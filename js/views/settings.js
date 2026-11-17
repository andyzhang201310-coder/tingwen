import { $, esc, fmtBytes } from '../util.js';
import { icons } from '../icons.js';
import { toast, openSheet, closeSheet, confirmDialog, choiceSheet } from '../ui.js';
import {
  setSettings, listRecordings, db, purgeRecording, purgeSpeakerData, storageInfo, DEFAULT_SETTINGS,
} from '../store.js';
import { builtinCount, parseDict, llmReady, llmCorrect } from '../correct.js';
import { T, locale } from '../i18n.js';

const UI_LANGS = () => [
  { label: T('set.langZh'), value: 'zh-CN' },
  { label: T('set.langEn'), value: 'en-US' },
  { label: T('set.langAuto'), value: 'auto' },
];
const RECOG_LANGS = () => [
  { label: T('set.recogZh'), value: 'zh-CN' },
  { label: T('set.recogEn'), value: 'en-US' },
  { label: T('set.recogAuto'), value: 'auto' },
];
const THEMES = () => [
  { label: T('set.themeDark'), value: 'dark' },
  { label: T('set.themeLight'), value: 'light' },
  { label: T('set.themeSystem'), value: 'system' },
];
const MODES = () => [
  { label: T('set.modeAccurate'), value: 'accurate' },
  { label: T('set.modeFast'), value: 'fast' },
];
const LEVELS = () => [
  { label: T('set.levelConservative'), value: 'conservative' },
  { label: T('set.levelStandard'), value: 'standard' },
  { label: T('set.levelAggressive'), value: 'aggressive' },
];
const DIAR_ENGINES = () => [
  { label: T('set.diarEngineAuto'), value: 'auto' },
  { label: T('set.diarLocal'), value: 'local' },
  { label: T('set.diarCloud'), value: 'cloud' },
];
const SCENARIO_OPTS = () => [
  { label: T('set.scenAuto'), value: 'auto' },
  { label: T('sum.scenarioMeeting'), value: 'meeting' },
  { label: T('sum.scenarioClass'), value: 'class' },
  { label: T('sum.scenarioInterview'), value: 'interview' },
  { label: T('sum.scenarioMemo'), value: 'memo' },
];
const TRANSLATE_OPTS = () => [
  { label: T('set.translateAuto'), value: 'auto' },
  { label: 'English', value: 'en' },
  { label: '简体中文', value: 'zh-CN' },
  { label: '日本語', value: 'ja' },
  { label: '한국어', value: 'ko' },
];
const ENGINES = () => [
  { label: T('set.engineAuto'), value: 'auto' },
  { label: T('set.engineLocal'), value: 'local' },
  { label: T('set.engineCloud'), value: 'cloud' },
];

