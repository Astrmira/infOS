# API 响应规范

> **适用范围**：infOS 后端的 JSON 业务 API；流式、文件和其他特殊响应见各接口契约。

---

## 1. 统一响应信封

JSON 业务接口使用以下信封。Router 应优先使用项目级响应工厂；`apiContractMiddleware` 为适用的 API 响应补齐默认 `message`，并拦截未注册业务码。SSE、文件与资源响应使用各自的格式。

```typescript
interface ApiResponse<T = unknown> {
  /** 业务状态码（UPPER_SNAKE_CASE，从规范表中选取） */
  code: string
  /** 面向用户的消息；展示时按当前语言本地化 */
  message: string
  /** 业务数据（成功时）或错误详情（失败时） */
  data?: T
}
```

---

## 2. message 规范

### 2.1 默认 message 注册表

每个 code 在 `@infos/shared` 中注册默认中文 message：

```typescript
// @infos/shared/src/constants/responseCodes.ts
export const CODE_MESSAGES: Record<string, string> = {
  OK: '操作成功',
  CREATED: '创建成功',
  // 完整列表见下方规范表
}
```

### 2.2 规则

- **大多数场景**：使用默认 message，保证一致性
- **需要上下文时**：后端可覆盖默认 message，通过国际化词条和占位符提供具体信息
- **展示与翻译**：中文是消息词条原文，前端展示错误时通过诊断翻译入口转换为当前语言。业务判断使用稳定的 `code`，动态信息使用占位符；详见 [国际化说明](./B25_I18N.md)。

```typescript
// 使用默认 message
throw new AppError('NOT_FOUND')
// → { code: "NOT_FOUND", message: "请求的资源不存在" }

// 覆盖 message 时使用对应运行端的国际化入口
throw new AppError('NOT_FOUND', { message: t('errors.backend', '目标会话不存在') })
```

---

## 3. data 字段

| 状态                    | data 内容                        | 必须       |
| ----------------------- | -------------------------------- | ---------- |
| 成功 + 有业务数据       | 业务对象 / 列表 / 分页结构       | **必须**   |
| 成功 + 纯操作（删除等） | 省略                             | 可选       |
| 失败 + 需前端精细处理   | 错误详情（字段校验、重试时间等） | **建议有** |
| 失败 + 通用错误         | 省略                             | 可选       |

---

## 4. HTTP 状态码清单

本项目使用以下 **17 个** HTTP 状态码，不使用 204：

| HTTP 码 | 标准语义               | 使用场景                       |
| ------- | ---------------------- | ------------------------------ |
| **200** | OK                     | 查询、更新、删除、动作执行成功 |
| **201** | Created                | 新建资源成功                   |
| **202** | Accepted               | 异步任务已入队                 |
| **400** | Bad Request            | 请求参数有误、校验失败         |
| **401** | Unauthorized           | 未认证、Token 无效/过期        |
| **403** | Forbidden              | 已认证但无权限                 |
| **404** | Not Found              | 资源不存在                     |
| **405** | Method Not Allowed     | HTTP 方法不对（框架自动处理）  |
| **409** | Conflict               | 资源冲突（重名、重复创建）     |
| **413** | Payload Too Large      | 上传内容/文件过大              |
| **415** | Unsupported Media Type | 不支持的文件/内容类型          |
| **422** | Unprocessable Entity   | 请求合法但业务上无法处理       |
| **429** | Too Many Requests      | 客户端请求频率过高             |
| **500** | Internal Server Error  | 服务内部错误                   |
| **502** | Bad Gateway            | 上游服务返回错误（LLM API 等） |
| **503** | Service Unavailable    | 服务暂不可用（启动中/维护中）  |
| **504** | Gateway Timeout        | 上游服务超时                   |

---

## 5. 完整 Code 规范表

> **严格约束**：后续开发 **有且只能** 使用以下 code。新增 code 必须先更新本文档。

### 5.1 成功类 (2xx)

