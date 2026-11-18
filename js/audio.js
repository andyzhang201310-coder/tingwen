/** 录音器：持续采集 + 30 秒分段 + 电平采样（对齐文档 5.1 / 5.2） */

/**
 * 音频质量档位 → MediaRecorder 码率（产品文档 7.1 设置页「音频质量」）。
 * 语音只需要 16k 采样，32 kbps opus 已经够听清；128 kbps 留给需要保留环境声或后制的场景。
 * 一小时录音大致体积：40 kbps≈18MB、64 kbps≈29MB、128 kbps≈58MB。
 */
export const AUDIO_BITRATES = { low: 40000, standard: 64000, high: 128000 };

export function bitrateOf(quality) {
  return AUDIO_BITRATES[quality] || AUDIO_BITRATES.standard;
}

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
    this.onPcm = null;     // 16kHz/16bit/mono 原始 PCM 帧回调（云端流式识别推流用）
    /* 麦克风被系统/其它应用打断（来电、语音助手、其它录音 App）：
       ended 是硬中断（轨道已死），mute/unmute 是软占用（可能自己恢复） */
    this.onTrackEnded = null;
    this.onMute = null;
    this.onUnmute = null;
    this._pcmNode = null;
    this._pcmSink = null;
    this.pcmFrames = 0;    // 已产出的 16k PCM 帧数（排查「识别中但无音频」用）
    this.pcmBytes = 0;
    this.pcmBufferSize = 0;
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

  async start({ bitrate = AUDIO_BITRATES.standard } = {}) {
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
    const options = { audioBitsPerSecond: bitrate };
    this.bitrate = bitrate;
    if (this.mime) options.mimeType = this.mime;
    this.rec = new MediaRecorder(this.stream, options);
    this.mime = this.rec.mimeType || this.mime || 'audio/webm';

    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this._buffer.push(e.data);
        if (this.elapsed - this._segStart >= this.segmentMs) this._flushSegment();
      }
    };
    this.rec.onerror = (e) => {
      console.warn('MediaRecorder error', e);
      /* 编码器/采集链路出错时轨道通常也已不可用，按硬中断上报 */
      this.onTrackEnded?.(e?.error?.name || 'recorderError');
    };

    /* 轨道级中断监听：Android 上来电或其它应用抢占麦克风时先 mute，拿不回来就 ended。
       mute 不立刻当失败（可能是系统短暂抢占，几秒后自行恢复），交给上层决定。 */
    const track = this.stream.getAudioTracks()[0];
    if (track) {
      this._track = track;
      track.addEventListener('ended', () => {
        if (!this.active) return;
        this.onTrackEnded?.('trackEnded');
      });
      track.addEventListener('mute', () => {
        if (!this.active) return;
        this.onMute?.();
      });
      track.addEventListener('unmute', () => {
        if (!this.active) return;
        this.onUnmute?.();
      });
    }

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

    /* 原始 PCM 采集：实时识别需要 16kHz/16bit/单声道。
       ScriptProcessor 把 AudioContext（通常 48kHz）的浮点样本线性降采样后回调。
       零增益节点接到 destination 是为了让回调在部分 WebView 里持续触发（不产生声音）。

       ⚠️ bufferSize 必须是 2 的幂（0 由实现决定）。这里以前写 1600，
       Android WebView 会直接抛 "must be 0 or a power of two between 256 and 16384"，
       PCM 节点创建失败 → 引擎一帧音频都收不到 → 状态显示「识别中」却永远不出字。 */
    if (this.ctx.createScriptProcessor) {
      for (const size of [2048, 4096, 1024, 8192]) {
        try {
          const proc = this.ctx.createScriptProcessor(size, 1, 1);
          const sink = this.ctx.createGain();
          sink.gain.value = 0;
          proc.onaudioprocess = (e) => {
            if (!this.active || this.paused || !this.onPcm) return;
            const input = e.inputBuffer.getChannelData(0);
            const pcm = resampleTo16k(input, this.ctx.sampleRate);
            if (pcm) {
              this.pcmFrames += 1;
              this.pcmBytes += pcm.byteLength;
              this.onPcm(pcm);
            }
          };
          src.connect(proc);
          proc.connect(sink);
          sink.connect(this.ctx.destination);
          this._pcmNode = proc;
          this._pcmSink = sink;
          this.pcmBufferSize = size;
          break;
        } catch (err) {
          console.warn('PCM 采集节点创建失败，尝试更小缓冲', size, err);
        }
      }
    }
    if (!this._pcmNode) console.warn('PCM 采集不可用，实时识别将没有音频输入');

    this._accum = 0;
    this._t0 = performance.now();
    this._pausedAt = null;
    this._segStart = 0;
    this._segIndex = 0;
    this.levels = [];
    this.segments = [];
    this._buffer = [];
    this.pcmFrames = 0;
    this.pcmBytes = 0;
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
    this._disconnectPcm();
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
    this._disconnectPcm();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
  }

  _disconnectPcm() {
    try { this._pcmNode?.disconnect(); } catch { /* ignore */ }
    try { this._pcmSink?.disconnect(); } catch { /* ignore */ }
    if (this._pcmNode) this._pcmNode.onaudioprocess = null;
    this._pcmNode = null;
    this._pcmSink = null;
  }
}

