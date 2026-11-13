# AIOS 核心架构与演进边界

> **适用范围**：infOS-TS 全项目（后端 Daemon、前端客户端、Electron 壳、资产与扩展）
> **状态**：当前架构基线与演进约束
> **最后更新**：2026-10-26
> **阅读约定**：本文定义核心架构基线与后续演进约束；各模块的当前实现状态、配置参数与边界限制以对应源码及 B 类文档为准。

---

## 实现参照与设计约束

| 架构概念 | 阅读实际实现的入口 |
| --- | --- |
| 上下文、Region 与提示词 | `services/context/contextCompiler.ts`；[B17](./B17_PROMPT_WORKSPACE.md) |
| 执行会话、审批与文件终端 | `services/execution/`、`tools/productivityRuntimeHolder.ts`；[B01](./B01_PRODUCTIVITY_RUNTIME.md) |
| 社交 Realm、平台账号与任务交付 | `packages/apps/social/runtime/`；[B21](./B21_SOCIAL_CAPABILITIES.md) |
| 持久队列与主动任务 | `services/conversation/conversationQueueService.ts`、`services/task/`；[B20](./B20_PROACTIVE_WORK.md)、[B26](./B26_CONVERSATION_QUEUE.md) |
| Application 协议与接入约束 | [A10](./A10_APPLICATION_INTEGRATION.md)、`packages/node-sdk/`、`packages/node-host/` |

未带包前缀的源码路径相对于 `packages/backend/src/`。OS 内核级强隔离、第三方生态全量适配及跨语言 SDK 等演进方向以各具体模块实际实现进度为准（参考 [B01](./B01_PRODUCTIVITY_RUNTIME.md) 与 [A10](./A10_APPLICATION_INTEGRATION.md)）。

## 1. 架构使命与核心原则

infOS 是以 **PrincipalAgent（主 Agent）内核** 为中心、可由自治 Application 扩展的 AI 工作站。系统从“单个后端进程围绕一次聊天请求集中编排状态”的模型，演进为资源边界明确、可多客户端接入、可跨发行形态运行的 Agent Runtime。

infOS 定义单一的通用自治 Application 形态：稳定身份、独立领域边界和独立生命周期的 Application Node/Realm，`Arca` 为标准参考实现。第三方开源应用保持各自的进程、UI、后端、Agent、会话和数据，通过三层 Adapter 与 Application Integration Protocol 接入，保持与进程内 `AgentAppRuntime` 的解耦。是否有 UI、是否常驻、是否使用 LLM、是否包含内部 Agent 均为应用内部策略，不构成额外的应用分类。Social 属于历史兼容特例，不作为通用生态 ABI 模板。

**Stronghold 属于主应用核心模块**，拥有主应用内的房间权威消息流、`group` Thread、管家和多 Agent 交互，不设置独立的 Application Identity、Application Realm、应用 Host 或应用工具命名空间。

### 1.1 六个一等资源

每个 PrincipalAgent（例如 Pero、Nana）拥有六个平级资源；它们通过 `agentId` 关联，不能用其中任意一个替代另一个。

| 资源                | 职责                                    | 生命周期             | 权威存储                                |
| ------------------- | --------------------------------------- | -------------------- | --------------------------------------- |
| Identity            | 人格、表达风格、行为边界与 channel 补丁 | Agent 长期存在       | Agent 定义文件与数据库元数据            |
| Long-term Memory    | 跨 Thread 的提炼记忆、候选和来源追溯    | Agent 长期存在       | SQLite + TriviumDB                      |
| Principal Workspace | Agent 的个人文件空间                    | Agent 长期存在       | `@data/principals/{agentId}/workspace/` |
| Context Runtime     | 只读编译 LLM 输入                       | 单次调用临时存在     | 内存                                    |
| Thread              | 对话边界与消息事实记录                  | 用户创建、归档或删除 | SQLite                                  |
| Tool Capability     | 工具、资源范围、参数约束和审批策略      | 随 Agent 配置存在    | Agent/扩展配置                          |

### 1.2 状态所有权

**持久状态**必须由后端权威维护，包含 Agent 配置、Thread 与消息、记忆、Workspace 文件、Capability 配置、入站路由及用户安装资产。

**运行时状态**重启后可重建，包含 LLM 调用、Context Bundle/Manifest、连接、Scheduler 执行态与取消控制器。

关键规则：

1. 后端不维护“全局活跃 Agent”或“全局活跃 Thread”。它们是**前端窗口级 UI 路由状态**。
2. 后端可同时服务多个 Agent、多个 Thread，所有请求必须显式携带或由 Thread 推导 `agentId`、`threadId`、`channel`。
3. 前端只拥有显示缓存和窗口偏好；不组装权威上下文，也不保存业务真相。
4. 切换 Agent 时必须原子地切换或创建匹配的 Thread，禁止出现不同 Agent 与 Thread 混配。
5. 消息存储、上下文编译与前端展示彼此独立；“模型看到什么”由 Context Compiler 决定，不应反向改变事实存储。

---

## 2. PrincipalAgent 与 Identity

### 2.1 Agent 身份边界

PrincipalAgent 是有长期人格、记忆和工作区的逻辑身份；会话、上下文包、工具清单和后台任务均不构成新的 PrincipalAgent。

```text
PrincipalAgent
├─ Identity
├─ Long-term Memory
├─ Principal Workspace
├─ Context Runtime
├─ Threads
└─ Tool Capability
```

Agent 逻辑身份应与未来可能存在的运行实例区分：`pero@desktop`、`pero@mobile` 和 `pero@cloud` 可代表同一 PrincipalAgent 的不同接入点；长期记忆始终归属逻辑身份，而不是某台设备。

### 2.2 Identity 组成与补丁规则

```text
Identity
├─ basePersona            核心人格，始终存在
├─ channelPatches         仅叠加场景差异
└─ behaviorBoundary       安全、隐私与内容边界
```

- `basePersona` 不因 channel 或客户端切换而替换。
- `channelPatches` 仅叠加差异，不可覆盖核心人格。
- 补丁由 Context Compiler 在编译时只读加载；Identity 本身不维护“当前模式”。
- 客户端输入或 `extraVars` 不得覆盖 `agent_name`、人格、记忆、所有者信息等核心变量。

