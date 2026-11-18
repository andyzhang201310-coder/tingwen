/**
 * 说话人身份管理服务
 * ------------------------------------------------------------------
 * 对应产品规范第 5 章、技术规范第 3.4 / 9 / 11 章：
 * - SpeakerAssignmentService：临时身份、片段关联、改归属、合并、人工锁定
 * - DiarizationScheduler：本地 / 云端任务调度、去重、重试、结果版本
 * - 每场会议独立 Speaker ID，不做跨会议声纹匹配
 */

import {
  getRecording, listTranscripts, updateTranscript,
  listSpeakers, getSpeaker, createSpeaker, updateSpeaker, deleteSpeaker,
  listTasks, putTask, addResult, listResults,
  logAssignment, listAssignments, logMerge, listMerges, updateMerge,
  clearSummaries,
} from './store.js';
import {
  LocalDiarizationEngine, CloudDiarizationEngine, fuseResults, orderClusters,
} from './diarize.js';
import { T } from './i18n.js';

/* ══════════════════════════════════════════
   任务（技术规范 11）
   ══════════════════════════════════════════ */

async function syncTask(recordingId, engine, mode, status, patch = {}) {
  const tasks = await listTasks(recordingId);
  const found = tasks.find((t) => t.engine === engine);
  const now = Date.now();
  const row = {
    id: found?.id || `task_${recordingId}_${engine}`,
    recordingId,
    audioSegmentId: 'full',
    engine,
    mode,
    status,
    retryCount: patch.retryCount ?? found?.retryCount ?? 0,
    errorCode: patch.errorCode ?? null,
    startedAt: patch.startedAt ?? found?.startedAt ?? (status === 'processing' ? now : null),
    finishedAt: patch.finishedAt ?? found?.finishedAt ?? null,
    createdAt: found?.createdAt || now,
  };
  if (status === 'completed' || status === 'failed') row.finishedAt = now;
  return putTask(row);
}

/** 任务去重：同一引擎只保留一条任务，重复提交视为幂等重试 */
export async function retryTask(recordingId, engine) {
  const tasks = await listTasks(recordingId);
  const found = tasks.find((t) => t.engine === engine);
  if (!found) return null;
  return putTask({ ...found, status: 'retrying', retryCount: (found.retryCount || 0) + 1, errorCode: null });
}

/* ══════════════════════════════════════════
   主流程：识别 → 融合 → 落库
   ══════════════════════════════════════════ */

/**
 * 运行说话人分离。
 * @param {string} recordingId
 * @param {{settings?:object, engine?:'auto'|'local'|'cloud', onProgress?:(p:number,label:string)=>void}} opts
 */
