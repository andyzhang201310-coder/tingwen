/**
 * 转录纠错引擎（纯本机，无网络依赖）
 *
 * 分层设计——每一层都只做“有把握”的修改，并且原始识别文本始终保留：
 *   1) 词库层：内置同音误识词 + 用户自定义词库（错词=对词）
 *   2) 上下文层：本身是合法词、但在录音语境下几乎必然是误识的词（如 测速→测试）
 *   3) 归一建议：同一份文稿内，低频的同音写法归并到高频写法（只给建议，不自动改）
 *   4) 大模型层：可选，需用户自己配置 OpenAI 兼容接口；结果同样先给建议
 *
 * 之所以把 3/4 设为“建议”而不是直接改：同音词很多是合法词（事实/实施、权力/权利），
 * 纯统计和大模型都会误判，交给人一眼确认成本更低，也不会把对的改错。
 */
import { esc } from './util.js';
import { PY_GROUPS } from './pinyin-data.js';

/* ───────────── 拼音 ───────────── */

let pyMap = null;

function pinyinMap() {
  if (pyMap) return pyMap;
  pyMap = new Map();
  for (const group of PY_GROUPS.split('|')) {
    const i = group.indexOf(':');
    if (i < 1) continue;
    const syl = group.slice(0, i);
    for (const ch of group.slice(i + 1)) pyMap.set(ch, syl);
  }
  return pyMap;
}

export function syllableOf(ch) {
  return pinyinMap().get(ch) || '';
}

export function pinyinOf(text = '') {
  return [...text].map(syllableOf);
}

/** 模糊音归一：卷舌/平舌、n/l、前后鼻音——中文 ASR 最常见的三类混淆 */
function fuzzy(syl) {
  if (!syl) return '';
  let s = syl;
  if (s.startsWith('zh')) s = `z${s.slice(2)}`;
  else if (s.startsWith('ch')) s = `c${s.slice(2)}`;
  else if (s.startsWith('sh')) s = `s${s.slice(2)}`;
  else if (s.startsWith('l')) s = `n${s.slice(1)}`;
  if (s.endsWith('ng')) s = `${s.slice(0, -2)}n`;
  return s;
}

/** 两段等长文字的读音相似度（0~1）；字符相同也计入，用于同音归并 */
export function phonicSim(a = '', b = '') {
  const x = [...a];
  const y = [...b];
  if (!x.length || x.length !== y.length) return 0;
  let score = 0;
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] === y[i]) { score += 1; continue; }
    const p = syllableOf(x[i]);
    const q = syllableOf(y[i]);
    if (p && p === q) score += 0.95;
    else if (p && fuzzy(p) === fuzzy(q)) score += 0.75;
  }
  return score / x.length;
}

/* ───────────── 词库 ───────────── */

