/**
 * 总结服务：按人员总结 + 整场会议总结
 * ------------------------------------------------------------------
 * 对应产品规范第 6 章、技术规范第 10 章。
 *
 * 硬约束（任何一条都不能放过）：
 * 1. 建议不等于决策，讨论内容不等于承诺；
 * 2. 不凭空推断负责人，负责人可以为空并标记待确认；
 * 3. 截止时间只在原文明确出现时提取；
 * 4. 每条结论必须能回链到原始转录片段；
 * 5. 原始转录与 AI 总结分开保存，重建总结不修改原文。
 *
 * 默认走本机规则抽取（确定性、可审计）；配置了大模型后可选择重写，
 * 但输出必须通过来源校验，不合格的条目直接丢弃。
 */

import {
  listTranscripts, listSpeakers, putMeetingSummary, putSpeakerSummary,
  addSummarySources, clearSummaries, listActionItems, putActionItem,
} from './store.js';
import { splitSentences, analyze } from './ai.js';
import { fmtDur } from './util.js';
import { T } from './i18n.js';
import { llmReady } from './correct.js';

/* ── 线索词 ── */
const RE = {
  open: /(还没|没有定|待定|不确定|再讨论|下次再说|没确认|尚未)/,
  question: /[？?]|(是否|怎么|为什么|如何|多少|能不能|要不要|有没有|行不行|可不可以|吗$)/,
  commitment: /(我来|我负责|我跟|我这边|我去|包在|我明天|我下周|我今天|我今晚|我负责)/,
  decision: /(决定|定了|结论|拍板|就这么|统一到|敲定|确定用|确定按|通过|一致同意)/,
  suggestion: /(建议|不如|要不|可以考虑|我倾向|方案是|可以试|是不是可以|我觉得可以)/,
  /* 待办不靠单个“需要/记得”就认定：要求句、条件规则句都不算承诺（规范 6.3） */
  actionCue: /(我来|我负责|我跟|我这边|我去|我明天|我下周|我今天|我今晚|记得|别忘了|待办|跟进|落实|务必|请你|帮忙|麻烦|需要)/,
  actionVerb: /(整理|准备|输出|提交|发到|发给|发送|同步|跟进|确认|核对|补充|更新|修复|清理|验收|排期|安排|联系|回复|写好|写完|写成|改一下|拆分|拉齐|对齐|落地|上线|归档|统计|评估|排查|复现|开会)/,
  due: /((下周|本周|这周)?周[一二三四五六日天]|下周|明天|后天|今天|月底前?|下月|(一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)|\d{1,2}月\d{1,2}[日号]|\d{1,2}[日号]前)/,
  firstPerson: /(我来|我负责|我跟|我这边|我去|我明天|我下周|我今天|我今晚)/,
};

const MAX_ITEMS = 6;

/** 条件句是规则，不是承诺（“如果发现问题就当天同步”只是流程说明） */
const COND = /^(如果|要是|一旦|万一|只要|凡是|假如|倘若|若是)/;

/**
 * 是否算一条待办：
 * 1. 有行动线索词 + 具体动作动词，缺一不可；
 * 2. 条件从句开头的句子、纯要求/描述句不算；
 * 3. 只是“需要有人管”这种没有动作对象的话不算。
 * 宁可漏一条让人自己补，也不要把讨论写成承诺（规范 6.3-2）。
 */
function isAction(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (COND.test(t) || /^(另外|还有|顺便)?(如果|要是|一旦|万一)/.test(t)) return false;
  if (!RE.actionCue.test(t)) return false;
  if (!RE.actionVerb.test(t)) return false;
  // “需要覆盖/需要一起验证/需要提前考虑”这类没有交付物的表述不算待办
  if (/需要(覆盖|一起|保证|注意|考虑|重视|关注)/.test(t)) return false;
  return true;
}

function sentencesOf(trs) {
  const out = [];
  trs.forEach((tr) => {
    const text = tr.text || '';
    if (!text.trim()) return;
    const total = Math.max(1, text.length);
    let cursor = 0;
    splitSentences(text).forEach((p) => {
      const idx = text.indexOf(p, cursor);
      const at = idx >= 0 ? idx : cursor;
      cursor = at + p.length;
      out.push({
        text: p,
        trId: tr.id,
        speakerId: tr.speakerId || null,
        startMs: Math.round((tr.startMs || 0) + (at / total) * Math.max(0, (tr.endMs || 0) - (tr.startMs || 0))),
        endMs: tr.endMs || 0,
      });
    });
  });
  return out;
}

