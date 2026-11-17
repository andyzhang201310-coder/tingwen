import { createRecording, addTranscript } from './store.js';

/* 演示会议：三位发言人，音高差异明显，便于本机声学聚类真实区分 */
const DEMO_TEXT = [
  { startMs: 800, f0: 108, speaker: 'm1', text: '今天主要确认三件事：版本发布时间、测试范围，还有上线之后的支持安排。' },
  { startMs: 7400, f0: 210, speaker: 'f1', text: '测试这边需要覆盖两小时连续录音，弱网、锁屏和来电中断也要一起验证。' },
  { startMs: 15200, f0: 155, speaker: 'm2', text: '我建议先灰度百分之十的用户，观察两天，指标正常再全量。' },
  { startMs: 22600, f0: 108, speaker: 'm1', text: '结论就按灰度来，周三之前完成客户端和服务端的版本对齐。' },
  { startMs: 30000, f0: 210, speaker: 'f1', text: '我想确认一下，崩溃率的上限是多少？超出以后要不要自动回滚？' },
  { startMs: 37200, f0: 155, speaker: 'm2', text: '我来负责验收清单，明天整理好发到群里。' },
  { startMs: 43600, f0: 108, speaker: 'm1', text: '另外记得把旧版本的崩溃日志清理掉，避免干扰判断。' },
  { startMs: 49800, f0: 210, speaker: 'f1', text: '如果发现问题，负责人当天同步，不要等到周会再说。' },
  { startMs: 56200, f0: 155, speaker: 'm2', text: '还有一点，回滚方案需要提前写好，不然临时处理会很慌。' },
];
const DEMO_DURATION = 63000;

function buildWave(durationMs, segments, sampleRate = 16000) {
  const total = Math.floor((durationMs / 1000) * sampleRate);
  const data = new Float32Array(total);
  segments.forEach((seg, idx) => {
    const start = Math.floor((seg.startMs / 1000) * sampleRate);
    const spell = Math.min(seg.text.length * 190, 6400);
    const end = Math.min(total, start + Math.floor((spell / 1000) * sampleRate));
    for (let i = start; i < end; i += 1) {
      const t = (i - start) / sampleRate;
      const syll = Math.abs(Math.sin(t * (4.6 + (idx % 3) * 0.7) * Math.PI));
      const env = Math.pow(syll, 1.6) * Math.min(1, (i - start) / 600) * Math.min(1, (end - i) / 900);
      // 基频按人区分，并加入极轻微抖动，接近真实嗓音而不是纯音
      const f = seg.f0 * (1 + Math.sin(t * 2.1) * 0.012);
      const v = (Math.sin(2 * Math.PI * f * t) * 0.58
        + Math.sin(2 * Math.PI * f * 2 * t) * 0.24
        + Math.sin(2 * Math.PI * f * 3 * t) * 0.11
        + Math.sin(2 * Math.PI * f * 4 * t) * 0.05);
      data[i] = v * env * 0.42;
    }
  });

  // 16bit PCM WAV
  const bytes = 44 + total * 2;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, total * 2, true);
  for (let i = 0; i < total; i += 1) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(44 + i * 2, s * 32767, true);
  }

  // 波形点
  const bucket = Math.max(1, Math.floor(total / 900));
  const peaks = [];
  for (let b = 0; b < 900; b += 1) {
    let peak = 0;
    const off = b * bucket;
    for (let i = 0; i < bucket; i += 6) {
      const v = Math.abs(data[off + i] || 0);
      if (v > peak) peak = v;
    }
    peaks.push({ t: Math.round((b / 900) * durationMs), v: Math.min(1, peak / 0.4) });
  }

  return { blob: new Blob([buf], { type: 'audio/wav' }), peaks };
}

export async function createDemoRecording() {
  const durationMs = DEMO_DURATION;
  const { blob, peaks } = buildWave(durationMs, DEMO_TEXT);
  const startedAt = Date.now() - 1000 * 60 * 47;
  const rec = await createRecording({
    title: '产品评审 · 1.2 版本',
    scenario: '会议',
    folder: '会议',
    status: 'saved',
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    audio: blob,
    size: blob.size,
    peaks,
    mime: 'audio/wav',
    engineMode: 'auto',
    engineUsed: 'browser',
    bookmarks: [{ ms: 22600, note: '结论' }],
  });
  for (let i = 0; i < DEMO_TEXT.length; i += 1) {
    const cur = DEMO_TEXT[i];
    const next = DEMO_TEXT[i + 1];
    await addTranscript({
      recordingId: rec.id,
      startMs: cur.startMs,
      endMs: (next ? next.startMs : durationMs) - 260,
      text: cur.text,
      engine: 'browser',
      status: 'final',
    });
  }
  return rec;
}