/** 内置同音误识词：左侧基本不是现代汉语常用词，替换是安全的 */
export const BUILTIN_PAIRS = [
  ['计录', '记录'], ['结速', '结束'], ['因该', '应该'], ['以经', '已经'],
  ['时后', '时候'], ['时侯', '时候'], ['会义', '会议'], ['放案', '方案'],
  ['问提', '问题'], ['问颗', '问题'], ['文当', '文档'], ['文建', '文件'],
  ['项木', '项目'], ['项日', '项目'], ['需球', '需求'], ['时简', '时间'],
  ['内荣', '内容'], ['团对', '团队'], ['进读', '进度'], ['我门', '我们'],
  ['你门', '你们'], ['他门', '他们'], ['开使', '开始'], ['继需', '继续'],
  ['觉的', '觉得'], ['所已', '所以'], ['因位', '因为'], ['但事', '但是'],
  ['没由', '没有'], ['什吗', '什么'], ['怎吗', '怎么'], ['这各', '这个'],
  ['那各', '那个'], ['则个', '这个'], ['工能', '功能'], ['细统', '系统'],
  ['数具', '数据'], ['拥户', '用户'], ['网落', '网络'], ['删出', '删除'],
  ['搜锁', '搜索'], ['社备', '设备'], ['平幕', '屏幕'], ['冲电', '充电'],
  ['设制', '设置'], ['总节', '总结'], ['结伦', '结论'], ['建意', '建议'],
  ['讨伦', '讨论'], ['安牌', '安排'], ['负则', '负责'], ['根进', '跟进'],
  ['确任', '确认'], ['风显', '风险'], ['忧化', '优化'], ['设记', '设计'],
  ['反愧', '反馈'], ['下栽', '下载'], ['计化', '计划'], ['完城', '完成'],
  ['支吃', '支持'], ['铲品', '产品'], ['信习', '信息'], ['发法', '方法'],
  ['关与', '关于'], ['书入', '输入'], ['测式', '测试'], ['侧试', '测试'],
  ['测士', '测试'], ['记要', '纪要'], ['部书', '部署'], ['版布', '发布'],
  ['迭带', '迭代'], ['语因', '语音'], ['录因', '录音'], ['录英', '录音'],
  ['今田', '今天'], ['名天', '明天'], ['下洲', '下周'], ['一吓', '一下'],
  ['核新', '核心'], ['重电', '重点'], ['目表', '目标'], ['运因', '运营'],
  ['流成', '流程'], ['接决', '解决'], ['方试', '方式'], ['办发', '办法'],
  ['情矿', '情况'], ['错物', '错误'], ['连系', '联系'], ['沟统', '沟通'],
  ['汇抱', '汇报'], ['工做', '工作'], ['那末', '那么'], ['这末', '这么'],
  ['什末', '什么'],
  /* 下面这批是 ASR 里高频、且错形本身不是现代汉语词的同音误识。
     只收「不会被正常词包含」的组合：题出（问题出现）、目地（项目地址）、在见（现在见面）、
     在次（存在次要）、建没（新建没）、因难（原因难以）、接构（连接构建）、接授（间接授予）
     这些都会误伤，一律不进词库。 */
  ['按装', '安装'], ['既使', '即使'], ['做为', '作为'], ['渡假', '度假'],
  ['侯选', '候选'], ['记算', '计算'],
  ['检侧', '检测'], ['环镜', '环境'], ['效律', '效率'],
  ['性嫩', '性能'], ['依懒', '依赖'], ['排察', '排查'], ['部暑', '部署'],
];

/** 上下文规则：左边是合法词，只有在特定语境下才改 */
export const CONTEXT_RULES = [
  {
    from: '测速', to: '测试',
    need: /(录音|识别|语音|转录|一段|一下|一遍|功能|这个|这段|文件|结果|我们|进行)/,
    unless: /(测速软件|测速工具|测速网络|测速仪|测速网站|测速结果|测速排行|测速速度|\d\s*(m|M|k|K)?bps)/,
    why: '录音语境下“测速”多为“测试”的误识',
  },
  { from: '在说一遍', to: '再说一遍', why: '“在/再”同音' },
  { from: '在来一次', to: '再来一次', why: '“在/再”同音' },
  { from: '在来一遍', to: '再来一遍', why: '“在/再”同音' },
  { from: '在试一次', to: '再试一次', why: '“在/再”同音' },
  { from: '在检查一遍', to: '再检查一遍', why: '“在/再”同音' },
  { from: '在确认一下', to: '再确认一下', why: '“在/再”同音' },
  { from: '在接在厉', to: '再接再厉', why: '固定成语' },
  {
    from: '登陆', to: '登录',
    need: /(账号|帐号|账户|用户|系统|网站|网页|页面|后台|应用|App|APP|登录页)/,
    unless: /(登陆月球|登陆火星|登陆舰|登陆艇|登陆作战|成功登陆|登陆点)/,
    why: '账号语境下“登陆”应为“登录”',
  },
];

const DICT_COUNT = BUILTIN_PAIRS.length + CONTEXT_RULES.filter((r) => !r.need).length;

export function builtinCount() {
  return DICT_COUNT;
}

/* ───────────── 口头语清理 ───────────── */

const LAUGH = '哈呵嘿嘻噶嘎';
const LEAD_FILLER = /^(?:[喂嗯啊呃哦噢唉哎][，,、.。\s]*)+/;
const TAIL_FILLER = /(?:[，,、.。\s]*[喂嗯啊呃哦噢唉哎])+$/;
const PUNCT_FILLER = /(^|[，,。！？!?；;：:\s])(?:嗯|啊|呃|唉|那个|然后|就是)[，,]\s*/g;
const REPEAT = /([\u4e00-\u9fa5]{1,2})\1{2,}/g;

/* ───────────── 主流程 ───────────── */

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

