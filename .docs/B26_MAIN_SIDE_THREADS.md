# 主侧会话与角色持续状态

> **适用范围**：每个已登记角色的唯一主线（`main`）、任意数量侧线（`side`）、据点亲历跨场景引用、角色共享状态与重置/备份契约

---

## 1. 权威归属模型

每个已登记角色持有唯一 `main` Thread 与任意数量的 `side` Thread；主线负责日常连续交互与自动对话补记，Thread 类型、用途、交互模式与执行模式分别表达各自职责。`PrincipalAgent` 继续通过 `agentId` 关联 Identity、Memory、Workspace、Context Runtime、Thread 与 Capability 等资源。

| 数据 | 权威位置 | 作用域 |
| --- | --- | --- |
| 人设与公开档案 | Agent / Identity | 角色 |
| 表达与持续状态 | `agent_character_state_events` | 角色共享 |
| 长记忆 | SQLite 事件账本与角色 TriviumDB Store | 角色共享 |
| 历史、心流、计划与酒馆局部变量 | 对应 Thread | 单一会话 |
| 正式发言与发布回执 | `thread_messages` 的 `publication_id` | 独立消息 |
| 执行输入快照、过程与结果 | `conversation_executions` | 一次逻辑执行 |
| 发言的来源修订关联 | `conversation_message_sources` | 消息之间的多对多关系 |
| 待回应问题与接续现场 | `conversation_expectations` | 主线与重置代次 |
| 据点房间事实 | `group_chat_messages` | 据点房间 |
| 角色亲历 | `agent_experiences`（引用房间消息） | 角色主线与重置代次 |
| 角色当前心流 | `flow_states`、`flow_state_revisions` | 主会话与据点共用 MainThread，侧会话独立 |
| 当前选中会话 | 客户端窗口 | 窗口偏好 |

角色身份与长记忆按角色资源管理；聊天记录由主线、侧线、据点房间与社交会话各自持有。主线与据点直接装配同一角色的近期原文并共用当前心流，侧会话与社交使用各自的历史与心流范围；长期认识通过带来源追踪的记忆沉淀与检索连通。

---

## 2. 创建、迁移与默认入口

### 2.1 迁移与幂等创建

- **迁移基线**：`0025_main_side_threads.sql` 为现有 Thread 新增 `thread_kind='side'` 与 `generation=1`，历史 ID、消息、用途、设置及原有状态记录原地保留。新角色共享状态表从空事件流开始（读取时采用表达默认值，持续目标、承诺与关系初始为空）。
- **自动补建**：容器启动为全部已登记角色补建空主线（启用状态沿用角色配置），角色创建与会话查询入口同样确保主线存在。数据库部分唯一索引 `idx_threads_main_agent` 约束每个角色至多一条主线，`ThreadRepository.ensureMainThread` 提供幂等创建。
- **创建规则**：兼容入口 `getOrCreateLatest(agentId, 'desktop', 'conversation')` 解析为主线；普通新建会话与检查点复制生成侧线；后台任务及应用内部 Thread 沿用原 `purpose` 与列表过滤规则。
- **默认入口解析**：主应用首次进入、桌宠、语音及主动行为默认定位主线。用户显式选择侧线后，主应用按窗口持久化选择，桌宠沿用自身会话偏好；主动调度始终取得角色主线。

### 2.2 前端主会话展示

- 会话列表在分页前优先按 `thread_kind` 置顶主线，再按消息与创建时间排列侧线。主应用在历史滚动区上方以单行直角入口固定展示「主会话」标识与清空重置入口，通过房屋图标、左侧色条与当前会话标记区分侧线；工作区切换抽屉与桌宠选择器复用 `MainThreadCard.vue`（桌宠滚动列表固定在顶部）。
- 对话日志在所选时间顺序内继续优先展示主线，主线的改名入口按类型隐藏。
- 前端通过 `threadDisplayName` 统一输出会话名称：主线隐藏重命名按钮与改名对话框，在聊天栏、导出标题、会话选项、用量筛选及批注来源展示固定类型标识；用量筛选与表达批注接口返回 `threadKind` 供客户端识别。侧线继续展示并编辑用户自定义标题。

---

## 3. 连续交流与执行模型

