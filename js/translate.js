/**
 * 译文（产品文档 2.3：摘要与翻译，在用户明确选择后调用云端模型处理）
 * ------------------------------------------------------------------
 * 约束：
 * 1. 只有用户点「翻译」才发请求，不做后台自动外发；
 * 2. 译文独立存储，绝不改写原文（改写只走纠错与手动编辑两条路）；
 * 3. 逐段对齐，模型少给或多给的行直接丢弃，不猜、不错位；
 * 4. 中途失败保留已完成的段落，重试只补缺的行。
 */

import { listTranscripts, getTranslationMap, putTranslation } from './store.js';
import { llmReady } from './correct.js';
import { chat } from './llm.js';
import { T } from './i18n.js';

export const TARGET_LANGS = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
];

export const LANG_NAME = {
  en: 'English',
  'zh-CN': '简体中文',
  ja: '日本語',
  ko: '한국어',
};

export function langLabel(code) {
  return LANG_NAME[code] || code;
}

/** 默认目标语言：中文界面译英文，其他界面译中文 */
export function defaultTargetLang(uiLang) {
  return /^zh/i.test(uiLang || 'zh') ? 'en' : 'zh-CN';
}

/* 每批 30 段：一次请求够用，又不至于超时 */
const BATCH = 30;

const SYSTEM = `你是专业翻译。把每一行转录译成目标语言，只输出 JSON。
要求：逐行一一对应，不合并、不拆分、不省略、不解释；数字、人名、术语照原样保留；保留说话人口语风格。`;

function parseJson(text) {
  const body = String(text || '');
  const fenced = body.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '').trim();
  const raw = fenced || body.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* 落到下面抛错 */ }
    }
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) {
      try { return JSON.parse(arr[0]); } catch { /* 继续抛错 */ }
    }
    throw new Error(T('tr.badJson'));
  }
}

/** 一批：返回 Map(transcriptId → 译文) */
async function translateBatch(batch, lang, settings) {
  const name = LANG_NAME[lang] || lang;
  const user = `目标语言：${name}。共 ${batch.length} 行，行号从 0 开始：
${batch.map((t, i) => `${i}. ${t.text}`).join('\n')}

输出 JSON：{"lines":[{"i":行号,"t":"译文"}]}`;

  /* 统一走 llm.js：模型名自愈 + 错误翻译 */
  const { content } = await chat({
    settings,
    temperature: 0.2,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
  });
  const parsed = parseJson(content);
  const rows = Array.isArray(parsed) ? parsed : (parsed.lines || parsed.translations || []);

  const out = new Map();
  rows.forEach((row) => {
    const i = Number(row?.i ?? row?.index ?? row?.line);
    const text = String(row?.t ?? row?.text ?? row?.translation ?? '').trim();
    if (!Number.isInteger(i) || i < 0 || i >= batch.length) return; // 越界行丢弃
    if (!text) return;
    out.set(batch[i].id, text);
  });
  return out;
}

/**
 * 翻译整篇（只补缺失的行，除非 force）。
 * @param {string} recordingId
 * @param {{settings?:object, lang:string, force?:boolean, onProgress?:(p:number)=>void}} opts
 */
export async function translateRecording(recordingId, opts = {}) {
  const settings = opts.settings || {};
  const lang = opts.lang;
  if (!llmReady(settings)) {
    const err = new Error(T('tr.needLlm'));
    err.code = 'no-llm';
    throw err;
  }
  const all = (await listTranscripts(recordingId)).filter((t) => (t.text || '').trim());
  if (!all.length) return { ok: false, code: 'no-transcript' };

  const existing = await getTranslationMap(recordingId, lang);
  const todo = opts.force ? all : all.filter((t) => !existing.has(t.id));
  if (!todo.length) return { ok: true, count: 0, total: 0, same: true };

  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const map = await translateBatch(batch, lang, settings);
    for (const tr of batch) {
      const text = map.get(tr.id);
      if (!text) continue;
      await putTranslation({
        recordingId,
        transcriptId: tr.id,
        lang,
        text,
        generator: 'llm',
        model: settings.llmModel || '',
      });
      done += 1;
    }
    opts.onProgress?.(Math.min(1, (i + batch.length) / todo.length));
  }
  return { ok: true, count: done, total: todo.length, lang };
}
