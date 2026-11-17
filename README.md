# 听文 TingWen · 实时语音转文字

> 原名「语记」因名称已被占用，产品更名为 **听文 TingWen**。应用内文案、离线缓存、数据库均已同步；旧库 `yuji_db` 会在首次打开时自动迁移到 `tingwen_db`，已录的内容不会丢。产品方案文档的文件名保持原样。

依据《语记_实时语音转文字App_产品方案与技术架构》（P0 基线）、`项目文档/speaker-identification.md`、`项目文档/speaker-identification-architecture.md` 与 4 张界面参考图实现的**可运行原型**。
真实麦克风录音、实时文字、分段落盘、崩溃恢复、文稿与音频双向定位、说话人分离与身份确认、按人员纪要与待办、导出、设置中心全部可交互。

## 快速开始

```bash
python serve.py          # 然后打开 http://127.0.0.1:8778/
```

> 必须用本地服务器打开（`file://` 无法使用麦克风与 ES Module）。
> 不要用 `python -m http.server`：Windows 下它会把 `.js` 当 `text/plain`，模块脚本会加载失败。

- 推荐 Chrome / Edge（实时识别依赖浏览器 Speech Recognition）。
- 手机访问：电脑与手机同一局域网，把地址换成电脑内网 IP，麦克风需要 `https` 或 `localhost`，因此手机端请用 Chrome 的端口转发或临时 https 隧道。
- 首次进入可点「载入演示记录」直接体验文稿页、播放联动与要点提炼（合成音频 + 示例文稿，明确标注为演示数据）。

## 已实现（对照产品文档）

| 文档模块 | 实现情况 |
| --- | --- |
| 实时转录（P0） | 开始 / 暂停 / 继续 / 结束、实时文字（临时文本与已确认文本分色）、计时、识别状态、引擎状态、网络状态 |
| 录音管理（P0） | MediaRecorder 持续采集，每 30 秒切一段写入 IndexedDB；异常退出后可恢复；列表、重命名、收藏、回收站、导入音频 |
| 文字编辑（P0） | 全文查看、逐段编辑（保留原始版本 `original`）、页内搜索、复制、导出 TXT / Markdown / JSON、导出音频 |
| 设置中心（P0） | 界面语言、识别语言、外观（深/浅/跟随系统）、识别模式、识别引擎、显示历史、保存录音、导入开关、音效、自动复制、打开即录音、自动清理、回收站、存储配额、隐私说明 |
| 中英双语（新增） | 全界面中文 / English / 跟随系统，设置里切换即时生效；状态、日期、导出模板、内置场景一并本地化 |
| 音频与文字联动（7.3） | 点段落跳转到对应 `start_ms`；播放时高亮当前段并自动滚动；±15 秒、倍速、波形拖动 |
| 识别纠错（新增，P0+） | 四层纠错：同音词库 / 上下文规则 / 同音归一建议 / 可选大模型；原文完整保留，修复处可见、可逐条撤销 |
| AI 智能整理（P1 预览） | 要点 / 待办 / 问题 / 关键词为**本机规则抽取**，界面明确标注「本机规则」，不冒充大模型结果 |
| 说话人识别与身份管理（P1，新增） | 本机声学分离 + 云端接口双引擎，统一结果模型与融合；会议内 Speaker ID、改名/合并/撤销、逐段与连续段重指派、人工锁定不被覆盖；按人员纪要与待办，**每条都可回溯到原句**。详见下文专章 |
| 同步与账号 | 未实现，按文档建议「第一版本地优先」 |

### 长时间录音可靠性（文档第 5 章）

- **边录边落盘**：每 30 秒把缓冲区写成一个分段记录（含 `startMs / endMs / size / checksum`），不依赖页面生命周期。
- **心跳**：每 4 秒把 `durationMs / size` 写回录音主记录，异常退出后仍能显示时长。
- **异常恢复**：启动时扫描 `status = recording` 的记录，若存在分段则在首页给出「恢复录音 / 丢弃」。
- **录音与识别解耦**：识别停止、报错、断网都不影响采集与落盘；状态栏如实显示「识别服务不可用 · 音频继续保存」。
- **收尾校验**：结束时合并分段 → 生成主音频 → 计算波形 → 清理分段 → 标记 `saved`。
- **离开保护**：`beforeunload` 拦截；浏览器后退时自动结束并保存，不静默丢音频。
- **其他**：录音期间申请 Screen Wake Lock；`navigator.onLine` 变化即时提示；显示已捕获体积与分段数。

