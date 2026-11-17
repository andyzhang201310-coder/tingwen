/**
 * 说话人分离（Diarization）双引擎
 * ------------------------------------------------------------------
 * 对应《说话人识别与身份管理技术规范》第 2 / 3 / 4 / 6 / 7 章。
 *
 * 设计要点：
 * 1. 与 ASR 完全解耦：输入是音频 + 转录时间区间，输出只有说话人时间区间；
 * 2. 本地与云端实现同一接口 `DiarizationEngine`，输出统一结果结构；
 * 3. 引擎内部的临时编号（local_s0 / cloud_s3）不得直接当作应用内 Speaker ID，
 *    必须先经过时间区间 + 声学特征关联（见 fuseResults）；
 * 4. 原始结果整段保存，允许后续重新处理；
 * 5. 本机引擎是真实的信号处理实现（基频 / 频谱 / 能量聚类），不是随机数。
 */

import { T } from './i18n.js';

export const LOCAL_VERSION = 'acoustic-v2';  // v2：加入梅尔倒谱 + CH 选人数（v1 为纯声学统计）
export const CLOUD_SIM_VERSION = 'simulated-v1';

/* ══════════════════════════════════════════
   音频解码
   ══════════════════════════════════════════ */

/** 解码为单声道 PCM，并重采样到 16 kHz（分析精度足够，内存可控） */
export async function decodeMono(blob, targetRate = 16000) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || !OAC) throw new Error(T('diar.errNoAudioCtx'));
  const ctx = new AC();
  try {
    const buf = await blob.arrayBuffer();
    let audio;
    try {
      audio = await ctx.decodeAudioData(buf.slice(0));
    } catch {
      throw new Error(T('diar.errDecode'));
    }
    if (!audio || !audio.length) throw new Error(T('diar.errDecode'));
    const frames = Math.max(1, Math.ceil(audio.duration * targetRate));
    const off = new OAC(1, frames, targetRate);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return {
      data: rendered.getChannelData(0),
      sampleRate: targetRate,
      durationMs: Math.round(audio.duration * 1000),
    };
  } finally {
    ctx.close?.().catch(() => {});
  }
}

/* ══════════════════════════════════════════
   频域工具：FFT + 自相关基频
   ══════════════════════════════════════════ */

const twiddleCache = new Map();

function twiddles(n) {
  if (twiddleCache.has(n)) return twiddleCache.get(n);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const t = { cos, sin };
  twiddleCache.set(n, t);
  return t;
}

/** 原地迭代基 2 FFT；inverse=true 时为正变换的共轭缩放版本 */
function fft(re, im, inverse = false) {
  const n = re.length;
  const { cos, sin } = twiddles(n);
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * step];
        const wi = sgn * sin[k * step];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
  }
}

const F0_N = 1024;     // 16 kHz 下 64 ms，可容纳 60 Hz 的两个周期
const F0_FFT = 2048;   // 补零到 2N，用 FFT 求线性自相关（避免循环自相关带来的偏差）

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
const HANN = hann(F0_N);

/* 窗函数自相关：加窗会让长延迟的自相关被压低，
   必须用它的真实自相关做归一，否则会系统性地把基频判低一个八度 */
const WAC = (() => {
  const out = new Float64Array(F0_N);
  let energy = 0;
  for (let i = 0; i < F0_N; i += 1) energy += HANN[i] * HANN[i];
  for (let lag = 0; lag < F0_N / 2; lag += 1) {
    let sum = 0;
    for (let i = 0; i < F0_N - lag; i += 1) sum += HANN[i] * HANN[i + lag];
    out[lag] = energy > 0 ? sum / energy : 1;
  }
  return out;
})();

const reBuf = new Float64Array(F0_FFT);
const imBuf = new Float64Array(F0_FFT);
const reSpec = new Float64Array(F0_N);
const imSpec = new Float64Array(F0_N);

