/**
 * 补识别（断网恢复后对已录音频重跑识别）—— 对应产品文档 8.2「断网恢复」
 *
 * 设计要点：
 * 1. 识别中断（network / error / unstable / unsupported）属于「已知丢失」，录音页实时开窗；
 *    结尾超过 5 秒没有新转录，也算未覆盖（识别可能滞后）。
 * 2. 断网只影响识别，录音与分段落盘继续（8.2 前半句已在 record.js 保证）。
 * 3. 补处理需要能读取音频文件的识别引擎：浏览器实时识别（Web Speech API）只能听麦克风，
 *    所以必须走用户自己配置的云端识别接口；未配置时明确返回「需配置」，不伪造结果。
 * 4. MediaRecorder 的分段只有第一段带容器头，中间段无法单独解码，
 *    因此补识别解码整段音频再按区间切片；为控制内存，对超长录音只标记不自动执行。
 */
import {
  getRecording, listTranscripts, addTranscript,
  listAsrJobs, addAsrJob, updateAsrJob, clearSegments,
  updateRecording, clearSummaries,
} from './store.js';
import { decodeMono } from './diarize.js';
import { T } from './i18n.js';

/** 超过这个长度不自动解码补识别（16 kHz 单声道 Float32 约 3.84 MB/分钟） */
export const REPAIR_MAX_MS = 20 * 60 * 1000;
/** 小于这个长度的缺口不值得单独发请求 */
const MIN_GAP_MS = 1200;
/** 结尾多久没有新转录算未覆盖 */
const TAIL_MS = 5000;

/* ───────── 区间运算 ───────── */

export function mergeRanges(ranges = []) {
  const list = ranges
    .map((r) => ({ startMs: Math.max(0, Math.round(r.startMs)), endMs: Math.round(r.endMs) }))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs + 200) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

function subtract(ranges, covers) {
  let out = ranges.map((r) => ({ ...r }));
  for (const c of covers) {
    const next = [];
    for (const r of out) {
      if (c.endMs <= r.startMs || c.startMs >= r.endMs) { next.push(r); continue; }
      if (c.startMs > r.startMs) next.push({ startMs: r.startMs, endMs: c.startMs });
      if (c.endMs < r.endMs) next.push({ startMs: c.endMs, endMs: r.endMs });
    }
    out = next;
  }
  return out;
}

/**
 * 计算未识别区间
 * @param {object} p
 * @param {Array<{startMs:number,endMs:number}>} p.windows 识别中断窗口（录音过程中记录）
 * @param {Array} p.transcripts 已有转录（可能包含补识别结果，用于回填后消除缺口）
 * @param {number} p.durationMs 录音总长
 */
export function collectGaps({ windows = [], transcripts = [], durationMs = 0 }) {
  const covered = mergeRanges(transcripts.map((t) => ({ startMs: t.startMs, endMs: t.endMs })));
  const lastEnd = covered.length ? covered[covered.length - 1].endMs : 0;
  const want = mergeRanges(windows);
  if (durationMs - lastEnd > TAIL_MS) {
    want.push({ startMs: Math.max(lastEnd, 0), endMs: durationMs, kind: 'tail' });
  }
  const gaps = subtract(want, covered)
    .filter((r) => r.endMs - r.startMs >= MIN_GAP_MS)
    .map((r) => ({
      kind: r.kind || 'gap',
      startMs: r.startMs,
      endMs: r.endMs,
      // 时间轴校准：转录时间戳是估算的，缺口边界向内收 400 ms，避免切到已识别的话头
      clipStartMs: Math.min(r.endMs, r.startMs + 400),
      clipEndMs: Math.max(r.startMs, r.endMs - 200),
    }));
  return gaps;
}

/* ───────── 入队与统计 ───────── */

