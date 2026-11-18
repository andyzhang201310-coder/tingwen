import { $, $$, esc, fmtBytes, sha256Short } from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, confirmDialog, renderWave, timerHtml } from '../ui.js';
import {
  createRecording, updateRecording, addSegment, clearSegments,
  addTranscript, purgeRecording, listTranscripts, verifySegments,
} from '../store.js';
import { Recorder } from '../audio.js';
import { createLiveASR } from '../asr-live.js';
import { estimateSpan } from '../asr.js';
import { analyze, suggestTitle } from '../ai.js';
import { defaultTitle, folderLabel } from '../model.js';
import { T } from '../i18n.js';
import { correctText, optionsFromSettings, renderTextWithFixes } from '../correct.js';
import { LiveSpeakerTracker } from '../live-speaker.js';
import { runDiarization } from '../speakers.js';
import { mergeRanges, collectGaps, enqueueGaps } from '../repair.js';
import { startKeepAlive, updateKeepAlive, stopKeepAlive, onKeepAliveStop, isKeepAliveSupported } from '../keepalive.js';

/** folder 用作数据键（写入录音元数据），显示时再按当前语言取名 */
const SCENES = ['会议', '课堂', '访谈', '备忘'];

/** 实时识别由「浏览器厂商」的服务提供，失败原因和出路随浏览器不同：
    Chrome 走 Google，Edge 走微软；对 Edge 用户说「改用 Edge」是自相矛盾。 */
function speechHost() {
  const ua = navigator.userAgent || '';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return 'chrome';
  return 'other';
}

