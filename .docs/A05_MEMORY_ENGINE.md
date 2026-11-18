# 记忆引擎架构

> **适用范围**：`packages/backend/src/services/memory/`
> **核心引擎**：SQLite (Drizzle) + TriviumDB (Vector + Graph)
> **范围**：事件记忆、自动检索与主动图查询；社交应用拥有独立的记忆处理流程
> **最后更新**：2026-11-09

---

## 1. 记忆存储层级

| 分层 | 载体 | 存储内容 | 检索方式 | 生命周期 |
| --- | --- | --- | --- | --- |
| **Layer 0 (Working)** | JSON / LLM Context | 当前会话 Context | 顺序读取 | 短期（单次会话） |
| **Layer 1 (Vector)** | **TriviumDB** | 事件向量 + 文本索引 | 向量检索 + BM25 | 长期 |
| **Layer 2 (Graph)** | **TriviumDB** | 事件图谱 + 关系边 | 图谱扩散 + 确定性 BFS | 长期 |
| **Layer 3 (Diary)** | **Workspace Markdown** | 每日人格日记 `dailynotes/*.md` | 按日期读取 | 永久 |
| **Notebook** | **Workspace Markdown** | 主文件 `notes/MEMORY.md` 与同级附页 | 主文件预算注入、附页按需读取 | 按文件维护 |

> Layer 3 的每日人格日记写入 Agent Workspace，不进入事件记忆库；全 Agent 共享的 **Facts Store**（`facts.tdb`）默认通过工具访问，并可在知识库面板独立开启有效事实自动召回（使用独立动态 XML，与事件记忆 RAG 管线分离）。TriviumDB 作为运行与检索权威，SQLite 保存完整备份与事务日志。

内置工作区能力片段 `components/abilities/workspace` 向角色说明日记目录 `dailynotes/`、日期命名与分篇规范（提示先列目录再按需读取），实际读写受文件工具授权与当前执行会话路径范围约束。

---

## 2. 写入管线 (EventNote Pipeline)

事件记忆由后台依据角色主线对话与有效亲历炼化，Agent 通过 `query_event_notes` 查询并回读来源：

1. 后台补记扫描主线的独立消息与亲历引用，按各自 Channel 处理未覆盖来源，产出事件或记录 `reviewed_no_event` 覆盖标记。
2. 消息覆盖键采用 `message:<id>@<revision>`（用户输入与正式角色发言皆可作为来源），批次与最终提交边界核对主线身份、代次及来源修订。
3. 时间链按 `eventAt` 维护，后台反思建立因果、同一事件、主题及参与对象关联边。
4. `EventNoteDraftCommitter` 保留历史已受理草稿的 Outbox 幂等恢复职责（按原操作编号与 Coverage 去重）。

据点生活事件以房间系统消息持久保存，亲历投影向后台提供源消息编号及 `lifeEvent` 结构化载荷（活动进展、成员关系与业务修订），复用亲历 Coverage、主线代次与遗忘截止位（据点实时状态见 [B32 据点生活](./B32_STRONGHOLD_LIFE.md)）。主、侧会话共享事件查询能力，后台炼化、反思与日记调度同时受总开关及单角色开关控制；来源撤回标注追溯状态，用户侧永久遗忘由 `PrivacyDeletionService` 清理记忆、日记及来源遗忘标记。

### 2.1 共享事实的修改权限

`write_fact`、`supersede_fact`、`delete_fact`、`add_fact_object_alias` 与 `remove_fact_object_alias` 统一校验所属角色有效 MainThread、代次与场景授权（工具目录、执行器、处理器与 NIT 子调用共享该校验链）。新增、取代与别名操作在准备事务提交前复查会话，永久删除在清理队列接纳时复查，已受理操作沿原事务回执恢复；用户管理侧通过专用编辑、还原与遗忘接口操作。

### 2.2 工作区记事本

每位角色通过 `notes/MEMORY.md` 维护要点与同级附页索引。`NotebookContextProvider` 在主应用前台编译时固定读取主文件正文与指纹（上限 `16000` 字符，超限可降级为位置说明，附页按需读取），交由统一 Region 与模型预算选择。主、侧会话与据点按各自工具权限操作同一角色目录：据点模式开放 `read_file / write_file / edit_file / get_file_info / list_directory` 并严格限制在 `notes` 直属 Markdown 文件；极简模式仅读取已有要点参考；任务独立工作区与子应用 Realm 按各自授权接入。记事本随工作区备份恢复。

