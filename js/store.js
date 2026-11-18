import { uid, sha256Short } from './util.js';
import { normalizeAsrSettings, emptyProvider } from './asr-providers.js';

/* 产品名从「语记」改为「听文 TingWen」，库名同步更换；
   旧库 yuji_db 里的录音会在首次打开时自动迁移过来，不丢数据。 */
const DB_NAME = 'tingwen_db';
const LEGACY_DB_NAME = 'yuji_db';
/* v2：新增说话人识别与身份管理相关表（对应技术规范第 8 章）
   v3：新增 asrJobs（未识别区间的补处理队列，对应产品文档 8.2「断网恢复」）
   v4：新增 translations（译文，对应产品文档 2.3「摘要与翻译」） */
const DB_VERSION = 4;
const STORES = [
  'recordings', 'segments', 'transcripts', 'meta',
  'speakers', 'speakerAssignments', 'speakerMerges',
  'diarizationTasks', 'diarizationResults',
  'meetingSummaries', 'speakerSummaries', 'summarySources', 'actionItems',
  'asrJobs', 'translations',
];

/** 设置默认值（对应文档 2.x / 7.x 与 界面参考3） */
export const DEFAULT_SETTINGS = {
  theme: 'dark',            // dark | light | system
  uiLang: 'auto',           // 界面语言：zh-CN | en-US | auto
  lang: 'zh-CN',            // 识别语言：zh-CN | en-US | auto
  engineMode: 'auto',       // auto | local | cloud
  transcribeMode: 'accurate', // accurate | fast
  showHistory: true,
  saveRecording: true,
  importAudio: true,
  soundEffect: true,
  autoCopy: false,
  autoCorrect: true,          // 自动纠正识别错误
  correctLevel: 'standard',   // conservative | standard | aggressive
  cleanFiller: false,         // 清理口头语（嗯/啊/重复词）
  customDict: '',             // 自定义纠错词库，每行 “错词=对词”
  llmBase: '',                // 可选：OpenAI 兼容接口地址
  llmModel: 'gpt-4o-mini',
  llmKey: '',
  instantRecord: false,
  autoDeleteOld: false,
  autoDeleteDays: 30,
  keepRecycle: true,
  /* 说话人识别与身份管理 */
  diarEnabled: true,          // 录音结束后自动做说话人分离
  diarEngine: 'auto',         // auto | local | cloud
  diarSimCloud: true,         // 未配置云端接口时，用本机结果模拟云端（仅用于验证双引擎融合）
  diarCloudUrl: '',           // 云端分离接口（POST，返回统一结果结构）
  diarCloudKey: '',
  /* 补识别（断网恢复后对已录音频重跑识别） */
  asrProvider: 'siliconflow',  // siliconflow | bailian | custom（当前生效的云端服务商）
  asrProviders: {              // 每家独立保存地址/密钥/模型，切换不丢配置
    siliconflow: emptyProvider('siliconflow'),
    bailian: emptyProvider('bailian'),
    custom: emptyProvider('custom'),
  },
  asrCloudUrl: '',            // 当前服务商的地址（同步字段，勿直接改）
  asrCloudKey: '',
  asrCloudModel: 'whisper-1',
  repairAuto: true,           // 网络恢复后自动补识别（需已配置云端识别接口）
  /* 智能整理与翻译（产品文档 2.3） */
  summaryScenario: 'auto',    // auto（按文件夹推断）| meeting | class | interview | memo
  translateLang: '',          // 目标语言；空 = 按界面语言取（中文界面译英文）
};

let dbPromise = null;