| HTTP | code             | 默认 message             | data                   | 场景                                                      |
| ---- | ---------------- | ------------------------ | ---------------------- | --------------------------------------------------------- |
| 200  | `OK`             | 操作成功                 | 业务数据或省略         | 查询、更新、删除、通用成功                                |
| 200  | `NOT_CONFIGURED` | 配置未设置               | `{ key, value: null }` | 请求了尚未初始化的 KV 配置，使用其兜底并避免 404 日志告警 |
| 201  | `CREATED`        | 创建成功                 | 新创建的资源           | 新建记忆、模型、Agent                                     |
| 202  | `ACCEPTED`       | 任务已提交，正在后台处理 | `{ taskId?: string }`  | 重索引、维护、梦境生成                                    |

### 5.2 客户端错误类 (4xx)

| HTTP | code                     | 默认 message             | data                                 | 场景                    |
| ---- | ------------------------ | ------------------------ | ------------------------------------ | ----------------------- |
| 400  | `BAD_REQUEST`            | 请求参数有误             | 可选                                 | 通用兜底                |
| 400  | `VALIDATION_ERROR`       | 请求参数校验失败         | `{ fields: Record<string, string> }` | Zod 校验不通过          |
| 400  | `MISSING_FIELD`          | 缺少必填字段             | `{ field: string }`                  | 必填字段未传            |
| 400  | `INVALID_FORMAT`         | 请求格式错误             | 可选                                 | JSON 解析失败           |
| 400  | `OUT_OF_RANGE`           | 参数值超出允许范围       | `{ field, min?, max? }`              | importance > 10         |
| 400  | `INVALID_PARAMETER`      | 参数类型或值无效         | `{ field, expected }`                | 期望 number 传了 string |
| 401  | `UNAUTHORIZED`           | 未认证，请先登录         | —                                    | 通用兜底                |
| 401  | `TOKEN_EXPIRED`          | 认证已过期，请重新登录   | —                                    | 凭据过期                |
| 401  | `TOKEN_INVALID`          | 认证信息无效             | —                                    | 凭据无效                |
| 403  | `FORBIDDEN`              | 无权执行此操作           | —                                    | 权限不足                |
| 404  | `NOT_FOUND`              | 请求的资源不存在         | `{ resource?, id? }`                 | 通用资源不存在          |
| 404  | `AGENT_NOT_FOUND`        | 指定的 Agent 不存在      | `{ agentId }`                        | 查询不存在的 Agent      |
| 404  | `MEMORY_NOT_FOUND`       | 指定的记忆不存在         | `{ memoryId }`                       | 查询不存在的记忆        |
| 404  | `MODEL_NOT_FOUND`        | 指定的模型配置不存在     | `{ modelId }`                        | 切换不存在的模型        |
| 405  | `METHOD_NOT_ALLOWED`     | 不支持该请求方法         | —                                    | 框架自动处理            |
| 409  | `CONFLICT`               | 资源冲突                 | 可选                                 | 通用兜底                |
| 409  | `DUPLICATE_NAME`         | 名称已存在               | `{ name, existingId? }`              | 模型名重复              |
| 409  | `ALREADY_EXISTS`         | 资源已存在               | `{ resource }`                       | 重复创建                |
| 409  | `REACT_TURN_LIMIT`       | 已达到执行轮次上限，任务尚未完成 | 可选                         | 执行达到轮次上限        |
| 413  | `PAYLOAD_TOO_LARGE`      | 上传内容过大             | `{ maxSize, actualSize? }`           | 文件超限                |
| 415  | `UNSUPPORTED_MEDIA_TYPE` | 不支持该文件类型         | `{ received, allowed[] }`            | 格式不支持              |
| 422  | `UNPROCESSABLE`          | 请求无法处理             | 可选                                 | 通用兜底                |
| 422  | `RESOURCE_BUSY`          | 资源正忙，请稍后再试     | `{ resource }`                       | 正在重索引              |
| 422  | `TASK_ALREADY_RUNNING`   | 该任务已在运行中         | `{ taskId? }`                        | 重复提交任务            |
| 422  | `PRECONDITION_FAILED`    | 前置条件不满足           | `{ reason }`                         | 缺少前置配置            |
| 429  | `RATE_LIMITED`           | 请求过于频繁，请稍后再试 | `{ retryAfter? }`                    | 限流                    |

### 5.3 服务端错误类 (5xx)