export async function runDiarization(recordingId, opts = {}) {
  const settings = opts.settings || {};
  const enginePref = opts.engine || settings.diarEngine || 'auto';
  const onProgress = opts.onProgress || (() => {});

  const rec = await getRecording(recordingId);
  if (!rec) return { ok: false, code: 'no-recording' };
  const trs = (await listTranscripts(recordingId))
    .filter((t) => (t.text || '').trim() && (t.endMs || 0) > (t.startMs || 0));
  if (!trs.length) return { ok: false, code: 'no-transcript' };
  if (!rec.audio) return { ok: false, code: 'no-audio' };
  if (!window.AudioContext && !window.webkitAudioContext) return { ok: false, code: 'no-audio-ctx' };

  const spans = trs.map((t) => ({ id: t.id, startMs: t.startMs, endMs: t.endMs }));
  const doLocal = enginePref !== 'cloud';
  const cloud = new CloudDiarizationEngine({
    url: settings.diarCloudUrl,
    key: settings.diarCloudKey,
    simulate: settings.diarSimCloud !== false,
  });
  const doCloud = enginePref !== 'local' && cloud.available;

  if (enginePref === 'cloud' && !doCloud) return { ok: false, code: 'cloud-unconfigured' };

  const engines = [];
  let localResult = null;
  let cloudResult = null;

  if (doLocal) {
    await syncTask(recordingId, 'local', 'ondevice', 'processing');
    onProgress(0.08, 'local');
    try {
      const local = new LocalDiarizationEngine();
      await local.initialize();
      localResult = await local.processSegment({
        recordingId, blob: rec.audio, spans, taskId: `task_${recordingId}_local`,
        onProgress: (p) => onProgress(0.08 + p * 0.55, 'local'),
      });
      await addResult({
        recordingId, taskId: `task_${recordingId}_local`, engine: 'local',
        engineVersion: localResult.engine_version,
        resultJson: localResult,
        speakerCount: new Set(localResult.speakers.map((s) => s.engine_speaker_id)).size,
        spanCount: localResult.speakers.length,
      });
      await syncTask(recordingId, 'local', 'ondevice', 'completed');
      engines.push({ engine: 'local', status: 'completed', spans: localResult.speakers.length });
    } catch (err) {
      await syncTask(recordingId, 'local', 'ondevice', 'failed', { errorCode: err?.message || 'local-failed' });
      engines.push({ engine: 'local', status: 'failed', error: err?.message || '' });
    }
  }

  if (doCloud) {
    await syncTask(recordingId, 'cloud', cloud.mode, 'queued');
    onProgress(0.68, 'cloud');
    try {
      await syncTask(recordingId, 'cloud', cloud.mode, 'processing');
      const simSource = localResult
        ? localResult.speakers.map((s) => ({
          transcriptId: s.transcript_id,
          startMs: s.start_ms,
          endMs: s.end_ms,
          confidence: s.confidence,
          cluster: Number(String(s.engine_speaker_id).replace(/^local_s/, '')) || 0,
        }))
        : [];
      cloudResult = await cloud.processSegment({
        recordingId,
        blob: rec.audio,
        spans,
        taskId: `task_${recordingId}_cloud`,
        simSource,
        onProgress: (p) => onProgress(0.68 + p * 0.22, 'cloud'),
      });
      await addResult({
        recordingId, taskId: `task_${recordingId}_cloud`, engine: 'cloud',
        engineVersion: cloudResult.engine_version,
        resultJson: cloudResult,
        speakerCount: new Set(cloudResult.speakers.map((s) => s.engine_speaker_id)).size,
        spanCount: cloudResult.speakers.length,
      });
      await syncTask(recordingId, 'cloud', cloud.mode, 'completed');
      engines.push({ engine: 'cloud', status: 'completed', mode: cloud.mode, spans: cloudResult.speakers.length });
    } catch (err) {
      // 云端失败不阻塞：保留本地结果，任务记为 failed，可重试
      await syncTask(recordingId, 'cloud', cloud.mode, 'failed', { errorCode: err?.message || 'cloud-failed' });
      engines.push({ engine: 'cloud', status: 'failed', mode: cloud.mode, error: err?.message || '' });
    }
  }

  if (!localResult && !cloudResult) {
    return { ok: false, code: 'all-failed', engines };
  }

  /* ── 融合 ── */
  onProgress(0.92, 'fuse');
  const fused = fuseResults({ local: localResult, cloud: cloudResult, transcripts: trs });
  const ordered = orderClusters(fused.assignments.slice().sort((a, b) => {
    const ta = trs.find((t) => t.id === a.transcriptId);
    const tb = trs.find((t) => t.id === b.transcriptId);
    return (ta?.startMs || 0) - (tb?.startMs || 0);
  }));
  const byTr = new Map(ordered.map((a) => [a.transcriptId, a]));
  const speakerCount = new Set(ordered.map((a) => a.index)).size;

  /* ── 身份空间：沿用已有 Speaker 记录，不打断人工确认 ── */
  const existing = await listSpeakers(recordingId);
  const byOrder = new Map(existing.map((s) => [s.order, s]));
  const speakers = [];
  for (let i = 0; i < speakerCount; i += 1) {
    const old = byOrder.get(i + 1);
    if (old) {
      speakers.push(old);
    } else {
      speakers.push(await createSpeaker({
        recordingId,
        order: i + 1,
        temporaryLabel: `Speaker ${i + 1}`,
        color: i,
      }));
    }
  }

  /* ── 回填片段：人工锁定的片段一律不动 ── */
  let assigned = 0;
  let lockedKept = 0;
  let conflicts = 0;
  for (const t of trs) {
    const a = byTr.get(t.id);
    if (!a) continue;
    if (a.conflict) conflicts += 1;
    if (t.speakerLocked) { lockedKept += 1; continue; }
    const target = speakers[a.index];
    const patch = {
      speakerId: target.id,
      speakerConfidence: a.confidence,
      // 枚举取 automatic / manual / imported（技术规范 8.2），引擎来源另存
      speakerSource: 'automatic',
      speakerEngine: a.source,
    };
    if (t.speakerId && t.speakerId !== target.id) {
      await logAssignment({
        recordingId, transcriptId: t.id, oldSpeakerId: t.speakerId,
        newSpeakerId: target.id, source: 'automatic', reason: a.conflict ? 'engine-mismatch' : 're-diarized',
      });
    }
    await updateTranscript(t.id, patch);
    assigned += 1;
  }

  // 清掉多余的旧身份（仍被锁定片段引用的保留）
  const usedAfter = new Set((await listTranscripts(recordingId)).map((t) => t.speakerId));
  for (const s of existing) {
    if (speakers.some((x) => x.id === s.id)) continue;
    if (usedAfter.has(s.id) || s.identityStatus === 'confirmed') continue;
    await deleteSpeaker(s.id);
  }

  await recomputeStats(recordingId);
  // 身份变了，旧总结作废（技术规范 10.3-8：总结与转录必须同一数据版本）
  await clearSummaries(recordingId).catch(() => {});

  onProgress(1, 'done');
  return {
    ok: true,
    speakerCount,
    assigned,
    lockedKept,
    conflicts,
    coverage: fused.coverage,
    engines,
    simulated: cloud.mode === 'simulated',
    cloudConfigured: cloud.mode === 'http',
  };
}