## AI 纠错（识别错误自动纠正）

实时识别难免有同音错字（“测速”其实要说“测试”、“因该”其实是“应该”）。这里没有把纠错做成一个黑盒，而是分四层，越往后越谨慎：

| 层 | 做法 | 是否自动改 | 例子 |
| --- | --- | --- | --- |
| 1. 同音词库 | 内置 100+ 组“非词 → 正确词”，可在设置里自己加 | 是 | 因该→应该、结速→结束、测式→测试 |
| 2. 上下文规则 | 本身是合法词，只在录音语境下才改（带排除条件） | 是（标准及以上） | 测速录音→测试录音；测速软件不动 |
| 3. 同音归一 | 同一份文稿里，低频写法归并到高频写法（拼音完全一致、高频 ≥3 次、低频仅 1 次） | 否，进面板等确认 | 测视 3 次中的 1 次 → 测试 |
| 4. 大模型 | 可选，用户自己填 OpenAI 兼容接口；只给建议 | 否，逐条或全部采用 | 人名、专业术语、长句误识 |

设计取舍：

- **原文不丢**：纠错后的段落同时保存 `raw`（识别原文）与 `corrections`（逐条修改记录），面板里每条都能“撤销”，也能“全部撤销”还原。
- **不静默改对的东西**：第 3、4 层只产生建议。同音词里有大量合法词对（事实/实施、权力/权利），纯统计或大模型都会误判，让人扫一眼比赌概率便宜。
- **可解释**：段内被改动的字带虚线标记，点一下显示“识别原文：测速”；面板标出每条来自哪个词库/规则。
- **口头语清理是单独的开关**：默认关闭，避免把“谢谢谢谢”“刚刚”这类正常重复删掉。
- **隐私**：前三层完全本机，拼音表内置（6,763 字，22 KB），不发任何请求；只有你主动点“大模型纠错”才会把文稿发到你填的地址。

拼音相似度用了模糊音归一（zh/z、ch/c、sh/s、n/l、前后鼻音），所以“测式/测试”这类能对上；而“测速/测试”读音并不相同，靠的是第 2 层上下文规则与词库，这点在代码注释里写清楚了，没有假装是模型能力。

## 中英双语

界面语言在「设置 → 通用 → 界面语言」里切换（中文 / English / 跟随系统），选中后立即重建当前视图，不刷新页面、不丢正在看的内容。

- **两套语言，一套代码**：所有界面文案集中在 `js/i18n.js`，视图里只写 `T('home.tabAll')` 这样的 key；中英各 551 条，缺 key 会自动回退中文并在控制台暴露，不会渲染出 `undefined`。
- **界面语言 ≠ 识别语言**：`uiLang` 决定菜单和提示语，`lang` 决定语音识别用哪种语言。说中文但用英文界面是完全正常的组合。
- **不只是标签**：状态文案（录音中 / 已保存 · 云端识别）、日期（今天 · 16:13 → Today · 16:13，跨年时 Nov 17, 2025）、导出文件里的「要点 / 文稿」标题、内置文件夹与场景名、错误提示、确认框默认按钮都做了本地化。
- **用户数据不翻译**：录音标题、文稿正文、词库词条、文件夹自定义名都原样保留，因为它们属于用户，不属于界面。
- **品牌**：中文界面用「听文 / TINGWEN」，英文界面用「TingWen / 听文」，主副标随语言对调。

边界：演示记录的文稿内容是中文示例（来自产品文档场景），切到英文界面只翻译界面本身，不会翻译示例文稿——那属于录音内容。

## 说话人识别与身份管理

实现依据：`项目文档/speaker-identification.md`（产品 v1.1）与 `项目文档/speaker-identification-architecture.md`（技术 v1.1）。

流程是三段，顺序不能颠倒：**分声（谁在什么时候说）→ 确认身份（这段是谁）→ 组织内容（这个人说了什么）**。中间的「确认」必须由人来做，机器只负责给出候选。

