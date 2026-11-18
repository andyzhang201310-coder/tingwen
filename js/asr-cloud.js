/**
 * 云端流式实时识别（阿里百炼 WebSocket，经本地 asr-proxy 注入鉴权头）
 *
 * 与 createASR（Web Speech API）接口一致：start/stop/pause/resume/destroy/voice，
 * 结果同样通过 onInterim / onFinal / onStatus 回调，录音页无需关心引擎差异。
 *
 * 输入：audio.js 的 onPcm 回调持续喂 16kHz 16bit mono PCM（ArrayBuffer）。
 * 输出：解析百炼 result-generated 事件里的中间结果与最终结果。
 */

/** 从百炼 fetch-generated / result-generated 事件里提取文本与是否最终句 */
function parseResult(evt) {
  const payload = evt?.payload || {};
  const content = payload.choices?.[0]?.message?.content
    ?? payload.output?.text
    ?? '';
  let text = '';
  let stable = false;
  if (typeof content === 'string') {
    const raw = content.trim();
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        text = items.map((it) => it?.text || it?.transcript || '').join('');
        stable = items.some((it) => it?.sentence?.end != null || it?.stable === true);
      } catch {
        text = raw;
      }
    } else {
      text = raw;
    }
  } else if (Array.isArray(content)) {
    text = content.map((it) => it?.text || '').join('');
    stable = true;
  }
  return { text: text.trim(), stable };
}

