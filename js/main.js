import { getSettings, listRecordings, softDeleteRecording } from './store.js';
import { Player } from './audio.js';
import { toast } from './ui.js';
import { mountHome } from './views/home.js';
import { mountRecord } from './views/record.js';
import { mountDoc } from './views/doc.js';
import { mountSettings } from './views/settings.js';
import { mountTrash } from './views/trash.js';
import { mountSpeakers } from './views/speakers.js';
import { createDemoRecording } from './demo.js';
import { runDiarization } from './speakers.js';
import { setLang, T } from './i18n.js';

const app = document.getElementById('app');
const player = new Player(document.getElementById('global-audio'));

const ctx = {
  player,
  settings: {},
  currentDocId: null,
  currentView: null,
  navigate,
  applyTheme,
  applyLang,
  rerender,
  beep,
  startRecording() {
    if (location.hash === '#/record') return;
    navigate('#/record');
  },
  async loadDemo() {
    const rec = await createDemoRecording();
    toast(T('home.demoLoaded'));
    // 演示会议直接跑一次真实的说话人分离，进入文稿即可看到三位发言人
    try {
      const res = await runDiarization(rec.id, { settings: ctx.settings });
      if (res.ok) toast(T('diar.done', { n: res.speakerCount }));
    } catch (err) {
      console.warn('演示说话人识别失败', err);
    }
  },
};

let teardown = null;
let lastHash = null;

function applyTheme(theme) {
  const sys = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const value = theme === 'system' ? sys : theme;
  document.documentElement.dataset.theme = value;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', value === 'light' ? '#f1f1f4' : '#0a0a0c');
}

/** 语言：写 html[lang] + 文档标题，视图重挂后所有文案随之切换 */
function applyLang(setting) {
  const lang = setLang(setting);
  document.title = T('app.title');
  document.documentElement.dataset.lang = lang;
  return lang;
}

/** 不刷新页面，直接重挂当前视图 */
function rerender() {
  lastHash = null;
  route();
}

let beepCtx = null;
function beep(kind = 'start') {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    beepCtx = beepCtx || new AC();
    const t = beepCtx.currentTime;
    const osc = beepCtx.createOscillator();
    const gain = beepCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(kind === 'start' ? 660 : 440, t);
    osc.frequency.exponentialRampToValueAtTime(kind === 'start' ? 880 : 330, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(beepCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch { /* 忽略 */ }
}

export function navigate(hash, { replace = false } = {}) {
  if (location.hash === hash) return;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function parseRoute() {
  const hash = location.hash || '#/';
  if (hash === '#/' || hash === '#' || hash === '') return { name: 'home' };
  if (hash === '#/record') return { name: 'record' };
  if (hash === '#/settings') return { name: 'settings' };
  if (hash === '#/trash') return { name: 'trash' };
  const doc = hash.match(/^#\/doc\/(.+)$/);
  if (doc) return { name: 'doc', id: doc[1] };
  const spk = hash.match(/^#\/speakers\/(.+)$/);
  if (spk) return { name: 'speakers', id: spk[1] };
  return { name: 'home' };
}

function route() {
  const r = parseRoute();
  if (lastHash === location.hash && teardown) return;
  lastHash = location.hash;

  try { teardown?.destroy?.(); } catch (e) { console.warn(e); }
  teardown = null;
  app.innerHTML = '';
  ctx.currentView = null;

  let view = null;
  try {
    if (r.name === 'home') view = mountHome(app, ctx);
    else if (r.name === 'record') view = mountRecord(app, ctx);
    else if (r.name === 'doc') view = mountDoc(app, ctx, r.id);
    else if (r.name === 'settings') view = mountSettings(app, ctx);
    else if (r.name === 'trash') view = mountTrash(app, ctx);
    else if (r.name === 'speakers') view = mountSpeakers(app, ctx, r.id);
  } catch (err) {
    console.error('视图渲染失败', err);
    app.innerHTML = `<div class="view"><div class="empty"><h3>${T('common.loadFailed')}</h3><p>${err.message}</p>
      <button class="ghost accent" data-act="reload">${T('sys.reload')}</button></div></div>`;
    app.querySelector('[data-act="reload"]')?.addEventListener('click', () => location.reload());
    return;
  }

  teardown = view;
  ctx.currentView = view;
}

/** 自动清理：超过设定天数的录音移入回收站 */
async function applyAutoDelete() {
  if (!ctx.settings.autoDeleteOld) return;
  const days = ctx.settings.autoDeleteDays || 30;
  const cutoff = Date.now() - days * 86400000;
  const recs = await listRecordings();
  for (const r of recs) {
    if (r.startedAt < cutoff && r.status !== 'recording') await softDeleteRecording(r.id);
  }
}

window.addEventListener('online', () => {
  if (location.hash === '#/record') toast(T('sys.online'));
});
window.addEventListener('offline', () => {
  toast(T('sys.offline'));
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (ctx.settings.theme === 'system') applyTheme('system');
});

(async function boot() {
  try {
    ctx.settings = await getSettings();
  } catch (err) {
    console.error(err);
    ctx.settings = {};
  }
  applyTheme(ctx.settings.theme || 'dark');
  applyLang(ctx.settings.uiLang || 'auto');
  await applyAutoDelete().catch(() => {});

  if (!location.hash) history.replaceState(null, '', '#/');
  route();
  window.addEventListener('hashchange', route);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
})();