---

## 3. 检索策略

记忆检索分为两条契约明确的路径：

1. **对话前自动 RAG**：默认向量 + BM25；可在「核心记忆 → RAG 配置 → 高级检索」开启 **SA-PPR 高级管线**（含 FISTA / DPP / Leiden）。自动补充时间轴末尾事件与每个命中事件的直接前驱（不计入 `top_k`，但受记忆专属 Token 上限约束）；基础管线另设独立相关度门槛。
2. **Agent 主动图查询**（`query_event_notes`）：确定性 **BFS**，严格遵守方向、边标签、深度、节点数与 Token 预算，独立于 SA-PPR 开关。

### 3.1 自动 RAG 筛选规则（`services/memory/automaticRagSelection.ts`）

- **检索线索**：由宿主场景提供（普通对话默认本次输入；据点按来源发言、关注与直接活动组织，空闲用主线当前目标与本人活动，见 [B32](./B32_STRONGHOLD_LIFE.md)）。`PrepareTurnParams.retrievalQuery` 缺省沿用输入，显式空字符串在编译入口转为 `ContextCompileOptions.retrievalQuery = null` 并跳过自动记忆召回与向知识/事实召回传递空查询（旧编译接口空字符串继续按历史正文回退）；场景提示词单独作为 `currentInput` 参与编排。
- **注入理由与通道预算**：`services/memory/automaticRagSelection.ts` 为候选标注 `direct`（直接命中）、`latest`（时间轴末尾）或 `previous`（直接前驱），与 `ContextCompiler` 及预算计数共用 `memory_context` 格式。专属预算键为 `channels.<desktop|group>.memoryTokenBudget`（`0` 不限，范围 `0–32000`；桌面默认 `2000` 约 8 命中/最多 17 条/`1.1K` Token，群聊默认 `1000` 按角色各自注入最多 7 条/`0.5K` Token；旧配置缺失自动补默认值）。
- **完整事件取舍**：优先级为 `direct`（按名次）→ `latest` → `previous`（按所依附命中名次，仅依附命中保留时才注入）；超出剩余预算的整条跳过不截断正文，较短候选可递补。最终按「末尾 → 命中 → 前驱」顺序输出。
- **来源与正文去重**：`ContextCompiler` 基于本轮装配的 user/assistant 消息构造 `VisibleMemorySource` 与 `EventNote.origin` 比对：仅当全部来源均可见（`messageIds` 全可见，或无 `messageIds` 时 `pairIds` 均属两侧完整可见历史对，且未经人工修订）时排除该条；被排除命中不占 `top_k`（基础路径多取一倍候选递补，前驱不随排除项补充），末尾锚点顺延取来源不可见最近事件。预览不带历史时不做来源去重。正文去重对文本做 NFKC 归一、忽略大小写与空白后取 SHA-256，在 `top_k` 截取前保留最高优先级项。
- **基础管线相关度门槛**：`basic.enableRelevanceGate`（默认开启）与 `basic.minSimilarity`（默认 `0.2`）仅在未开 SA-PPR 时生效——放行条件为「查询与事件余弦相似度达标」或「事件标签（≥2 字符）出现在查询中」（Embedding 不可用文本回退时放宽至标签或正文存在拉丁词/CJK 二字组重合）。候选不足少放不硬凑 `top_k`，直接前驱上限 `ceil(top_k / 2)`，仅保留 1 条末尾时间锚点（`0.2` 为保守阈值，兼容 e5 等高基线模型；关闭即退回全量补满，SA-PPR 继续使用上游 `advanced.minScore`）。记忆上限只约束记忆区，整体超窗交由全局预算处理；注入位置仍在尾部 `turn_context`，一次 ReAct 执行仅在 `ContextCompiler.compile` 检索一次。

---

## 4. 记忆维护与后台补记

