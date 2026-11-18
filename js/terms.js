/**
 * 术语抽取：从一篇文稿里把「值得对号入座」的词捞出来
 *
 * 场景：会议里反复出现的产品名、项目代号、人名、英文缩写，识别引擎第一次往往写对、
 * 第二次就按同音写错了。逐个去词库里手敲太慢，所以让程序先把候选列出来，人只需要勾选。
 *
 * 两条产出，区别很重要：
 *   - **配对**（`错写=正写`）——文稿里确实存在同音异形的低频写法，加进去立刻生效；
 *   - **单词**（只有正写）——没有找到错写，但它是个专有名词，先记为术语，
 *     供后续同音归一参考，也不会被纠错引擎误伤。
 *
 * 判定不靠词典，靠统计：一篇文稿里反复出现的 2–6 字片段，若总是作为更长的词出现，
 * 那它只是那个长词的一部分，不算独立术语。
 */
import { parseDict, phonicSim, syllableOf } from './correct.js';

/** 高频虚词与通用词：它们出现次数最多，但抽出来毫无意义 */
const STOP = new Set((
  '的了是在我你他她它这那有和就不都也很到说要去会着没看好自己我们你们他们'
  + '可以什么怎么因为所以但是然后如果现在时候这个那个还是就是没有一些一个这样'
  + '那样知道觉得应该可能已经比较非常真的其实东西问题事情地方时间今天明天昨天'
  + '大家咱们他们咱们自己别人一个两个几个多少哪里什么怎么为什么怎么样'
  + '嗯啊哦呃唉诶呀吧呢吗嘛哈对好行OKok'
).match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z]+/g) || []);

/**
 * 字级停用：候选的**首字或尾字**落在里面就丢弃。
 * 语音转写的边界错误几乎都是「多带一个虚词」——「百炼直连的」「要确认」「这个产品」，
 * 靠这一条就能砍掉大半噪音，而且比黑名单更通用。
 */
const EDGE_STOP = new Set('的了着过是在和与及或就都也还很太更最我你他她它这那有个要会能可以把被让给对从向于为以之其此该些每各某咱们啊吧呢吗呀嘛哦嗯一二三四五六七八九十'.split(''));

/** 通用名词：任意行业都在说，进词库只会有害（把正常词替换成它自己） */
const GENERIC = new Set([
  '产品', '用户', '系统', '功能', '版本', '时间', '问题', '内容', '公司', '项目',
  '团队', '需求', '数据', '设计', '开发', '测试', '会议', '讨论', '成本', '情况', '方式', '部分',
  '工作', '业务', '技术', '平台', '服务', '客户', '市场', '目标', '结果', '原因', '过程',
  /* 会议里最常出现、但放进词库毫无意义的口头通用词 */
  '确认', '建议', '需要', '发现', '支持', '安排', '验证', '处理', '完成', '开始', '结束',
  '检查', '跟进', '沟通', '反馈', '上线', '发布', '优化', '调整', '准备', '整理', '同步',
  '记录', '提供', '包括', '通过', '进行', '使用', '出现', '认为', '表示', '强调', '提出',
  '回滚', '灰度', '监控', '报警', '日志', '接口', '字段', '文档', '流程', '方案', '标准',
]);

/** 出现频率高但语义为零的短语，专门用来挡噪音 */
const NOISE = new Set([
  '一下', '这个', '那个', '这样', '那样', '的话', '时候', '一个', '我们', '他们',
  '什么', '怎么', '可以', '没有', '就是', '还是', '然后', '自动', '另外', '如果',
  '而且', '并且', '或者', '不过', '只是', '首先', '其次', '最后', '目前', '之后',
  '之前', '同时', '一般', '基本', '大概', '必须', '一定', '肯定', '确实', '实际',
  '具体', '主要', '重要', '简单', '复杂', '容易', '困难', '当前', '以后', '以前',
  '这次', '那次', '上次', '下次', '每次', '当天', '上午', '下午', '晚上', '今天',
  '明天', '昨天', '一些', '一点', '有点', '比较', '非常', '还是', '只有', '已经',
]);

