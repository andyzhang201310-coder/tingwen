import { T } from './i18n.js';

export function statusOf(rec) {
  if (!rec) return { text: '', dot: 'mute' };
  if (rec.status === 'recording') return { text: T('status.recording'), dot: 'live' };
  if (rec.status === 'recovered') return { text: T('status.recovered'), dot: 'warn' };
  if (rec.status === 'imported') return { text: T('status.imported'), dot: 'mute' };
  if (rec.status === 'failed') return { text: T('status.failed'), dot: 'err' };
  if (rec.hasTranscript === false) return { text: T('status.noTranscript'), dot: 'warn' };
  if (rec.engineUsed === 'manual') return { text: T('status.manual'), dot: 'ok' };
  if (rec.engineMode === 'cloud') return { text: T('status.cloud'), dot: 'ok' };
  if (rec.engineMode === 'local') return { text: T('status.local'), dot: 'ok' };
  return { text: T('status.auto'), dot: 'ok' };
}

export function engineLabel(mode) {
  return { auto: T('engine.auto'), local: T('engine.local'), cloud: T('engine.cloud') }[mode] || T('engine.auto');
}

export function engineShort(rec) {
  if (!rec) return '';
  if (rec.engineUsed === 'manual') return T('engine.shortManual');
  return { auto: T('engine.shortAuto'), local: T('engine.shortLocal'), cloud: T('engine.shortCloud') }[rec.engineMode] || T('engine.shortAuto');
}

/** 内置文件夹的显示名；用户自定义的文件夹原样返回。
 *  键是数据里存的文件夹名（中文常量），值是词条 key。 */
const FOLDER_KEYS = {
  默认: 'folder.default',
  导入: 'folder.import',
  会议: 'folder.meeting',
  课堂: 'folder.class',
  访谈: 'folder.interview',
  备忘: 'folder.memo',
};

export function folderLabel(name) {
  if (!name) return T('folder.default');
  if (FOLDER_KEYS[name]) return T(FOLDER_KEYS[name]);
  return name;
}

export function defaultTitle(date = new Date()) {
  const h = date.getHours();
  const part = h < 6 ? T('part.early') : h < 11 ? T('part.morning') : h < 13 ? T('part.noon') : h < 18 ? T('part.afternoon') : T('part.evening');
  return T('title.recording', { part, m: date.getMonth() + 1, d: date.getDate() });
}