### 1. 分声：两个引擎，一套结果

`DiarizationEngine` 与 ASR 完全解耦——识别只产出文字与时间戳，分离只消费「音频 + 转录区间」，两者可以分别换、分别失败。

| 引擎 | 做法 | 标注 |
| --- | --- | --- |
| 本机声学（`LocalDiarizationEngine`） | 16 kHz 单声道重采样 → 逐段提取基频中位数 / 基频离散度 / 谱质心 / 高低频能量比 / RMS → 按维度 z-score 加权 → k-means（k-means++ 初始化，3 组种子取最优） | 界面标「本机处理」 |
| 云端（`CloudDiarizationEngine`） | `POST` 表单（`audio` 文件 + `meta` JSON，`Authorization: Bearer`），返回统一结构 | 界面标「云端处理」 |
| 云端未配置时的模拟 | 以本机结果为基准做确定性扰动（编号整体错位 + 约 7% 片段翻转），用于验证融合与冲突路径 | 界面标 **模拟云端**，不冒充真实结果 |

说话人数不靠用户填，由轮廓系数（silhouette）与自定义**分离度**（最小类间距离 ÷ 平均类内距离）共同判定：分离度 `< 2.0` 或得分 `< 0.42` 就拒绝拆分；片段数 ≤ 3 时最多分 2 人，片段数 < 6 时以分离度为主判据。宁少不多——把一个人拆成两个，用户要合并两次；把两个人合成一个，用户只是改几段。

基频估计是这个模块里最容易出错的地方，踩过的坑写在注释里：用**补零到 2048 点的线性自相关**（避免循环自相关的伪峰）、除以**窗函数自相关 `WAC[lag]`**（消除长延迟处的窗泄漏衰减）、取**第一个超过 `max(0.34, 峰值×0.82)` 的局部极大**（而不是全局最大，避免把二倍频当基频），最后做抛物线插值。合成音验证：110 / 205 / 152 Hz 三个音色分离正确，置信度 0.78 / 0.95 / 0.78。

### 2. 融合：引擎标签不是身份

两个引擎的 `Speaker 0` 不是同一个人，引擎内部标签（`local_s0` / `cloud_s*`）**绝不写入应用层 Speaker ID**。

- 用**共现投票**建立「云端标签 → 本机标签」映射：一致率 ≥ 60% 且一对一才采纳，否则丢弃该映射。
- 同一片段两引擎判断冲突时按置信度取高，并在界面上打冲突标记（`speakerConfidence < 0.45`）；两引擎一致则来源记为 `local+cloud`。
- 最终身份按**首次出现顺序**重编号，和文稿阅读顺序一致。

统一结果模型（`diarization_results.resultJson`）：

```json
{ "recording_id": "...", "segment_id": "...", "engine": "local|cloud",
  "engine_task_id": "...", "engine_version": "acoustic-v1",
  "status": "completed",
  "speakers": [{ "engine_speaker_id": "local_s0", "start_ms": 0, "end_ms": 4200,
                 "confidence": 0.78, "transcript_id": "..." }] }
```

任务表 `diarization_tasks` 走 `pending → queued → processing → completed / failed / retrying / cancelled`；一个引擎失败不影响另一个，失败任务可在说话人页单独重试（`retryTask`）。**录音落盘永不等待分离**：分离在 `finish()` 保存完成之后才启动，页面跳转时显示进度环，失败只提示、不回滚录音。

### 3. 确认身份：人工优先，且可撤销

文稿页分为四栏：**全文 / 按人员 / AI 纪要 / 待办**。全文页顶部横幅提示「已识别 N 位发言人 · M 位待确认」并给出「去确认」入口；工具栏第二行是**按人员筛选**（彩色圆点 + 名字 + 未识别），点选只看某人，再点一次取消。每个段落上都有发言人徽标，点它即可改这段的人。