export function mountSettings(root, ctx) {
  root.innerHTML = `
    <div class="view settings">
      <div class="settings-top">
        <button class="icon-btn" data-act="back" aria-label="${T('common.back')}">${icons.chevronLeft}</button>
        <div class="t">${T('set.title')}</div>
      </div>
      <div class="scroll" id="setScroll"></div>
    </div>`;

  const scroll = $('#setScroll', root);
  let s = ctx.settings;

  function row({ icon, label, value, act, chev = true, danger = false }) {
    const chevHtml = chev ? `<span class="chev">${icons.chevronRight}</span>` : '';
    const valueHtml = (value || chev)
      ? `<span class="set-value">${value ? esc(value) : ''}${chevHtml}</span>`
      : '';
    return `
      <button class="set-row" data-act="${act}">
        ${icons[icon] || ''}
        <span class="set-label" ${danger ? 'style="color:var(--red)"' : ''}>${esc(label)}</span>
        ${valueHtml}
      </button>`;
  }

  function toggle({ icon, label, key, sub }) {
    return `
      <div class="set-row" data-toggle="${key}">
        ${icons[icon] || ''}
        <span class="set-label">${esc(label)}</span>
        <button class="switch" role="switch" aria-checked="${s[key] ? 'true' : 'false'}" data-toggle="${key}" aria-label="${esc(label)}"></button>
      </div>
      ${sub ? `<div class="set-sub">${esc(sub)}</div>` : ''}`;
  }

  function current(list, value) {
    return (list.find((x) => x.value === value) || list[0]).label;
  }

  async function render() {
    s = ctx.settings;
    const recs = await listRecordings();
    const trash = await listRecordings({ deleted: true });
    const totalSize = recs.reduce((sum, r) => sum + (r.size || r.audio?.size || 0), 0);
    const { quota, usage } = await storageInfo();
    const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
    const dictCount = parseDict(s.customDict).length;

    scroll.innerHTML = `
      <div class="settings-hero">
        <h2>${T('set.hero')}</h2>
        <p>${T('set.heroDesc')}</p>
      </div>

      <div class="group">
        <div class="section-label">${T('set.general')}</div>
        ${row({ icon: 'translate', label: T('set.lang'), value: current(UI_LANGS(), s.uiLang), act: 'ui-lang' })}
        ${row({ icon: 'mic', label: T('set.recogLang'), value: current(RECOG_LANGS(), s.lang), act: 'lang' })}
        ${row({ icon: 'phone', label: T('set.theme'), value: current(THEMES(), s.theme), act: 'theme' })}
        ${row({ icon: 'bolt', label: T('set.mode'), value: current(MODES(), s.transcribeMode), act: 'mode' })}
        ${row({ icon: 'cloud', label: T('set.engine'), value: current(ENGINES(), s.engineMode), act: 'engine' })}
        ${row({
          icon: 'cloud',
          label: T('set.asrCloud'),
          value: s.asrCloudUrl ? T('set.configured') : T('set.notConfigured'),
          act: 'asr-cloud',
        })}
      </div>

      <div class="group">
        <div class="section-label">${T('set.groupRec')}</div>
        ${toggle({ icon: 'clock', label: T('set.showHistory'), key: 'showHistory', sub: s.showHistory ? '' : T('set.showHistorySub') })}
        ${toggle({ icon: 'storage', label: T('set.saveRecording'), key: 'saveRecording', sub: s.saveRecording ? '' : T('set.saveRecordingSub') })}
        ${toggle({ icon: 'audioFile', label: T('set.importAudio'), key: 'importAudio' })}
        ${toggle({ icon: 'waveform', label: T('set.sound'), key: 'soundEffect' })}
        ${toggle({ icon: 'sparkle', label: T('set.autoCorrect'), key: 'autoCorrect', sub: s.autoCorrect ? T('set.autoCorrectOn') : T('set.autoCorrectOff') })}
        ${toggle({ icon: 'edit', label: T('set.cleanFiller'), key: 'cleanFiller', sub: s.cleanFiller ? T('set.cleanFillerSub') : '' })}
        ${row({ icon: 'bolt', label: T('set.fixLevel'), value: current(LEVELS(), s.correctLevel), act: 'correct-level' })}
        ${row({ icon: 'list', label: T('set.fixDict'), value: T('set.fixDictValue', { n: dictCount }), act: 'dict' })}
        ${row({ icon: 'cloud', label: T('set.llm'), value: llmReady(s) ? T('set.configured') : T('set.notConfigured'), act: 'llm' })}
        ${row({ icon: 'doc', label: T('set.summaryScenario'), value: current(SCENARIO_OPTS(), s.summaryScenario), act: 'summary-scenario' })}
        ${row({ icon: 'translate', label: T('set.translateLang'), value: TRANSLATE_OPTS().find((x) => x.value === (s.translateLang || 'auto'))?.label || T('set.translateAuto'), act: 'translate-lang' })}
        ${toggle({ icon: 'copy', label: T('set.autoCopy'), key: 'autoCopy', sub: s.autoCopy ? T('set.autoCopySub') : '' })}
        ${toggle({ icon: 'mic', label: T('set.instant'), key: 'instantRecord', sub: T('set.instantSub') })}
      </div>

      <div class="group">
        <div class="section-label">${T('set.groupSpeaker')}</div>
        ${toggle({ icon: 'waveform', label: T('set.diarAutoToggle'), key: 'diarEnabled', sub: s.diarEnabled ? T('set.diarAutoSub') : T('set.diarAutoOff') })}
        ${row({ icon: 'bolt', label: T('set.diarEngine'), value: current(DIAR_ENGINES(), s.diarEngine), act: 'diar-engine' })}
        ${row({
          icon: 'cloud',
          label: T('set.diarCloudRow'),
          value: s.diarCloudUrl ? T('set.configured') : (s.diarSimCloud ? T('diar.modeSim') : T('set.notConfigured')),
          act: 'diar-cloud',
        })}
        ${toggle({ icon: 'cloud', label: T('set.diarSim'), key: 'diarSimCloud', sub: s.diarSimCloud ? T('set.diarSimSub') : '' })}
        ${row({ icon: 'lock', label: T('set.spkData'), act: 'spk-data' })}
      </div>

      <div class="group">
        <div class="section-label">${T('set.groupData')}</div>
        ${toggle({ icon: 'trash', label: T('set.autoDelete'), key: 'autoDeleteOld', sub: s.autoDeleteOld ? T('set.autoDeleteSub', { n: s.autoDeleteDays }) : '' })}
        ${row({ icon: 'restore', label: T('set.trash'), value: T('set.trashValue', { n: trash.length }), act: 'trash' })}
        <div class="storage-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="storage-meta">
          <span>${recs.length
            ? T('set.storageLocalN', { size: fmtBytes(totalSize), n: recs.length })
            : T('set.storageLocal', { size: fmtBytes(totalSize) })}</span>
          <span>${quota ? T('set.quota', { size: fmtBytes(quota) }) : T('set.quotaUnknown')}</span>
        </div>
      </div>

      <div class="group">
        <div class="section-label">${T('set.groupAdvanced')}</div>
        ${row({ icon: 'waveform', label: T('set.engineDoc'), act: 'about-engine' })}
        ${row({ icon: 'lock', label: T('set.privacy'), act: 'privacy' })}
        ${row({ icon: 'info', label: T('set.about'), value: T('set.aboutValue'), act: 'about' })}
      </div>

      <div class="set-foot">
        ${T('set.footer')}<br />
        ${T('set.footer2')}
      </div>`;
  }

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const toggleEl = e.target.closest('[data-toggle]');

    if (toggleEl) {
      const key = toggleEl.dataset.toggle;
      const next = !s[key];
      ctx.settings = await setSettings({ [key]: next });
      if (key === 'soundEffect' && next) ctx.beep?.();
      await render();
      if (key === 'autoDeleteOld' && next) toast(T('set.historyOn'));
      return;
    }

    if (!act) return;
    if (act === 'back') { ctx.navigate('#/'); return; }

    if (act === 'ui-lang') {
      const v = await choiceSheet({
        title: T('set.lang'),
        desc: T('set.langDesc'),
        options: UI_LANGS(),
        value: s.uiLang,
      });
      if (v) {
        ctx.settings = await setSettings({ uiLang: v });
        // 立即切换：重建当前视图，无需刷新页面
        ctx.applyLang(v);
        ctx.rerender();
      }
      return;
    }
    if (act === 'lang') {
      const v = await choiceSheet({ title: T('set.recogLang'), desc: T('set.recogLangDesc'), options: RECOG_LANGS(), value: s.lang });
      if (v) { ctx.settings = await setSettings({ lang: v }); await render(); }
      return;
    }
    if (act === 'theme') {
      const v = await choiceSheet({ title: T('set.theme'), desc: T('set.themeDesc'), options: THEMES(), value: s.theme });
      if (v) {
        ctx.settings = await setSettings({ theme: v });
        ctx.applyTheme(v);
        await render();
      }
      return;
    }
    if (act === 'mode') {
      const v = await choiceSheet({ title: T('set.mode'), desc: T('set.modeDesc'), options: MODES(), value: s.transcribeMode });
      if (v) { ctx.settings = await setSettings({ transcribeMode: v }); await render(); }
      return;
    }
    if (act === 'engine') {
      const v = await choiceSheet({ title: T('set.engine'), desc: T('set.engineDesc'), options: ENGINES(), value: s.engineMode });
      if (v) { ctx.settings = await setSettings({ engineMode: v }); await render(); }
      return;
    }
    if (act === 'trash') { ctx.navigate('#/trash'); return; }

    if (act === 'dict') { openDict(); return; }
    if (act === 'diar-engine') {
      const v = await choiceSheet({
        title: T('set.diarEngine'),
        desc: T('set.diarEngineDesc'),
        options: DIAR_ENGINES(),
        value: s.diarEngine,
      });
      if (v) { ctx.settings = await setSettings({ diarEngine: v }); await render(); }
      return;
    }
    if (act === 'diar-cloud') { openDiarCloud(); return; }
    if (act === 'asr-cloud') { openAsrCloud(); return; }
    if (act === 'spk-data') { openSpeakerData(); return; }
    if (act === 'llm') { openLLM(); return; }
    if (act === 'summary-scenario') {
      const v = await choiceSheet({
        title: T('set.summaryScenario'),
        desc: T('set.summaryScenarioDesc'),
        options: SCENARIO_OPTS(),
        value: s.summaryScenario || 'auto',
      });
      if (v) { ctx.settings = await setSettings({ summaryScenario: v }); await render(); }
      return;
    }
    if (act === 'translate-lang') {
      const v = await choiceSheet({
        title: T('set.translateLang'),
        desc: T('set.translateLangDesc'),
        options: TRANSLATE_OPTS(),
        value: s.translateLang || 'auto',
      });
      if (v) {
        ctx.settings = await setSettings({ translateLang: v === 'auto' ? '' : v });
        await render();
      }
      return;
    }
    if (act === 'correct-level') {
      const v = await choiceSheet({
        title: T('set.fixLevel'),
        desc: T('set.levelDesc'),
        options: LEVELS(),
        value: s.correctLevel,
      });
      if (v) { ctx.settings = await setSettings({ correctLevel: v }); await render(); }
      return;
    }
    if (act === 'about-engine') {
      openSheet({
        title: T('set.engineDoc'),
        content: `<p class="sheet-desc">${T('set.engineSheet')}</p>
          <p class="sheet-desc">${T('set.engineSheet2')}</p>
          <p class="hint">${T('set.engineSheet3')}</p>`,
      });
      return;
    }
    if (act === 'privacy') {
      openSheet({
        title: T('set.privacy'),
        content: `<p class="sheet-desc">${T('set.privacyMic')}</p>
          <p class="sheet-desc">${T('set.privacyStore')}</p>
          <p class="sheet-desc">${T('set.privacyAsr')}</p>
          <p class="sheet-desc">${T('set.privacyDelete')}</p>`,
      });
      return;
    }
    if (act === 'about') {
      openSheet({
        title: T('set.about'),
        content: `<p class="sheet-desc">${T('set.aboutBody')}</p>
          <p class="sheet-desc">${T('set.aboutBody2')}</p>
          <p class="sheet-desc">${T('set.aboutBody3')}</p>
          <p class="hint">${T('set.version', { date: new Date().toLocaleDateString(locale()) })}</p>`,
        actions: [{ label: T('set.clearAll'), danger: true, icon: 'trash', onClick: clearAll }],
      });
      return;
    }
  });

  function openDict() {
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('set.dictDesc', { n: builtinCount() })}</p>
      <textarea class="dict-area" id="dictText" spellcheck="false" placeholder="测速=测试&#10;结速=结束&#10;因该=应该">${esc(s.customDict || '')}</textarea>
      <div class="hint">${T('set.dictHint')}</div>
      <button class="btn-primary" id="dictSave" style="margin-top:12px">${T('set.dictSave')}</button>`;
    const close = openSheet({ title: T('set.fixDict'), content: box });
    $('#dictSave', box).addEventListener('click', async () => {
      const val = $('#dictText', box).value;
      ctx.settings = await setSettings({ customDict: val });
      close();
      await render();
      toast(T('set.dictSaved', { n: parseDict(val).length }));
    });
  }

  function openDiarCloud() {
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('set.diarCloudHint')}</p>
      <label class="set-field"><span>${T('set.diarCloudUrl')}</span>
        <input class="dict-input" id="dcUrl" placeholder="https://example.com/diarize" value="${esc(s.diarCloudUrl || '')}" /></label>
      <label class="set-field"><span>${T('set.diarCloudKey')}</span>
        <input class="dict-input" id="dcKey" type="password" placeholder="••••" value="${esc(s.diarCloudKey || '')}" /></label>
      <div class="hint">${T('diar.simNote')}</div>
      <button class="btn-primary" id="dcSave" style="margin-top:14px">${T('common.save')}</button>`;
    const close = openSheet({ title: T('set.diarCloudRow'), content: box });
    $('#dcSave', box).addEventListener('click', async () => {
      ctx.settings = await setSettings({
        diarCloudUrl: $('#dcUrl', box).value.trim(),
        diarCloudKey: $('#dcKey', box).value.trim(),
      });
      close();
      await render();
      toast(T('set.diarSaved'));
    });
  }

  function openAsrCloud() {
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('set.asrCloudHint')}</p>
      <label class="set-field"><span>${T('set.asrCloudUrl')}</span>
        <input class="dict-input" id="acUrl" placeholder="https://api.openai.com/v1/audio/transcriptions" value="${esc(s.asrCloudUrl || '')}" /></label>
      <label class="set-field"><span>${T('set.asrCloudKey')}</span>
        <input class="dict-input" id="acKey" type="password" placeholder="••••" value="${esc(s.asrCloudKey || '')}" /></label>
      <label class="set-field"><span>${T('set.asrCloudModel')}</span>
        <input class="dict-input" id="acModel" placeholder="whisper-1" value="${esc(s.asrCloudModel || 'whisper-1')}" /></label>
      ${toggle({
        icon: 'restore',
        label: T('set.repairAuto'),
        key: 'repairAuto',
        sub: s.repairAuto === false ? '' : T('set.repairAutoSub'),
      })}
      <p class="hint">${T('set.asrCloudWarn')}</p>
      <button class="btn-primary" id="acSave" style="margin-top:14px">${T('common.save')}</button>`;
    const close = openSheet({ title: T('set.asrCloud'), content: box });
    box.addEventListener('click', (e) => {
      const sw = e.target.closest('.switch');
      if (!sw) return;
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      s.repairAuto = on;
      const hintEl = $('.set-sub', box);
      if (hintEl) hintEl.style.display = on ? '' : 'none';
    });
    $('#acSave', box).addEventListener('click', async () => {
      ctx.settings = await setSettings({
        asrCloudUrl: $('#acUrl', box).value.trim(),
        asrCloudKey: $('#acKey', box).value.trim(),
        asrCloudModel: $('#acModel', box).value.trim() || 'whisper-1',
        repairAuto: s.repairAuto !== false,
      });
      close();
      await render();
      toast(T('set.asrCloudSaved'));
    });
  }

  function openSpeakerData() {
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('set.spkDataBody')}</p>
      <p class="sheet-desc">${T('set.spkDataBody2')}</p>
      <button class="ghost danger" id="spkClear" style="width:100%;justify-content:center;height:44px;margin-top:6px">
        ${T('set.spkClear')}
      </button>`;
    openSheet({ title: T('set.spkData'), content: box });
    $('#spkClear', box).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: T('set.spkClear'),
        message: T('set.spkClearMsg'),
        confirmText: T('set.spkClear'),
        danger: true,
      });
      if (!ok) return;
      const recs = [...await listRecordings(), ...await listRecordings({ deleted: true })];
      for (const r of recs) await purgeSpeakerData(r.id);
      closeSheet();
      ctx.currentView?.refresh?.();
      toast(T('set.spkCleared'));
    });
  }

  function openLLM() {
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="sheet-desc">${T('set.llmDesc')}</p>
      <label class="set-field"><span>${T('set.llmBase')}</span>
        <input class="dict-input" id="llmBase" placeholder="https://api.openai.com/v1" value="${esc(s.llmBase || '')}" /></label>
      <label class="set-field"><span>${T('set.llmModel')}</span>
        <input class="dict-input" id="llmModel" placeholder="gpt-4o-mini" value="${esc(s.llmModel || 'gpt-4o-mini')}" /></label>
      <label class="set-field"><span>${T('set.llmKey')}</span>
        <input class="dict-input" id="llmKey" type="password" placeholder="sk-…" value="${esc(s.llmKey || '')}" /></label>
      <div class="hint">${T('set.llmHint')}</div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="ghost outline" id="llmTest" style="flex:1">${T('set.test')}</button>
        <button class="btn-primary" id="llmSave" style="flex:1">${T('common.save')}</button>
      </div>`;
    const close = openSheet({ title: T('set.llm'), content: box });
    const collect = () => ({
      llmBase: $('#llmBase', box).value.trim(),
      llmModel: $('#llmModel', box).value.trim() || 'gpt-4o-mini',
      llmKey: $('#llmKey', box).value.trim(),
    });
    $('#llmSave', box).addEventListener('click', async () => {
      ctx.settings = await setSettings(collect());
      close();
      await render();
      toast(T('set.llmSaved'));
    });
    $('#llmTest', box).addEventListener('click', async () => {
      const cfg = collect();
      if (!llmReady(cfg)) { toast(T('set.llmNeedConfig')); return; }
      const btn = $('#llmTest', box);
      btn.textContent = T('set.testing');
      btn.disabled = true;
      try {
        const sample = s.lang === 'en-US'
          ? 'This is a test recording used to check whether the connection works.'
          : '这是一段测速录音，用来测式接口是否正常。';
        const edits = await llmCorrect([sample], cfg);
        toast(edits.length
          ? T('set.llmOk', { pair: `${edits[0].from}→${edits[0].to}` })
          : T('set.llmOkNoEdit'));
      } catch (err) {
        toast(err?.message || T('set.llmFail'));
      } finally {
        btn.textContent = T('set.test');
        btn.disabled = false;
      }
    });
  }

  async function clearAll() {
    const ok = await confirmDialog({
      title: T('set.clearTitle'),
      message: T('set.clearMsg'),
      confirmText: T('set.clearConfirm'),
      danger: true,
    });
    if (!ok) return;
    const recs = await listRecordings();
    const dead = await listRecordings({ deleted: true });
    for (const r of [...recs, ...dead]) await purgeRecording(r.id);
    await db.clear('meta');
    ctx.settings = { ...DEFAULT_SETTINGS };
    ctx.applyTheme(ctx.settings.theme);
    toast(T('set.cleared'));
    ctx.navigate('#/', { replace: true });
  }

  render();
  return {
    refresh: render,
    destroy() {},
  };
}