官方、Workshop 与用户 Agent 定义可以参与资产联邦，但官方/Workshop 定义只读；运行时 Workspace 必须始终位于 `@data`，不得写入安装目录或订阅目录。

---

## 3. Thread、Channel 与消息事实流

### 3.1 Thread 的职责

Thread 是交互的持久边界，负责消息事实、修订版本与会话策略。每个角色拥有唯一主 Thread 和多个 SideThread，角色持续状态与长记忆由角色资源持有。生命周期、来源及迁移规则见 [主侧会话与角色持续状态](./B26_MAIN_SIDE_THREADS.md)。

```text
Thread
├─ id / agentId / channel / threadKind / generation
├─ platform / platformIdentifier
├─ title / status / 时间字段
├─ contextPolicy
├─ messageCount / pairCount
└─ ThreadMessage[]
```

`ThreadMessage` 必须保留 `role`、内容、`pairId`、状态、`revision`、真实 `agentId`（适用于 assistant 消息）、元数据与时间戳。删除默认是软删除，Compiler 只读取 active 消息；敏感数据擦除应使用保留 tombstone 的物理清除流程。

### 3.2 Channel 是 Thread 的持久属性

```text
ThreadChannel = 'desktop' | 'group'
```

- Channel只描述主应用内部交互入口，不得编码Arca、Social、Coding等子应用身份；子应用身份由`appId/realmId`表达。
- `group`专属于主应用Stronghold内部交互；不得被Social或其他Application Realm复用。
- Application Realm内部会话使用Realm私有Surface/Session标识，不扩大全局`ThreadChannel`联合。
- Channel 不属于 Agent 的“当前模式”，也不是临时调用参数。
- 同一 Agent 可并发拥有不同 channel 的 Thread。
- `ambient` 是请求级 Capability Scope，不是 Channel；它只能在当前 Channel 权限基础上做减法。
- App 聊天与 Pet3DView 默认进入角色唯一主 Thread，各窗口保留用户显式选择的 SideThread。
- 主动陪伴开关只控制 Agent 主动行为调度，不切换 Thread、Channel 或人格。

| Channel | 主要处理路径                    | 记忆边界   | 说明                                        |
| ------- | ------------------------------- | ---------- | ------------------------------------------- |
| desktop | PrincipalAgent Context Compiler | 主记忆     | App、Pet3DView 与本地快捷入口共享的连续交互 |
| group   | 主应用Stronghold运行时          | 房间事件流 | 主应用内部多人房间交互，不属于Application   |

### 3.3 据点事实与角色亲历

据点群聊按事实和亲历分别持有数据。

1. **房间权威消息流**：按 `roomId` 存储和展示，代表用户实际看到的房间会话。
2. **角色亲历引用**：`agent_experiences` 在每条消息提交时固定在场关系，并关联角色主线代次。

据点回合以角色主线为身份锚点，场景适配器为 Execution 编译 `group` 上下文与权限。执行通过 KernelScheduler、ConversationTurnService 和 AgentService 完成，结果回到原房间，审计过程附在房间消息上。旧 `stronghold_{roomId}_{agentId}` Thread 留作历史资料。主线私聊与据点来源按各自视图呈现。

### 3.4 主动行为与临时输入

主动陪伴、定时事件和系统触发使用目标角色唯一主 Thread，能力范围沿用各调度来源的门控策略。内部触发指令使用 `inputPersistence='ephemeral'` 参与本轮上下文，最终 assistant 回复写入主线并推送到客户端。

旧 `companion` Thread 在迁移启动时统一软删除，不合并到 Desktop 历史。

---

## 4. Context Runtime：只读编译而非状态容器

### 4.1 职责与边界

Context Runtime 在每次 LLM 调用时从 Identity、Memory、Thread、Workspace 和 Tool Capability **只读消费**，编译出 LLM Messages 与可审计 Manifest。

它不得：写入记忆、修改人格、持久化消息、执行工具或创建文件。

```text
ContextRuntime
├─ ContextCompiler
├─ ContextBundle       单次调用临时产物
├─ ContextManifest     资源使用与裁剪记录
├─ TokenBudget
└─ ContextPolicy       由 Thread 持有
```

### 4.2 三层上下文机制

| 层级     | 内容                     | LLM 介入   | 触发方式          |
| -------- | ------------------------ | ---------- | ----------------- |
| 短上下文 | 最近窗口内的原生消息     | 否         | Compiler 直接读取 |
| 长记忆   | Agent 的事件记事（EventNote） | 提炼阶段有 | RAG / 策略检索    |
| 即时检索 | Agent 主动调用的记忆工具 | 是         | ReAct 决策        |

滚动摘要不是事实真相层。它会造成双重压缩、维护复杂和额外 LLM 调用；超出窗口的历史应由可追溯的长期记忆兜底，而不是把历史反复摘要后注入 Prompt。

### 4.3 编译顺序与原生消息要求

高层编译顺序为：权限过滤 → 相关记忆检索 → active/latest revision 消息选择 → 去重 → Token 预算 → 槽位排序 → 输出 Messages/Manifest。

最近消息必须保留原生 `user` / `assistant` 角色，禁止序列化为 XML 后再塞进 system prompt，以避免历史重复注入。

典型槽位顺序：

| 位置    | 内容                             |
| ------- | -------------------------------- |
| 100–200 | 核心人格、行为边界、channel 补丁 |
| 300     | 经策略筛选的长期记忆             |
| 500     | 工具和技能描述                   |
| 600     | Workspace 引用（可选）           |
| 700     | 最近 Thread 原生消息             |
| 800     | 当前用户输入                     |
| 900     | 时间与一致性提醒                 |

### 4.4 Token 预算与 Manifest

不可压缩内容包括人格、硬规则和当前输入；近期消息、channel 补丁和必要工具为高优先级；工作区描述与旧消息可裁剪；记忆和系统知识按需检索。

`ContextManifest` 至少应记录人格/补丁版本、记忆检索项、消息范围、工具筛选、Token 明细和裁剪原因，用于回答“这条信息为何进入本轮 Prompt”。

---

## 5. Long-term Memory：事件记事与来源

