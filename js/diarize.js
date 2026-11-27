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

export const LOCAL_VERSION = 'acoustic-v3';  // v3：句内按换人切分（v2 为整句聚类）
export const CLOUD_SIM_VERSION = 'simulated-v1';

/* 句内切分参数：一句里换人就断开，是 v3 的核心行为。
   窗口 1.2s / 步进 0.6s：短到能卡住一次换人，又长到凑得出 3 个浊音帧算基频。
   太短的句子（<1.8s）只有一两个窗，切了也只会把句子切碎，直接跳过。 */
const SPLIT_MIN_SPAN_MS = 1800;
const SPLIT_WIN_MS = 1200;
const SPLIT_HOP_MS = 600;
const SPLIT_MIN_PART_MS = 700;
const SPLIT_PAD_MS = 60;

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

/**
 * 一帧里是否同时有两个人在说。
 *
 * 判据在频域而不是自相关：两个等强度的声源叠加时，自相关会给出两者的折中周期
 * （实测 120 Hz + 210 Hz 被判成 108 Hz），次峰根本立不起来；而频谱上两条谐波梳
 * 是分开的，直接找「第二个可用作基频的峰」更可靠。
 *
 * 边界：分辨率 15.6 Hz（1024 点 @16 kHz），基频差小于约 25 Hz 的两个人分不开；
 * 同性别、音高极接近的重叠会漏检——所以这个标记只做提示，不改任何归属。
 */