/** 把缺口写进 asrJobs，已有任务覆盖 60% 以上的区间不重复入队 */
export async function enqueueGaps(recordingId, gaps) {
  if (!gaps?.length) return [];
  const exists = await listAsrJobs(recordingId);
  const created = [];
  for (const g of gaps) {
    const dup = exists.some((j) => {
      const overlap = Math.min(j.endMs, g.endMs) - Math.max(j.startMs, g.startMs);
      return overlap > 0 && overlap >= (g.endMs - g.startMs) * 0.6;
    });
    if (dup) continue;
    created.push(await addAsrJob({ recordingId, kind: g.kind, startMs: g.startMs, endMs: g.endMs }));
  }
  return created;
}

/** 未完成 / 已完成 / 失败 的统计，供录音页与文稿页展示 */
export async function pendingSummary(recordingId) {
  const jobs = await listAsrJobs(recordingId);
  const open = jobs.filter((j) => j.status === 'pending' || j.status === 'processing');
  const failed = jobs.filter((j) => j.status === 'failed');
  const done = jobs.filter((j) => j.status === 'completed');
  const totalMs = [...open, ...failed].reduce((n, j) => n + (j.endMs - j.startMs), 0);
  return { jobs, open, failed, done, count: open.length + failed.length, totalMs };
}

export function canRepair(settings) {
  return !!(settings?.asrCloudUrl || '').trim();
}

/* ───────── 音频切片与 WAV 编码 ───────── */

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const put = (off, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i)); };
  put(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  view.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function sliceMs(decoded, startMs, endMs) {
  const rate = decoded.sampleRate;
  const a = Math.max(0, Math.floor((startMs / 1000) * rate));
  const b = Math.min(decoded.data.length, Math.ceil((endMs / 1000) * rate));
  if (b <= a) return new Float32Array(0);
  return decoded.data.subarray(a, b);
}

/* ───────── 云端识别调用 ───────── */

/**
 * 清洗云端返回的文本。
 * SenseVoice 一类模型会把情感/音频事件标签直接拼进文本（如末尾的 😊、😂，
 * 或 <|happy|> / <|Speech|> 这类 token），这些对转写文稿是噪音，需去掉。
 * 只挑明确的标签与表情，不碰正常标点与中日韩文字。
 */
function cleanCloudText(s = '') {
  return String(s)
    .replace(/<\|[A-Za-z]+\|>/g, '')                    // <|happy|> / <|Speech|> 等模型 token
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '') // 情感/事件 emoji
    .replace(/[ \t]{2,}/g, ' ')                           // 去标签后可能留下的重复空格
    .trim();
}

