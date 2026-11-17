# 说话人识别与身份管理技术规范

- 产品：听文 TingWen
- 模块：Speaker Identification & Identity Management
- 文档版本：1.1
- 状态：已审批
- 目标平台：Android、iOS
- 技术基线：Flutter + 原生音频能力 + SQLite

## 1. 技术目标

建立独立于 ASR 的说话人识别模块，将音频时间区间、转录文字和说话人身份关联起来。

采用本地 + 云端双引擎架构。

必须满足：
1. ASR 和 Diarization 独立运行。
2. 本地和云端识别引擎使用统一接口。
3. 两个引擎可以根据调度策略共同参与识别。
4. 录音采集不依赖识别服务是否正常。
5. 识别结果允许修正和重新处理。
6. 每场会议独立管理 Speaker ID。
7. 人工确认结果不可被自动任务静默覆盖。
8. 支持长时间录音的分段处理和断点恢复。

## 2. 系统架构

音频采集服务产生连续音频流，并先持久化音频数据。

处理流水线：

Audio Capture
→ Audio Buffer
→ Local Audio Persistence
→ Audio Segment Manager
→ ASR Engine
→ Local Diarization Engine
→ Cloud Diarization Engine
→ Transcript Alignment
→ Speaker Assignment
→ SQLite Persistence
→ Personal Summary + Meeting Summary

模块说明：

- Audio Capture：原生录音采集。
- Audio Segment Manager：管理音频分段和时间区间。
- ASR Engine：语音转文字。
- Local Diarization Engine：本地说话人分离。
- Cloud Diarization Engine：云端说话人分离。
- Transcript Alignment：合并 ASR 和说话人时间区间。
- Speaker Assignment：身份关联和人工修正。
- SQLite Persistence：持久化转录、身份和任务状态。
- Summary Service：生成个人总结和整场会议总结。

录音服务不得等待 ASR、Diarization 或 AI 总结完成。

## 3. 模块划分

建议新增：

```text
lib/
└── features/
    └── speakers/
        ├── domain/
        │   ├── entities/
        │   ├── repositories/
        │   └── services/
        ├── data/
        │   ├── models/
        │   ├── datasources/
        │   └── repositories/
        ├── application/
        │   ├── speaker_detection_service.dart
        │   ├── speaker_assignment_service.dart
        │   ├── speaker_merge_service.dart
        │   └── diarization_scheduler.dart
        └── presentation/
            ├── live_speaker_view/
            ├── speaker_review/
            └── speaker_summary/
```

### 3.1 统一识别接口

```dart
abstract interface class DiarizationEngine {
  Future<void> initialize();

  Future<DiarizationResult> processSegment(
    AudioSegment segment,
  );

  Future<void> dispose();
}
```

本地和云端引擎均实现统一结果接口。

### 3.2 本地引擎

```dart
abstract interface class LocalDiarizationEngine
    implements DiarizationEngine {}
```

负责：
- 离线处理音频。
- 输出说话人时间区间。
- 输出可用的置信度信息。
- 网络不可用时继续工作。
- 将结果交给统一处理层。

### 3.3 云端引擎

```dart
abstract interface class CloudDiarizationEngine
    implements DiarizationEngine {}
```

负责：
- 提交允许上传的音频片段。
- 返回说话人时间区间。
- 提供任务 ID 和处理状态。
- 支持失败重试。
- 支持任务幂等。
- 不直接写入或覆盖人工确认的身份。

云端长期密钥不得硬编码在客户端。

### 3.4 SpeakerAssignmentService

负责：
- 创建会议内临时说话人。
- 关联转录片段。
- 修改发言归属。
- 合并说话人。
- 保存人工确认记录。
- 防止自动识别覆盖人工修正。

### 3.5 DiarizationScheduler

负责：
- 本地和云端任务调度。
- 网络状态判断。
- 用户引擎设置判断。
- 任务去重和重试。
- 结果版本管理。
- 识别失败恢复。

### 3.6 SpeakerRepository

负责：
- 说话人信息持久化。
- 说话人查询。
- 身份确认状态。
- 合并及修正历史。
- 删除和数据关联维护。

