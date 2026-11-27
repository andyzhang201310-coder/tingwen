import {
  $, $$, esc, fmtClock, fmtDur, fmtDate, fmtBytes, safeName,
  copyText, downloadText, downloadBlob, debounce, audioExt,
} from '../util.js';
import { icons } from '../icons.js';
import { canWriteFile, saveBlobNative } from '../file-export.js';
import { toast, openSheet, confirmDialog, renderWave, closeSheet } from '../ui.js';
import {
  getRecording, updateRecording, listTranscripts, updateTranscript,
  addTranscript, deleteTranscript, softDeleteRecording, purgeRecording, setSettings,
  getTranslationMap, translationLangs, clearTranslations,
  clearSegments, clearTranscripts, clearSummaries,
} from '../store.js';
import { analyze } from '../ai.js';
import { statusOf, engineLabel, folderLabel, intrReasonText } from '../model.js';
import { T } from '../i18n.js';
import {
  correctText, optionsFromSettings, suggestMerges, llmCorrect, llmReady,
  renderTextWithFixes, applyOneFix, revertOne,
} from '../correct.js';
import {
  loadSpeakerView, speakerName, runDiarization, reassignSegments, createEmptySpeaker,
} from '../speakers.js';
import { pendingSummary, runRepair, canRepair, repairReasonText } from '../repair.js';
import {
  translateRecording, TARGET_LANGS, langLabel, defaultTargetLang,
} from '../translate.js';
import { createSpeakerTabs } from './doc-speaker-tabs.js';
import { toSrt, toVtt, toDocx, printDoc } from '../export.js';
import { extractTerms, appendDict, termLines } from '../terms.js';

