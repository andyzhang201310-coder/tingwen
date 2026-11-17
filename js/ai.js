/** 本机规则分析：要点 / 待办 / 问题 / 关键词
 *  说明：P0 阶段不接大模型，这里用确定性规则做结构化抽取，
 *  接口保持独立，后续可替换为云端 / 本地 LLM。 */

const CUE_STRONG = ['决定', '结论', '决议', '目标', '方案', '确认', '重点是', '核心', '总结'];
const CUE_MID = ['需要', '必须', '安排', '负责', '下一步', '跟进', '落实', '风险', '问题', '建议', '优化', '提升'];
const TODO_CUE = ['需要', '负责', '安排', '下一步', '待办', '截止', '记得', '跟进', '落实', '必须', '要做', '下周', '明天'];
const QUESTION_CUE = ['？', '?', '是否', '怎么', '为什么', '如何', '多少', '能不能', '有没有'];

const STOP_CHARS = '的了是在和与就都也很我你他她它这那有会要个把被对从而且但所以因为如果所以呢吗啊吧么上下中前后时候一个我们你们他们这样那样什么怎么可以没有还是知道觉得然后可能应该已经现在今天明天昨天';

export function splitSentences(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function collect(transcripts) {
  const sentences = [];
  transcripts.forEach((tr) => {
    const text = tr.text || '';
    if (!text.trim()) return;
    const pieces = splitSentences(text);
    const totalChars = Math.max(1, text.length);
    let cursor = 0;
    pieces.forEach((p) => {
      const idx = text.indexOf(p, cursor);
      const ratio = (idx >= 0 ? idx : cursor) / totalChars;
      cursor = (idx >= 0 ? idx : cursor) + p.length;
      const span = Math.max(0, tr.endMs - tr.startMs);
      sentences.push({
        trId: tr.id,
        text: p,
        startMs: Math.round(tr.startMs + ratio * span),
        edited: tr.edited,
      });
    });
  });
  return sentences;
}

function scoreSentence(s, i, total) {
  let score = 0;
  CUE_STRONG.forEach((c) => { if (s.text.includes(c)) score += 3; });
  CUE_MID.forEach((c) => { if (s.text.includes(c)) score += 1.4; });
  const len = s.text.length;
  if (len >= 12 && len <= 70) score += 1.2;
  if (len > 90) score -= 0.8;
  if (/\d/.test(s.text)) score += 0.6;
  if (i < 3) score += 0.4;
  if (i > total - 3) score += 0.5;
  if (/^(嗯|啊|呃|那个|就是|然后就是)/.test(s.text)) score -= 1.2;
  return score;
}

function similar(a, b) {
  if (a === b) return true;
  const setA = new Set(a.slice(0, 24));
  const setB = new Set(b.slice(0, 24));
  let inter = 0;
  setA.forEach((c) => { if (setB.has(c)) inter += 1; });
  return inter / Math.max(1, Math.min(setA.size, setB.size)) > 0.72;
}

function keywordsOf(text, limit = 5) {
  const counts = new Map();
  const cjk = text.replace(/[^\u4e00-\u9fa5]/g, ' ');
  cjk.split(/\s+/).forEach((chunk) => {
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= chunk.length; i += 1) {
        const gram = chunk.slice(i, i + n);
        if ([...gram].some((c) => STOP_CHARS.includes(c))) continue;
        if (new Set(gram).size === 1) continue;
        counts.set(gram, (counts.get(gram) || 0) + 1);
      }
    }
  });
  const ranked = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([g, c]) => ({ g, c, s: c * (g.length >= 3 ? 1.5 : 1) }))
    .sort((a, b) => b.s - a.s);
  const picked = [];
  ranked.forEach((item) => {
    if (picked.length >= limit) return;
    if (picked.some((p) => p.includes(item.g) || item.g.includes(p))) return;
    picked.push(item.g);
  });
  return picked;
}

/** 主分析入口 */
export function analyze(transcripts = []) {
  const sentences = collect(transcripts);
  const fullText = transcripts.map((t) => t.text).join(' ').trim();
  if (!sentences.length) {
    return { takeaways: [], todos: [], questions: [], keywords: [], sentences: [], fullText };
  }

  const scored = sentences
    .map((s, i) => ({ ...s, score: scoreSentence(s, i, sentences.length) }))
    .sort((a, b) => b.score - a.score);

  const takeaways = [];
  scored.forEach((s) => {
    if (takeaways.length >= 4) return;
    if (s.text.length < 8) return;
    if (takeaways.some((t) => similar(t.text, s.text))) return;
    if (s.score < 1) return;
    takeaways.push({ text: s.text, startMs: s.startMs, trId: s.trId });
  });
  if (!takeaways.length) {
    sentences.slice(0, 3).forEach((s) => takeaways.push({ text: s.text, startMs: s.startMs, trId: s.trId }));
  }

  const todos = sentences
    .filter((s) => TODO_CUE.some((c) => s.text.includes(c)) && s.text.length > 6)
    .slice(0, 6)
    .map((s) => ({ text: s.text, startMs: s.startMs, trId: s.trId }));

  const questions = sentences
    .filter((s) => QUESTION_CUE.some((c) => s.text.includes(c)))
    .slice(0, 6)
    .map((s) => ({ text: s.text, startMs: s.startMs, trId: s.trId }));

  return {
    takeaways,
    todos,
    questions,
    keywords: keywordsOf(fullText, 5),
    sentences,
    fullText,
  };
}

/** 从文稿里找一个像标题的短语 */
export function suggestTitle(transcripts = []) {
  const text = transcripts.map((t) => t.text).join(' ').trim();
  if (!text) return '';
  const first = splitSentences(text)[0] || text;
  const short = first.replace(/^[嗯啊呃那个就是，。\s]+/, '').slice(0, 14);
  return short.replace(/[，。！？,.\s]+$/, '');
}

export function countFlags(transcripts = []) {
  const a = analyze(transcripts);
  return { key: a.takeaways.length, todo: a.todos.length, q: a.questions.length };
}