## 4. 双引擎调度策略

### 4.1 基本原则

本地和云端引擎共同构成完整的说话人识别能力。

系统不应假设两个引擎输出的 Speaker ID 一致。

引擎输出首先进入统一结果层，再由统一处理服务决定如何合并和关联。

### 4.2 任务处理

每个音频片段可以拥有：
- ASR 任务。
- 本地 Diarization 任务。
- 云端 Diarization 任务。

任务相互独立，录音优先级最高。

### 4.3 调度建议

- 本地引擎：可在音频片段保存后启动。
- 云端引擎：根据网络、授权和配置决定是否提交。
- 云端不可用：保留本地结果。
- 本地不可用：允许在用户授权和云端可用时使用云端。
- 两个结果均可用：进入结果融合和冲突检测。
- 结果不一致：保留原始结果，不直接覆盖。
- 用户人工修正：锁定修正结果。

不在 P0 验证前冻结固定的主次引擎关系。

### 4.4 结果融合

融合应综合考虑：
- 音频时间区间。
- 引擎任务来源。
- 说话人分配结果。
- 引擎置信度（如有）。
- 现有人工确认记录。

两个引擎的 Speaker 0 不代表同一个人。

只有经过时间区间及声音关联分析后，才能考虑将两个引擎的临时标签映射到同一个内部 Speaker ID。

无法可靠关联时，标记为待校正，不强制合并。

## 5. 本地与云端引擎候选方案

### 5.1 本地引擎

P0 阶段比较：
- pyannote.audio 相关模型及移动端部署方案。
- 基于 Speaker Embedding 的聚类方案。
- 其他可部署在 Android 和 iOS 的轻量化模型。

必须验证：
- 商业使用许可。
- 模型转换和部署方式。
- Android 兼容性。
- iOS 兼容性。
- CPU、GPU、NPU 支持。
- 模型大小。
- 内存。
- 延迟。
- 耗电和发热。
- 中文会议识别效果。

pyannote.audio 不应直接视为 Flutter 移动端现成组件。

whisper.cpp 主要承担 ASR，不是完整的说话人分离解决方案。

### 5.2 云端引擎

云端方案需验证：
- 是否提供说话人分离。
- 是否提供说话人时间区间。
- 是否支持长音频或分段音频。
- 说话人标签是否稳定。
- 请求时长和文件大小限制。
- 数据保留政策。
- 商业使用条件。
- 价格和并发限制。

具体供应商和 API 以 P0 验证结果为准。

## 6. 统一结果模型

引擎结果统一转换为内部数据结构：

```json
{
  "recording_id": "recording_001",
  "segment_id": "segment_001",
  "engine": "local",
  "engine_task_id": "task_001",
  "engine_version": "model_version",
  "speakers": [
    {
      "engine_speaker_id": "speaker_0",
      "start_ms": 1200,
      "end_ms": 5800,
      "confidence": null
    }
  ],
  "status": "completed"
}
```

说明：
- recording_id：当前会议录音。
- segment_id：音频分段。
- engine：local 或 cloud。
- engine_speaker_id：引擎内部临时标签。
- start_ms、end_ms：相对当前录音的全局时间。
- confidence：没有可靠来源时为空。
- engine_version：模型或服务版本。

## 7. 时间轴和结果对齐

ASR 输出：
- start_ms
- end_ms
- text
- segment_id

Diarization 输出：
- start_ms
- end_ms
- engine_speaker_id
- confidence（可空）

通过时间区间关联文字和说话人。

技术要求：
1. 所有时间统一使用录音开始后的毫秒数。
2. 不得只依赖文字相似度合并说话人。
3. 不得假设每个音频区间只有一个发言人。
4. 允许多个说话人时间区间重叠。
5. 无法可靠关联时标记为 unknown。
6. 允许后续引擎重新处理同一音频区间。
7. 人工确认的分配优先于自动结果。
8. 保留原始引擎输出。
9. 跨音频分段的发言必须使用全局时间偏移。
10. 不能把引擎内部临时编号直接当成应用内部 Speaker ID。

