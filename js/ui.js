import { el, esc, pad } from './util.js';
import { icons } from './icons.js';
import { T } from './i18n.js';

/* ── Toast ─────────────────────────────── */
export function toast(message, duration = 2200) {
  const root = document.getElementById('toast-root');
  if (!root) return null;
  const node = el(`<div class="toast">${esc(message)}</div>`);
  root.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }, duration);
  return node;
}

/** 一直挂着、由调用方手动关掉的提示（转码这种要等几十秒的动作用） */
export function toastSticky(message) {
  const node = toast(message, 10 * 60 * 1000);
  return () => {
    if (!node) return;
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
}

export function haptic(ms = 8) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

/* 吞掉紧随其后的那一次 click。
   长按弹菜单后手指抬起，浏览器仍会补发一次 click；它会落在刚出现的遮罩上把菜单关掉，
   或落在列表行上跳进详情页。这里在捕获阶段拦掉，正常轻点不受影响。 */
let swallowClickUntil = 0;
let swallowBound = false;

export function swallowNextClick(ms = 320) {
  if (!swallowBound) {
    swallowBound = true;
    document.addEventListener('click', (e) => {
      if (Date.now() < swallowClickUntil) {
        swallowClickUntil = 0;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }
  swallowClickUntil = Date.now() + ms;
}

/* ── Sheet ─────────────────────────────── */
let sheetCloser = null;
let sheetSeq = 0;        // 每开一张表自增，用来作废上一张表还没跑完的关闭动画
let sheetCloseTimer = 0;
let sheetOnClose = null; // 当前表的 onClose，被新表顶掉时补发一次，避免 await 永久挂起
let sheetClosing = false;

export function openSheet({ title, desc, actions = [], content = null, onClose = null }) {
  const root = document.getElementById('sheet-root');
  if (!root) return;
  const body = root.querySelector('.sheet-body');

  /* 上一张表可能正处在 210ms 关闭动画里（典型场景：动作表里点“删除”→ 立刻弹确认框）。
     必须清掉它的定时器，否则回调会把刚打开的新表重新 hidden、还会把确认结果当成取消。
     若上一张表还活着却被顶掉，补发一次 onClose，保证 confirmDialog/choiceSheet 的 Promise 不会悬空。 */
  if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = 0; }
  if (sheetOnClose) {
    const pending = sheetOnClose;
    sheetOnClose = null;
    try { pending(); } catch { /* 忽略旧表的回调异常 */ }
  }
  sheetSeq += 1;
  const seq = sheetSeq;
  sheetOnClose = onClose;
  sheetClosing = false;

  root.classList.remove('is-closing');
  body.innerHTML = '';

  if (title) body.appendChild(el(`<h3 class="sheet-title">${esc(title)}</h3>`));
  if (desc) body.appendChild(el(`<p class="sheet-desc">${esc(desc)}</p>`));

  if (content) {
    if (typeof content === 'string') body.insertAdjacentHTML('beforeend', content);
    else body.appendChild(content);
  }

  if (actions.length) {
    const wrap = el('<div class="sheet-actions"></div>');
    actions.forEach((a) => {
      const btn = el(`
        <button class="sheet-action ${a.danger ? 'danger' : ''} ${a.primary ? 'primary' : ''}">
          ${a.icon ? icons[a.icon] || '' : ''}<span>${esc(a.label)}</span>
        </button>`);
      btn.addEventListener('click', async () => {
        close(); // 只关自己这张表，回调里若又开了新表也不会被误关
        if (a.onClick) await a.onClick();
      });
      wrap.appendChild(btn);
    });
    body.appendChild(wrap);
  }

  root.hidden = false;

  function close() {
    if (seq !== sheetSeq || sheetClosing) return; // 已被新表取代或已关闭
    sheetClosing = true;
    sheetCloseTimer && clearTimeout(sheetCloseTimer);
    root.classList.add('is-closing');
    sheetCloseTimer = setTimeout(() => {
      sheetCloseTimer = 0;
      if (seq !== sheetSeq) return; // 动画期间换表了，交给新表处理
      root.hidden = true;
      root.classList.remove('is-closing');
      const fn = sheetOnClose;
      sheetOnClose = null;
      if (fn) fn();
    }, 210);
  }

  sheetCloser = close;
  root.querySelectorAll('[data-sheet-close]').forEach((b) => {
    b.onclick = () => closeSheet();
  });
  return close;
}

export function closeSheet() {
  const closer = sheetCloser;
  sheetCloser = null;
  if (closer) closer();
}

export function confirmDialog({ title, message, confirmText = T('common.confirm'), cancelText = T('common.cancel'), danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    openSheet({
      title,
      desc: message,
      actions: [
        {
          label: confirmText,
          danger,
          primary: !danger,
          onClick: () => done(true),
        },
        { label: cancelText, onClick: () => done(false) },
      ],
      onClose: () => done(false),
    });
  });
}

export function choiceSheet({ title, desc, options, value }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    openSheet({
      title,
      desc,
      actions: options.map((o) => ({
        label: `${o.label}${o.value === value ? '  ✓' : ''}`,
        onClick: () => done(o.value),
      })),
      onClose: () => done(undefined),
    });
  });
}