function overlapFromSpectrum(sampleRate) {
  const binHz = sampleRate / F0_N;
  const lo = Math.max(2, Math.floor(70 / binHz));
  const hi = Math.min(F0_N / 2 - 2, Math.ceil(360 / binHz));
  if (hi - lo < 6) return false;

  const peaks = [];
  for (let k = lo; k <= hi; k += 1) {
    const m = Math.hypot(reSpec[k], imSpec[k]);
    const prev = Math.hypot(reSpec[k - 1], imSpec[k - 1]);
    const next = Math.hypot(reSpec[k + 1], imSpec[k + 1]);
    if (m <= prev || m < next) continue;
    peaks.push({ hz: k * binHz, mag: m });
  }
  if (peaks.length < 2) return false;
  peaks.sort((a, b) => b.mag - a.mag);

  const p1 = peaks[0];
  for (let i = 1; i < Math.min(peaks.length, 4); i += 1) {
    const p2 = peaks[i];
    if (p2.mag < p1.mag * 0.35) continue;          // 太弱，多半是噪声或共振峰
    const ratio = Math.max(p1.hz, p2.hz) / Math.min(p1.hz, p2.hz);
    if (ratio < 1.18) continue;                     // 太近，本来就是一回事
    const nearInt = Math.abs(ratio - Math.round(ratio)) < 0.14 * Math.max(1, Math.round(ratio));
    if (nearInt) continue;                          // 整数倍＝同一个人的谐波
    return true;
  }
  return false;
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
  const allRms = [];
  for (let off = from; off + F0_N <= to; off += hop) {
    let sum = 0;
    for (let i = 0; i < F0_N; i += 1) {
      const v = data[off + i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / F0_N);
    /* 静音帧也要留着：噪声底就是从这里取的，全丢掉就没法估信噪比 */
    allRms.push(rms);
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
  let overlapFrames = 0;
  voiced.forEach((f) => {
    frameSpectrum(data, f.off);
    const s = spectralStatsOf(sampleRate);
    if (s.centroid > 90) cents.push(s.centroid);
    b1 += s.b1;
    b2 += s.b2;
    b3 += s.b3;
    cepFrames.push(melCepstrumOf(sampleRate));
    /* 复用同一帧的谱，不额外做 FFT */
    if (overlapFromSpectrum(sampleRate)) overlapFrames += 1;
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
    ...qualityOf(frames, allRms, overlapFrames, voiced.length),
  };
}

/**
 * 片段质量：信噪比 + 重叠占比。
 *
 * 远场、隔着一台笔记本开会时，真正的问题不是「分不出人」，而是分出来的结果不可信——
 * 必须把这种不可信标出来，否则用户会把噪声当成人声编号，越改越乱。
 *
 * SNR 用 10 分位当噪声底、90 分位当语音峰：直接取平均会被大段静音稀释，
 * 峰值又会被人咳嗽或关门声抬高，两端分位对偶发噪声最不敏感。
 */
function qualityOf(frames = [], allRms = [], overlapFrames = 0, voicedCount = 1) {
  const noise = quantile(allRms, 0.1) || 0;
  const peak = quantile(allRms, 0.9) || 0;
  /* 片段内没有明显停顿（分位差不到 8 dB）时，「噪声底」其实是语音的低谷，
     按它算出来的信噪比只会偏低，不如不给这个数。 */
  const dynamicDb = noise > 0 && peak > noise ? 20 * Math.log10(peak / noise) : 0;
  const snrDb = dynamicDb >= 8 ? Math.min(60, dynamicDb) : null;

  /* 清晰度主导质量等级：噪声与混响都会破坏周期性，clarity 随之下降，
     它比信噪比对「连续说话、没有停顿」的片段更稳。 */
  const clarity = median(frames.map((f) => f.clarity)) || 0;
  const overlapRatio = voicedCount ? overlapFrames / voicedCount : 0;
  return {
    snrDb: snrDb === null ? null : Math.round(snrDb),
    clarity: Number(clarity.toFixed(2)),
    overlapRatio: Number(overlapRatio.toFixed(2)),
    overlap: overlapRatio >= 0.25,
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
  /* 归一化参数要带出去：同一场录音内的更细单位（句内小窗）必须用同一套
     means/sds/weights 投影，否则和这里算出来的中心不在一个空间里，无法比较。 */
  const norm = { means, sds, weights };

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
  /* 单人也需要中心点：句内切分要拿它把每个小窗归到唯一的那一簇 */
  if (!best.centers) {
    const dim = pts[0].length;
    best.centers = [Array.from({ length: dim }, (_, d) => pts.reduce((s, p) => s + p[d], 0) / n)];
  }
  return { ...best, pts, norm, detail };
}

/** 用某一场的归一化参数投影一个特征向量（与 autoCluster 内部同构） */
export function projectVector(vector, norm) {
  if (!norm) return vector.slice();
  const { means, sds, weights } = norm;
  return vector.map((x, d) => ((x - means[d]) / sds[d]) * (weights[d] || 0));
}

/* ══════════════════════════════════════════
   统一结果结构（规范第 6 章）
   ══════════════════════════════════════════ */

/** 整场质量汇总：一条录音该不该被信任，看这几个数就够了 */
export function summarizeQuality(spans = []) {
  if (!spans.length) return null;
  const snrs = spans.map((s) => s.snrDb).filter((n) => Number.isFinite(n));
  /* 云端引擎回来的结果没有声学指标：宁可报 null，也不要编一个「未知质量」顶在前面，
     否则读取方会拿这份空壳覆盖本机算出来的真实质量。 */
  if (!snrs.length && !spans.some((s) => Number.isFinite(s.clarity))) return null;
  const med = snrs.length ? median(snrs) : null;
  const clarities = spans.map((s) => s.clarity).filter((n) => Number.isFinite(n));
  const clarityMed = clarities.length ? median(clarities) : null;
  const overlapSpans = spans.filter((s) => s.overlap).length;
  const noisySpans = spans.filter((s) => Number.isFinite(s.clarity) && s.clarity < 0.55).length;
  const lowConfSpans = spans.filter((s) => Number.isFinite(s.confidence) && s.confidence < 0.45).length;
  /* 等级看清晰度，不看信噪比：连续说话、没有停顿的片段算不出可信的噪声底，
     但周期性（clarity）在任何片段上都成立。门限来自实测：干净近场 ≥ 0.8，
     笔记本内置麦约 0.6–0.75，远场嘈杂与重叠会掉到 0.55 以下。 */
  const level = clarityMed === null
    ? (med === null ? 'unknown' : (med >= 24 ? 'clean' : med >= 14 ? 'moderate' : 'noisy'))
    : (clarityMed >= 0.72 ? 'clean' : clarityMed >= 0.55 ? 'moderate' : 'noisy');
  return {
    snrDb: med === null ? null : Math.round(med),
    clarity: clarityMed === null ? null : Number(clarityMed.toFixed(2)),
    level,
    overlapSpans,
    noisySpans,
    lowConfSpans,
    spans: spans.length,
  };
}

function resultOf({ recordingId, engine, taskId, engineVersion, spans, status = 'completed', note = '' }) {
  return {
    recording_id: recordingId,
    segment_id: 'full',
    engine,
    engine_task_id: taskId,
    engine_version: engineVersion,
    status,
    note,
    quality: summarizeQuality(spans),
    speakers: spans.map((s) => ({
      engine_speaker_id: s.engineSpeakerId,
      start_ms: Math.round(s.startMs),
      end_ms: Math.round(s.endMs),
      confidence: s.confidence ?? null,
      snr_db: Number.isFinite(s.snrDb) ? s.snrDb : null,
      clarity: Number.isFinite(s.clarity) ? s.clarity : null,
      overlap: !!s.overlap,
      transcript_id: s.transcriptId,
      /* 句内切分后同一 transcript_id 会有多条：用 part_index 标顺序，
         没有切分的片段这两个字段为 null（旧读取方不受影响）。 */
      part_index: Number.isInteger(s.partIndex) ? s.partIndex : null,
      part_count: Number.isInteger(s.partCount) ? s.partCount : null,
    })),
  };
}

/* ══════════════════════════════════════════
   句内切分：一句里换人 → 拆成两段
   ══════════════════════════════════════════ */

/** 把一个转录区间摊成重叠分析窗；太短的句子返回空数组（不切） */
export function windowsOf(span) {
  const dur = (span.endMs || 0) - (span.startMs || 0);
  if (dur < SPLIT_MIN_SPAN_MS) return [];
  /* 一句话特别长时（例如 15 秒的上限）按步进会出 20 多个窗，
     手机上算起来太慢：超过 30 个窗就等比放大步进，仍保证覆盖整段。 */
  const raw = Math.ceil(dur / SPLIT_HOP_MS);
  const hop = raw > 30 ? Math.ceil(raw / 30) * SPLIT_HOP_MS : SPLIT_HOP_MS;
  const out = [];
  for (let t = span.startMs; t < span.endMs; t += hop) {
    const end = Math.min(span.endMs, t + SPLIT_WIN_MS);
    if (end - t < 400) break;
    out.push({ startMs: Math.round(t), endMs: Math.round(end) });
    if (end >= span.endMs) break;
  }
  return out.length >= 2 ? out : [];
}

/** 去掉「只跳一个窗又跳回来」的孤立标签：换人至少得撑住两个窗才算数 */
export function smoothLabels(labels) {
  const out = labels.slice();
  for (let i = 1; i < out.length - 1; i += 1) {
    if (out[i] === null || out[i + 1] === null) continue;
    if (out[i - 1] === out[i + 1] && out[i] !== out[i - 1]) out[i] = out[i - 1];
  }
  return out;
}

/**
 * 把一串带标签的窗压成连续片段，并把过短的片段并进较长的邻居。
 * 输入：按时间排好序的 [{ startMs, endMs, label }]
 * 输出：[{ label, startMs, endMs, units }]
 */
export function partsOf(units) {
  if (!units.length) return [];
  const groups = [];
  units.forEach((u) => {
    const last = groups[groups.length - 1];
    if (last && last.label === u.label) {
      last.endMs = u.endMs;
      last.units.push(u);
    } else {
      groups.push({ label: u.label, startMs: u.startMs, endMs: u.endMs, units: [u] });
    }
  });

  let merged = true;
  while (merged && groups.length > 1) {
    merged = false;
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      if (g.endMs - g.startMs >= SPLIT_MIN_PART_MS) continue;
      const prev = groups[i - 1];
      const next = groups[i + 1];
      const target = !prev ? next : (!next ? prev
        : ((prev.endMs - prev.startMs) >= (next.endMs - next.startMs) ? prev : next));
      target.startMs = Math.min(target.startMs, g.startMs);
      target.endMs = Math.max(target.endMs, g.endMs);
      target.units.push(...g.units);
      groups.splice(i, 1);
      merged = true;
      break;
    }
  }
  return groups;
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
    const clustered = autoCluster(
      withFeat.map((x) => x.feat.vector),
      withFeat[0].feat.weights,
    );
    const { labels, k, centers, pts, norm } = clustered;

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

    /* ── 句内切分：整句聚完还要看句子里有没有换人 ──
       只用整句特征会把人声平均掉（A 说前 3 秒、B 说后 3 秒，得到的是「两个人中间的声音」），
       所以对够长的句子再摊成 1.2s 小窗，用同一套归一化参数把它们归到整句聚类得到的中心上，
       连续窗换簇就断行。人数 k=1 时不切：整场只有一个人，切了只会碎。 */
    const splits = new Map();   // transcriptId -> { parts, radius }
    if (k > 1 && centers?.length) {
      const dists = pts.map((p, i) => dist(p, centers[labels[i]]));
      const radius = median(dists) || 0.5;
      onProgress?.(0.72, 'split');
      withFeat.forEach((x) => {
        const parts = splitSpanBySpeaker(pcm, x.span, centers, norm, radius);
        if (parts.length > 1) splits.set(x.span.id, { parts, radius });
      });
    }

    const spansOut = [];
    withFeat.forEach((x, i) => {
      const split = splits.get(x.span.id);
      if (split) {
        const { parts, radius } = split;
        parts.forEach((p, partIndex) => {
          const dMean = p.units.reduce((s, u) => s + u.d, 0) / p.units.length;
          const snrMean = p.units.reduce((s, u) => s + (Number.isFinite(u.feat.snrDb) ? u.feat.snrDb : 20), 0) / p.units.length;
          const overlap = p.units.some((u) => u.feat.overlap);
          const clarities = p.units.map((u) => u.feat.clarity).filter((c) => Number.isFinite(c));
          /* 置信度按「这几窗离本簇中心多远」算：小窗没有整句平均，天然比整句散，
             所以用 2.2 倍半径做缓冲，越靠近中心越可信。 */
          const conf = Math.max(0.3, Math.min(0.95, 0.95 - 0.45 * (dMean / (radius * 2.2 || 1))));
          const snrFactor = Math.max(0.55, Math.min(1, 0.55 + (snrMean / 30) * 0.45));
          const tuned = Math.max(0.2, Math.min(0.95, conf * snrFactor * (overlap ? 0.8 : 1)));
          spansOut.push({
            engineSpeakerId: `local_s${labelOf.get(p.label)}`,
            transcriptId: x.span.id,
            startMs: p.startMs,
            endMs: p.endMs,
            confidence: Number(tuned.toFixed(3)),
            snrDb: Math.round(snrMean),
            clarity: clarities.length ? Number(median(clarities).toFixed(2)) : null,
            overlap,
            cluster: labelOf.get(p.label),
            partIndex,
            partCount: parts.length,
          });
        });
        return;
      }

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
      /* 质量修正：远场噪声大、或这一段本身是两人同说时，归属可信度必然下降。
         不把音量当特征参与聚类（它不稳定），但要用它来标「这段别太当真」。 */
      const snr = Number.isFinite(x.feat.snrDb) ? x.feat.snrDb : 20;
      const snrFactor = Math.max(0.55, Math.min(1, 0.55 + (snr / 30) * 0.45));
      const tuned = Math.max(0.2, Math.min(0.95, conf * snrFactor * (x.feat.overlap ? 0.8 : 1)));
      spansOut.push({
        engineSpeakerId: `local_s${labelOf.get(group)}`,
        transcriptId: x.span.id,
        startMs: x.span.startMs,
        endMs: x.span.endMs,
        confidence: Number(tuned.toFixed(3)),
        snrDb: x.feat.snrDb,
        clarity: x.feat.clarity,
        overlap: x.feat.overlap,
        cluster: labelOf.get(group),
      });
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

/** 同一 transcript 可能有多条（句内按换人切分），这里按时间归拢 */
function spanList(result) {
  const m = new Map();
  (result?.speakers || []).forEach((s) => {
    if (!s.transcript_id) return;
    if (!m.has(s.transcript_id)) m.set(s.transcript_id, []);
    m.get(s.transcript_id).push(s);
  });
  m.forEach((list) => list.sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)));
  return m;
}

/** 在另一引擎的片段里找与给定区间重叠最多的那一条 */
function overlapPick(span, list) {
  let best = null;
  let bestOv = 0;
  (list || []).forEach((s) => {
    const ov = Math.min(span.end_ms || 0, s.end_ms || 0) - Math.max(span.start_ms || 0, s.start_ms || 0);
    if (ov > bestOv) { bestOv = ov; best = s; }
  });
  return best;
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
 * 在一句话内部找换人点：摊成小窗 → 用整句聚类得到的中心归类 → 连续换簇就断开。
 * @param {{data:Float32Array,sampleRate:number}} pcm
 * @param {{id:string,startMs:number,endMs:number}} span
 * @param {number[][]} centers 已投影空间中的簇中心
 * @param {{means:number[],sds:number[],weights:number[]}} norm
 * @param {number} radius 整句点到各自中心的距离中位数（用于算置信度）
 * @returns {Array<{label:number,startMs:number,endMs:number,units:Array}>} 至少 1 段
 */
export function splitSpanBySpeaker(pcm, span, centers, norm, radius = 0.5) {
  const wins = windowsOf(span);
  if (!wins.length || !centers?.length) return [];
  const units = [];
  wins.forEach((w) => {
    const feat = analyzeSpan(pcm, w, { padMs: SPLIT_PAD_MS });
    if (!feat) return;
    const p = projectVector(feat.vector, norm);
    let bestC = 0;
    let bestD = Infinity;
    centers.forEach((c, ci) => {
      const d = dist(p, c);
      if (d < bestD) { bestD = d; bestC = ci; }
    });
    units.push({ startMs: w.startMs, endMs: w.endMs, label: bestC, d: bestD, feat });
  });
  if (units.length < 2) return [];
  const sm = smoothLabels(units.map((u) => u.label));
  units.forEach((u, i) => { u.label = sm[i]; });
  const parts = partsOf(units);
  /* 分析窗本身是重叠的（1.2s 窗 / 0.6s 步进），直接拿窗边缘当边界会让相邻两段重叠半秒。
     取两个相邻窗中心的中点当切点，段与段首尾相接，时间轴才不重复计数。 */
  for (let i = 1; i < parts.length; i += 1) {
    const prevLast = parts[i - 1].units[parts[i - 1].units.length - 1];
    const nextFirst = parts[i].units[0];
    const cut = Math.round(
      ((prevLast.startMs + prevLast.endMs) / 2 + (nextFirst.startMs + nextFirst.endMs) / 2) / 2,
    );
    parts[i - 1].endMs = Math.min(cut, parts[i - 1].endMs);
    parts[i].startMs = Math.max(cut, parts[i].startMs);
  }
  if (parts.length) {
    parts[0].startMs = Math.min(parts[0].startMs, span.startMs);
    parts[parts.length - 1].endMs = Math.max(parts[parts.length - 1].endMs, span.endMs);
  }
  return parts;
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
  /* 句内切分后同一 transcript 会有多条，融合时必须按"条"对齐，
     不能再退回整句一条的老路，否则切出来的第二段说话人就被丢掉了。 */
  const localList = spanList(local);
  const cloudList = spanList(cloud);
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
    const lList = localList.get(t.id) || [];
    const cList = cloudList.get(t.id) || [];

    /* ── 句内切分：本机给出多段，就按多段落库 ── */
    if (lList.length > 1) {
      const parts = lList.map((sp) => {
        const c = overlapPick(sp, cList);
        let confidence = (sp.confidence ?? 0.5) * 0.92;
        let source = 'local';
        let conflict = false;
        if (c) {
          const mapped = mapping.get(c.engine_speaker_id) || null;
          if (mapped === sp.engine_speaker_id) {
            confidence = Math.min(0.97, ((sp.confidence ?? 0.5) + (c.confidence ?? 0.5)) / 2 + 0.06);
            source = 'local+cloud';
          } else {
            confidence = Math.min(0.85, Math.min(sp.confidence ?? 0.5, c.confidence ?? 0.5) * 0.72);
            conflict = true;
          }
        }
        return {
          startMs: sp.start_ms,
          endMs: sp.end_ms,
          cluster: sp.engine_speaker_id,
          confidence: Number(confidence.toFixed(3)),
          source,
          conflict,
        };
      });
      const dominant = parts.reduce(
        (a, b) => ((b.endMs - b.startMs) > (a.endMs - a.startMs) ? b : a),
        parts[0],
      );
      const anyConflict = parts.some((p) => p.conflict);
      if (anyConflict) conflicts += 1;
      covered += 1;
      assignments.push({
        transcriptId: t.id,
        cluster: dominant.cluster,
        confidence: dominant.confidence,
        source: parts.every((p) => p.source === 'local+cloud') ? 'local+cloud' : dominant.source,
        conflict: anyConflict,
        parts: parts.map((p) => ({
          startMs: p.startMs, endMs: p.endMs, cluster: p.cluster, confidence: p.confidence,
        })),
      });
      return;
    }

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
  const push = (c) => { if (c && !ordered.includes(c)) ordered.push(c); };
  assignments.forEach((a) => {
    /* 切分过的行按段的时间顺序取号：谁先开口谁是 Speaker 1，
       不能按"主导说话人"取号，否则一句里先说话的人反而编号靠后 */
    if (a.parts?.length) {
      [...a.parts].sort((x, y) => x.startMs - y.startMs).forEach((p) => push(p.cluster));
      push(a.cluster);
    } else {
      push(a.cluster);
    }
  });
  const map = new Map(ordered.map((c, i) => [c, i]));
  return assignments.map((a) => ({
    ...a,
    index: map.get(a.cluster),
    parts: a.parts ? a.parts.map((p) => ({ ...p, index: map.get(p.cluster) })) : a.parts,
  }));
}