function itemOf(s) {
  return { text: s.text, src: [{ trId: s.trId, startMs: s.startMs }] };
}

function dueOf(text) {
  const m = text.match(RE.due);
  return m ? m[0] : '';
}

function pushUnique(list, s) {
  if (list.length >= MAX_ITEMS) return;
  if (list.some((x) => x.text === s.text)) return;
  list.push(itemOf(s));
}

/**
 * 会议场景的规则抽取：议题 / 讨论 / 决策 / 未决问题 / 各方观点 / 待办。
 * @param {Array} trs 转录段
 * @param {Array} speakers 发言人记录
 */
function extractMeetingSummaries(trs, speakers) {
  const sents = sentencesOf(trs);
  const bySpeaker = new Map();
  sents.forEach((s) => {
    if (!s.speakerId) return;
    if (!bySpeaker.has(s.speakerId)) bySpeaker.set(s.speakerId, []);
    bySpeaker.get(s.speakerId).push(s);
  });

  const pendingActions = [];
  const speakerPayloads = new Map();

  speakers.forEach((spk) => {
    const own = bySpeaker.get(spk.id) || [];
    const payload = {
      overview: '',
      keyPoints: [],
      questions: [],
      suggestions: [],
      decisions: [],
      commitments: [],
      actionItems: [],
      sampleCount: own.length,
      speechMs: own.reduce((n, s) => n + Math.max(0, (trs.find((t) => t.id === s.trId)?.endMs || 0) - s.startMs), 0),
    };
    own.forEach((s) => {
      const text = s.text;
      if (RE.open.test(text)) {
        // 未决问题单独归入问题列表，避免被当成结论
        pushUnique(payload.questions, s);
        return;
      }
      if (RE.question.test(text)) {
        pushUnique(payload.questions, s);
        return;
      }
      if (RE.commitment.test(text)) {
        pushUnique(payload.commitments, s);
        const due = dueOf(text);
        if (pendingActions.length < 12) {
          pendingActions.push({
            text,
            speakerId: spk.id,
            ownerId: spk.id,
            ownerName: spk.displayName || '',
            ownerConfirmed: spk.identityStatus === 'confirmed' ? 1 : 0,
            dueText: due,
            transcriptId: s.trId,
            startMs: s.startMs,
          });
          pushUnique(payload.actionItems, s);
        }
        return;
      }
      if (RE.decision.test(text)) {
        pushUnique(payload.decisions, s);
        return;
      }
      if (RE.suggestion.test(text)) {
        pushUnique(payload.suggestions, s);
        return;
      }
      if (isAction(text)) {
        // 只有第一人称承诺才敢认定负责人；其余一律待确认（规范 6.3-3）
        const first = RE.firstPerson.test(text);
        if (pendingActions.length < 12) {
          pendingActions.push({
            text,
            speakerId: spk.id,
            ownerId: first ? spk.id : null,
            ownerName: first ? (spk.displayName || '') : '',
            ownerConfirmed: first && spk.identityStatus === 'confirmed' ? 1 : 0,
            dueText: dueOf(text),
            transcriptId: s.trId,
            startMs: s.startMs,
          });
          pushUnique(payload.actionItems, s);
        }
        return;
      }
      pushUnique(payload.keyPoints, s);
    });

    const topics = analyze(own.map((s) => ({ id: s.trId, text: s.text, startMs: s.startMs, endMs: s.startMs }))).keywords;
    payload.topics = topics.slice(0, 3);
    payload.overview = own.length
      ? T('sum.personOverview', {
        name: spk.displayName || T('spk.unnamed', { n: spk.order || 1 }),
        n: own.length,
        dur: fmtDur(payload.speechMs),
        topics: topics.slice(0, 3).join(T('common.listSep')) || T('sum.noTopic'),
      })
      : T('sum.personEmpty');
    payload.keyPoints = payload.keyPoints.slice(0, 4);
    payload.questions = payload.questions.slice(0, 4);
    payload.suggestions = payload.suggestions.slice(0, 4);
    payload.decisions = payload.decisions.slice(0, 4);
    payload.commitments = payload.commitments.slice(0, 4);
    payload.actionItems = payload.actionItems.slice(0, 5);
    speakerPayloads.set(spk.id, payload);
  });

  const all = analyze(trs);
  const totalMs = trs.reduce((n, t) => n + Math.max(0, (t.endMs || 0) - (t.startMs || 0)), 0);
  const decisions = [];
  const openQ = [];
  const discussion = [];
  sents.forEach((s) => {
    if (RE.open.test(s.text) || RE.question.test(s.text)) { pushUnique(openQ, s); return; }
    if (RE.decision.test(s.text)) { pushUnique(decisions, s); return; }
    pushUnique(discussion, s);
  });

  const opinions = speakers
    .filter((s) => (bySpeaker.get(s.id) || []).length)
    .slice(0, 6)
    .map((s) => {
      const own = bySpeaker.get(s.id) || [];
      const top = own.slice().sort((a, b) => b.text.length - a.text.length)[0];
      return {
        speakerId: s.id,
        name: s.displayName || T('spk.unnamed', { n: s.order || 1 }),
        text: top?.text || '',
        src: top ? [{ trId: top.trId, startMs: top.startMs }] : [],
      };
    });

  const meeting = {
    scenario: 'meeting',
    overview: T('sum.meetingOverview', {
      n: speakers.filter((s) => (bySpeaker.get(s.id) || []).length).length,
      dur: fmtDur(totalMs),
      seg: trs.length,
      topics: all.keywords.slice(0, 4).join(T('common.listSep')) || T('sum.noTopic'),
    }),
    topics: all.keywords.slice(0, 5).map((k) => ({ text: k, src: [] })),
    discussionPoints: discussion.slice(0, 6),
    participantOpinions: opinions,
    confirmedDecisions: decisions.slice(0, 5),
    unresolvedQuestions: openQ.slice(0, 5),
    actionItems: pendingActions.slice(0, 8),
    counts: {
      speakers: speakers.length,
      segments: trs.length,
      decisions: decisions.length,
      open: openQ.length,
      actions: pendingActions.length,
    },
  };

  return { meeting, bySpeaker: speakerPayloads };
}