## 8. SQLite 数据模型

### 8.1 speakers

```sql
CREATE TABLE speakers (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    display_name TEXT,
    temporary_label TEXT NOT NULL,
    identity_status TEXT NOT NULL DEFAULT 'unconfirmed',
    first_seen_ms INTEGER,
    total_speech_ms INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

每条 speakers 记录必须属于一个 recording_id。

### 8.2 transcript_segments 扩展

```sql
ALTER TABLE transcript_segments
ADD COLUMN speaker_id TEXT;

ALTER TABLE transcript_segments
ADD COLUMN speaker_confidence REAL;

ALTER TABLE transcript_segments
ADD COLUMN speaker_assignment_source TEXT
DEFAULT 'automatic';

ALTER TABLE transcript_segments
ADD COLUMN speaker_assignment_locked INTEGER
DEFAULT 0;
```

speaker_assignment_source：
- automatic
- manual
- imported

speaker_assignment_locked：
- 0：允许自动结果更新。
- 1：人工确认锁定。

### 8.3 speaker_assignments

```sql
CREATE TABLE speaker_assignments (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_segment_id TEXT NOT NULL,
    old_speaker_id TEXT,
    new_speaker_id TEXT,
    source TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
);
```

### 8.4 diarization_tasks

```sql
CREATE TABLE diarization_tasks (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    audio_segment_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    status TEXT NOT NULL,
    retry_count INTEGER DEFAULT 0,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

engine：
- local
- cloud

### 8.5 diarization_results

建议新增结果表，用于保留各引擎的原始输出：

```sql
CREATE TABLE diarization_results (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    audio_segment_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    engine_version TEXT,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

### 8.6 speaker_merge_history

```sql
CREATE TABLE speaker_merge_history (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    source_speaker_id TEXT NOT NULL,
    target_speaker_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reversed_at TEXT
);
```

所有表必须建立必要的索引和外键约束，并通过数据库迁移管理版本。

MVP 不需要建立跨会议 speaker_profiles 声纹身份库。

## 9. 会议身份生命周期

1. 创建会议时初始化会议级说话人空间。
2. 识别引擎产生临时标签。
3. 统一处理层创建内部 Speaker ID。
4. 用户确认姓名。
5. 转录片段关联内部 Speaker ID。
6. 用户可以合并或修正。
7. AI 总结读取当前有效身份。
8. 会议删除时按照数据删除策略清理相关记录。

不同会议之间不得直接复用 Speaker ID。

## 10. AI 总结技术规范

### 10.1 个人总结

按当前会议有效 speaker_id 分组。

输出：
- overview
- key_points
- questions
- suggestions
- decisions
- commitments
- action_items

每条内容应关联原始 transcript_segment_id。

### 10.2 整场会议总结

整场会议总结读取当前会议的完整转录内容及身份确认信息。

输出：
- meeting_overview
- topics
- discussion_points
- participant_opinions
- confirmed_decisions
- unresolved_questions
- action_items

### 10.3 总结生成约束

1. 不得将建议当作已确认决策。
2. 不得将发言人自动当作待办负责人。
3. 负责人允许为空。
4. 截止时间必须有原始依据。
5. 不确定的身份应标记待确认。
6. 每条总结必须关联原始发言片段。
7. 原始转录和 AI 总结分开保存。
8. 个人总结和整场会议总结使用相同的会议数据版本，避免内容不一致。

### 10.4 总结存储

建议使用：
- meeting_summaries：整场会议总结。
- speaker_summaries：会议内个人总结。
- summary_sources：总结与原始转录片段的关联。
- action_items：待办事项。

## 11. 任务调度和可靠性

任务状态：
- pending
- queued
- processing
- completed
- failed
- retrying
- cancelled

规则：
1. 音频先可靠写入本地。
2. 再创建 ASR 和 Diarization 任务。
3. 同一任务重复提交必须幂等。
4. 本地和云端任务分别管理状态。
5. 任务失败不影响录音。
6. 网络恢复后按策略重新提交云端任务。
7. 结果写入数据库时使用事务。
8. 已锁定的人工分配不允许被自动任务覆盖。
9. 识别结果保留引擎、任务 ID 和版本。
10. 云端上传失败时保留本地待处理任务。

## 12. 隐私和安全

1. 默认不进行跨会议声纹匹配。
2. 不默认保存长期个人声纹档案。
3. 声音样本及声纹特征按敏感数据处理。
4. 云端处理前明确传输的数据范围。
5. 云端密钥不得硬编码在客户端。
6. 本地数据库和声音样本按威胁模型设计加密。
7. 日志不得输出原始声音样本或敏感身份信息。
8. 删除会议时同步处理相关说话人和任务数据。

## 13. 测试策略

### 单元测试

- 临时说话人创建。
- 转录片段与说话人关联。
- 本地和云端结果统一转换。
- 双引擎结果冲突处理。
- 人工分配锁定。
- 说话人合并。
- 合并撤销。
- 未知说话人处理。
- 跨分段时间偏移。
- 任务重试与幂等。
- AI 总结来源校验。
- 会议间 Speaker ID 隔离。

### 集成测试

- ASR + 本地 Diarization 时间轴合并。
- ASR + 云端 Diarization 时间轴合并。
- 本地和云端同时返回结果。
- 两个引擎识别结果不一致。
- 网络中断和恢复。
- 长时间录音任务调度。
- 识别任务失败后录音继续。
- 人工修正后重新处理音频。
- 个人总结和整场会议总结生成。
- 删除会议后的关联数据清理。

### 真机测试

Android 和 iOS 分别验证：
- 连续录音。
- 后台录音。
- 设备锁屏。
- 音频中断。
- 蓝牙设备切换。
- 长时间录音内存变化。
- CPU、耗电和发热。
- 本地说话人分离延迟。
- 云端任务上传及网络恢复。
- 本地与云端结果融合。

### 会议测试样本

覆盖：
- 2 人轮流发言。
- 3～5 人轮流发言。
- 多人快速交替发言。
- 两人重叠发言。
- 远距离发言。
- 环境噪声。
- 同一人音量变化。
- 不同人声音相似。
- 长时间会议及跨音频分段发言。

测试应有人工标注的真实说话人区间，分别评估 ASR 和 Diarization，不以单一综合准确率掩盖问题。

## 14. P0 技术验证清单

- [ ] 确认本地模型许可证及商业使用条件。
- [ ] 验证 Android 部署。
- [ ] 验证 iOS 部署。
- [ ] 验证模型大小和内存需求。
- [ ] 测量实时处理延迟。
- [ ] 测量 CPU/GPU/NPU 资源消耗。
- [ ] 测量持续运行耗电和发热。
- [ ] 验证中文多人会议区分效果。
- [ ] 验证多人重叠发言。
- [ ] 比较本地和云端识别效果。
- [ ] 验证双引擎结果融合。
- [ ] 确认云端 API 限制、时间戳、价格和隐私政策。
- [ ] 确定断网和失败后的处理策略。

完成验证后再冻结具体模型、SDK 和云端供应商。

## 15. 技术验收标准

- [ ] DiarizationEngine 与 ASREngine 解耦。
- [ ] 本地和云端引擎实现统一接口。
- [ ] 双引擎结果能够统一处理。
- [ ] 不同引擎的临时标签不会直接混淆。
- [ ] 每场会议拥有独立的 Speaker ID。
- [ ] 转录片段与 Speaker ID 正确关联。
- [ ] 时间戳使用录音全局毫秒时间。
- [ ] 支持未知说话人。
- [ ] 支持人工修改、合并及撤销。
- [ ] 支持人工修正锁定。
- [ ] 自动结果不能覆盖人工锁定结果。
- [ ] 识别任务支持失败重试。
- [ ] 录音采集不依赖识别任务成功。
- [ ] 数据库保存识别来源及任务状态。
- [ ] 支持个人总结和整场会议总结。
- [ ] AI 总结能够引用原始片段。
- [ ] Android 和 iOS 均完成真机验证。