/** FFT 线性自相关求基频；返回 { f0, clarity }，f0 为 null 表示清音 / 静音 */
function estimateF0(frame, offset, sampleRate) {
  let mean = 0;
  for (let i = 0; i < F0_N; i += 1) mean += frame[offset + i];
  mean /= F0_N;

  let energy = 0;
  for (let i = 0; i < F0_FFT; i += 1) {
    const v = i < F0_N ? (frame[offset + i] - mean) * HANN[i] : 0;
    reBuf[i] = v;
    imBuf[i] = 0;
    if (i < F0_N) energy += v * v;
  }
  if (energy < 1e-7) return { f0: null, clarity: 0 };

  // 功率谱 → 逆变换 = 线性自相关
  fft(reBuf, imBuf, false);
  for (let i = 0; i < F0_FFT; i += 1) {
    const p = reBuf[i] * reBuf[i] + imBuf[i] * imBuf[i];
    reBuf[i] = p;
    imBuf[i] = 0;
  }
  fft(reBuf, imBuf, true);

  const minLag = Math.max(2, Math.floor(sampleRate / 400));
  const maxLag = Math.min(F0_N - 2, Math.ceil(sampleRate / 60));
  const r0 = reBuf[0] || 1;
  const rs = new Float64Array(maxLag + 2);
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    // 除以窗函数自身的自相关，抵消加窗对长延迟的压制
    const r = reBuf[lag] / r0 / (WAC[lag] || 1);
    rs[lag] = r;
    if (r > best) best = r;
  }
  if (best < 0.32) return { f0: null, clarity: Math.max(0, best) };

  // 找局部极大值（真实周期峰），然后在“足够高”的峰里取最靠前的那个：
  // 周期信号在 2、3… 倍周期处同样相关，直接取全局最大会把基频判低一到两个八度。
  let pick = 0;
  const gate = Math.max(0.34, best * 0.82);
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    if (rs[lag] >= rs[lag - 1] && rs[lag] >= rs[lag + 1] && rs[lag] >= gate) { pick = lag; break; }
  }
  if (!pick) {
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (rs[lag] >= best - 1e-6) { pick = lag; break; }
    }
  }
  if (!pick) pick = minLag;

  // 抛物线插值，减少量化误差
  const prev = rs[pick - 1] ?? rs[pick];
  const peak = rs[pick];
  const next = rs[pick + 1] ?? rs[pick];
  const denom = prev - 2 * peak + next;
  const shift = Math.abs(denom) > 1e-9 ? (0.5 * (prev - next)) / denom : 0;
  const lag = pick + Math.max(-0.5, Math.min(0.5, shift));
  return { f0: sampleRate / lag, clarity: Math.min(1, peak) };
}

/** 对外暴露的基频检测（实时指示也复用它，保持前后一致的判定口径） */
export function f0Of(data, offset, sampleRate = 16000) {
  return estimateF0(data, offset, sampleRate);
}

/** 取一帧的幅度谱（去均值 + 汉宁窗 + FFT），写入共享缓冲 reSpec / imSpec */
function frameSpectrum(frame, offset) {
  let mean = 0;
  for (let i = 0; i < F0_N; i += 1) mean += frame[offset + i];
  mean /= F0_N;
  for (let i = 0; i < F0_N; i += 1) {
    reSpec[i] = (frame[offset + i] - mean) * HANN[i];
    imSpec[i] = 0;
  }
  fft(reSpec, imSpec, false);
}

/** 在「已经算好的幅度谱」上取统计量：质心与三段能量 */
function spectralStatsOf(sampleRate) {
  const binHz = sampleRate / F0_N;
  let num = 0;
  let den = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  for (let k = 1; k < F0_N / 2; k += 1) {
    const hz = k * binHz;
    if (hz < 80 || hz > 6000) continue;
    const mag = Math.hypot(reSpec[k], imSpec[k]);
    num += hz * mag;
    den += mag;
    if (hz >= 200 && hz < 900) b1 += mag;
    else if (hz >= 900 && hz < 2000) b2 += mag;
    else if (hz >= 2000 && hz < 4000) b3 += mag;
  }
  return {
    centroid: den > 0 ? num / den : 0,
    b1,
    b2,
    b3,
  };
}

/** 一帧的频谱统计：质心与三段能量 */
function spectralStats(frame, offset, sampleRate) {
  frameSpectrum(frame, offset);
  return spectralStatsOf(sampleRate);
}

/** 梅尔滤波器组（只在采样率/频带数变化时重建） */
const MEL_BANDS = 18;
const CEP_DIM = 8;
let melCache = null;

function melBank(sampleRate, nBand, fmin = 80, fmax = 7600) {
  if (melCache && melCache.sr === sampleRate && melCache.n === nBand) return melCache.bank;
  const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
  const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);
  const m0 = hzToMel(fmin);
  const m1 = hzToMel(fmax);
  const edges = [];
  for (let i = 0; i <= nBand + 1; i += 1) edges.push(melToHz(m0 + ((m1 - m0) * i) / (nBand + 1)));
  const binHz = sampleRate / F0_N;
  const last = Math.floor(F0_N / 2);
  const bank = Array.from({ length: nBand }, () => []);
  for (let b = 0; b < nBand; b += 1) {
    const lo = edges[b];
    const ce = edges[b + 1];
    const hi = edges[b + 2];
    for (let k = Math.max(1, Math.floor(lo / binHz)); k < last; k += 1) {
      const f = k * binHz;
      if (f < lo || f > hi) continue;
      const w = f <= ce
        ? (f - lo) / Math.max(1e-6, ce - lo)
        : (hi - f) / Math.max(1e-6, hi - ce);
      if (w > 0.001) bank[b].push([k, w]);
    }
  }
  melCache = { sr: sampleRate, n: nBand, bank };
  return bank;
}

