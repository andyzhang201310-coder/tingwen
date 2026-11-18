/**
 * 实时识别统一适配层
 *
 * 引擎优先级（可在设置里改 liveEngine）：
 *   auto（默认）：真机 = 百炼原生SDK → 系统识别 → 浏览器；网页 = 云端流式（经代理）→ 浏览器
 *   sdk          ：百炼原生SDK（真机直连，不需代理/服务器；网页不支持时回退浏览器）
 *   cloud        ：云端流式（经本地代理，需电脑常开代理）
 *   native       ：系统原生识别
 *   browser      ：Web Speech API（Edge 可用，Chrome 国内常不可用）
 *
 * 对外接口与 createASR 完全一致，录音页只认这一个对象。
 */
import { createASR } from './asr.js';
import { createCloudASR, isNativePlatform } from './asr-cloud.js';
import { createNativeASR } from './asr-native.js';
import { createSdkASR } from './asr-sdk.js';

const CHAIN = {
  browser: ['browser'],
  native: ['native', 'browser'],
  sdk: ['sdk', 'native', 'browser'],   // 真机 SDK 失败时先回系统识别，再回浏览器
  cloud: ['cloud'],
  auto: ['sdk', 'native', 'browser'],   // 真机基线；网页端在下方把 sdk/native 换成 cloud
};