export function createCloudASR({
  proxyUrl = '',
  key = '',
  model = 'paraformer-realtime-v2',
  workspaceId = '',
  lang = 'zh-CN',
  getElapsed,
  onFinal,
  onInterim,
  onStatus,
} = {}) {
  const api = {
    supported: !!(proxyUrl && key),
    active: false,
    paused: false,
    engine: 'cloud',
    start,
    stop,
    pause,
    resume,
    destroy,
    voice() {},   // 云端有自己的 VAD，不需要电平喂狗
    feed,
  };

  if (!api.supported) {
    onStatus?.({ state: 'unsupported', reason: !proxyUrl ? 'noProxy' : 'noKey' });
    return api;
  }

  let ws = null;
  let started = false;
  let finalSent = false;
  let intentionalStop = false;
  let retryTimer = null;
  let connectTimer = null;   // 连接握手超时：连错误 IP 时 TCP 会长时间挂起，onerror 不来，必须主动判失败
  let retryStep = 0;
  let interleaved = '';          // 当前未定稿的中间结果
  const RETRY_DELAYS = [500, 1200, 2500];
  /* 帧缓冲：ScriptProcessor 每 100ms 给一帧 1600 样本，正好一帧一发；
     若某些 WebView 给更小帧，这里攒够 1600 个样本再发，保证 100ms/帧。 */
  let frameBuf = new Uint8Array(0);

  function normalizeUrl() {
    let u = String(proxyUrl).trim();
    if (/^http:\/\//i.test(u)) u = u.replace(/^http:/i, 'ws:');
    if (/^https:\/\//i.test(u)) u = u.replace(/^https:/i, 'wss:');
    if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`;
    /* 用户可能填的是根地址或带 healthz，统一到 /ws/asr */
    try {
      const url = new URL(u);
      if (!url.pathname || url.pathname === '/' || url.pathname.endsWith('/healthz')) {
        url.pathname = '/ws/asr';
      }
      return url.toString();
    } catch {
      return u;
    }
  }

  function clearRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  function scheduleRetry() {
    if (intentionalStop || api.paused) return;
    const wait = RETRY_DELAYS[Math.min(retryStep, RETRY_DELAYS.length - 1)];
    retryStep += 1;
    clearRetry();
    onStatus?.({ state: 'network', attempts: retryStep });
    retryTimer = setTimeout(() => { if (!intentionalStop && !api.paused) startOnce(); }, wait);
  }

  function flushInterim() {
    const t = interleaved.trim();
    interleaved = '';
    if (t.length >= 2) onFinal?.({ text: t, at: getElapsed?.() ?? 0, partial: true, engine: 'cloud' });
  }

  function startOnce() {
    clearRetry();
    started = false;
    finalSent = false;
    interleaved = '';
    frameBuf = new Uint8Array(0);
    onStatus?.({ state: 'starting' });

    let url;
    try { url = normalizeUrl(); } catch (e) {
      onStatus?.({ state: 'error', code: 'badProxyUrl' });
      return;
    }

    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';

    /* 4 秒还没进入 task-started 就判失败：连错误 IP/端口时 TCP 握手会挂几十秒，
       onerror 迟迟不触发，上层 auto 模式的「失败 2 秒回退」就永远等不到 network 状态。
       主动判失败后走 scheduleRetry → network → 上层及时回退到系统原生识别。 */
    connectTimer = setTimeout(() => {
      if (started || intentionalStop || api.paused) return;
      onStatus?.({ state: 'network', reason: 'connectTimeout' });
      try { ws.close(); } catch { /* ignore */ }
      scheduleRetry();
    }, 4000);

    ws.onopen = () => {
      retryStep = 0;
      const l = lang === 'en-US' ? 'en' : lang === 'auto' ? 'auto' : 'zh';
      ws.send(JSON.stringify({
        action: 'start',
        key,
        model,
        workspaceId,
        format: 'pcm',
        sampleRate: 16000,
        lang: l,
      }));
    };

    ws.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)); }
      catch { return; }
      const header = evt.header || {};
      const ev = header.event || header.action || evt.action;
      if (ev === 'task-started') {
        clearTimeout(connectTimer);
        connectTimer = null;
        if (!started) {
          started = true;
          api.active = true;
          onStatus?.({ state: 'listening' });
        }
        return;
      }
      if (ev === 'result-generated' || ev === 'transcription-generated') {
        const { text, stable } = parseResult(evt);
        if (!text) return;
        if (stable) {
          /* 百炼 result-generated 是句子级最终结果：直接落库，并清掉此前的临时行 */
          interleaved = '';
          onFinal?.({ text, at: getElapsed?.() ?? 0, engine: 'cloud' });
        } else {
          interleaved = text;
          onInterim?.({ text, at: getElapsed?.() ?? 0 });
        }
        return;
      }
      if (ev === 'task-finished') {
        finalSent = true;
        flushInterim();
        api.active = false;
        onStatus?.({ state: 'listening' });
        return;
      }
      if (ev === 'error') {
        const code = evt.payload?.code || 'upstream';
        onStatus?.({ state: 'error', code, message: evt.payload?.message || '' });
        /* 鉴权/参数类错误不重试：重试也不会好，且会掩盖真正原因 */
        if (/key|auth|permission|param|model/i.test(code)) {
          intentionalStop = true;
          api.supported = false;
        } else {
          scheduleRetry();
        }
      }
    };

    ws.onerror = () => {
      /* onerror 后通常紧跟 onclose，这里只标记，重连交给 onclose 统一处理 */
    };

    ws.onclose = () => {
      const wasIntentional = intentionalStop || api.paused;
      api.active = false;
      if (!wasIntentional) scheduleRetry();
    };
  }

  function feed(pcmBuffer) {
    if (!api.active || api.paused || !ws || ws.readyState !== WebSocket.OPEN || !started) return;
    let chunk = pcmBuffer;
    if (!(chunk instanceof ArrayBuffer)) chunk = new Uint8Array(chunk).buffer;
    if (chunk.byteLength === 3200) {
      ws.send(chunk);
      return;
    }
    /* 攒帧：不足 100ms 的片段拼起来，避免发过小的帧被服务端判为抖动 */
    const incoming = new Uint8Array(chunk);
    const merged = new Uint8Array(frameBuf.length + incoming.length);
    merged.set(frameBuf, 0);
    merged.set(incoming, frameBuf.length);
    let offset = 0;
    while (merged.length - offset >= 3200) {
      ws.send(merged.slice(offset, offset + 3200).buffer);
      offset += 3200;
    }
    frameBuf = merged.slice(offset);
  }

  function start() {
    intentionalStop = false;
    api.paused = false;
    retryStep = 0;
    startOnce();
  }

  function pause() {
    api.paused = true;
    flushInterim();
    clearRetry();
    /* 不关闭 WebSocket：保留会话，暂停期间只是不推音频（服务端的 VAD 会把它当静音） */
    onStatus?.({ state: 'paused' });
  }

  function resume() {
    if (!api.paused) return;
    api.paused = false;
    if (started) onStatus?.({ state: 'listening' });
    else startOnce();
  }

  function stop() {
    if (intentionalStop && !ws) return;
    intentionalStop = true;
    api.paused = false;
    clearRetry();
    flushInterim();
    if (ws && ws.readyState === WebSocket.OPEN && started && !finalSent) {
      try { ws.send(JSON.stringify({ action: 'finish' })); } catch { /* ignore */ }
      /* 给服务端一点时间回 task-finished 和尾句，再关闭 */
      setTimeout(() => { try { ws?.close(); } catch { /* ignore */ } }, 600);
    } else if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
    ws = null;
    api.active = false;
  }

  function destroy() {
    intentionalStop = true;
    clearRetry();
    flushInterim();
    try { ws?.close(); } catch { /* ignore */ }
    ws = null;
    api.active = false;
    onStatus = null;
    onFinal = null;
    onInterim = null;
  }

  return api;
}

/** 判断当前是否运行在 Capacitor 原生环境（避免直接 import @capacitor/core 造成打包问题） */
export function isNativePlatform() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    ? window.Capacitor.isNativePlatform()
    : window.NativeStorage || window.Capacitor?.Plugins);
}