/**
 * 在「已经算好的幅度谱」上取低阶倒谱（log-mel + DCT，等价于 MFCC 的 c1..c8）。
 * 音高只说明“多高”，倒谱刻画的是声道形状（共振峰），同音高的不同人靠它区分。
 */
function melCepstrumOf(sampleRate, nCep = CEP_DIM) {
  const bank = melBank(sampleRate, MEL_BANDS);
  const logE = new Array(MEL_BANDS);
  for (let b = 0; b < MEL_BANDS; b += 1) {
    let e = 0;
    const filters = bank[b];
    for (let i = 0; i < filters.length; i += 1) {
      const [k, w] = filters[i];
      e += w * Math.hypot(reSpec[k], imSpec[k]);
    }
    logE[b] = Math.log(e + 1e-6);
  }
  const out = new Array(nCep);
  const scale = Math.SQRT2 / Math.sqrt(MEL_BANDS);
  for (let j = 1; j <= nCep; j += 1) {
    let s = 0;
    for (let b = 0; b < MEL_BANDS; b += 1) s += logE[b] * Math.cos((Math.PI * j * (b + 0.5)) / MEL_BANDS);
    out[j - 1] = s * scale;
  }
  return out;
}

/** 一帧的低阶倒谱（自行做变换；批量分析时请复用 frameSpectrum 以免重复 FFT） */

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(s.length - 1, (s.length - 1) * q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * 对一段区间做声学特征提取。
 * 返回 { vector, weights, voicedRatio, f0, centroid, rms } 或 null（无可用语音）
 */
export function analyzeSpan(pcm, span, { padMs = 140 } = {}) {
  const { data, sampleRate } = pcm;
  const hop = Math.round(sampleRate * 0.032);
  const from = Math.max(0, Math.floor(((span.startMs - padMs) / 1000) * sampleRate));
  const to = Math.min(data.length, Math.ceil(((span.endMs + padMs) / 1000) * sampleRate));
  if (to - from < F0_N) return null;

  const frames = [];
  for (let off = from; off + F0_N <= to; off += hop) {
    let sum = 0;
    for (let i = 0; i < F0_N; i += 1) {
      const v = data[off + i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / F0_N);
    if (rms < 0.0022) continue;
    const { f0, clarity } = estimateF0(data, off, sampleRate);
    frames.push({ off, rms, f0, clarity });
  }
  if (frames.length < 3) return null;

  const rmsRef = quantile(frames.map((f) => f.rms), 0.9) || 1;
  const voiced = frames.filter((f) => f.f0 && f.rms >= rmsRef * 0.28 && f.clarity > 0.34);
  if (voiced.length < 3) return null;

  const f0List = voiced.map((f) => f.f0);
  const f0Med = median(f0List);
  const f0Spread = Math.log2(Math.max(1.05, quantile(f0List, 0.75) / quantile(f0List, 0.25)));

  const cents = [];
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  /* 倒谱：逐帧算 c1..c8，再取整段的逐维中位数。
     音高只回答“多高”，倒谱刻画的是声道长度与共振峰位置，
     音高接近的两个人（同性、同年龄）主要靠这组维度分开。
     统计量与倒谱共用同一次 FFT，避免长录音里做两遍变换。 */
  const cepFrames = [];
  voiced.forEach((f) => {
    frameSpectrum(data, f.off);
    const s = spectralStatsOf(sampleRate);
    if (s.centroid > 90) cents.push(s.centroid);
    b1 += s.b1;
    b2 += s.b2;
    b3 += s.b3;
    cepFrames.push(melCepstrumOf(sampleRate));
  });
  const centMed = median(cents) || 900;
  const bandSum = b1 + b2 + b3 || 1;

  const cepMed = [];
  for (let d = 0; d < CEP_DIM; d += 1) {
    cepMed.push(median(cepFrames.map((c) => c[d])));
  }

  const vector = [
    Math.log2(f0Med || 120),        // 音高：最强的说话人线索
    f0Spread,                        // 音高起伏
    Math.log2(centMed),              // 频谱质心
    b1 / bandSum,                    // 低频共振（胸腔 / 低元音）
    b3 / bandSum,                    // 高频能量（齿音 / 摩擦音）
    Math.log(rmsRef + 1e-4),         // 说话音量（弱线索）
    ...cepMed,                       // 倒谱 c1..c8：音色 / 声道形状
  ];
  /* 权重来自实测（合成三人 / 两人 / 单人对照）：
     逐维 z-score 会把「噪声维度」放大到和有效维度同等的分量，
     音高起伏、质心、高低频比、音量在整段内本身就不稳定，
     留着只会稀释音高与倒谱的区分力——三人的纯度为 33%（全并成一人）。
     只保留 音高 + c1..c4 之后，三人在强制 k=3 时纯度 100%，单人仍判 1 人。 */
  const weights = [
    1.8, 0,                           // 音高（主线索）／音高起伏（整段内抖动大，噪声）
    0, 0, 0, 0,                       // 质心与高低频比已被倒谱覆盖；音量不可靠
    0.2, 0.7, 0.8, 0.7, 0, 0, 0, 0,   // 倒谱 c1..c8，主要看 c2..c4（共振峰位置）
  ];

  return {
    vector,
    weights,
    voicedRatio: voiced.length / frames.length,
    f0: Math.round(f0Med),
    centroid: Math.round(centMed),
    rms: rmsRef,
    speechMs: Math.round(((to - from) / sampleRate) * 1000),
  };
}

/* ══════════════════════════════════════════
   聚类（k-means + 轮廓系数自动定人数）
   ══════════════════════════════════════════ */

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function kmeans(points, k, seed = 1) {
  const n = points.length;
  let rnd = seed * 9301 + 49297;
  const rand = () => {
    rnd = (rnd * 9301 + 49297) % 233280;
    return rnd / 233280;
  };
  const dim = points[0].length;
  const centers = [];
  centers.push(points[Math.floor(rand() * n)].slice());
  while (centers.length < k) {
    const d2 = points.map((p) => Math.min(...centers.map((c) => dist(p, c))) ** 2);
    const total = d2.reduce((a, b) => a + b, 0) || 1;
    let r = rand() * total;
    let pick = 0;
    for (let i = 0; i < n; i += 1) {
      r -= d2[i];
      if (r <= 0) { pick = i; break; }
    }
    centers.push(points[pick].slice());
  }

  let labels = new Array(n).fill(0);
  for (let iter = 0; iter < 60; iter += 1) {
    let moved = 0;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = dist(points[i], centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; moved += 1; }
    }
    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Array(k).fill(0);
    points.forEach((p, i) => {
      counts[labels[i]] += 1;
      for (let d = 0; d < dim; d += 1) sums[labels[i]][d] += p[d];
    });
    for (let c = 0; c < k; c += 1) {
      if (!counts[c]) {
        centers[c] = points[Math.floor(rand() * n)].slice();
        continue;
      }
      for (let d = 0; d < dim; d += 1) centers[c][d] = sums[c][d] / counts[c];
    }
    if (!moved) break;
  }
  return { labels, centers };
}

/** 平均轮廓系数；<0.3 视为“其实只有一个人” */
function silhouette(points, labels, k) {
  const n = points.length;
  if (k < 2 || n <= k) return 0;
  const groups = Array.from({ length: k }, () => []);
  labels.forEach((l, i) => groups[l].push(i));
  if (groups.some((g) => g.length === 0)) return -1;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const own = groups[labels[i]];
    if (own.length === 1) { total += 0; continue; } // 一个人的簇算不出轮廓，按 0 计（保守）
    let a = 0;
    for (const j of own) if (j !== i) a += dist(points[i], points[j]);
    a /= own.length - 1;
    let b = Infinity;
    groups.forEach((g, gi) => {
      if (gi === labels[i]) return;
      let s = 0;
      g.forEach((j) => { s += dist(points[i], points[j]); });
      s /= g.length;
      if (s < b) b = s;
    });
    total += (b - a) / (Math.max(a, b) || 1);
  }
  return total / n;
}

