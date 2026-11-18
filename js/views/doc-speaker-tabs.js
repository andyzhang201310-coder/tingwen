/**
 * 文稿页的「按人员 / AI 纪要 / 待办」三栏
 * ------------------------------------------------------------------
 * 对应产品规范 4.4：会议详情页提供全文、按人员、AI 纪要、待办。
 * 这一层只管渲染与交互，数据从 speakers.js / summarize.js 取。
 */

import { esc, fmtClock, fmtDur } from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, closeSheet, confirmDialog } from '../ui.js';
import {
  loadSpeakerView, speakerName, reassignSegments, createEmptySpeaker, runDiarization,
} from '../speakers.js';
import { buildSummaries, dataVersionOf, scenarioOf, SCENARIOS } from '../summarize.js';
import { llmReady } from '../correct.js';
import {
  getMeetingSummary, listSpeakerSummaries, listActionItems, updateActionItem, listTranscripts,
  getRecording, updateRecording,
} from '../store.js';
import { T } from '../i18n.js';

const colorOf = (spk) => `c${((spk?.color ?? 0) % 6 + 6) % 6}`;

const SCENARIO_LABEL = {
  meeting: 'sum.scenarioMeeting',
  class: 'sum.scenarioClass',
  interview: 'sum.scenarioInterview',
  memo: 'sum.scenarioMemo',
};

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
    scenario: 'meeting',
    expanded: new Set(),
    loaded: false,
  };

  /* ── 数据 ── */
  async function load() {
    const view = await loadSpeakerView(recordingId);
    const [meeting, persons, actions, trs, rec] = await Promise.all([
      getMeetingSummary(recordingId),
      listSpeakerSummaries(recordingId),
      listActionItems(recordingId),
      listTranscripts(recordingId),
      getRecording(recordingId),
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
      scenario: scenarioOf(rec, ctx.settings),
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
  function scenarioBar() {
    return `
      <div class="scen-bar">
        ${SCENARIOS.map((sc) => `
          <button class="filter-chip ${state.scenario === sc ? 'active' : ''}" data-tab-act="scenario" data-sc="${sc}">
            ${esc(T(SCENARIO_LABEL[sc]))}
          </button>`).join('')}
      </div>`;
  }

  /** 摘要块：一段话 + 主题词，四个场景共用 */
  function abstractBlock(m) {
    return `
      <div class="sum-abs">
        <div class="sum-abs-label">${T('sum.abstract')}</div>
        <p class="sum-overview">${esc(m.overview)}</p>
        ${m.topics?.length ? `<div class="tk-chips">${m.topics.map((t) => `<span class="tag">${esc(t.text)}</span>`).join('')}</div>` : ''}
      </div>`;
  }

  const actionItemsOf = (m) => (m.actionItems || []).map((a) => ({
    text: a.text,
    src: a.src || (a.transcriptId ? [{ trId: a.transcriptId, startMs: a.startMs }] : []),
  }));

  /** 按场景渲染主体 */
  function scenarioBlocks(m) {
    const sc = m.scenario || 'meeting';

    if (sc === 'class') {
      return `
        <article class="sum-card">
          <div class="sum-card-head">${T('doc.classSummary')}</div>
          ${abstractBlock(m)}
          ${(m.chapters || []).map((c) => `
            <div class="sum-sec">
              <div class="sum-sec-head">
                <span class="sum-chap-no">${c.index}</span>${esc(c.title)}
                ${c.startMs ? `<span class="sum-src">${fmtClock(c.startMs, false)}</span>` : ''}
              </div>
              <ul class="sum-list">${(c.points || []).map(sumItem).join('')}</ul>
            </div>`).join('')}
          ${section(T('sum.emphasis'), m.emphasis)}
          ${section(T('sum.actions'), actionItemsOf(m))}
        </article>
        ${m.reviewOutline?.length ? `
          <article class="sum-card">
            <div class="sum-card-head">${T('sum.reviewOutline')}</div>
            ${m.reviewOutline.map((r) => `
              <div class="sum-sec">
                <div class="sum-sec-head">${esc(r.title)}</div>
                <ul class="sum-list">${(r.items || []).map(sumItem).join('')}</ul>
              </div>`).join('')}
          </article>` : ''}`;
    }

    if (sc === 'interview') {
      return `
        <article class="sum-card">
          <div class="sum-card-head">${T('doc.interviewSummary')}</div>
          ${abstractBlock(m)}
          ${(m.qa || []).map((q) => {
            const src = q.question?.src?.[0];
            return `
              <div class="qa-pair">
                <div class="qa-q" ${src ? `data-locate="${src.trId}" data-jump="${src.startMs}"` : ''}>
                  <span class="qa-mark">Q</span><span>${esc(q.question?.text || '')}</span>
                </div>
                <div class="qa-a">
                  <span class="qa-mark">A</span><span>${esc(q.answer?.text || '')}</span>
                </div>
              </div>`;
          }).join('')}
          ${!m.qa?.length ? `<p class="hint">${T('sum.noQa')}</p>` : ''}
        </article>
        ${m.quotes?.length ? `
          <article class="sum-card">
            <div class="sum-card-head">${T('sum.quotes')}</div>
            <ul class="sum-list">${m.quotes.map(sumItem).join('')}</ul>
          </article>` : ''}
        ${m.followUps?.length ? `
          <article class="sum-card">
            <div class="sum-card-head">${T('sum.followUps')}</div>
            <ul class="sum-list">${m.followUps.map(sumItem).join('')}</ul>
          </article>` : ''}
        ${m.actionItems?.length ? `
          <article class="sum-card">
            <div class="sum-card-head">${T('sum.actions')}</div>
            <ul class="sum-list">${actionItemsOf(m).map(sumItem).join('')}</ul>
          </article>` : ''}`;
    }

    if (sc === 'memo') {
      return `
        <article class="sum-card">
          <div class="sum-card-head">${T('doc.memoSummary')}</div>
          ${abstractBlock(m)}
          ${section(T('sum.keyPoints'), m.keyPoints)}
          ${section(T('sum.reminders'), m.reminders)}
          ${section(T('sum.actions'), actionItemsOf(m))}
        </article>`;
    }

    return `
      <article class="sum-card">
        <div class="sum-card-head">${T('doc.meetingSummary')}</div>
        ${abstractBlock(m)}
        ${section(T('sum.discussion'), m.discussionPoints)}
        ${section(T('sum.decisions'), m.confirmedDecisions)}
        ${section(T('sum.open'), m.unresolvedQuestions)}
        ${section(T('sum.actions'), actionItemsOf(m))}
      </article>
      ${m.participantOpinions?.length ? `
        <article class="sum-card">
          <div class="sum-card-head">${T('sum.opinions')}</div>
          ${m.participantOpinions.map((o) => `
            <div class="sum-opinion">
              <div class="sum-opinion-name">${esc(o.name || T('spk.unknown'))}</div>
              <ul class="sum-list">${sumItem({ text: o.text, src: o.src })}</ul>
            </div>`).join('')}
        </article>` : ''}`;
  }

  function renderSummary() {
    state.kind = 'summary';
    const m = state.meeting?.payload;
    if (!m) {
      el.innerHTML = `
        ${scenarioBar()}
        <div class="para-empty">${T('doc.summaryEmpty')}</div>
        <p class="hint" style="padding:0 0 18px">${T('doc.summaryEmptyDesc')}</p>
        <button class="ghost accent" data-tab-act="summarize">${icons.sparkle}${T('doc.summaryGenerate')}</button>
        ${!state.speakers.length ? `<p class="hint" style="margin-top:14px">${T('doc.summaryNoSpeaker')}</p>` : ''}`;
      return;
    }
    const personById = new Map(state.persons.map((p) => [p.speakerId, p]));
    const mismatch = (m.scenario || 'meeting') !== state.scenario;
    el.innerHTML = `
      ${scenarioBar()}
      <div class="sum-toolbar">
        <span class="tag ${state.meeting.generator === 'llm' ? 'accent' : ''}">
          ${state.meeting.generator === 'llm' ? T('doc.summaryByLlm') : T('doc.summaryByRules')}
        </span>
        <div class="spacer"></div>
        <button class="mini-btn" data-tab-act="summarize">${T('doc.summaryRegenerate')}</button>
        <button class="mini-btn" data-tab-act="summarize-llm">${T('doc.summaryLlm')}</button>
      </div>
      ${mismatch ? `<p class="hint sum-stale">${T('doc.scenarioMismatch')}</p>` : ''}
      ${stale() ? `<p class="hint sum-stale">${T('doc.summaryStale')}</p>` : ''}
      ${scenarioBlocks(m)}
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
    /* 配了大模型就直接走大模型：待办靠规则只能抓到第一人称承诺，容易一条都出不来 */
    const genAct = llmReady(ctx.settings) ? 'summarize-llm' : 'summarize';
    if (!state.actions.length) {
      el.innerHTML = `
        <div class="para-empty">${T('doc.todoEmpty')}</div>
        <button class="ghost accent" data-tab-act="${genAct}">${icons.sparkle}${T('doc.summaryGenerate')}</button>`;
      return;
    }
    el.innerHTML = `
      <div class="sum-toolbar">
        <span class="tag ${state.meeting?.generator === 'llm' ? 'accent' : ''}">
          ${state.meeting?.generator === 'llm' ? T('doc.summaryByLlm') : T('doc.summaryByRules')}
        </span>
        <div class="spacer"></div>
        <button class="mini-btn" data-tab-act="${genAct}">${T('doc.todoRegenerate')}</button>
      </div>
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
    if (allowLLM && !llmReady(ctx.settings)) {
      const go = await confirmDialog({
        title: T('doc.summaryLlm'),
        message: T('sum.llmNeedConfig'),
        confirmText: T('sum.llmGoSettings'),
      });
      if (go) ctx.navigate('#/settings');
      return;
    }
    state.busy = 'summarize';
    /* 两个按钮都在工具栏里（重新生成 / 用大模型重写），必须按点了哪一个取，
       否则「生成中…」会写到另一个按钮上 */
    const btn = el.querySelector(`[data-tab-act="${allowLLM ? 'summarize-llm' : 'summarize'}"]`);
    const old = btn?.textContent;
    if (btn) { btn.textContent = T('doc.summaryGenerating'); btn.disabled = true; }
    try {
      const res = await buildSummaries(recordingId, {
        settings: ctx.settings, allowLLM, scenario: state.scenario,
      });
      if (!res.ok) {
        toast(res.code === 'no-transcript' ? T('diar.noTranscript') : T('doc.summaryEmpty'));
        return;
      }
      if (!allowLLM) {
        toast(T('doc.summaryGenerated'));
      } else if (res.generator === 'llm') {
        toast(T('doc.summaryGenerated'));
      } else {
        /* 回退时把真实原因说出来（401、余额不足、超时都在这里），否则只看到一句“不可用”没法排查 */
        toast(res.llmError ? `${T('sum.llmFallback')} · ${res.llmError}` : T('sum.llmFallback'));
      }
      await load();
      renderByKind();
    } catch (err) {
      toast(err?.message || T('common.loadFailed'));
    } finally {
      state.busy = '';
      if (btn) { btn.textContent = old || T('doc.summaryRegenerate'); btn.disabled = false; }
    }
  }

  /** 切换场景：写入本条记录，已有总结则按新场景重算规则版（不自动调用大模型） */
  async function switchScenario(sc) {
    if (state.scenario === sc || state.busy) return;
    state.scenario = sc;
    await updateRecording(recordingId, { reportScenario: sc });
    if (state.meeting) {
      state.busy = 'scenario';
      try {
        await buildSummaries(recordingId, { settings: ctx.settings, scenario: sc });
        await load();
      } finally {
        state.busy = '';
      }
    }
    renderSummary();
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
    if (act === 'scenario') { await switchScenario(actEl.dataset.sc); return; }
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