| 能力 | 说明 |
| --- | --- |
| 改名 / 标记「不是我」/ 备注 | 改名后 `identityStatus = confirmed`；「不是我」把该身份标为未知，其片段回到待指派 |
| 合并两位发言人 | 写入 `speaker_merge_history`（源、目标、片段数、时间），受影响片段全部迁移并锁定 |
| 撤销合并 | 按历史记录精确还原到合并前的身份，再次点击即可 |
| 单段 / 连续多段重指派 | 文稿页点段落的发言人徽标，或在按人员视图里框选连续段；写入 `speaker_assignments`（含 `batchId`） |
| 人工锁定 | 重指派与合并会置 `speaker_assignment_locked = 1`；重新跑分离时**跳过锁定片段**，并在结果里报 `lockedKept` 数量 |
| 全部重来 | 「清除身份数据」清空该录音的说话人侧全部表并复位文稿字段，不动音频与文字 |

字段语义严格分开，避免把「谁判断的」和「哪个引擎」混成一列：

```
speakerId                应用层身份（每场会议独立，不做跨会议声纹匹配）
speakerConfidence        该段归属的置信度
speakerSource            automatic | manual | imported   ← 谁做的决定
speakerEngine            local | cloud | local+cloud    ← 哪个引擎给的
speakerLocked            1 = 人工锁定，自动结果不得覆盖
```

（对应技术规范 8.2 的 `speaker_id / speaker_confidence / speaker_assignment_source / speaker_assignment_locked`，迁到 SQLite 时按原名建列即可。）

「自动结果不得静默覆盖人工结果」是硬约束：`runDiarization` 在回填时先查 `speakerLocked`，命中就 `continue`，同时在返回值里如实报告跳过了多少段。

### 4. 组织内容：每条结论都能点回原句

生成两份总结：整场会议的（讨论要点 / 已确认结论 / 未解决问题 / 各人观点 / 待办）与按人员的（要点 / 提问 / 建议 / 表态 / 承诺）。

- **强制溯源**：每个条目携带 `src: [{ trId, startMs }]`，同时写入 `summary_sources` 表；点击条目跳转到文稿对应段落并高亮播放。大模型返回的条目若找不到可解析的来源，`pickItems` 直接丢弃——宁可少一条，不留无法核对的结论。
- **不把建议当决定**：只有出现明确表态词（就这么定 / 决定 / 通过）才进「已确认结论」；「我觉得可以」留在「观点」里。
- **不替人认领任务**：责任人只从第一人称承诺（「我来…」「我这边…」）里取；否则 `ownerId = null`、`ownerConfirmed = 0`，界面显示「待确认」而不是猜一个人名。
- **不把讨论变承诺**：待办只认明确的行动句（待办 / 跟进 / 整理好 / 负责），并剔除「需要覆盖」这类描述性说法。
- **数据版本校验**：总结记录 `dataVersion`（转录内容与身份的指纹），身份或文字一变就提示「内容已变更，请重新生成」，旧总结留在库里但标为过期（`isStale`）。
- 默认生成器是**本机规则**（界面标「本机规则」）；填了大模型接口后可切换，失败自动回退规则结果，不阻塞。

### 5. 录音中的实时发言人

录音页计时下方的实时指示条用同一套基频函数（复用 `diarize.js` 的 `f0Of`，不另写一份）跟踪当前说话人：分析器时域数据按 3 倍降采样 → 逐帧基频 → 维护最多 4 个 log2 基频质心 → 连续 2 次命中且间隔 ≥ 500 ms 才切换，避免字间停顿导致标记抖动。它只做**当场提示**，不写库、不影响最终分离结果。

### 6. 隐私边界

- **每场会议独立编号**：`Speaker 1..N` 只在本场有效，不做跨会议声纹匹配、不建立全局声纹库——这是产品文档的硬性要求，也是不需要「声纹同意书」的前提。
- **默认不出本机**：声学分离全部在浏览器内完成，音频不上传；只有显式配置了云端分离接口（`diarCloudUrl` + Key）才会发请求。
- **临时标签不等于姓名**：未确认的发言人一律显示 `发言人 N` / `Speaker N` 与「待确认」状态，绝不把推测写成姓名。
- **可删除**：设置 → 说话人识别 → 身份数据，一键清除全部会议的说话人数据；删除单条录音时这些表随录音级联清理。

## 数据模型（IndexedDB `tingwen_db`）