function parseLevel(value) {
  return ['conservative', 'standard', 'aggressive'].includes(value) ? value : 'standard';
}

export function optionsFromSettings(s = {}) {
  return {
    level: parseLevel(s.correctLevel),
    filler: !!s.cleanFiller,
    dict: parseDict(s.customDict),
    on: s.autoCorrect !== false,
  };
}

/** 把 “错词=对词 / 错词→对词” 的多行文本解析成词对 */
export function parseDict(text = '') {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const m = line.match(/^(.+?)\s*(?:=|->|→|=>)\s*(.+)$/);
      if (!m) return null;
      const from = m[1].trim();
      const to = m[2].trim();
      if (!from || !to || from === to) return null;
      return { from, to };
    })
    .filter(Boolean);
}

/** 纠错主入口：返回纠错后的文本与逐条修改记录 */
export function correctText(raw = '', options = {}) {
  const text = String(raw || '');
  const opts = {
    level: parseLevel(options.level),
    filler: !!options.filler,
    dict: Array.isArray(options.dict) ? options.dict : [],
    extraPairs: Array.isArray(options.extraPairs) ? options.extraPairs : [],
  };
  const edits = [];
  const claimed = [];

  function overlaps(start, end) {
    return claimed.some(([s, e]) => start < e && end > s);
  }

  function add(start, end, to, type, from, why) {
    if (start < 0 || end > text.length || start >= end) return;
    if (!to && end - start === 0) return;
    if (overlaps(start, end)) return;
    claimed.push([start, end]);
    edits.push({ start, end, to, from: from ?? text.slice(start, end), type, why: why || '' });
  }

  // 1) 用户词库（优先级最高，可覆盖内置规则）
  opts.dict.forEach((pair) => {
    let idx = 0;
    while (idx <= text.length - pair.from.length) {
      const at = text.indexOf(pair.from, idx);
      if (at < 0) break;
      const prev = text[at - 1];
      const next = text[at + pair.from.length];
      if (!isWordChar(prev) && !isWordChar(next)) add(at, at + pair.from.length, pair.to, 'dict', pair.from, '我的词库');
      idx = at + pair.from.length;
    }
  });

  // 2) 内置同音词
  const builtin = new Map(BUILTIN_PAIRS);
  for (let i = 0; i < text.length - 1; i += 1) {
    const to = builtin.get(text.slice(i, i + 2));
    if (!to) continue;
    if (isWordChar(text[i - 1]) || isWordChar(text[i + 2])) continue;
    add(i, i + 2, to, 'homophone', text.slice(i, i + 2), '内置同音词库');
  }

  // 3) 上下文规则
  if (opts.level !== 'conservative') {
    CONTEXT_RULES.forEach((rule) => {
      if (!text.includes(rule.from)) return;
      if (rule.need && !rule.need.test(text)) return;
      if (rule.unless && rule.unless.test(text)) return;
      let idx = 0;
      while (idx <= text.length - rule.from.length) {
        const at = text.indexOf(rule.from, idx);
        if (at < 0) break;
        add(at, at + rule.from.length, rule.to, 'context', rule.from, rule.why || '上下文规则');
        idx = at + rule.from.length;
      }
    });
  }

  // 4) 文稿内同音归一（由调用方作为 extraPairs 传入，属“建议已被接受”的修改）
  opts.extraPairs.forEach((pair) => {
    if (!pair?.from || !pair?.to) return;
    let idx = 0;
    while (idx <= text.length - pair.from.length) {
      const at = text.indexOf(pair.from, idx);
      if (at < 0) break;
      add(at, at + pair.from.length, pair.to, 'learned', pair.from, pair.why || '同音归一');
      idx = at + pair.from.length;
    }
  });

  // 5) 口头语清理
  if (opts.filler) {
    let m;
    const lead = LEAD_FILLER.exec(text);
    if (lead && lead[0].length && lead[0].length < text.length) {
      add(0, lead[0].length, '', 'filler', lead[0], '开头口头语');
    }
    const tail = TAIL_FILLER.exec(text);
    if (tail && tail[0].length && tail[0].length < text.length && tail.index > 0) {
      add(tail.index, tail.index + tail[0].length, '', 'filler', tail[0], '结尾口头语');
    }
    REPEAT.lastIndex = 0;
    while ((m = REPEAT.exec(text))) {
      const unit = m[1];
      if ([...unit].every((c) => LAUGH.includes(c))) continue;
      add(m.index, m.index + m[0].length, unit, 'filler', m[0], '重复词');
    }
    PUNCT_FILLER.lastIndex = 0;
    while ((m = PUNCT_FILLER.exec(text))) {
      const start = m.index + m[1].length;
      add(start, m.index + m[0].length, '', 'filler', m[0].slice(m[1].length), '句中口头语');
    }
  }

  const merged = edits.sort((a, b) => a.start - b.start);
  const applied = applyEdits(text, merged);
  return {
    raw: text,
    text: applied.text,
    corrections: applied.spans,
    changed: applied.spans.length > 0,
    count: applied.spans.length,
  };
}