- **独立消息架构**：主线的用户输入、角色发言与后台任务交付各自独立保存。一次逻辑 Execution 可消费多条输入并发布零条或多条正式消息。主线消息 `pair_id` 留空，由 `publication_id` 提供幂等身份、`execution_id` 关联逻辑执行；用户输入发布身份由队列提交身份与主线代次生成，重复提交返回同一消息。
- **`conversation` 工具**：
  - `publish`：即时提交一条正式发言并返回 `messageId`（同一执行可多次调用），`publish.responds_to` 可将发表与回应结算合并至同一事务。
  - `wait`：批量保存待回应问题、已发布消息修订引用、接续要点与可选到期时间后结束本次执行（省略到期时间时持续保留，读取待回应现场时自动结算已到期事项）。
  - `resolve`：使用本次有效用户输入回应一个或多个待回应事项。
- **多轮接续**：后续用户输入经队列创建新 Execution，编译器提供仍有效的问题与接续要点，模型可择机回应或转向新话题。等待现场持久化保存，应用重启后仍可由后续交流接续。主线工具菜单另开放独立执行结束操作。
- **投影与快照绑定**：`finish_task.reply` 在主线中可省略，普通自然语言最终答复由编排层以独立发布身份落盘，工具发表的消息即时进入投影；过程记录与正式消息分别结算（失败、暂停与中断记录保留各自投影，已发表消息继续作为有效交流事实存在）。执行输入来源固定至消息修订，任务结果事件引用对应交付消息；来源编辑、撤回或代次变化后提交入口重校验有效性。角色状态、心流、计划与文件快照沿用现有来源列，主线在其中记录逻辑执行编号；侧会话继续使用原有配对合同并保持原生工具调用/结果完整协议组。

---

## 4. 跨场景历史预算、记忆范围与工作清理

### 4.1 跨场景历史装配与预算

- **双向原文装配**：主会话读取同角色当前代次的据点亲历，据点读取同角色主线近期正式原文；另一场景选取条数为当前窗口实际选入正式聊天消息数的二分之一向上取整（`ceil(N / 2)`），当前窗口为空时以现有 Channel 默认消息窗口数为基准。
- **惰性编译与查询约束**：条数筛选复用 `getActiveMessages` 与亲历查询，在数据库截取前筛选 `user`、`assistant` 正式消息并保留完整正文；清单保留消息身份、代次、场景、时间与真实发言者，跨场景原文在实际执行时惰性装配（亲历记录自身只存来源，据点来源更正、撤回或主线重置直接作用于后续编译）。侧会话按自身范围读取，Realm 与 Social 维持独立历史与心流合同，工作工具轨迹由工作上下文选择规则管理。
- **Token 容量与记忆覆盖**：`memory.runtime.channels.<channel>.historyTokenBudget` 控制主线与据点近期历史容量（默认 `16384 Token`，可设 `1024–262144`）。主线按独立消息向前读取，工作模式在剩余预算内恢复来源有效的完整工具过程，零发言执行经窗口内有效输入接续，生成附件绑定到该执行最后一条正式发言（旧 `contextPairs` 保留侧会话兼容语义）。动态填充提供贴近当前输入与前移至上一条输入两档，按稳定用户消息定位。主线记忆覆盖键为 `message:<id>@<revision>`（用户输入、角色发言与任务结果皆可作来源），`current_execution` 选中本次消费与发表来源，`uncovered_sources` 选中截至本次尚未覆盖的来源。

### 4.2 工作上下文清理（`clear_work_context`）

- 主应用前台桌面对话向策略允许的主、侧会话开放 `clear_work_context`（在 NIT 脚本外直接执行，按会话、代次、逻辑执行与调用 ID 幂等）。
- 提交后在 `work_context_clears` 登记当前已存在的消息与执行边界（最新边界存来源集合，旧行保留操作回执；重复调用返回原回执）。本次清理所属的完整原生工具批次作为新工作起点：较早工具过程自下一次模型请求起退出，当前请求与热轨迹仅在新边界实际提交时清理（并拒绝在途旧缓存提交），普通会话资料保留，角色记事本在结算时重读并作为独立快照注入。
- 恢复同一逻辑执行时沿已应用的调用标识继续积累轨迹，侧会话分页预算按清理后有效材料计费。清理边界随逻辑备份导出（导入时重写消息、执行、轮次与调用引用），检查点复制当前边界并映射新消息，主线重置清除旧代次清理回执。（据点与子应用各自清理合同暂未开放，列入后续规划。）

---

## 5. 生命周期、重置与角色共享状态

### 5.1 生命周期与主线重置