/** 浮点样本（ctx.sampleRate）→ 16kHz 16bit 单声道 ArrayBuffer */
function resampleTo16k(input, srcRate) {
  if (!input || !input.length) return null;
  const target = 16000;
  const ratio = srcRate / target;
  const outLen = Math.floor(input.length / ratio);
  if (outLen < 1) return null;
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const v = (input[i0] || 0) * (1 - frac) + (input[i0 + 1] || input[i0] || 0) * frac;
    const clamped = Math.max(-1, Math.min(1, v));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
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
    this.source = null;   // 当前装载的音频 Blob
    this.sourceKey = null; // 当前装载的是哪条录音：IndexedDB 读出的 Blob 每次都是新对象，只能按 id 认
    this.lastPos = 0;     // 最近一次有效播放位置（毫秒）：位置被意外抹掉时用来续上
    this._subs = new Set();
    this.rate = 1;
    this.audio.addEventListener('timeupdate', () => {
      if (this.audio.currentTime > 0.15) this.lastPos = this.audio.currentTime * 1000;
      this.emit('time');
    });
    this.audio.addEventListener('play', () => this.emit('state'));
    this.audio.addEventListener('pause', () => this.emit('state'));
    this.audio.addEventListener('ended', () => {
      this.lastPos = 0;   // 播完再点播放应当从头开始，别让位置守卫把尾巴续上
      this.emit('state');
      this.emit('ended');
    });
    this.audio.addEventListener('loadedmetadata', () => this.emit('loaded'));
  }

  on(cb) {
    this._subs.add(cb);
    return () => this._subs.delete(cb);
  }

  emit(type) {
    this._subs.forEach((cb) => cb(type, this));
  }

  /** 播放器里装的是不是这条录音（按 id 认，不按 Blob 引用——从库里读出来的 Blob 每次都是新对象） */
  isLoaded(key) {
    return !!key && this.sourceKey === key;
  }

  load(blob, key = null) {
    /* 同一条录音就不要再装一次：重新 load 会把 currentTime 清零，
       表现就是「点一下暂停，进度回到开头」。 */
    if (key && key === this.sourceKey) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.source = blob || null;
    this.sourceKey = key || null;
    this.lastPos = 0;
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
    /* 兜底：极少数情况下（重新装载音频源、浏览器回收媒体流水线）currentTime 会悄悄回到 0，
       这时 continue 就变成了「从头播」。用户主动拖动进度条会走 seek() 同步 lastPos，
       所以这里只在上次位置明显靠后、且播放器又真的停在 0 附近时接管。 */
    if (this.lastPos > 1200 && this.audio.currentTime < 0.35 && !this.audio.ended) {
      try { this.audio.currentTime = this.lastPos / 1000; } catch { /* ignore */ }
    }
    try { await this.audio.play(); } catch (e) { console.warn(e); }
  }
  pause() { this.audio.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(ms) {
    const d = this.durationMs || this.audio.duration * 1000;
    const target = Math.max(0, Math.min(ms, (d || ms) - 30));
    if (Number.isFinite(target)) {
      this.lastPos = target;   // 这是一次有意的跳转，位置守卫后续不该再把它拉回去
      this.audio.currentTime = target / 1000;
    }
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
    this.source = null;
    this.sourceKey = null;
    this.lastPos = 0;
    this.audio.removeAttribute('src');
  }
}