/** 按修改记录把原文重建成新文本，并把位置换算到新文本坐标系 */
export function applyEdits(raw, edits = []) {
  const sorted = [...edits].filter((e) => e && e.start >= 0).sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  const spans = [];
  for (const e of sorted) {
    if (e.start < cursor) continue;
    out += raw.slice(cursor, e.start);
    const cs = out.length;
    out += e.to;
    spans.push({ ...e, cs, ce: out.length });
    cursor = e.end;
  }
  out += raw.slice(cursor);
  return { text: out, spans };
}

/** 把带纠错标记的文本渲染成 HTML（修复处带虚线下划线，点按可看原词） */
export function renderTextWithFixes(text = '', corrections = []) {
  const src = String(text || '');
  if (!Array.isArray(corrections) || !corrections.length) return esc(src);
  const sorted = [...corrections]
    .filter((c) => Number.isFinite(c.cs) && Number.isFinite(c.ce) && c.cs >= 0 && c.ce <= src.length && c.ce > c.cs)
    .sort((a, b) => a.cs - b.cs);
  let out = '';
  let cursor = 0;
  for (const c of sorted) {
    if (c.cs < cursor) continue;
    out += esc(src.slice(cursor, c.cs));
    const fixed = src.slice(c.cs, c.ce);
    out += `<span class="fix" data-fix="${esc(c.from || '')}" title="识别为「${esc(c.from || '')}」">${esc(fixed)}</span>`;
    cursor = c.ce;
  }
  out += esc(src.slice(cursor));
  return out;
}

/* ───────────── 同音归一建议 ───────────── */

const SKIP_GRAM = /[^\u4e00-\u9fa5]/;

function gramsOf(text, size) {
  const out = [];
  for (let i = 0; i + size <= text.length; i += 1) {
    const g = text.slice(i, i + size);
    if (SKIP_GRAM.test(g)) continue;
    out.push(g);
  }
  return out;
}

/**
 * 在一份文稿里找“同音但低频”的写法，作为归一建议。
 * 只在读音完全一致、且高频写法出现 ≥3 次、低频写法只出现 1 次时才给出。
 */
export function suggestMerges(texts = [], limit = 6) {
  const full = texts.filter(Boolean).join('\n');
  if (full.length < 12) return [];
  const freq = new Map();
  [2, 3, 4].forEach((n) => {
    gramsOf(full, n).forEach((g) => freq.set(g, (freq.get(g) || 0) + 1));
  });
  const frequent = [...freq.entries()].filter(([, c]) => c >= 3);
  const rare = [...freq.entries()].filter(([, c]) => c === 1);
  const out = [];
  for (const [r, rc] of rare) {
    if (out.length >= limit) break;
    let best = null;
    for (const [f, fc] of frequent) {
      if (f.length !== r.length || f === r) continue;
      let diff = 0;
      for (let i = 0; i < f.length; i += 1) if (f[i] !== r[i]) diff += 1;
      if (!diff || diff > 2) continue;
      const sameSound = [...r].every((ch, i) => ch === f[i] || (!!syllableOf(ch) && syllableOf(ch) === syllableOf(f[i])));
      if (!sameSound) continue;
      if (phonicSim(r, f) < 0.9) continue;
      if (!best || fc > best.fc) best = { f, fc };
    }
    if (best && best.fc >= 3) {
      out.push({ from: r, to: best.f, hits: best.fc, why: `文中「${best.f}」出现 ${best.fc} 次，读音相同`, rc });
    }
  }
  return out;
}

/* ───────────── 大模型纠错（可选） ───────────── */

export function llmReady(cfg = {}) {
  return !!(cfg.llmBase && cfg.llmKey);
}