/* ══════════════════════════════════════════
   场景化整理：会议 / 课堂 / 访谈 / 备忘（产品文档 2.3）
   —— 只换结构，不换底线：每条仍须可回链、负责人仍可空
   ══════════════════════════════════════════ */

export const SCENARIOS = ['meeting', 'class', 'interview', 'memo'];

const EMPHASIS = /(重点|关键|核心|要注意|注意|考点|必考|易错|容易错|记住|划重点|小结|总结一下|强调|重要的是)/;
const FOLLOW_UP = /(下次|回头|再确认|再讨论|待定|后续|稍后|再约|跟进)/;
const REMIND = /(提醒|记得|别忘了|别忘|要交|截止|到期)/;
const CHAPTER_GAP = 90 * 1000;       // 停顿 90 秒以上视为换章节
const CHAPTER_SPAN = 5 * 60 * 1000;  // 单章最长 5 分钟，避免长段独白吞掉整场
const CHAPTER_ITEMS = 6;             // 单章最多 6 句：短录音也要能分出段落

/** 场景：本条记录自己的选择优先，其次设置里的强制值，最后按文件夹推断 */
export function scenarioOf(rec, settings = {}) {
  const own = rec?.reportScenario;
  if (own && SCENARIOS.includes(own)) return own;
  const forced = settings.summaryScenario;
  if (forced && forced !== 'auto' && SCENARIOS.includes(forced)) return forced;
  const f = String(rec?.folder || '');
  if (/课堂|课程|讲座|教学|class|lecture|course/i.test(f)) return 'class';
  if (/访谈|采访|interview/i.test(f)) return 'interview';
  if (/备忘|速记|memo|note/i.test(f)) return 'memo';
  return 'meeting';
}

function nameOf(spk) {
  return spk ? (spk.displayName || T('spk.unnamed', { n: spk.order || 1 })) : T('spk.unknown');
}

function totalMsOf(trs) {
  return trs.reduce((n, t) => n + Math.max(0, (t.endMs || 0) - (t.startMs || 0)), 0);
}

function keywordsOf(trs, n = 4) {
  return analyze(trs).keywords.slice(0, n).join(T('common.listSep')) || T('sum.noTopic');
}

/** 按时间间隔切章；单句碎章并入前一块 */
function chaptersOf(sents) {
  const blocks = [];
  let cur = null;
  sents.forEach((s) => {
    if (!cur) { cur = { startMs: s.startMs, endMs: s.endMs || s.startMs, items: [s] }; return; }
    const gap = s.startMs - cur.endMs;
    const span = (s.endMs || s.startMs) - cur.startMs;
    if (gap > CHAPTER_GAP || span > CHAPTER_SPAN || cur.items.length >= CHAPTER_ITEMS) {
      blocks.push(cur);
      cur = { startMs: s.startMs, endMs: s.endMs || s.startMs, items: [s] };
    } else {
      cur.items.push(s);
      cur.endMs = Math.max(cur.endMs, s.endMs || s.startMs);
    }
  });
  if (cur) blocks.push(cur);
  const out = [];
  blocks.forEach((b) => {
    if (b.items.length < 2 && out.length) {
      const prev = out[out.length - 1];
      prev.items.push(...b.items);
      prev.endMs = Math.max(prev.endMs, b.endMs);
    } else out.push(b);
  });
  return out;
}