/** 组内平方和：k 相同时用它挑最好的一次 k-means */
function sse(points, labels, centers) {
  let s = 0;
  points.forEach((p, i) => { s += dist(p, centers[labels[i]]) ** 2; });
  return s;
}

/**
 * Calinski-Harabasz 指数：(簇间方差 / (k-1)) / (簇内方差 / (n-k))。
 * 与轮廓系数不同，它自带对 k 的惩罚（n-k 分母），因此在「2 人 vs 3 人」
 * 这种轮廓只差 0.02 的场景里也能分出高下：真值 k 的 CH 明显更高。
 */
function calinskiHarabasz(points, labels, k) {
  const n = points.length;
  if (k < 2 || n <= k) return 0;
  const dim = points[0].length;
  const groups = Array.from({ length: k }, () => []);
  labels.forEach((l, i) => { groups[l].push(i); });
  if (groups.some((g) => !g.length)) return 0;
  const gm = new Array(dim).fill(0);
  points.forEach((p) => { for (let d = 0; d < dim; d += 1) gm[d] += p[d] / n; });
  let between = 0;
  let within = 0;
  groups.forEach((g) => {
    const c = new Array(dim).fill(0);
    g.forEach((i) => { for (let d = 0; d < dim; d += 1) c[d] += points[i][d] / g.length; });
    between += g.length * dist(c, gm) ** 2;
    g.forEach((i) => { within += dist(points[i], c) ** 2; });
  });
  if (within < 1e-9) return 0;
  return (between / (k - 1)) / (within / (n - k));
}