长期记忆归属 PrincipalAgent，不归属 Thread；Thread 是记忆的来源，不是记忆容器。

```text
Thread 消息 / Scheduler / 主动记事
  → EventNoteDraft（本回合）
  → 回合成功持久化后提交 EventNote（系统时间轴）
  → 后台未覆盖区间补记 + Reflection 建边/归档
  → MemoryRetrieval
  → Context Compiler
```

### 5.1 EventNote 与 Provenance

每条事件记事应记录：`agentId`、`narrative`、`eventAt`（系统权威时间）、`createdAt`、`importance`、情感与结构化标签，以及完整 provenance：来源 Thread、Pair/消息 ID、channel、创建方式（主动/后台）。

来源追溯支持：

- 审计记忆为何存在；
- 判断可信度；
- 按来源处理隐私请求；
- 删除或归档 Thread 时定位受影响的记忆；
- 避免不同 Thread、不同场景的消息混批提炼。

### 5.2 提交与覆盖决策

写入只创建本回合 Draft，回合成功后才提交；后台仅处理未覆盖的连续消息区间，可产出 0~N 条事件。是否值得长期保留由模型判断，代码只负责工程幂等与覆盖边界；零事件区间以 `reviewed_no_event` 记录。

### 5.3 存储隔离与 TriviumDB 文件组

每个 Agent 的事件记忆按 `agent_{agentId}` 物理隔离（`memory.tdb`，社交侧为 `social.tdb`）；全 Agent 共享 `knowledge/facts.tdb` 与 `knowledge/knowledge.tdb`。每日人格日记写入 Workspace `dailynotes/*.md`，不进入记忆库。Mmap 存储模式下，一个 TDB 的持久化一致性组包括：

- `*.tdb`：元数据、图和 payload；
- `*.tdb.vec`：向量本体；
- `*.tdb.flush_ok`：跨文件提交标记；
- `*.tdb.wal`：崩溃恢复日志；
- `*.tdb.quiver`：可重建的 ANN 索引。

云同步必须同步持久化一致性组，排除 `*.tmp` 与 `*.lock` 等运行中间态；加载端以 `flush_ok` 校验并在必要时由 WAL 恢复。

---

## 6. Workspace 与 Tool Capability

### 6.1 Workspace 分类

| 空间                  | 所属           | 用途                             |
| --------------------- | -------------- | -------------------------------- |
| Principal Workspace   | PrincipalAgent | 日记、笔记、草稿、计划和个人文件 |
| Application Workspace | Application    | 应用项目、产物与任务资源         |
| Runtime Data Space    | 系统           | DB、配置、缓存、向量索引         |

Principal Workspace 的唯一可写根为：

```text
@data/principals/{agentId}/workspace/
├─ inbox/ notes/ diary/ drafts/ plans/
├─ documents/ attachments/ exports/
└─ archive/
```

所有 Workspace 文件操作必须做规范化 containment 检查，拒绝绝对路径、`..` 逃逸、软链接/junction 越界和未授权扩展名。`@principal` / Agent Workspace 逻辑前缀只能解析到 `@data` 下的 Agent 私有根。

### 6.2 Capability 的多层约束

权限不只是工具名白名单，而是：

```text
(agentId, channel)
  ∩ capabilityScope（default / ambient，只减不增）
  → ToolPermission
     ├─ toolName
     ├─ resourceScope（允许根、拒绝路径、scope）
     ├─ paramPolicy（可选）
     └─ requiresApproval
```

原则：

1. 工具定义注入和实际执行必须经过同一个 CapabilityGate。
2. 未配置 channel 必须 fail-closed，不能回退 desktop 全开放。
3. 平台能力（截图、剪贴板等）也必须先通过 CapabilityGate，再路由给 Provider。
4. 工具执行上下文必须显式传递 `agentId + threadId + channel + capabilityScope`，禁止默认回退到某个 Agent。
5. `ambient` 只能对 Channel 的工具与 Prompt Fragment 取交集，并清空 Skills 指引；会话选中的 Skills 直接装配完整正文，工具授权继续由现有门禁决定。
6. 文件和终端操作默认受 Workspace scope 限制；高风险动作进入审批层。
7. `run_script` 等快捷路径不得绕过统一执行器。

---

## 7. Node、Facet、控制面与能力提供者

### 7.1 Node 与 Facet

Daemon、Electron、Tauri、Web、CLI、Docker 与 Capability Host 不再被建模为互斥产品类型，而是 INF Node 上可组合的 Facet：

```text
server      Agent、Policy、Scheduler、业务权威
client      Surface、Input Seat、用户在场
capability  Browser、ComfyUI、TTS、设备能力
storage     Workspace、Asset、Credential 权威
compute     GPU/CPU 执行资源
gateway     Node Session 与 Carrier 入口
device      相机、麦克风、相册、定位、震动
```

Node Identity 是稳定安全身份，Node Session 是一次 Transport 连接。连接断开或重建不能改变对象 Authority，也不能让旧 Session Handle 继续有效。

客户端入口在任何后台启动之前决定：Electron 标准版、Steam 版和便携版可选择本地 Server Facet 或远程 Control Authority。远程模式不启动本机 Server，仅保留 Client/Capability Facet；业务连接与能力会话绑定选定服务器身份，断线不自动回退本地。模式配置与加密凭据位于客户端用户根目录，不依赖业务数据库，不参与 Steam 业务快照。切换模式通过重启生效，退出远程客户端不关闭共享服务器或其子应用。

### 7.2 Control Plane 与 Execution Plane

```text
Control Plane（通常在 Server Facet）
  Principal Agent / Planner / Policy / Approval / Placement / Binding

Execution Plane（可在任意合规 Provider Node）
  Runtime Adapter / Browser / ComfyUI / TTS / OCR / Device Input

Data Plane
  Kernel Envelope / Runtime Event / Asset Stream / Transfer
```

Agent Application 不能直接持有本地 Driver。它只能消费 Bound Port；Placement Resolver 根据 Requirement、Offer、Node Lease、Trust、Input Seat、数据驻留和资源 Authority 选择 Provider。

### 7.3 单 Server 内单对象单 Authority