function chapterTitle(items) {
  const kw = analyze(items.map((s) => ({ id: s.trId, text: s.text, startMs: s.startMs, endMs: s.endMs }))).keywords;
  if (kw.length) return kw.slice(0, 2).join(T('common.listSep'));
  const first = items[0]?.text || '';
  return first.length > 16 ? `${first.slice(0, 16)}…` : first;
}

/** 跨场景共用：把承诺与行动句收成待办（第一人称才敢署名） */
function collectActions(sents, speakers) {
  const byId = new Map(speakers.map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  sents.forEach((s) => {
    if (out.length >= 8) return;
    const spk = byId.get(s.speakerId);
    if (!spk) return;
    const text = s.text;
    if (!RE.commitment.test(text) && !isAction(text)) return;
    if (seen.has(text)) return;
    seen.add(text);
    const first = RE.firstPerson.test(text);
    out.push({
      text,
      speakerId: spk.id,
      ownerId: first ? spk.id : null,
      ownerName: first ? (spk.displayName || '') : '',
      ownerConfirmed: first && spk.identityStatus === 'confirmed' ? 1 : 0,
      dueText: dueOf(text),
      transcriptId: s.trId,
      startMs: s.startMs,
      src: [{ trId: s.trId, startMs: s.startMs }],
    });
  });
  return out;
}

/** 课堂：章节 / 知识点 / 重点 / 复习提纲 */
function extractClassSummaries(trs, speakers) {
  const base = extractMeetingSummaries(trs, speakers); // 复用按人员分区
  const sents = sentencesOf(trs);
  const blocks = chaptersOf(sents);

  const chapters = blocks.map((b, i) => {
    const points = [];
    b.items.forEach((s) => {
      if (RE.question.test(s.text)) return;
      if (isAction(s.text)) return;
      pushUnique(points, s);
    });
    return {
      index: i + 1,
      title: chapterTitle(b.items),
      startMs: b.startMs,
      endMs: b.endMs,
      points,
    };
  }).filter((c) => c.points.length);

  const keyPoints = [];
  const emphasis = [];
  sents.forEach((s) => {
    if (RE.question.test(s.text)) return;
    if (EMPHASIS.test(s.text)) pushUnique(emphasis, s);
    pushUnique(keyPoints, s);
  });

  const reviewOutline = chapters.map((c) => ({
    title: c.title,
    items: c.points.slice(0, 3),
  }));
  const actions = collectActions(sents, speakers);

  const meeting = {
    scenario: 'class',
    overview: T('sum.classOverview', {
      n: chapters.length,
      dur: fmtDur(totalMsOf(trs)),
      seg: trs.length,
      topics: keywordsOf(trs),
    }),
    topics: analyze(trs).keywords.slice(0, 5).map((k) => ({ text: k, src: [] })),
    chapters,
    keyPoints: keyPoints.slice(0, 6),
    emphasis: emphasis.slice(0, 5),
    reviewOutline,
    actionItems: actions,
    counts: {
      speakers: speakers.length,
      segments: trs.length,
      chapters: chapters.length,
      emphasis: emphasis.length,
      actions: actions.length,
    },
  };
  return { meeting, bySpeaker: base.bySpeaker };
}

/** 访谈：问答对 / 主题 / 关键陈述 / 待跟进 */
function extractInterviewSummaries(trs, speakers) {
  const base = extractMeetingSummaries(trs, speakers);
  const sents = sentencesOf(trs);

  const qa = [];
  let pending = null;
  sents.forEach((s) => {
    if (RE.question.test(s.text)) {
      if (pending && pending.answer.length) qa.push(pending);
      pending = { question: s, answer: [] };
      return;
    }
    if (!pending) return;
    if (pending.answer.length >= 3) { qa.push(pending); pending = null; return; }
    pending.answer.push(s);
  });
  if (pending && pending.answer.length) qa.push(pending);

  const quotes = sents
    .filter((s) => !RE.question.test(s.text) && s.text.length >= 12)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 4)
    .map((s) => ({ text: s.text, speakerId: s.speakerId, src: [{ trId: s.trId, startMs: s.startMs }] }));
  const actions = collectActions(sents, speakers);

  const followUps = [];
  sents.forEach((s) => {
    if (FOLLOW_UP.test(s.text) && RE.question.test(s.text)) pushUnique(followUps, s);
  });

  const meeting = {
    scenario: 'interview',
    overview: T('sum.interviewOverview', {
      q: qa.length,
      dur: fmtDur(totalMsOf(trs)),
      seg: trs.length,
      topics: keywordsOf(trs),
    }),
    topics: analyze(trs).keywords.slice(0, 5).map((k) => ({ text: k, src: [] })),
    qa: qa.slice(0, 8).map((p) => ({
      question: { text: p.question.text, src: [{ trId: p.question.trId, startMs: p.question.startMs }] },
      questionSpeakerId: p.question.speakerId,
      answer: {
        text: p.answer.map((a) => a.text).join(''),
        src: [{ trId: p.answer[0].trId, startMs: p.answer[0].startMs }],
      },
      answerSpeakerId: p.answer[0].speakerId,
      startMs: p.question.startMs,
    })),
    quotes,
    followUps: followUps.slice(0, 5),
    actionItems: actions,
    counts: {
      speakers: speakers.length,
      segments: trs.length,
      qa: qa.length,
      quotes: quotes.length,
      actions: actions.length,
    },
  };
  return { meeting, bySpeaker: base.bySpeaker };
}

