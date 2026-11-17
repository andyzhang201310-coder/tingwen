/** 录音器：持续采集 + 30 秒分段 + 电平采样（对齐文档 5.1 / 5.2） */
export class Recorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.ctx = null;
    this.analyser = null;
    this.levels = [];
    this.segments = [];
    this._buffer = [];
    this._segStart = 0;
    this._segIndex = 0;
    this._accum = 0;
    this._t0 = 0;
    this._pausedAt = null;
    this._raf = null;
    this._lastLevel = 0;
    this.mime = '';
    this.active = false;
    this.paused = false;
    this.onSegment = null;
    this.onLevel = null;
    this.onFrame = null;   // 时域帧回调（实时发言人指示用，不落库）
    this.segmentMs = 30000;
  }

  get elapsed() {
    if (this._pausedAt) return this._accum;
    return this._accum + (performance.now() - this._t0);
  }

  static pickMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    if (!window.MediaRecorder) return '';
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风采集');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    this.mime = Recorder.pickMime();
    const options = { audioBitsPerSecond: 64000 };
    if (this.mime) options.mimeType = this.mime;
    this.rec = new MediaRecorder(this.stream, options);
    this.mime = this.rec.mimeType || this.mime || 'audio/webm';

    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this._buffer.push(e.data);
        if (this.elapsed - this._segStart >= this.segmentMs) this._flushSegment();
      }
    };
    this.rec.onerror = (e) => console.warn('MediaRecorder error', e);

    // 电平分析（不接 destination，避免回声）
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    src.connect(this.analyser);
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);
    this._time = new Uint8Array(this.analyser.fftSize);

    this._accum = 0;
    this._t0 = performance.now();
    this._pausedAt = null;
    this._segStart = 0;
    this._segIndex = 0;
    this.levels = [];
    this.segments = [];
    this._buffer = [];
    this.rec.start(2000);
    this.active = true;
    this.paused = false;
    this._tick();
    return { mime: this.mime };
  }

  _tick() {
    const loop = () => {
      if (!this.active) return;
      if (!this.paused && this.analyser) {
        this.analyser.getByteTimeDomainData(this._time);
        let sum = 0;
        for (let i = 0; i < this._time.length; i += 1) {
          const v = (this._time[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this._time.length);
        const v = Math.min(1, Math.pow(rms, 0.62) * 2.6);
        const t = this.elapsed;
        if (this.onFrame) this.onFrame(this._time);
        if (t - this._lastLevel > 45) {
          this.levels.push({ t, v });
          this._lastLevel = t;
          if (this.onLevel) this.onLevel(t, v);
        }
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _flushSegment() {
    if (!this._buffer.length) return;
    const blob = new Blob(this._buffer, { type: this.mime });
    const seg = {
      index: this._segIndex,
      startMs: Math.round(this._segStart),
      endMs: Math.round(this.elapsed),
      blob,
    };
    this.segments.push(seg);
    this._segIndex += 1;
    this._segStart = this.elapsed;
    this._buffer = [];
    if (this.onSegment) this.onSegment(seg);
  }

  pause() {
    if (!this.active || this.paused) return;
    this._accum += performance.now() - this._t0;
    this._pausedAt = performance.now();
    this.paused = true;
    try { this.rec.pause(); } catch { /* ignore */ }
    if (this.ctx?.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (!this.active || !this.paused) return;
    this._t0 = performance.now();
    this._pausedAt = null;
    this.paused = false;
    try { this.rec.resume(); } catch { /* ignore */ }
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  addMarker() {
    return Math.round(this.elapsed);
  }

  async stop() {
    if (!this.rec) return null;
    const duration = Math.round(this.elapsed);
    await new Promise((resolve) => {
      const done = () => resolve();
      this.rec.addEventListener('stop', done, { once: true });
      try { this.rec.stop(); } catch { resolve(); }
      setTimeout(resolve, 1200);
    });
    this._flushSegment();
    this.active = false;
    this.paused = false;
    cancelAnimationFrame(this._raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) { try { await this.ctx.close(); } catch { /* ignore */ } }

    const blob = new Blob(this.segments.map((s) => s.blob), { type: this.mime });
    const peaks = downsampleLevels(this.levels, duration, 900);
    return { blob, durationMs: duration, peaks, mime: this.mime, segments: this.segments };
  }

  abort() {
    try { this.rec?.stop(); } catch { /* ignore */ }
    this.active = false;
    cancelAnimationFrame(this._raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
  }
}

/** 电平 → 归一化波形点 */
export function downsampleLevels(levels, durationMs, count = 900) {
  if (!levels.length || !durationMs) return [];
  const bucket = durationMs / count;
  const out = [];
  let i = 0;
  for (let b = 0; b < count; b += 1) {
    const start = b * bucket;
    const end = start + bucket;
    let sum = 0;
    let n = 0;
    while (i < levels.length && levels[i].t < end) {
      if (levels[i].t >= start) { sum += levels[i].v; n += 1; }
      i += 1;
    }
    out.push({ t: Math.round(start), v: n ? sum / n : 0 });
  }
  // 轻度归一化，避免小音量看不出波形
  const max = out.reduce((m, p) => Math.max(m, p.v), 0) || 1;
  const gain = max < 0.35 ? Math.min(2.4, 0.55 / max) : 1;
  return out.map((p) => ({ t: p.t, v: Math.min(1, p.v * gain) }));
}

/** 从音频文件解码出波形（用于导入音频） */
export async function peaksFromFile(file, count = 900) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const data = audio.getChannelData(0);
    const duration = audio.duration * 1000;
    const bucket = Math.max(1, Math.floor(data.length / count));
    const out = [];
    for (let b = 0; b < count; b += 1) {
      let peak = 0;
      const start = b * bucket;
      for (let i = 0; i < bucket; i += 8) {
        const v = Math.abs(data[start + i] || 0);
        if (v > peak) peak = v;
      }
      out.push({ t: Math.round((b / count) * duration), v: peak });
    }
    const max = out.reduce((m, p) => Math.max(m, p.v), 0) || 1;
    return out.map((p) => ({ t: p.t, v: Math.min(1, p.v / max) }));
  } finally {
    ctx.close().catch(() => {});
  }
}

/** 播放器：单一 audio 元素 + 事件 */
export class Player {
  constructor(audioEl) {
    this.audio = audioEl;
    this.url = null;
    this._subs = new Set();
    this.rate = 1;
    this.audio.addEventListener('timeupdate', () => this.emit('time'));
    this.audio.addEventListener('play', () => this.emit('state'));
    this.audio.addEventListener('pause', () => this.emit('state'));
    this.audio.addEventListener('ended', () => { this.emit('state'); this.emit('ended'); });
    this.audio.addEventListener('loadedmetadata', () => this.emit('loaded'));
  }

  on(cb) {
    this._subs.add(cb);
    return () => this._subs.delete(cb);
  }

  emit(type) {
    this._subs.forEach((cb) => cb(type, this));
  }

  load(blob) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = blob ? URL.createObjectURL(blob) : null;
    this.audio.src = this.url || '';
    this.audio.load();
  }

  get currentMs() { return (this.audio.currentTime || 0) * 1000; }
  get durationMs() {
    const d = this.audio.duration;
    return Number.isFinite(d) ? d * 1000 : 0;
  }
  get playing() { return !this.audio.paused && !this.audio.ended; }

  async play() {
    try { await this.audio.play(); } catch (e) { console.warn(e); }
  }
  pause() { this.audio.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(ms) {
    const d = this.durationMs || this.audio.duration * 1000;
    const target = Math.max(0, Math.min(ms, (d || ms) - 30));
    if (Number.isFinite(target)) this.audio.currentTime = target / 1000;
  }

  nudge(ms) { this.seek(this.currentMs + ms); }

  setRate(r) {
    this.rate = r;
    this.audio.playbackRate = r;
  }

  destroy() {
    this.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.audio.removeAttribute('src');
  }
}
