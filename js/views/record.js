import { $, $$, esc, fmtBytes, sha256Short } from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, confirmDialog, renderWave, timerHtml } from '../ui.js';
import {
  createRecording, updateRecording, addSegment, clearSegments,
  addTranscript, purgeRecording, listTranscripts,
} from '../store.js';
import { Recorder } from '../audio.js';
import { createASR, estimateSpan } from '../asr.js';
import { analyze, suggestTitle } from '../ai.js';
import { defaultTitle, folderLabel } from '../model.js';
import { T } from '../i18n.js';
import { correctText, optionsFromSettings, renderTextWithFixes } from '../correct.js';
import { LiveSpeakerTracker } from '../live-speaker.js';
import { runDiarization } from '../speakers.js';

/** folder 用作数据键（写入录音元数据），显示时再按当前语言取名 */
const SCENES = ['会议', '课堂', '访谈', '备忘'];

export function mountRecord(root, ctx) {
  root.innerHTML = `
    <div class="view rec">
      <header class="rec-top">
        <button class="chip-btn" data-act="scene">${icons.folder}<span id="sceneLabel">${folderLabel('会议')}</span></button>
        <button class="icon-btn accent" data-act="ai" aria-label="${T('rec.livePoints')}">${icons.sparkle}</button>
      </header>

      <div class="wave-wrap">
        <div class="ruler" id="ruler"></div>
        <canvas id="wave"></canvas>
        <div class="wave-badge" id="waveBadge"><i class="dot live"></i><span>REC</span></div>
        <div class="wave-meta" id="waveMeta">WEBM · 48kHz</div>
      </div>

      <div class="timer" id="timer">${timerHtml(0)}</div>
      <div class="live-spk" id="liveSpk"><i class="spk-dot c-mute"></i><span>${T('rec.speakerNone')}</span></div>

      <div class="rec-ctrls">
        <button class="round-ghost" data-act="mark" aria-label="${T('rec.mark')}">${icons.back15}</button>
        <button class="play-lg" data-act="pause" aria-label="${T('rec.pause')}">${icons.pause}</button>
        <button class="round-ghost" data-act="engine" aria-label="${T('rec.switchEngine')}">${icons.fwd15}</button>
      </div>

      <div class="live-panel" id="live">
        <div class="live-empty">${T('rec.waiting')}</div>
      </div>

      <div class="status-bar" id="statusBar"></div>

      <div class="rec-bottom">
        <button class="txt-btn" data-act="cancel">${T('rec.cancel')}</button>
        <button class="stop-btn" data-act="stop" aria-label="${T('rec.stop')}"><span></span></button>
        <button class="txt-btn" data-act="done">${T('rec.done')}</button>
      </div>
    </div>`;

  const canvas = $('#wave', root);
  const timerEl = $('#timer', root);
  const liveEl = $('#live', root);
  const statusBar = $('#statusBar', root);
  const rulerEl = $('#ruler', root);
  const waveMeta = $('#waveMeta', root);
  const waveBadge = $('#waveBadge', root);
  const sceneLabel = $('#sceneLabel', root);
  const stopBtn = $('.stop-btn', root);
  const pauseBtn = $('[data-act="pause"]', root);

  const recorder = new Recorder();
  let rec = null;
  let asr = null;
  let lines = [];        // { ms, text }
  let interimEl = null;
  let interimText = '';
  let lastEnd = 0;
  let engineMode = ctx.settings.engineMode || 'auto';
  let asrState = 'starting';
  let asrNote = '';
  let finished = false;
  let paused = false;
  let wakeLock = null;
  let rafId = 0;
  let heartbeat = 0;
  let timerTick = 0;
  let scene = SCENES[0];
  let saveError = '';
  let fixCount = 0;
  let fixOpts = optionsFromSettings(ctx.settings);
  let tracker = null;
  let liveIdx = null;

  /* ── 界面更新 ── */
  function winInfo() {
    const t = Math.max(recorder.elapsed, 0);
    const win = Math.max(6000, Math.min(14000, t / 0.72 || 6000));
    const start = Math.max(0, t - win * 0.72);
    return { t, win, start, end: start + win };
  }

  function paint() {
    const { t, win, end } = winInfo();
    timerEl.innerHTML = timerHtml(t);
    renderWave(canvas, recorder.levels, {
      progressMs: t,
      durationMs: Math.max(end, 1000),
      windowMs: win,
      dimAll: true,
    });
  }

  function updateRuler() {
    const { start, end } = winInfo();
    let html = '';
    for (let i = 0; i <= 6; i += 1) {
      const ms = start + ((end - start) * i) / 6;
      const pct = (i / 6) * 100;
      const align = i === 0 ? 'transform:none;' : (i === 6 ? 'transform:translateX(-100%);' : '');
      html += `<span style="left:${pct}%;${align}">${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}</span>`;
    }
    rulerEl.innerHTML = html;
  }

  function statusHtml() {
    const parts = [];
    const modeText = engineMode === 'local' ? T('rec.modeLocal') : engineMode === 'cloud' ? T('rec.modeCloud') : T('rec.modeAuto');
    parts.push(`${modeText}`);
    const stateMap = {
      listening: T('rec.stateListening'),
      starting: T('rec.stateStarting'),
      unsupported: T('rec.stateUnsupported'),
      denied: T('rec.stateDenied'),
      network: T('rec.stateNetwork'),
      unstable: T('rec.stateUnstable'),
      error: T('rec.stateError'),
      paused: T('rec.statePaused'),
    };
    parts.push(stateMap[asrState] || T('rec.stateListening'));
    if (!navigator.onLine) parts.push(T('rec.offline'));
    const segBytes = recorder.segments.reduce((n, x) => n + x.blob.size, 0);
    const bufBytes = (recorder._buffer || []).reduce((n, b) => n + b.size, 0);
    parts.push(T('rec.captured', { size: fmtBytes(segBytes + bufBytes), n: recorder.segments.length }));
    if (ctx.settings.autoCorrect !== false && fixCount > 0) parts.push(T('rec.fixes', { n: fixCount }));
    if (saveError) parts.push(saveError);
    return parts.map((p, i) => `${i ? '<i class="sep"></i>' : ''}<span>${esc(p)}</span>`).join('');
  }

  function setBadge(isPaused) {
    waveBadge.innerHTML = isPaused
      ? '<i class="dot warn"></i><span>PAUSED</span>'
      : '<i class="dot live"></i><span>REC</span>';
  }

  function paintStatus() {
    statusBar.innerHTML = statusHtml();
  }

  const liveSpk = $('#liveSpk', root);

  /** 实时发言人只是界面提示：编号为当前声音的临时序号，录音结束后由批量识别重新编号 */
  function paintLiveSpeaker(idx) {
    liveIdx = idx;
    if (!liveSpk) return;
    if (idx === null || idx === undefined) {
      liveSpk.className = 'live-spk';
      liveSpk.innerHTML = `<i class="spk-dot c-mute"></i><span>${T('rec.speakerNone')}</span>`;
      return;
    }
    liveSpk.className = 'live-spk is-live';
    liveSpk.innerHTML = `<i class="spk-dot c${idx % 6}"></i><span>${T('rec.liveSpeaker')} ${T('spk.liveShort', { n: idx + 1 })}</span>`;
  }

  function appendLine(ms, text, corrections = []) {
    const node = document.createElement('div');
    node.className = 'live-line';
    const dot = liveIdx === null
      ? '<i class="spk-dot c-mute"></i>'
      : `<i class="spk-dot c${liveIdx % 6}"></i>`;
    node.innerHTML = `${dot}<span class="t">${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}</span>${renderTextWithFixes(text, corrections)}`;
    if (liveEl.querySelector('.live-empty')) liveEl.innerHTML = '';
    if (interimEl) liveEl.insertBefore(node, interimEl); else liveEl.appendChild(node);
    liveEl.scrollTop = liveEl.scrollHeight;
  }

  function setInterim(text) {
    interimText = text;
    if (!text) {
      interimEl?.remove();
      interimEl = null;
      return;
    }
    if (!interimEl) {
      interimEl = document.createElement('div');
      interimEl.className = 'live-line interim';
      if (liveEl.querySelector('.live-empty')) liveEl.innerHTML = '';
      liveEl.appendChild(interimEl);
    }
    interimEl.textContent = text;
    liveEl.scrollTop = liveEl.scrollHeight;
  }

  /* ── 识别结果落库 ── */
  async function onFinal({ text, at }) {
    if (!rec) return;
    const { startMs, endMs } = estimateSpan(text, at, lastEnd);
    lastEnd = endMs;
    const fix = fixOpts.on ? correctText(text, fixOpts) : null;
    const shown = fix?.changed ? fix.text : text;
    try {
      await addTranscript({
        recordingId: rec.id,
        startMs,
        endMs,
        text: shown,
        engine: 'browser',
        status: 'final',
        raw: fix?.changed ? text : null,
        corrections: fix?.changed ? fix.corrections : null,
        corrected: fix?.changed ? 1 : 0,
      });
      lines.push({ ms: startMs, text: shown });
      appendLine(startMs, shown, fix?.corrections || []);
      fixCount += fix?.count || 0;
      setInterim('');
    } catch (err) {
      console.warn('保存转录失败', err);
      saveError = T('rec.saveTranscriptFailed');
      paintStatus();
    }
  }

  /* ── 启动 ── */
  async function boot() {
    // 先拿到麦克风，再落库，避免无权限时留下空记录
    try {
      await recorder.start();
    } catch (err) {
      renderError(err);
      return;
    }

    waveMeta.textContent = recorder.mime.includes('mp4') ? 'M4A · 44kHz' : 'WEBM · 48kHz';
    if (ctx.settings.soundEffect) ctx.beep?.('start');

    rec = await createRecording({
      title: defaultTitle(),
      scenario: scene,
      folder: scene,
      engineMode,
      engineUsed: 'browser',
      mime: recorder.mime,
      startedAt: Date.now(),
    });

    tracker = new LiveSpeakerTracker({ onChange: (idx) => paintLiveSpeaker(idx) });
    recorder.onFrame = (frame) => tracker.push(frame);
    paintLiveSpeaker(null);

    recorder.onSegment = async (seg) => {
      try {
        await addSegment({
          recordingId: rec.id,
          index: seg.index,
          startMs: seg.startMs,
          endMs: seg.endMs,
          blob: seg.blob,
          checksum: await sha256Short(seg.blob),
        });
        paintStatus();
      } catch (err) {
        console.warn('分段保存失败', err);
        saveError = T('rec.saveSegmentFailed');
        paintStatus();
      }
    };

    // 识别
    asr = createASR({
      lang: ctx.settings.lang === 'en-US' ? 'en-US' : 'zh-CN',
      getElapsed: () => Math.round(recorder.elapsed),
      onFinal,
      onInterim: ({ text }) => setInterim(text),
      onStatus: (s) => {
        asrState = s.state;
        if (s.state === 'network') asrNote = T('rec.networkDown');
        paintStatus();
      },
    });
    asrState = asr.supported ? 'listening' : 'unsupported';
    if (asr.supported) asr.start();
    paintStatus();

    // 循环
    const loop = () => {
      if (finished) return;
      paint();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    timerTick = setInterval(() => { if (!finished) updateRuler(); }, 400);

    heartbeat = setInterval(async () => {
      if (finished || !rec) return;
      try {
        await updateRecording(rec.id, {
          durationMs: Math.round(recorder.elapsed),
          size: recorder.segments.reduce((s, x) => s + x.blob.size, 0),
        });
      } catch { /* 忽略 */ }
      paintStatus();
    }, 4000);

    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 忽略 */ }
    }
    updateRuler();
  }

  function renderError(err) {
    const msg = err?.name === 'NotAllowedError'
      ? T('rec.micDenied')
      : err?.message || T('rec.startFailed');
    const wrap = $('.view', root);
    wrap.innerHTML = `
      <header class="rec-top">
        <button class="chip-btn" data-act="back">${icons.chevronLeft}<span>${T('common.back')}</span></button>
      </header>
      <div class="empty" style="flex:1">
        ${icons.mic}
        <h3>${T('rec.cantStartTitle')}</h3>
        <p>${esc(msg)}</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:18px">
          <button class="ghost accent" data-act="retry">${T('common.retry')}</button>
          <button class="ghost outline" data-act="back">${T('common.home')}</button>
        </div>
      </div>`;
    wrap.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'retry') { ctx.navigate('#/', { replace: true }); setTimeout(() => ctx.navigate('#/record'), 60); }
      if (a === 'back') ctx.navigate('#/', { replace: true });
    });
  }

  /* ── 收尾 ── */
  async function finish({ goto = 'doc', silent = false } = {}) {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    clearInterval(timerTick);
    cancelAnimationFrame(rafId);
    asr?.stop();
    try { await wakeLock?.release(); } catch { /* 忽略 */ }

    let result = null;
    try {
      result = await recorder.stop();
    } catch (err) {
      console.warn('停止录音失败', err);
    }
    if (!rec) { ctx.navigate('#/', { replace: true }); return; }

    const duration = result?.durationMs || Math.round(recorder.elapsed);
    const trs = await listTranscripts(rec.id);
    const autoTitle = suggestTitle(trs) || rec.title;
    const keepAudio = ctx.settings.saveRecording;

    await updateRecording(rec.id, {
      status: 'saved',
      hasTranscript: trs.length > 0,
      endedAt: Date.now(),
      durationMs: duration,
      audio: keepAudio ? result?.blob || null : null,
      size: keepAudio ? result?.blob?.size || 0 : 0,
      peaks: result?.peaks || [],
      mime: result?.mime || rec.mime,
      engineUsed: 'browser',
      title: autoTitle || defaultTitle(),
    });
    await clearSegments(rec.id);

    if (!silent) toast(keepAudio ? T('rec.saved') : T('rec.savedTextOnly'));

    if (ctx.settings.autoCopy && trs.length) {
      const text = trs.map((t) => t.text).join('\n');
      try { await navigator.clipboard.writeText(text); toast(T('rec.copied')); } catch { /* 忽略 */ }
    }
    if (ctx.settings.soundEffect) ctx.beep?.('stop');

    /* 说话人分离在保存完成之后才启动，且失败不影响录音（技术规范 11） */
    const wantDiar = ctx.settings.diarEnabled !== false && keepAudio && trs.length > 0;
    let diarTask = null;
    if (wantDiar) {
      if (goto === 'doc') showDiarOverlay();
      diarTask = runDiarization(rec.id, {
        settings: ctx.settings,
        onProgress: goto === 'doc' ? (p) => paintDiar(p) : () => {},
      }).catch(() => null);
    } else if (trs.length && !keepAudio) {
      toast(T('rec.diarSkipped'));
    }

    ctx.currentView?.refresh?.();
    if (goto === 'doc') {
      if (diarTask) {
        const res = await diarTask;
        if (res?.ok) toast(T('rec.diarDone', { n: res.speakerCount }));
        else toast(T('rec.diarFailed'));
      }
      ctx.navigate(`#/doc/${rec.id}`, { replace: true });
    } else if (goto === 'home') {
      if (diarTask) diarTask.then(() => ctx.currentView?.refresh?.());
      ctx.navigate('#/', { replace: true });
    }
  }

  /** 结束后的分析进度页：明确告诉用户正在做什么，不假装已完成 */
  function showDiarOverlay() {
    const wrap = $('.view', root);
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="diar-overlay">
        <div class="diar-ring" id="diarRing"><span id="diarPct">0%</span></div>
        <h3>${T('rec.diarRunning')}</h3>
        <p class="hint">${T('rec.speakerHint')}</p>
      </div>`;
  }

  function paintDiar(p) {
    const pct = Math.max(0, Math.min(100, Math.round((p || 0) * 100)));
    const label = $('#diarPct', root);
    if (label) label.textContent = `${pct}%`;
    const ring = $('#diarRing', root);
    if (ring) ring.style.setProperty('--p', String(pct));
  }

  async function cancel() {
    const ok = await confirmDialog({
      title: T('rec.abandonTitle'),
      message: T('rec.abandonMsg'),
      confirmText: T('rec.abandon'),
      danger: true,
    });
    if (!ok) return;
    finished = true;
    clearInterval(heartbeat);
    clearInterval(timerTick);
    cancelAnimationFrame(rafId);
    asr?.stop();
    recorder.abort();
    try { await wakeLock?.release(); } catch { /* 忽略 */ }
    if (rec) await purgeRecording(rec.id);
    ctx.navigate('#/', { replace: true });
  }

  /* ── 事件 ── */
  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;

    if (act === 'pause') {
      if (finished) return;
      if (paused) {
        recorder.resume();
        asr?.resume();
        paused = false;
        asrState = asr?.supported ? 'listening' : 'unsupported';
        pauseBtn.innerHTML = icons.pause;
        setBadge(false);
        toast(T('rec.resumed'));
      } else {
        recorder.pause();
        asr?.pause();
        paused = true;
        asrState = 'paused';
        pauseBtn.innerHTML = icons.play;
        setBadge(true);
        paintLiveSpeaker(null);
        toast(T('rec.paused'));
      }
      paintStatus();
      return;
    }

    if (act === 'mark') {
      if (finished) return;
      const ms = Math.round(recorder.elapsed);
      const marks = [...(rec.bookmarks || []), { ms, note: T('rec.mark') }];
      rec.bookmarks = marks;
      await updateRecording(rec.id, { bookmarks: marks });
      toast(T('rec.marked', { time: `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}` }));
      return;
    }

    if (act === 'engine') {
      const order = ['auto', 'local', 'cloud'];
      engineMode = order[(order.indexOf(engineMode) + 1) % order.length];
      await updateRecording(rec.id, { engineMode });
      toast(T('rec.engineSwitched', { name: engineMode === 'auto' ? T('engine.auto') : engineMode === 'local' ? T('engine.local') : T('engine.cloud') }));
      paintStatus();
      return;
    }

    if (act === 'scene') {
      const node = document.createElement('div');
      node.innerHTML = `<div class="sheet-actions">${SCENES.map((f) => `
        <button class="sheet-action" data-scene="${esc(f)}">${icons.folder}<span>${esc(folderLabel(f))}</span></button>`).join('')}</div>`;
      const close = openSheet({ title: T('rec.scene'), desc: T('rec.sceneDesc'), content: node });
      node.addEventListener('click', async (e2) => {
        const f = e2.target.closest('[data-scene]')?.dataset.scene;
        if (!f) return;
        scene = SCENES.includes(f) ? f : SCENES[0];
        sceneLabel.textContent = folderLabel(scene);
        if (rec) await updateRecording(rec.id, { folder: scene, scenario: scene });
        close();
      });
      return;
    }

    if (act === 'ai') {
      const trs = rec ? await listTranscripts(rec.id) : [];
      const a = analyze(trs);
      const content = `
        <div class="card" style="padding:14px">
          <div class="tk-head">${icons.sparkle}<span>${T('rec.pointsHead')}</span></div>
          ${a.takeaways.length ? `<ul class="tk-list">${a.takeaways.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul>` : `<p class="tk-empty">${T('rec.pointsEmpty')}</p>`}
          ${a.keywords.length ? `<div class="tk-chips">${a.keywords.map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</div>` : ''}
        </div>
        <p class="hint" style="margin-top:12px">${T('rec.pointsHint')}</p>`;
      openSheet({ title: T('rec.pointsTitle'), content });
      return;
    }

    if (act === 'stop') { await finish({ goto: 'home' }); return; }
    if (act === 'done') { await finish({ goto: 'doc' }); return; }
    if (act === 'cancel') { await cancel(); }
  });

  const beforeUnload = (e) => {
    if (finished) return;
    e.preventDefault();
    e.returnValue = T('rec.leaveWarn');
    return e.returnValue;
  };
  window.addEventListener('beforeunload', beforeUnload);

  boot();

  return {
    destroy() {
      window.removeEventListener('beforeunload', beforeUnload);
      if (!finished) {
        // 路由离开（浏览器后退等）：自动结束并保存，避免丢音频
        finish({ goto: 'none', silent: true });
      }    },
  };
}
