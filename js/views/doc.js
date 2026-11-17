import {
  $, $$, esc, fmtClock, fmtDur, fmtDate, fmtBytes, safeName,
  copyText, downloadText, downloadBlob, debounce,
} from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, confirmDialog, renderWave, closeSheet } from '../ui.js';
import {
  getRecording, updateRecording, listTranscripts, updateTranscript,
  addTranscript, deleteTranscript, softDeleteRecording, purgeRecording, setSettings,
} from '../store.js';
import { analyze } from '../ai.js';
import { statusOf, engineLabel, folderLabel } from '../model.js';
import { T } from '../i18n.js';
import {
  correctText, optionsFromSettings, suggestMerges, llmCorrect, llmReady,
  renderTextWithFixes, applyOneFix, revertOne,
} from '../correct.js';
import {
  loadSpeakerView, speakerName, runDiarization, reassignSegments, createEmptySpeaker,
} from '../speakers.js';
import { createSpeakerTabs } from './doc-speaker-tabs.js';

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
        <div id="spkBanner"></div>

        <div class="doc-tabs">
          <button class="doc-tab active" data-tab="transcript">${T('doc.tabTranscript')}</button>
          <button class="doc-tab" data-tab="speakers">${T('doc.tabSpeakers')}</button>
          <button class="doc-tab" data-tab="summary">${T('doc.tabSummary')}</button>
          <button class="doc-tab" data-tab="todos">${T('doc.tabTodos')}</button>
          <div class="doc-tabs-end">
            <button class="fix-btn" id="fixBtn" data-act="fix" aria-label="${T('doc.fixEntry')}">${icons.sparkle}<span id="fixCount">0</span></button>
            <button class="icon-btn" data-act="expand" aria-label="${T('common.expand')}">${icons.expand}</button>
          </div>
        </div>

        <div class="doc-toolbar" id="toolbar"></div>
        <div class="doc-toolbar spk-filter-bar" id="spkFilterBar" hidden></div>
        <div id="searchWrap"></div>
        <div class="paras" id="paras"></div>
      </div>

      <div class="player" id="player">
        <div class="player-wave" data-act="seek"><canvas id="pwave"></canvas></div>
        <div class="player-times"><span id="cur">00:00</span><span id="total">00:00</span></div>
        <div class="player-ctrls">
          <button class="speed-btn" data-act="speed">1.0×</button>
          <button class="icon-btn" data-act="back15" aria-label="${T('doc.back15')}">${icons.back15}</button>
          <button class="player-play" data-act="play" aria-label="${T('common.play')}">${icons.play}</button>
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
  let llmBusy = false;
  let spk = { speakers: [], byId: new Map(), groups: new Map(), tasks: [], unknownCount: 0, unconfirmed: 0 };
  let tabsApi = null;

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

  /* ── 渲染：发言人横幅 ── */
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
            <p>${spk.unknownCount ? T('spk.unknownSegments', { n: spk.unknownCount }) : T('spk.identityNote')}</p>
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
          <div class="para selected" data-id="${t.id}">
            <div class="para-meta"><span class="para-time">${fmtClock(t.startMs, false)}</span>
              <span class="para-flag">${T('doc.editing')}</span></div>
            <textarea class="para-edit" data-edit="${t.id}">${esc(text)}</textarea>
          </div>`;
      }
      const fixes = t.corrections || [];
      const owner = t.speakerId ? spk.byId.get(t.speakerId) : null;
      const lowConf = t.speakerId && (t.speakerConfidence ?? 1) < 0.45;
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
        </div>`;
    }).join('');
    syncFixBadge();
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
  function updateProgress() {
    const ms = ctx.player.currentMs;
    curEl.textContent = fmtDur(ms);
    drawPlayerWave();
    const list = $$('.para', parasEl);
    let current = null;
    list.forEach((p) => {
      const start = Number(p.dataset.start || 0);
      p.classList.remove('playing');
      if (start <= ms + 120) current = p;
    });
    if (current && ctx.player.playing) {
      current.classList.add('playing');
      if (!userScrolled && Date.now() - lastScrollTs > 1200) {
        const top = current.offsetTop - scrollEl.clientHeight * 0.42;
        scrollEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }

  function jumpTo(ms, play = true) {
    if (!rec.audio) { toast(T('doc.noAudio')); return; }
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
  /** 导出带发言人：未确认身份时用临时编号，不冒充真名 */
  function transcriptText() {
    const nameOf = (t) => {
      const owner = t.speakerId ? spk.byId.get(t.speakerId) : null;
      return owner ? ` ${speakerName(owner)}：` : ' ';
    };
    return trs.map((t) => `[${fmtClock(t.startMs, false)}]${nameOf(t)}${t.text}`).join('\n');
  }

  function openExport() {
    const node = document.createElement('div');
    node.innerHTML = `
      <div class="sheet-actions">
        <button class="sheet-action" data-e="copy">${icons.copy}<span>${T('export.copyAll')}</span></button>
        <button class="sheet-action" data-e="txt">${icons.doc}<span>${T('export.txt')}</span></button>
        <button class="sheet-action" data-e="md">${icons.doc}<span>${T('export.md')}</span></button>
        <button class="sheet-action" data-e="json">${icons.list}<span>${T('export.json')}</span></button>
        <button class="sheet-action" data-e="audio">${icons.download}<span>${T('export.audio')}</span></button>
      </div>`;
    openSheet({ title: T('export.title'), desc: T('export.desc'), content: node });
    node.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-e]')?.dataset.e;
      if (!k) return;
      closeSheet();
      const head = `${rec.title}\n${fmtDate(rec.startedAt)} · ${T('common.duration')} ${fmtDur(rec.durationMs)} · ${engineLabel(rec.engineMode)}\n`;
      if (k === 'copy') {
        const ok = await copyText(`${head}\n${transcriptText()}`);
        toast(ok ? T('export.copied') : T('export.copyFailed'));
      } else if (k === 'txt') {
        downloadText(`${safeName(rec.title)}.txt`, `${head}\n${transcriptText()}`);
        toast(T('export.doneTxt'));
      } else if (k === 'md') {
        const md = `# ${rec.title}\n\n> ${fmtDate(rec.startedAt)} · ${fmtDur(rec.durationMs)} · ${engineLabel(rec.engineMode)}\n\n## ${T('export.mdPoints')}\n\n${
          analysis.takeaways.map((t) => `- ${t.text}`).join('\n') || `- ${T('common.none')}`
        }\n\n## ${T('export.mdBody')}\n\n${trs.map((t) => `**${fmtClock(t.startMs, false)}** ${t.text}`).join('\n\n')}\n`;
        downloadText(`${safeName(rec.title)}.md`, md, 'text/markdown;charset=utf-8');
        toast(T('export.doneMd'));
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
        downloadText(`${safeName(rec.title)}.json`, JSON.stringify(data, null, 2), 'application/json');
        toast(T('export.doneJson'));
      } else if (k === 'audio') {
        if (!rec.audio) { toast(T('doc.noAudio')); return; }
        const ext = (rec.mime || '').includes('mp4') ? 'm4a' : 'webm';
        downloadBlob(`${safeName(rec.title)}.${ext}`, rec.audio);
        toast(T('export.doneAudio'));
      }
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
        await persistFix(t, { ...next, corrected: next.corrections.length ? 1 : 0 });
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
        await persistFix(t, { ...next, corrected: 1 });
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
          await persistFix(t, { text: raw, corrections: null, corrected: 0, raw: null });
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
            if (t.corrections) await persistFix(t, { text: base, corrections: null, corrected: 0, raw: null });
            continue;
          }
          await persistFix(t, { text: fix.text, corrections: fix.corrections, corrected: 1, raw: base });
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
          await persistFix(t, { text: fix.text, corrections: fix.corrections, corrected: 1, raw: base });
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
      </div>
      <div class="sheet-actions" style="margin-top:10px">
        <button class="sheet-action" data-a="rename">${icons.edit}<span>${T('common.rename')}</span></button>
        <button class="sheet-action" data-a="edit">${icons.edit}<span>${T('doc.editTranscript')}</span></button>
        <button class="sheet-action" data-a="speaker">${icons.waveform}<span>${T('doc.speaker')}</span></button>
        <button class="sheet-action danger" data-a="delete">${icons.trash}<span>${T('common.delete')}</span></button>
      </div>`;
    openSheet({ title: rec.title, content: node });
    node.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'edit') { closeSheet(); startEdit(); }
      if (a === 'speaker') { closeSheet(); ctx.player.pause(); ctx.navigate(`#/speakers/${rec.id}`); return; }
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
    renderBanner();
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
      if (ctx.currentDocId !== id) {
        ctx.player.load(rec.audio);
        ctx.currentDocId = id;
      }
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
      if (ctx.currentDocId !== id) { ctx.player.load(rec.audio); ctx.currentDocId = id; }
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
    if (type === 'time' || type === 'state' || type === 'loaded') {
      if (ctx.currentDocId !== id) return;
      playBtn.innerHTML = ctx.player.playing ? icons.pause : icons.play;
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
      if (ctx.currentDocId !== id) {
        ctx.player.load(rec.audio);
        ctx.currentDocId = id;
        ctx.player.seek(0);
        ctx.player.setRate(1);
      }
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
