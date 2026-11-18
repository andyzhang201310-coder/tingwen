/**
 * 录音保活（产品文档 5.3「后台运行」）。
 *
 * 真机：调用 RecordingKeepAlive 插件挂一个 microphone 类型的前台服务，
 *       进程保持前台优先级并持唤醒锁，30 秒分段的落盘回调在锁屏后仍能执行。
 * 网页：没有对应插件，全部降级为空操作，不影响录音。
 *
 * 这里只做「进程别被冻」和「给用户一个能停的通知」，
 * 音频采集仍在 MediaRecorder，两者互不依赖：保活失败只是失去后台保护。
 */

function plugin() {
  return window.Capacitor?.Plugins?.RecordingKeepAlive || null;
}

export function isKeepAliveSupported() {
  return !!plugin();
}

export async function startKeepAlive({ title, text } = {}) {
  const p = plugin();
  if (!p) return { running: false, reason: 'unsupported' };
  try {
    const r = await p.start({ title: title || '听文正在录音', text: text || '' });
    if (r && r.running === false) return r;
    return { running: true, notif: r?.notif !== false };
  } catch (err) {
    return { running: false, reason: err?.message || 'error' };
  }
}

export async function updateKeepAlive({ title, text } = {}) {
  const p = plugin();
  if (!p) return { running: false };
  try {
    return await p.update({ title: title || '听文正在录音', text: text || '' });
  } catch {
    return { running: false };
  }
}

export async function stopKeepAlive() {
  const p = plugin();
  if (!p) return;
  try {
    await p.stop();
  } catch {
    /* 服务已经不在时 stopService 无副作用，忽略 */
  }
}

/**
 * 用户在通知栏点「停止录音」。
 * 返回取消订阅函数，调用方负责在页面卸载时清掉，避免重复绑定。
 */
export function onKeepAliveStop(handler) {
  const p = plugin();
  if (!p) return () => {};
  let handle = null;
  let removed = false;
  try {
    Promise.resolve(p.addListener('stopRequested', () => handler()))
      .then((h) => {
        handle = h;
        if (removed) h?.remove?.();
      })
      .catch(() => {});
  } catch {
    return () => {};
  }
  return () => {
    removed = true;
    handle?.remove?.();
  };
}