每个持久或有副作用的 Kernel Object 在当前 Server 运行时内只有一个 Authority Node。其他 Client/Capability Node 可以缓存 Snapshot，但写入必须回到该 Server Authority。Authority 负责 Generation、Revision、Sequence、Handle Revocation Epoch 与 Durable Fact。

多 Server 之间不建立实时 Replica、自动 Command Route 或隐式多主。用户主动执行“从此服务器上同步最新数据”时，所选 Server 的完整用户数据快照是唯一来源，并整体覆写当前 Server；同步完成后各 Server 继续独立运行，后续数据不会自动互相追平。

禁止：

- 多 Node 直接写同一 SQLite/TriviumDB；
- 多 Server 自动同步、对象级选择同步或按时间戳合并完整用户数据；
- 把共享文件路径当作分布式资源协议；
- 让 Electron/Steam/便携版 Renderer 切换到远程 Server；
- Provider 断线后继续使用旧 Lease/Handle。

### 7.4 Node-scoped Capability

Provider Offer 必须携带 Node 与 Placement：

```text
Capability Definition
→ Node-scoped Offer
→ Placement Resolver
→ Policy Binding
→ Node-bound Handle
→ Bound Port
→ Kernel Envelope(sourceNodeId → targetNodeId)
→ Node Transport
→ Provider
```

有效权限继续是交集，并加入 Node 约束：

```text
Consumer Handle
∩ Provider Offer
∩ Node Trust / Lease
∩ Placement Requirement
∩ Resource Authority
∩ Policy / Approval
∩ Deadline / Generation / Revocation Epoch
```

### 7.5 客户端与 Input Seat

Client Facet 代表用户界面，不天然拥有服务端权限。文件选择器、桌面截图、窗口、剪贴板、通知、摄像头、麦克风、扬声器与 Pet3DView 等能力必须由 Client/Device Provider 发布。

`InputSeat` 表示当前可接收用户输入和审批的客户端会话。需要用户在场的操作必须绑定 Input Seat Lease；无活动 Seat 时返回等待状态，不能任意选择另一个在线客户端。

### 7.6 Gateway 与 Node Plane

GatewayHub 只负责 WebSocket Carrier、连接心跳与消息收发，不承担 Node Identity、Trust、Facet、Authority、Placement 或 Capability Binding。正式 Node Plane 由以下对象组成：

```text
NodeRegistry
NodeSessionRegistry
NodeCapabilityDirectory
ResourceAuthorityDirectory
PlacementResolver
NodeRouter
NodeTransport
```

Gateway WebSocket、Electron IPC、HTTP、MCP 或未来 QUIC 都只是 NodeTransport Adapter。

### 7.7 Capability Node 接入规则

独立 Capability Node 不依赖 Server 主动连接其 IP。Server 在“分布式”Tab生成包含 Endpoint、Server ID、证书指纹和一次性 Pairing Code 的邀请；Capability Node 使用邀请主动建立出站 WSS，完成证书和 Trust 校验后发布 Offer。该方式通常不要求能力节点拥有公网入站地址或配置 NAT 端口映射。

首版一个 Capability Node 只绑定一个 Home Server。它的 Session、Offer Lease、Invocation、Cancellation、Receipt 和 Asset Transfer 都由 Home Server 管理；其他 Server 不实时发现或跨 Server 调用该节点。用户若要在另一 Server 使用同类能力，应将能力节点重新配对到目标 Server，或部署另一个能力节点。

### 7.8 Browser Capability 的正式边界

Browser 不建模为独立 Application，首期由 Electron Client 按需发布为 `web.page` Capability，供 Agent 通过 `browser_*` Tool ABI 调用。页面 Scene、Action Receipt、Form Plan 和 Site Model 均由 Tool 编排层维护，统一归入现有能力模型而不另设 Browser Application Identity 或应用商店生命周期。

```text
Principal Agent
→ browser_* Tool ABI
→ web.page Capability Handle
→ Electron Browser Provider
→ 隔离 BrowserWindow / WebContents
→ Electron 内置 Chromium
```

Electron Browser Provider 拥有隔离的 Browser Session、Profile、Cookie、Download 和页面对象 Authority，与 infOS 主 Renderer 及用户日常 Chrome 保持隔离；需要可见交互或审批时按需展示同一隔离 `WebContents`，后台任务静默隐藏运行。

非 Electron Client 默认不声明 `web.page`，对应 Browser Tools 由 `CapabilityGate` 隐藏或返回 `CAPABILITY_UNAVAILABLE`。缺少本地能力时不回退至服务器 Chromium，避免改变 URL、Cookie、下载或登录数据驻留；后续若接入远程 Browser Provider，仍沿同一 `web.page` Offer 与 Tool ABI 接入。

生产装配已完成迁移：Backend Container 不安装 `infos.browser`、不发布 `server.browser.chromium`，也不启动 Chromium Driver 或持有 Browser Profile，仅保留 Browser Tool 定义、Electron 能力绑定与结果编排；旧 `ChromiumRuntime` 与 `BrowserApplication` 类作为未装配历史代码保留。

### 7.9 Application Integration 与主 Agent 边界

第三方 Application 采用三层 Adapter：infOS 通用 Integration Foundation、infOS 侧应用专属 Adapter、目标应用内部 Plugin/Extension/Sidecar。详细协议和 Arca 参考实现见 [A10_APPLICATION_INTEGRATION](./A10_APPLICATION_INTEGRATION.md)。

主 Agent 与 Application 主要通过 Tool Projection、Application Task 和 Application Session 通信。Application 接收长任务并返回 `taskId` 后，任务必须拥有独立 Principal、Kernel Execution、取消域和持久状态；主 Agent 的单次 ReAct、Thread 或 Execution 失败不得级联取消该任务。因果关系使用 `correlationId/causationId`，不能滥用 `parentExecutionId` 建立隐式生死绑定。

Application 使用 Persona、Knowledge、Workspace、Model 或 Asset 时必须通过 Capability Handle 和 Bound Port。禁止向社区 Adapter 注入 `AppContext`、Repository、数据库连接、裸路径、Credential 或 Kernel Service 实例。Persona 必须是版本化投影，不是包含系统协议和隐藏规则的最终 System Prompt。

