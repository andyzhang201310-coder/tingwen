import { isEn } from './i18n.js';
import { saveBlobNative } from './file-export.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const pad = (n, len = 2) => String(n).padStart(len, '0');

export function uid(prefix = 'rec') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 毫秒 → mm:ss.cc */
export function fmtClock(ms, withCs = true) {
  const t = Math.max(0, Math.floor(ms || 0));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return withCs ? `${pad(m)}:${pad(s)}.${pad(cs)}` : `${pad(m)}:${pad(s)}`;
}

/** 毫秒 → 00:42 / 1:04:09 */
export function fmtDur(ms) {
  const t = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtStamp(ms) {
  return fmtClock(ms, false);
}

const DAY = 86400000;

function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sameDay(a, b) {
  return dayStart(a) === dayStart(b);
}

const EN_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 列表里的时间：今天 · 12:21 / 昨天 · 12:21 / 10月7日 · 12:21 / Nov 7 · 12:21 */
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = dayStart(Date.now());
  const day = dayStart(ts);
  if (isEn()) {
    const md = `${EN_MONTH[d.getMonth()]} ${d.getDate()}`;
    if (day === today) return `Today · ${hm}`;
    if (day === today - DAY) return `Yesterday · ${hm}`;
    if (d.getFullYear() === new Date().getFullYear()) return `${md} · ${hm}`;
    return `${md}, ${d.getFullYear()} · ${hm}`;
  }
  if (day === today) return `今天 · ${hm}`;
  if (day === today - DAY) return `昨天 · ${hm}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 · ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${hm}`;
}

export function dateGroupLabel(ts) {
  const d = new Date(ts);
  const today = dayStart(Date.now());
  const day = dayStart(ts);
  if (isEn()) {
    const md = `${EN_MONTH[d.getMonth()]} ${d.getDate()}`;
    if (day === today) return 'Today';
    if (day === today - DAY) return 'Yesterday';
    if (d.getFullYear() === new Date().getFullYear()) return md;
    return `${md}, ${d.getFullYear()}`;
  }
  if (day === today) return '今天';
  if (day === today - DAY) return '昨天';
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function fmtBytes(n) {
  if (!n) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last));
    }
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * 保存一个文件到用户能找到的地方。
 *
 * 安卓包走原生写入（下载/听文/），因为 WebView 不支持 <a download> 下载 blob；
 * 网页端仍用锚点下载。返回值用于给用户真实反馈：
 *   { ok: true, path }  已落盘（path 是手机上的展示路径）
 *   { ok: true }        网页端已触发下载，无法回读结果
 *   { ok: false }       写入失败
 */
export async function downloadBlob(filename, blob, opts = {}) {
  try {
    const saved = await saveBlobNative(blob, filename, opts);
    if (saved) return { ok: true, path: saved.path, converted: saved.converted };
  } catch (e) {
    console.warn('[export] native save failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  return downloadBlob(filename, new Blob([text], { type: mime }));
}

export function safeName(s) {
  return (s || (isEn() ? 'recording' : '记录')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

/**
 * 音频扩展名按真实 MIME 走，不能一律 .webm：
 * 演示录音是 WAV、云端引擎回传可能是 mp4/aac，后缀错了播放器就认不出来。
 */
export function audioExt(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('webm')) return 'webm';
  if (m.includes('flac')) return 'flac';
  return 'webm';
}

/**
 * 这个封装要不要在导出时转成 m4a。
 *
 * 录音器在安卓 WebView 里只能出 webm/opus（本机 WebView 是 Chrome 110，
 * 连 audio/mp4 都不支持），而 webm 在微信、华为音乐、车机里基本打不开，
 * 用户看到的就是「格式不对」。所以导出时交给原生层转成 AAC 封装成 .m4a。
 * wav / mp3 / m4a 本身就是通用格式，原样保存即可。
 */
export function needsAacWrap(mime = '') {
  const m = String(mime).toLowerCase();
  return m.includes('webm') || m.includes('ogg') || m.includes('matroska');
}

export async function sha256Short(blob) {
  try {
    if (window.crypto?.subtle) {
      const buf = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest).slice(0, 8))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch { /* 忽略，回退 */ }
  return `len${blob.size}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