| store | 用途 | 关键字段 |
| --- | --- | --- |
| `recordings` | 录音主记录 | `id, title, scenario, folder, startedAt, durationMs, status, engineMode, mime, size, peaks, audio(Blob), bookmarks, favorite, deletedAt` |
| `segments` | 录音过程中的音频分段 | `recordingId, index, startMs, endMs, blob, checksum` |
| `transcripts` | 转录段 | `recordingId, startMs, endMs, text, engine, status(interim/final/edited), speakerId, speakerConfidence, speakerSource, speakerEngine, speakerLocked, edited, rev, original, raw, corrections, corrected` |
| `meta` | 设置 | `key='settings'` |

说话人识别（库版本 2，`DB_VERSION = 2`，旧库原地升级、不丢数据）：

| store | 用途 | 关键字段 |
| --- | --- | --- |
| `speakers` | 本场会议的发言人身份 | `recordingId, order, temporaryLabel, name, color, identityStatus(unknown/unconfirmed/confirmed), note, firstMs, lastMs, turnCount, totalMs, mergedInto` |
| `speakerAssignments` | 归属变更流水（自动 + 人工） | `recordingId, transcriptId, oldSpeakerId, newSpeakerId, source, reason, batchId, at` |
| `speakerMerges` | 合并历史（支持撤销） | `recordingId, sourceId, sourceName, targetId, targetName, movedSegments, at, undone` |
| `diarizationTasks` | 分离任务状态机 | `recordingId, engine(ondevice/cloud), mode, taskId, status(pending/queued/processing/completed/failed/retrying/cancelled), attempts, errorCode, startedAt, finishedAt` |
| `diarizationResults` | 引擎原始结果（按引擎各存一份） | `recordingId, taskId, engine, engineVersion, resultJson, speakerCount, spanCount, at` |
| `meetingSummaries` | 整场会议总结 | `recordingId, generator(rules/llm), dataVersion, payload{overview,discussionPoints,confirmedDecisions,unresolvedQuestions,participantOpinions,counts}` |
| `speakerSummaries` | 按人员总结 | `recordingId, speakerId, generator, dataVersion, payload{keyPoints,questions,suggestions,decisions,commitments}` |
| `summarySources` | 总结条目 → 原句（强制溯源） | `recordingId, summaryId, kind(meeting/speaker), section, index, transcriptId, startMs` |
| `actionItems` | 待办 | `recordingId, speakerId, text, ownerId, ownerName, ownerConfirmed, dueText, status(open/done), transcriptId, startMs` |

删除单条录音时，上述 9 张表按 `recordingId` 级联清理，并把转录段的说话人字段复位；`speakers` 均带 `recordingId` 索引，`speakerAssignments` 另带 `transcriptId` 索引。

录音对象里的 `audio` 只在结束时写入；过程中只有 `segments`，与文档「先落盘再识别」的原则一致。分离任务只在 `status = saved` 之后入队，所以任何分离失败都不会影响录音本身。

## 结构

```
index.html
css/      tokens.css（设计令牌，深浅双主题）· app.css（基础组件）· views.css（各页面）
js/
  main.js         路由、主题、全局播放器、启动流程
  store.js        IndexedDB 封装与仓储方法（v2：录音 / 转录 / 说话人 / 总结 13 张表）
  audio.js        Recorder（采集/分段/电平/逐帧回调）、Player、波形采样
  asr.js          浏览器实时识别封装 + 时间戳估算
  ai.js           本机规则：要点/待办/问题/关键词
  diarize.js      说话人分离引擎：重采样、基频、特征、聚类、双引擎、融合
  speakers.js     身份管理：跑分离、改名、合并/撤销、重指派、锁定、统计
  summarize.js    会议与按人员总结：规则抽取、大模型调用、溯源校验
  live-speaker.js 录音中的实时发言人跟踪（复用 diarize 的基频函数）
  i18n.js         双语词条与取词函数（切换语言不刷新页面）
  correct.js      纠错引擎：词库/上下文/拼音归一/大模型调用
  pinyin-data.js  拼音表（GB2312 常用字，按音节分组，离线）
  ui.js           Toast、Sheet、确认框、波形渲染
  demo.js         合成演示音频与示例文稿（3 人会议，用于验证分离）
  views/          home · record · doc · doc-speaker-tabs · speakers · settings · trash
assets/icon.svg  manifest.webmanifest  sw.js（离线外壳）
```

