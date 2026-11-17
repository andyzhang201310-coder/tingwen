/**
 * 浏览器实时语音识别封装（Web Speech API）
 * - 说明：这是 Web 原型可用的实时引擎，能力来自浏览器/系统提供的识别服务，
 *   与文档中 whisper.cpp（本地）和云端实时 API 属于不同实现，接口层保持可替换。
 */
export function createASR({ lang = 'zh-CN', getElapsed, onFinal, onInterim, onStatus, onLevel }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const api = {
    supported: !!SR,
    active: false,
    paused: false,
    start,
    stop,
    pause,
    resume,
    destroy,
  };

  if (!SR) {
    onStatus?.({ state: 'unsupported' });
    return api;
  }

  let recog = null;
  let restartTimer = null;
  let rapidRestarts = 0;
  let lastStartAt = 0;
  let intentionalStop = false;

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;

    r.onstart = () => {
      api.active = true;
      rapidRestarts = 0;
      onStatus?.({ state: 'listening' });
    };

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const text = (res[0]?.transcript || '').trim();
        if (!text) continue;
        if (res.isFinal) {
          onFinal?.({ text, confidence: res[0]?.confidence || null, at: getElapsed?.() ?? 0 });
        } else {
          interim += text;
        }
      }
      if (interim) onInterim?.({ text: interim, at: getElapsed?.() ?? 0 });
      else onInterim?.({ text: '', at: getElapsed?.() ?? 0 });
    };

    r.onerror = (e) => {
      const code = e.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        onStatus?.({ state: 'denied' });
        api.active = false;
        intentionalStop = true;
        return;
      }
      if (code === 'network') {
        onStatus?.({ state: 'network' });
        return;
      }
      onStatus?.({ state: 'error', code });
    };

    r.onend = () => {
      api.active = false;
      if (intentionalStop || api.paused) return;
      if (!api.supported) return;
      const now = performance.now();
      rapidRestarts = now - lastStartAt < 900 ? rapidRestarts + 1 : 0;
      if (rapidRestarts > 6) {
        onStatus?.({ state: 'unstable' });
        return;
      }
      restartTimer = setTimeout(() => {
        if (intentionalStop || api.paused) return;
        try { startOnce(); } catch { /* ignore */ }
      }, 220);
    };
    return r;
  }

  function startOnce() {
    lastStartAt = performance.now();
    recog = build();
    try {
      recog.start();
    } catch (e) {
      onStatus?.({ state: 'error', code: String(e?.message || e) });
    }
  }

  function start() {
    intentionalStop = false;
    api.paused = false;
    if (recog) { try { recog.stop(); } catch { /* ignore */ } }
    startOnce();
  }

  function pause() {
    api.paused = true;
    clearTimeout(restartTimer);
    try { recog?.stop(); } catch { /* ignore */ }
  }

  function resume() {
    if (!api.paused) return;
    api.paused = false;
    intentionalStop = false;
    startOnce();
  }

  function stop() {
    intentionalStop = true;
    api.paused = false;
    clearTimeout(restartTimer);
    try { recog?.stop(); } catch { /* ignore */ }
    recog = null;
    api.active = false;
  }

  function destroy() {
    stop();
    onStatus = null;
  }

  return api;
}

/** 根据文本长度估算该段语音覆盖的时间区间（用于时间戳对齐） */
export function estimateSpan(text, elapsed, lastEnd) {
  const chars = (text || '').length;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (text.match(/\b[a-zA-Z]+\b/g) || []).length;
  let est = cjk * 210 + words * 340;
  est = Math.max(700, Math.min(15000, est || chars * 160));
  const end = Math.max(lastEnd + 200, elapsed);
  const start = Math.max(lastEnd, end - est);
  return { startMs: Math.round(start), endMs: Math.round(end) };
}