- **开关作用域**：总开关 `memory.background.enabled` 与各角色开关 `memory.background.agent.<agentId>.enabled`（缺省开启）同时为真时生效，配置增删改导入均热更新；关闭角色即取消在途后台任务、暂停在线累计与炼化并从关系任务限额查询前排除，保留已有进度与记忆。
- **8 小时在线补记与持久计时**：每个启用 Agent 累计在线满 `8` 小时后扫描主线及有效亲历未覆盖来源（每分钟仅检测是否到点）。轻量心跳每 `30s` 累加时长写入 SQLite 并在正常关闭补尾段（停用、关机、挂起及重启期间暂停累计，不按墙钟补算；不继承旧静默计时）。
- **周期边界、容量分批与叙事**：周期到点锁定消息 ID 上界，全部分批及重试完成后才推进周期（无新事件写入 `reviewed_no_event`）。按补记模型窗口扣除人设、提示词与输出预留后动态分批，大正文消息按 Token 切片并保留分片结果直至来源复核提交。补记与反思按所属 Agent 人设与称呼保持各自叙事视角，仅同步未修改的内置任务提示词。
- **失败退避与时间语义**：补记失败按 `5 / 10 / 20 / 40 / 60` 分钟退避（`Coverage Claim` 防重放，提炼期间消息变更则丢弃旧结果；命中编辑/撤回仅处理受影响来源）。关系维护每 `5` 分钟增量运行，失败按 `5 / 15 / 30 / 60` 分钟退避，连续 5 次失败暂停自动调用；维护产生的新修订不重新触发自身维护。数据库存 UTC 时刻，提炼与上下文使用本地时间加显式偏移（`eventAt` 为事件时间、`createdAt` 为记录或修订时间）。

---

## 5. TriviumDB 接入规范

节点总量统计复用已打开 Store，冷库通过 `describeStore()` 使用临时只读句柄并及时关闭。统计沿库自身维度读取，角色库按业务访问打开。

