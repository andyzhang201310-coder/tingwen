/**
 * 百炼实时识别 · 原生 SDK 引擎（真机专用）
 *
 * 走 Capacitor 原生插件 BailianAsr → 阿里 Fun-ASR-Realtime Android SDK。
 * SDK 在原生层用 initialize 参数传 apikey 完成鉴权，手机直连百炼，
 * 不需要电脑代理、不需要自建服务器，也不受 WebView 不能自定义请求头的限制。
 *
 * 接口与 createASR 一致：start/stop/pause/resume/destroy/voice/feed。
 * feed 接收 audio.js 的 16kHz/16bit/mono PCM 帧（ArrayBuffer），base64 后送原生。
 */

const arrToBase64 = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

export function createSdkASR({
  key = '',
  model = 'fun-asr-realtime',
  lang = 'zh-CN',
  workspaceId = '',
  getElapsed,
  onFinal,
  onInterim,
  onStatus,
} = {}) {
  // 先声明状态变量：即使「无插件/无 Key」提前 return，api 上的方法被适配层调用也不会 TDZ 报错
  let inited = false;
  let starting = false;
  let intentionalStop = false;
  let unsub = [];
  let startTimer = null;

  function clearStartTimer() {
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
  }

  const api = {
    supported: false,
    active: false,
    paused: false,
    engine: 'sdk',
    start,
    stop,
    pause,
    resume,
    destroy,
    voice() {},
    feed,
  };

  const Plugins = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins) || {};
  const SR = Plugins.BailianAsr;
  if (!SR || typeof SR.init !== 'function' || !key) {
    onStatus?.({ state: 'unsupported', reason: !key ? 'noKey' : 'noPlugin', engine: 'sdk' });
    return api;
  }

  function listen() {
    Promise.all([
      SR.addListener('interim', (d) => {
        const text = String((d && d.text) || '').trim();
        if (text) { clearStartTimer(); onInterim?.({ text, at: getElapsed?.() ?? 0 }); }
      }),
      SR.addListener('final', (d) => {
        const text = String((d && d.text) || '').trim();
        if (text) { clearStartTimer(); onFinal?.({ text, at: getElapsed?.() ?? 0, engine: 'sdk' }); }
      }),
      SR.addListener('status', (s) => {
        const state = (s && s.state) || '';
        if (state === 'listening') {
          clearStartTimer();
          api.active = true;
          onStatus?.({ state: 'listening', engine: 'sdk' });
        } else if (state === 'audioOpen') {
          clearStartTimer();
          api.active = true;
          onStatus?.({ state: 'listening', engine: 'sdk' });
        } else if (state === 'error') {
          clearStartTimer();
          onStatus?.({ state: 'error', code: s.code, engine: 'sdk' });
        } else if (state === 'completed') {
          clearStartTimer();
          api.active = false;
          onStatus?.({ state: 'listening', engine: 'sdk' });
        }
      }),
    ]).then((handles) => { unsub = handles.filter(Boolean); }).catch(() => {});
  }

  async function ensureInit() {
    if (inited) return true;
    const l = lang === 'en-US' ? 'en' : lang === 'auto' ? 'auto' : 'zh';
    try {
      await SR.init({ key, model, lang: l, workspaceId });
      inited = true;
      listen();
      return true;
    } catch (e) {
      clearStartTimer();
      onStatus?.({ state: 'error', code: String((e && e.message) || e), engine: 'sdk' });
      return false;
    }
  }

  async function start() {
    if (starting) return;
    starting = true;
    intentionalStop = false;
    clearStartTimer();
    onStatus?.({ state: 'starting', engine: 'sdk' });
    /* 看门狗：startDialog/网络连接若长时间无事件，主动报错让上层回退，
       不再无限停在“识别启动中”。 */
    startTimer = setTimeout(() => {
      startTimer = null;
      api.active = false;
      onStatus?.({ state: 'error', code: 'sdkStartTimeout', engine: 'sdk' });
    }, 6000);
    const ok = await ensureInit();
    starting = false;
    if (!ok) return;
    try {
      await SR.start();
      /* 原生侧已改为 WebSocket 直连并在 task-started 前缓存最多 1 秒音频，
         这里立刻置 active 开始喂流，避免开头几个字被丢掉。 */
      api.active = true;
    } catch (e) {
      clearStartTimer();
      onStatus?.({ state: 'error', code: String((e && e.message) || e), engine: 'sdk' });
    }
  }

  function feed(pcm) {
    if (api.paused || intentionalStop || !api.active || !pcm) return;
    try { SR.pushPcm({ data: arrToBase64(pcm) }); } catch { /* 高频调用，静默 */ }
  }

  async function stop() {
    if (intentionalStop) return;
    intentionalStop = true;
    clearStartTimer();
    api.active = false;
    try { await SR.stop(); } catch { /* ignore */ }
  }

  async function pause() {
    api.paused = true;
    await stop();
    onStatus?.({ state: 'paused', engine: 'sdk' });
  }

  async function resume() {
    if (!api.paused) return;
    api.paused = false;
    await start();
  }

  async function destroy() {
    intentionalStop = true;
    clearStartTimer();
    for (const h of unsub) { try { await h.remove(); } catch { /* ignore */ } }
    unsub = [];
    try { await SR.release(); } catch { /* ignore */ }
    api.active = false;
    inited = false;
    onStatus = null;
    onFinal = null;
    onInterim = null;
  }

  api.supported = true;
  return api;
}