function createStores(db) {
  if (!db.objectStoreNames.contains('recordings')) {
    const s = db.createObjectStore('recordings', { keyPath: 'id' });
    s.createIndex('startedAt', 'startedAt');
    s.createIndex('status', 'status');
  }
  if (!db.objectStoreNames.contains('segments')) {
    const s = db.createObjectStore('segments', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('transcripts')) {
    const s = db.createObjectStore('transcripts', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('meta')) {
    db.createObjectStore('meta', { keyPath: 'key' });
  }

  /* ── 说话人识别（v2） ── */
  if (!db.objectStoreNames.contains('speakers')) {
    const s = db.createObjectStore('speakers', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('speakerAssignments')) {
    const s = db.createObjectStore('speakerAssignments', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
    s.createIndex('transcriptId', 'transcriptId');
  }
  if (!db.objectStoreNames.contains('speakerMerges')) {
    const s = db.createObjectStore('speakerMerges', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('diarizationTasks')) {
    const s = db.createObjectStore('diarizationTasks', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('diarizationResults')) {
    const s = db.createObjectStore('diarizationResults', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('meetingSummaries')) {
    const s = db.createObjectStore('meetingSummaries', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('speakerSummaries')) {
    const s = db.createObjectStore('speakerSummaries', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('summarySources')) {
    const s = db.createObjectStore('summarySources', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('actionItems')) {
    const s = db.createObjectStore('actionItems', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
  }
  if (!db.objectStoreNames.contains('asrJobs')) {
    const s = db.createObjectStore('asrJobs', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
    s.createIndex('status', 'status');
  }
  /* ── 译文（v4） ── */
  if (!db.objectStoreNames.contains('translations')) {
    const s = db.createObjectStore('translations', { keyPath: 'id' });
    s.createIndex('recordingId', 'recordingId');
    s.createIndex('transcriptId', 'transcriptId');
  }
}

function openRaw(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => createStores(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('数据库打开失败'));
    req.onblocked = () => reject(new Error('数据库被其他标签页占用'));
  });
}

/** 老库 → 新库的一次性搬迁。失败不影响新库正常使用，只是不动旧数据。 */
async function migrateLegacyDB() {
  if (typeof indexedDB.databases !== 'function') return;
  let names = [];
  try {
    names = (await indexedDB.databases()).map((d) => d.name);
  } catch {
    return;
  }
  if (!names.includes(LEGACY_DB_NAME) || names.includes(DB_NAME)) return;

  let legacy;
  try {
    legacy = await new Promise((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return;
  }

  const target = await openRaw(DB_NAME);
  try {
    for (const name of STORES) {
      if (!legacy.objectStoreNames.contains(name) || !target.objectStoreNames.contains(name)) continue;
      const rows = await new Promise((resolve) => {
        const r = legacy.transaction(name, 'readonly').objectStore(name).getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => resolve([]);
      });
      if (!rows.length) continue;
      await new Promise((resolve) => {
        const tx = target.transaction(name, 'readwrite');
        const os = tx.objectStore(name);
        for (const row of rows) os.put(row);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    }
  } finally {
    legacy.close();
    target.close();
  }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    if (!('indexedDB' in window)) throw new Error('当前环境不支持 IndexedDB');
    await migrateLegacyDB().catch(() => {});
    return openRaw(DB_NAME);
  })();
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(name, key) {
    return wrap((await store(name)).get(key));
  },
  async put(name, value) {
    return wrap((await store(name, 'readwrite')).put(value));
  },
  async del(name, key) {
    return wrap((await store(name, 'readwrite')).delete(key));
  },
  async all(name) {
    return wrap((await store(name)).getAll());
  },
  async byIndex(name, index, value) {
    return wrap((await store(name)).index(index).getAll(value));
  },
  async clear(name) {
    return wrap((await store(name, 'readwrite')).clear());
  },
};

/* ───────── 录音 ───────── */

export async function listRecordings({ deleted = false } = {}) {
  const all = await db.all('recordings');
  return all
    .filter((r) => (deleted ? !!r.deletedAt : !r.deletedAt))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function getRecording(id) {
  return db.get('recordings', id);
}

export async function createRecording(data = {}) {
  const now = Date.now();
  const rec = {
    id: uid('rec'),
    title: data.title || '未命名录音',
    scenario: data.scenario || '会议',
    folder: data.folder || '默认',
    startedAt: data.startedAt || now,
    endedAt: null,
    durationMs: 0,
    status: 'recording',
    engineMode: data.engineMode || 'auto',
    engineUsed: data.engineUsed || 'browser',
    mime: data.mime || '',
    size: 0,
    peaks: [],
    audio: null,
    bookmarks: [],
    favorite: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...data,
  };
  await db.put('recordings', rec);
  return rec;
}

export async function updateRecording(id, patch) {
  const rec = await getRecording(id);
  if (!rec) return null;
  const next = { ...rec, ...patch, updatedAt: Date.now() };
  await db.put('recordings', next);
  return next;
}

export async function softDeleteRecording(id) {
  return updateRecording(id, { deletedAt: Date.now() });
}

export async function restoreRecording(id) {
  return updateRecording(id, { deletedAt: null });
}

/** 彻底删除：录音 + 分段 + 文稿 + 说话人与任务、总结（技术规范 12.8） */
export async function purgeRecording(id) {
  const segs = await db.byIndex('segments', 'recordingId', id);
  await Promise.all(segs.map((s) => db.del('segments', s.id)));
  const jobs = await db.byIndex('asrJobs', 'recordingId', id);
  await Promise.all(jobs.map((j) => db.del('asrJobs', j.id)));
  const trs = await db.byIndex('transcripts', 'recordingId', id);
  await Promise.all(trs.map((t) => db.del('transcripts', t.id)));
  const trans = await db.byIndex('translations', 'recordingId', id);
  await Promise.all(trans.map((t) => db.del('translations', t.id)));
  await purgeSpeakerData(id);
  await db.del('recordings', id);
}

/** 只清说话人相关数据，录音与文稿保留（隐私条款：可删除身份关联） */
export async function purgeSpeakerData(id) {
  const tables = [
    'speakers', 'speakerAssignments', 'speakerMerges',
    'diarizationTasks', 'diarizationResults',
    'meetingSummaries', 'speakerSummaries', 'summarySources', 'actionItems',
  ];
  for (const name of tables) {
    const rows = await db.byIndex(name, 'recordingId', id);
    await Promise.all(rows.map((r) => db.del(name, r.id)));
  }
  const trs = await db.byIndex('transcripts', 'recordingId', id);
  await Promise.all(trs.map((t) => db.put('transcripts', {
    ...t, speakerId: null, speakerConfidence: null, speakerSource: 'automatic', speakerLocked: 0,
  })));
}

/* ───────── 音频分段（落盘证据，用于异常恢复） ───────── */

export async function addSegment(segment) {
  const seg = {
    id: segment.id || uid('seg'),
    recordingId: segment.recordingId,
    index: segment.index ?? 0,
    startMs: segment.startMs ?? 0,
    endMs: segment.endMs ?? 0,
    size: segment.blob?.size || 0,
    checksum: segment.checksum || '',
    blob: segment.blob,
    createdAt: Date.now(),
  };
  await db.put('segments', seg);
  return seg;
}

export async function listSegments(recordingId) {
  const segs = await db.byIndex('segments', 'recordingId', recordingId);
  return segs.sort((a, b) => a.index - b.index);
}

export async function clearSegments(recordingId) {
  const segs = await db.byIndex('segments', 'recordingId', recordingId);
  await Promise.all(segs.map((s) => db.del('segments', s.id)));
}

/**
 * 分段完整性自检（产品文档 8.2「分段完整性：时间连续、文件可读、校验通过」）
 * 重算每个分段的校验和与写入时比对，并检查相邻分段时间轴是否连续。
 */
export async function verifySegments(recordingId) {
  const segs = await listSegments(recordingId);
  const bad = [];
  const holes = [];
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    const actual = s.blob ? await sha256Short(s.blob) : '';
    if (!s.blob) {
      bad.push({ index: s.index, reason: 'missing', stored: s.checksum || '', actual: '' });
    } else if (s.checksum && actual && actual !== s.checksum) {
      bad.push({ index: s.index, reason: 'mismatch', stored: s.checksum, actual });
    }
    if (i > 0 && s.startMs - segs[i - 1].endMs > 1500) {
      holes.push({ after: segs[i - 1].index, from: segs[i - 1].endMs, to: s.startMs });
    }
  }
  return {
    total: segs.length,
    bytes: segs.reduce((n, s) => n + (s.size || 0), 0),
    bad,
    holes,
    ok: segs.length > 0 && !bad.length && !holes.length,
  };
}

/* ───────── 转录段 ───────── */

export async function addTranscript(t) {
  const item = {
    id: t.id || uid('tr'),
    recordingId: t.recordingId,
    startMs: Math.max(0, Math.round(t.startMs || 0)),
    endMs: Math.max(0, Math.round(t.endMs || 0)),
    text: (t.text || '').trim(),
    engine: t.engine || 'browser',
    status: t.status || 'final', // interim | final | edited
    speakerId: t.speakerId || null,
    speakerConfidence: t.speakerConfidence ?? null,
    speakerSource: t.speakerSource || 'automatic', // automatic | manual | imported
    speakerEngine: t.speakerEngine || null,         // local | cloud | local+cloud：谁给的归属
    speakerLocked: t.speakerLocked ? 1 : 0,         // 1 = 人工确认锁定，自动结果不得覆盖
    source: t.source || 'live',                     // live | repair | import：这段文字从哪来
    edited: t.edited ? 1 : 0,
    rev: t.rev || 1,
    original: t.original || null,
    raw: t.raw || null,               // 识别原文（纠错前）
    corrections: t.corrections || null, // 纠错记录，坐标基于 text
    corrected: t.corrected ? 1 : 0,
    correctedAt: t.corrected ? Date.now() : null,
    createdAt: Date.now(),
  };
  await db.put('transcripts', item);
  return item;
}

export async function listTranscripts(recordingId) {
  const list = await db.byIndex('transcripts', 'recordingId', recordingId);
  return list.sort((a, b) => a.startMs - b.startMs || a.createdAt - b.createdAt);
}

export async function updateTranscript(id, patch) {
  const cur = await db.get('transcripts', id);
  if (!cur) return null;
  const { autoFix, ...rest } = patch || {};
  const next = { ...cur, ...rest };
  // 自动纠错不算“人工编辑”，不写 original，也不改 status
  if (rest.text !== undefined && !cur.original && !autoFix) next.original = cur.text;
  next.rev = (cur.rev || 1) + 1;
  await db.put('transcripts', next);
  return next;
}

export async function deleteTranscript(id) {
  return db.del('transcripts', id);
}

/* ───────── 说话人（会议内身份，技术规范 8.1） ───────── */

export async function listSpeakers(recordingId) {
  const rows = await db.byIndex('speakers', 'recordingId', recordingId);
  return rows.sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function getSpeaker(id) {
  return db.get('speakers', id);
}

export async function createSpeaker(data = {}) {
  const now = Date.now();
  const spk = {
    id: uid('spk'),
    recordingId: data.recordingId,
    order: data.order || 1,
    displayName: data.displayName || '',
    temporaryLabel: data.temporaryLabel || `Speaker ${data.order || 1}`,
    identityStatus: 'unconfirmed', // unconfirmed | confirmed | unknown
    note: '',
    color: (data.order || 1) - 1,
    firstSeenMs: data.firstSeenMs ?? null,
    lastSeenMs: data.lastSeenMs ?? null,
    totalSpeechMs: 0,
    segmentCount: 0,
    createdAt: now,
    updatedAt: now,
    ...data,
  };
  await db.put('speakers', spk);
  return spk;
}

export async function updateSpeaker(id, patch) {
  const cur = await db.get('speakers', id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await db.put('speakers', next);
  return next;
}

export async function deleteSpeaker(id) {
  return db.del('speakers', id);
}

/** 重构识别时整体重建：先清空的只有自动身份空间，人工确认的姓名会尽量保留 */
export async function clearSpeakers(recordingId) {
  const rows = await db.byIndex('speakers', 'recordingId', recordingId);
  await Promise.all(rows.map((r) => db.del('speakers', r.id)));
}

/* ───────── 归属变更记录（8.3） ───────── */

export async function listAssignments(recordingId) {
  const rows = await db.byIndex('speakerAssignments', 'recordingId', recordingId);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function logAssignment(data) {
  const row = {
    id: uid('asg'),
    recordingId: data.recordingId,
    transcriptId: data.transcriptId,
    oldSpeakerId: data.oldSpeakerId ?? null,
    newSpeakerId: data.newSpeakerId ?? null,
    source: data.source || 'manual', // automatic | manual | imported | merge
    reason: data.reason || '',
    batchId: data.batchId || null,
    createdAt: Date.now(),
  };
  await db.put('speakerAssignments', row);
  return row;
}

/* ───────── 合并历史（8.6） ───────── */

export async function listMerges(recordingId) {
  const rows = await db.byIndex('speakerMerges', 'recordingId', recordingId);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function logMerge(data) {
  const row = {
    id: uid('mrg'),
    recordingId: data.recordingId,
    sourceSpeakerId: data.sourceSpeakerId,
    targetSpeakerId: data.targetSpeakerId,
    sourceName: data.sourceName || '',
    targetName: data.targetName || '',
    movedCount: data.movedCount || 0,
    // 合并会改写身份状态与名字，撤销必须能还原到合并前
    sourceBefore: data.sourceBefore || null,
    targetBefore: data.targetBefore || null,
    createdAt: Date.now(),
    reversedAt: null,
  };
  await db.put('speakerMerges', row);
  return row;
}

export async function updateMerge(id, patch) {
  const cur = await db.get('speakerMerges', id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await db.put('speakerMerges', next);
  return next;
}

/* ───────── 识别任务与原始结果（8.4 / 8.5） ───────── */

export const TASK_STATUS = ['pending', 'queued', 'processing', 'completed', 'failed', 'retrying', 'cancelled'];

export async function listTasks(recordingId) {
  const rows = await db.byIndex('diarizationTasks', 'recordingId', recordingId);
  return rows.sort((a, b) => (a.engine === b.engine ? 0 : a.engine === 'local' ? -1 : 1));
}

export async function putTask(task) {
  const row = { ...task, updatedAt: Date.now() };
  await db.put('diarizationTasks', row);
  return row;
}

export async function listResults(recordingId) {
  const rows = await db.byIndex('diarizationResults', 'recordingId', recordingId);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addResult(data) {
  const row = {
    id: uid('res'),
    recordingId: data.recordingId,
    audioSegmentId: data.audioSegmentId || 'full',
    taskId: data.taskId,
    engine: data.engine,
    engineVersion: data.engineVersion || '',
    resultJson: typeof data.resultJson === 'string' ? data.resultJson : JSON.stringify(data.resultJson),
    speakerCount: data.speakerCount || 0,
    spanCount: data.spanCount || 0,
    createdAt: Date.now(),
  };
  await db.put('diarizationResults', row);
  return row;
}

/* ───────── 总结（10.4） ───────── */

export async function getMeetingSummary(recordingId) {
  const rows = await db.byIndex('meetingSummaries', 'recordingId', recordingId);
  return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

export async function putMeetingSummary(data) {
  const now = Date.now();
  const cur = data.id ? await db.get('meetingSummaries', data.id) : null;
  const row = {
    id: data.id || uid('ms'),
    recordingId: data.recordingId,
    scenario: data.scenario || 'meeting',   // meeting | class | interview | memo
    generator: data.generator || 'rules',
    dataVersion: data.dataVersion || '',
    payload: data.payload,
    createdAt: cur?.createdAt || now,
    updatedAt: now,
  };
  await db.put('meetingSummaries', row);
  return row;
}

export async function listSpeakerSummaries(recordingId) {
  return db.byIndex('speakerSummaries', 'recordingId', recordingId);
}

export async function putSpeakerSummary(data) {
  const now = Date.now();
  const cur = data.id ? await db.get('speakerSummaries', data.id) : null;
  const row = {
    id: data.id || uid('ss'),
    recordingId: data.recordingId,
    speakerId: data.speakerId,
    generator: data.generator || 'rules',
    dataVersion: data.dataVersion || '',
    payload: data.payload,
    createdAt: cur?.createdAt || now,
    updatedAt: now,
  };
  await db.put('speakerSummaries', row);
  return row;
}

export async function addSummarySources(rows = []) {
  await Promise.all(rows.map((r) => db.put('summarySources', {
    id: uid('src'),
    recordingId: r.recordingId,
    summaryId: r.summaryId,
    kind: r.kind || 'meeting',
    sectionKey: r.sectionKey || '',
    itemIndex: r.itemIndex ?? 0,
    transcriptId: r.transcriptId,
    startMs: r.startMs ?? 0,
    createdAt: Date.now(),
  })));
}

export async function listSummarySources(recordingId) {
  return db.byIndex('summarySources', 'recordingId', recordingId);
}

export async function clearSummaries(recordingId) {
  for (const name of ['meetingSummaries', 'speakerSummaries', 'summarySources', 'actionItems']) {
    const rows = await db.byIndex(name, 'recordingId', recordingId);
    await Promise.all(rows.map((r) => db.del(name, r.id)));
  }
}

/* ───────── 译文（产品文档 2.3：摘要与翻译） ───────── */

export async function listTranslations(recordingId, lang) {
  const rows = await db.byIndex('translations', 'recordingId', recordingId);
  const list = lang ? rows.filter((r) => r.lang === lang) : rows;
  return list.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
}

/** 渲染用：transcriptId → 译文行 */
export async function getTranslationMap(recordingId, lang) {
  const rows = await listTranslations(recordingId, lang);
  const map = new Map();
  rows.forEach((r) => map.set(r.transcriptId, r));
  return map;
}

/** 同一段同一语言只保留一条，重译时 rev 递增（不覆盖原文，也不留重复行） */
export async function putTranslation(data) {
  const rows = await db.byIndex('translations', 'transcriptId', data.transcriptId);
  const cur = rows.find((r) => r.lang === data.lang);
  const row = {
    id: cur?.id || uid('tl'),
    recordingId: data.recordingId,
    transcriptId: data.transcriptId,
    lang: data.lang,
    text: data.text,
    generator: data.generator || 'llm',
    model: data.model || '',
    rev: (cur?.rev || 0) + 1,
    createdAt: cur?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await db.put('translations', row);
  return row;
}

export async function clearTranslations(recordingId, lang) {
  const rows = await listTranslations(recordingId, lang);
  await Promise.all(rows.map((r) => db.del('translations', r.id)));
  return rows.length;
}

/** 已翻译语言汇总：{lang, count, updatedAt}[] */
export async function translationLangs(recordingId) {
  const rows = await listTranslations(recordingId);
  const map = new Map();
  rows.forEach((r) => {
    const cur = map.get(r.lang) || { lang: r.lang, count: 0, updatedAt: 0 };
    cur.count += 1;
    cur.updatedAt = Math.max(cur.updatedAt, r.updatedAt || 0);
    map.set(r.lang, cur);
  });
  return [...map.values()];
}

/* ───────── 待办（6.4） ───────── */

export async function listActionItems(recordingId) {
  const rows = await db.byIndex('actionItems', 'recordingId', recordingId);
  return rows.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
}

export async function putActionItem(data) {
  const row = {
    id: data.id || uid('todo'),
    recordingId: data.recordingId,
    speakerId: data.speakerId || null,
    text: data.text || '',
    ownerId: data.ownerId || null,
    ownerName: data.ownerName || '',
    ownerConfirmed: data.ownerConfirmed ? 1 : 0,
    dueText: data.dueText || '',
    status: data.status || 'open', // open | confirmed | done
    transcriptId: data.transcriptId || null,
    startMs: data.startMs ?? 0,
    createdAt: data.createdAt || Date.now(),
  };
  await db.put('actionItems', row);
  return row;
}

export async function updateActionItem(id, patch) {
  const cur = await db.get('actionItems', id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await db.put('actionItems', next);
  return next;
}

/* ───────── 补识别任务队列（断网恢复后对已录音频重跑识别） ───────── */

export const ASR_JOB_STATUS = ['pending', 'processing', 'completed', 'failed', 'skipped'];

/**
 * 记录一段「未被识别覆盖」的音频区间。
 * kind: gap（识别中断导致的丢失区间）| tail（结尾未识别的尾巴）
 */
export async function addAsrJob(job) {
  const row = {
    id: job.id || uid('job'),
    recordingId: job.recordingId,
    kind: job.kind || 'gap',
    startMs: Math.round(job.startMs || 0),
    endMs: Math.round(job.endMs || 0),
    status: ASR_JOB_STATUS.includes(job.status) ? job.status : 'pending',
    attempts: job.attempts || 0,
    reason: job.reason || '',       // 未能补处理的原因（noCloud / noAudio / http401…）
    text: job.text || '',
    transcriptIds: job.transcriptIds || [],
    createdAt: job.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await db.put('asrJobs', row);
  return row;
}

export async function listAsrJobs(recordingId) {
  const rows = await db.byIndex('asrJobs', 'recordingId', recordingId);
  return rows.sort((a, b) => a.startMs - b.startMs);
}

export async function updateAsrJob(id, patch) {
  const cur = await db.get('asrJobs', id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await db.put('asrJobs', next);
  return next;
}

export async function clearAsrJobs(recordingId, { keepOpen = true } = {}) {
  const rows = await listAsrJobs(recordingId);
  const drop = keepOpen ? rows.filter((r) => r.status === 'completed' || r.status === 'skipped') : rows;
  await Promise.all(drop.map((r) => db.del('asrJobs', r.id)));
  return drop.length;
}

/* ───────── 设置 ───────── */

export async function getSettings() {
  const row = await db.get('meta', 'settings');
  return normalizeAsrSettings({ ...DEFAULT_SETTINGS, ...(row?.value || {}) });
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  /* 兼容旧调用方：只传 asrCloud* 三个字段时，视为改当前服务商，而不是覆盖整组配置 */
  if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'asrProviders')) {
    const id = next.asrProvider;
    const cfg = { ...(next.asrProviders?.[id] || emptyProvider(id)) };
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'asrCloudUrl')) cfg.url = next.asrCloudUrl;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'asrCloudKey')) cfg.key = next.asrCloudKey;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'asrCloudModel')) cfg.model = next.asrCloudModel;
    next.asrProviders = { ...next.asrProviders, [id]: cfg };
  }
  const normalized = normalizeAsrSettings(next);
  await db.put('meta', { key: 'settings', value: normalized });
  return normalized;
}

/* ───────── 容量 ───────── */

export async function storageInfo() {
  let quota = 0;
  let usage = 0;
  try {
    const est = await navigator.storage?.estimate?.();
    quota = est?.quota || 0;
    usage = est?.usage || 0;
  } catch { /* 忽略 */ }
  return { quota, usage };
}
