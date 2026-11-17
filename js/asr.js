/**
 * 浏览器实时语音识别封装（Web Speech API）
 * - 说明：这是 Web 原型可用的实时引擎，能力来自浏览器/系统提供的识别服务，
 *   与文档中 whisper.cpp（本地）和云端实时 API 属于不同实现，接口层保持可替换。
 */
export function createASR({ lang = 'zh-CN', getElapsed, onFinal, onInterim, onStatus, onLevel, idleMs = 20000, voiceThreshold = 0.15 }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  /* 最近一次「听到人声」的时刻，由录音器的电平喂进来。
     没有这个信号时，看门狗分不清「会话卡死」和「只是没人说话」，
     而后者一旦被当成卡死重开，正在说的那半句就被切掉了。 */
  let lastVoiceAt = 0;
  let voiceWired = false;
  let everResult = false;
  /* 连续「确实没人说话」而续命的次数，到上限就换一次会话，避免状态彻底坏死 */
  let idleHolds = 0;
  const IDLE_HOLDS_MAX = 6;
  /* 未提交的临时结果：会话被放弃前先落库，能救回正在说的半句 */
  let pendingInterim = '';
  const api = {
    supported: !!SR,
    active: false,
    paused: false,
    start,
    stop,
    pause,
    resume,
    destroy,
    /* 由录音器每 45ms 灌一次电平，给看门狗判断「现在是没人说话」还是「会话死了」 */
    voice(v) {
      voiceWired = true;
      if (Number.isFinite(v) && v >= voiceThreshold) lastVoiceAt = performance.now();
    },
  };

  if (!SR) {
    onStatus?.({ state: 'unsupported' });
    return api;
  }

  let recog = null;
  let restartTimer = null;
  let retryTimer = null;
  let networkDown = false;
  let rapidRestarts = 0;
  let lastStartAt = 0;
  let intentionalStop = false;
  /* 网络错误的自适应重试：首次 400ms 就重来（一次抖动不该让字幕空等 3 秒），
     连续失败再逐步退避，避免把服务打得更死 */
  const RETRY_DELAYS = [400, 900, 1800, 3000];
  let retryStep = 0;
  /* 看门狗：Chrome 的会话会「静默死亡」——不给 result、不给 error、也不给 end，
     界面一直显示「识别中」，实际早已不出字（长录音表现为只有开头一句）。
     一旦整个会话超过 idleMs 没有任何事件，就主动丢掉旧会话、重开一个。
     注意：本机实测首条结果最晚在 15.5s 才返回，阈值必须明显高于它，
     否则会在结果到来前把会话掐掉、永远出不了第一句。 */
  let idleTimer = null;
  /* 首条结果到来前用 idleMs（要容忍冷启动的十几秒），
     已经在出字之后只要短时间内没有新结果就可以认定会话卡死，阈值收紧 */
  const IDLE_BUSY_MS = Math.max(1500, Math.min(8000, Math.round(idleMs * 0.4)));

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** 每收到一次引擎事件就重新计时 */
  function armIdle(wait = idleMs) {
    clearIdle();
    if (intentionalStop || api.paused) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (intentionalStop || api.paused) return;
      /* 关键判断：这段时间到底有没有人说话。
         没人说话 → 会话只是闲着，重开零收益，反而会把下一句的开头切掉
         （长录音里就是「新开的一段开头缺一两个字」）。这种情况只续命，不重开。
         有人说话却没结果 → 这才是真的卡死，必须换会话。 */
      const quiet = performance.now() - lastVoiceAt;
      /* VAD 没接线、或从来没收到过高于阈值的电平，就不敢下结论，退回按时间重开 */
      const vdsLive = voiceWired && lastVoiceAt > 0;
      const nobodySpoke = vdsLive && quiet > 1200;
      if (everResult && nobodySpoke && idleHolds < IDLE_HOLDS_MAX) {
        idleHolds += 1;
        armIdle(wait);
        return;
      }
      idleHolds = 0;
      const old = recog;
      recog = null;                    // 先脱钩：旧会话的 onend 不再触发重启
      flushInterim();                  // 把没等到 final 的半句先落库，别跟着旧会话一起丢
      try { old?.abort?.() } catch { /* ignore */ }
      clearTimeout(restartTimer);
      networkDown = false;
      retryStep = 0;
      try { startOnce(); } catch { /* ignore */ }
    }, wait);
  }

  /** 会话被放弃前提交最后一条临时结果——宁可接一句毛边，也不要整句消失 */
  function flushInterim() {
    const t = String(pendingInterim || '').trim();
    pendingInterim = '';
    if (t.length < 2) return;
    onFinal?.({ text: t, confidence: null, at: getElapsed?.() ?? 0, partial: true });
  }

  /** 断网时的重连：不依赖 onend 的快速重启计数，改为带间隔的定时重试 */
  function scheduleRetry(delay) {
    const wait = delay ?? RETRY_DELAYS[Math.min(retryStep, RETRY_DELAYS.length - 1)];
    retryStep += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (intentionalStop || api.paused) return;
      if (navigator.onLine === false) { onStatus?.({ state: 'network', attempts: retryStep }); scheduleRetry(delay ?? 3000); return; }
      networkDown = false;
      rapidRestarts = 0;
      try { startOnce(); } catch { /* ignore */ }
    }, wait);
  }

  /** 网络恢复：立刻重连，不等下一次重试 */
  function handleOnline() {
    if (intentionalStop || api.paused || !api.supported) return;
    networkDown = false;
    rapidRestarts = 0;
    retryStep = 0;
    clearTimeout(retryTimer);
    try { startOnce(); } catch { /* ignore */ }
  }
  window.addEventListener('online', handleOnline);

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;

    r.onstart = () => {
      if (r !== recog) return;         // 已被看门狗/重连替换掉的旧会话，一律不响应
      api.active = true;
      rapidRestarts = 0;
      armIdle();
      onStatus?.({ state: 'listening' });
    };

    r.onresult = (event) => {
      if (r !== recog) return;
      retryStep = 0;   // 真的收到结果了，退避归零
      everResult = true;
      idleHolds = 0;
      armIdle(IDLE_BUSY_MS);   // 已经在出字：再沉默这么久就判定会话卡死
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const text = (res[0]?.transcript || '').trim();
        if (!text) continue;
        if (res.isFinal) {
          pendingInterim = '';
          onFinal?.({ text, confidence: res[0]?.confidence || null, at: getElapsed?.() ?? 0 });
        } else {
          interim += text;
        }
      }
      if (interim) {
        pendingInterim = interim;
        onInterim?.({ text: interim, at: getElapsed?.() ?? 0 });
      } else {
        onInterim?.({ text: '', at: getElapsed?.() ?? 0 });
      }
    };

    r.onerror = (e) => {
      if (r !== recog) return;
      const code = e.error || 'unknown';
      /* 静音超时、被外部打断：都不该让会话就此停摆 */
      if (code === 'no-speech') { armIdle(IDLE_BUSY_MS); return; }
      if (code === 'aborted') {
        if (!intentionalStop && !api.paused) scheduleRetry(300);
        return;
      }
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        onStatus?.({ state: 'denied' });
        api.active = false;
        intentionalStop = true;
        return;
      }
      if (code === 'network') {
        networkDown = true;
        clearIdle();
        onStatus?.({ state: 'network', attempts: retryStep });
        scheduleRetry();   // 自适应：400ms 起，连续失败再退避
        return;
      }
      /* 其他错误（音频设备、语言等）：不静默停摆，交给看门狗在 idleMs 后重开 */
      onStatus?.({ state: 'error', code });
      armIdle();
    };

    r.onend = () => {
      if (r !== recog) return;         // 旧会话的收尾不再驱动重启
      api.active = false;
      clearIdle();
      if (intentionalStop || api.paused) return;
      flushInterim();                  // 引擎自己收尾了，最后半句也别丢
      if (!api.supported) return;
      /* 断网导致的中断交给 scheduleRetry，避免快速重启计数把引擎永久停掉 */
      const now = performance.now();
      if (networkDown) { scheduleRetry(); return; }
      /* 这一轮活得够久说明服务是好的，退避归零，下次抖动可以立刻重连 */
      if (now - lastStartAt > 4000) retryStep = 0;
      rapidRestarts = now - lastStartAt < 900 ? rapidRestarts + 1 : 0;
      if (rapidRestarts > 6) {
        onStatus?.({ state: 'unstable' });
        scheduleRetry(8000);   // 不永久停掉：间隔重试，避免录音还在继续却没有识别
        return;
      }
      /* 30ms：onend 之后引擎已经释放，缝隙越短，正在说的字被切掉的越少。
         原来等 220ms，一段话换气正好落在空窗里，新段开头就缺字。 */
      restartTimer = setTimeout(() => {
        if (intentionalStop || api.paused) return;
        try { startOnce(); } catch { /* ignore */ }
      }, 30);
    };
    return r;
  }

  function startOnce() {
    lastStartAt = performance.now();
    recog = build();
    try {
      recog.start();
      armIdle();
    } catch (e) {
      onStatus?.({ state: 'error', code: String(e?.message || e) });
      /* 启动就被拒（设备被占用、实例状态异常）：别让它成为死路 */
      if (!intentionalStop && !api.paused) scheduleRetry(600);
    }
  }

  function start() {
    intentionalStop = false;
    api.paused = false;
    networkDown = false;
    rapidRestarts = 0;
    retryStep = 0;
    idleHolds = 0;
    clearIdle();
    clearTimeout(retryTimer);
    /* 先脱钩再停旧会话：否则它的事件会按「当前会话」处理，可能多开一个并行会话 */
    const old = recog;
    recog = null;
    flushInterim();
    if (old) { try { old.stop(); } catch { /* ignore */ } }
    startOnce();
  }

  function pause() {
    api.paused = true;
    clearIdle();
    clearTimeout(restartTimer);
    clearTimeout(retryTimer);
    flushInterim();
    try { recog?.stop(); } catch { /* ignore */ }
  }

  function resume() {
    if (!api.paused) return;
    api.paused = false;
    intentionalStop = false;
    networkDown = false;
    rapidRestarts = 0;
    startOnce();
  }

  function stop() {
    intentionalStop = true;
    api.paused = false;
    networkDown = false;
    clearIdle();
    clearTimeout(restartTimer);
    clearTimeout(retryTimer);
    flushInterim();          // 停之前把最后半句交出去
    try { recog?.stop(); } catch { /* ignore */ }
    recog = null;
    api.active = false;
  }

  function destroy() {
    stop();
    window.removeEventListener('online', handleOnline);
    onStatus = null;
  }

  return api;
}

/** 根据文本长度估算该段语音覆盖的时间区间（用于时间戳对齐） */
export function estimateSpan(text, elapsed, lastEnd) {
  const chars = (text || '').length;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (text.match(/\b[a-zA-Z]+\b/g) || []).length;
  let est = cjk * 210 + words * 340;
  est = Math.max(700, Math.min(15000, est || chars * 160));
  const end = Math.max(lastEnd + 200, elapsed);
  const start = Math.max(lastEnd, end - est);
  return { startMs: Math.round(start), endMs: Math.round(end) };
}