- **引擎与存储**。后端与 Social 同步使用 npm 包 `triviumdb@0.9.2`。应用维护 TypeScript 适配，原生 SDK 与独立迁移器由 TriviumDB 上游维护。主文件格式为 v15，文本、关键词及索引由统一的 `.idx` 文件随库保存。Mmap 库还包含向量、分代 Payload、WAL 和检查点文件。常驻 Store 的 Payload 缓存上限为 32 MiB，单条上限 4 MiB，只读临时 Store 的缓存上限为 8 MiB。
- **升级时机**。后端持有数据目录租约时，先于业务读写迁移角色记忆、社交图谱、公共事实与知识库。已有向量原样迁移，无需重新调用 Embedding 模型。备份、清空、重建和永久遗忘使用同一套文件组识别规则。升级、失败续迁与回退见 [A08 部署运维](./A08_DEVOPS.md#23-迁移原则)，运行期重建见 [B29 索引维护](./B29_INDEX_MAINTENANCE.md)。
- **只读锁与快照边界**（`openExistingReader()`）：备份排除 `.lock` 运行锁，而引擎 `readOnly` 要求锁文件已存在。`openExistingReader()` 在确认主库存在后校验锁路径在受管数据根内且无符号链接（验证快照副本时由 `captureSnapshot()` 传入快照目标根），再以 `wx` / `0600` 补建空锁由引擎获取共享锁，既保留已有锁也不退回可写打开或创建空主库；缺锁时文档知识库仍可从 SQLite 恢复检索状态。
- **边界类型、文本索引与错误恢复**：`JsEdge / JsIncomingEdge` 保留 `metadata: unknown`；安全整数范围外 TQL 整数返回十进制字符串，`details` 整数需按实际 `number | string` 处理。WAL 写入、映射替换或约束发布故障可能隔离 writer/共享句柄，恢复须释放句柄重开后核实状态，而非盲目重放。`indexText(id, text)` 整体替换节点 BM25 正文（多字段需合并一次性登记，修改 Payload 不自动更新文本索引），常驻 Store 开启 `loadTextIndex: true` 并可通过 `buildTextIndex()` 预热，持久化依赖 flush/close 并继续保留 SQLite 备份重放；JSON 边界拒绝 `undefined`（构图与自动修订按删字段或省略字段处理），领域层统一经 `eventMemoryService.ts`、`facts.repo.ts` 与 `storeRegistry.ts` 协调落盘。

---

## 6. 核心数据对象与记忆边界

### 6.1 数据对象

- **`EventNote` (TDB + SQLite 备份)**：`id`、`agentId`、`narrative`、`eventAt`（系统权威时间）、`createdAt`、`importance`、`affect{tones, valence, arousal}`、`participants / places / objects / topics`、`origin{mode, threadId, pairIds, messageIds, channel}`、`status(active | archived)`；`operationId` 幂等提交，可由 SQLite 全量重建。
- **`ConversationCoverage` (SQLite)**：记录 `outcome = event_recorded | reviewed_no_event` 以防重扫并支持回溯清理。
- **`Facts` (共享 `facts.tdb`)**：跨 Agent 共享对象事实库（`objectKey` / `statement`，支持 `superseded_by` 取代链与可选自动召回，详见 [B03](./B03_DOCUMENT_KNOWLEDGE.md#可选自动召回)）。

### 6.2 记忆不变约束与 Context 映射

1. 事件记忆归属 `agentId`（`memory.tdb` 与共享 `facts.tdb` 按 Agent/全局隔离），Thread 仅作来源追溯。
2. 系统消息时间是 `eventAt` 唯一权威；每个 `EventNote` 持有完整 Provenance。
3. 长期记忆是独立跨 Execution 资源而非提示词私有状态，Memory Region 入模前记录 `agentId`、Store/来源、Snapshot/Revision、检索 Query 与分数、Token 预算与裁剪原因、Provenance/Trust 与派生标记。`ContextCompiler` 仅按 Policy 只读物化为 Region（类似缺页处理，确保相同输入产生可复现 Context Manifest）；Observer 产出的 Agent State 需由 Thread ContextPolicy 与 Observer Policy 双重启用方可进入上下文。
4. 跨 Application 记忆回流须经 `infos.knowledge.submit_candidate` 与主 Agent MemoryGate，知识只读查询走收窄 `infos.knowledge.query` Capability，不直接读取 TriviumDB 或数据库（见 [A10](./A10_APPLICATION_INTEGRATION.md)）。

---

## 7. 检索运行配置与旧状态清理

- `memory.runtime` 统一通过 Schema 归一化保存通道预算与基础/SA-PPR 高级检索参数（SA-PPR 的 Leiden 社区亲和度使用本次查询向量计算；配置中的退役字段按未声明剥离）。
- 应用启动与安装旧快照时通过 `services/maintenance/obsoleteRetrievalState.ts` 清理直属普通旧状态文件 `agent_<id>/rnn_<channel>.bin` 及 `shared/rnn_proj.bin`、`rnn_output.bin`、`rnn_mingru.bin`（遇到占用/权限错误记日志并在下次启动重试；备份与分布式快照按共享路径规则过滤；旧快照在校验原包后于安装准备阶段清理）。

---

## 8. 人工编辑档案

- **编辑范围与版本留存**：核心记忆详情支持编辑正文、重要度、情感与实体标签；有效事实支持编辑正文、来源与可信度（历史或已撤回事实保持只读）。人工编辑生成替代版本，原正文留存于 SQLite，继承原 Agent、事件时间、对话来源与归档状态（或原对象/时间/记录者），修订事务另记修改者与前版本（记忆同步记录 `origin.manualEdit`），不伪造对话回合或触发后台反思。
- **向量、索引与事务并发**：记忆默认复用原向量并按需重建向量（无论是否重建向量均更新文本索引并基于新标签重建实体边，事实仅维护文本索引）。选择重建向量时先生成向量再进入准备事务，已落盘的向量可在失败重放时直接复用不重复请求模型；同一客户端草稿沿用 `operationId`，事务内验证目标版本有效性及归档状态，发生并发修订时仅首方生效，冲突后保留前端草稿供刷新决定。保存后刷新界面视图，保留未提交草稿的关闭前确认提示，且不自动重写历史日记或正在运行的对话上下文。
- **归档恢复与还原边界**：归档记忆可从列表、详情或批量操作恢复（推进检索版本并恢复索引）；已撤回事实可在知识库点击「还原」，保留原有正文、来源、时间与记录者而不重算向量，通过事务日志同步 SQLite 与 TDB。已被新修订替代的历史版本不允许直接还原覆盖现行链；永久删除与来源遗忘标记在还原执行前优先校验拦截，确保已遗忘内容不被还原重现。