进程内 Application Realm 仅用于官方受信任兼容实现。第三方 Application 默认运行在独立 Service Process、Node Host 或远程 Node；Backend 内存 Runtime Map 不得成为通用 Application 生命周期的权威载体。

### 7.10 入站路由替代全局活跃 Agent

外部消息仍由 `InboundRoute` 决定 Principal/Thread 归属；Node Placement 只决定执行位置，不能替代 Principal 路由：

```text
(source, identifier) → { agentId, channel, threadId?, config? }
```

桌面聊天由 Thread 的 `agentId` 决定，后台任务由 SchedulerTask 的 `agentId` 决定，外部消息由 InboundRoute 的 `agentId` 决定。Node、Principal、Thread 和 Input Seat 是四个独立维度。

---

## 8. Context Compiler 与 Region 收敛

ContextCompiler 负责主应用的模型上下文编译，社交应用通过自己的编译器提供当前平台会话资料。角色身份和长记忆通过对应资源接入，聊天历史、心流和执行过程按所属 Thread 或场景提供。

```text
Identity / Rules / State / Capability / Memory / Flow
Thread Message Authority
Current Scene Context
        ↓
ContextRegionProvider
        ↓
Context Region Registry
        ↓
Trust / Priority / Required / Budget / Deduplication
        ↓
ContextCompiler
        ↓
MDP Slot Render + Native Conversation Messages
        ↓
LLM Messages + Context Manifest
```

### 8.1 ContextRegion

Region 是一次编译使用的只读材料，不是新的持久领域真源：

```text
regionId
kind
sourceObjectRefs
trust
priority
required
tokenEstimate
contentHash
content
provenance
validUntil
deduplicationKey
```

Region Provider 只能读取其领域 Authority 并返回 Region；不能修改 Thread、Memory、Agent State 或 Prompt 模板。ContextCompiler 负责统一选择、预算和渲染。

`delivery` 在选择后决定正文出口：内置 `manifest-only` 只用于清单与计费，内置 Thread 的 `conversation` 由历史/当前输入独立装配，工具 `infos.context.tools` 保留既有投递。插件只放行 `delivery=conversation` 且 `providerId` 以 `package:` 开头的区块，作为 `role=user`、`trust=external` 的本轮资料；不能简单放开全部 conversation 或改成 system。选择阶段继续排除空、过期、重复和超预算区块；工作模式的详细上下文沿用最终统一请求窗口计费，不在 Region 阶段提前拒绝。

插件动态资料在原有系统提示词和完整历史之后投递：

| 框架 | 选中插件正文的位置 |
| --- | --- |
| 原生 managed assembly | 注入 user `turn_context` 的 `<package_context>`；只复用处于历史之后、当前输入之前且保留结束标签的槽位，否则在当前输入前补独立的 user `<turn_context>` |
| SillyTavern | 在框架标记的当前输入前插入 user 快照，位于旧历史之后；保留深度 0 尾注等后续布局 |
| 无 managed assembly | 先独立追加原生历史，再在当前输入前插入 user 快照；无当前输入时追加到尾部 |

`ContextCompiler` 在 Selector 选中后处理已渲染消息，不重新执行模板或酒馆宏；插入后更新 `currentMessageIndex`，工作历史展开后再按消息对象重新定位。插件正文变化仅作用于本轮动态尾部，原有 `system` 与旧历史字节保持不变，也不在历史前插入新 `user` 消息，因此不会打断 `preparePromptReplay` 的历史连续性与热轨迹续接。热轨迹保留先前实际发送的旧快照并在本轮追加新快照（实际厂商侧前缀缓存命中率仍取决于具体模型供应商规则）。

源码入口：`packages/backend/src/services/context/contextCompiler.ts` 的 `packageMessages`、`packages/backend/src/services/context/contextRegionRuntime.ts`、`packages/backend/src/packages/packageExtensionActivators.ts`。