- 服务端对会话返回 `threadKind`、`generation`、`canDelete`、`canFork` 与 `canReset`。主线支持单条消息编辑、撤回与重新生成，整条会话通过清空重置维护。
- `POST /api/chat/threads/:id/reset` 取得历史变更占用，取消当前执行、待审批与待回应事项，推进持久代次 `generation` 并软删除当前消息（`deletedBy='reset'`，保留来源追溯），同事务清理心流、修订记录、计划、计划变更与工作上下文清理边界。重置保留 Thread ID、模型与工具设置、角色共享状态、长记忆与工作区文件；亲历保留原来源记录，当前视角仅读取新代次经历。
- **酒馆变量与清库边界**：酒馆变量采用串行队列与 `scopeEpochs`，局部变量清理与 Thread 代次推进在同一 SQLite 事务提交，全局变量内容保留但旧代次产生的局部与全局写入均在提交时失效。危险区域全量清空同样保留主线身份、取消在途交互并清理局部变量（全局变量保留内容并失效旧提交版本）。
- **代次校验**：执行、队列输入、任务交付、工具状态、计划、心流与记事提交均携带代次并与计数同事务保存；运行时注销与队列派发按占用身份结算，旧执行收尾回调仅释放自身占用。重置发布 `thread_reset`，客户端更新代次并刷新投影，Surface 帧与快照携带 `threadGeneration` 使 Compositor 与桌宠丢弃过期帧。

### 5.2 角色共享状态（`PetStateService`）

- 共享字段包含 `mood`、`vibe`、`mind` 以及最长 `8000` 字符的 `ongoingGoals`、`commitments` 与 `relationships`（空字符串表示清除）；`flow_states` 中的 `currentGoal / privateFacts` 在主线与据点共用，侧会话独立，任务与计划各自维护进度。心流补丁与撤回详见 [角色状态](./B10_CHARACTER_STATE.md)。
- `update_state` 与 `finish_task` 共用 `PetStateService`，状态补丁携带角色、Thread、代次、逻辑执行来源与工具调用编号实现幂等；临时触碰、闲置与欢迎台词保留原始事件时间并按 `6` 小时有效期与池容量投影。
- 上下文编译携带角色状态版本，执行期间共用版本引用；跨场景并发提交返回版本冲突与最新状态供执行方重试，NIT 子工具继承同一版本与代次。消息撤回通过追加来源补偿事件重放消除被撤回贡献，保留其他场景有效字段；主线重置保留角色共享事件。旧 `thread_character_state_events` 仅作会话兼容与检查点历史基线保留。

---

## 6. 记忆来源、据点执行与恢复兼容

### 6.1 记忆来源与遗忘

- 自动对话补记仅扫描主线（入队、批次与写入均核验主线身份与代次）；侧会话支持共享记忆检索与工作区记事本维护，角色级后台开关统一控制补记与维护。
- 主线普通对话、主动活动与任务交付按各自来源炼化，据点经历采用 `experience:<id>` 覆盖键，后台按私聊与据点来源分别分批并保留各自 Channel（亲历直接读取权威房间消息）。
- 记事来源记录 `generation`、`messageRevisions` 与可选 `experienceIds`，在 SQLite 准备写入与异步向量化后 TriviumDB 提交两个边界核验来源：过期且未落入 TDB 的准备草稿标为 `discarded` 并清理占位条目，修订则解除待替代关联；跨会话修订经 `origin.sources` 保留多方来源引用。消息事件与事实同事务写入 Outbox，主线执行结算发布 `conversation.execution.settled`，`EventNoteDraftCommitter.consumeExecution / consumeMessage` 保留历史已受理草稿的幂等恢复职责（参见 [记忆引擎](./A05_MEMORY_ENGINE.md)）。
- 消息撤回保留已炼化记忆并在来源页标注撤回/修订状态；永久遗忘经 `PrivacyDeletionService` 清除记忆、派生资料并登记跨会话遗忘标记，记忆重置同步推进聊天与亲历截止编号。

### 6.2 据点执行与生活经历侧栏