/** 备忘：要点 / 提醒 */
function extractMemoSummaries(trs, speakers) {
  const base = extractMeetingSummaries(trs, speakers);
  const sents = sentencesOf(trs);

  const keyPoints = [];
  const reminders = [];
  const actions = collectActions(sents, speakers);
  sents.forEach((s) => {
    if (REMIND.test(s.text) || (RE.due.test(s.text) && !RE.question.test(s.text))) {
      pushUnique(reminders, s);
      return;
    }
    if (RE.question.test(s.text)) return;
    if (isAction(s.text)) return;
    pushUnique(keyPoints, s);
  });

  const meeting = {
    scenario: 'memo',
    overview: T('sum.memoOverview', {
      seg: trs.length,
      dur: fmtDur(totalMsOf(trs)),
      topics: keywordsOf(trs),
    }),
    topics: analyze(trs).keywords.slice(0, 5).map((k) => ({ text: k, src: [] })),
    keyPoints,
    reminders,
    unresolvedQuestions: [],
    actionItems: actions,
    counts: {
      speakers: speakers.length,
      segments: trs.length,
      reminders: reminders.length,
      actions: actions.length,
    },
  };
  return { meeting, bySpeaker: base.bySpeaker };
}

/**
 * 规则抽取分发器。
 * @param {Array} trs
 * @param {Array} speakers
 * @param {{scenario?:'meeting'|'class'|'interview'|'memo'}} opts
 */
export function extractSummaries(trs, speakers, opts = {}) {
  switch (opts.scenario) {
    case 'class': return extractClassSummaries(trs, speakers);
    case 'interview': return extractInterviewSummaries(trs, speakers);
    case 'memo': return extractMemoSummaries(trs, speakers);
    default: return extractMeetingSummaries(trs, speakers);
  }
}

/* ══════════════════════════════════════════
   可选：大模型重写（输出必须可回链）
   ══════════════════════════════════════════ */

const LLM_SYSTEM = `你是内容整理助手。只依据给定的发言逐条整理，不得补充原文没有的信息。
规则：建议不能写成已通过的决策；讨论不能写成承诺；没有明确依据时负责人为 null；截止时间只为原文明确出现的值。
按指定的场景结构输出，每条结论必须给出 src（对应发言行号数组）。输出严格 JSON。`;

/** 各场景要模型输出的结构（会议沿用原 schema，历史总结仍可读） */
const LLM_SHAPES = {
  meeting: `{
 "meeting": {
   "overview": "一段话概括",
   "topics": ["议题"],
   "discussion": [{"text":"讨论要点","src":[行号]}],
   "opinions": [{"who":发言人序号,"text":"观点","src":[行号]}],
   "decisions": [{"text":"已确认决策","src":[行号]}],
   "open": [{"text":"未解决问题","src":[行号]}],
   "actions": [{"text":"待办","owner":发言人序号或null,"due":"原文中的截止时间或空","src":[行号]}]
 }`,
  class: `{
 "meeting": {
   "overview": "一段话概括这节课讲了什么",
   "topics": ["主题"],
   "chapters": [{"title":"小节标题（用原文里的说法）","points":[{"text":"该节要点","src":[行号]}]}],
   "key_points": [{"text":"知识点","src":[行号]}],
   "emphasis": [{"text":"讲者明确强调、易错、考点","src":[行号]}],
   "actions": [{"text":"作业或任务","owner":null,"due":"","src":[行号]}]
 }`,
  interview: `{
 "meeting": {
   "overview": "一段话概括受访者说了什么",
   "topics": ["话题"],
   "qa": [{"question":"提问原话","answer":"回答要点","who":受访者序号,"src":[行号]}],
   "quotes": [{"text":"关键陈述原话","src":[行号]}],
   "follow_ups": [{"text":"需要后续确认或追问的点","src":[行号]}],
   "actions": [{"text":"待跟进","owner":null,"due":"","src":[行号]}]
 }`,
  memo: `{
 "meeting": {
   "overview": "一段话概括",
   "topics": ["主题"],
   "key_points": [{"text":"要点","src":[行号]}],
   "reminders": [{"text":"需要注意或到期的提醒","src":[行号]}],
   "actions": [{"text":"待办","owner":null,"due":"","src":[行号]}]
 }`,
};