/** 英文里的常见词，不该进术语表 */
const EN_STOP = new Set((
  'the and for with that this from have will your you are not but can all any our out '
  + 'has had was were been they their them there then than when what which who how why '
  + 'ok okok yes yeah just very much more most some such only also into over under about '
  + 'after before while because through would could should shall may might must do does did'
).split(/\s+/));

const CJK = /[\u4e00-\u9fa5]/;

/** 按标点/换行切句，术语不会跨句 */
function sentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/** 只保留连续的汉字段做 n-gram，避免把数字、英文、标点搅进来 */
function hanRuns(s) {
  return s.match(/[\u4e00-\u9fa5]+/g) || [];
}

function gramCounts(list, sizes) {
  const map = new Map();
  list.forEach((s) => {
    hanRuns(s).forEach((run) => {
      sizes.forEach((n) => {
        for (let i = 0; i + n <= run.length; i += 1) {
          const g = run.slice(i, i + n);
          let st = map.get(g);
          if (!st) { st = { hits: 0, left: new Set(), right: new Set() }; map.set(g, st); }
          st.hits += 1;
          /* 记录左右邻字：一个真正的词，左右邻会变（「百炼直连的」「百炼直连如果」）；
             一段固定串则不会（「炼直连的下行」永远前面是「百」、后面是「延」）。 */
          st.left.add(i > 0 ? run[i - 1] : '^');
          st.right.add(i + n < run.length ? run[i + n] : '$');
        }
      });
    });
  });
  return map;
}

const allStop = (s) => {
  /* 逐字都在停用字表里才算虚词串：单字表用整串反查太严，「第一天」会被误杀 */
  for (const ch of s) {
    if (!STOP.has(ch)) return false;
  }
  return true;
};

/**
 * @param {Array} trs 转录段
 * @param {object} opts
 * @param {string} opts.customDict 现有词库原文（判断是否已收录）
 * @param {number} opts.limit 候选上限
 * @returns {{terms: Array, stats: object}}
 */
