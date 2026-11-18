import { $, $$, esc, fmtDate, fmtDur, dateGroupLabel, debounce, fmtBytes, sameDay } from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, confirmDialog, swallowNextClick } from '../ui.js';
import {
  listRecordings, createRecording, updateRecording, softDeleteRecording,
  purgeRecording, listSegments, clearSegments, verifySegments, db,
} from '../store.js';
import { peaksFromFile } from '../audio.js';
import { statusOf, defaultTitle, folderLabel } from '../model.js';
import { T, isEn } from '../i18n.js';

export function mountHome(root, ctx) {
  root.innerHTML = `
    <div class="view home">
      <header class="home-head">
        <div class="home-top">
          <h1 class="app-title">${isEn() ? 'TingWen' : '听文'}<span class="app-title-en ${isEn() ? 'is-zh' : ''}">${isEn() ? '听文' : 'TINGWEN'}</span></h1>
          <button class="icon-btn accent" data-act="settings" aria-label="${T('home.settings')}">${icons.gear}</button>
        </div>
        <div class="searchbar">
          ${icons.search}
          <input id="q" type="search" placeholder="${T('home.searchPlaceholder')}" autocomplete="off" />
          <button class="icon-btn" data-act="voice-search" aria-label="${T('home.voiceSearch')}" style="width:28px;height:28px">${icons.mic}</button>
        </div>
        <nav class="tabs">
          <button class="tab active" data-tab="all">${T('home.tabAll')}</button>
          <button class="tab" data-tab="folders">${T('home.tabFolders')}</button>
          <button class="tab" data-tab="import-audio">${T('home.tabImportAudio')}</button>
          <button class="tab" data-tab="import-voice">${T('home.tabImportVoice')}</button>
        </nav>
      </header>
      <div class="scroll" id="homeScroll">
        <div id="banner"></div>
        <div class="list" id="listWrap"></div>
      </div>
      <div class="fab-wrap" id="fab">
        <div class="fab-item">
          <button class="fab-btn" data-act="import" aria-label="${T('home.importAudio')}">${icons.folder}</button>
        </div>
        <div class="fab-item">
          <button class="fab-btn" data-act="record" aria-label="${T('home.startRecording')}">${icons.mic}</button>
        </div>
        <button class="fab-btn main" data-act="fab-toggle" aria-label="${T('home.new')}">${icons.plus}</button>
      </div>
      <input type="file" id="filePicker" accept="audio/*" multiple hidden />
    </div>`;

  const view = $('.view', root);
  const listWrap = $('#listWrap', root);
  const banner = $('#banner', root);
  const qInput = $('#q', root);
  const picker = $('#filePicker', root);
  const fab = $('#fab', root);

  let all = [];
  let index = new Map();
  let query = '';
  let tab = 'all';
  let folder = null;
  let playingId = null;

  /* ── 数据 ── */
  async function load() {
    all = await listRecordings();
    index = new Map();
    try {
      const trs = await db.all('transcripts');
      trs.forEach((t) => {
        index.set(t.recordingId, `${index.get(t.recordingId) || ''} ${t.text}`.trim());
      });
    } catch { /* 忽略 */ }
  }

  function filtered() {
    let list = all;
    if (!ctx.settings.showHistory) {
      list = list.filter((r) => r.status === 'recording' || sameDay(r.startedAt, Date.now()));
    }
    if (folder) list = list.filter((r) => (r.folder || '默认') === folder);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((r) => {
        const hay = `${r.title} ${r.folder || ''} ${r.scenario || ''} ${index.get(r.id) || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }

  /* ── 渲染 ── */
  function rowHtml(r) {
    const st = statusOf(r);
    const sub = r.subtitle || st.text;
    const active = playingId === r.id && ctx.player.playing;
    return `
      <div class="row rec-row" data-id="${r.id}">
        <button class="row-play ${active ? 'is-playing' : ''}" data-act="play" data-id="${r.id}" aria-label="${T('common.play')}">
          ${active ? icons.pause : icons.play}
        </button>
        <div class="row-main">
          <div class="row-title">${esc(r.title)}</div>
          <div class="row-sub"><i class="dot ${st.dot}"></i><span class="status-text">${esc(sub)}</span></div>
        </div>
        <div class="row-meta">
          <span class="row-dur">${fmtDur(r.durationMs)}</span>
          <span class="row-date">${fmtDate(r.startedAt)}</span>
        </div>
      </div>`;
  }

  function emptyHtml() {
    const searching = !!query;
    return `
      <div class="empty">
        ${icons.waveform}
        <h3>${searching ? T('home.emptySearchTitle') : T('home.emptyTitle')}</h3>
        <p>${searching ? T('home.emptySearchDesc') : T('home.emptyDesc')}</p>
        ${searching ? '' : `<div style="display:flex;gap:10px;justify-content:center;margin-top:18px">
          <button class="ghost accent" data-act="record">${T('home.startRecording')}</button>
          <button class="ghost outline" data-act="demo">${T('home.loadDemo')}</button>
        </div>`}
      </div>`;
  }

  function render() {
    const list = filtered();
    if (!list.length) {
      listWrap.innerHTML = emptyHtml();
      return;
    }
    if (tab === 'folders' && !folder) {
      const map = new Map();
      list.forEach((r) => {
        const k = r.folder || '默认';
        map.set(k, [...(map.get(k) || []), r]);
      });
      listWrap.innerHTML = [...map.entries()].map(([name, recs]) => `
        <div class="list-date-label">${esc(T('home.folderMeta', { name: folderLabel(name), n: recs.length }))}</div>
        ${recs.map(rowHtml).join('')}
      `).join('');
      return;
    }
    const groups = new Map();
    list.forEach((r) => {
      const k = dateGroupLabel(r.startedAt);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    listWrap.innerHTML = [...groups.entries()].map(([label, recs]) => `
      <div class="list-date-label">${esc(label)}</div>
      ${recs.map(rowHtml).join('')}
    `).join('');
  }

  /* ── 恢复提示 ── */
  async function checkRecovery() {
    banner.innerHTML = '';
    const pend = all.filter((r) => r.status === 'recording');
    for (const r of pend) {
      const segs = await listSegments(r.id);
      if (!segs.length) continue;
      const node = document.createElement('div');
      node.className = 'recover-banner';
      node.innerHTML = `
        <div style="flex:1">
          <h4>${T('home.recoverTitle')}</h4>
          <p>${esc(T('home.recoverDesc', {
            date: fmtDate(r.startedAt),
            n: segs.length,
            size: fmtBytes(segs.reduce((s, x) => s + (x.size || 0), 0)),
          }))}</p>
          <div class="acts">
            <button class="ghost accent" data-act="recover" data-id="${r.id}">${T('home.recover')}</button>
            <button class="ghost outline" data-act="discard" data-id="${r.id}">${T('home.discard')}</button>
          </div>
        </div>`;
      banner.appendChild(node);
    }
  }

  /* ── 播放 ── */
  function togglePlay(id) {
    const rec = all.find((r) => r.id === id);
    if (!rec) return;
    if (!rec.audio) {
      toast(T('home.noAudio'));
      return;
    }
    /* 同一条录音：暂停和继续都在原地。原来这里无条件 load + seek(0)，
       于是「暂停一下再点播放」每次都从头开始；只有播完（ended）或换一条才回到 0。 */
    if (ctx.player.isLoaded(id)) {
      if (ctx.player.playing) {
        ctx.player.pause();
        return;
      }
      if (ctx.player.ended) ctx.player.seek(0);
      playingId = id;
      ctx.player.play();
      render();
      return;
    }
    ctx.player.load(rec.audio, rec.id);
    ctx.player.seek(0);
    ctx.player.play();
    playingId = id;
    render();
  }

  /* ── 导入 ── */
  async function importFiles(files) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      try {
        toast(T('home.parsing', { name: file.name }));
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        const duration = await new Promise((resolve) => {
          audio.onloadedmetadata = () => resolve((audio.duration || 0) * 1000);
          audio.onerror = () => resolve(0);
          audio.src = url;
          setTimeout(() => resolve((audio.duration || 0) * 1000), 4000);
        });
        URL.revokeObjectURL(url);
        let peaks = [];
        try { peaks = await peaksFromFile(file); } catch { /* 波形不可用 */ }
        await createRecording({
          title: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || defaultTitle(),
          scenario: '导入',
          folder: '导入',
          status: 'imported',
          durationMs: duration,
          audio: file,
          size: file.size,
          peaks,
          mime: file.type || 'audio/mpeg',
          engineUsed: 'none',
        });
      } catch (err) {
        console.error(err);
        toast(T('home.importFailed', { msg: err.message }));
      }
    }
    toast(T('home.importDone'));
    await load();
    render();
    await checkRecovery();
  }

  /* ── 语音搜索 ── */
  function voiceSearch() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast(T('home.voiceUnsupported')); return; }
    const r = new SR();
    r.lang = ctx.settings.lang === 'en-US' ? 'en-US' : 'zh-CN';
    r.interimResults = false;
    r.maxAlternatives = 1;
    toast(T('home.voiceHint'));
    r.onresult = (e) => {
      const text = e.results[0][0].transcript;
      qInput.value = text;
      query = text.trim();
      render();
    };
    r.onerror = () => toast(T('home.voiceFailed'));
    try { r.start(); } catch { toast(T('home.voiceUnavailable')); }
  }

  /* ── 事件 ── */
  root.addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-act]');
    const row = e.target.closest('.rec-row');
    if (actEl) {
      const act = actEl.dataset.act;
      if (act === 'settings') { ctx.navigate('#/settings'); return; }
      if (act === 'voice-search') { voiceSearch(); return; }
      if (act === 'fab-toggle') {
        fab.classList.toggle('open');
        return;
      }
      if (act === 'record') {
        fab.classList.remove('open');
        ctx.startRecording();
        return;
      }
      if (act === 'import') {
        fab.classList.remove('open');
        if (ctx.settings.importAudio === false) { toast(T('home.importDisabled')); return; }
        picker.click();
        return;
      }
      if (act === 'demo') { await ctx.loadDemo(); await refresh(); return; }
      if (act === 'play') {
        e.stopPropagation();
        togglePlay(actEl.dataset.id);
        return;
      }
      if (act === 'recover') {
        await recover(actEl.dataset.id);
        return;
      }
      if (act === 'discard') {
        const ok = await confirmDialog({ title: T('home.discardTitle'), message: T('home.discardMsg'), confirmText: T('home.discard'), danger: true });
        if (ok) {
          await purgeRecording(actEl.dataset.id);
          toast(T('home.discarded'));
          await refresh();
        }
        return;
      }
    }
    if (row) {
      ctx.navigate(`#/doc/${row.dataset.id}`);
      return;
    }
    if (!e.target.closest('.fab-wrap')) fab.classList.remove('open');
  });

  // 长按删除
  let pressTimer = null;
  let pressId = null;
  let pressFired = false;

  root.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.rec-row');
    if (!row) return;
    pressId = row.dataset.id;
    pressFired = false;
    pressTimer = setTimeout(async () => {
      pressTimer = null;
      pressFired = true;
      const rec = all.find((r) => r.id === pressId);
      if (!rec) return;
      openSheet({
        title: rec.title,
        desc: `${fmtDate(rec.startedAt)} · ${T('common.duration')} ${fmtDur(rec.durationMs)} · ${fmtBytes(rec.size || rec.audio?.size || 0)}`,
        actions: [
          { label: T('common.rename'), icon: 'edit', onClick: () => rename(rec.id) },
          { label: rec.favorite ? T('home.removeFavorite') : T('home.addFavorite'), icon: 'heart', onClick: async () => { await updateRecording(rec.id, { favorite: !rec.favorite }); await refresh(); } },
          { label: T('home.exportAudio'), icon: 'download', onClick: () => {
            if (!rec.audio) { toast(T('home.noAudio')); return; }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(rec.audio);
            a.download = `${rec.title}.webm`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          } },
          { label: T('common.delete'), icon: 'trash', danger: true, onClick: async () => {
            const ok = await confirmDialog({ title: T('home.deleteTitle'), message: T('home.deleteMsg'), confirmText: T('common.delete'), danger: true });
            if (ok) { await softDeleteRecording(rec.id); toast(T('home.movedToTrash')); await refresh(); }
          } },
        ],
      });
    }, 520);
  });
  root.addEventListener('pointerup', () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (pressFired) { pressFired = false; swallowNextClick(); }
  });
  ['pointercancel', 'pointermove'].forEach((ev) => {
    root.addEventListener(ev, () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (ev === 'pointercancel') pressFired = false;
    });
  });

  async function rename(id) {
    const rec = all.find((r) => r.id === id);
    if (!rec) return;
    const input = document.createElement('div');
    input.innerHTML = `
      <input id="renameInput" class="doc-search" style="height:44px;margin:8px 0 0;width:100%" value="${esc(rec.title)}" />
      <button class="btn-primary" id="renameOk" style="margin-top:14px">${T('common.saveName')}</button>`;
    const close = openSheet({ title: T('common.rename'), content: input });
    $('#renameOk', input).addEventListener('click', async () => {
      const val = $('#renameInput', input).value.trim();
      if (!val) return;
      await updateRecording(id, { title: val });
      close();
      await refresh();
    });
  }

  async function recover(id) {
    const segs = await listSegments(id);
    if (!segs.length) { toast(T('home.noSegments')); return; }
    /* 先自检再拼装：校验和不符或时间轴断裂时明确告知，不假装恢复成功（产品文档 8.2） */
    const check = await verifySegments(id).catch(() => null);
    if (check && !check.ok && check.bad.length) {
      toast(T('home.recoverBroken', { bad: check.bad.length, holes: check.holes.length }));
    }
    toast(T('home.merging'));
    const blob = new Blob(segs.map((s) => s.blob), { type: segs[0].blob?.type || 'audio/webm' });
    let peaks = [];
    try { peaks = await peaksFromFile(blob); } catch { /* 无波形 */ }
    const duration = segs[segs.length - 1].endMs || 0;
    await updateRecording(id, {
      status: 'recovered',
      audio: blob,
      size: blob.size,
      durationMs: duration,
      endedAt: Date.now(),
      peaks,
      integrity: check
        ? { segments: check.total, ok: check.ok, bad: check.bad.length, holes: check.holes.length }
        : null,
    });
    await clearSegments(id);
    toast(T('home.recovered'));
    await refresh();
    ctx.navigate(`#/doc/${id}`);
  }

  picker.addEventListener('change', async () => {
    await importFiles(picker.files);
    picker.value = '';
  });

  qInput.addEventListener('input', debounce(() => {
    query = qInput.value.trim();
    render();
  }, 160));

  $$('.tab', root).forEach((t) => {
    t.addEventListener('click', () => {
      const v = t.dataset.tab;
      if (v === 'import-audio' || v === 'import-voice') {
        picker.click();
        return;
      }
      $$('.tab', root).forEach((x) => x.classList.toggle('active', x === t));
      tab = v;
      folder = null;
      render();
    });
  });

  const unsub = ctx.player.on((type) => {
    if (type === 'state') {
      const playing = ctx.player.playing;
      if (!playing) playingId = playingId;
      render();
    }
  });

  async function refresh() {
    await load();
    render();
    await checkRecovery();
  }

  listWrap.innerHTML = Array.from({ length: 3 }).map(() => `
    <div class="skel-row">
      <i style="width:34px;height:34px;border-radius:50%"></i>
      <div style="flex:1">
        <i style="width:52%;height:12px;margin-bottom:8px"></i>
        <i style="width:32%;height:9px"></i>
      </div>
      <i style="width:40px;height:10px"></i>
    </div>`).join('');

  refresh();

  return {
    refresh,
    destroy() {
      unsub();
      if (pressTimer) clearTimeout(pressTimer);
      fab.classList.remove('open');
    },
  };
}
