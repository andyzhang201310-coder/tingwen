/**
 * 文稿页的「按人员 / AI 纪要 / 待办」三栏
 * ------------------------------------------------------------------
 * 对应产品规范 4.4：会议详情页提供全文、按人员、AI 纪要、待办。
 * 这一层只管渲染与交互，数据从 speakers.js / summarize.js 取。
 */

import { esc, fmtClock, fmtDur } from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, closeSheet } from '../ui.js';
import {
  loadSpeakerView, speakerName, reassignSegments, createEmptySpeaker, runDiarization,
} from '../speakers.js';
import { buildSummaries, dataVersionOf } from '../summarize.js';
import {
  getMeetingSummary, listSpeakerSummaries, listActionItems, updateActionItem, listTranscripts,
} from '../store.js';
import { T } from '../i18n.js';

const colorOf = (spk) => `c${((spk?.color ?? 0) % 6 + 6) % 6}`;

export function createSpeakerTabs({ el, ctx, recordingId, onLocate }) {
  let state = {
    trs: [],
    speakers: [],
    groups: new Map(),
    byId: new Map(),
    tasks: [],
    unknownCount: 0,
    unconfirmed: 0,
    meeting: null,
    persons: [],
    actions: [],
    busy: '',
    kind: 'speakers',
    expanded: new Set(),
    loaded: false,
  };

  /* ── 数据 ── */
  async function load() {
    const view = await loadSpeakerView(recordingId);
    const [meeting, persons, actions, trs] = await Promise.all([
      getMeetingSummary(recordingId),
      listSpeakerSummaries(recordingId),
      listActionItems(recordingId),
      listTranscripts(recordingId),
    ]);
    state = {
      ...state,
      trs,
      speakers: view.speakers,
      groups: view.groups,
      byId: view.byId,
      tasks: view.tasks,
      unknownCount: view.unknownCount,
      unconfirmed: view.unconfirmed,
      meeting,
      persons,
      actions,
      loaded: true,
    };
  }

  const stale = () => !!state.meeting && state.meeting.dataVersion !== dataVersionOf(state.trs);

  /* ── 通用片段 ── */
  function sumItem(item) {
    const src = item.src?.[0];
    return `<li class="sum-item" ${src ? `data-locate="${src.trId}" data-jump="${src.startMs}"` : ''}>
      <span>${esc(item.text)}</span>
      ${src ? `<span class="sum-src">${fmtClock(src.startMs, false)}</span>` : ''}
    </li>`;
  }

  function section(title, items) {
    if (!items || !items.length) return '';
    return `
      <div class="sum-sec">
        <div class="sum-sec-head">${esc(title)}</div>
        <ul class="sum-list">${items.map(sumItem).join('')}</ul>
      </div>`;
  }

  function renderByKind() {
    if (state.kind === 'speakers') renderSpeakers();
    else if (state.kind === 'summary') renderSummary();
    else renderTodos();
  }

  /* ── 按人员 ── */
  function renderSpeakers() {
    state.kind = 'speakers';
    if (!state.speakers.length) {
      el.innerHTML = `
        <div class="para-empty">${T('doc.noSpeakerYet')}</div>
        <p class="hint" style="padding:0 0 18px">${T('doc.noSpeakerDesc')}</p>
        <button class="ghost accent" data-tab-act="identify">${icons.sparkle}${T('doc.runIdentify')}</button>`;
      return;
    }
    const personById = new Map(state.persons.map((p) => [p.speakerId, p]));
    el.innerHTML = `
      <div class="spk-tab-note">
        <button class="ghost outline sm" data-tab-act="goto-speakers">${icons.waveform}${T('doc.goConfirm')}</button>
        <span class="hint">${esc(T('spk.identityNote'))}</span>
      </div>
      ${state.speakers.map((spk) => {
        const segs = state.groups.get(spk.id) || [];
        const open = state.expanded.has(spk.id);
        const p = personById.get(spk.id)?.payload;
        const shown = open ? segs : segs.slice(0, 3);
        return `
          <article class="spk-block" data-spk="${spk.id}">
            <header class="spk-block-head" data-tab-act="toggle" data-id="${spk.id}">
              <span class="spk-avatar sm ${colorOf(spk)}">${esc(spk.displayName ? spk.displayName.slice(0, 1) : `S${spk.order}`)}</span>
              <div class="spk-block-main">
                <div class="spk-card-name">
                  <span>${esc(speakerName(spk))}</span>
                  <span class="spk-status ${spk.identityStatus === 'confirmed' ? 'ok' : spk.identityStatus === 'unknown' ? 'mute' : 'warn'}">
                    ${esc(spk.identityStatus === 'confirmed' ? T('spk.statusConfirmed') : spk.identityStatus === 'unknown' ? T('spk.statusUnknown') : T('spk.statusUnconfirmed'))}
                  </span>
                </div>
                <div class="spk-card-meta">
                  <span>${esc(T('spk.times', { n: segs.length }))}</span>
                  <span>${esc(T('spk.totalSpeech', { dur: fmtDur(spk.totalSpeechMs || 0) }))}</span>
                </div>
              </div>
              <span class="chev ${open ? 'open' : ''}">${icons.chevronDown}</span>
            </header>
            ${p ? `<p class="sum-overview">${esc(p.overview)}</p>` : ''}
            ${p ? `
              ${section(T('sum.keyPoints'), p.keyPoints)}
              ${section(T('sum.questions'), p.questions)}
              ${section(T('sum.suggestions'), p.suggestions)}
              ${section(T('sum.decisions'), p.decisions)}
              ${section(T('sum.commitments'), p.commitments)}
            ` : ''}
            <div class="spk-block-segs">
              ${shown.map((t) => `
                <button class="spk-line" data-jump="${t.startMs}">
                  <span class="spk-line-time">${fmtClock(t.startMs, false)}</span>
                  <span class="spk-line-text">${esc(t.text)}</span>
                </button>`).join('')}
              ${segs.length > 3
                ? `<button class="mini-btn" data-tab-act="toggle" data-id="${spk.id}">
                    ${open ? T('common.collapse') : T('doc.showAll', { n: segs.length })}
                  </button>`
                : ''}
              ${!segs.length ? `<p class="hint">${T('spk.emptySpeaker')}</p>` : ''}
            </div>
            <div class="spk-block-acts">
              <button class="mini-btn" data-tab-act="summary-of" data-id="${spk.id}">${T('spk.summaryEntry')}</button>
              <button class="mini-btn" data-tab-act="reassign" data-id="${spk.id}">${T('spk.changeOwner')}</button>
            </div>
          </article>`;
      }).join('')}
      ${state.unknownCount ? `
        <button class="spk-unassigned" data-tab-act="identify">
          ${icons.waveform}<span>${esc(T('spk.unknownSegments', { n: state.unknownCount }))}</span>
        </button>` : ''}`;
  }

  /* ── AI 纪要 ── */
  function renderSummary() {
    state.kind = 'summary';
    const m = state.meeting?.payload;
    if (!m) {
      el.innerHTML = `
        <div class="para-empty">${T('doc.summaryEmpty')}</div>
        <p class="hint" style="padding:0 0 18px">${T('doc.summaryEmptyDesc')}</p>
        <button class="ghost accent" data-tab-act="summarize">${icons.sparkle}${T('doc.summaryGenerate')}</button>
        ${!state.speakers.length ? `<p class="hint" style="margin-top:14px">${T('doc.summaryNoSpeaker')}</p>` : ''}`;
      return;
    }
    const personById = new Map(state.persons.map((p) => [p.speakerId, p]));
    el.innerHTML = `
      <div class="sum-toolbar">
        <span class="tag ${state.meeting.generator === 'llm' ? 'accent' : ''}">
          ${state.meeting.generator === 'llm' ? T('doc.summaryByLlm') : T('doc.summaryByRules')}
        </span>
        <div class="spacer"></div>
        <button class="mini-btn" data-tab-act="summarize">${T('doc.summaryRegenerate')}</button>
        <button class="mini-btn" data-tab-act="summarize-llm">${T('doc.summaryLlm')}</button>
      </div>
      ${stale() ? `<p class="hint sum-stale">${T('doc.summaryStale')}</p>` : ''}
      <article class="sum-card">
        <div class="sum-card-head">${T('doc.meetingSummary')}</div>
        <p class="sum-overview">${esc(m.overview)}</p>
        ${m.topics?.length ? `<div class="tk-chips">${m.topics.map((t) => `<span class="tag">${esc(t.text)}</span>`).join('')}</div>` : ''}
        ${section(T('sum.discussion'), m.discussionPoints)}
        ${section(T('sum.decisions'), m.confirmedDecisions)}
        ${section(T('sum.open'), m.unresolvedQuestions)}
        ${section(T('sum.actions'), (m.actionItems || []).map((a) => ({ text: a.text, src: a.src || (a.transcriptId ? [{ trId: a.transcriptId, startMs: a.startMs }] : []) })))}
      </article>
      ${m.participantOpinions?.length ? `
        <article class="sum-card">
          <div class="sum-card-head">${T('sum.opinions')}</div>
          ${m.participantOpinions.map((o) => `
            <div class="sum-opinion">
              <div class="sum-opinion-name">${esc(o.name || T('spk.unknown'))}</div>
              <ul class="sum-list">${sumItem({ text: o.text, src: o.src })}</ul>
            </div>`).join('')}
        </article>` : ''}
      ${state.speakers.map((spk) => {
        const row = personById.get(spk.id);
        if (!row) return '';
        const p = row.payload;
        return `
          <article class="sum-card" data-sum-spk="${spk.id}">
            <div class="sum-card-head">
              <span class="spk-dot ${colorOf(spk)}"></span>${esc(speakerName(spk))}
            </div>
            <p class="sum-overview">${esc(p.overview)}</p>
            ${section(T('sum.keyPoints'), p.keyPoints)}
            ${section(T('sum.questions'), p.questions)}
            ${section(T('sum.suggestions'), p.suggestions)}
            ${section(T('sum.decisions'), p.decisions)}
            ${section(T('sum.commitments'), p.commitments)}
            ${section(T('sum.actions'), p.actionItems)}
          </article>`;
      }).join('')}
      <p class="hint sum-foot">${T('doc.sourceHint')}</p>`;
  }

  /* ── 待办 ── */
  function renderTodos() {
    state.kind = 'todos';
    if (!state.actions.length) {
      el.innerHTML = `
        <div class="para-empty">${T('doc.todoEmpty')}</div>
        <button class="ghost accent" data-tab-act="summarize">${icons.sparkle}${T('doc.summaryGenerate')}</button>`;
      return;
    }
    el.innerHTML = `
      <div class="todo-list">
        ${state.actions.map((a) => {
          const owner = a.ownerId ? state.byId.get(a.ownerId) : null;
          const done = a.status === 'done';
          return `
            <div class="todo-item ${done ? 'is-done' : ''}" data-todo="${a.id}">
              <button class="todo-check" data-tab-act="toggle-todo" data-id="${a.id}" aria-label="${T('doc.todoMarkDone')}">
                ${done ? icons.check : ''}
              </button>
              <div class="todo-main">
                <div class="todo-text">${esc(a.text)}</div>
                <div class="todo-meta">
                  <span class="todo-owner ${owner ? '' : 'pending'}">
                    ${esc(T('doc.todoOwner'))}：${owner ? esc(speakerName(owner)) : esc(T('doc.todoUnassigned'))}
                  </span>
                  ${a.dueText ? `<span>${esc(T('doc.todoDue'))}：${esc(a.dueText)}</span>` : ''}
                  ${a.transcriptId ? `<button class="todo-src" data-locate="${a.transcriptId}" data-jump="${a.startMs}">${T('common.jump')}</button>` : ''}
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>
      <p class="hint sum-foot">${T('doc.sourceHint')}</p>`;
  }

  /* ── 交互 ── */
  async function doSummarize(allowLLM) {
    if (state.busy) return;
    state.busy = 'summarize';
    const btn = el.querySelector('[data-tab-act="summarize"]');
    const old = btn?.textContent;
    if (btn) { btn.textContent = T('doc.summaryGenerating'); btn.disabled = true; }
    try {
      const res = await buildSummaries(recordingId, { settings: ctx.settings, allowLLM });
      if (!res.ok) {
        toast(res.code === 'no-transcript' ? T('diar.noTranscript') : T('doc.summaryEmpty'));
        return;
      }
      toast(allowLLM && res.generator === 'rules' ? T('sum.llmFallback') : T('doc.summaryGenerated'));
      await load();
      renderByKind();
    } catch (err) {
      toast(err?.message || T('common.loadFailed'));
    } finally {
      state.busy = '';
      if (btn) { btn.textContent = old || T('doc.summaryRegenerate'); btn.disabled = false; }
    }
  }

  async function identify() {
    if (state.busy) return;
    state.busy = 'identify';
    el.innerHTML = `<div class="para-empty">${T('diar.running')}</div>`;
    const res = await runDiarization(recordingId, {
      settings: ctx.settings,
      onProgress: (p) => {
        const node = el.querySelector('.para-empty');
        if (node) node.textContent = `${T('diar.running')} ${Math.round(p * 100)}%`;
      },
    });
    state.busy = '';
    if (!res.ok) {
      toast(res.code === 'no-audio' ? T('diar.errNoAudio') : T('diar.failed'));
    } else {
      toast(T('diar.done', { n: res.speakerCount }));
    }
    await load();
    renderByKind();
    onLocate?.(null, { changed: true });
  }

  function openReassign(spk) {
    const list = state.groups.get(spk.id) || [];
    if (!list.length) { toast(T('spk.emptySpeaker')); return; }
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('spk.changeOwner')}</p>
      <div class="spk-seg-list">
        ${list.map((t) => `
          <div class="spk-seg" data-seg="${t.id}" data-start="${t.startMs}">
            <div class="spk-seg-head">
              <span class="spk-seg-time">${fmtClock(t.startMs, false)}</span>
              ${t.speakerLocked ? `<span class="spk-seg-flag">${T('spk.lockedFlag')}</span>` : ''}
            </div>
            <div class="spk-seg-text">${esc(t.text)}</div>
            <div class="spk-seg-acts">
              <button class="mini-btn" data-assign="${t.id}">${T('spk.changeOwner')}</button>
            </div>
          </div>`).join('')}
      </div>`;
    openSheet({ title: speakerName(spk), content: box });
    box.addEventListener('click', async (e) => {
      const assign = e.target.closest('[data-assign]');
      if (assign) {
        e.stopPropagation();
        closeSheet();
        openAssign(assign.dataset.assign);
        return;
      }
      const seg = e.target.closest('.spk-seg');
      if (seg) onLocate?.(null, { ms: Number(seg.dataset.start || 0) });
    });
  }

  function openAssign(trId) {
    const tr = state.trs.find((t) => t.id === trId);
    const box = document.createElement('div');
    box.innerHTML = `
      ${tr ? `<div class="spk-quote-block">${esc(tr.text)}</div>` : ''}
      <div class="sheet-actions">
        ${state.speakers.map((s) => `
          <button class="sheet-action" data-pick="${s.id}">
            <span class="spk-dot ${colorOf(s)}"></span><span>${esc(speakerName(s))}</span>
            ${tr?.speakerId === s.id ? `<span class="sheet-check">${icons.check}</span>` : ''}
          </button>`).join('')}
        <button class="sheet-action" data-pick="__new">${icons.plus}<span>${T('spk.createSpeaker')}</span></button>
        <button class="sheet-action" data-pick="__none">${icons.x}<span>${T('spk.unknown')}</span></button>
      </div>`;
    const close = openSheet({ title: T('spk.assignTitle'), content: box });
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-pick]');
      if (!btn) return;
      const val = btn.dataset.pick;
      let speakerId = val;
      if (val === '__new') speakerId = (await createEmptySpeaker(recordingId)).id;
      if (val === '__none') speakerId = null;
      await reassignSegments(recordingId, trId, speakerId);
      close();
      toast(T('spk.assigned'));
      await load();
      onLocate?.(null, { changed: true });
      renderByKind();
    });
  }

  el.addEventListener('click', async (e) => {
    const locate = e.target.closest('[data-locate]');
    if (locate) {
      onLocate?.(locate.dataset.locate, { ms: Number(locate.dataset.jump || 0) });
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      onLocate?.(null, { ms: Number(jump.dataset.jump || 0) });
      return;
    }
    const actEl = e.target.closest('[data-tab-act]');
    if (!actEl) return;
    const act = actEl.dataset.tabAct;
    if (act === 'toggle') {
      const id = actEl.dataset.id;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      renderSpeakers();
      return;
    }
    if (act === 'goto-speakers') { ctx.navigate(`#/speakers/${recordingId}`); return; }
    if (act === 'identify') { await identify(); return; }
    if (act === 'summarize') { await doSummarize(false); return; }
    if (act === 'summarize-llm') { await doSummarize(true); return; }
    if (act === 'toggle-todo') {
      const id = actEl.dataset.id;
      const cur = state.actions.find((a) => a.id === id);
      if (!cur) return;
      const next = cur.status === 'done' ? 'open' : 'done';
      // 勾选就是勾选：不弹确认框，再点一次即可改回来
      await updateActionItem(id, { status: next, doneAt: next === 'done' ? Date.now() : null });
      toast(next === 'done' ? T('doc.todoDoneToast') : T('doc.todoOpenToast'));
      await load();
      renderTodos();
      return;
    }
    if (act === 'reassign') {
      const spk = state.byId.get(actEl.dataset.id);
      if (spk) openReassign(spk);
      return;
    }
    if (act === 'summary-of') {
      const id = actEl.dataset.id;
      document.querySelector('.doc-tab[data-tab="summary"]')?.click();
      setTimeout(() => {
        document.querySelector(`.sum-card[data-sum-spk="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 450);
    }
  });

  return {
    load,
    renderSpeakers,
    renderSummary,
    renderTodos,
    get state() { return state; },
    destroy() {},
  };
}