async function postClip({ url, key, model, lang, blob, startMs, endMs }) {
  const form = new FormData();
  form.append('file', blob, `clip-${startMs}-${endMs}.wav`);
  form.append('model', model || 'whisper-1');
  form.append('language', lang === 'en-US' ? 'en' : 'zh');
  form.append('response_format', 'json');
  form.append('start_ms', String(startMs));
  form.append('end_ms', String(endMs));
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}${detail ? ` · ${detail.slice(0, 120)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error('响应不是 JSON');
  if (Array.isArray(data.segments) && data.segments.length) {
    return data.segments.map((s) => ({ text: cleanCloudText(s.text), startMs: s.startMs ?? s.start, endMs: s.endMs ?? s.end })).filter((s) => s.text);
  }
  const text = cleanCloudText(data.text || data.transcription);
  return text ? [{ text, startMs, endMs }] : [];
}

/* ───────── 执行补识别 ───────── */

/**
 * @returns {{ok:boolean, reason?:string, done:number, failed:number, added:number, needConfig?:boolean}}
 */
export async function runRepair(recordingId, { settings, onProgress } = {}) {
  const rec = await getRecording(recordingId);
  if (!rec) return { ok: false, reason: 'noRecording', done: 0, failed: 0, added: 0 };
  const sum = await pendingSummary(recordingId);
  const jobs = [...sum.open, ...sum.failed];
  if (!jobs.length) return { ok: true, reason: 'nothing', done: 0, failed: 0, added: 0 };

  if (!canRepair(settings)) {
    for (const j of jobs) await updateAsrJob(j.id, { reason: 'noCloud' });
    return { ok: false, reason: 'noCloud', needConfig: true, done: 0, failed: 0, added: 0 };
  }
  if (!rec.audio) {
    for (const j of jobs) await updateAsrJob(j.id, { status: 'skipped', reason: 'noAudio' });
    return { ok: false, reason: 'noAudio', done: 0, failed: 0, added: 0 };
  }
  if ((rec.durationMs || 0) > REPAIR_MAX_MS) {
    for (const j of jobs) await updateAsrJob(j.id, { reason: 'tooLong' });
    return { ok: false, reason: 'tooLong', done: 0, failed: 0, added: 0, needConfig: false };
  }

  let decoded;
  try {
    decoded = await decodeMono(rec.audio, 16000);
  } catch (err) {
    for (const j of jobs) await updateAsrJob(j.id, { reason: `decode:${err.message}`.slice(0, 120) });
    return { ok: false, reason: 'decode', done: 0, failed: 0, added: 0 };
  }

  let done = 0;
  let failed = 0;
  let added = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    onProgress?.({ index: i, total: jobs.length, job });
    await updateAsrJob(job.id, { status: 'processing' });
    try {
      const pcm = sliceMs(decoded, job.startMs, job.endMs);
      if (!pcm.length) {
        await updateAsrJob(job.id, { status: 'completed', reason: 'emptyRange', text: '' });
        done += 1;
        continue;
      }
      const wav = encodeWav(pcm, decoded.sampleRate);
      const parts = await postClip({
        url: settings.asrCloudUrl.trim(),
        key: settings.asrCloudKey,
        model: settings.asrCloudModel,
        lang: settings.lang,
        blob: wav,
        startMs: job.startMs,
        endMs: job.endMs,
      });
      const ids = [];
      for (const p of parts) {
        const row = await addTranscript({
          recordingId,
          startMs: Math.round(p.startMs ?? job.startMs),
          endMs: Math.round(p.endMs ?? job.endMs),
          text: p.text,
          engine: 'cloud',
          status: 'final',
          source: 'repair',
          speakerSource: 'automatic',
          speakerEngine: 'cloud',
        });
        ids.push(row.id);
        added += 1;
      }
      await updateAsrJob(job.id, {
        status: 'completed',
        attempts: (job.attempts || 0) + 1,
        text: parts.map((p) => p.text).join(' '),
        transcriptIds: ids,
        reason: parts.length ? '' : 'silent',
      });
      done += 1;
    } catch (err) {
      failed += 1;
      await updateAsrJob(job.id, {
        status: 'failed',
        attempts: (job.attempts || 0) + 1,
        reason: String(err.message || err).slice(0, 160),
      });
    }
  }

  /* 收尾：全部完成则删掉保留的分段与任务，并作废旧总结 */
  const after = await pendingSummary(recordingId);
  if (after.count === 0) {
    await clearSegments(recordingId);
    await updateRecording(recordingId, { pending: { count: 0, totalMs: 0 } });
  } else {
    await updateRecording(recordingId, { pending: { count: after.count, totalMs: after.totalMs } });
  }
  if (added) await clearSummaries(recordingId);

  return { ok: failed === 0, done, failed, added };
}

/** 网络恢复后自动跑一遍（只处理已配置云端识别接口的录音） */
export async function autoRepair({ settings, recordings = [] } = {}) {
  if (!canRepair(settings) || settings.repairAuto === false) return { ran: 0, added: 0 };
  let ran = 0;
  let added = 0;
  for (const rec of recordings) {
    const sum = await pendingSummary(rec.id);
    if (!sum.count) continue;
    if (!rec.audio) continue;
    const res = await runRepair(rec.id, { settings });
    if (res.ok) { ran += 1; added += res.added; }
  }
  return { ran, added };
}

/** 文案：把失败原因翻成用户能懂的一句话 */
export function repairReasonText(reason) {
  if (!reason) return '';
  if (reason === 'noCloud') return T('repair.reasonNoCloud');
  if (reason === 'noAudio') return T('repair.reasonNoAudio');
  if (reason === 'tooLong') return T('repair.reasonTooLong');
  if (reason === 'silent') return T('repair.reasonSilent');
  if (reason.startsWith('decode')) return T('repair.reasonDecode');
  return reason;
}