| HTTP | code                   | 默认 message               | data                        | 场景                    |
| ---- | ---------------------- | -------------------------- | --------------------------- | ----------------------- |
| 500  | `INTERNAL_ERROR`       | 服务内部错误，请稍后再试   | 可选                        | **通用兜底**            |
| 500  | `DB_ERROR`             | 数据库操作失败             | `{ operation? }`            | SQLite / TriviumDB 异常 |
| 500  | `CONFIG_ERROR`         | 配置异常                   | `{ key? }`                  | 配置缺失/格式错误       |
| 502  | `LLM_ERROR`            | AI 服务异常，请稍后再试    | `{ provider, model? }`      | LLM API 错误            |
| 502  | `LLM_RATE_LIMITED`     | AI 服务繁忙，请稍后再试    | `{ provider, retryAfter? }` | LLM 429                 |
| 502  | `EMBEDDING_ERROR`      | 向量服务异常               | `{ provider }`              | Embedding 失败          |
| 502  | `EXTERNAL_ERROR`       | 外部服务异常               | `{ service }`               | MCP/TTS 等失败          |
| 502  | `MCP_ERROR`            | MCP 服务调用失败           | `{ server?, tool? }`        | MCP 工具执行失败        |
| 503  | `SERVICE_UNAVAILABLE`  | 服务暂不可用               | —                           | 通用兜底                |
| 503  | `SERVICE_INITIALIZING` | 服务正在启动中，请稍后再试 | —                           | 未完成初始化            |
| 504  | `GATEWAY_TIMEOUT`      | 上游服务响应超时           | `{ service? }`              | 通用超时                |
| 504  | `LLM_TIMEOUT`          | AI 服务响应超时            | `{ provider, model? }`      | LLM 超时                |

注册表及 HTTP 映射的权威来源是 `packages/shared/src/constants/responseCodes.ts`；新增或调整业务码时同步维护本文。

---

## 6. AppError 实现

`packages/backend/src/lib/appError.ts` 中的 `AppError` 接收 shared 定义的 `ResponseCode`，从 `CODE_MESSAGES` 和 `CODE_TO_HTTP` 读取默认消息与 HTTP 状态。调用方可传入 `message`、`data` 和 `cause`；错误处理器负责将错误转换为响应。业务码、消息和状态映射统一维护在 `packages/shared/src/constants/responseCodes.ts`。

---

### 6.1 校验与状态绑定

- 所有 Zod 请求校验必须使用项目级 `validate()` 包装器，避免直接使用 `@hono/zod-validator` 的默认错误体。
- 校验失败统一返回 HTTP 400 与 `VALIDATION_ERROR` 信封，字段错误放入 `data.fields`。
- HTTP 201 必须使用 `CREATED`，HTTP 202 必须使用 `ACCEPTED`；动作成功且未创建新资源时使用 HTTP 200 与 `OK`。
- Router 仅使用在 `ResponseCode`、`CODE_MESSAGES` 与本文档注册的业务码。

---

## 7. 分页响应

分页参数与返回结构由具体接口定义。例如记忆档案查询的 `page` 默认为 1，`pageSize` 默认为 30、最大为 100；超出校验范围的参数会被拒绝。返回数据包含 `items`、`page`、`pageSize`、`total`、`pageCount`、`facets` 和 `stats`，页码超过末页时调整到有效页。其他列表也可能使用游标，应以对应路由和共享类型为准。

---

## 8. 流式 / SSE 响应

`/api/chat/stream` 使用 SSE。正文、思考过程、工具调用、状态等对话呈现由 `ConversationSurfaceSession` 转换为 `surface` 帧；检索进度使用 `rag_progress`，结束和错误分别使用 `done`、`error`。路由还会发送心跳。帧结构以 `@infos/shared` 中的 Surface 类型及 `chatStreamRunner.ts` 为准。

## 9. AIOS Thread、SSE 与能力契约

队列和 SSE 共用 `runChatStream`。执行器交付类型化事件，SSE 路由编码事件数据，Gateway 直接把 Surface 对象编码进 WebSocket 信封。Surface 字节统计复用这两处生成的 JSON 字符串。

WebSocket 客户端可在 `hello.features` 声明 `thread-surface-sync-v1`。服务端在 `hello_ack.features` 确认后，客户端通过 `gateway.watch_thread` 发送 `{ threadId, watching }`。订阅随连接释放，重连时重新登记。该连接只接收所观察 Thread 的实时会话帧；后台回复提醒仍按原有通知受众投递。旧客户端使用原有完整帧。