/* ══════════════════════════════════════════
   统计与查询
   ══════════════════════════════════════════ */

/** 依据转录段重算每位发言人的首次出现、发言次数、总时长 */
export async function recomputeStats(recordingId) {
  const [trs, speakers] = await Promise.all([
    listTranscripts(recordingId),
    listSpeakers(recordingId),
  ]);
  const agg = new Map();
  trs.forEach((t) => {
    if (!t.speakerId) return;
    const cur = agg.get(t.speakerId) || { count: 0, ms: 0, first: Infinity, last: 0 };
    cur.count += 1;
    cur.ms += Math.max(0, (t.endMs || 0) - (t.startMs || 0));
    cur.first = Math.min(cur.first, t.startMs || 0);
    cur.last = Math.max(cur.last, t.endMs || 0);
    agg.set(t.speakerId, cur);
  });
  const out = [];
  for (const s of speakers) {
    const a = agg.get(s.id);
    out.push(await updateSpeaker(s.id, {
      segmentCount: a?.count || 0,
      totalSpeechMs: a?.ms || 0,
      firstSeenMs: a && a.count ? a.first : null,
      lastSeenMs: a && a.count ? a.last : null,
    }));
  }
  return out.sort((x, y) => (x.order || 0) - (y.order || 0));
}

/** 发言人 + 其全部片段，供确认页 / 文稿页使用 */
/**
 * 从已存的分离结果里取质量汇总。
 * 结果表按时间倒序，取最新一条带 quality 的即可——重跑分离后旧质量随之作废，
 * 不能用历史记录里较好的那一次来粉饰当前结果。
 */
function qualityOfResults(rows = []) {
  for (const r of rows) {
    try {
      const j = typeof r.resultJson === 'string' ? JSON.parse(r.resultJson) : r.resultJson;
      const q = j && j.quality;
      if (!q) continue;
      /* 早期版本写进去的空壳（四个指标全 null）不能算「有质量数据」，
         否则一份旧结果会把真实指标顶掉。 */
      if (!Number.isFinite(q.snrDb) && !Number.isFinite(q.clarity) && q.level === 'unknown') continue;
      return { ...q, engine: r.engine, engineVersion: r.engineVersion };
    } catch { /* 坏数据跳过，不影响其它结果 */ }
  }
  return null;
}

export async function loadSpeakerView(recordingId) {
  const [trs, speakers, tasks, assignments, merges, results] = await Promise.all([
    listTranscripts(recordingId),
    listSpeakers(recordingId),
    listTasks(recordingId),
    listAssignments(recordingId),
    listMerges(recordingId),
    listResults(recordingId).catch(() => []),
  ]);
  const byId = new Map(speakers.map((s) => [s.id, s]));
  const groups = new Map();
  trs.forEach((t) => {
    if (!t.speakerId) return;
    if (!groups.has(t.speakerId)) groups.set(t.speakerId, []);
    groups.get(t.speakerId).push(t);
  });
  return {
    transcripts: trs,
    speakers: speakers.filter((s) => !s.mergedInto),
    allSpeakers: speakers,
    byId,
    groups,
    tasks,
    assignments,
    merges,
    quality: qualityOfResults(results),
    unknownCount: trs.filter((t) => !t.speakerId).length,
    unconfirmed: speakers.filter((s) => !s.mergedInto && s.identityStatus === 'unconfirmed').length,
  };
}