const LLM_SYSTEM = `你是中文语音识别（ASR）文本纠错器。只修正同音/近音造成的错别字、明显误识的人名术语与错别字，不改变原意，不扩写，不删减有效信息，不改写口语风格。只在有把握时修改，不确定就保持原样。只输出 JSON。`;

/**
 * 调 OpenAI 兼容的 chat/completions 做整篇纠错。
 * @returns {Promise<Array<{line:number, from:string, to:string, why:string}>>}
 */
export async function llmCorrect(lines = [], cfg = {}) {
  if (!llmReady(cfg)) throw new Error('未配置大模型纠错服务');
  const base = String(cfg.llmBase).replace(/\/+$/, '');
  const user = `逐行检查下面的 ASR 文本。返回 JSON：{"lines":[{"i":行号,"edits":[{"from":"原文片段","to":"修正后","why":"简短理由"}]}]}。
规则：from 必须是该行中连续出现的原文子串；只返回有改动的行；没有改动返回 {"lines":[]}。

${lines.map((t, i) => `${i}. ${t}`).join('\n')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.llmKey}`,
      },
      body: JSON.stringify({
        model: cfg.llmModel || 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: LLM_SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? '大模型请求超时' : '无法连接大模型接口');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}${detail ? ` · ${detail.slice(0, 120)}` : ''}`);
  }
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content || '';
  const jsonText = content.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '').trim() || content.trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('大模型返回内容无法解析');
    parsed = JSON.parse(m[0]);
  }
  const out = [];
  (parsed.lines || []).forEach((row) => {
    const idx = Number(row.i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) return;
    (row.edits || []).forEach((e) => {
      const from = String(e.from || '');
      const to = String(e.to || '');
      if (!from || !to || from === to) return;
      if (!lines[idx].includes(from)) return;
      out.push({ line: idx, from, to, why: String(e.why || '大模型纠错').slice(0, 24) });
    });
  });
  return out;
}

/* ───────────── 在现有文本上叠加单条修改 ───────────── */

/**
 * 在已经纠错过的段落上再应用一条“建议”，并同步平移已有的纠错标记。
 * 用于大模型建议、同音归一建议被单条采用的情况。
 */
export function applyOneFix(tr, from, to, type = 'llm', why = '') {
  const text = tr.text || '';
  const at = text.indexOf(from);
  if (at < 0) return null;
  const end = at + from.length;
  const delta = to.length - from.length;
  const corrections = (tr.corrections || []).map((c) => {
    if (c.cs >= end) return { ...c, cs: c.cs + delta, ce: c.ce + delta };
    if (c.ce <= at) return { ...c };
    return null;
  }).filter(Boolean);
  if ((tr.corrections || []).length !== corrections.length) return null;
  const nextText = text.slice(0, at) + to + text.slice(end);
  corrections.push({ cs: at, ce: at + to.length, from, to, type, why });
  corrections.sort((a, b) => a.cs - b.cs);
  const raw = tr.raw || (tr.corrections?.length ? applyEditsBack(tr) : text);
  return { text: nextText, corrections, raw };
}

/** 没有 raw 字段时，用现有标记反推原文 */
function applyEditsBack(tr) {
  const text = tr.text || '';
  let out = '';
  let cursor = 0;
  [...(tr.corrections || [])].sort((a, b) => a.cs - b.cs).forEach((c) => {
    out += text.slice(cursor, c.cs) + (c.from ?? text.slice(c.cs, c.ce));
    cursor = c.ce;
  });
  return out + text.slice(cursor);
}

/** 撤销某一条修改：就地还原这一段，其余标记位置随之平移 */
export function revertOne(tr, index) {
  const list = [...(tr.corrections || [])];
  const target = list[index];
  if (!target) return null;
  const text = tr.text || '';
  const restored = target.from ?? text.slice(target.cs, target.ce);
  const delta = restored.length - (target.ce - target.cs);
  const nextText = text.slice(0, target.cs) + restored + text.slice(target.ce);
  const corrections = list
    .filter((_, i) => i !== index)
    .map((c) => (c.cs >= target.ce ? { ...c, cs: c.cs + delta, ce: c.ce + delta } : { ...c }));
  return {
    text: nextText,
    corrections,
    raw: tr.raw || null,
    corrected: corrections.length ? 1 : 0,
  };
}
