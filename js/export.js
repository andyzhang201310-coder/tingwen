/**
 * 导出：投稿级文件格式
 *
 * 现有导出只有 TXT / Markdown / JSON。产品文档 8 章把「导出文件」列为交付物之一，
 * 并把 DOCX/PDF 标为后续功能；字幕文件则是在文稿已有精确时间戳之后自然该有的产物
 * （喂给剪辑软件、播放器、视频平台都用得上）。
 *
 * 这里的 DOCX 是**真正的 Word 文件**：手写 ZIP（存储方式，不压缩）+ OOXML 部件，
 * 不引入任何第三方库——项目是免构建的 ES Module，多一个依赖就多一次打包与升级负担。
 * docx 规范允许 STORED 条目，Word / WPS / Pages 都能正常打开。
 */

/* ───────── 时间码 ───────── */

const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');

/** SRT 用逗号分隔毫秒，VTT 用点，两者都不接受 60 秒以上的「秒」字段 */
function timecode(ms, sep = ',') {
  const t = Math.max(0, Math.round(ms || 0));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const msr = t % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(msr, 3)}`;
}

/** 一段文字至少要能读出声音来，否则字幕闪一下就没了 */
const MIN_CUE_MS = 900;

function cues(trs = []) {
  const list = [];
  trs.forEach((t) => {
    const text = String(t.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const start = Math.max(0, Math.round(t.startMs || 0));
    /* 引擎给的时间戳偶尔缺失或倒挂：用下一句起点兜底，保证单调递增 */
    const end = Math.max(start + MIN_CUE_MS, Math.round(t.endMs || 0));
    list.push({ start, end, text, speakerId: t.speakerId || null });
  });
  return list.sort((a, b) => a.start - b.start);
}

/** 发言人只作为字幕行的前缀，不单独占一行——单行字幕更适合播放器 */
function withSpeaker(text, speakerId, nameOf) {
  const name = speakerId && nameOf ? nameOf(speakerId) : '';
  return name ? `${name}：${text}` : text;
}

/* ───────── 字幕 ───────── */

export function toSrt(trs, { nameOf } = {}) {
  return cues(trs)
    .map((c, i) => `${i + 1}\n${timecode(c.start)} --> ${timecode(c.end)}\n${withSpeaker(c.text, c.speakerId, nameOf)}\n`)
    .join('\n');
}

export function toVtt(trs, { nameOf, title = '' } = {}) {
  const head = ['WEBVTT', title ? `NOTE ${title.replace(/\n/g, ' ')}` : '', '']
    .filter((x, i) => i !== 1 || title)
    .join('\n');
  const body = cues(trs)
    .map((c) => `${timecode(c.start, '.')} --> ${timecode(c.end, '.')}\n${withSpeaker(c.text, c.speakerId, nameOf)}\n`)
    .join('\n');
  return `${head}\n${body}`;
}

/* ───────── ZIP（STORE 方式） ───────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** DOS 时间戳：docx 不看这个字段，但格式得合法 */
function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 最小 ZIP 打包器：只做 STORED（method 0）。
 * 结构 = 局部文件头 + 数据（逐个）→ 中央目录 → 目录结束记录。
 */
function zipStore(files) {
  const enc = new TextEncoder();
  const { time, date } = dosTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach((f) => {
    const nameBytes = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : enc.encode(f.data);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // flag: UTF-8 文件名
    local.setUint16(8, 0, true);           // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);            // version made by
    cen.setUint16(6, 20, true);            // version needed
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint16(30, 0, true);            // extra len
    cen.setUint16(32, 0, true);            // comment len
    cen.setUint16(34, 0, true);            // disk
    cen.setUint16(36, 0, true);            // internal attrs
    cen.setUint32(38, 0, true);            // external attrs
    cen.setUint32(42, offset, true);       // local header offset

    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/* ───────── DOCX ───────── */

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** 中文必须显式给 eastAsia 字体，否则 Word 会退回宋体/出现方框 */
function run(text, { bold = false, size = 22, color = null, italic = false } = {}) {
  return `<w:r><w:rPr>`
    + `<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>`
    + `${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/>' : ''}`
    + `${color ? `<w:color w:val="${color}"/>` : ''}`
    + `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`
    + `</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}

/** 段落：spacing/indent 都显式写，避免不同 Word 版本默认值不一致 */
function para(content, { style = null, align = null, before = 0, after = 120, line = null, indent = null } = {}) {
  return `<w:p><w:pPr>`
    + `${style ? `<w:pStyle w:val="${style}"/>` : ''}`
    + `<w:spacing w:before="${before}" w:after="${after}"${line ? ` w:line="${line}" w:lineRule="auto"` : ''}/>`
    + `${indent ? `<w:ind w:firstLine="${indent}"/>` : ''}`
    + `${align ? `<w:jc w:val="${align}"/>` : ''}`
    + `</w:pPr>${content}</w:p>`;
}

const HEADING = (text, size = 28) => para(run(text, { bold: true, size }), { before: 240, after: 120 });

/**
 * 生成 .docx。
 * @param {object} opts
 * @param {string} opts.title      标题
 * @param {string} opts.meta       元信息（时间 · 时长 · 引擎）
 * @param {string[]} opts.takeaways 要点
 * @param {Array} opts.trs          转录段
 * @param {(id:string)=>string} opts.nameOf 发言人取名
 * @param {object} opts.labels     界面文案（随语言变化）
 */
export async function toDocx({ title, meta, takeaways = [], trs = [], nameOf, labels = {} }) {
  const L = {
    points: labels.points || '要点',
    body: labels.body || '文稿',
    speaker: labels.speaker || '发言人',
    empty: labels.empty || '（无内容）',
    ...labels,
  };

  const blocks = [];
  blocks.push(para(run(title || '', { bold: true, size: 40 }), { after: 80 }));
  if (meta) blocks.push(para(run(meta, { size: 20, color: '6B7280' }), { after: 240 }));

  if (takeaways.length) {
    blocks.push(HEADING(L.points));
    takeaways.forEach((t) => blocks.push(para(run(`• ${t.text || t}`, { size: 22 }), { after: 80, indent: 240 })));
  }

  blocks.push(HEADING(L.body));
  if (!trs.length) {
    blocks.push(para(run(L.empty, { size: 22, color: '9CA3AF' })));
  } else {
    trs.forEach((t) => {
      const who = t.speakerId && nameOf ? nameOf(t.speakerId) : '';
      const clock = timecode(t.startMs, ':').slice(0, 8);
      const lead = `${clock}  ${who ? `${who}：` : ''}`;
      blocks.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr>`
        + run(lead, { size: 18, color: '9CA3AF' })
        + run(String(t.text || '').trim(), { size: 22 })
        + '</w:p>');
    });
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${blocks.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>
<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEsc(title || '')}</dc:title>
<dc:creator>听文 TingWen</dc:creator>
<cp:lastModifiedBy>听文 TingWen</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>听文 TingWen</Application></Properties>`;

  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
  ]);
}

/* ───────── 打印（另存为 PDF） ───────── */

/**
 * PDF 走系统打印：中文字体在浏览器的 PDF 引擎里是现成的，
 * 自己写 PDF 要么嵌字体（体积暴涨）要么丢字，不如交给系统的「另存为 PDF」。
 * 返回 false 表示这个环境不支持打印（如部分安卓 WebView），由调用方提示。
 */
export function printDoc({ title, meta, takeaways = [], trs = [], nameOf, labels = {} }) {
  if (typeof window.print !== 'function') return false;
  const esc = xmlEsc;
  const rows = trs.map((t) => {
    const who = t.speakerId && nameOf ? nameOf(t.speakerId) : '';
    const clock = timecode(t.startMs, ':').slice(0, 8);
    return `<p class="line"><span class="t">${clock}</span>${who ? `<b class="who">${esc(who)}：</b>` : ''}${esc(t.text)}</p>`;
  }).join('');
  const style = `
    @page { margin: 18mm 16mm; }
    body { font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; color: #111; font-size: 13pt; line-height: 1.7; }
    h1 { font-size: 22pt; margin: 0 0 6px; }
    .meta { color: #667085; font-size: 10.5pt; margin-bottom: 18px; }
    h2 { font-size: 14pt; margin: 22px 0 8px; border-left: 4px solid #2563eb; padding-left: 8px; }
    ul { margin: 0 0 12px; padding-left: 20px; }
    .line { margin: 0 0 8px; }
    .t { color: #98a2b3; font-size: 10pt; margin-right: 8px; }
    .who { font-weight: 600; }
    /* 屏幕上不显示排版副本，只留打印介质里的那一份 */
    .print-sheet { display: none; }
    @media print {
      body[data-printing] > *:not(.print-sheet) { display: none !important; }
      .print-sheet { display: block !important; }
    }`;

  const host = document.createElement('div');
  host.className = 'print-sheet';
  host.innerHTML = `<style>${style}</style>
    <h1>${esc(title || '')}</h1>
    <p class="meta">${esc(meta || '')}</p>
    ${takeaways.length ? `<h2>${esc(labels.points || '要点')}</h2><ul>${takeaways.map((t) => `<li>${esc(t.text || t)}</li>`).join('')}</ul>` : ''}
    <h2>${esc(labels.body || '文稿')}</h2>
    ${rows || `<p class="meta">${esc(labels.empty || '（无内容）')}</p>`}`;

  const prev = document.body.getAttribute('data-printing');
  document.body.setAttribute('data-printing', '1');
  document.body.appendChild(host);
  const cleanup = () => {
    host.remove();
    if (prev === null) document.body.removeAttribute('data-printing');
    else document.body.setAttribute('data-printing', prev);
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  try {
    window.print();
  } catch {
    cleanup();
    return false;
  }
  setTimeout(cleanup, 60000);
  return true;
}