export function mountDoc(root, ctx, id) {
  root.innerHTML = `
    <div class="view doc">
      <header class="doc-top">
        <button class="icon-btn back" data-act="back" aria-label="${T('common.back')}">${icons.chevronLeft}</button>
        <div class="doc-heading">
          <div class="doc-kicker">${T('doc.kicker')}</div>
          <h1 class="doc-title" id="docTitle">…</h1>
        </div>
        <div class="doc-actions">
          <button class="icon-btn" data-act="fav" aria-label="${T('common.favorite')}">${icons.heart}</button>
          <button class="icon-btn" data-act="info" aria-label="${T('common.more')}">${icons.info}</button>
        </div>
      </header>

      <div class="scroll doc-scroll" id="docScroll">
        <section class="takeaways" id="takeaways"></section>
        <div id="intrBar"></div>
        <div id="spkBanner"></div>
        <div id="repairBar"></div>

        <div class="doc-tabs">
          <button class="doc-tab active" data-tab="transcript">${T('doc.tabTranscript')}</button>
          <button class="doc-tab" data-tab="speakers">${T('doc.tabSpeakers')}</button>
          <button class="doc-tab" data-tab="summary">${T('doc.tabSummary')}</button>
          <button class="doc-tab" data-tab="todos">${T('doc.tabTodos')}</button>
          <div class="doc-tabs-end">
            <button class="icon-btn tr-btn" data-act="translate" aria-label="${T('doc.translate')}" title="${T('doc.translate')}">${icons.translate}</button>
            <button class="icon-btn" data-act="terms" aria-label="${T('terms.entry')}" title="${T('terms.entry')}">${icons.marker}</button>
            <button class="fix-btn" id="fixBtn" data-act="fix" aria-label="${T('doc.fixEntry')}">${icons.sparkle}<span id="fixCount">0</span></button>
            <button class="icon-btn" data-act="expand" aria-label="${T('common.expand')}">${icons.expand}</button>
          </div>
        </div>

        <div class="doc-toolbar" id="toolbar"></div>
        <div class="doc-toolbar spk-filter-bar" id="spkFilterBar" hidden></div>
        <div class="doc-toolbar tr-bar" id="trBar" hidden></div>
        <div id="searchWrap"></div>
        <div class="paras" id="paras"></div>
      </div>

      <div class="player" id="player">
        <div class="player-wave" data-act="seek"><canvas id="pwave"></canvas></div>
        <div class="player-times"><span id="cur">00:00</span><span id="total">00:00</span></div>
        <div class="player-ctrls">
          <button class="speed-btn" data-act="speed">1.0×</button>
          <button class="icon-btn" data-act="back15" aria-label="${T('doc.back15')}">${icons.back15}</button>
          <button class="player-play" data-act="play" aria-label="${T('common.play')}"><span class="ic ic-play">${icons.play}</span><span class="ic ic-pause">${icons.pause}</span></button>
          <button class="icon-btn" data-act="fwd15" aria-label="${T('doc.fwd15')}">${icons.fwd15}</button>
          <button class="icon-btn" data-act="export" aria-label="${T('common.export')}">${icons.share}</button>
        </div>
      </div>
      <div id="editBar"></div>
    </div>`;

  const docTitle = $('#docTitle', root);
  const takeawaysEl = $('#takeaways', root);
  const toolbar = $('#toolbar', root);
  const spkFilterBar = $('#spkFilterBar', root);
  const parasEl = $('#paras', root);
  const searchWrap = $('#searchWrap', root);
  const canvas = $('#pwave', root);
  const curEl = $('#cur', root);
  const totalEl = $('#total', root);
  const playBtn = $('[data-act="play"]', root);
  const scrollEl = $('#docScroll', root);
  const editBar = $('#editBar', root);
  const bannerEl = $('#spkBanner', root);
  const repairBar = $('#repairBar', root);
  const intrBar = $('#intrBar', root);
  const trBar = $('#trBar', root);

  let rec = null;
  let trs = [];
  let analysis = { takeaways: [], todos: [], questions: [], keywords: [] };
  let filter = 'all';
  let spkFilter = 'all';
  let searchQuery = '';
  let editing = null; // Set<id>
  let viewing = 'transcript';
  let activeId = null;
  let userScrolled = false;
  let lastScrollTs = 0;
  let speeds = [1, 1.25, 1.5, 2];
  let speedIdx = 0;
  let backfilled = false;
  let learned = [];
  let llmHints = [];
  /* 译文：trLang 为空表示不显示；trMap 为 transcriptId → 译文行 */
  let trLang = '';
  let trMap = new Map();
  let trLangs = [];
  let trBusy = false;
  let trShow = true;
  let llmBusy = false;
  let spk = { speakers: [], byId: new Map(), groups: new Map(), tasks: [], unknownCount: 0, unconfirmed: 0 };
  let tabsApi = null;
  /* 未识别区间（补识别）：count=待处理段数，totalMs=合计时长 */
  let repair = { count: 0, totalMs: 0, running: false, reason: '' };

  const colorOf = (s) => `c${((s?.color ?? 0) % 6 + 6) % 6}`;

  /* ── 数据 ── */
  async function load() {
    rec = await getRecording(id);
    if (!rec) return false;
    trs = await listTranscripts(id);
    if (!backfilled) {
      backfilled = true;
      await backfillCorrections();
    }
    analysis = analyze(trs);
    spk = await loadSpeakerView(id);
    trLangs = await translationLangs(id);
    if (trLangs.length) {
      if (!trLang || !trLangs.some((l) => l.lang === trLang)) {
        trLang = trLangs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].lang;
      }
      trMap = await getTranslationMap(id, trLang);
    } else {
      trLang = '';
      trMap = new Map();
    }
    const sum = await pendingSummary(id).catch(() => null);
    repair = {
      count: sum?.count || 0,
      totalMs: sum?.totalMs || 0,
      running: false,
      reason: sum?.failed?.[0]?.reason || '',
    };
    return true;
  }

  /** 对已有文稿补一次纠错（旧数据、导入文稿都适用）；原文写进 raw，可撤销 */
  async function backfillCorrections() {
    const opts = optionsFromSettings(ctx.settings);
    if (!opts.on) return;
    const merges = opts.level === 'aggressive'
      ? suggestMerges(trs.map((t) => t.raw || t.text || ''))
      : [];
    for (const t of trs) {
      /* 用户点过「全部撤销」：尊重这个决定，不再自动改回去（手动「重扫全文」仍可重来） */
      if (t.fixReverted) continue;
      if (!t.text || t.edited || t.corrected || (t.corrections && t.corrections.length)) continue;
      const fix = correctText(t.text, { ...opts, extraPairs: merges });
      if (!fix.changed) continue;
      t.raw = t.text;
      t.text = fix.text;
      t.corrections = fix.corrections;
      t.corrected = 1;
      await updateTranscript(t.id, {
        text: fix.text,
        raw: t.raw,
        corrections: fix.corrections,
        corrected: 1,
        correctedAt: Date.now(),
        autoFix: true,
      });
    }
  }

  function fixTotal() {
    return trs.reduce((n, t) => n + ((t.corrections || []).length), 0);
  }

  /* ── 渲染：要点 ── */
  function renderTakeaways() {
    const tags = analysis.keywords.slice(0, 4);
    const bullets = analysis.takeaways.slice(0, 4);
    takeawaysEl.innerHTML = `
      <div class="rec-title">${esc(rec.title)}</div>
      <div class="tk-head">${icons.bolt}<span>${T('doc.pointsHead')}</span></div>
      ${bullets.length
        ? `<ul class="tk-list">${bullets.map((b) => `<li data-jump="${b.startMs}">${esc(b.text)}</li>`).join('')}</ul>`
        : `<p class="tk-empty">${trs.length ? T('doc.pointsShort') : T('doc.noTranscript')}</p>`}
      ${tags.length ? `<div class="tk-chips">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}`;
  }

  /* ── 渲染：录音被系统中断（产品文档 7.2「显示中断原因，保存已完成分段」） ──
     不放信息弹层：用户结束录音后直接落在文稿页，只有放在正文上方才解释得清
     「为什么这段只有两分钟」。 */
  function renderIntrBar() {
    if (!intrBar) return;
    if (!rec?.interrupted) { intrBar.innerHTML = ''; return; }
    intrBar.innerHTML = `
      <div class="repair-bar intr-bar">
        <span class="repair-icon">${icons.info}</span>
        <div class="repair-main">
          <b>${esc(T('doc.intrTitle'))}</b>
          <span>${esc(T('doc.intrBody', { reason: intrReasonText(rec.interrupted) }))}</span>
        </div>
      </div>`;
  }

  /* ── 渲染：未识别区间（补识别入口，对应产品文档 8.2「断网恢复」） ── */
  function renderRepairBar() {
    if (!repairBar) return;
    if (!repair.count || viewing !== 'transcript') { repairBar.innerHTML = ''; return; }
    const ready = canRepair(ctx.settings);
    const hint = repair.reason ? ` · ${repairReasonText(repair.reason)}` : '';
    repairBar.innerHTML = `
      <div class="repair-bar">
        <span class="repair-icon">${icons.info}</span>
        <div class="repair-main">
          <b>${esc(T('repair.barTitle', { n: repair.count }))}</b>
          <span>${esc(T('repair.barSub', { dur: fmtDur(repair.totalMs) }))}${esc(hint)}</span>
        </div>
        <button class="ghost accent repair-btn" data-act="repair" ${repair.running ? 'disabled' : ''}>
          ${repair.running ? esc(T('repair.running')) : esc(T('repair.action'))}
        </button>
      </div>
      ${ready ? '' : `<p class="repair-tip">${esc(T('repair.needConfigShort'))}</p>`}`;
  }

  async function doRepair() {
    if (repair.running) return;
    if (!canRepair(ctx.settings)) {
      const node = document.createElement('div');
      node.innerHTML = `
        <p class="sheet-desc">${esc(T('repair.needConfig'))}</p>
        <div class="sheet-actions">
          <button class="sheet-action" data-open-set>${icons.gear}<span>${esc(T('repair.openSettings'))}</span></button>
        </div>`;
      const close = openSheet({ title: T('repair.title'), desc: T('repair.desc'), content: node });
      node.addEventListener('click', (e) => {
        if (!e.target.closest('[data-open-set]')) return;
        close();
        ctx.navigate('#/settings');
      });
      return;
    }
    repair.running = true;
    renderRepairBar();
    const res = await runRepair(id, {
      settings: ctx.settings,
      onProgress: (p) => {
        const b = $('[data-act="repair"]', root);
        if (b) b.textContent = `${T('repair.running')} ${p.index + 1}/${p.total}`;
      },
    });
    repair.running = false;
    await load();
    renderTakeaways();
    renderBanner();
    renderRepairBar();
    renderToolbar();
    if (viewing === 'transcript') renderParas();
    if (res.ok) toast(T('repair.done', { n: res.added }));
    else if (res.reason === 'nothing') toast(T('repair.none'));
    else toast(T('repair.failed', { reason: repairReasonText(res.reason) }));
  }

  /* ── 渲染：发言人横幅 ── */
  /** 录音质量有问题时优先说这一句：它比「已识别 N 人」更能解释用户接下来看到的混乱 */
  function spkQualityNote() {
    const q = spk.quality;
    if (!q) return '';
    if (q.level === 'noisy') return T('doc.qualityNoisyNote');
    if (q.overlapSpans) return T('doc.qualityOverlapNote', { n: q.overlapSpans });
    return '';
  }

  function renderBanner() {
    if (!bannerEl) return;
    if (!trs.length) { bannerEl.innerHTML = ''; return; }
    const n = spk.speakers.length;
    if (!n) {
      bannerEl.innerHTML = `
        <div class="spk-banner">
          <div class="spk-banner-main">
            <span class="spk-banner-icon">${icons.waveform}</span>
            <div>
              <b>${T('doc.noSpeakerYet')}</b>
              <p>${T('doc.noSpeakerDesc')}</p>
            </div>
          </div>
          <button class="ghost accent sm" data-act="identify">${T('doc.runIdentify')}</button>
        </div>`;
      return;
    }
    bannerEl.innerHTML = `
      <div class="spk-banner compact">
        <div class="spk-banner-main">
          <div class="spk-avatars">
            ${spk.speakers.slice(0, 4).map((s) => `<span class="spk-avatar xs ${colorOf(s)}" title="${esc(speakerName(s))}">${esc(s.displayName ? s.displayName.slice(0, 1) : `S${s.order}`)}</span>`).join('')}
            ${spk.speakers.length > 4 ? `<span class="spk-avatar xs more">+${spk.speakers.length - 4}</span>` : ''}
          </div>
          <div>
            <b>${T('doc.speakerBanner', { n })}${spk.unconfirmed ? ` · ${T('doc.speakerBannerPending', { n: spk.unconfirmed })}` : ''}</b>
            <p>${spkQualityNote() || (spk.unknownCount ? T('spk.unknownSegments', { n: spk.unknownCount }) : T('spk.identityNote'))}</p>
          </div>
        </div>
        <button class="ghost outline sm" data-act="speakers">${T('doc.goConfirm')}</button>
      </div>`;
  }

  /* ── 渲染：筛选栏 ── */
  function renderToolbar() {
    const n = (arr) => (arr.length ? ` (${arr.length})` : '');
    toolbar.innerHTML = `
      <button class="round-search" data-act="search" aria-label="${T('common.search')}">${icons.search}</button>
      <button class="filter-chip ${filter === 'all' ? 'active' : ''}" data-filter="all">${T('doc.filterAll')}</button>
      <button class="filter-chip ${filter === 'key' ? 'active' : ''}" data-filter="key">${T('doc.filterKey')}${n(analysis.takeaways)}</button>
      <button class="filter-chip ${filter === 'todo' ? 'active' : ''}" data-filter="todo">${T('doc.filterTodo')}${n(analysis.todos)}</button>
      <button class="filter-chip ${filter === 'q' ? 'active' : ''}" data-filter="q">${T('doc.filterQ')}${n(analysis.questions)}</button>`;

    /* 按人员筛选单独一行：混在 AI 快捷筛选后面会被挤出屏幕，等于没有 */
    if (spk.speakers.length) {
      spkFilterBar.hidden = false;
      spkFilterBar.innerHTML = `
        <span class="spk-filter-label">${T('doc.filterBySpeaker')}</span>
        ${spk.speakers.map((s) => `
          <button class="filter-chip spk-chip ${spkFilter === s.id ? 'active' : ''}" data-spkfilter="${s.id}">
            <span class="spk-dot ${colorOf(s)}"></span>${esc(speakerName(s))}
          </button>`).join('')}
        <button class="filter-chip spk-chip ${spkFilter === 'unknown' ? 'active' : ''}" data-spkfilter="unknown">${T('doc.speakerUnknown')}${spk.unknownCount ? ` (${spk.unknownCount})` : ''}</button>`;
    } else {
      spkFilterBar.hidden = true;
      spkFilterBar.innerHTML = '';
    }

    if (!toolbar.querySelector(`[data-filter="${filter}"]`)) filter = 'all';
    if (spkFilter !== 'all' && spkFilter !== 'unknown' && !spk.byId.has(spkFilter)) spkFilter = 'all';
  }

  /* ── 译文条（有译文才出现，可关掉只看原文） ── */
  function renderTrBar() {
    $('[data-act="translate"]', root)?.classList.toggle('is-on', trLangs.length > 0);
    if (!trLangs.length) {
      trBar.hidden = true;
      trBar.innerHTML = '';
      return;
    }
    const cur = trLangs.find((l) => l.lang === trLang);
    trBar.hidden = false;
    trBar.innerHTML = `
      <button class="filter-chip ${trShow ? 'active' : ''}" data-act="tr-toggle">
        ${icons.translate}${esc(langLabel(trLang))}
      </button>
      ${trLangs.filter((l) => l.lang !== trLang).map((l) => `
        <button class="filter-chip" data-act="tr-lang" data-lang="${esc(l.lang)}">${esc(langLabel(l.lang))}</button>`).join('')}
      <span class="tr-hint">${esc(T('doc.trCount', { n: cur?.count || 0, total: trs.length }))}</span>
      <div class="spacer"></div>
      <button class="mini-btn" data-act="tr-retranslate" ${trBusy ? 'disabled' : ''}>${trBusy ? T('doc.trRunning') : T('doc.trRetranslate')}</button>
      <button class="mini-btn" data-act="tr-clear" ${trBusy ? 'disabled' : ''}>${T('doc.trClear')}</button>`;
  }

  function openTranslate() {
    const def = ctx.settings.translateLang || defaultTargetLang(ctx.settings.uiLang || 'zh');
    const langs = TARGET_LANGS.slice().sort((a, b) => (a.code === def ? -1 : b.code === def ? 1 : 0));
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('doc.trDesc')}</p>
      <div class="sheet-actions">
        ${langs.map((l) => `
          <button class="sheet-action" data-lang="${esc(l.code)}">
            <span>${esc(l.label)}</span>
            ${trLangs.some((x) => x.lang === l.code) ? `<span class="sheet-check">${icons.check}</span>` : ''}
          </button>`).join('')}
      </div>
      ${llmReady(ctx.settings) ? '' : `<p class="hint">${T('doc.trNeedLlm')}</p>`}`;
    const close = openSheet({ title: T('doc.translate'), content: box });
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-lang]');
      if (!btn) return;
      const lang = btn.dataset.lang;
      close();
      await runTranslate(lang);
    });
  }

  async function runTranslate(lang) {
    if (trBusy) return;
    if (!llmReady(ctx.settings)) {
      const go = await confirmDialog({
        title: T('doc.translate'),
        message: T('doc.trNeedLlm'),
        confirmText: T('doc.trGoSettings'),
      });
      if (go) ctx.navigate('#/settings');
      return;
    }
    trBusy = true;
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${esc(T('doc.trRunningLang', { lang: langLabel(lang) }))}</p>
      <div class="tr-progress"><span style="width:0%"></span></div>
      <p class="hint">${esc(T('doc.trRunningHint'))}</p>`;
    const close = openSheet({ title: T('doc.translate'), content: box });
    const fill = box.querySelector('.tr-progress span');
    try {
      const res = await translateRecording(id, {
        settings: ctx.settings,
        lang,
        onProgress: (p) => { if (fill) fill.style.width = `${Math.round(p * 100)}%`; },
      });
      close();
      if (!res.ok) {
        toast(T('doc.trNoText'));
        return;
      }
      trLang = lang;
      trShow = true;
      await load();
      renderTrBar();
      renderParas();
      toast(res.same ? T('doc.trAlready') : T('doc.trDone', { n: res.count }));
    } catch (err) {
      close();
      toast(err?.message || T('doc.trFailed'));
    } finally {
      trBusy = false;
      renderTrBar();
    }
  }

  async function clearTrans(lang) {
    const ok = await confirmDialog({
      title: T('doc.trClear'),
      message: T('doc.trClearConfirm', { lang: langLabel(lang) }),
      confirmText: T('common.delete'),
      danger: true,
    });
    if (!ok) return;
    await clearTranslations(id, lang);
    if (trLang === lang) { trLang = ''; trMap = new Map(); trShow = true; }
    await load();
    renderTrBar();
    renderParas();
    toast(T('doc.trCleared'));
  }

  function highlight(text) {
    let out = esc(text);
    const marks = analysis.takeaways.slice(0, 2)
      .map((t) => t.text)
      .filter((m) => m && m.length >= 4)
      .sort((a, b) => b.length - a.length);
    marks.forEach((m) => {
      const em = esc(m);
      if (out.includes(em) && !out.includes(`<mark>${em}</mark>`)) {
        out = out.replace(em, `<mark>${em}</mark>`);
      }
    });
    return out;
  }

  function filterSet() {
    if (filter === 'key') return new Set(analysis.sentences.filter((s) => analysis.takeaways.some((t) => t.text === s.text)).map((s) => s.trId));
    if (filter === 'todo') return new Set(analysis.todos.map((t) => t.trId));
    if (filter === 'q') return new Set(analysis.questions.map((t) => t.trId));
    return null;
  }

  function renderParas() {
    const allowed = filterSet();
    let list = trs;
    if (allowed) list = list.filter((t) => allowed.has(t.id));
    if (spkFilter === 'unknown') list = list.filter((t) => !t.speakerId);
    else if (spkFilter !== 'all') list = list.filter((t) => t.speakerId === spkFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((t) => (t.text || '').toLowerCase().includes(q));
    }

    if (!list.length) {
      parasEl.innerHTML = `
        <div class="para-empty">
          ${trs.length
            ? T('doc.emptyFilter')
            : (rec.status === 'imported' ? T('doc.emptyImported') : T('doc.emptyNoText'))}
        </div>
        <button class="ghost accent" data-act="edit" style="margin:4px 0 20px">${T('doc.editTranscript')}</button>`;
      return;
    }

    parasEl.innerHTML = list.map((t) => {
      const isEditing = editing && editing.has(t.id);
      const text = t.text || '';
      if (isEditing) {
        return `
          <div class="para selected" data-id="${t.id}" data-start="${t.startMs}">
            <div class="para-meta"><span class="para-time">${fmtClock(t.startMs, false)}</span>
              <span class="para-flag">${T('doc.editing')}</span></div>
            <textarea class="para-edit" data-edit="${t.id}">${esc(text)}</textarea>
          </div>`;
      }
      const fixes = t.corrections || [];
      const owner = t.speakerId ? spk.byId.get(t.speakerId) : null;
      const lowConf = t.speakerId && (t.speakerConfidence ?? 1) < 0.45;
      const tr = trShow && trLang ? trMap.get(t.id) : null;
      return `
        <div class="para" data-id="${t.id}" data-start="${t.startMs}">
          <div class="para-meta">
            <span class="para-time">${fmtClock(t.startMs, false)}</span>
            ${owner
              ? `<button class="para-spk ${colorOf(owner)}" data-spk-edit="${t.id}"><span class="spk-dot ${colorOf(owner)}"></span>${esc(speakerName(owner))}${t.speakerLocked ? `<i class="lock-dot" title="${T('spk.lockedFlag')}"></i>` : ''}</button>`
              : (spk.speakers.length ? `<button class="para-spk is-unknown" data-spk-edit="${t.id}">${T('doc.speakerUnknown')}</button>` : '')}
            ${lowConf ? `<span class="para-flag warn">${T('spk.conflictFlag')}</span>` : ''}
            ${t.edited ? `<span class="para-flag">${T('doc.edited')}</span>` : ''}
            ${fixes.length ? `<button class="para-flag fix-flag" data-act="fix">${icons.sparkle}${T('doc.fixed', { n: fixes.length })}</button>` : ''}
          </div>
          <div class="para-text">${paraHtml(t)}</div>
          ${tr ? `<div class="para-tr" lang="${esc(trLang)}"><span class="para-tr-tag">${esc(langLabel(trLang))}</span><span>${esc(tr.text)}</span></div>` : ''}
        </div>`;
    }).join('');
    syncFixBadge();
    paintPlayhead(true);   // innerHTML 重建后把当前播放段重新点亮（DOM 是新的）
  }

  /** 逐段渲染：修复处的文字带虚线标记，其余部分保留要点高亮 */
  function paraHtml(t) {
    const text = t.text || '';
    const fixes = (t.corrections || []).filter((c) => c.cs >= 0 && c.ce <= text.length && c.ce > c.cs).sort((a, b) => a.cs - b.cs);
    if (!fixes.length) return highlight(text);
    let out = '';
    let cursor = 0;
    for (const c of fixes) {
      if (c.cs < cursor) continue;
      out += highlight(text.slice(cursor, c.cs));
      out += `<span class="fix" data-fix="${esc(c.from || '')}" title="${esc(T('doc.originalIs', { text: c.from || '' }))}">${esc(text.slice(c.cs, c.ce))}</span>`;
      cursor = c.ce;
    }
    out += highlight(text.slice(cursor));
    return out;
  }

  function syncFixBadge() {
    const n = fixTotal();
    const btn = $('#fixBtn', root);
    if (!btn) return;
    $('#fixCount', btn).textContent = n;
    btn.classList.toggle('is-on', n > 0);
    btn.title = n ? T('doc.fixCountTitle', { n }) : T('doc.fixEntry');
  }

  function renderPlayer() {
    const hasAudio = !!rec.audio;
    $('#player').style.opacity = hasAudio ? '1' : '0.55';
    $('#player').style.pointerEvents = hasAudio ? 'auto' : 'none';
    totalEl.textContent = fmtDur(rec.durationMs);
    drawPlayerWave();
  }

  function drawPlayerWave() {
    const progress = ctx.currentDocId === id ? ctx.player.currentMs : 0;
    renderWave(canvas, rec?.peaks || [], {
      progressMs: progress,
      durationMs: rec?.durationMs || 1000,
    });
  }

  /* ── 播放联动 ── */
  /* 播放跟读：播放头落在哪一段，那一段就整块亮起来。
     只在真正播放过之后才点亮（否则刚打开文稿第一段就亮着，像是选中状态）；
     暂停时保留高亮——用户多半是想看着刚才听到的位置。 */
  let playOn = false;
  let playId = null;

  function paintPlayhead(force = false) {
    const list = $$('.para', parasEl);
    if (!list.length) { playId = null; return; }
    const ms = ctx.player.currentMs;
    let current = null;
    list.forEach((p) => {
      if (Number(p.dataset.start || 0) <= ms + 120) current = p;
    });
    /* 录音开头往往有一段静音，第一段的时间戳不在 0；
       刚点播放时还没走到那儿，就先亮第一段，别让人以为没反应。 */
    if (!current) current = list[0];
    const id = playOn ? current.dataset.id : null;
    if (id === playId && !force) return;
    playId = id;
    list.forEach((p) => p.classList.toggle('playing', p.dataset.id === id));
    if (!id) return;
    if (userScrolled || Date.now() - lastScrollTs <= 1200) return;
    const node = list.find((p) => p.dataset.id === id);
    if (!node) return;
    const top = node.offsetTop - scrollEl.clientHeight * 0.42;
    scrollEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function updateProgress() {
    const ms = ctx.player.currentMs;
    curEl.textContent = fmtDur(ms);
    drawPlayerWave();
    paintPlayhead();
  }

  /* 播放/暂停图标只在状态真的变了才切——而且只切 class，不动按钮内部节点。
     原来每个 timeupdate（每秒约 4 次）都给按钮赋一次 innerHTML，svg 被反复销毁重建；
     重建若正好落在按下与抬起之间，click 会被派发到已消失元素的祖先，
     冒泡到 root 后 closest('[data-act]') 找不到按钮——表现就是「点暂停要点好几次才生效」。 */
  let iconPlaying = false;   // 模板初始就是播放图标
  function paintPlayIcon() {
    const on = ctx.player.playing;
    if (iconPlaying === on) return;
    iconPlaying = on;
    playBtn.classList.toggle('is-on', on);
    playBtn.setAttribute('aria-label', on ? T('common.pause') : T('common.play'));
  }

  function jumpTo(ms, play = true) {
    if (!rec.audio) { toast(T('doc.noAudio')); return; }
    playOn = true;
    ctx.player.seek(ms);
    if (play) ctx.player.play();
    updateProgress();
  }

  /* ── 编辑 ── */
  function startEdit(ids) {
    editing = ids ? new Set(ids) : new Set(trs.map((t) => t.id));
    if (!trs.length) editing = new Set();
    renderParas();
    if (!trs.length) {
      // 空文稿：直接给一个输入框
      parasEl.innerHTML = `
        <div class="para">
          <div class="para-meta"><span class="para-time">00:00</span><span class="para-flag">${T('doc.newPara')}</span></div>
          <textarea class="para-edit" id="newPara" placeholder="${T('doc.newParaPlaceholder')}"></textarea>
        </div>`;
    }
    editBar.innerHTML = `
      <div class="edit-bar">
        <button class="ghost" data-act="edit-cancel">${T('common.cancel')}</button>
        <button class="ghost accent" data-act="edit-save">${icons.check}${T('common.save')}</button>
      </div>`;
    const first = parasEl.querySelector('textarea');
    first?.focus();
  }

  async function saveEdit() {
    const areas = $$('[data-edit]', parasEl);
    const newArea = $('#newPara', parasEl);
    let changed = 0;
    for (const area of areas) {
      const tid = area.dataset.edit;
      const next = area.value.trim();
      const cur = trs.find((t) => t.id === tid);
      if (cur && next && next !== cur.text) {
        if (!next) continue;
        await updateTranscript(tid, { text: next, status: 'edited', edited: 1, corrections: null, corrected: 0, raw: null });
        changed += 1;
      }
    }
    if (newArea && newArea.value.trim()) {
      await addTranscript({
        recordingId: rec.id,
        startMs: 0,
        endMs: Math.max(0, rec.durationMs),
        text: newArea.value.trim(),
        engine: 'manual',
        status: 'edited',
        edited: 1,
      });
      await updateRecording(rec.id, { engineUsed: 'manual' });
      changed += 1;
    }
    editing = null;
    editBar.innerHTML = '';
    await load();
    renderAll();
    if (changed) toast(T('doc.savedEdits', { n: changed }));
    else toast(T('doc.noChanges'));
  }

  function cancelEdit() {
    editing = null;
    editBar.innerHTML = '';
    renderParas();
  }

  /* ── 导出 ── */
  /**
   * 只认文稿区内的选区（产品文档 7.3「支持复制全文、复制选段」）。
   * 选中标题栏、工具栏按钮文字时不算「选段」，否则用户想复制全文会拿到半句界面文案。
   */
  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const raw = sel.toString().trim();
    if (!raw) return '';
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 3 ? node.parentNode : node);
    const scroll = $('#docScroll', root);
    if (!el || !scroll || !scroll.contains(el)) return '';
    return raw;
  }

  /** 有选区复制选区，没有就复制全文 */
  async function copySelectionOrAll() {
    const sel = selectionText();
    const text = sel || transcriptText();
    if (!text.trim()) { toast(T('doc.noTranscript')); return; }
    const ok = await copyText(text);
    toast(ok
      ? (sel ? T('doc.copiedSel', { n: sel.length }) : T('doc.copiedAll'))
      : T('export.copyFailed'));
  }

  /** 导出带发言人：未确认身份时用临时编号，不冒充真名 */
  function transcriptText() {
    const nameOf = (t) => {
      const owner = t.speakerId ? spk.byId.get(t.speakerId) : null;
      return owner ? ` ${speakerName(owner)}：` : ' ';
    };
    return trs.map((t) => `[${fmtClock(t.startMs, false)}]${nameOf(t)}${t.text}`).join('\n');
  }

  /**
   * 导出结果提示：安卓能拿到真实落盘路径就明说存在哪，
   * 失败也要明说——之前 WebView 下载 blob 静默失败，还弹「已导出」，等于骗人。
   */
  function exportToast(r, doneKey) {
    if (!r || !r.ok) { toast(T('export.failed')); return; }
    toast(r.path ? T('export.savedTo', { path: r.path }) : T(doneKey));
  }

  function openExport() {
    const node = document.createElement('div');
    const selNow = selectionText();
    node.innerHTML = `
      <div class="sheet-actions">
        <button class="sheet-action" data-e="copy">${icons.copy}<span>${selNow ? T('doc.copySelN', { n: selNow.length }) : T('export.copyAll')}</span></button>
        <button class="sheet-action" data-e="docx">${icons.doc}<span>${T('export.docx')}</span></button>
        <button class="sheet-action" data-e="txt">${icons.doc}<span>${T('export.txt')}</span></button>
        <button class="sheet-action" data-e="md">${icons.doc}<span>${T('export.md')}</span></button>
        <button class="sheet-action" data-e="srt">${icons.marker}<span>${T('export.srt')}</span></button>
        <button class="sheet-action" data-e="vtt">${icons.marker}<span>${T('export.vtt')}</span></button>
        <button class="sheet-action" data-e="json">${icons.list}<span>${T('export.json')}</span></button>
        <button class="sheet-action" data-e="pdf">${icons.share}<span>${T('export.pdf')}</span></button>
        <button class="sheet-action" data-e="audio">${icons.download}<span>${T('export.audio')}</span></button>
        ${canWriteFile() ? `<button class="sheet-action" data-e="audioShare">${icons.share}<span>${T('export.shareAudio')}</span></button>` : ''}
      </div>
      <p class="hint" style="margin-top:10px">${T('export.subtitleHint')}</p>`;
    openSheet({ title: T('export.title'), desc: T('export.desc'), content: node });
    node.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-e]')?.dataset.e;
      if (!k) return;
      closeSheet();
      const head = `${rec.title}\n${fmtDate(rec.startedAt)} · ${T('common.duration')} ${fmtDur(rec.durationMs)} · ${engineLabel(rec.engineMode)}\n`;
      const meta = `${fmtDate(rec.startedAt)} · ${T('common.duration')} ${fmtDur(rec.durationMs)} · ${engineLabel(rec.engineMode)}`;
      /* 发言人只在已确认/已编号时带上，未确认时显示临时编号，绝不冒充姓名 */
      const nameOfId = (sid) => {
        const owner = sid ? spk.byId.get(sid) : null;
        return owner ? speakerName(owner) : '';
      };
      const labels = { points: T('export.mdPoints'), body: T('export.mdBody'), empty: T('common.none') };
      if (k === 'copy') {
        const sel = selNow;
        const ok = await copyText(sel || `${head}\n${transcriptText()}`);
        toast(ok
          ? (sel ? T('doc.copiedSel', { n: sel.length }) : T('export.copied'))
          : T('export.copyFailed'));
      } else if (k === 'txt') {
        const r = await downloadText(`${safeName(rec.title)}.txt`, `${head}\n${transcriptText()}`);
        exportToast(r, 'export.doneTxt');
      } else if (k === 'docx') {
        if (!trs.length) { toast(T('doc.noTranscript')); return; }
        const blob = await toDocx({
          title: rec.title, meta, takeaways: analysis.takeaways, trs, nameOf: nameOfId, labels,
        });
        const r = await downloadBlob(`${safeName(rec.title)}.docx`, blob);
        exportToast(r, 'export.doneDocx');
      } else if (k === 'srt' || k === 'vtt') {
        if (!trs.length) { toast(T('doc.noTranscript')); return; }
        const text = k === 'srt'
          ? toSrt(trs, { nameOf: nameOfId })
          : toVtt(trs, { nameOf: nameOfId, title: rec.title });
        const r = await downloadText(
          `${safeName(rec.title)}.${k}`,
          text,
          k === 'srt' ? 'application/x-subrip;charset=utf-8' : 'text/vtt;charset=utf-8',
        );
        exportToast(r, k === 'srt' ? 'export.doneSrt' : 'export.doneVtt');
      } else if (k === 'pdf') {
        if (!trs.length) { toast(T('doc.noTranscript')); return; }
        /* 安卓 WebView 的 window.print 是空操作，别让用户点了没反应 */
        const native = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
          && window.Capacitor.isNativePlatform());
        if (native) { toast(T('export.printUnsupported')); return; }
        const ok = printDoc({
          title: rec.title, meta, takeaways: analysis.takeaways, trs, nameOf: nameOfId, labels,
        });
        if (!ok) toast(T('export.printUnsupported'));
      } else if (k === 'md') {
        const md = `# ${rec.title}\n\n> ${fmtDate(rec.startedAt)} · ${fmtDur(rec.durationMs)} · ${engineLabel(rec.engineMode)}\n\n## ${T('export.mdPoints')}\n\n${
          analysis.takeaways.map((t) => `- ${t.text}`).join('\n') || `- ${T('common.none')}`
        }\n\n## ${T('export.mdBody')}\n\n${trs.map((t) => `**${fmtClock(t.startMs, false)}** ${t.text}`).join('\n\n')}\n`;
        const r = await downloadText(`${safeName(rec.title)}.md`, md, 'text/markdown;charset=utf-8');
        exportToast(r, 'export.doneMd');
      } else if (k === 'json') {
        const data = {
          recording: {
            id: rec.id, title: rec.title, startedAt: rec.startedAt, durationMs: rec.durationMs,
            engineMode: rec.engineMode, mime: rec.mime, size: rec.size,
          },
          takeaways: analysis.takeaways,
          keywords: analysis.keywords,
          segments: trs.map((t) => ({
            startMs: t.startMs, endMs: t.endMs, text: t.text, engine: t.engine,
            edited: !!t.edited, status: t.status,
          })),
        };
        const r = await downloadText(`${safeName(rec.title)}.json`, JSON.stringify(data, null, 2), 'application/json');
        exportToast(r, 'export.doneJson');
      } else if (k === 'audio' || k === 'audioShare') {
        if (!rec.audio) { toast(T('doc.noAudio')); return; }
        const name = `${safeName(rec.title)}.${audioExt(rec.mime || rec.audio.type)}`;
        if (k === 'audioShare') {
          /* 分享走原生：先落盘到「下载/听文/」，再拉起系统分享面板 */
          const saved = await saveBlobNative(rec.audio, name, { share: true }).catch(() => null);
          if (saved) { toast(T('export.shareAudioDone')); return; }
        }
        exportToast(await downloadBlob(name, rec.audio), 'export.doneAudio');
      }
    });
  }


  /* ── 术语抽取 ── */
  /**
   * 从这篇文稿里捞出值得进词库的词。默认全选：抽取规则已经卡掉了虚词毛边与通用名词，
   * 剩下的基本都是这场会议自己的产品名、项目代号和缩写；不想收的取消勾选即可。
   */
  function openTerms() {
    const { terms } = extractTerms(trs, { customDict: ctx.settings.customDict || '', limit: 18 });
    if (!terms.length) { toast(T('terms.empty')); return; }

    const chosen = new Set(terms.map((t) => t.term));
    const node = document.createElement('div');
    node.innerHTML = `
      <div class="term-list">
        ${terms.map((t, i) => `
          <label class="term-row is-on" data-i="${i}">
            <input type="checkbox" checked>
            <span class="term-main">
              <span class="term-word">${esc(t.term)}${t.pair ? `<span class="term-badge">${esc(T('terms.pairBadge'))}</span>` : ''}</span>
              <span class="term-meta">${esc(T('terms.hit', { n: t.hits }))}${t.pair ? ` · ${esc(T('terms.pair', { from: t.pair.from }))}` : ''}</span>
              ${t.sample ? `<span class="term-eg">${esc(t.sample.slice(0, 48))}</span>` : ''}
            </span>
          </label>`).join('')}
      </div>
      <button class="sheet-action primary" data-add>${esc(T('terms.add', { n: terms.length }))}</button>`;
    openSheet({ title: T('terms.title'), desc: T('terms.desc'), content: node });

    const addBtn = $('[data-add]', node);
    const syncCount = () => {
      addBtn.textContent = chosen.size ? T('terms.add', { n: chosen.size }) : T('terms.none');
      addBtn.disabled = chosen.size === 0;
    };

    node.addEventListener('change', (e) => {
      const row = e.target.closest('.term-row');
      if (!row) return;
      const t = terms[Number(row.dataset.i)];
      if (!t) return;
      if (e.target.checked) { chosen.add(t.term); row.classList.add('is-on'); }
      else { chosen.delete(t.term); row.classList.remove('is-on'); }
      syncCount();
    });

    node.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-add]')) return;
      const picked = terms.filter((t) => chosen.has(t.term));
      if (!picked.length) { toast(T('terms.none')); return; }
      const { text, added } = appendDict(ctx.settings.customDict || '', termLines(picked));
      if (!added) { toast(T('terms.duplicated')); closeSheet(); return; }
      ctx.settings = await setSettings({ customDict: text });
      closeSheet();
      toast(T('terms.added', { n: added }));
    });
  }

  /* ── 纠错面板 ── */
  const FIX_KEY = {
    dict: 'fix.typeDict', homophone: 'fix.typeHomophone', context: 'fix.typeContext',
    filler: 'fix.typeFiller', learned: 'fix.typeLearned', llm: 'fix.typeLlm',
  };
  const fixLabel = (type) => (FIX_KEY[type] ? T(FIX_KEY[type]) : type);

  async function persistFix(t, patch) {
    Object.assign(t, patch);
    await updateTranscript(t.id, {
      text: t.text,
      corrections: t.corrections && t.corrections.length ? t.corrections : null,
      corrected: t.corrected ? 1 : 0,
      raw: t.raw || null,
      fixReverted: t.fixReverted ? 1 : 0,
      autoFix: true,
    });
  }

  async function applyPairEverywhere(from, to, type, why) {
    let hits = 0;
    for (const t of trs) {
      if (t.edited || !(t.text || '').includes(from)) continue;
      const next = applyOneFix(t, from, to, type, why);
      if (!next) continue;
      hits += 1;
      await persistFix(t, { ...next, corrected: 1 });
    }
    if (hits) {
      await load();
      renderAll();
      toast(T('fix.applied', { n: hits }));
    } else {
      toast(T('fix.notFound'));
    }
    return hits;
  }

  function openFixPanel() {
    const node = document.createElement('div');
    let counts = {};

    function draw() {
      const items = [];
      trs.forEach((t) => (t.corrections || []).forEach((c, ci) => {
        items.push({ ...c, ci, trId: t.id, startMs: t.startMs });
      }));
      counts = items.reduce((m, x) => {
        m[x.type] = (m[x.type] || 0) + 1;
        return m;
      }, {});
      const tags = Object.keys(counts)
        .map((k) => `<span class="tag">${esc(fixLabel(k))} ${counts[k]}</span>`)
        .join('');
      const list = items.map((c) => `
        <div class="fix-item">
          <div class="fix-item-main">
            <span class="fix-time">${fmtClock(c.startMs, false)}</span>
            <span class="fix-pair"><s>${esc(c.from || '')}</s><span class="fix-arrow">→</span><b>${esc(c.to || T('fix.removed'))}</b></span>
            <span class="fix-type">${esc(fixLabel(c.type))}</span>
          </div>
          <div class="fix-item-acts">
            ${c.from && c.to ? `<button class="mini-btn" data-add="${c.trId}:${c.ci}">${T('fix.addToDict')}</button>` : ''}
            <button class="mini-btn danger" data-undo="${c.trId}:${c.ci}">${T('common.undo')}</button>
          </div>
        </div>`).join('');

      const learnList = learned.map((x, i) => `
        <div class="fix-item">
          <div class="fix-item-main">
            <span class="fix-pair"><s>${esc(x.from)}</s><span class="fix-arrow">→</span><b>${esc(x.to)}</b></span>
            <span class="fix-type">${esc(x.why)}</span>
          </div>
          <div class="fix-item-acts"><button class="mini-btn" data-learn="${i}">${T('common.adopt')}</button></div>
        </div>`).join('');

      const llmList = llmHints.map((x, i) => `
        <div class="fix-item">
          <div class="fix-item-main">
            <span class="fix-time">${fmtClock(trs[x.line]?.startMs || 0, false)}</span>
            <span class="fix-pair"><s>${esc(x.from)}</s><span class="fix-arrow">→</span><b>${esc(x.to)}</b></span>
            <span class="fix-type">${esc(x.why)}</span>
          </div>
          <div class="fix-item-acts"><button class="mini-btn" data-llm="${i}">${T('common.adopt')}</button></div>
        </div>`).join('');

      node.innerHTML = `
        <div class="fix-summary">
          <div class="fix-num"><b>${items.length}</b><span>${T('fix.fixedCount')}</span></div>
          <div class="fix-tags">${tags || `<span class="tag">${T('fix.nothing')}</span>`}</div>
        </div>
        <div class="fix-acts">
          <button class="ghost outline sm" data-fix-act="rescan">${T('fix.rescan')}</button>
          <button class="ghost outline sm" data-fix-act="filler">${T('fix.cleanFiller')}</button>
          <button class="ghost outline sm" data-fix-act="llm" ${llmBusy ? 'disabled' : ''}>${llmBusy ? T('fix.llmRunning') : (llmReady(ctx.settings) ? T('fix.llm') : T('fix.llmUnset'))}</button>
          ${items.length ? `<button class="ghost outline sm" data-fix-act="revert-all">${T('fix.revertAll')}</button>` : ''}
        </div>
        ${items.length ? `<div class="fix-list">${list}</div>` : `<p class="hint" style="margin:12px 2px">${T('fix.nothingHint')}</p>`}
        ${learned.length ? `<div class="fix-sec">${T('fix.learnHead')}</div><div class="fix-list">${learnList}</div>` : ''}
        ${llmHints.length ? `<div class="fix-sec">${T('fix.llmHead')}</div><div class="fix-list">${llmList}</div>` : ''}
        <p class="hint" style="margin:14px 2px 0">${T('fix.footNote')}</p>`;
    }

    draw();
    const close = openSheet({
      title: T('fix.title'),
      desc: T('fix.desc'),
      content: node,
    });

    node.addEventListener('click', async (e) => {
      const undo = e.target.closest('[data-undo]');
      const add = e.target.closest('[data-add]');
      const learn = e.target.closest('[data-learn]');
      const llmBtn = e.target.closest('[data-llm]');
      const actEl = e.target.closest('[data-fix-act]');

      if (undo) {
        const [trId, ci] = undo.dataset.undo.split(':');
        const t = trs.find((x) => x.id === trId);
        if (!t) return;
        const next = revertOne(t, Number(ci));
        if (!next) return;
        /* 撤到最后一条就等于「这篇不要自动纠错」，标记住，免得重开文稿又被纠回去 */
        await persistFix(t, {
          ...next,
          corrected: next.corrections.length ? 1 : 0,
          fixReverted: next.corrections.length ? 0 : 1,
        });
        await load();
        renderAll();
        draw();
        toast(T('fix.reverted'));
        return;
      }

      if (add) {
        const [trId, ci] = add.dataset.add.split(':');
        const t = trs.find((x) => x.id === trId);
        const c = t?.corrections?.[Number(ci)];
        if (!c) return;
        const line = `${c.from}=${c.to}`;
        const cur = ctx.settings.customDict || '';
        if (cur.split(/\r?\n/).some((x) => x.trim() === line)) { toast(T('fix.alreadyInDict')); return; }
        ctx.settings = await setSettings({ customDict: `${cur ? `${cur.replace(/\s+$/, '')}\n` : ''}${line}` });
        toast(T('fix.addedToDict', { line }));
        return;
      }

      if (learn) {
        const item = learned[Number(learn.dataset.learn)];
        if (!item) return;
        await applyPairEverywhere(item.from, item.to, 'learned', item.why);
        learned = suggestMerges(trs.map((t) => t.text || '')).filter(
          (x) => !trs.some((t) => (t.corrections || []).some((c) => c.from === x.from && c.to === x.to)),
        );
        draw();
        return;
      }

      if (llmBtn) {
        const item = llmHints[Number(llmBtn.dataset.llm)];
        const t = trs[item?.line];
        if (!item || !t) return;
        const next = applyOneFix(t, item.from, item.to, 'llm', item.why);
        if (!next) { toast(T('fix.pairChanged')); return; }
        await persistFix(t, { ...next, corrected: 1, fixReverted: 0 });
        llmHints.splice(Number(llmBtn.dataset.llm), 1);
        await load();
        renderAll();
        draw();
        toast(T('fix.adopted'));
        return;
      }

      if (!actEl) return;
      const act = actEl.dataset.fixAct;

      if (act === 'revert-all') {
        const ok = await confirmDialog({
          title: T('fix.revertTitle'),
          message: T('fix.revertMsg'),
          confirmText: T('fix.revertAll'),
          danger: true,
        });
        if (!ok) return;
        for (const t of trs) {
          if (!(t.corrections || []).length) continue;
          const raw = t.raw || t.text;
          await persistFix(t, { text: raw, corrections: null, corrected: 0, raw: null, fixReverted: 1 });
        }
        await load();
        renderAll();
        llmHints = [];
        learned = [];
        draw();
        toast(T('fix.revertedAll'));
        return;
      }

      if (act === 'rescan') {
        const opts = optionsFromSettings(ctx.settings);
        const merges = opts.level === 'aggressive'
          ? suggestMerges(trs.map((t) => t.raw || t.text || ''))
          : [];
        let total = 0;
        for (const t of trs) {
          if (t.edited) continue;
          const base = t.raw || t.text || '';
          if (!base) continue;
          const fix = correctText(base, { ...opts, extraPairs: merges });
          if (!fix.changed) {
            if (t.corrections) await persistFix(t, { text: base, corrections: null, corrected: 0, raw: null, fixReverted: 0 });
            continue;
          }
          await persistFix(t, { text: fix.text, corrections: fix.corrections, corrected: 1, raw: base, fixReverted: 0 });
          total += fix.count;
        }
        await load();
        renderAll();
        learned = suggestMerges(trs.map((t) => t.text || ''));
        draw();
        toast(total ? T('fix.rescanned', { n: total }) : T('fix.rescanNone'));
        return;
      }

      if (act === 'filler') {
        const opts = { ...optionsFromSettings(ctx.settings), filler: true };
        let total = 0;
        for (const t of trs) {
          if (t.edited) continue;
          const base = t.raw || t.text || '';
          if (!base) continue;
          const fix = correctText(base, opts);
          if (!fix.changed) continue;
          await persistFix(t, { text: fix.text, corrections: fix.corrections, corrected: 1, raw: base, fixReverted: 0 });
          total += fix.count;
        }
        await load();
        renderAll();
        draw();
        toast(total ? T('fix.fillerDone', { n: total }) : T('fix.fillerNone'));
        return;
      }

      if (act === 'llm') {
        if (!llmReady(ctx.settings)) {
          close();
          openLLMHint();
          return;
        }
        if (llmBusy) return;
        llmBusy = true;
        draw();
        try {
          const lines = trs.map((t) => t.text || '');
          const edits = await llmCorrect(lines, ctx.settings);
          llmHints = edits;
          toast(edits.length ? T('fix.llmHints', { n: edits.length }) : T('fix.llmNone'));
        } catch (err) {
          toast(err?.message || T('fix.llmFailed'));
        } finally {
          llmBusy = false;
          draw();
        }
      }
    });

    learned = suggestMerges(trs.map((t) => t.text || '')).filter(
      (x) => !trs.some((t) => (t.corrections || []).some((c) => c.from === x.from && c.to === x.to)),
    );
    draw();
  }

  function openLLMHint() {
    openSheet({
      title: T('fix.llmSheetTitle'),
      desc: T('fix.llmSheetDesc'),
      content: `<p class="sheet-desc">${T('fix.llmSheetBody')}</p>
        <p class="hint">${T('fix.offlineHint')}</p>`,
      actions: [{ label: T('fix.gotoSettings'), icon: 'cloud', onClick: () => ctx.navigate('#/settings') }],
    });
  }

  /* ── 独立删除（产品文档 5.4 第 6 条：录音、文字、云端数据可分别删除） ──
     整条删除回收站已经支持，这里补的是「只删其中一样」：
     访谈常要留声不留字（文字涉密），课程笔记反过来要留字不留声（省空间）。 */
  async function deleteAudioOnly() {
    const ok = await confirmDialog({
      title: T('doc.delAudioTitle'),
      message: T('doc.delAudioMsg'),
      confirmText: T('doc.delAudio'),
      danger: true,
    });
    if (!ok) return;
    try { ctx.player?.pause?.(); } catch { /* 播放器可能没在播 */ }
    await clearSegments(rec.id);
    await updateRecording(rec.id, { audio: null, size: 0, peaks: [] });
    rec.audio = null;
    rec.size = 0;
    rec.peaks = [];
    toast(T('doc.audioDeleted'));
    renderAll();
  }

  async function deleteTextOnly() {
    const ok = await confirmDialog({
      title: T('doc.delTextTitle'),
      message: T('doc.delTextMsg'),
      confirmText: T('doc.delText'),
      danger: true,
    });
    if (!ok) return;
    const n = await clearTranscripts(rec.id);
    try { await clearSummaries(rec.id); } catch { /* 摘要清不掉不影响文字删除 */ }
    await updateRecording(rec.id, { hasTranscript: false, pending: { count: 0, totalMs: 0 } });
    toast(T('doc.textDeleted', { n }));
    await load();
    renderAll();
  }

  /* ── 信息 / 操作 ── */
  function openInfo() {
    const st = statusOf(rec);
    const node = document.createElement('div');
    node.innerHTML = `
      <div class="card" style="padding:14px;margin-bottom:4px">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-2);margin-bottom:8px">
          <span>${esc(fmtDate(rec.startedAt))}</span><span>${fmtDur(rec.durationMs)}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <span class="tag">${esc(folderLabel(rec.folder))}</span>
          <span class="tag">${esc(engineLabel(rec.engineMode))}</span>
          <span class="tag ${st.dot === 'ok' ? 'green' : ''}">${esc(st.text)}</span>
          <span class="tag">${esc(fmtBytes(rec.size || rec.audio?.size || 0))}</span>
          <span class="tag">${esc((rec.mime || 'audio').split(';')[0])}</span>
        </div>
        ${rec.bookmarks?.length ? `<div class="hint" style="margin-top:10px">${T('doc.bookmarks')}：${rec.bookmarks.map((b) => fmtClock(b.ms, false)).join(' · ')}</div>` : ''}
        ${rec.interrupted ? `<div class="hint" style="margin-top:8px">${T('doc.intrBody', { reason: intrReasonText(rec.interrupted) })}</div>` : ''}
        ${rec.integrity
          ? `<div class="hint" style="margin-top:8px">${T('doc.integrityLine', {
            n: rec.integrity.segments,
            result: rec.integrity.ok
              ? T('doc.integrityOk')
              : T('doc.integrityBad', { bad: rec.integrity.bad, holes: rec.integrity.holes }),
          })}</div>`
          : ''}
      </div>
      <div class="sheet-actions" style="margin-top:10px">
        <button class="sheet-action" data-a="rename">${icons.edit}<span>${T('common.rename')}</span></button>
        <button class="sheet-action" data-a="edit">${icons.edit}<span>${T('doc.editTranscript')}</span></button>
        <button class="sheet-action" data-a="speaker">${icons.waveform}<span>${T('doc.speaker')}</span></button>
        ${(rec.audio || rec.size) ? `<button class="sheet-action danger" data-a="delAudio">${icons.trash}<span>${T('doc.delAudio')}</span></button>` : ''}
        ${trs.length ? `<button class="sheet-action danger" data-a="delText">${icons.trash}<span>${T('doc.delText')}</span></button>` : ''}
        <button class="sheet-action danger" data-a="delete">${icons.trash}<span>${T('common.delete')}</span></button>
      </div>`;
    openSheet({ title: rec.title, content: node });
    node.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'edit') { closeSheet(); startEdit(); }
      if (a === 'speaker') { closeSheet(); ctx.player.pause(); ctx.navigate(`#/speakers/${rec.id}`); return; }
      if (a === 'delAudio') { closeSheet(); await deleteAudioOnly(); return; }
      if (a === 'delText') { closeSheet(); await deleteTextOnly(); return; }
      if (a === 'rename') {
        closeSheet();
        const box = document.createElement('div');
        box.innerHTML = `<input class="doc-search" id="rn" style="height:44px;margin:8px 0 0;width:100%" value="${esc(rec.title)}" />
          <button class="btn-primary" id="rnOk" style="margin-top:14px">${T('common.saveName')}</button>`;
        const close = openSheet({ title: T('common.rename'), content: box });
        $('#rnOk', box).addEventListener('click', async () => {
          const val = $('#rn', box).value.trim();
          if (!val) return;
          await updateRecording(rec.id, { title: val });
          rec.title = val;
          docTitle.textContent = val;
          close();
          renderTakeaways();
        });
      }
      if (a === 'delete') {
        closeSheet();
        const ok = await confirmDialog({ title: T('doc.deleteTitle'), message: T('doc.deleteMsg'), confirmText: T('common.delete'), danger: true });
        if (ok) {
          await softDeleteRecording(rec.id);
          toast(T('doc.movedToTrash'));
          ctx.navigate('#/', { replace: true });
        }
      }
    });
  }

  /* ── 三栏（按人员 / 纪要 / 待办） ── */
  function syncTabUI() {
    $$('.doc-tab', root).forEach((t) => t.classList.toggle('active', t.dataset.tab === viewing));
  }

  function renderBody() {
    const isTranscript = viewing === 'transcript';
    toolbar.style.display = isTranscript ? '' : 'none';
    if (!isTranscript) spkFilterBar.style.display = 'none';
    else spkFilterBar.style.display = '';
    if (!isTranscript) trBar.style.display = 'none';
    else { trBar.style.display = ''; renderTrBar(); }
    $('[data-act="expand"]', root)?.style.setProperty('display', isTranscript ? '' : 'none');
    if (!isTranscript) searchWrap.innerHTML = '';
    if (isTranscript) { renderParas(); return; }
    if (!tabsApi) {
      tabsApi = createSpeakerTabs({ el: parasEl, ctx, recordingId: id, onLocate: handleLocate });
    }
    parasEl.innerHTML = `<div class="para-empty">${T('common.loading')}</div>`;
    tabsApi.load().then(() => {
      if (viewing === 'speakers') tabsApi.renderSpeakers();
      else if (viewing === 'summary') tabsApi.renderSummary();
      else tabsApi.renderTodos();
    }).catch(() => {
      parasEl.innerHTML = `<div class="para-empty">${T('common.loadFailed')}</div>`;
    });
  }

  /** 总结 / 待办里的“定位”：回到全文并高亮该段，同时定位录音 */
  async function handleLocate(trId, opts = {}) {
    if (opts.changed) {
      await load();
      renderBanner();
      renderRepairBar();
      renderToolbar();
      if (viewing === 'transcript') renderParas();
      return;
    }
    if (opts.ms !== undefined && opts.ms !== null && opts.ms >= 0) jumpTo(opts.ms, true);
    if (!trId) return;
    viewing = 'transcript';
    syncTabUI();
    renderBody();
    const node = parasEl.querySelector(`.para[data-id="${trId}"]`);
    if (node) {
      $$('.para', parasEl).forEach((p) => p.classList.remove('selected'));
      node.classList.add('selected');
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /** 改单段归属（人工结果锁定，自动识别不再覆盖） */
  function openSpkAssign(trId) {
    const tr = trs.find((t) => t.id === trId);
    const box = document.createElement('div');
    const options = [
      ...spk.speakers.map((s) => ({
        id: s.id,
        html: `<span class="spk-dot ${colorOf(s)}"></span><span>${esc(speakerName(s))}</span>${tr?.speakerId === s.id ? `<span class="sheet-check">${icons.check}</span>` : ''}`,
      })),
      { id: '__new', html: `${icons.plus}<span>${T('spk.createSpeaker')}</span>` },
      { id: '__none', html: `${icons.x}<span>${T('spk.unknown')}</span>` },
    ];
    box.innerHTML = `
      ${tr ? `<div class="spk-quote-block">${esc(tr.text)}</div>` : ''}
      <div class="sheet-actions">
        ${options.map((o) => `<button class="sheet-action" data-pick="${o.id}">${o.html}</button>`).join('')}
      </div>`;
    const close = openSheet({ title: T('spk.assignTitle'), content: box });
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-pick]');
      if (!btn) return;
      let speakerId = btn.dataset.pick;
      if (speakerId === '__new') {
        const created = await createEmptySpeaker(id);
        speakerId = created.id;
        toast(T('spk.created', { name: speakerName(created) }));
      }
      if (speakerId === '__none') speakerId = null;
      await reassignSegments(id, trId, speakerId);
      close();
      if (speakerId) toast(T('spk.assigned'));
      await load();
      renderBanner();
      renderRepairBar();
      renderToolbar();
      renderParas();
    });
  }

  async function identify() {
    const btn = $('[data-act="identify"]', root);
    if (btn) { btn.disabled = true; btn.textContent = T('doc.identifying'); }
    const res = await runDiarization(id, {
      settings: ctx.settings,
      onProgress: (p) => {
        const b = $('[data-act="identify"]', root);
        if (b) b.textContent = `${T('doc.identifying')} ${Math.round(p * 100)}%`;
      },
    });
    if (!res.ok) {
      const msg = res.code === 'no-audio' ? T('diar.errNoAudio')
        : res.code === 'no-transcript' ? T('diar.noTranscript')
          : res.code === 'cloud-unconfigured' ? T('diar.errCloudUnset') : T('diar.failed');
      toast(msg);
    } else {
      toast(res.engines.length > 1 ? T('diar.doneFused', { n: res.speakerCount }) : T('diar.done', { n: res.speakerCount }));
    }
    await load();
    renderAll();
  }

  /* ── 渲染全部 ── */
  function renderAll() {
    docTitle.textContent = rec.title;
    $('[data-act="fav"]', root).innerHTML = rec.favorite ? icons.heartFill : icons.heart;
    $('[data-act="fav"]', root).style.color = rec.favorite ? 'var(--red)' : '';
    renderTakeaways();
    renderIntrBar();
    renderBanner();
    renderRepairBar();
    renderToolbar();
    syncTabUI();
    renderBody();
    renderPlayer();
  }

  /* ── 事件 ── */
  root.addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-act]');
    const chip = e.target.closest('[data-filter]');
    const spkChip = e.target.closest('[data-spkfilter]');
    const spkEdit = e.target.closest('[data-spk-edit]');
    const para = e.target.closest('.para');
    const bullet = e.target.closest('[data-jump]');
    const tab = e.target.closest('.doc-tab');
    const fixEl = e.target.closest('.fix');

    if (bullet) { jumpTo(Number(bullet.dataset.jump)); return; }
    if (fixEl) { toast(T('doc.originalIs', { text: fixEl.dataset.fix || T('doc.emptyOriginal') })); return; }

    if (spkEdit) {
      e.stopPropagation();
      const trId = spkEdit.dataset.spkEdit;
      if (!spk.byId.size) { await identify(); return; }
      openSpkAssign(trId);
      return;
    }

    if (spkChip) {
      const v = spkChip.dataset.spkfilter;
      // 再点一次取消筛选，回到全部（没有单独的“全部”芯片，靠这个回退）
      spkFilter = spkFilter === v ? 'all' : v;
      renderToolbar();
      renderParas();
      return;
    }

    if (chip) {
      filter = chip.dataset.filter;
      renderToolbar();
      renderParas();
      return;
    }

    if (tab && tab.dataset.tab) {
      viewing = tab.dataset.tab;
      syncTabUI();
      renderBody();
      return;
    }

    if (para && !editing && !e.target.closest('textarea') && !e.target.closest('button')) {
      const ms = Number(para.dataset.start || 0);
      const wasActive = para.classList.contains('playing');
      $$('.para', parasEl).forEach((p) => p.classList.remove('selected'));
      para.classList.add('selected');
      if (rec.audio) {
        jumpTo(ms, !wasActive);
      } else {
        toast(T('doc.noAudio'));
      }
      return;
    }

    if (!actEl) return;
    const act = actEl.dataset.act;

    if (act === 'back') { ctx.player.pause(); ctx.navigate('#/'); return; }
    if (act === 'identify') { await identify(); return; }
    if (act === 'translate') { openTranslate(); return; }
    if (act === 'tr-toggle') { trShow = !trShow; renderTrBar(); renderParas(); return; }
    if (act === 'tr-lang') {
      trLang = actEl.dataset.lang;
      trMap = await getTranslationMap(id, trLang);
      trShow = true;
      renderTrBar();
      renderParas();
      return;
    }
    if (act === 'tr-retranslate') { await runTranslate(trLang); return; }
    if (act === 'tr-clear') { await clearTrans(trLang); return; }
    if (act === 'repair') { await doRepair(); return; }
    if (act === 'speakers') { ctx.player.pause(); ctx.navigate(`#/speakers/${id}`); return; }
    if (act === 'fav') {
      rec.favorite = !rec.favorite;
      await updateRecording(rec.id, { favorite: rec.favorite });
      renderAll();
      toast(rec.favorite ? T('doc.favorited') : T('doc.unfavorited'));
      return;
    }
    if (act === 'info') { openInfo(); return; }
    if (act === 'fix') { openFixPanel(); return; }
    if (act === 'play') {
      if (!rec.audio) { toast(T('doc.noAudio')); return; }
      /* 只有播放器里装的不是这条录音时才重装。只看 currentDocId 会在
         「从列表页试听进来」「视图来回切换」这些路径上误判成没装载，
         一 load 就把 currentTime 清零——表现出来就是点暂停又回到开头。 */
      if (!ctx.player.isLoaded(rec.id)) ctx.player.load(rec.audio, rec.id);
      ctx.currentDocId = id;
      /* 播完了再点播放才从头；暂停中续播保持原位。 */
      if (ctx.player.ended) { ctx.player.seek(0); ctx.player.play(); return; }
      ctx.player.toggle();
      return;
    }
    if (act === 'back15') { ctx.player.nudge(-15000); updateProgress(); return; }
    if (act === 'fwd15') { ctx.player.nudge(15000); updateProgress(); return; }
    if (act === 'speed') {
      speedIdx = (speedIdx + 1) % speeds.length;
      const s = speeds[speedIdx];
      ctx.player.setRate(s);
      actEl.textContent = s === 1 ? '1.0×' : `${s}×`;
      return;
    }
    if (act === 'export') { openExport(); return; }
    if (act === 'terms') { openTerms(); return; }
    if (act === 'expand') {
      const max = scrollEl.scrollHeight;
      scrollEl.scrollTo({ top: scrollEl.scrollTop > 40 ? 0 : max, behavior: 'smooth' });
      return;
    }
    if (act === 'search') {
      if (searchWrap.querySelector('input')) {
        searchWrap.innerHTML = '';
        searchQuery = '';
        renderParas();
        return;
      }
      searchWrap.innerHTML = `
        <div class="doc-search">${icons.search}<input id="ds" placeholder="${T('doc.searchInDoc')}" />
        <button class="icon-btn" data-act="search-clear" style="width:26px;height:26px">${icons.x}</button></div>`;
      const inp = $('#ds', searchWrap);
      inp.focus();
      inp.addEventListener('input', debounce(() => {
        searchQuery = inp.value.trim();
        renderParas();
      }, 150));
      return;
    }
    if (act === 'search-clear') {
      searchWrap.innerHTML = '';
      searchQuery = '';
      renderParas();
      return;
    }
    if (act === 'edit') { startEdit(); return; }
    if (act === 'edit-cancel') { cancelEdit(); return; }
    if (act === 'edit-save') { await saveEdit(); return; }
    if (act === 'seek') {
      const rect = actEl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (!rec.audio) return;
      if (!ctx.player.isLoaded(rec.id)) ctx.player.load(rec.audio, rec.id);
      ctx.currentDocId = id;
      ctx.player.seek(ratio * (ctx.player.durationMs || rec.durationMs));
      updateProgress();
    }
  });

  scrollEl.addEventListener('scroll', () => {
    userScrolled = true;
    lastScrollTs = Date.now();
    clearTimeout(scrollEl._ut);
    scrollEl._ut = setTimeout(() => { userScrolled = false; }, 1600);
  }, { passive: true });

  const unsub = ctx.player.on((type) => {
    if (type === 'ended') {
      if (ctx.currentDocId !== id) return;
      /* 只关掉播放态，让 paintPlayhead 自己去比对并摘掉高亮。
         这里若顺手清 playId，paintPlayhead 会误判「没变化」直接返回，高亮就摘不掉了。 */
      playOn = false;
      paintPlayIcon();
      updateProgress();
      return;
    }
    if (type === 'time' || type === 'state' || type === 'loaded') {
      if (ctx.currentDocId !== id) return;
      if (ctx.player.playing) playOn = true;
      paintPlayIcon();
      updateProgress();
      if (type === 'loaded') totalEl.textContent = fmtDur(rec.durationMs);
    }
  });

  const onResize = debounce(() => drawPlayerWave(), 160);
  window.addEventListener('resize', onResize);

  (async () => {
    const ok = await load();
    if (!ok) {
      root.innerHTML = `<div class="view"><div class="empty"><h3>${T('doc.notFound')}</h3><p>${T('doc.notFoundDesc')}</p>
        <button class="ghost accent" data-act="back" style="margin-top:16px">${T('common.home')}</button></div></div>`;
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="back"]')) ctx.navigate('#/');
      });
      return;
    }
    renderAll();
    if (rec.audio) {
      /* 从列表页试听进来时播放器里已经是这一条了，别再重装——重装会把位置清零 */
      if (!ctx.player.isLoaded(rec.id)) {
        ctx.player.load(rec.audio, rec.id);
        ctx.player.seek(0);
      }
      ctx.currentDocId = id;
      ctx.player.setRate(1);   // 视图重建后倍速按钮显示的是 1.0×，播放器要跟着归位
      updateProgress();
    }
  })();

  return {
    destroy() {
      unsub();
      tabsApi?.destroy();
      window.removeEventListener('resize', onResize);
      ctx.player.pause();
      if (ctx.currentDocId === id) ctx.currentDocId = null;
    },
  };
}
