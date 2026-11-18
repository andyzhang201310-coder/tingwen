/**
 * 原生端实时识别（Capacitor speech-recognition 插件，调用系统识别引擎）
 *
 * 只在真机（Capacitor 原生容器）里可用；PWA 网页端插件加载不到，会标记 unsupported。
 * 接口与 createASR 一致，结果走 onInterim / onFinal / onStatus。
 *
 * 说明：Android 的识别能力由系统 SpeechRecognizer 提供，不同厂商/机型、是否装了
 * Google 服务会影响可用性和准确率。因此适配层会在云端流式失败时回退到这里，
 * 而不是反过来；原生不可用时再回退到 Web Speech API。
 */

export async function createNativeASR({
  lang = 'zh-CN',
  getElapsed,
  onFinal,
  onInterim,
  onStatus,
} = {}) {
  const api = {
    supported: false,
    active: false,
    paused: false,
    engine: 'native',
    start,
    stop,
    pause,
    resume,
    destroy,
    feed() {},   // 原生引擎自己采集，不吃 PCM 帧
    voice() {},
  };

  let SR = null;
  let listeners = [];
  let starting = false;
  let intentionalStop = false;
  let finalAccepted = false;

  /* Capacitor 插件通过 window.Capacitor.Plugins 暴露（原生 WebView 注入），
     不走 ES import —— 项目是免构建的，WebView 无法解析 npm 包名。 */
  try {
    const plugins = window.Capacitor?.Plugins;
    SR = plugins?.SpeechRecognition || null;
  } catch (e) {
    SR = null;
  }
  if (!SR || typeof SR.start !== 'function') {
    onStatus?.({ state: 'unsupported', reason: 'noPlugin' });
    return api;
  }

  try {
    const ok = await SR.available();
    if (!ok?.available) {
      onStatus?.({ state: 'unsupported', reason: 'unavailable' });
      return api;
    }
    const perm = await SR.checkPermissions();
    if (perm?.speechRecognition && perm.speechRecognition !== 'granted') {
      const asked = await SR.requestPermissions();
      if (asked?.speechRecognition && asked.speechRecognition !== 'granted') {
        onStatus?.({ state: 'denied' });
        api.supported = false;
        return api;
      }
    }
  } catch (e) {
    onStatus?.({ state: 'unsupported', reason: 'perm' });
    return api;
  }

  api.supported = true;

  async function bind() {
    for (const h of listeners) { try { await h.remove(); } catch { /* ignore */ } }
    listeners = [];
    const h1 = await SR.addListener('partialResults', (data) => {
      const text = String(data?.matches?.[0] || '').trim();
      if (text) onInterim?.({ text, at: getElapsed?.() ?? 0 });
    });
    const h2 = await SR.addListener('listeningState', (data) => {
      if (data?.status === 'started') {
        api.active = true;
        onStatus?.({ state: 'listening' });
      }
    });
    listeners = [h1, h2].filter(Boolean);
  }

  async function start() {
    intentionalStop = false;
    api.paused = false;
    finalAccepted = false;
    if (starting) return;
    starting = true;
    onStatus?.({ state: 'starting' });
    try {
      await bind();
      await SR.start({
        language: lang === 'en-US' ? 'en-US' : 'zh-CN',
        partialResults: true,
        popup: false,
        maxResults: 1,
      });
      /* start() 返回时可能已经带最终结果；插件在 partialResults=true 时通常立即 resolve */
      const res = await SR.isListening?.();
      if (!res?.listening) onStatus?.({ state: 'starting' });
    } catch (e) {
      onStatus?.({ state: 'error', code: String(e?.message || e) });
    } finally {
      starting = false;
    }
  }

  /* 插件的 stop() 会 Promise<{matches}> 返回最终文本，这是拿定稿的可靠途径 */
  async function stop() {
    if (intentionalStop) return;
    intentionalStop = true;
    api.paused = false;
    try {
      const res = await SR.stop();
      const matches = res?.matches || [];
      const text = String(matches[0] || '').trim();
      if (text && !finalAccepted) {
        finalAccepted = true;
        onFinal?.({ text, at: getElapsed?.() ?? 0, engine: 'native' });
      }
    } catch { /* ignore */ }
    api.active = false;
    for (const h of listeners) { try { await h.remove(); } catch { /* ignore */ } }
    listeners = [];
  }

  async function pause() {
    /* 插件没有真正的 pause：停掉会话，恢复时重新 start */
    api.paused = true;
    try {
      const res = await SR.stop();
      const text = String(res?.matches?.[0] || '').trim();
      if (text) onFinal?.({ text, at: getElapsed?.() ?? 0, engine: 'native' });
    } catch { /* ignore */ }
    api.active = false;
    onStatus?.({ state: 'paused' });
  }

  async function resume() {
    if (!api.paused) return;
    api.paused = false;
    intentionalStop = false;
    await start();
  }

  async function destroy() {
    intentionalStop = true;
    try { await SR.stop(); } catch { /* ignore */ }
    for (const h of listeners) { try { await h.remove(); } catch { /* ignore */ } }
    listeners = [];
    api.active = false;
    onStatus = null;
    onFinal = null;
    onInterim = null;
  }

  return api;
}