以上描述规范轨迹的装配顺序。全局「动态填充深度」可在最终模型请求副本中将本轮资料前移到上一条用户输入之前，历史校验继续消费连续的规范轨迹；配置、缓存代价和作用范围统一见 [动态填充深度](./B17_PROMPT_WORKSPACE.md#33-动态填充深度)。

### 8.2 Region 信任与预算

信任级别至少区分：

```text
system       内核规则与受信模板
principal    用户/Agent 显式身份资源
authority    Server 权威领域数据
derived      摘要、检索、投影等派生数据
external     外部平台或不可信来源
```

选择顺序不是简单字符串拼接：

```text
required Region 必须保留，否则编译失败
→按 priority、trust 和稳定 regionId 排序
→按 deduplicationKey/contentHash 去重
→在 tokenBudget 内选择 optional Region
→ Manifest 记录 selected/dropped/truncated 与原因
```

本阶段只允许 Region 整体选择，不对任意文本静默截断；后续可由 Provider 提供多分辨率 Region 或显式压缩版本。

### 8.3 场景历史与长期连续性

主线和侧线读取各自 Thread 的消息与心流。据点适配器提供角色在场时的房间记录，社交应用提供当前平台账号与会话的历史。复用角色身份和执行基础时，编译器仍在数据读取层维护这些作用域，模板变量与原生消息使用相同边界。

跨场景长期认识通过角色记忆的沉淀、修订和检索形成。记忆保留来源、时间与角色归属，进入当前输入时按场景资料范围和预算选择。原始来源供追溯查询，显式委派通过独立任务请求及交付回执传递选定资料。

`internalScene` 与 `realmExecution` 会隔离宿主 Thread 的聊天历史和心流。旧 `enableContinuity` 等字段保留解析兼容，内置运行时采用场景自身的资料和记忆检索。

### 8.4 Context Manifest

Manifest 必须证明本轮使用了哪些 Region：

```text
providerId
regionId
kind
selected
tokenEstimate
trust
priority
sourceObjectRefs
contentHash
reason
```

Manifest 用于审计、调试和可解释 Surface，不包含 Credential 明文或未脱敏秘密。

### 8.5 与 Memory、Summary、Observer 的关系

```text
Thread Message Domain Event
├─ Memory Pipeline → Memory Region
├─ Observer Service → Agent State Region
└─ Surface Projection
```

这些消费者分别读取领域权威资料。记忆加工维护有来源的长期认识，Observer 提供派生观察，Surface 提供展示投影。当前场景的编译器负责选择实际进入模型输入的材料。

---

## 9. 资产联邦与多发行数据边界

资产联邦的覆盖优先级固定为：

```text
官方 @app  <  Workshop @workshop  <  用户本地 @data
```

官方与 Workshop 资源为只读。模型需要动态生成 manifest 时，通过内存中的受限虚拟协议提供，不回写安装或订阅目录。后端与 Electron 各自扫描所属资源类型，统一遵循该覆盖顺序与 `PathResolver` containment 规则。

跨发行版共享同一数据语义：Agent 数据、Workspace、SQLite、TriviumDB、用户安装的 Skills/Extensions 和自定义资源统一位于 `@data`。安装资源与 Workshop 订阅内容作为可重新获取的只读分发资产，不作为用户存档或云同步来源。

---

## 10. API 与流式契约

### 10.1 后端权威 API

客户端创建或选择 Thread 后，只提交当前输入：

```text
POST /api/chat
{ threadId, content, attachmentIds? }
```

后端从 Thread 读取 Agent、channel、策略与历史，编译上下文并持久化消息。客户端不得上传完整历史数组来参与上下文组装。

REST 保持统一响应信封；API DTO 与 SSE discriminated union 放在 `@infos/shared`，防止前后端字段漂移。Shared只保存两个及以上Package共同遵守的稳定边界契约，不保存具体Application Manifest、单一前端功能实现、产品策略常量或Backend Service/Repository。具体Application必须在自身Package定义Manifest并通过公开入口导出。

### 10.2 SSE 事件

聊天 SSE 以 `surface` 帧传递正文、思考、状态和工具等呈现内容，另有 `rag_progress`、`error` 和 `done` 事件。内部工具调用与结果通过 `callId` 关联，再由 `ConversationSurfaceSession` 投影。流成功结束会显式发送 `done`；前端应将缺少 `done` 的断流视为截断。事件定义和实现入口见 [API 响应规范](./S02_API_SPEC.md#8-流式--sse-响应)。

---

## 11. 迁移策略与演进经验

### 11.1 演进原则

AIOS 演进采用小步、可验证与可回滚策略：每次收敛单一边界，迁移前先保留备份，接口兼容层设置明确的退出条件；每步迁移完成后独立可运行、通过类型检查并补充对应领域测试。

| 演进主题          | 核心结果                           | 验证重点                     |
| ----------------- | ---------------------------------- | ---------------------------- |
| Session → Thread  | 后端权威 Thread 与消息事实流       | 客户端不再提交完整历史       |
| Context 编译      | 历史仅作为原生消息注入一次         | 无 XML 历史重复              |
| 前端适配          | 窗口级 UI 状态与 Thread 视图订阅   | 刷新后持久资源不丢失         |
| Workspace         | Agent 私有根和 containment         | 非授权路径拒绝读写           |
| Memory            | Candidate、Gate、Provenance        | 不同 Thread 不混批提炼       |
| Capability        | `(agentId, channel)` + fail-closed | 社交/群聊不暴露高风险工具    |
| Daemon / Provider | Node 后端与 Electron 能力解耦      | 无桌面 Provider 时可解释降级 |

历史 `conversation_logs` 迁移到 `thread_messages` 时按 `(sessionId, agentId, source)` 建 Thread，生成 `pairId`、默认 `active` 状态与初始 `revision`，并保留原表/备份供审计；权威会话状态全部迁移至 Thread 模型（旧全局指针 `session.{agentId}.current` 已退出权威链路）。

### 11.2 能力桥接的关键契约

能力提供者链路持续遵循以下设计准则：

1. 所有启动入口统一装配同一 `CapabilityBridge`；
2. 工具名与能力名通过显式映射关联（如 `take_screenshot → screen_capture`），不依赖同名约定；
3. Provider 返回值在边界处标准化，截图等多模态能力返回可供 ReAct/LLM 消费的结构化负载；
4. 权限校验先于 Provider 路由执行，确保所有平台工具统一经过 `CapabilityGate`；
5. Provider 协议（注册、心跳、调用、结果与错误格式）集中定义在 `@infos/shared`，供主端与扩展共用；
6. Provider WebSocket/IPC 连接在生产环境强制鉴权，主动断连与心跳超时统一收敛为 `offline` 状态。

### 11.3 API 兼容期

兼容接口内部转发到 Thread API 并附带退出计划：旧 Session 创建/清空/查询接口收敛至 `/api/threads`，旧全量 `messages` 载荷收敛至 `{ threadId, content }`，避免恢复前端历史组装逻辑。

---

## 12. 统一 Application 与内部 Agent

### 12.1 Application 不分类

通用 Application 只有一种自治形态。Arca、Research、Minecraft Companion、Coding Workspace 等都使用相同的 Application Identity、Host、Capability 和 Federation 模型。以下差异属于内部实现策略：

```text
有 UI / 无 UI
前台 / 后台
常驻 / 按需启动
Kernel 托管启动 / 用户或外部系统启动
单进程 / 多进程
使用 LLM / 不使用 LLM
包含内部 Agent / 纯确定性逻辑
```

`Package` 是安装与分发单位，`Tool` 是 Agent-facing 薄 ABI，`Capability` 是版本化能力契约，`Client` 是可选交互面，各自承担正交职责。

### 12.2 Application Realm 与 Kernel 的唯一耦合面

唯一 Kernel 为自治子应用签发隔离的 `Application Realm`。Realm 是受控 Kernel 视图而非第二套 Kernel 实例，持有 `appId / realmId / principalId / LifecycleScope`，并统一通过 Realm 内的 Port、Capability Handle、Scoped Tool、Context Provider、Event 与 Task Binding 使用 Kernel 机制。

```text
Application Realm
├─ 发布 Capability Offer
├─ 声明 Capability Requirement
├─ 通过 Handle 调用 Bound Port
├─ 发布 Event / Receipt / Checkpoint
└─ 可选连接独立 Client
```

Application Realm 与 Kernel 数据库、内部 Service、主应用 Thread Channel 以及原始 Credential 保持隔离。申请 `model.inference`、`search.web`、`web.page`、`document.semantic` 等能力依赖通过标准声明建立绑定。Stronghold 作为主应用核心模块直接遵循主应用内部 Service、`group` Thread 与 `CapabilityGate` 边界，不纳入 Application Realm。

### 12.3 内部 Agent / Worker

Application 内部可包含零个、一个或多个 Agent/Worker，属内部实现而不形成新的应用分类。内部 Agent 自主维护历史与工作状态，经由 Application Host 的受限 Capability Binding 执行任务，与主 Agent Thread、主 Agent Canonical Memory 和人格 Authority 隔离；主应用与 Application 间的可调用关系由 Endpoint、Capability Offer 与显式 Tool Projection 声明。

Application 与主应用的双向关系固定分为：Application 通过 `offeredCapabilities + endpoints` 声明对外 Operation，并通过可选 `toolProjections` 将允许主 Agent 调用的 Operation 投影为 Tool；Application 通过 `requestedCapabilities` 向 Kernel 请求模型、人格、知识、工作区、审批或主 Agent 协作。Tool Projection 随在线 Offer 注册和注销，Realm 私有工具隔离于主 Thread 工具管理之外。

```text
Principal Agent
→ Task / Capability Grant
→ Application Host
→ 内部 Agent / Worker（可选）
→ Application Checkpoint / Result / Receipt
```

内部 Agent 的记忆候选若需回流，经由 Application Checkpoint 与主 Agent MemoryGate 核验；Application 领域状态归属自身 Store/Authority。Social 虽沿用部分历史领域结构，跨 Package 依赖已收口至 `@infos/shared` Port 与公开 Application Host ABI，不再作为新应用的目录模板。

### 12.4 开发者参考实现

Arca 为标准自治 Application 模板。新应用沿用其独立 Host、稳定 Identity、可选独立 Client、NodeProvider、Capability Offer/Requirement、独立 Store/Authority 与断线重连边界。现有 `AppManager/AgentAppRuntime` 已演进为 Application Realm 生命周期宿主，负责进程内 Realm 的 Scoped Tool、Task Binding 与生命周期；外部 Host 通过 Node Federation 接入同一 Realm 协议。Arca 任务与 Social 私有会话已迁入 Realm，`arca` / `social` 退出主应用 Thread Channel 与 Agent 静态能力矩阵；Stronghold 固定归属主应用模块而不接入 Realm Manager。

Social 已通过 Shared 中的 Storage/Execution/Event Port、自身 Data Service 与公开 Application Host ABI 完成边界收口，不再深路径导入 Backend 源码或直接持有 DrizzleDb、GatewayHub 与 Backend Repository 实现；新增宿主协作能力优先进入 Shared Port 或领域 Facade。

---

## 13. Kernel Object、Execution 与系统事件

### 13.1 架构基线

1. Agent 是长期 Principal 与资源所有者，具体运行归属唯一 `executionId`。
2. 可观察副作用追溯至 Principal、Process、Execution、Capability 与因果链。
3. Resource 为实体资源，Capability 为访问权，Tool 为面向模型的操作 ABI（资源授权独立于工具名白名单）。
4. Capability 支持委派、收窄、到期和撤销，Skill、fallback 与默认值不隐式扩权。
5. 持久事实使用 Durable Event；Token、动画、进度和心跳等临时体验使用 Ephemeral Frame。
6. Application 仅持有 Port 与 Capability Handle，不直接访问数据库、Backend Service 实例、Service Locator 或全局 `AppContext`。
7. Renderer 与 Surface 作为无状态投影层，窗口关闭或 DOM 重建不改变领域权威状态。
8. Context Compiler 对 Identity、Memory、Thread、Workspace 与 Capability 保持只读映射。
9. Observer 仅生成观测度量，是否进入上下文由策略层决定。
10. 跨边界调用具备可取消、可超时、可审计与对象 Generation 校验语义，崩溃后持久日志保持合法前缀。
11. Kernel 提供 Object、Execution、Capability、IPC、Lifecycle、Scheduler 与 Audit 基础设施，业务策略收敛在领域与用户空间。
12. Stronghold 固定属于主应用，`group` 为其专属 Channel；Application 身份由 `appId/realmId` 表达。

### 13.2 OS 领域本体

| AIOS 对象       | OS 类比               | 固定语义                              |
| --------------- | --------------------- | ------------------------------------- |
| PrincipalAgent  | Security Principal    | 长期身份、人格、私有资源与授权主体    |
| Thread          | TTY / Journal         | 持久交互边界与消息事实流，不执行代码  |
| Task            | Job                   | 用户期望完成的工作，可跨多次执行      |
| Process         | Process               | Task、Application 或驻留服务的运行载体 |
| Execution       | Execution attempt     | 一次有起止、预算、结果和因果链的运行  |
| Tool Call       | System call           | 对 Kernel Service 或 Adapter 的结构化请求 |
| Context Runtime | Virtual address space | 本轮模型可见资源的临时映射            |
| Workspace       | Filesystem namespace  | Principal 或 Application 的可写文件空间  |
| Surface         | Display object        | 领域事实的可重建视觉投影              |

`Task = 要完成什么`，`Process = 谁承载运行`，`Execution = 某次尝试`，`Turn = 一次用户可感知事务`，`Thread = 持久交流与事实记录`；执行主体由显式 Execution 上下文携带，不依据 Thread 或前端当前活跃 Agent 推导。

### 13.3 Kernel Object

可寻址、可授权、可订阅或受生命周期管理的实体必须可投影为Kernel Object：

```typescript
interface KernelObjectRef {
  objectType: string
  objectId: string
  generation: number
  ownerPrincipalId: string
}
```

领域表继续持有权威数据，Object Registry只提供投影，不建立万能对象大表。对象可按领域选择支持`inspect`、`subscribe`、`snapshot`、`grant`、`revoke`、`suspend`、`resume`与`close`。`generation`用于拒绝页面导航、Application重启、Surface替换、Document Revision、Provider重连或Checkpoint恢复后的过期句柄。

### 13.4 Execution模型

```typescript
interface ExecutionDescriptor {
  executionId: string
  processId: string
  principalId: string
  taskId?: string
  parentExecutionId?: string
  threadId?: string
  class: 'interactive' | 'foreground' | 'background' | 'resident' | 'maintenance' | 'realtime'
  priority: number
  deadline?: string
  budget: {
    maxDurationMs?: number
    maxLlmCalls?: number
    maxInputTokens?: number
    maxOutputTokens?: number
    maxToolCalls?: number
    maxConcurrentIo?: number
  }
}
```

状态机固定为`created → queued → running → waiting_io | waiting_approval | suspended → running → completed | failed | cancelled | timed_out`，终态必须携带结构化ExitStatus。聊天Turn、后台任务、Application命令和主动行为均使用同一Execution身份与预算语义。后台任务使用所属 PrincipalAgent 执行，不创建独立开发子 Agent，也不递归派发通用后台任务；应用交办遵循对应应用的适配层协议。

### 13.5 Capability Handle与Tool ABI

Capability Handle必须绑定主体、Kernel Object、允许操作、资源范围、父句柄、有效期与撤销属性。子句柄必须满足操作集、资源范围、有效期和风险均不超过父句柄。ToolExecutor作为系统调用分发器，按以下链路执行：

```text
解析对象与操作
→ 校验Capability Handle
→ Policy / Approval
→ 路由Service或Adapter
→ Deadline / Cancellation
→ 结构化结果
→ Durable Audit Event
```

### 13.6 Durable Event、Ephemeral Frame与Kernel Envelope

Durable Event用于消息提交、工具接受/拒绝、审批请求与完成、Agent求助请求与完成、文件修改、Task迁移、Application生命周期、Checkpoint与文档提交等事实；Ephemeral Frame用于Token、Thinking、进度、短时Toast、音频播放帧、动画和心跳。Frame可合并、降频或丢弃，Event必须可恢复和审计。重要通知应先成为Durable Notification事实，再按目标Client/Input Seat投影为Toast；TTS应物化为Audio Asset并由目标Audio Output Capability播放，不得向所有Gateway连接无差别广播音频。

REST、SSE、WebSocket、Electron IPC、MCP与内存EventBus可以保持不同Carrier，但必须共享协议版本、Message/Correlation/Causation、Principal/Process/Execution、Object Generation、Operation、Capability、Deadline、Durability与结构化Payload语义。

### 13.7 Context Runtime映射

Context是由Identity、Memory、Thread、Capability、Skill、Workspace、Flow State、Environment和Current Input等Region组成的临时地址空间。Region必须记录来源对象、可见性、优先级、Token估算、新鲜度、必需性与物化方法。RAG相当于按需缺页处理，Token Budget相当于地址空间配额；Context Manifest必须能解释每段内容的来源、版本、预算与裁剪原因。

### 13.8 主 Agent 的近期工具上下文

主 Agent 的 `desktop` 对话把当前工作区焦点和近期工具结果纳入标准上下文生命周期。工作区焦点仅属于本轮请求，必须校验 Agent、真实 Thread、文件版本和终端 ExecutionSession；未保存选区只有用户显式附加才进入模型。近期读取结果按 Thread、Agent、Pair 在进程内保留原始返回文本；来源、范围、版本、读取参数随原有助手消息元数据保存。Context Compiler 直接从当前活跃消息窗口收集对应工具 Region，由统一预算按新近顺序决定正文或来源降级，并写入 Context Manifest。文件变化、不可核验、退出窗口、回滚和内存回收都会释放正文；进程重启后仍可根据对话中的来源重读。

私有心流只保留目标与事实；旧 `workContext` 正文列和逐轮表由 `0001_remove_work_context` 迁移删除，旧工具摘录表由 `0003_remove_tool_observations` 删除。ReAct 每次模型请求前计算输入预算；达到容量边界时按来源降级较早的可重读结果，最近一次读取保留原文，不另调模型生成工作续接摘要。工具正文不写入审计转写和初始提示词持久化快照，也不进入长期记忆；后台任务与 Realm 维持各自执行上下文，不继承日常工具缓存。

---

## 14. 架构决策门槛与演进检查表

新增Kernel级抽象前必须回答：资源与权威状态是什么、生命周期和终态是什么、Principal/Process/Execution如何归属、需要什么Capability、哪些是Durable Event、如何取消超时与幂等、如何检测旧Generation、崩溃后如何恢复、性能与UX如何测量、是否应留在用户空间、替代的旧胶水及移除条件是什么。

新增或修改架构相关功能时，应验证：

- [ ] Agent、Thread、Memory、Workspace、Capability 的状态所有权明确；
- [ ] 后端没有引入全局活跃 Agent/Thread 依赖；
- [ ] Context Compiler 对资源保持只读，历史不会重复注入；
- [ ] 主应用Channel只包含`desktop/group`，应用身份只由`appId/realmId`表达；
- [ ] Stronghold保持主应用模块且`group`专属，不注册Application Realm；
- [ ] 任何文件路径经过 containment 检查；
- [ ] 任何平台工具也经过 CapabilityGate；
- [ ] Thread 与消息 API/SSE 契约同步更新 shared 类型；
- [ ] 官方/Workshop 只读资源不被运行时写入；
- [ ] 新存档或同步规则覆盖 SQLite 与 TriviumDB 多文件一致性；
- [ ] Application 使用 Arca 式自治边界，不新增平行应用分类；内部 Agent 不绕过 Checkpoint、Workspace 或 MemoryGate 隔离。

---

## 15. 相关规范

- [项目结构](./A01_PROJECT_STRUCTURE.md)
- [后端架构](./A02_BACKEND_ARCHITECTURE.md)
- [前端架构](./A03_FRONTEND_ARCHITECTURE.md)
- [部署与多发行](./A04_DEPLOYMENT.md)
- [记忆引擎](./A05_MEMORY_ENGINE.md)
- [扩展系统](./A06_EXTENSION_SYSTEM.md)
- [跨平台与路径](./A07_CROSS_PLATFORM.md)
- [模式与角色管理](./M01_MODE_SYSTEM.md)
- [能力门控](./M02_CAPABILITY_GATE.md)
- [API 响应与流式规范](./S02_API_SPEC.md)
- [Steam 与资产联邦](./M04_STEAM_INTEGRATION.md)