- **房间与调度**：`GroupChatService.sendMessage` 在同一事务落盘公共消息、当时在场者亲历引用（每条消息分别确立在场关系，普通旁听仅形成亲历；角色移动连同成员资格提交）及 `metadataJson.replyIntent`（目标主线与代次、待回复队列、进度）与 Outbox 事件。`StrongholdRoundService` 由 Outbox 唤醒与周期扫描共同驱动，按房间、角色、轮次与主线代次去重（单角色最多尝试 3 次），中断恢复继续处理未结算队列，撤回来源或重置目标主线后跳过旧请求；执行期间新追加的接收者写入同一持久意图。
- **回合执行**：`StrongholdTurnService` 以角色主线为锚点经 `KernelScheduler` 与 `ConversationTurnService` 编译 `group` 权限并执行，同时注入房间亲历与主线私聊近期原文，酒馆局部变量按 `group + roomId + agentId + 主ThreadId` 隔离。最终回复写回原房间并保留审计元数据（已退出写入房间×角色隐藏问答 Thread，`recordPairVisibility` 仅保留旧数据兼容入口）。更多据点与条件等待契约见 [据点生活](./B32_STRONGHOLD_LIFE.md) 与 [主动行为](./B20_PROACTIVE_WORK.md#据点接话与条件等待)。
- **生活经历侧栏**（`ThreadExperiences.vue`、`thread-experiences.css`）：主线输入栏右侧可展开独立侧栏，按需拉取最近 60 条亲历（最新在前、按本地日期分组、展示头像/据点/时间，支持局部搜索正文/发言者/据点、默认节选与点击展开全文；刷新保留列表，切会话/重置/离开自动收起并作废过期请求）。样式采用直角边框、主题强调色与像素字体（含代码/图片/公式局部框），复用 `PDrawer`（统一遮罩、直角关闭按钮、焦点管理、Escape 关闭与滚动锁）。Social 使用独立 Application、Realm、授权、历史与心流，宿主咨询仅传递请求与辅助资料并返回原应用。

### 6.3 投影、重新生成与备份快照

- **Surface 投影**：主线 Assistant Surface 默认 `processCollapsed = true`，正式发言独立显示并允许展开思考、工具、重试与中间叙述；`surface.publish` 执行期同步已发表消息，`surface.commit / surface.settled` 结算最终现场。
- **撤回与重新生成**：`POST /api/chat/threads/:id/regenerate` 接收消息 ID、修订与客户端幂等 UUID 并经队列派发新执行：选中角色发言时替换该条（首条替代发言发表时同事务撤回旧回复，发表前失败原回复仍有效）；选中用户输入时保留原文并重做关联回复，主动发言同样适用；原消息内容、修订及用户附件按归属恢复到触发资料。旧 `rewind` 契约保留兼容，文件恢复由 `restoreFiles` 按执行快照核对现有文件独立控制；来源变化撤销对应执行贡献并重新开放已回答的有效问题。
- **备份与分布式快照**：逻辑备份包含独立消息、执行、待回应事项、来源关系、状态事件、亲历与引用房间记录，导入时重写发布/执行/来源 ID；若导入主线与本机主线冲突则自动降为侧线（归属侧线的亲历留作历史资料，不参与主线据点编译），运行中执行恢复为中断，等待现场按有效来源保留；逻辑导入将据点回复意图标为已结束，完整快照保留原意图用于恢复。`flow_states` 通过 `(thread_id, agent_id)` 唯一索引处理导入冲突与引用重写；分布式快照写出 `schemaVersion = 2`，兼容读取 `v1` 迁移并拒绝旧客户端直接写回新结构。

---

## 7. 源码入口

- **数据库与 Thread**：`database/schema.ts`、`database/migrations/0025_main_side_threads.sql`、`0034_work_context_clears.sql`、`repositories/thread.repo.ts`、`services/thread/threadService.ts`、`threadForkService.ts`
- **对话、队列与记忆**：`repositories/conversation.repo.ts`、`tools/conversation`、`packages/shared/src/conversation.ts`、`services/conversation/conversationTurnService.ts`、`conversationQueueService.ts`、`services/memory/eventMemoryFallbackService.ts`、`eventNoteDraftCommitter.ts`
- **状态、编译与据点**：`services/agent/petStateService.ts`、`services/context/contextCompiler.ts`、`services/stronghold/groupChatService.ts`、`strongholdRoundService.ts`、`strongholdTurnService.ts`
- **变量、清理与投影**：`services/prompt/sillyTavernVariables.ts`、`services/maintenance/privacyDeletionService.ts`、`projections/conversationProjectionService.ts`、`conversationSurfaceSession.ts`
- **前端**：`packages/frontend/src/stores/useThreadStore.ts`、`usePetStateStore.ts`、`components/compositor/ConversationSurface.vue`、`components/chat/MainThreadCard.vue`、`ThreadExperiences.vue`、`thread-experiences.css`