export function extractTerms(trs = [], { customDict = '', limit = 24 } = {}) {
  const texts = trs.map((t) => String(t.text || '')).filter(Boolean);
  const full = texts.join('\n');
  const sents = sentences(full);
  if (!full.trim()) return { terms: [], stats: { sentences: 0, chars: 0 } };

  const existed = new Set(parseDict(customDict).map((p) => p.to));
  const existedFrom = new Set(parseDict(customDict).map((p) => p.from));

  const grams = gramCounts(sents, [2, 3, 4, 5, 6]);
  /* 短文稿门槛要低一些，否则两三句话什么也抽不出来 */
  const minHits = sents.length >= 12 ? 3 : 2;
  const cands = [];

  grams.forEach((st, g) => {
    const hits = st.hits;
    if (hits < minHits) return;
    if (!CJK.test(g)) return;
    if (allStop(g)) return;
    if (g.length < 2) return;
    /* 首尾带虚词的是切词毛边，不是术语 */
    if (EDGE_STOP.has(g[0]) || EDGE_STOP.has(g[g.length - 1])) return;
    if (NOISE.has(g)) return;
    if (g.length <= 2 && GENERIC.has(g)) return;
    /* 两个字只出现两次的，多半是「产品」「确认」这种通用词；
       三字以上才放宽到两次——「回滚方案」「产品评审」这种正是要的 */
    if (!(hits >= 3 || (g.length >= 3 && hits >= 2))) return;
    /* 左右邻都只有一个字：它只是某段固定长串的中间一段，不是独立的词 */
    if (st.left.size <= 1 && st.right.size <= 1 && hits >= 2) return;
    cands.push({ term: g, hits, len: g.length });
  });

  /* 最长优先：若某个候选基本只作为更长候选的一部分出现（次数不少于它的七成），
     那它自己不是词，只是那个长词的一段——「产品」让位给「产品评审」。
     门槛取 0.75 而不是 1：放宽一点点能清掉「的」字被切掉后残留的残词，
     又不至于把真正独立的高频词（听文）也一起吞掉。 */
  const kept = cands.filter((c) => {
    if (c.len >= 6) return true;
    for (const other of cands) {
      if (other.len <= c.len || other.len > c.len + 2) continue;
      if (other.hits < c.hits * 0.75) continue;
      if (other.term.includes(c.term)) return false;
    }
    return true;
  });

  kept.sort((a, b) => (b.hits * Math.min(b.len, 4)) - (a.hits * Math.min(a.len, 4)));

  /* 同音异形的低频写法：只在长度 2–4 上找，太长的组合噪音大 */
  const rare = [];
  grams.forEach((st, g) => {
    if (st.hits === 1 && CJK.test(g) && g.length >= 2 && g.length <= 4) rare.push(g);
  });

  const sampleOf = (term) => sents.find((s) => s.includes(term)) || '';
  const terms = [];

  for (const c of kept) {
    if (terms.length >= limit) break;
    if (existed.has(c.term)) continue;

    let pair = null;
    if (c.len <= 4) {
      let checked = 0;
      for (const r of rare) {
        if (checked > 400 || terms.length >= limit) break;
        if (r.length !== c.len || r === c.term) continue;
        if (existedFrom.has(r)) continue;
        let sameSound = true;
        for (let i = 0; i < r.length; i += 1) {
          if (r[i] === c.term[i]) continue;
          const a = syllableOf(r[i]);
          const b = syllableOf(c.term[i]);
          if (!a || a !== b) { sameSound = false; break; }
        }
        if (!sameSound) continue;
        if (phonicSim(r, c.term) < 0.9) continue;
        pair = { from: r, to: c.term };
        break;
      }
    }

    terms.push({
      term: c.term,
      hits: c.hits,
      kind: 'zh',
      sample: sampleOf(c.term),
      pair,
    });
  }

  /* 英文与缩写：出现两次以上，或带大写/数字的专有写法 */
  const enMap = new Map();
  (full.match(/[A-Za-z][A-Za-z0-9+#._-]{1,19}/g) || []).forEach((w) => {
    const key = w;
    enMap.set(key, (enMap.get(key) || 0) + 1);
  });
  const enList = [...enMap.entries()]
    .filter(([w, n]) => !EN_STOP.has(w.toLowerCase()) && (n >= 2 || /[A-Z].*[A-Z]|\d/.test(w)))
    .sort((a, b) => b[1] - a[1]);

  for (const [w, n] of enList) {
    if (terms.length >= limit + 8) break;
    if (existed.has(w)) continue;
    if (terms.some((t) => t.term === w)) continue;
    terms.push({ term: w, hits: n, kind: 'en', sample: sampleOf(w), pair: null });
  }

  return {
    terms,
    stats: { sentences: sents.length, chars: full.length },
  };
}

/** 把勾选的候选拼成词库行：有配对写 `错=对`，没有就单列术语 */
export function termLines(selected = []) {
  return selected.map((t) => (t.pair ? `${t.pair.from}=${t.pair.to}` : t.term));
}

/** 追加到现有词库文本，自动去重、保留原有注释与空行顺序 */
export function appendDict(customDict = '', lines = []) {
  const cur = String(customDict || '');
  const have = new Set(cur.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  const add = lines
    .map((x) => String(x || '').trim())
    .filter((x) => x && !have.has(x));
  if (!add.length) return { text: cur, added: 0 };
  const head = cur.replace(/\s+$/, '');
  return { text: `${head ? `${head}\n` : ''}${add.join('\n')}`, added: add.length };
}