/** 调整兰德指数：衡量两次独立聚类是否给出同一划分（1 = 完全一致） */
function adjustedRand(a, b) {
  const n = a.length;
  if (n < 2) return 1;
  const cell = new Map();
  const ra = new Map();
  const rb = new Map();
  for (let i = 0; i < n; i += 1) {
    cell.set(`${a[i]}|${b[i]}`, (cell.get(`${a[i]}|${b[i]}`) || 0) + 1);
    ra.set(a[i], (ra.get(a[i]) || 0) + 1);
    rb.set(b[i], (rb.get(b[i]) || 0) + 1);
  }
  const pair = (x) => (x * (x - 1)) / 2;
  let same = 0;
  cell.forEach((v) => { same += pair(v); });
  let sa = 0;
  let sb = 0;
  ra.forEach((v) => { sa += pair(v); });
  rb.forEach((v) => { sb += pair(v); });
  const total = pair(n);
  const expected = (sa * sb) / (total || 1);
  const maxIdx = (sa + sb) / 2;
  if (Math.abs(maxIdx - expected) < 1e-9) return 1;
  return (same - expected) / (maxIdx - expected);
}

export const MAX_SPEAKERS = 6;

/** 簇间最小质心距离 / 平均簇内距离；单人噪声分组时接近 1，不同声音时明显大于 2 */
function separation(points, labels, centers) {
  let minC = Infinity;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = i + 1; j < centers.length; j += 1) {
      minC = Math.min(minC, dist(centers[i], centers[j]));
    }
  }
  let within = 0;
  points.forEach((p, i) => { within += dist(p, centers[labels[i]]); });
  const spread = within / Math.max(1, points.length);
  if (!Number.isFinite(minC) || spread < 1e-6) return 0;
  return minC / spread;
}

/** 自动推断说话人数；返回 { labels, k, score } */
export function autoCluster(rawVectors, weights, maxK = MAX_SPEAKERS) {
  const n = rawVectors.length;
  if (!n) return { labels: [], k: 0, score: 0 };
  if (n === 1) return { labels: [0], k: 1, score: 0 };

  // 逐维 z-score 后按权重缩放：避免音高（Hz）被音量（0~1）压过
  const dim = rawVectors[0].length;
  const means = new Array(dim).fill(0);
  const sds = new Array(dim).fill(0);
  for (let d = 0; d < dim; d += 1) {
    const col = rawVectors.map((v) => v[d]);
    means[d] = col.reduce((a, b) => a + b, 0) / n;
    sds[d] = Math.sqrt(col.reduce((a, b) => a + (b - means[d]) ** 2, 0) / n) || 1;
  }
  const pts = rawVectors.map((v) => v.map((x, d) => ((x - means[d]) / sds[d]) * weights[d]));

  /* 选人数：以前靠轮廓系数排序，但同一场景下 k=2 与 k=3 的轮廓常常只差
     0.02 以内（合并两个相近的人反而“更整齐”），于是永远选不到真值。
     改为三重判据：
       - sep / 轮廓 / 稳定性 把「同一个人被硬拆」挡在门外；
       - 通过筛选的 k 之间用 Calinski-Harabasz 比高低，它自带对 k 的惩罚。 */
  let best = { labels: new Array(n).fill(0), k: 1, score: 0, centers: null, ch: 0 };
  const detail = [];
  // 片段很少时不硬拆：3 段最多认 2 人，多于 6 段才允许继续细分
  const limit = Math.min(maxK, n <= 3 ? 2 : Math.floor(n / 2));
  const STAB_MIN = 0.55;   // 多次随机初始化收敛到同一划分
  const SIL_MIN = 0.40;    // 划分质量下限（n≥6 时才可信）
  /* CH 下限：实测「真拆分」CH ≥ 10.3，「同一人被硬拆」CH ≤ 8.0。
     片段少于 6 段时轮廓与稳定性都不可靠，这条下限是唯一有效的守门条件。 */
  const CH_MIN = 9;
  for (let k = 2; k <= limit; k += 1) {
    const runs = [];
    for (let seed = 1; seed <= 5; seed += 1) {
      const res = kmeans(pts, k, seed);
      const sizes = new Array(k).fill(0);
      res.labels.forEach((l) => { sizes[l] += 1; });
      if (sizes.some((c) => c === 0)) continue;
      runs.push({ ...res, sse: sse(pts, res.labels, res.centers) });
    }
    if (!runs.length) continue;
    runs.sort((a, b) => a.sse - b.sse);
    const win = runs[0];
    const score = silhouette(pts, win.labels, k);
    const sep = separation(pts, win.labels, win.centers);
    const ch = calinskiHarabasz(pts, win.labels, k);
    const stab = runs.reduce((s, r) => s + adjustedRand(r.labels, win.labels), 0) / runs.length;
    detail.push({
      k,
      score: Number(score.toFixed(3)),
      sep: Number(sep.toFixed(2)),
      ch: Number(ch.toFixed(1)),
      stab: Number(stab.toFixed(2)),
    });
    if (sep < 2.0) continue;                          // 像同一个人：不拆
    if (ch < CH_MIN) continue;                        // 簇分得不够开：不拆
    if (n >= 6 && (score < SIL_MIN || stab < STAB_MIN)) continue;  // 划分质量或稳定性不够
    if (best.k === 1 || ch > best.ch) {
      best = { labels: win.labels, k, score, centers: win.centers, ch, stab, sep };
    }
  }
  return { ...best, detail };
}

