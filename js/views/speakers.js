/**
 * 发言人确认页（#/speakers/:recId）
 * ------------------------------------------------------------------
 * 对应产品规范 4.3 / 7.2：
 * 每位临时发言人显示编号、首次发言时间、发言次数、总时长、代表片段、确认状态；
 * 支持确认真名、标记未知、合并、改单段归属、播放代表音频。
 */

import { $, esc, fmtClock, fmtDur } from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, confirmDialog } from '../ui.js';
import { getRecording } from '../store.js';
import {
  loadSpeakerView, speakerName, speakerStatusText,
  renameSpeaker, markSpeakerUnknown, mergeSpeakers, undoMerge,
  reassignSegments, createEmptySpeaker, retryTask, runDiarization,
} from '../speakers.js';
import { T } from '../i18n.js';

const colorOf = (spk) => `c${((spk?.color ?? 0) % 6 + 6) % 6}`;

const STATUS_CLASS = {
  confirmed: 'ok',
  unknown: 'mute',
  unconfirmed: 'warn',
};

export function mountSpeakers(root, ctx, recordingId) {
  root.innerHTML = `
    <div class="view spk">
      <header class="spk-top">
        <button class="icon-btn" data-act="back" aria-label="${T('common.back')}">${icons.chevronLeft}</button>
        <div class="spk-heading">
          <div class="spk-kicker">${T('spk.kicker')}</div>
          <h1 class="spk-title">${T('spk.pageTitle')}</h1>
        </div>
        <button class="icon-btn" data-act="doc" aria-label="${T('spk.viewDoc')}">${icons.doc}</button>
      </header>
      <div class="scroll spk-scroll" id="spkScroll"></div>
    </div>`;

  const scroll = $('#spkScroll', root);
  let rec = null;
  let view = null;
  let busy = false;

  /* ── 数据 ── */
  async function load() {
    rec = await getRecording(recordingId);
    if (!rec) return false;
    view = await loadSpeakerView(recordingId);
    return true;
  }

  /* ── 渲染 ── */
  function taskRow(task) {
    const modeText = task.mode === 'ondevice'
      ? T('diar.modeOnDevice')
      : task.mode === 'http' ? T('diar.modeHttp') : task.mode === 'simulated' ? T('diar.modeSim') : '';
    const statusKey = `diar.status${task.status.charAt(0).toUpperCase()}${task.status.slice(1)}`;
    const dot = task.status === 'completed' ? 'ok' : task.status === 'failed' ? 'err' : 'warn';
    return `
      <div class="diar-task">
        <i class="dot ${dot}"></i>
        <span class="diar-task-name">${task.engine === 'local' ? T('diar.engineLocal') : T('diar.engineCloud')}</span>
        ${modeText ? `<span class="diar-task-mode">${esc(modeText)}</span>` : ''}
        <span class="diar-task-status">${esc(T(statusKey))}</span>
        ${task.status === 'failed'
          ? `<button class="mini-btn" data-act="retry" data-engine="${task.engine}">${T('diar.taskRetry')}</button>`
          : ''}
      </div>`;
  }

  /**
   * 录音质量：信噪比与重叠语音。
   * 远场开会时分离结果会明显变差，但界面原本只说「已识别 N 人」——
   * 用户不知道这份结果该信几分。这里把不可见的声学条件明说出来。
   */
  function qualityHtml() {
    const q = view.quality;
    if (!q) return '';
    const LEVEL = {
      clean: ['ok', 'spk.qualityClean'],
      moderate: ['warn', 'spk.qualityModerate'],
      noisy: ['bad', 'spk.qualityNoisy'],
      unknown: ['mute', 'spk.qualityUnknown'],
    };
    const [cls, key] = LEVEL[q.level] || LEVEL.unknown;
    const bits = [];
    /* 信噪比低于 18 dB 时不展示：那是「片段里没有停顿、算不准」的产物，
       和左边的「清晰」摆在一起只会让人怀疑这个判断。 */
    if (Number.isFinite(q.snrDb) && q.snrDb >= 18) bits.push(T('spk.qualitySnr', { db: q.snrDb }));
    if (q.overlapSpans) bits.push(T('spk.overlapSpans', { n: q.overlapSpans }));
    if (q.lowConfSpans) bits.push(T('spk.lowConfSpans', { n: q.lowConfSpans }));
    const advice = q.level === 'noisy'
      ? `<p class="hint">${esc(T('spk.qualityNoisyHint'))}</p>`
      : (q.overlapSpans ? `<p class="hint">${esc(T('spk.overlapHint'))}</p>` : '');
    return `
      <div class="spk-quality">
        <span class="spk-q-badge ${cls}">${esc(T(key))}</span>
        ${bits.length ? `<span class="spk-q-detail">${esc(bits.join(' · '))}</span>` : ''}
      </div>
      ${advice}`;
  }

  function overviewHtml() {
    const n = view.speakers.length;
    const conflicts = view.transcripts.filter((t) => (t.speakerConfidence ?? 1) < 0.45 && t.speakerId).length;
    const locked = view.transcripts.filter((t) => t.speakerLocked).length;
    const sim = view.tasks.some((t) => t.mode === 'simulated' && t.status === 'completed');
    const cloudFailed = view.tasks.some((t) => t.engine === 'cloud' && t.status === 'failed');
    return `
      <section class="spk-overview">
        <div class="spk-nums">
          <div class="spk-num"><b>${n}</b><span>${T('spk.peopleLabel')}</span></div>
          <div class="spk-num"><b>${view.unconfirmed}</b><span>${T('spk.statusUnconfirmed')}</span></div>
          <div class="spk-num"><b>${view.transcripts.length}</b><span>${T('doc.tabTranscript')}</span></div>
        </div>
        <div class="diar-tasks">
          ${view.tasks.length
            ? view.tasks.map(taskRow).join('')
            : `<div class="diar-task"><i class="dot mute"></i><span class="diar-task-name">${T('diar.title')}</span><span class="diar-task-status">${T('diar.statusPending')}</span></div>`}
        </div>
        ${qualityHtml()}
        <div class="spk-flags">
          ${conflicts ? `<span class="tag">${esc(T('spk.conflicts', { n: conflicts }))}</span>` : ''}
          ${view.unknownCount ? `<span class="tag">${esc(T('spk.unknownSegments', { n: view.unknownCount }))}</span>` : ''}
          ${locked ? `<span class="tag">${esc(T('spk.lockedCount', { n: locked }))}</span>` : ''}
        </div>
        ${sim ? `<p class="hint diar-sim">${T('diar.simNote')}</p>` : ''}
        ${cloudFailed && !sim ? `<p class="hint">${T('diar.cloudFailed')}</p>` : ''}
        <div class="spk-overview-acts">
          <button class="ghost outline sm" data-act="rerun" ${busy ? 'disabled' : ''}>
            ${busy ? T('spk.rerunning') : T('spk.rerun')}
          </button>
          <button class="ghost outline sm" data-act="doc">${T('spk.viewDoc')}</button>
        </div>
      </section>`;
  }

  function speakerCard(spk) {
    const segs = view.groups.get(spk.id) || [];
    const sample = segs.slice().sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs))[0];
    const name = speakerName(spk);
    const status = speakerStatusText(spk);
    const initial = spk.displayName ? spk.displayName.slice(0, 1) : `S${spk.order}`;
    return `
      <article class="spk-card" data-spk="${spk.id}">
        <div class="spk-card-head">
          <div class="spk-avatar ${colorOf(spk)}">${esc(initial)}</div>
          <div class="spk-card-main">
            <div class="spk-card-name">
              <span>${esc(name)}</span>
              <span class="spk-status ${STATUS_CLASS[spk.identityStatus] || 'warn'}">${esc(status)}</span>
            </div>
            <div class="spk-card-meta">
              ${spk.firstSeenMs !== null && spk.firstSeenMs !== undefined ? `<span>${esc(T('spk.firstSeen', { time: fmtClock(spk.firstSeenMs, false) }))}</span>` : ''}
              <span>${esc(T('spk.times', { n: spk.segmentCount || segs.length }))}</span>
              <span>${esc(T('spk.totalSpeech', { dur: fmtDur(spk.totalSpeechMs || 0) }))}</span>
            </div>
          </div>
        </div>
        ${sample ? `
          <button class="spk-sample" data-act="preview" data-start="${sample.startMs}" data-end="${sample.endMs}">
            <span class="spk-quote">${esc(sample.text.slice(0, 46))}${sample.text.length > 46 ? '…' : ''}</span>
            <span class="spk-play">${icons.play}</span>
          </button>` : `<p class="spk-empty">${T('spk.emptySpeaker')}</p>`}
        <div class="spk-acts">
          <button class="mini-btn" data-act="rename">${T('spk.rename')}</button>
          <button class="mini-btn" data-act="merge">${T('spk.merge')}</button>
          <button class="mini-btn" data-act="segments">${T('spk.viewSegments')}</button>
          ${spk.identityStatus !== 'unknown' ? `<button class="mini-btn" data-act="unknown">${T('spk.markUnknown')}</button>` : ''}
        </div>
      </article>`;
  }

  function unassignedCard() {
    if (!view.unknownCount) return '';
    return `
      <button class="spk-unassigned" data-act="unassigned">
        ${icons.waveform}
        <span>${esc(T('spk.unknownSegments', { n: view.unknownCount }))}</span>
        <span class="chev">${icons.chevronRight}</span>
      </button>`;
  }

  function mergeHistoryHtml() {
    const done = view.merges.filter((m) => !m.reversedAt);
    if (!done.length) return '';
    return `
      <div class="spk-sec">${T('spk.mergeHistory')}</div>
      ${done.map((m) => {
        const from = view.byId.get(m.sourceSpeakerId);
        const to = view.byId.get(m.targetSpeakerId);
        return `
          <div class="spk-history">
            <span>${esc(from ? speakerName(from) : '—')} → ${esc(to ? speakerName(to) : '—')}</span>
            <button class="mini-btn" data-act="undo-merge" data-id="${m.id}">${T('spk.mergeUndo')}</button>
          </div>`;
      }).join('')}`;
  }

  function render() {
    if (!view.speakers.length && !view.transcripts.length) {
      scroll.innerHTML = `
        <div class="empty">
          ${icons.waveform}
          <h3>${T('diar.noTranscript')}</h3>
          <p>${T('spk.noSpeakerDesc')}</p>
        </div>`;
      return;
    }
    if (!view.speakers.length) {
      scroll.innerHTML = `
        ${overviewHtml()}
        <div class="empty" style="padding:28px 24px 40px">
          ${icons.waveform}
          <h3>${T('spk.noSpeaker')}</h3>
          <p>${T('spk.noSpeakerDesc')}</p>
          <button class="ghost accent" data-act="rerun" style="margin-top:16px">${T('spk.startIdentify')}</button>
        </div>`;
      return;
    }
    scroll.innerHTML = `
      ${overviewHtml()}
      <div class="spk-list">${view.speakers.map(speakerCard).join('')}</div>
      ${unassignedCard()}
      ${mergeHistoryHtml()}
      <p class="hint spk-foot">${T('spk.identityNote')}</p>`;
  }

  /* ── 试听 ── */
  function preview(startMs, endMs, btn) {
    if (!rec?.audio) { toast(T('doc.noAudio')); return; }
    if (!ctx.player.isLoaded(recordingId)) ctx.player.load(rec.audio, recordingId);
    ctx.currentDocId = recordingId;
    ctx.player.seek(startMs);
    ctx.player.play();
    clearInterval(preview.timer);
    preview.timer = setInterval(() => {
      if (ctx.player.currentMs >= Math.max(startMs + 400, endMs) || !ctx.player.playing) {
        ctx.player.pause();
        clearInterval(preview.timer);
        btn?.classList.remove('is-playing');
      }
    }, 160);
    btn?.classList.add('is-playing');
  }

  /* ── 操作 ── */
  function openRename(spk) {
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('spk.identityNote')}</p>
      <label class="set-field"><span>${T('spk.rename')}</span>
        <input class="dict-input" id="spkName" placeholder="${T('spk.namePlaceholder')}" value="${esc(spk.displayName || '')}" /></label>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="ghost outline" id="spkUnknown" style="flex:1">${T('spk.markUnknown')}</button>
        <button class="btn-primary" id="spkSave" style="flex:1">${T('common.saveName')}</button>
      </div>`;
    const close = openSheet({ title: T('spk.rename'), content: box });
    const input = $('#spkName', box);
    input.focus();
    input.select();
    $('#spkSave', box).addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) { toast(T('spk.namePlaceholder')); return; }
      await renameSpeaker(spk.id, name);
      close();
      toast(T('spk.nameSaved'));
      await refresh();
    });
    $('#spkUnknown', box).addEventListener('click', async () => {
      await markSpeakerUnknown(spk.id);
      close();
      toast(T('spk.markedUnknown'));
      await refresh();
    });
  }

  function openMerge(spk) {
    const others = view.speakers.filter((s) => s.id !== spk.id);
    if (!others.length) { toast(T('spk.noSpeaker')); return; }
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${esc(T('spk.mergeDesc', { name: speakerName(spk) }))}</p>
      <div class="sheet-actions">
        ${others.map((o) => `
          <button class="sheet-action" data-target="${o.id}">
            <span class="spk-dot ${colorOf(o)}"></span>
            <span>${esc(speakerName(o))}</span>
            <span class="spk-arrow">← ${esc(T('spk.segmentCount', { n: spk.segmentCount || 0 }))}</span>
          </button>`).join('')}
      </div>`;
    const close = openSheet({ title: T('spk.mergeTitle'), content: box });
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-target]');
      if (!btn) return;
      const target = view.byId.get(btn.dataset.target);
      close();
      const res = await mergeSpeakers(recordingId, spk.id, target.id);
      if (res.ok) toast(T('spk.mergeDone', { name: speakerName(target), n: res.moved }));
      await refresh();
    });
  }

  function openAssign(trId) {
    const tr = view.transcripts.find((t) => t.id === trId);
    const box = document.createElement('div');
    box.innerHTML = `
      ${tr ? `<div class="spk-quote-block">${esc(tr.text)}</div>` : ''}
      <div class="sheet-actions">
        ${view.speakers.map((s) => `
          <button class="sheet-action" data-assign="${s.id}">
            <span class="spk-dot ${colorOf(s)}"></span><span>${esc(speakerName(s))}</span>
            ${tr?.speakerId === s.id ? `<span class="sheet-check">${icons.check}</span>` : ''}
          </button>`).join('')}
        <button class="sheet-action" data-assign="__new">${icons.plus}<span>${T('spk.createSpeaker')}</span></button>
        <button class="sheet-action" data-assign="__none">${icons.x}<span>${T('spk.unknown')}</span></button>
      </div>`;
    const close = openSheet({ title: T('spk.assignTitle'), content: box });
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-assign]');
      if (!btn) return;
      const val = btn.dataset.assign;
      let speakerId = val;
      if (val === '__new') {
        const created = await createEmptySpeaker(recordingId);
        speakerId = created.id;
        toast(T('spk.created', { name: speakerName(created) }));
      }
      if (val === '__none') speakerId = null;
      await reassignSegments(recordingId, trId, speakerId);
      close();
      if (val !== '__new') toast(T('spk.assigned'));
      await refresh();
    });
  }

  function openSegments(spk, onlyUnassigned = false) {
    const list = onlyUnassigned
      ? view.transcripts.filter((t) => !t.speakerId)
      : (view.groups.get(spk?.id) || []);
    const box = document.createElement('div');
    box.innerHTML = list.length ? `
      <p class="sheet-desc">${onlyUnassigned ? T('spk.unknownSegHint') : esc(T('spk.segmentCount', { n: list.length }))}</p>
      <div class="spk-seg-list">
        ${list.map((t) => {
          const owner = view.byId.get(t.speakerId);
          return `
            <div class="spk-seg" data-seg="${t.id}" data-start="${t.startMs}">
              <div class="spk-seg-head">
                <span class="spk-seg-time">${fmtClock(t.startMs, false)}</span>
                ${owner ? `<span class="spk-dot ${colorOf(owner)}"></span><span class="spk-seg-owner">${esc(speakerName(owner))}</span>` : ''}
                ${t.speakerLocked ? `<span class="spk-seg-flag">${T('spk.lockedFlag')}</span>` : ''}
                ${(t.speakerConfidence ?? 1) < 0.45 ? `<span class="spk-seg-flag warn">${T('spk.conflictFlag')}</span>` : ''}
              </div>
              <div class="spk-seg-text">${esc(t.text)}</div>
              <div class="spk-seg-acts">
                <button class="mini-btn" data-assign-seg="${t.id}">${T('spk.changeOwner')}</button>
              </div>
            </div>`;
        }).join('')}
      </div>` : `<p class="hint">${T('spk.emptySpeaker')}</p>`;
    openSheet({ title: onlyUnassigned ? T('spk.unknownSegments', { n: list.length }) : T('spk.viewSegments'), content: box });
    box.addEventListener('click', (e) => {
      const seg = e.target.closest('.spk-seg');
      const assignBtn = e.target.closest('[data-assign-seg]');
      if (assignBtn) {
        e.stopPropagation();
        openAssign(assignBtn.dataset.assignSeg);
        return;
      }
      if (seg) preview(Number(seg.dataset.start || 0), 0);
    });
  }

  async function refresh() {
    await load();
    render();
  }

  async function doRerun() {
    if (busy) return;
    busy = true;
    render();
    const res = await runDiarization(recordingId, {
      settings: ctx.settings,
      onProgress: (p) => {
        const btn = $('[data-act="rerun"]', scroll);
        if (btn) btn.textContent = `${T('spk.rerunning')} ${Math.round(p * 100)}%`;
      },
    });
    busy = false;
    if (!res.ok) {
      const msg = res.code === 'no-audio' ? T('diar.errNoAudio')
        : res.code === 'no-transcript' ? T('diar.noTranscript')
          : res.code === 'cloud-unconfigured' ? T('diar.errCloudUnset')
            : T('diar.failed');
      toast(msg);
    } else {
      toast(res.engines.length > 1 ? T('diar.doneFused', { n: res.speakerCount }) : T('diar.done', { n: res.speakerCount }));
    }
    await refresh();
    ctx.currentView?.refresh?.();
  }

  /* ── 事件 ── */
  root.addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-act]');
    const card = e.target.closest('.spk-card');
    if (!actEl) return;
    const act = actEl.dataset.act;
    const spk = card ? view.byId.get(card.dataset.spk) : null;

    if (act === 'back') { ctx.player.pause(); ctx.navigate('#/'); return; }
    if (act === 'doc') { ctx.navigate(`#/doc/${recordingId}`); return; }
    if (act === 'rerun') { await doRerun(); return; }
    if (act === 'preview') {
      preview(Number(actEl.dataset.start), Number(actEl.dataset.end), actEl);
      return;
    }
    if (act === 'retry') {
      await retryTask(recordingId, actEl.dataset.engine);
      await doRerun();
      return;
    }
    if (act === 'unassigned') { openSegments(null, true); return; }
    if (act === 'undo-merge') {
      const res = await undoMerge(recordingId, actEl.dataset.id);
      toast(res.ok ? T('spk.mergeUndone') : T('diar.failed'));
      await refresh();
      return;
    }
    if (!spk) return;
    if (act === 'rename') { openRename(spk); return; }
    if (act === 'merge') { openMerge(spk); return; }
    if (act === 'segments') { openSegments(spk); return; }
    if (act === 'unknown') {
      const ok = await confirmDialog({
        title: T('spk.markUnknown'),
        message: T('spk.identityNote'),
        confirmText: T('common.confirm'),
      });
      if (!ok) return;
      await markSpeakerUnknown(spk.id);
      toast(T('spk.markedUnknown'));
      await refresh();
    }
  });

  (async () => {
    const ok = await load();
    if (!ok) {
      scroll.innerHTML = `<div class="empty"><h3>${T('doc.notFound')}</h3><p>${T('doc.notFoundDesc')}</p></div>`;
      return;
    }
    render();
  })();

  return {
    refresh,
    destroy() {
      clearInterval(preview.timer);
      if (ctx.currentDocId === recordingId) {
        ctx.player.pause();
        ctx.currentDocId = null;
      }
    },
  };
}