function pickItems(rows, trs) {
  const out = [];
  (rows || []).forEach((r) => {
    const text = String(r?.text || '').trim();
    if (!text) return;
    const src = (Array.isArray(r.src) ? r.src : [])
      .map((i) => trs[Number(i)])
      .filter(Boolean)
      .map((t) => ({ trId: t.id, startMs: t.startMs }));
    if (!src.length) return; // 无法追溯的条目一律丢弃
    out.push({ text, src });
  });
  return out.slice(0, MAX_ITEMS);
}

/** 待办统一解析：owner 只在模型给出且能对应到人时才算确认 */
function mapActions(rows, trs, speakers) {
  const orderOf = new Map(speakers.map((s) => [s.order, s]));
  return (rows || []).map((a) => {
    const src = pickItems([{ text: a.text, src: a.src }], trs)[0]?.src || [];
    const spk = orderOf.get(Number(a.owner));
    return {
      text: String(a.text || ''),
      speakerId: orderOf.get(Number(a.who ?? a.owner))?.id || null,
      ownerId: spk?.id || null,
      ownerName: spk?.displayName || '',
      ownerConfirmed: spk?.identityStatus === 'confirmed' ? 1 : 0,
      dueText: String(a.due || ''),
      transcriptId: src[0]?.trId || null,
      startMs: src[0]?.startMs || 0,
      src,
    };
  }).filter((a) => a.text && a.src.length && !COND.test(a.text));
}

/** 按场景把模型输出映射成与规则结果同构的结构 */
function mapLlmMeeting(scenario, raw, trs, speakers) {
  const items = (rows) => pickItems(rows, trs);
  const base = {
    scenario,
    overview: String(raw.overview || ''),
    topics: (raw.topics || []).slice(0, 5).map((x) => ({ text: String(x), src: [] })),
  };
  const actions = mapActions(raw.actions, trs, speakers);

  if (scenario === 'class') {
    const chapters = (raw.chapters || []).map((c, i) => {
      const points = items(c.points);
      return {
        index: i + 1,
        title: String(c.title || ''),
        startMs: points[0]?.src?.[0]?.startMs || 0,
        endMs: 0,
        points,
      };
    }).filter((c) => c.points.length);
    return {
      ...base,
      chapters,
      keyPoints: items(raw.key_points),
      emphasis: items(raw.emphasis),
      reviewOutline: chapters.map((c) => ({ title: c.title, items: c.points.slice(0, 3) })),
      actionItems: actions,
    };
  }

  if (scenario === 'interview') {
    const orderOf = new Map(speakers.map((s) => [s.order, s]));
    return {
      ...base,
      qa: (raw.qa || []).map((q) => {
        const src = pickItems([{ text: q.question, src: q.src }], trs)[0]?.src || [];
        const who = orderOf.get(Number(q.who));
        return {
          question: { text: String(q.question || ''), src },
          questionSpeakerId: null,
          answer: { text: String(q.answer || ''), src },
          answerSpeakerId: who?.id || null,
          startMs: src[0]?.startMs || 0,
        };
      }).filter((q) => q.question.text && q.answer.text && q.question.src.length),
      quotes: (raw.quotes || []).map((x) => {
        const src = pickItems([{ text: x.text, src: x.src }], trs)[0]?.src || [];
        return { text: String(x.text || ''), src };
      }).filter((x) => x.text && x.src.length),
      followUps: items(raw.follow_ups),
      actionItems: actions,
    };
  }

  if (scenario === 'memo') {
    return {
      ...base,
      keyPoints: items(raw.key_points),
      reminders: items(raw.reminders),
      actionItems: actions,
    };
  }

  const orderOf = new Map(speakers.map((s) => [s.order, s]));
  return {
    ...base,
    discussionPoints: items(raw.discussion),
    participantOpinions: (raw.opinions || []).map((o) => {
      const spk = orderOf.get(Number(o.who));
      const src = pickItems([{ text: o.text, src: o.src }], trs)[0]?.src || [];
      return {
        speakerId: spk?.id || null,
        name: spk ? (spk.displayName || T('spk.unnamed', { n: spk.order })) : '',
        text: String(o.text || ''),
        src,
      };
    }).filter((o) => o.text && o.src.length),
    confirmedDecisions: items(raw.decisions),
    unresolvedQuestions: items(raw.open),
    actionItems: actions,
  };
}