/** 显示名：未确认时不冒充真名（规范 6.3-9） */
export function speakerName(spk, index) {
  if (!spk) return T('spk.unnamed', { n: (index ?? 0) + 1 });
  if (spk.identityStatus === 'unknown') return T('spk.unknown');
  if (spk.displayName) return spk.displayName;
  return T('spk.unnamed', { n: spk.order || 1 });
}

export function speakerStatusText(spk) {
  if (!spk) return '';
  if (spk.identityStatus === 'confirmed') return T('spk.statusConfirmed');
  if (spk.identityStatus === 'unknown') return T('spk.statusUnknown');
  return T('spk.statusUnconfirmed');
}

/* ══════════════════════════════════════════
   人工操作（全部优先于自动结果）
   ══════════════════════════════════════════ */

export async function renameSpeaker(speakerId, name) {
  const spk = await getSpeaker(speakerId);
  if (!spk) return null;
  const clean = (name || '').trim();
  return updateSpeaker(speakerId, {
    displayName: clean,
    identityStatus: clean ? 'confirmed' : 'unconfirmed',
  });
}

export async function markSpeakerUnknown(speakerId) {
  return updateSpeaker(speakerId, { displayName: '', identityStatus: 'unknown' });
}

export async function setSpeakerNote(speakerId, note) {
  return updateSpeaker(speakerId, { note: (note || '').trim() });
}

/** 新建一个空身份，用于把被错判成同一人的片段拆出来 */
export async function createEmptySpeaker(recordingId) {
  const speakers = await listSpeakers(recordingId);
  const order = speakers.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
  return createSpeaker({
    recordingId,
    order,
    temporaryLabel: `Speaker ${order}`,
    color: order - 1,
  });
}

/**
 * 把一条或连续多条片段改归属。
 * 人工结果立刻锁定，自动识别不会静默覆盖（规范 5.4）。
 */
export async function reassignSegments(recordingId, transcriptIds, speakerId, reason = 'manual') {
  const list = Array.isArray(transcriptIds) ? transcriptIds : [transcriptIds];
  const trs = await listTranscripts(recordingId);
  const index = new Map(trs.map((t) => [t.id, t]));
  let moved = 0;
  for (const id of list) {
    const t = index.get(id);
    if (!t || t.speakerId === speakerId) continue;
    await logAssignment({
      recordingId, transcriptId: id, oldSpeakerId: t.speakerId || null,
      newSpeakerId: speakerId, source: 'manual', reason,
    });
    await updateTranscript(id, {
      speakerId: speakerId || null,
      speakerSource: 'manual',
      speakerLocked: speakerId ? 1 : 0,
      speakerConfidence: null,
    });
    moved += 1;
  }
  await recomputeStats(recordingId);
  return moved;
}

/** 解除锁定，允许后续自动识别更新该片段 */
export async function unlockSegment(transcriptId) {
  return updateTranscript(transcriptId, { speakerLocked: 0, speakerSource: 'automatic' });
}

/**
 * 合并两个被错误拆分的说话人。
 * 原始转录文字与音频位置不变，只改身份指向，并留下可撤销的记录。
 */