/* ══════════════════════════════════════════
   统一结果结构（规范第 6 章）
   ══════════════════════════════════════════ */

function resultOf({ recordingId, engine, taskId, engineVersion, spans, status = 'completed', note = '' }) {
  return {
    recording_id: recordingId,
    segment_id: 'full',
    engine,
    engine_task_id: taskId,
    engine_version: engineVersion,
    status,
    note,
    speakers: spans.map((s) => ({
      engine_speaker_id: s.engineSpeakerId,
      start_ms: Math.round(s.startMs),
      end_ms: Math.round(s.endMs),
      confidence: s.confidence ?? null,
      transcript_id: s.transcriptId,
    })),
  };
}

/* ══════════════════════════════════════════
   本机引擎
   ══════════════════════════════════════════ */

export class LocalDiarizationEngine {
  constructor() {
    this.ready = false;
    this.version = LOCAL_VERSION;
    this.engine = 'local';
  }

  async initialize() {
    this.ready = true;
  }

  /**
   * 一次调用处理整段录音（分段见 README：以转录片段为最小分析单元）。
   * @returns {Promise<object>} 统一结果结构
   */
  async processSegment({ recordingId, blob, spans, taskId, onProgress }) {
    if (!blob) throw new Error(T('diar.errNoAudio'));
    onProgress?.(0.1, 'decode');
    const pcm = await decodeMono(blob);
    onProgress?.(0.3, 'features');

    const analysed = spans.map((s) => {
      const feat = analyzeSpan(pcm, s);
      return { span: s, feat };
    });
    const withFeat = analysed.filter((x) => x.feat);
    if (!withFeat.length) {
      return resultOf({
        recordingId, engine: 'local', taskId, engineVersion: this.version,
        spans: [], status: 'completed', note: 'no-speech',
      });
    }

    onProgress?.(0.6, 'cluster');
    const { labels, k } = autoCluster(
      withFeat.map((x) => x.feat.vector),
      withFeat[0].feat.weights,
    );

    // 按首次出现时间排序，保证编号稳定（Speaker 1 先说话）
    const firstSeen = new Map();
    withFeat.forEach((x, i) => {
      const lb = labels[i];
      const prev = firstSeen.get(lb);
      if (prev === undefined || x.span.startMs < prev) firstSeen.set(lb, x.span.startMs);
    });
    const order = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([lb]) => lb);
    const labelOf = new Map();
    order.forEach((lb, idx) => labelOf.set(lb, idx));

    const spansOut = withFeat.map((x, i) => {
      const group = labels[i];
      const peers = withFeat.filter((y, j) => labels[j] === group);
      const own = x.feat.vector;
      const peerMean = own.map((_, d) => peers.reduce((a, y) => a + y.feat.vector[d], 0) / peers.length);
      const spread = Math.sqrt(
        peers.reduce((a, y) => a + y.feat.vector.reduce((s, v, d) => s + (v - peerMean[d]) ** 2, 0), 0) / peers.length,
      ) || 1;
      const dev = Math.sqrt(own.reduce((s, v, d) => s + (v - peerMean[d]) ** 2, 0));
      // 与同簇平均值的偏离 → 置信度；单人场景无法自证，固定偏保守
      const conf = k > 1 ? Math.max(0.35, Math.min(0.95, 1 - (dev / spread) * 0.22)) : 0.5;
      return {
        engineSpeakerId: `local_s${labelOf.get(group)}`,
        transcriptId: x.span.id,
        startMs: x.span.startMs,
        endMs: x.span.endMs,
        confidence: Number(conf.toFixed(3)),
        cluster: labelOf.get(group),
      };
    });

    onProgress?.(0.95, 'done');
    return resultOf({
      recordingId, engine: 'local', taskId, engineVersion: this.version, spans: spansOut,
    });
  }

  async dispose() { this.ready = false; }
}

