# 后端架构

> **适用范围**：`packages/backend/` 全部代码
> **技术栈**：Hono + Drizzle ORM + better-sqlite3 + TriviumDB

---

## 1. 三层架构与职责边界

后端交互由每个角色的唯一主 Thread 锚定，SideThread 承载局部或分支对话；具体状态归属、事务边界与跨场景恢复见 [主侧会话与角色持续状态](./B26_MAIN_SIDE_THREADS.md)。整体代码按三层组织，层间禁止越权调用（详见 [S05 代码质量标准](./S05_CODE_STANDARDS.md#2-三层架构约束)）：

```text
Router 层 (routers/)      ──▶ 接收请求 → Zod 校验 → 调用 Service → 包装响应
Service 层 (services/)    ──▶ 业务逻辑编排 → 调用 Repository / 外部服务
Repository 层 (repositories/) ──▶ 数据访问（SQLite via Drizzle / TriviumDB）
```

---

## 2. Router 与错误处理

- Router 由 `app.ts` 挂载，从 `AppContext` 获取服务实例，使用项目级 `validate()` 包装器完成参数校验。
- `app.ts` 注册 `middleware/errorHandler.ts`：业务异常 `AppError` 按业务码映射 HTTP 状态并输出标准信封；未捕获异常记录服务端日志并返回 `INTERNAL_ERROR`。错误消息在展示边界通过 i18n 转换，业务状态码定义见 [S02 API 响应规范](./S02_API_SPEC.md)。

---

## 3. DI 容器与生命周期

- `container.ts` 定义 `AppConfig`、`AppContext`、`createAppContext()` 与 `initAppContext()`，按依赖顺序装配数据库连接、Repository、领域服务、Kernel 运行时与 Application 集成。
- `lifecycle/startup.ts` 负责服务的启动、端口监听与优雅关闭（含 SQLite WAL checkpoint 与后台任务回收）。

### 3.1 交流执行统一准入

生产容器为 `ConversationTurnService` 注入同一 `KernelScheduler`。HTTP、SSE、持久消息队列、CLI 和迟到回答续聊的根级执行统一在准备输入和调用模型前准入，普通对话使用 `interactive` 类别及 `thread:<threadId>` 资源键。同角色不同 Thread 可并发，同 Thread 执行串行。默认总运行数为 4，交互类最多 2、后台类最多 2，其他类别沿调度器配置。用户活动在排队前通知主动行为服务，使主动回合及时让出。排队请求固定主线代次，实际准备输入时复核。

后台任务、据点和语音传入的 Execution 由调用方结算，交流服务复用身份并通知执行观察者。已有调度执行调用链中的内部交互复用父级准入，内部执行记录关联父 Execution。流式事件通过有界通道转交，消费者结束时取消生成器并等待调度名额释放。会话暂停与等待保存在交流领域，本次调度执行段完成后释放运行名额。

---

## 4. 存储与结构迁移

### 4.1 SQLite 持久化与刷盘分级

主库连接在 `database/connection.ts` 创建，默认启用以下 PRAGMA 配置：

- `journal_mode = WAL`、`synchronous = NORMAL`、`journal_size_limit = 64MB`（`67108864`）
- `temp_store = MEMORY`、`busy_timeout = 5000`、`cache_size = -20000`、`foreign_keys = ON`、`secure_delete = ON`

常规配置与流式结算沿用 `synchronous = NORMAL`，避免容器挂载卷下频繁同步刷盘阻塞主线程；用户消息显式入队与队列变更通过 `durableQueueWrite()` 在事务边界临时提升至 `synchronous = FULL`，确保同步落盘后再向客户端确认。事件记忆在 SQLite 与 TriviumDB 间的备份和重建分工见 [记忆引擎](./A05_MEMORY_ENGINE.md)；Steam 云存档的启动前快照替换在 `createDrizzleConnection()` 打开数据库前原子执行（详见 [M04 Steam 集成](./M04_STEAM_INTEGRATION.md)）。

### 4.2 结构迁移与执行记录对齐

`database/schemaMigrations.ts` 统一承接启动与 CLI 的结构迁移：

1. **旧单基线库兼容**：先在 `__drizzle_migrations` 登记 `0000_baseline` 记录，再由 Drizzle 执行后续增量迁移。
2. **已有记录对齐**：按 SQL 文件的 SHA-256 摘要（兼容 LF/CRLF）优先认领已执行项，未认领项按 `_journal.json` 的 `when` 时间戳匹配；重排仅更新 `created_at`，保留原始摘要。
3. **缺口补齐**：最后一个已执行项之前的缺口在同一事务内补执行并登记（失败时整批回滚），其后的新增迁移交由 Drizzle 标准迁移事务执行。
4. **历史特例**：`0025_main_side_threads` 针对已登记旧库额外核对并补齐消息的 `publication_id` / `execution_id` 及交流执行相关表和索引；后续结构变更统一追加标准 SQL 迁移文件。

---

## 5. LLM 调用、提示词缓存与故障恢复

`services/llm/types.ts` 定义统一的 Provider 接口，`services/llm/llmService.ts` 按请求协议选择 OpenAI 兼容 Chat Completions、OpenAI Responses、Gemini 或 Anthropic 实现；连接认证与模型角色映射规则见 [服务商连接](./B22_PROVIDER_CONNECTIONS.md)。

### 5.1 提示词前缀稳定性

缓存优化通过稳定输入前缀提高上游服务商的自动命中率，自身不额外发起请求或修改消息历史顺序：

- **分段布局**：系统段固定放置静态规则；时间、心情、RAG 与环境状态统一放在靠近当前输入的 `turn_context`。工具与 Schema 键通过 `services/llm/promptCache.ts` 的 `canonicalTools()` 按常驻工具优先、动态工具置后的顺序稳定排序。
- **工具菜单稳定**：工作模式自首轮请求起即在工具列表中包含 `finish_task`（调用合法性仍由执行侧门控控制），避免业务工具执行后菜单发生结构跳变；聊天与极简模式保持原菜单。
- **透传策略**：Anthropic 与 OpenAI 兼容接口均直接发送稳定后的标准消息，不附加 `cache_control` 或 `prompt_cache_key` 等额外控制字段，是否缓存及计费策略由上游服务商决定。
- **度量与排障**：每次请求记录 `prompt_hash`、`prefix_hash` 与 `tools_hash`，缓存读写用量按 [B16 用量账本](./B16_TOKEN_USAGE.md) 统计。

### 5.2 重试退避与中断恢复

- **退避策略**：`services/llm/retryPolicy.ts` 对临时 HTTP 状态（`408 / 429 / 500 / 502 / 503 / 504`）、网络异常及已知临时上游错误码执行可取消的指数退避（单次等待上限 30 秒，优先尊重 `Retry-After`）；ReAct 单轮最多重试 5 次，并与外层共享总预算。参数、鉴权、配额耗尽、主动取消及退化重复错误（`GenerationLoopError`）直接终止，不自动重试。
- **流式中断续接**：流式响应未收到完成标记即断开时，受控 ReAct 冻结已输出片段、丢弃未完成工具参数草稿后重新请求当前轮，已完成的工具调用不重放。
- **重试时间线与预算投影**：每次重试生成独立的 `model_retry` 时间线块与 `model-retry` Surface 节点，固定记录原因、计数与退避时长并随消息持久化。每轮 ReAct 在裁剪后通过 `context_budget` 报告当前请求估算并在上游返回真实用量后更新。草稿预览通过 `disableMemoryRetrieval` 跳过远程记忆检索，返回 `memoryRetrievalDeferred` 标记。

### 5.3 Embedding 健康冷却与验证页识别

- **健康冷却**：`ApiEmbeddingProvider`（`services/embedding/providers/apiProvider.ts`）将服务配置启用状态与运行期健康状态分离：遇到验证页、鉴权失败或无效向量时冷却 5 分钟；常规网络/服务故障冷却 30 秒；429 默认冷却 60 秒（有 `Retry-After` 时在 1 秒至 30 分钟内采信）。冷却期内直接报错，到期后仅放行一次恢复探测，配置变更立即取消旧请求并重建实例。
- **兼容端点与校验**：OpenAI 兼容 `/models` 探测仅在返回 404/405 且非验证页时尝试兼容路径。Embedding、Reranker 与 LLM 接口统一识别 `cf-mitigated: challenge` 及 HTML 验证页特征并转为可读配置提示，日志不输出原始网页正文。

---

## 6. Gateway 层

- **端点与协议**：与 HTTP 共用 `:9120` 端口；WebSocket 升级时校验设备身份，随后完成版本化 Hello 握手与 Shared Schema 校验；远程部署 TLS 策略见 [A04 部署架构](./A04_DEPLOYMENT.md)。
- **文件组织**（`services/gateway/`）：
  - `gatewayHub.ts`：WS Hub，管理连接、心跳、订阅、版本协商与消息路由
  - `wsUpgrade.ts`：Hono WebSocket 升级与 JSON Envelope 入口
  - `durableGatewayStream.ts`：可持久化的 Gateway 事件流
  - `notificationTargetFilter.ts`：通知推送目标过滤
  - `types.ts`、`index.ts`：连接事件类型与公开入口
- **装配方式**：`GatewayHub` 通过注入的持久通知 Repository 提供通知推送能力，Application 通过受限 Host ABI 接入，不在 Gateway 层承载领域业务编排。

---

## 7. AIOS 领域对象边界

后端以 [A09 AIOS 核心架构](./A09_AIOS_ARCHITECTURE.md) 为基线，各域严格按权威对象分工：

| 领域 | 后端权威对象 | 边界职责 |
| --- | --- | --- |
| PrincipalAgent | 身份、人格定义、长期资源关联 | 跨场景角色锚点，不持有窗口级 UI 状态 |
| Thread | 对话边界、消息事实、`channel` 与 `policy` | 维护会话历史，不直接持有长期记忆 |
| Context Runtime | 只读编译模型输入与 `ContextManifest` | 只读装配，编译期间不修改持久化状态 |
| Memory | `EventNote`、`ConversationCoverage`、`Provenance` | 独立记忆权威，不将原始 Thread 等同长记忆 |
| Workspace | Agent 私有工作区与路径 containment | 隔离读写，不越界写只读内置/Workshop 资产 |
| Tool Capability | `(agentId, channel)` 权限矩阵与资源范围 | 请求上下文必须显式传入 `agentId / threadId / channel` |
| Application Integration | Application 协议、Adapter、Endpoint 与 Port | 通过公开 Port 交互，不直接注入 `AppContext` 或主库 |

### 7.1 运行时上下文与编译

- 进入 Service / Tool 执行链的上下文必须显式携带 `agentId`、`threadId` 与 `channel`，外部消息由 `InboundRoute` 确定归属，后台任务从任务记录读取。
- 聊天入口仅向后端提交当前输入与 `threadId`。`ContextCompiler` 在 `CapabilityGate` 判定工具集后，通过 `Promise.all` 并行执行自动 RAG、知识库召回、角色状态与心流读取，最终按固定顺序只读组装消息。

### 7.2 纯 Node 运行时与第三方应用隔离

- `packages/backend` 保持纯 Node.js 运行时，不导入 Electron；本机或移动端平台能力通过 `CapabilityGate` 委托给已连接的 Capability Provider 节点。
- 第三方应用通过独立进程或 Node Host 接入，Backend Adapter 只使用公开 Port 与 Kernel Envelope，不接触主数据库、DI Container 或明文凭据（详见 [A10 应用集成](./A10_APPLICATION_INTEGRATION.md)）。