同一连接首次收到某个 Thread 的历史投影时，`surface` 推送携带 `frame`。后续推送可携带 `delta`，其 `baseOperationId` 指向上次投影帧。消息与 Surface 列表按新页面顺序排列，未变化的记录使用 ID，新增和修改的记录使用完整对象。分页字段与撤回墓碑取自新页面。切换投影归属、会话代次或重新订阅时从完整帧开始。客户端遇到基线缺失时重新观察该 Thread，并通过 HTTP 恢复当前状态。编解码入口见 `packages/shared/src/threadSurfaceSync.ts`。

入队、领取、暂停、调序和结算等变更触发 `conversation_queue_changed`，其中只含 `threadId`。观察端收到通知后读取队列接口，多个紧邻的通知可以合并。持久通知的重放仍通过 `gateway.subscribe` 和游标完成。

`GET /api/chat/queue/:threadId` 可返回 `data.terminalOperationId`，对应当前历史首页最近一次队列终态帧的 `operationId`。服务端核对投影缓存、会话代次、消息计数和最后消息时间。客户端已应用同一终态时可省去结算后的历史请求，缺少标识时沿用历史恢复流程。

`POST /api/chat/queue/:threadId` 继续使用客户端生成的 UUID `clientMessageId`。主会话执行期间默认补充本轮，可传 `delivery: "next_turn"` 单独排队。返回的队列项可带服务端填写的 `input.supplementTo`，指向目标主会话执行。客户端可用该字段在同一发言者下预览用户正文，按正式消息的 `publicationId` 接替预览。任务事件沿宿主投递路径录入。

主会话消息投影可带 `timelineGroupId`。补话错过当前执行时，它标明后续消息在前端沿用的原气泡组。`executionId` 和消息游标仍指向实际执行与持久历史位置。