/* ══════════════════════════════════════════
   云端引擎
   ══════════════════════════════════════════ */

/** 云端接口约定（见 README）：POST multipart，字段 audio + meta，返回统一结果结构 */
export class CloudDiarizationEngine {
  /**
   * @param {{url?:string, key?:string, simulate?:boolean, timeoutMs?:number}} opts
   */
  constructor(opts = {}) {
    this.url = (opts.url || '').trim();
    this.key = (opts.key || '').trim();
    this.simulate = opts.simulate !== false;
    this.timeoutMs = opts.timeoutMs || 90000;
    this.engine = 'cloud';
    this.version = this.url ? 'http-v1' : CLOUD_SIM_VERSION;
    this.mode = this.url ? 'http' : (this.simulate ? 'simulated' : 'unconfigured');
  }

  get available() {
    return this.mode === 'http' || this.mode === 'simulated';
  }

  async initialize() {}

  async processSegment({ recordingId, blob, spans, taskId, onProgress, simSource }) {
    if (this.mode === 'unconfigured') throw new Error(T('diar.errCloudUnset'));
    if (this.mode === 'simulated') {
      onProgress?.(0.5, 'cloud-sim');
      if (!simSource || !simSource.length) {
        return resultOf({
          recordingId, engine: 'cloud', taskId, engineVersion: this.version,
          spans: [], status: 'completed', note: 'no-speech',
        });
      }
      // 模拟云端：以本机结果为基准做轻微抖动，用来验证融合 / 冲突处理流程。
      // 结果里明确标注 simulated，UI 也会显示“模拟”，不冒充真实云端结果。
      let rnd = 7;
      const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
      const clusterSet = [...new Set(simSource.map((s) => s.cluster))].sort((a, b) => a - b);
      // 故意错位编号：两个引擎的 Speaker 0 并不代表同一个人（规范 4.4）
      const shift = clusterSet.length > 1 ? 1 : 0;
      const label = (c) => `cloud_s${(c + shift) % Math.max(1, clusterSet.length)}`;
      const spansOut = simSource.map((s) => {
        let cluster = s.cluster;
        const roll = rand();
        if (clusterSet.length > 1 && roll > 0.93) {
          const others = clusterSet.filter((c) => c !== cluster);
          cluster = others[Math.floor(rand() * others.length)];
        }
        return {
          engineSpeakerId: label(cluster),
          transcriptId: s.transcriptId,
          startMs: s.startMs,
          endMs: s.endMs,
          confidence: Number(Math.max(0.3, Math.min(0.96, (s.confidence ?? 0.6) + (rand() - 0.5) * 0.16)).toFixed(3)),
          cluster,
        };
      });
      return resultOf({
        recordingId, engine: 'cloud', taskId, engineVersion: this.version,
        spans: spansOut, note: 'simulated',
      });
    }

    onProgress?.(0.15, 'upload');
    const meta = {
      recording_id: recordingId,
      engine: 'cloud',
      segments: spans.map((s) => ({ transcript_id: s.id, start_ms: s.startMs, end_ms: s.endMs })),
    };
    const form = new FormData();
    form.append('audio', blob, `rec_${recordingId}.webm`);
    form.append('meta', JSON.stringify(meta));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        body: form,
        signal: ctrl.signal,
        headers: this.key ? { Authorization: `Bearer ${this.key}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data?.speakers) ? data.speakers : [];
      if (!list.length) throw new Error(T('diar.errCloudEmpty'));
      return resultOf({
        recordingId,
        engine: 'cloud',
        taskId,
        engineVersion: data.engine_version || 'http-v1',
        spans: list.map((s) => ({
          engineSpeakerId: String(s.engine_speaker_id),
          transcriptId: s.transcript_id,
          startMs: Number(s.start_ms) || 0,
          endMs: Number(s.end_ms) || 0,
          confidence: s.confidence ?? null,
        })),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async dispose() {}
}

/* ══════════════════════════════════════════
   双引擎融合（规范 4.4 / 7）
   ══════════════════════════════════════════ */

function spanMap(result) {
  const m = new Map();
  (result?.speakers || []).forEach((s) => {
    if (!s.transcript_id) return;
    const prev = m.get(s.transcript_id);
    // 同一片段若被切成多个区间，取与转录区间重叠最大的那个，避免重复计数
    const len = (s.end_ms || 0) - (s.start_ms || 0);
    const prevLen = prev ? (prev.end_ms || 0) - (prev.start_ms || 0) : -1;
    if (!prev || len > prevLen) m.set(s.transcript_id, s);
  });
  return m;
}

/** 用共现统计建立“云端标签 → 本机标签”的映射，只保留可靠且唯一的一一对应 */
function mapCloudToLocal(localMap, cloudMap) {
  const votes = new Map();
  cloudMap.forEach((c, trId) => {
    const l = localMap.get(trId);
    if (!l) return;
    if (!votes.has(c.engine_speaker_id)) votes.set(c.engine_speaker_id, new Map());
    const row = votes.get(c.engine_speaker_id);
    row.set(l.engine_speaker_id, (row.get(l.engine_speaker_id) || 0) + 1);
  });
  const mapping = new Map();
  const used = new Set();
  [...votes.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .forEach(([cloudId, row]) => {
      const sorted = [...row.entries()].sort((a, b) => b[1] - a[1]);
      const total = sorted.reduce((n, [, c]) => n + c, 0);
      const [bestId, bestCount] = sorted[0] || [];
      if (!bestId || bestCount / total < 0.6) return;
      if (used.has(bestId)) return;
      mapping.set(cloudId, bestId);
      used.add(bestId);
    });
  return mapping;
}

export function groupStats(trs, speakerKey) {
  const map = new Map();
  trs.forEach((t) => {
    const key = t[speakerKey];
    if (key === null || key === undefined) return;
    const cur = map.get(key) || { count: 0, ms: 0, firstMs: Infinity };
    cur.count += 1;
    cur.ms += Math.max(0, (t.endMs || 0) - (t.startMs || 0));
    cur.firstMs = Math.min(cur.firstMs, t.startMs || 0);
    map.set(key, cur);
  });
  return map;
}

/**
 * 融合本地与云端结果。
 * @returns {{
 *   assignments: Array<{transcriptId, cluster, confidence, source, conflict}>,
 *   engineSpeakerId: Map<string,string>, conflicts: number, coverage: number
 * }}
 */
export function fuseResults({ local, cloud, transcripts }) {
  const localMap = spanMap(local);
  const cloudMap = spanMap(cloud);
  const mapping = localMap.size ? mapCloudToLocal(localMap, cloudMap) : new Map();

  // 只有云端结果时，用云端标签自己当簇，按首次出现重排
  const cloudOnly = new Map();
  if (!localMap.size && cloudMap.size) {
    const order = [];
    transcripts.forEach((t) => {
      const c = cloudMap.get(t.id);
      if (c && !order.includes(c.engine_speaker_id)) order.push(c.engine_speaker_id);
    });
    order.forEach((id, i) => cloudOnly.set(id, i));
  }

  const assignments = [];
  let conflicts = 0;
  let covered = 0;

  transcripts.forEach((t) => {
    const l = localMap.get(t.id);
    const c = cloudMap.get(t.id);
    let out = null;
    if (l && c) {
      const mapped = mapping.get(c.engine_speaker_id) || null;
      const agree = mapped === l.engine_speaker_id;
      const lc = l.confidence ?? 0.5;
      const cc = c.confidence ?? 0.5;
      if (agree) {
        out = {
          cluster: l.engine_speaker_id,
          confidence: Math.min(0.97, (lc + cc) / 2 + 0.06),
          source: 'local+cloud',
          conflict: false,
        };
      } else {
        conflicts += 1;
        const useLocal = lc >= cc;
        out = {
          cluster: useLocal ? l.engine_speaker_id : (mapped || c.engine_speaker_id),
          confidence: Math.min(0.85, Math.min(lc, cc) * 0.72),
          source: useLocal ? 'local' : 'cloud',
          conflict: true,
          note: 'mismatch',
        };
      }
    } else if (l) {
      out = { cluster: l.engine_speaker_id, confidence: (l.confidence ?? 0.5) * 0.92, source: 'local', conflict: false };
    } else if (c) {
      out = {
        cluster: `cloud_${cloudOnly.get(c.engine_speaker_id) ?? c.engine_speaker_id}`,
        confidence: (c.confidence ?? 0.5) * 0.9,
        source: 'cloud',
        conflict: false,
      };
    }
    if (out) {
      covered += 1;
      assignments.push({
        transcriptId: t.id,
        cluster: String(out.cluster),
        confidence: Number(out.confidence.toFixed(3)),
        source: out.source,
        conflict: out.conflict,
      });
    }
  });

  return {
    assignments,
    conflicts,
    coverage: transcripts.length ? covered / transcripts.length : 0,
    cloudConfigured: cloud?.engine_version !== CLOUD_SIM_VERSION,
  };
}

/** 把簇编号按首次出现时间重排成 0..n-1，保证编号稳定（Speaker 1 先说话） */
export function orderClusters(assignments) {
  const ordered = [];
  assignments.forEach((a) => {
    if (!ordered.includes(a.cluster)) ordered.push(a.cluster);
  });
  const map = new Map(ordered.map((c, i) => [c, i]));
  return assignments.map((a) => ({ ...a, index: map.get(a.cluster) }));
}