/* ── 波形渲染 ───────────────────────────── */
function sampleAt(points, t) {
  if (!points.length) return 0;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const a = points[Math.max(0, lo - 1)];
  const b = points[lo];
  if (!b) return a?.v || 0;
  const span = Math.max(1, b.t - a.t);
  const k = Math.min(1, Math.max(0, (t - a.t) / span));
  return (a.v || 0) + ((b.v || 0) - (a.v || 0)) * k;
}

let colorCache = { theme: null, bar: '#ff8f45', dim: 'rgba(255,143,69,.22)' };

function waveColors() {
  const theme = document.documentElement.dataset.theme || 'dark';
  if (colorCache.theme !== theme) {
    const cs = getComputedStyle(document.documentElement);
    colorCache = {
      theme,
      bar: cs.getPropertyValue('--wave-bar').trim() || '#ff8f45',
      dim: cs.getPropertyValue('--wave-bar-dim').trim() || 'rgba(255,143,69,.22)',
    };
  }
  return colorCache;
}

/**
 * @param canvas HTMLCanvasElement
 * @param points [{t,v}] 0..1
 * @param opts { progressMs, durationMs, windowMs, bar, dim, playhead, gap, minH }
 */
export function renderWave(canvas, points, opts = {}) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const duration = Math.max(opts.durationMs || 0, points.length ? points[points.length - 1].t : 0, 1);
  const progress = Math.max(0, Math.min(opts.progressMs || 0, duration));
  const win = opts.windowMs || duration;
  const start = opts.windowMs
    ? Math.max(0, Math.min(progress - win * 0.72, Math.max(0, duration - win)))
    : 0;
  const end = Math.min(duration, start + win);

  const barW = 3;
  const gap = 2.4;
  const count = Math.max(8, Math.floor(w / (barW + gap)));
  const mid = h / 2;
  const c = waveColors();
  const barColor = opts.bar || c.bar;
  const dimColor = opts.dim || c.dim;
  const playColor = opts.playhead || '#ff3b30';

  for (let i = 0; i < count; i += 1) {
    const t = start + ((i + 0.5) / count) * (end - start);
    const isFuture = t > progress + 60;
    const v = isFuture && opts.windowMs ? 0 : sampleAt(points, t);
    const barH = Math.max(opts.minH ?? 2, v * (h - 6));
    const x = i * (barW + gap);
    ctx.fillStyle = isFuture ? dimColor : barColor;
    if (opts.dimAll && t > progress) ctx.fillStyle = dimColor;
    const y = mid - barH / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barW, barH, 1.6);
    else ctx.rect(x, y, barW, barH);
    ctx.fill();
  }

  if (opts.showPlayhead !== false && end > start) {
    const px = ((progress - start) / (end - start)) * w;
    if (px >= 0 && px <= w) {
      ctx.fillStyle = playColor;
      ctx.fillRect(Math.min(w - 1.5, Math.max(0, px - 0.75)), 0, 1.5, h);
      ctx.beginPath();
      ctx.arc(Math.min(w - 2, Math.max(2, px)), 2.5, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ── 计时器 DOM ─────────────────────────── */
export function timerHtml(ms) {
  const t = Math.max(0, Math.floor(ms || 0));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `<span class="dim">${pad(m)}:</span>${pad(s)}<span class="cs">.${pad(cs)}</span>`;
}

export function setPressed(btn, pressed) {
  if (!btn) return;
  btn.classList.toggle('is-pressed', pressed);
}