export function createLiveASR({
  settings = {},
  getElapsed,
  onFinal,
  onInterim,
  onStatus,
} = {}) {
  const native = isNativePlatform();
  const prefer = settings.liveEngine || 'auto';
  let chain = (CHAIN[prefer] || CHAIN.auto).slice();

  if (!native) {
    /* 网页端没有原生SDK和系统识别插件：auto 走云端流式（经代理）→ 浏览器 */
    chain = chain.filter((e) => e !== 'native' && e !== 'sdk');
    if (prefer === 'auto') chain = ['cloud', 'browser'];
  } else {
    /* 真机端百炼原生SDK可直接连百炼，不需要代理；显式选 cloud（走代理）时保留用户选择 */
    chain = chain.filter((e) => e !== 'cloud' || prefer === 'cloud');
  }

  let skippedCloud = false;  // 兼容旧逻辑：现在真机 auto 已不含 cloud
  const proxy = String(settings.asrProxyUrl || '').trim();
  const loopback = !proxy || /:\/\/(127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)/i.test(proxy);
  if (native && prefer === 'cloud' && loopback && chain.length > 1) {
    chain = chain.filter((e) => e !== 'cloud');
    skippedCloud = true;
  }

  const api = {
    supported: false,
    active: false,
    paused: false,
    engine: '',
    start,
    stop,
    pause,
    resume,
    destroy,
    voice,
    feed,
  };

  let current = null;
  let index = -1;
  let intentionalStop = false;
  let downAt = 0;
  let switching = false;
  let fallbackTimer = null;

  /* 链里有任一引擎就视为支持；具体引擎能否用由 tryNext 逐级验证并回退。
     不能在构造时置 false：录音页据此决定是否调用 start()，会造成所有引擎都不启动。 */
  api.supported = chain.length > 0;

  function clearFallbackTimer() {
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  }

  function report(s) {
    if (intentionalStop) return;
    if (s.state === 'network' || s.state === 'error' || s.state === 'unsupported' || s.state === 'denied') {
      if (!downAt) {
        downAt = Date.now();
        /* 引擎可能只报一次错（如 SDK 看门狗），必须自己排定 2 秒后的回退检查，
           不能依赖引擎重复上报。 */
        if (!switching && current) {
          clearFallbackTimer();
          fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            if (intentionalStop || switching || !current) return;
            if (downAt && Date.now() - downAt > 1800) tryNext(current);
          }, 2000);
        }
      }
      /* 云端/原生失败超过 2 秒才回退，避免一次抖动就把整段识别切走 */
      if (!switching && current && Date.now() - downAt > 2000) tryNext(current);
    } else {
      downAt = 0;
      clearFallbackTimer();
    }
    onStatus?.({ ...s, engine: api.engine });
  }

  function make(engine) {
    const base = { getElapsed, onFinal, onInterim, onStatus: report };
    if (engine === 'sdk') {
      const prov = JSON.parse(JSON.stringify(settings.asrProviders || {}));
      const bailian = prov.bailian || {};
      return createSdkASR({
        ...base,
        key: settings.liveAsrKey || bailian.key || '',
        model: 'fun-asr-realtime',
        workspaceId: settings.asrWorkspaceId || '',
        lang: settings.lang === 'en-US' ? 'en-US' : 'zh-CN',
      });
    }
    if (engine === 'cloud') {
      const prov = JSON.parse(JSON.stringify(settings.asrProviders || {}));
      const bailian = prov.bailian || {};
      return createCloudASR({
        ...base,
        proxyUrl: settings.asrProxyUrl || 'ws://127.0.0.1:8790/ws/asr',
        key: settings.liveAsrKey || bailian.key || '',
        workspaceId: settings.asrWorkspaceId || '',
        model: 'paraformer-realtime-v2',
        lang: settings.lang === 'en-US' ? 'en-US' : 'zh-CN',
      });
    }
    if (engine === 'native') {
      /* 原生插件是异步 create，先同步返回一个占位，加载完再顶替 */
      const holder = {
        supported: true, active: false, paused: false, engine: 'native',
        start() {}, stop() {}, pause() {}, resume() {}, destroy() {}, voice() {}, feed() {},
      };
      createNativeASR({ ...base, lang: settings.lang || 'zh-CN' }).then((impl) => {
        if (current !== holder) return;   // 期间已切换，丢弃
        Object.assign(holder, impl, { engine: 'native' });
        if (!intentionalStop && !api.paused) holder.start();
        api.supported = holder.supported;
        if (!holder.supported) {
          /* 真机系统识别不可用：继续回退到链里的下一个（浏览器引擎） */
          setTimeout(() => { if (!intentionalStop) tryNext(holder); }, 0);
        }
      });
      return holder;
    }
    return createASR({
      ...base,
      lang: settings.lang === 'en-US' ? 'en-US' : 'zh-CN',
    });
  }

  function tryNext(failed) {
    if (switching || intentionalStop) return;
    switching = true;
    try { failed?.destroy?.(); } catch { /* ignore */ }
    current = null;
    downAt = 0;
    index += 1;
    if (index >= chain.length) {
      onStatus?.({ state: 'unsupported', reason: 'allEnginesFailed', engine: api.engine });
      api.supported = false;
      switching = false;
      return;
    }
    const next = chain[index];
    api.engine = next;
    current = make(next);
    api.supported = !!current?.supported;
    /* 引擎异步加载（native）时 supported 先占位 true，加载完再更新 */
    if (!api.supported) {
      switching = false;
      setTimeout(() => { if (!intentionalStop) tryNext(current); }, 0);
      return;
    }
    if (!api.paused) { try { current.start(); } catch { /* ignore */ } }
    onStatus?.({ state: 'switch', engine: next });
    switching = false;
  }

  function start() {
    intentionalStop = false;
    api.paused = false;
    downAt = 0;
    clearFallbackTimer();
    index = -1;
    if (skippedCloud && !api._skippedNotified) {
      api._skippedNotified = true;
      onStatus?.({ state: 'notice', reason: 'skippedCloudLoopback', engine: 'native' });
    }
    tryNext(null);
  }

  function stop() {
    intentionalStop = true;
    api.paused = false;
    try { current?.stop?.(); } catch { /* ignore */ }
    api.active = false;
  }

  function pause() {
    api.paused = true;
    try { current?.pause?.(); } catch { /* ignore */ }
    api.active = false;
  }

  function resume() {
    if (!api.paused) return;
    api.paused = false;
    try { current?.resume?.(); } catch { /* ignore */ }
  }

  function voice(v) {
    try { current?.voice?.(v); } catch { /* ignore */ }
  }

  function feed(pcm) {
    if (api.paused || intentionalStop) return;
    try { current?.feed?.(pcm); } catch { /* ignore */ }
  }

  function destroy() {
    intentionalStop = true;
    clearFallbackTimer();
    try { current?.destroy?.(); } catch { /* ignore */ }
    current = null;
    onStatus = null;
    onFinal = null;
    onInterim = null;
  }

  return api;
}

/** 供设置页显示当前平台与推荐引擎 */
export function liveEngineHint(settings = {}) {
  const native = isNativePlatform();
  const prefer = settings.liveEngine || 'auto';
  if (prefer === 'browser') return 'browser';
  if (prefer === 'sdk') return native ? 'sdk' : 'browser';
  if (prefer === 'native') return native ? 'native' : 'browser';
  if (prefer === 'cloud') return 'cloud';
  return native ? 'sdk→native' : 'cloud→browser';
}