const SCENARIO_HINT = { meeting: '会议', class: '课堂 / 讲座', interview: '访谈', memo: '速记备忘' };

/** DeepSeek 支持强制 JSON 输出；其他 OpenAI 兼容端点不一定认这个字段，只在认得的情况下带 */
function jsonMode(cfg) {
  const base = String(cfg.llmBase || '');
  const model = String(cfg.llmModel || '');
  return /deepseek/i.test(base) || /deepseek/i.test(model);
}

/** 调用大模型，返回与 extractSummaries 同构的结构；失败抛错，由调用方回退规则结果 */
export async function llmSummarize({ trs, speakers, settings, scenario = 'meeting' }) {
  if (!llmReady(settings)) throw new Error(T('sum.llmUnset'));
  const base = String(settings.llmBase).replace(/\/+$/, '');
  const lines = trs.map((t, i) => {
    const spk = speakers.find((s) => s.id === t.speakerId);
    const who = spk ? (spk.displayName || `发言人${spk.order}`) : '未识别';
    return `${i}. [${who}] ${t.text}`;
  }).join('\n');

  const shape = LLM_SHAPES[scenario] || LLM_SHAPES.meeting;
  const user = `转录共 ${trs.length} 行（行号从 0 开始），场景：${SCENARIO_HINT[scenario] || '会议'}。
下面是逐行发言：
${lines}

请输出 JSON（meeting 部分按当前场景的结构，speakers 部分是按人员分区）：
${shape},
 "speakers": [
   {"order": 发言人序号, "overview":"一段话", "key_points":[{"text":"","src":[]}],
    "questions":[{"text":"","src":[]}], "suggestions":[{"text":"","src":[]}],
    "decisions":[{"text":"","src":[]}], "commitments":[{"text":"","src":[]}],
    "actions":[{"text":"","src":[]}]}
 ]
}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.llmKey}` },
      body: JSON.stringify({
        model: settings.llmModel || 'gpt-4o-mini',
        temperature: 0.2,
        ...(jsonMode(settings) ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: LLM_SYSTEM }, { role: 'user', content: user }],
      }),
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? T('sum.llmTimeout') : T('sum.llmConn'));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${detail ? ` · ${detail.slice(0, 140)}` : ''}`);
  }
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content || '';
  const jsonText = content.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '').trim() || content.trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(T('sum.llmParse'));
    parsed = JSON.parse(m[0]);
  }

  const orderOf = new Map(speakers.map((s) => [s.order, s]));
  const meeting = mapLlmMeeting(scenario, parsed.meeting || {}, trs, speakers);

  const bySpeaker = new Map();
  (parsed.speakers || []).forEach((row) => {
    const spk = orderOf.get(Number(row.order));
    if (!spk) return;
    bySpeaker.set(spk.id, {
      overview: String(row.overview || ''),
      keyPoints: pickItems(row.key_points, trs),
      questions: pickItems(row.questions, trs),
      suggestions: pickItems(row.suggestions, trs),
      decisions: pickItems(row.decisions, trs),
      commitments: pickItems(row.commitments, trs),
      actionItems: pickItems(row.actions, trs),
      generator: 'llm',
    });
  });
  return { meeting, bySpeaker, generator: 'llm' };
}

/* ══════════════════════════════════════════
   生成并落库
   ══════════════════════════════════════════ */

export function dataVersionOf(trs) {
  return `${trs.length}:${trs.reduce((n, t) => n + (t.rev || 1), 0)}`;
}

function sourceRows({ recordingId, summaryId, kind, payload, sectionMap }) {
  const rows = [];
  Object.entries(sectionMap).forEach(([key, list]) => {
    (list || []).forEach((item, i) => {
      (item.src || []).forEach((s) => {
        rows.push({
          recordingId, summaryId, kind, sectionKey: key, itemIndex: i,
          transcriptId: s.trId, startMs: s.startMs,
        });
      });
    });
  });
  return rows;
}

/**
 * 生成两类总结并写入存储。
 * @param {string} recordingId
 * @param {{settings?:object, generator?:'rules'|'llm', allowLLM?:boolean, scenario?:string}} opts
 */
export async function buildSummaries(recordingId, opts = {}) {
  const settings = opts.settings || {};
  const scenario = SCENARIOS.includes(opts.scenario) ? opts.scenario : 'meeting';
  const trs = await listTranscripts(recordingId);
  const speakers = (await listSpeakers(recordingId)).filter((s) => !s.mergedInto);
  if (!trs.length) return { ok: false, code: 'no-transcript' };

  const dataVersion = dataVersionOf(trs);
  let result = extractSummaries(trs, speakers, { scenario });
  let generator = 'rules';
  let llmError = '';

  if (opts.allowLLM && llmReady(settings)) {
    try {
      const llm = await llmSummarize({ trs, speakers, settings, scenario });
      if (llm.meeting.overview || llm.bySpeaker.size) {
        result = { meeting: { ...llm.meeting, counts: result.meeting.counts }, bySpeaker: llm.bySpeaker };
        generator = 'llm';
      } else {
        llmError = T('sum.llmEmpty');
      }
    } catch (err) {
      // 失败不影响规则结果（规范 8：AI 总结失败，原始数据仍可查看）
      console.warn('大模型总结失败，回退本机规则', err);
      llmError = err?.message || T('sum.llmFail');
      generator = 'rules';
    }
  } else if (opts.allowLLM) {
    llmError = T('sum.llmUnset');
  }

  // 保留已有待办的完成状态
  const prevActions = await listActionItems(recordingId);
  const doneTexts = new Set(prevActions.filter((a) => a.status === 'done').map((a) => a.text));

  await clearSummaries(recordingId);

  const meetingRow = await putMeetingSummary({
    recordingId,
    scenario,
    generator,
    dataVersion,
    payload: result.meeting,
  });
  const flatChapterPoints = (result.meeting.chapters || []).flatMap((c) => c.points || []);
  const qaRows = (result.meeting.qa || []).flatMap((q) => [
    { src: q.question?.src || [] },
    { src: q.answer?.src || [] },
  ]);
  const srcRows = sourceRows({
    recordingId,
    summaryId: meetingRow.id,
    kind: 'meeting',
    sectionMap: {
      discussion: result.meeting.discussionPoints,
      decisions: result.meeting.confirmedDecisions,
      open: result.meeting.unresolvedQuestions,
      opinions: result.meeting.participantOpinions,
      chapters: flatChapterPoints,
      keyPoints: result.meeting.keyPoints,
      emphasis: result.meeting.emphasis,
      qa: qaRows,
      quotes: result.meeting.quotes,
      followUps: result.meeting.followUps,
      reminders: result.meeting.reminders,
    },
  });

  const speakerRows = [];
  for (const spk of speakers) {
    const payload = result.bySpeaker.get(spk.id);
    if (!payload) continue;
    const row = await putSpeakerSummary({
      recordingId, speakerId: spk.id, generator, dataVersion, payload,
    });
    speakerRows.push(row);
    srcRows.push(...sourceRows({
      recordingId,
      summaryId: row.id,
      kind: 'speaker',
      sectionMap: {
        keyPoints: payload.keyPoints,
        questions: payload.questions,
        suggestions: payload.suggestions,
        decisions: payload.decisions,
        commitments: payload.commitments,
      },
    }));
  }
  await addSummarySources(srcRows);

  const actions = [];
  for (const a of result.meeting.actionItems) {
    actions.push(await putActionItem({
      recordingId,
      speakerId: a.speakerId || null,
      text: a.text,
      ownerId: a.ownerId || null,
      ownerName: a.ownerName || '',
      ownerConfirmed: a.ownerConfirmed ? 1 : 0,
      dueText: a.dueText || '',
      status: doneTexts.has(a.text) ? 'done' : 'open',
      transcriptId: a.transcriptId || a.src?.[0]?.trId || null,
      startMs: a.startMs ?? a.src?.[0]?.startMs ?? 0,
    }));
  }

  return {
    ok: true,
    generator,
    llmError,
    dataVersion,
    meeting: meetingRow,
    speakers: speakerRows,
    actions,
    counts: result.meeting.counts,
  };
}

/** 已有总结是否落后于当前转录（用于提示“内容已变更，请重新生成”） */
export function isStale(summary, trs) {
  if (!summary) return false;
  return summary.dataVersion !== dataVersionOf(trs);
}
