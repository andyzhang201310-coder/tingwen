/* 大模型统一入口（纪要 / 待办 / 翻译 / 纠错 / 设置页测试都走这里）

   为什么要有这一层：
   1. 模型 ID 很容易填错——界面上看到的是展示名「DeepSeek-V4.1-Flash」，
      接口要的是 ID「deepseek-flash」。手填展示名会得到 HTTP 400，
      而且报错是一整段英文 JSON，用户完全不知道该改什么。
   2. 服务端其实会在报错里告诉你「支持哪些模型」，这一层直接解析出来，
      自动换一个重试，并把可用的名字写回设置，下一次就不用再试错。
   3. 401/402/429/5xx 各给一句能操作的中文，而不是甩原文。
*/

import { T } from './i18n.js';

/** 带状态码、可读原因与「服务端支持的模型列表」的错误 */
export class LLMError extends Error {
  constructor(message, { status = 0, detail = '', models = [], model = '' } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.detail = detail;
    this.models = models;
    this.model = model;
  }
}

export { normalizeModel } from './model-id.js';
import { normalizeModel } from './model-id.js';

function isDeepSeek(base) {
  return /deepseek/i.test(String(base || ''));
}

/** 只对认 response_format 的端点开 JSON 模式；不支持时会自动去掉重试一次 */
function prefersJson(base, model) {
  return isDeepSeek(base) || /deepseek/i.test(String(model || ''));
}

/** 从 400 的报错里抽出「支持的模型名」 */
function readErrorBody(text) {
  let message = '';
  try {
    const j = JSON.parse(text);
    message = j?.error?.message || j?.error?.msg || j?.message || j?.msg || '';
  } catch { /* 不是 JSON 就退化成原文 */ }
  if (!message) message = String(text || '').replace(/\s+/g, ' ').trim();

  const models = [];
  const m = message.match(/supported (?:api )?model names? (?:are|is) ([^.;]*(?:;|\.|$))/i)
    || message.match(/available models? (?:are|is)[:：]? ([^.;]*)/i);
  if (m) {
    m[1]
      .split(/,|，|\/|\band\b/)
      .map((s) => s.trim().replace(/^[`"'\s]+|[`"'\s]+$/g, ''))
      .forEach((s) => {
        if (!s || /^but you passed/i.test(s) || /\s/.test(s)) return;
        if (!models.includes(s)) models.push(s);
      });
  }
  return { message, models };
}

function isModelIssue(status, message, models) {
  if (models.length) return true;
  return status === 400 && /model_not_found|model .*(does not exist|not found|is not supported|invalid)|unknown model|invalid model|no such model|不支持的?模型|模型.*(不存在|无效)/i.test(message);
}

function describeError(status, message, models, model) {
  if (models.length) return T('llm.modelUnsupported', { model, list: models.join(' / ') });
  if (status === 401 || status === 403) return T('llm.keyInvalid', { s: status });
  if (status === 402) return T('llm.quota');
  if (status === 429) return T('llm.rate');
  if (status >= 500) return T('llm.server', { s: status });
  if (isModelIssue(status, message, models)) return T('llm.modelUnknown', { model });
  const brief = String(message || '').replace(/\s+/g, ' ').slice(0, 90);
  return brief ? `HTTP ${status} · ${brief}` : `HTTP ${status}`;
}

/* 模型被自动纠正后写回设置，下一次直接用对；失败也不影响本次结果 */
async function rememberModel(model, silent) {
  try {
    const store = await import('./store.js');
    const cur = await store.getSettings();
    if (cur.llmModel === model) return;
    await store.setSettings({ llmModel: model });
    if (!silent) {
      const { toast } = await import('./ui.js');
      toast(T('llm.switched', { model }));
    }
  } catch { /* ignore */ }
}

/**
 * 调 OpenAI 兼容的 chat/completions。
 * @param {object} opts
 * @param {object} opts.settings 含 llmBase / llmModel / llmKey
 * @param {Array<{role:string, content:string}>} opts.messages
 * @param {boolean} [opts.json] 是否尝试 JSON 模式（默认 true）
 * @returns {Promise<{content:string, model:string}>}
 */
export async function chat({
  settings = {}, messages = [], temperature = 0.2, json = true, timeout = 60000, maxTokens, silentSwitch = false,
}) {
  const base = String(settings.llmBase || '').replace(/\/+$/, '');
  const key = String(settings.llmKey || '');
  if (!base || !key) throw new LLMError(T('llm.needConfig'));

  let wantJson = json && prefersJson(base, settings.llmModel);

  /* 候选队列：先用户填的，再服务端报出来的，最后常见兜底 */
  const queue = [];
  const push = (name) => {
    const n = normalizeModel(name);
    if (n && !queue.includes(n)) queue.push(n);
  };
  push(settings.llmModel);
  if (isDeepSeek(base)) push('deepseek-chat');

  const tried = new Set();
  let lastErr = null;

  for (let i = 0; i < queue.length && i < 4; i++) {
    const model = queue[i];
    if (tried.has(model)) continue;
    tried.add(model);

    const payload = { model, temperature, messages };
    if (wantJson) payload.response_format = { type: 'json_object' };
    if (maxTokens) payload.max_tokens = maxTokens;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new LLMError(err?.name === 'AbortError' ? T('llm.timeout') : T('llm.conn'));
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const data = await res.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content || '';
      if (model !== String(settings.llmModel || '').trim()) rememberModel(model, silentSwitch);
      return { content, model };
    }

    const text = await res.text().catch(() => '');
    const { message, models } = readErrorBody(text);
    lastErr = new LLMError(describeError(res.status, message, models, model), {
      status: res.status, detail: message, models, model,
    });

    /* 端点不认 response_format：去掉该字段，同一个模型再试一次 */
    if (wantJson && res.status === 400 && /json_object|response_format|json mode|json 模式/i.test(message)) {
      wantJson = false;
      queue.splice(i, 0, model); // 插回队首，允许同一模型重试
      queue.splice(i + 1, 1);
      tried.delete(model);
      i -= 1;
      continue;
    }

    /* 模型名不认：把服务端给的可用模型排进队列自动重试 */
    if (isModelIssue(res.status, message, models)) {
      (models.length ? models : (isDeepSeek(base) ? ['deepseek-chat'] : [])).forEach(push);
      continue;
    }

    throw lastErr;
  }

  throw lastErr || new LLMError(T('llm.fail'));
}

/** 读取接口支持的模型 ID（设置页「拉取可用模型」用） */
export async function listModels(settings = {}) {
  const base = String(settings.llmBase || '').replace(/\/+$/, '');
  const key = String(settings.llmKey || '');
  if (!base || !key) throw new LLMError(T('llm.needConfig'));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${base}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    throw new LLMError(err?.name === 'AbortError' ? T('llm.timeout') : T('llm.conn'));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const { message, models } = readErrorBody(text);
    throw new LLMError(describeError(res.status, message, models, settings.llmModel), {
      status: res.status, detail: message, models,
    });
  }
  const data = await res.json().catch(() => null);
  const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const ids = rows.map((r) => String(r?.id || r?.name || '')).filter(Boolean);
  if (!ids.length) throw new LLMError(T('llm.noModels'));
  return ids;
}