## 与文档技术选型的差异（重要）

| 文档方案 | 本原型 | 说明 |
| --- | --- | --- |
| Flutter + Kotlin/Swift 原生音频 | Web（MediaRecorder + Web Audio） | 原型用于验证交互、状态机与可靠性策略；原生版可复用同一套状态与数据结构 |
| whisper.cpp 本地识别 | Web Speech API | 浏览器识别由系统/厂商服务提供，中文效果依赖环境；不支持时会明确降级为「仅录音」 |
| 云端实时识别 API | 未接入 | 没有可用凭证，因此不伪造云端结果；`engineMode` 已预留三种模式与切换入口 |
| SQLite | IndexedDB | 字段命名与文档 6.2 / 6.3 保持一致，迁移到 SQLite 时按同名字段建表即可 |
| 翻译 / 说话人分离与会议纪要 | 说话人分离：本机声学引擎 + 云端接口（可选）已实现；翻译未实现 | 分离按技术规范实现了双引擎抽象、统一结果模型、融合与任务状态机；云端接口需自备地址与 Key，未配置时用明确标注的「模拟云端」跑通融合链路。翻译仍缺服务，界面不展示未经服务验证的内容 |
| 大模型纠错 | 可选接入（OpenAI 兼容） | 默认关闭；用户填接口与 Key 后才可用，请求由浏览器直连，不经过中间服务 |
| 多语言（i18n 框架） | 自建轻量双语层 | 只有中英两套词条，没有引入 i18next；Flutter 版可换成 `flutter_localizations` + ARB，key 命名可直接复用 |

已知限制：Web 端单次可录时长受浏览器内存与配额约束，长录音（小时级）应以原生版为准；本文档要求的 2 小时基线需在 Flutter 版本上做真机验证。

## 建议的下一步

1. **P1 基础框架**：用此原型的路由、数据模型、状态文案直接映射到 Flutter 工程（`features/home|record|doc|settings`）。
2. **P2 录音系统**：Kotlin 前台服务 + Swift `AVAudioSession`，沿用「30 秒分段 + 心跳 + 恢复」策略。
3. **P3/P4 双引擎**：`asr.js` 的接口（`start/pause/resume/stop` + `onFinal/onInterim/onStatus` + 基于音频区间的时间戳）可直接作为引擎抽象层，替换为 whisper.cpp 与云端流式 API。
4. **P5**：真正的大模型纪要（当前默认本机规则，接口已通）、云端同步与账号；说话人识别可直接把 `diarize.js` 的两个引擎换成原生实现（`processSegment` 接口与统一结果模型不变），本机引擎可下沉到 Kaldi/ONNX 的声纹模型。
5. **纠错增强**：把内置词库换成领域词表 + 语言模型重打分（如中文 GPT-2/ngram），并支持“从这篇文稿一键抽取术语进词库”。
6. **说话人增强**：把「每场会议独立编号」升级为**用户显式开启**的跨会议声纹（需单独授权与删除入口）；补上重叠语音（双人同说）与远场噪声场景的分离质量评估。

## 许可

**本项目采用「保留所有权利 + 商用需授权」的许可，不是开源许可。** 完整条款见 [LICENSE](LICENSE)。

| 用途 | 是否需要授权 | 说明 |
| --- | --- | --- |
| 阅读源码、本地运行、学习研究 | 免费 | 无需申请 |
| 教学演示、非商业项目、二次开发 | 免费 | 需保留版权声明与 LICENSE 全文 |
| 分享修改版本 | 免费 | 不得删除作者署名 |
| 公司内部业务使用、付费产品 / SaaS / 小程序 | **需书面授权** | 含打包进商业发行物、硬件、转售 |
| 以本项目名义申请商标 / 软著 / 成果 | **需书面授权** | — |

商业授权请通过本仓库 Issues 或作者 [GitHub 主页](https://github.com/andyzhang201310-coder) 联系。

另请注意：语音识别与说话人分离结果为辅助输出，可能出错；录音的合法性、他人隐私与个人信息保护由使用者自行负责，详见 LICENSE 第四条免责声明。