export async function mergeSpeakers(recordingId, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return { ok: false, code: 'invalid' };
  const [src, tgt] = await Promise.all([getSpeaker(sourceId), getSpeaker(targetId)]);
  if (!src || !tgt || src.recordingId !== recordingId || tgt.recordingId !== recordingId) {
    return { ok: false, code: 'not-found' };
  }
  const trs = await listTranscripts(recordingId);
  const moved = trs.filter((t) => t.speakerId === sourceId);
  const merge = await logMerge({
    recordingId,
    sourceSpeakerId: sourceId,
    targetSpeakerId: targetId,
    sourceName: src.displayName || '',
    targetName: tgt.displayName || '',
    movedCount: moved.length,
    sourceBefore: { displayName: src.displayName || '', identityStatus: src.identityStatus || 'unconfirmed' },
    targetBefore: { displayName: tgt.displayName || '', identityStatus: tgt.identityStatus || 'unconfirmed' },
  });
  for (const t of moved) {
    await logAssignment({
      recordingId, transcriptId: t.id, oldSpeakerId: sourceId,
      newSpeakerId: targetId, source: 'merge', reason: merge.id, batchId: merge.id,
    });
    await updateTranscript(t.id, {
      speakerId: targetId, speakerSource: 'manual', speakerLocked: 1,
    });
  }
  await updateSpeaker(targetId, {
    // 目标已确认的名字优先；否则继承来源的名字
    displayName: tgt.displayName || (src.identityStatus === 'confirmed' ? src.displayName : ''),
    identityStatus: tgt.identityStatus === 'confirmed' || src.identityStatus === 'confirmed'
      ? 'confirmed' : tgt.identityStatus,
  });
  await updateSpeaker(sourceId, {
    mergedInto: targetId,
    mergedAt: Date.now(),
    identityStatus: 'merged',
    segmentCount: 0,
    totalSpeechMs: 0,
  });
  await recomputeStats(recordingId);
  return { ok: true, merge, moved: moved.length };
}

/** 撤销合并：把当时移动过的片段还原到来源身份 */
export async function undoMerge(recordingId, mergeId) {
  const merges = await listMerges(recordingId);
  const m = merges.find((x) => x.id === mergeId);
  if (!m || m.reversedAt) return { ok: false, code: 'not-found' };
  const assignments = await listAssignments(recordingId);
  const batch = assignments.filter((a) => a.batchId === mergeId);
  const trs = await listTranscripts(recordingId);
  const index = new Map(trs.map((t) => [t.id, t]));
  let restored = 0;
  for (const a of batch) {
    const t = index.get(a.transcriptId);
    if (!t || t.speakerId !== m.targetSpeakerId) continue; // 之后又被改过，不覆盖
    await updateTranscript(t.id, { speakerId: m.sourceSpeakerId, speakerSource: 'manual', speakerLocked: 1 });
    restored += 1;
  }
  // 撤销必须把两边都还原：否则来源恢复了名字，目标还留着同一个名字，出现两个“张明”
  await updateSpeaker(m.sourceSpeakerId, {
    mergedInto: null, mergedAt: null,
    displayName: m.sourceBefore?.displayName ?? '',
    identityStatus: m.sourceBefore?.identityStatus || 'unconfirmed',
  });
  if (m.targetBefore) {
    const tgt = await getSpeaker(m.targetSpeakerId);
    // 目标的名字若是合并时从来源继承来的，撤销后要还回去
    if (tgt && tgt.displayName === m.sourceBefore?.displayName) {
      await updateSpeaker(m.targetSpeakerId, {
        displayName: m.targetBefore.displayName || '',
        identityStatus: m.targetBefore.identityStatus || 'unconfirmed',
      });
    }
  }
  await updateMerge(m.id, { reversedAt: Date.now() });
  await recomputeStats(recordingId);
  return { ok: true, restored };
}

/** 把一位发言人的全部片段并入另一位；用于“不同人被判成同一人”的拆分前准备 */
export async function clearSpeakerAssignments(recordingId, speakerId) {
  const trs = await listTranscripts(recordingId);
  const own = trs.filter((t) => t.speakerId === speakerId);
  for (const t of own) {
    await updateTranscript(t.id, { speakerId: null, speakerSource: 'automatic', speakerLocked: 0 });
  }
  await recomputeStats(recordingId);
  return own.length;
}

/** 清空本场身份与识别结果（录音与文稿保留，人工锁定片段保留身份） */
export async function resetSpeakers(recordingId) {
  const trs = await listTranscripts(recordingId);
  for (const t of trs) {
    if (t.speakerLocked && t.speakerSource === 'manual') continue;
    await updateTranscript(t.id, { speakerId: null, speakerConfidence: null, speakerSource: 'automatic' });
  }
  const keep = new Set(trs.filter((t) => t.speakerLocked && t.speakerSource === 'manual').map((t) => t.speakerId));
  const speakers = await listSpeakers(recordingId);
  for (const s of speakers) {
    if (keep.has(s.id)) continue;
    await deleteSpeaker(s.id);
  }
  await recomputeStats(recordingId);
}