交互 API 的领域边界以 [A09_AIOS_ARCHITECTURE](./A09_AIOS_ARCHITECTURE.md#10-api-与流式契约) 为准：后端从 `threadId` 推导 `agentId`、`channel` 和上下文策略，客户端仅提交当前输入。主侧会话的领域契约见 [主侧会话与角色持续状态](./B26_MAIN_SIDE_THREADS.md)，核心生命周期入口包括 `POST /api/chat/threads/latest`（兼容返回唯一主线）、`POST /api/chat/threads`（创建侧线）、`POST /api/chat/threads/:id/reset`（清空主线）、`GET /api/chat/threads/:id/experiences`（亲历来源）和 `POST /api/chat/threads/:id/fork`（侧线检查点复制）；Thread 响应携带主侧类型、代次与操作能力。

- `ThreadChannel` 仅包含 `desktop`、`group`；前者由主 Agent Compiler 处理，后者专属于 Stronghold。
- Social、Arca 等 Application Realm 身份由 `appId/realmId` 表达，保持全局 `ThreadChannel` 枚举精简。
- 内部工具调用与结果使用 `callId` 关联，并投影为 Surface 节点；具体字段以共享类型和投影实现为准。
- `done` 是流式成功结束的显式事件，前端收到 EOF 但缺少 `done` 时按异常截断处理。
- Provider 节点的能力协议与 SSE 业务流分离，能力调用消息的类型统一由 `@infos/shared` 定义。

主线交流按独立消息、逻辑执行和待回应事项持久化，完整来源及恢复合同见[主侧会话参考](./B26_MAIN_SIDE_THREADS.md)。Projection 消息提供可选 `publicationId`、`executionId`、`sourceMessages`，独立过程记录标记 `executionRecord`。`surface.publish` 同步执行中的正式发言。`executionPending: true` 标记运行中的主线发言，时间线在恢复连接时也按此字段暂存。`surface.commit` 或 `surface.settled` 携带结算快照，客户端按快照一次呈现本次回复。

`DELETE /api/chat/threads/:id/execution-records/:executionId` 撤下主线独立过程记录，返回最新投影及形如 `execution:<executionId>` 的 `deletedMessageIds`。执行审计、等待事项和正式消息继续保留。

`rewind-preview / rewind` 接受 `preserveInputAttachments` 和 `restoreFiles`。主线预检返回 `scope` 与明确的 `messageIds`，普通撤回处理指定消息，重新生成按输入的消费关系定位回复，文件恢复单独选择。侧线继续返回既有分支回滚清单。

主线的独立重新生成入口为 `POST /api/chat/threads/:id/regenerate`，请求体包含 `messageId`、`revision` 和 UUID `clientMessageId`，返回 `ConversationQueueSnapshot`。服务端核验源消息，派发时再次核验修订，将这次用户操作记录为执行触发资料。该入口支持角色主动发言，用户原始输入按真实来源保存。

---

## 10. 桌宠口语与导航投影

- assistant ConversationMessageProjection 增加可选 spokenReply，来源是独立口语通道，非正文摘要或正文截断。历史消息缺省时保持不播报。
- conversation_reply_ready 是发给同角色客户端的短暂 Gateway Push，字段为 agentId/threadId/messageId/spokenReply；持久化事实仍通过 Conversation Projection 恢复。
- Gateway chat 接受可选 speak=false 禁用本次自动播报；stop_speech 只取消该角色语音派发与播放，不取消 Agent 生成或后台任务。
- gateway.select_principal 将当前客户端的消息投影身份切换为指定角色；Input Seat 仍独立申请与续租。
- 语音识别二进制请求保留实际 Content-Type 编码参数；取消后客户端不再把迟到识别结果提交为对话。

## 11. 档案人工修订

以下接口使用标准信封，成功返回新版本记录（生成新的 `id`）；用户仅可修改列明字段，来源对话、所属角色与事实对象保持不变。

| 方法 | 路径 | 请求 |
| --- | --- | --- |
| PATCH | `/api/memories/:id` | `narrative`、`importance`、`affect{tones,valence,arousal}`、`participants/places/objects/topics`、`expectedStatus`、`regenerateVector`（默认 false）、UUID `operationId` |
| PATCH | `/api/knowledge/facts/:id` | `statement`、可选 `source/confidence`、UUID `operationId` |

正文上限 20,000 字符；每组标签最多 100 项、每项最多 200 字符；重要度与情感数值为 0–10 整数，可信度为 0–1。相同草稿的网络重试沿用同一个 `operationId`。版本或状态冲突返回 `CONFLICT`（409）；索引未完成返回 `RESOURCE_BUSY`；向量生成失败返回 `EMBEDDING_ERROR`。人工修订维持原归档状态，历史与已撤回事实保持只读。

## 12. 文档知识库

所有端点位于 `/api/knowledge`，使用标准信封。共享事实端点保持原有合同。

`GET /api/knowledge/recall-settings` 读取独立的自动召回设置；`PUT /api/knowledge/recall-settings` 接受 `{ "documentAutoRecall": false, "factAutoRecall": false }`（默认关闭，只控制自动注入，不影响手动查询工具与 `memory.runtime`）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/documents?query=&page=1&pageSize=30` | 资料列表、分页及统计，pageSize 最大 100 |
| GET | `/documents/:id` | 文档元数据、各部分摘要与关键词 |
| POST | `/documents` | 导入粘贴文本或网页：`kind: text/url`、可选 `title`、`content/url`、可选 `replaceId` |
| POST | `/documents/upload` | multipart 文本导入：`file`、可选 `title`、`replaceId` |
| POST | `/documents/:id/retry` | 失败的整理任务重新排队 |
| DELETE | `/documents/:id` | 取消整理，删除原文、摘要及派生索引 |
| POST | `/reindex` | 从摘要重建可选向量索引，不重复摘要整理 |
| POST | `/search` | `keywords`、`regex`、`limit≤20`、`expand`、`partIds`、`documentId`、`offset` |

导入和重试返回 `202 ACCEPTED` 与文档状态，LLM 整理在后台执行。重建返回 `202 ACCEPTED`，进度通过各文档 `vectorStatus` 获取。检索默认返回摘要与原文节选，`expand` 展开原文；结果包括 `version`、`truncated`，长部分包括字符游标 `nextOffset`。

入库规则、存储与工具上下文生命周期见 [B03_DOCUMENT_KNOWLEDGE](./B03_DOCUMENT_KNOWLEDGE.md)。
