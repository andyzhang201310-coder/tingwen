/**
 * 原生文件导出（Android）：把 WebView 里的 Blob 真正写进手机存储。
 *
 * 网页端的 <a download> 只对 blob: 链接生效于桌面浏览器；安卓 WebView 不支持，
 * Capacitor 也没挂 DownloadListener，所以安卓包里必须有这条原生通道。
 *
 * 分块写入（512KB/块，base64 过桥）：一段两小时的录音有几十 MB，
 * 一次性塞进桥接会撑爆 WebView 的字符串上限，也容易把主线程卡住。
 */

const CHUNK = 512 * 1024;

function plugin() {
  return (typeof window !== 'undefined' && window.Capacitor?.Plugins?.FileExport) || null;
}

/** 当前环境能不能原生落盘（安卓包 true，网页 false） */
export function canWriteFile() {
  return !!plugin();
}

/** 把一块 Blob 读成纯 base64（去掉 data: 前缀） */
function chunkBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : '');
    };
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}

/**
 * 写入手机存储；非原生环境返回 null，调用方自行回退到 <a download>。
 *
 * convert=true 时，原生层会把 webm/opus 用 MediaCodec 转成 AAC 并封成 .m4a
 * 再落盘（文件名里的后缀会一起换掉）；转码失败则退回原格式保存，
 * 返回值的 converted 会告诉调用方到底转没转。
 *
 * @returns {Promise<{path: string, converted: boolean}|null>}
 */
export async function saveBlobNative(blob, filename, { share = false, convert = false } = {}) {
  const P = plugin();
  if (!P) return null;
  const { id } = await P.open({
    name: filename,
    mime: blob.type || 'application/octet-stream',
    convertTo: convert ? 'audio/mp4' : '',
  });
  try {
    for (let off = 0; off < blob.size; off += CHUNK) {
      const part = blob.slice(off, Math.min(blob.size, off + CHUNK));
      // eslint-disable-next-line no-await-in-loop
      await P.append({ id, data: await chunkBase64(part) });
    }
    const res = await P.close({ id, share });
    return { path: res?.path || filename, converted: !!res?.converted };
  } catch (e) {
    /* 写了一半失败：也要关掉会话，否则句柄一直占着文件 */
    try { await P.close({ id, share: false }); } catch { /* 忽略 */ }
    throw e;
  }
}