/** 网络错误持续多久才值得弹出解释（短暂抖动只让状态栏闪一下，不打断阅读） */
const NET_HINT_DELAY = 2200;

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

      <div class="asr-hint" id="asrHint" hidden></div>

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
  const hintEl = $('#asrHint', root);

  const recorder = new Recorder();
  let rec = null;
  let asr = null;
  let lines = [];        // { ms, text }
  let interimEl = null;
  let interimText = '';
  let lastEnd = 0;
  let engineMode = ctx.settings.engineMode || 'auto';
  let activeEngine = '';     // 实际生效的识别引擎：cloud | native | browser
  let asrState = 'starting';
  let lastErrCode = '';      // 最近一次识别引擎错误码，便于真机排查
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
  /* 识别中断窗口：断网 / 引擎异常期间录到的音频没有任何转录，记下来供补识别 */
  let downWindows = [];
  let openDown = null;
  /* 通知栏「停止录音」的取消订阅函数；页面离开时必须清掉，否则回到录音页会重复绑定 */
  let keepStopOff = null;
  let keepAliveOn = false;
  /* 存储余量与麦克风占用：两者都会导致「以为在录、实际没录」，必须在状态栏直说 */
  let storageWarn = '';       // '' | 'low' | 'critical'
  let storageFree = 0;
  let micBlocked = false;
  let muteTimer = 0;
  /* 录音被系统中断的原因（trackEnded / micBusy / recorderError），写入元信息供文稿页说明 */
  let interruptReason = '';

  /* ── 界面更新 ── */
  /** 通知栏文案用的 mm:ss */
  const mss = (ms) => {
    const t = Math.max(0, Math.round(ms));
    return `${String(Math.floor(t / 60000)).padStart(2, '0')}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}`;
  };

  /**
   * 存储余量检查（产品文档 5.4「空间不足时明确告警，不静默丢弃音频」/ 7.2 同一条）。
   * 用 navigator.storage.estimate 的 quota - usage：WebView 的配额本身会随磁盘剩余收缩，
   * 折算出来的余量能反映「还能录多久」，比直接问磁盘更接近实际可写空间。
   * 拿不到配额时静默跳过，不让一个可选提示把录音搞挂。
   */
  async function checkStorage() {
    try {
      if (!navigator.storage?.estimate) return;
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      if (!quota) return;
      const free = Math.max(0, quota - usage);
      storageFree = free;
      const MB = 1024 * 1024;
      const next = free < 30 * MB ? 'critical' : free < 120 * MB ? 'low' : '';
      if (next !== storageWarn) {
        storageWarn = next;
        if (next === 'critical') toast(T('rec.storageCritical', { size: fmtBytes(free) }));
        else if (next === 'low') toast(T('rec.storageLow', { size: fmtBytes(free) }));
        paintStatus();
      }
    } catch { /* 配额接口不可用时不影响录音 */ }
  }

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

  /** 当前未被识别覆盖的区间（识别中断窗口 + 结尾尾巴），录音页实时展示 */
  function liveGaps() {
    const t = Math.round(recorder.elapsed);
    const wins = downWindows.map((w) => ({ ...w }));
    if (openDown && asrState !== 'paused') wins.push({ startMs: openDown.startMs, endMs: t });
    if (t - lastEnd > 5000) wins.push({ startMs: Math.max(lastEnd, 0), endMs: t });
    return mergeRanges(wins).filter((g) => g.endMs - g.startMs > 1200);
  }

  function statusHtml() {
    const parts = [];
    /* 存储和麦克风状态放在最前面：它们决定「这段录音到底有没有录上」 */
    if (storageWarn) {
      parts.push(`<b class="warn">${esc(T(storageWarn === 'critical' ? 'rec.storageCritical' : 'rec.storageLow', { size: fmtBytes(storageFree) }))}</b>`);
    }
    if (micBlocked) parts.push(`<b class="warn">${esc(T('rec.intrMute'))}</b>`);
    const modeText = engineMode === 'local' ? T('rec.modeLocal') : engineMode === 'cloud' ? T('rec.modeCloud') : T('rec.modeAuto');
    parts.push(esc(modeText));
    const ENG_LABEL = { sdk: T('rec.engineSdkLive'), cloud: T('rec.engineCloudLive'), native: T('rec.engineNativeLive'), browser: T('rec.engineBrowserLive') };
    if (activeEngine && ENG_LABEL[activeEngine]) parts.push(esc(ENG_LABEL[activeEngine]));
    const stateMap = {
      listening: T('rec.stateListening'),
      starting: T('rec.stateStarting'),
      unsupported: T('rec.stateUnsupported'),
      denied: T('rec.stateDenied'),
      network: T('rec.stateNetwork'),
      unstable: T('rec.stateUnstable'),
      error: T('rec.stateError'),
      paused: T('rec.statePaused'),
      switch: T('rec.stateSwitch'),
    };
    parts.push(esc(stateMap[asrState] || T('rec.stateListening')));
    if ((asrState === 'error' || asrState === 'network') && lastErrCode) {
      parts.push(esc(T('rec.errCode', { code: lastErrCode })));
    }
    if (!navigator.onLine) parts.push(esc(T('rec.offline')));
    const segBytes = recorder.segments.reduce((n, x) => n + x.blob.size, 0);
    const bufBytes = (recorder._buffer || []).reduce((n, b) => n + b.size, 0);
    parts.push(esc(T('rec.captured', { size: fmtBytes(segBytes + bufBytes), n: recorder.segments.length })));
    if (ctx.settings.autoCorrect !== false && fixCount > 0) parts.push(esc(T('rec.fixes', { n: fixCount })));
    /* 积压：有多少段音频没有对应文字（产品文档 2.1「显示积压或待处理状态」） */
    const gaps = liveGaps();
    if (gaps.length) {
      const ms = gaps.reduce((n, g) => n + (g.endMs - g.startMs), 0);
      const dur = `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
      parts.push(`<b class="warn">${esc(T('rec.pendingSum', { n: gaps.length, dur }))}</b>`);
    }
    if (saveError) parts.push(esc(saveError));
    return parts.map((p, i) => `${i ? '<i class="sep"></i>' : ''}<span>${p}</span>`).join('');
  }

  function setBadge(isPaused) {
    waveBadge.innerHTML = isPaused
      ? '<i class="dot warn"></i><span>PAUSED</span>'
      : '<i class="dot live"></i><span>REC</span>';
  }

  function paintStatus() {
    statusBar.innerHTML = statusHtml();
  }

  /* 识别不出文字时，把原因说清楚——沉默的空面板是最难自查的失败 */
  const ASR_HINTS = {
    network: ['rec.hintNetTitle', 'rec.hintNetBody'],
    unsupported: ['rec.hintUnsupportedTitle', 'rec.hintUnsupportedBody'],
    denied: ['rec.hintDeniedTitle', 'rec.hintDeniedBody'],
    error: ['rec.hintErrorTitle', 'rec.hintErrorBody'],
    unstable: ['rec.hintUnstableTitle', 'rec.hintUnstableBody'],
  };

  /* 网络类提示先按「当前引擎」分流，只有浏览器引擎才按 UA 细分为 Chrome / Edge。
     之前一律按 UA 分流，导致跑百炼云引擎时也弹「Chrome 走 Google」，文不对题。 */
  const NET_BODY = {
    chrome: 'rec.hintNetBody',
    edge: 'rec.hintNetBodyEdge',
    other: 'rec.hintNetBodyGeneric',
  };
  const NET_BY_ENGINE = {
    cloud: ['rec.hintNetTitleCloud', 'rec.hintNetBodyCloud'],
    native: ['rec.hintNetTitleNative', 'rec.hintNetBodyNative'],
  };

  let netDownAt = 0;        // 本轮网络错误第一次出现的时刻
  let netAttempts = 0;      // 已失败的重试次数（asr 传入）
  let netHintTimer = null;

  function clearNetHintTimer() {
    clearTimeout(netHintTimer);
    netHintTimer = null;
  }

  /** 到达 NET_HINT_DELAY 时再重画一次，让持续失败自己「长出来」 */
  function armNetHint() {
    clearNetHintTimer();
    if (!netDownAt) return;
    const left = NET_HINT_DELAY - (Date.now() - netDownAt);
    if (left <= 0) return;
    netHintTimer = setTimeout(() => {
      netHintTimer = null;
      paintAsrHint();
    }, left);
  }

  function paintAsrHint() {
    if (!hintEl) return;
    let h = finished ? null : ASR_HINTS[asrState];
    if (h === ASR_HINTS.network) {
      /* 一次抖动就弹整块解释会打断阅读：至少持续 2.2 秒，或重试已连续失败 2 次，才算「真的连不上」 */
      const sustained = netAttempts >= 2 || Date.now() - netDownAt >= NET_HINT_DELAY;
      if (!sustained) h = null;
      else if (NET_BY_ENGINE[activeEngine]) h = NET_BY_ENGINE[activeEngine];
      else h = [h[0], NET_BODY[speechHost()] || NET_BODY.chrome];
    }
    /* 引擎说「在听」但一帧 PCM 都没采到：实时识别必然不出字。
       这里主动提示，避免界面一直停在「识别中」让人误以为在等语音。 */
    if (!h && !finished && asrState === 'listening'
        && (activeEngine === 'sdk' || activeEngine === 'cloud')
        && recorder.elapsed > 5000 && !recorder.pcmFrames) {
      h = ['rec.hintNoPcmTitle', 'rec.hintNoPcmBody'];
    }
    if (!h) {
      hintEl.hidden = true;
      hintEl.innerHTML = '';
      return;
    }
    hintEl.hidden = false;
    hintEl.innerHTML = `<b>${esc(T(h[0]))}</b><span>${esc(T(h[1]))}</span>`;
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
  /** 一句定稿：纠错 → 入库 → 上屏。任何一步失败都要在状态栏说出来，
      不能出现「界面有字、库里没字」这种最难自查的状态。 */
  async function commitText(text, at) {
    if (!rec) return false;
    const clean = String(text || '').trim();
    if (!clean) return false;
    /* 引擎在 stop 时会把最后一句重发一次：相邻重复不再入库，避免文稿出现两遍 */
    const prev = lines[lines.length - 1];
    if (prev && prev.text === clean) { setInterim(''); return false; }

    const { startMs, endMs } = estimateSpan(clean, at, lastEnd);
    /* 状态一直显示 listening 但长时间没有结果时，也把这段算作缺口 */
    if (openDown && startMs - openDown.startMs > 1200) {
      downWindows.push({ startMs: openDown.startMs, endMs: startMs });
      openDown = null;
    }
    lastEnd = endMs;
    const fix = fixOpts.on ? correctText(clean, fixOpts) : null;
    const shown = fix?.changed ? fix.text : clean;
    try {
      await addTranscript({
        recordingId: rec.id,
        startMs,
        endMs,
        text: shown,
        engine: 'browser',
        status: 'final',
        raw: fix?.changed ? clean : null,
        corrections: fix?.changed ? fix.corrections : null,
        corrected: fix?.changed ? 1 : 0,
      });
      lines.push({ ms: startMs, text: shown });
      appendLine(startMs, shown, fix?.corrections || []);
      fixCount += fix?.count || 0;
      setInterim('');
      return true;
    } catch (err) {
      console.warn('保存转录失败', err);
      saveError = T('rec.saveTranscriptFailed');
      paintStatus();
      return false;
    }
  }

  function onFinal({ text, at }) {
    commitText(text, at).catch((err) => {
      console.warn('转录入库异常', err);
      saveError = T('rec.saveTranscriptFailed');
      paintStatus();
    });
  }

  /** 收尾：引擎最后那句若只有临时结果、始终没等到定稿，按已显示的字补存一条 */
  async function flushInterim() {
    const text = String(interimText || '').trim();
    if (!text) return;
    await commitText(text, Math.round(recorder.elapsed));
  }

  /* 识别不可用的状态：这些区间里录到的音频没有任何转录，记成待补识别 */
  const DOWN_STATES = ['network', 'error', 'unstable', 'unsupported', 'denied'];

  function trackDown(state) {
    if (paused) return;
    if (DOWN_STATES.includes(state)) {
      if (!openDown) openDown = { startMs: Math.round(recorder.elapsed) };
    } else if (state === 'listening' && openDown) {
      downWindows.push({ startMs: openDown.startMs, endMs: Math.round(recorder.elapsed) });
      openDown = null;
    }
  }

  function closeDownWindow() {
    if (!openDown) return;
    downWindows.push({ startMs: openDown.startMs, endMs: Math.round(recorder.elapsed) });
    openDown = null;
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

    // 识别：统一适配层按设置与平台选择 云端流式 / 原生系统 / Web Speech API
    asr = createLiveASR({
      settings: ctx.settings,
      getElapsed: () => Math.round(recorder.elapsed),
      onFinal,
      onInterim: ({ text }) => setInterim(text),
      onStatus: (s) => {
        if (s.engine && s.engine !== activeEngine) activeEngine = s.engine;
        if (s.state === 'network') {
          if (!netDownAt) netDownAt = Date.now();
          netAttempts = s.attempts || 0;
          armNetHint();
        } else {
          netDownAt = 0;
          netAttempts = 0;
          clearNetHintTimer();
        }
        asrState = s.state;
        if (s.state === 'error' || s.state === 'network' || s.state === 'unsupported' || s.state === 'denied') {
          lastErrCode = s.code ? String(s.code) : '';
        } else if (s.state === 'listening' || s.state === 'switch') {
          lastErrCode = '';
        }
        trackDown(s.state);
        paintStatus();
        paintAsrHint();
      },
    });
    asrState = asr.supported ? 'starting' : 'unsupported';
    /* PCM 帧推给云端流式引擎；浏览器/原生引擎的 feed 是空操作，无副作用 */
    recorder.onPcm = (pcm) => { if (!paused) asr?.feed?.(pcm); };
    /* 电平喂给识别层：Web Speech API 引擎用它判断「没人说话」还是「会话卡死」 */
    recorder.onLevel = (t, v) => asr?.voice?.(v);

    /* ── 麦克风被系统打断（产品文档 7.2「录音被系统中断」）──
       硬中断（轨道 ended）：编码链路已断，继续挂着只会让用户以为还在录，
       立刻按「完成」的同一套流程收尾，已录内容一定落盘。
       软占用（mute）：多为来电/语音助手短暂抢占，给 10 秒恢复窗口，拿不回来再收尾。 */
    recorder.onTrackEnded = (reason) => {
      if (finished) return;
      interruptReason = reason || 'trackEnded';
      closeDownWindow();
      toast(T('rec.intrEnded'));
      finish({ goto: 'doc', silent: true });
    };
    recorder.onMute = () => {
      if (finished) return;
      micBlocked = true;
      paintStatus();
      clearTimeout(muteTimer);
      muteTimer = setTimeout(() => {
        if (finished || !micBlocked) return;
        interruptReason = 'micBusy';
        closeDownWindow();
        toast(T('rec.intrMuteLost'));
        finish({ goto: 'doc', silent: true });
      }, 10000);
    };
    recorder.onUnmute = () => {
      micBlocked = false;
      clearTimeout(muteTimer);
      paintStatus();
    };
    checkStorage();

    if (asr.supported) asr.start();
    paintStatus();
    paintAsrHint();

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
      /* 每 4 秒顺带查一次存储余量：30 秒一段、一路写下去，等真写满再报就晚了 */
      checkStorage();
      /* 通知栏同步时长与已落盘段数：锁屏时用户看不到界面，只能看通知 */
      if (keepAliveOn) {
        updateKeepAlive({
          title: rec.title,
          text: T('rec.keepAliveText', { time: mss(recorder.elapsed), n: recorder.segments.length }),
        });
      }
      paintStatus();
      paintAsrHint();
    }, 4000);

    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 忽略 */ }
    }

    /* 前台服务：锁屏 / 切后台时把进程钉在前台优先级，30 秒分段的落盘回调才不会被冻住。
       网页端没有这个插件，startKeepAlive 直接返回 unsupported，录音不受影响。 */
    const ka = await startKeepAlive({
      title: rec?.title || T('rec.keepAliveTitle'),
      text: T('rec.keepAliveText', { time: mss(0), n: 0 }),
    }).catch(() => ({ running: false }));
    keepAliveOn = ka?.running === true;
    if (keepAliveOn) {
      /* 服务起来了但通知被系统隐藏时，锁屏后就没有「停止录音」入口，
         必须明说，否则用户只能等录音自己结束 */
      if (ka.notif === false) toast(T('rec.notifOff'));
      keepStopOff = onKeepAliveStop(() => {
        /* 通知栏点「停止录音」→ 走与「完成」完全相同的收尾，
           保证分段校验、尾句补存、缺口入队都执行到 */
        if (!finished) finish();
      });
    } else if (isKeepAliveSupported()) {
      /* 插件在但服务没起来：录音仍可进行，只是锁屏后可能被系统冻结 */
      toast(T('rec.bgOff'));
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
    clearNetHintTimer();
    paintAsrHint();
    clearInterval(heartbeat);
    clearInterval(timerTick);
    cancelAnimationFrame(rafId);
    closeDownWindow();

    /* 顺序很关键：先停采集（不再有 PCM 进来）→ 让引擎收尾（finish-task 会把最后一句定稿）
       → 等收尾结果回来 → 补存还没定稿的那句 → 最后才拆监听。
       原来的顺序是先 destroy 再 stop 录音，最后一次定稿必然被丢掉。 */
    let result = null;
    try {
      result = await recorder.stop();
    } catch (err) {
      console.warn('停止录音失败', err);
    }
    try { await asr?.stop?.(); } catch { /* 忽略 */ }
    if (activeEngine === 'sdk' || activeEngine === 'cloud') {
      /* 云端/直连引擎的尾句要等服务端回包，给一个收尾窗口 */
      await new Promise((r) => setTimeout(r, 900));
    }
    try { await flushInterim(); } catch { /* 忽略 */ }
    asr?.destroy();
    try { await wakeLock?.release(); } catch { /* 忽略 */ }
    /* 音频已停、分段已合并成 blob，剩下的只是写库，这时才撤前台服务 */
    await stopKeepAlive();
    keepStopOff?.();
    keepStopOff = null;
    keepAliveOn = false;
    if (!rec) { ctx.navigate('#/', { replace: true }); return; }

    const duration = result?.durationMs || Math.round(recorder.elapsed);
    const trs = await listTranscripts(rec.id);
    const autoTitle = suggestTitle(trs) || rec.title;
    const keepAudio = ctx.settings.saveRecording;

    /* 分段完整性自检：重算校验和 + 时间轴连续性（产品文档 8.2） */
    const integrity = await verifySegments(rec.id).catch(() => null);
    /* 未识别区间：识别中断窗口 + 结尾尾巴，去掉已被文字覆盖的部分 */
    const gaps = collectGaps({ windows: downWindows, transcripts: trs, durationMs: duration });

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
      integrity: integrity
        ? { segments: integrity.total, ok: integrity.ok, bad: integrity.bad.length, holes: integrity.holes.length }
        : null,
      pending: { count: gaps.length, totalMs: gaps.reduce((n, g) => n + (g.endMs - g.startMs), 0) },
      /* 被系统中断而结束的录音要留痕：否则用户只看到「时长比预期短」，不知道发生了什么 */
      interrupted: interruptReason || null,
    });
    if (gaps.length && keepAudio) await enqueueGaps(rec.id, gaps);
    await clearSegments(rec.id);

    if (!silent) toast(keepAudio ? T('rec.saved') : T('rec.savedTextOnly'));
    if (integrity && !integrity.ok) {
      toast(T('rec.integrityBad', { bad: integrity.bad.length, holes: integrity.holes.length }));
    } else if (gaps.length && keepAudio) {
      toast(T('rec.pendingTip', { n: gaps.length }));
    }

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
    asr?.destroy();
    recorder.abort();
    try { await wakeLock?.release(); } catch { /* 忽略 */ }
    await stopKeepAlive();
    keepStopOff?.();
    keepStopOff = null;
    keepAliveOn = false;
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
        asrState = asr?.active ? 'listening' : 'starting';
        pauseBtn.innerHTML = icons.pause;
        setBadge(false);
        toast(T('rec.resumed'));
      } else {
        recorder.pause();
        asr?.pause();
        paused = true;
        asrState = 'paused';
        closeDownWindow();   // 暂停期间不录音，这段不算缺口
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

  /* 网络状态变化要立刻反映到状态栏，否则断网恢复后仍显示旧状态 */
  const onNet = () => { if (!finished) paintStatus(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  boot();

  return {
    destroy() {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
      keepStopOff?.();
      keepStopOff = null;
      if (!finished) {
        // 路由离开（浏览器后退等）：自动结束并保存，避免丢音频
        finish({ goto: 'none', silent: true });
      }
      /* finish 里已停过服务；这里再兜一次，防止 finish 因异常提前返回后通知一直挂着 */
      stopKeepAlive();
    },
  };
}
