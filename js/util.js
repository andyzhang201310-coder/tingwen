import { isEn } from './i18n.js';

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

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function safeName(s) {
  return (s || (isEn() ? 'recording' : '记录')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
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
