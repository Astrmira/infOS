# 生产力工具与执行运行时

> 职责：执行会话、文件与终端资源、策略审批及其客户端投影。
> 范围：Backend / Daemon 运行时及 Frontend 工作区、审批与终端。

本文描述当前运行契约。具体字段以执行域类型为准；能力准入与执行模式分别见 [M02](./M02_CAPABILITY_GATE.md) 和 [B19](./B19_THREAD_EXECUTION_MODES.md)。

## 1. 设计原则

1. **Channel 与 Sandbox 正交**：Channel 参与业务授权，Profile 声明执行策略；实际隔离语义以对应 Runner 实现为准（默认实现为软件策略检查，不包含 OS 内核强隔离）。
2. **所有副作用进入执行运行时**：终端、文件写入、编辑、删除和外部进程统一经由执行运行时分发，不直接在 Tool handler 中操作宿主资源。
3. **结构化结果**：工具错误以 `StructuredToolResult` 承载，统一包含成功状态、错误码、截断信息和元数据。
4. **可取消**：`AbortSignal` 贯穿 ReAct、ToolExecutor、受管进程和长时工具。
5. **句柄化长任务**：长时命令返回 Terminal ID，异步推进而不阻塞单次 ReAct 工具调用。
6. **安全写入**：编辑采用内容/哈希保护，写入采用同目录临时文件与原子替换。
7. **隔离边界明确**：`LocalPolicyRunner` 提供软件策略校验与受管进程生命周期；OS 内核级强隔离由独立 Runner 实现提供。

## 2. 总体架构

```text
Conversation / BackgroundTask → ReActLoop → RegistryToolExecutor
  → CapabilityGate + 最终参数策略 + ApprovalService
  → ProductivityRuntime（tools/productivityRuntimeHolder.ts）
      ├─ ExecutionSessionManager：所有权与生命周期
      ├─ WorkspaceService / VirtualWorkspace：文件与版本
      └─ TerminalManager → LocalPolicyRunner：PTY / pipe 进程
```

## 3. 领域模型

### 3.1 ExecutionSession

执行会话是副作用资源的归属单位。

```ts
interface ExecutionSession {
  id: string
  ownerAgentId: string
  threadId?: string
  taskId?: string
  channel: string
  workspaceRoot: string
  sandboxProfile: SandboxProfile
  state: 'active' | 'closing' | 'closed'
  createdAt: string
  lastActiveAt: string
}
```

生命周期规则：

- 普通对话默认按 Thread 复用执行会话。
- BackgroundTask 按 Task 创建执行会话。
- Task 完成、失败或取消时关闭其终端并释放临时资源。
- 执行会话只能被所属 Agent/Thread/Task 操作。

### 3.2 SandboxProfile

```ts
type SandboxProfileName = 'read-only' | 'workspace-write' | 'task-isolated' | 'full-access'

interface SandboxProfile {
  name: SandboxProfileName
  readableRoots: string[]
  writableRoots: string[]
  protectedPaths: string[]
  network: 'deny' | 'allow'
  inheritEnv: string[]
  maxProcesses: number
  maxRuntimeMs: number
  maxOutputBytes: number
}
```

`LocalPolicyRunner` 提供软件层的策略检查、环境清理、进程管理和路径边界；新增 Runner 须保持生命周期与取消契约。

## 4. 统一工具结果

```ts
interface StructuredToolResult {
  ok: boolean
  output: string
  error?: {
    code: string
    message: string
    retryable?: boolean
  }
  truncated?: boolean
  metadata?: Record<string, unknown>
}
```

兼容策略：

- ToolRegistry handler 兼容返回 `string | StructuredToolResult`。
- ToolExecutor 统一归一化为现有 `ToolExecutionResult`。
- `ok=false` 映射为 `isError=true`，参与 ReAct 熔断。
- 归一化发生在执行边界，调用方依据统一错误标志处理失败观察。

## 5. SandboxRunner

```ts
interface SandboxRunner {
  readonly kind: string
  createSession(session: ExecutionSession): Promise<void>
  spawn(session: ExecutionSession, spec: ProcessSpec): Promise<SandboxProcess>
  spawnTerminal(session: ExecutionSession, spec: ProcessSpec): Promise<ManagedTerminalProcess>
  terminateProcess(processId: string, force?: boolean): Promise<void>
  disposeSession(sessionId: string): Promise<void>
}
```

`LocalPolicyRunner`：

- 使用 `spawn` 直接启动可执行文件，禁止字符串拼接调用搜索二进制。
- Shell 命令仅由终端工具显式启动。
- 环境变量采用白名单，不继承模型 Key、Daemon Token 等凭据。
- 支持 `AbortSignal`。
- 保存进程句柄，取消时终止进程。
- Windows 使用 `taskkill /T` 作为进程树清理降级方案；Unix 使用进程组信号。
- 输出使用环形缓冲，保留头尾与截断信息。

`LocalPolicyRunner` 聚焦软件策略与进程生命周期管理，不提供文件系统内核隔离、网络内核隔离或 CPU/内存硬额度。

## 6. TerminalManager

终端是执行会话内的多实例资源，而不是一次性函数。

### 6.1 终端工具

| 工具                 | 功能                               |
| -------------------- | ---------------------------------- |
| `terminal_create`    | 创建后台终端，立即返回 Terminal ID |
| `terminal_list`      | 列出当前执行会话的终端             |
| `terminal_get`       | 获取状态、命令、cwd、PID、退出码   |
| `terminal_read`      | 使用 cursor/limit 读取增量输出     |
| `terminal_wait`      | 等待退出、文本匹配或超时           |
| `terminal_write`     | 向 stdin 写入文本（pipe 模式）     |
| `terminal_interrupt` | 中断当前进程                       |
| `terminal_kill`      | 终止进程树                         |
| `terminal_close`     | 清理终端及缓冲                     |

TerminalManager 支持 `node-pty`（Windows ConPTY / Unix PTY），不可用时降级到 `child_process.spawn` 的 pipe 后端。pipe 不具备完整 TTY/TUI 能力；`terminal_resize` 只在支持尺寸的后端生效。终端状态包含 backend、cols、rows，客户端据此展示实际能力。

### 6.2 输出缓冲

- 每终端保存有界字符缓冲。
- `terminal_read` 返回 `cursor`、`nextCursor`、`hasMore`、`status`。
- 增量读取避免将完整长日志直接注入 ReAct 上下文。
- 终端退出时保留 `exitCode`、`signal` 和尾部输出。

### 6.3 远程能力节点终端

GPU/Linux 能力节点发布 `system.shell` Offer 后，主 Agent 可使用独立的 `remote_terminal_*` 工具包。该工具包与浏览器、Computer Use 一样属于二级高级工具抽屉：默认不向模型发送具体工具定义，Agent 确认任务需要远程节点操作后先调用 `expand_advanced_tools`，下一轮才获得完整远程终端工具。工具契约与本机多终端保持一致，每次调用须显式提供 `node_id`，Terminal ID 仅在对应节点内有效。

远程终端不使用本机终端的风险分级审批策略，而统一服从当前 Thread 的 Char Ops 自动执行开关：

- 自动执行关闭：所有 `remote_terminal_*` 调用逐次强制审批，包括只读、等待、中断和关闭；
- 自动执行开启：所有 `remote_terminal_*` 调用直接执行，不创建审批；
- CapabilityGate、节点配对、在线 Lease、Handle、Tool 禁用状态与调用审计在两种模式下均强制生效。

节点侧维持真实长时 Shell Session，Server 只保存 Node ID、远程 Terminal ID 和调用回执；节点断线后不自动重放可能产生副作用的命令。

## 7. VirtualWorkspace

### 7.1 文件读取

`read_file` 默认读取前 800 行；`read_file_range` 支持：

- `offset` / `limit`
- `line_start` / `line_end`
- `tail_lines`
- 文本/二进制识别
- 返回 encoding、EOL、总字节数、hash、截断状态
- 返回绑定调用者、真实文件、版本与实际范围的 `read_ref`；可直接用于下一次 `edit_file`。
- `outline=true` 按需读取 JS/TS 精确符号大纲或 Python 声明位置；`symbol` 和可选 `symbol_pick` 选择目标。JS/TS 可靠解析时返回精确符号和版本化引用；Python 使用 TS 进程内的轻量词法/缩进扫描，不依赖解释器或新增解析库，只提供声明位置，选中后自动读取附近源码，不推断完整函数体的替换范围。
- 不支持的语言、语法不完整、解析器不可用、复杂 Python 格式字符串、混合缩进、符号未找到或源码超出 128,000 字符解析预算时，自动返回最多 16,000 字符的普通源码窗口、`symbolFallback` 原因、版本化 `read_ref` 与可用的 `nextOffset`。取消和文件权限错误仍按原语义传播；歧义仍需明确选择。回退读取引用只覆盖实际可见源码，编辑时继续核验所有权和文件版本。
- `path=tool-result:ID` 配合 offset/limit 分页读取超限结果，校验 Agent、Thread、任务及 Realm 归属。内存热缓存有有效期；写盘成功的内部原件可跨重启读取，写盘失败则仅保留短期缓存。隐私删除和所属会话/角色清理会撤销原件，失效后按原始来源重读。

文本写入确保 UTF-8 编码与 BOM 保留（其他非 UTF-8 编码不保证无损往返）。

### 7.2 搜索

- `glob_files`：使用 Node 递归枚举与简化 Glob 匹配，支持范围以工具参数及 `VirtualWorkspace` 实现为准。
- `code_search`：优先使用随应用打包或 `PATH` 中的 `rg`，通过 `spawn(binary, args, { shell:false })` 调用；缺少 `rg` 时降级为 Node 流式逐行检索。
- 统一支持全局 `limit`、`include`/`exclude`、固定字符串/正则、大小写和上下文行。

### 7.3 安全编辑

`edit_file`：

- 单步定位互斥：`read_ref + new_text`、`path + old_text + new_text`，或携带 `expected_hash` 的行范围/`after_line` 操作；删除传空 `new_text`。
- `old_text` 多处匹配时不写入，返回候选与 `ticketId`；通过 `ticket_id + pick` 选择时复用原内容并重新核验版本。
- `steps` 支持同文件批量编辑，所有定位基于编辑前快照；存在重叠或任一步失败时整批不写。
- 写入、编辑和工作区保存共用进程内同文件队列；提交前核验版本，保持 BOM 与 CRLF，使用同目录临时文件原子 `rename`（同文件队列仅序列化进程内写入，外部程序并发修改由文件版本号核验发现）。
- 模型获取状态、版本与修改统计，完整 diff 交由前端界面呈现；若编辑后检查点失败，响应中明确提示文件已写入，避免重复操作。

### 7.4 工具观察与长任务文件状态

- 直接工具与 NIT 内部调用共用真实观察入口，内部读取来源随对话保存；脚本计算值不受模型观察切片影响。
- 默认模型工具观察预算为 128,000 字符，另受实际输入容量约束。超限结果保持合法外壳，提供片段、规模与可用的结果引用，不在 JSON 中间截断。
- 文件事实随工具记录和 assistant 元数据保存。冷编译、热轨迹和 Task 检查点使用同一按版本投影，保留最近操作，退出被替代的大参数和过期读取；原始审计与界面 diff 不丢失。
- 原生签名续接、未完成调用和失败调用保守保留。需要持续比较旧版本时可设置 retain_context；仍受总容量限制。
- 聊天、工作模式均随 assistant 消息保存当前轮 `workContext`；只记录本轮模型输出、工具协议与观察，不复制前序提示词。工作模式按消息身份详细重放，聊天模式继续使用精简历史。
- 工作历史按模型输入预算分页读取，包含失败和中断回合。编辑与来源 revision 校验使旧轨迹失效；切换模型不迁移不兼容的原生推理。Realm 与任务作用域单独核验。
- 每个 ReAct 请求按 Provider 实际序列化估算输入，预留模型输出额度；容量超限自动滑出最旧的完整工具组并留出增长余量，不调用摘要模型，不以累计历史超限主动结束任务。
- 上游明确返回输入容量拒绝且尚未产生本轮输出时，自动收紧窗口并重新请求，最多三次，不占用新的 ReAct 工具轮次，也不重放前序工具；其他 400 参数错误不进入该恢复路径。
- 滑出材料和超大结果使用内部 `runtime/tool-results` 原件，通过已有 `read_file_range` 分段读取；引用按 Agent、Thread、任务及 Realm 隔离，正常退出和重启不删除原件。隐私遗忘撤销详细副本，Thread/角色删除及重置清理对应持久原件。
- 文件未变且观察仍在窗口内时无需全量重读；文件版本变化时注明过期，缺少细节才按范围补读。运行中的终端由现有所有权状态自动投影，不新增工程管理工具或工作区交接文件。

`edit_file` 仅采用精确匹配（不做自动 `fuzzy apply`）；定位不唯一或版本变化时，调用者须重新读取并明确选择。

## 8. Execution、Thread Purpose 与策略映射

Productivity Runtime 不新增持久 Channel：主应用继续使用 `desktop | group`，后台任务通过 `ThreadPurpose = background_task`、Execution Class 与显式 Workspace Mount 表达隔离：

| 执行上下文                     | 默认 Profile                           |
| ------------------------------ | -------------------------------------- |
| desktop conversation           | workspace-write                        |
| background_task Execution      | task-isolated                          |
| ambient 请求作用域             | read-only；在所属 Channel 权限上做减法 |
| infos.social Application Realm | Social 专用 Port；无 Terminal          |
| Stronghold group               | read-only；无 Terminal                 |

后台任务创建 `background_task` Purpose 的 Thread（Channel 仍为 `desktop`），任务 Workspace 路径如下：

```text
@data/principals/{agentId}/tasks/{taskId}/workspace
```

任务操作真实项目目录时须显式添加挂载根，不以进程 `cwd` 作为隐式授权。

## 9. 权限与审批

Productivity Runtime 复用统一的 `ApprovalService` 与 Policy/Approval/Receipt 前端闭环协议：

```ts
type ApprovalDecision =
  | 'allow_once'
  | 'allow_session'
  | 'allow_always'
  | 'deny_once'
  | 'deny_always'
```

审批与执行边界：

- 操作是否直接执行由当前执行模式、Profile 与审批策略共同决定（而非仅依风险等级放行）。
- 超出能力或路径授权的操作直接按权限拒绝；需要审批的调用进入统一审批链（审批通过不扩大原有资源授权范围）。
- `full-access` 仅允许显式配置。

## 10. ReAct 与长任务

普通对话和 BackgroundTask 继续复用同一 ReActLoop。

短命令：

```text
terminal_execute → 等待退出 → 返回结果
```

长命令：

```text
terminal_create → 立即返回 terminalId
terminal_wait/read → 后续 ReAct 观察
terminal_kill/close → 生命周期管理
```

禁止让无限运行的服务器占住单次 Tool Call。

## 11. 审批持久化与交互

PolicyEngine 的纯 TypeScript 命令规则提供风险与审批信号。ToolExecutor 在 Hook 修改后的最终参数上执行检查，确保审批与实际执行面对同一参数快照。审批策略与参数策略来自 `capabilities.yaml`；自动审批的判断范围见 [B19](./B19_THREAD_EXECUTION_MODES.md)。

`ApprovalService` 持久保存 `pending / approved / denied / expired / consumed`，一次性授权仅消费一次。审计追加记录 `requested`、`resolved`、`consumed`、`expired`、`session_cleared`；永久允许/拒绝按最后一次决策恢复。接口 `/api/approvals` 管理请求与决策，`/api/approvals/audit` 按审批或会话查询链路，Gateway 推送 `tool_approval_requested`。

等待审批时原调用暂停；允许后原地续行，拒绝或过期形成失败观察。附言随 `resolutionMessage` 保存，拒绝附言通过 `APPROVAL_DENIED.userMessage` 回传。参数摘要递归脱敏，覆盖数组、嵌套凭据、`Authorization` 和 `Cookie`。

前端 `useApprovalStore` 为跨 Tab 单例。`ApprovalCard` 在对话流、工作区与任务详情中展示同一审批，并以真实 `pending` 状态更新角标（关闭局部展示组件不改变后端审批状态）。

## 12. 工作区与上下文

工作、聊天模式的桌面对话每轮编译时通过 `WorkspaceDirectoryContextProvider` 读取当前角色工作区的直属目录项，以必选 Context Region 提供 `@principal/` 根目录名称清单。该入口同时覆盖 MainThread 与 SideThread，随新建、重命名和删除刷新。目录名称附加 `/`，文件及链接保留名称，排序为目录优先、名称升序。文件正文、子目录条目和链接目标沿文件工具按需访问。

概览使用 `readdir` 的目录项类型，快照指纹只取名称清单及固定说明，正文或文件时间变化沿用同一指纹。根目录尚未创建时提供空清单，读取异常时提供暂不可用状态并记录本地化日志。主应用极简模式、后台任务、据点及子应用按各自上下文范围装配。

源码入口为 `packages/backend/src/services/workspace/workspaceDirectoryContext.ts`，由 Backend 容器注册到 `ContextRegionRegistry`，进入 `ContextCompiler` 的统一快照与预算装配。

工作区文件树、终端和 Copilot 共用当前 Agent 的真实 `desktop` Thread；后端核验 Agent、Thread 与 `ExecutionSession` 的所有权。切换 Agent/Thread 时清理终端引用与选区，同时保护编辑器未保存内容。

- 文件树按层懒加载。保存使用 SHA-256 乐观锁与原子写入；截断预览不直接覆盖写入完整文件。
- 路径检查使用 `realpath`，拒绝 symlink / Windows Junction 越过允许根（进程内队列协调内部并发，外部程序并发修改由版本号冲突拦截）。
- “本轮材料”表达下一次请求显式附加的文件、选区与终端。未保存正文不自动发送；选区及文件版本须核验，发送成功或切换 Thread 后清理临时引用。
- 近期工具正文按 Thread、Agent、Pair 在进程内缓存，来源、范围、版本和读取参数随助手消息保存。统一 Region 预算决定正文或来源降级，不另行做关键词召回或摘要。
- 正文缓存上限 32 MiB；材料退出窗口、版本变化、撤回、回收或进程重启后，按来源重新读取。读取工具的持久化审计仅保存来源元数据，上下文留存由当前 Region 预算窗口管理。
- `read_file`、`write_file`、`delete_file` 等旧入口同样经由 `ExecutionSession` / `VirtualWorkspace`，前端编辑器共用同一服务端写入权限通道。

## 13. 依赖与发行边界

`node-pty` 和 `ripgrep` 来自上游依赖。发行依赖收集器保留 `node-pty` 的 `.node`、ConPTY、OpenConsole 和 winpty 运行文件；`ripgrep` 按目标平台/架构提取到 `resources/bin`。搜索解析顺序为发行资源、开发依赖、PATH、Node fallback；单文件 Daemon 使用 `INFOS_RESOURCES_ROOT` 定位资源。

开发环境允许在缺少 PTY/rg 时降级，发行收集与 `afterPack` 完整性校验则要求对应原生资源完整随包携带。原生源码与编译链由上游维护，仓库负责 ABI 适配、收集与运行兼容。

当前未接入 Windows Restricted Token/Job Object、Linux bubblewrap、macOS Seatbelt、容器级强隔离或 LSP 语义服务；Profile 中的网络与资源字段目前作为契约配置与策略参数传递，而非由宿主内核强制限制。

## 14. 维护与排障入口

| 关注点 | 源码入口 |
| --- | --- |
| 会话所有权、Profile 与生命周期 | `packages/backend/src/services/execution/executionSession.ts` |
| 文件范围、版本、编辑及路径约束 | `packages/backend/src/services/execution/virtualWorkspace.ts` |
| 审批决策和持久化 | `packages/backend/src/services/execution/approvalService.ts`、`packages/backend/src/repositories/toolApproval.repo.ts` |
| 工作区 HTTP 与文件状态 | `packages/backend/src/services/workspace/workspaceService.ts` |
| 近期读取结果的上下文投影 | `packages/backend/src/services/context/toolContextService.ts` |
| 客户端文件、终端、审批 | `packages/frontend/src/components/main/tabs/WorkspaceTab.vue`、`packages/frontend/src/components/workspace/`、`packages/frontend/src/stores/useApprovalStore.ts` |
| 原生依赖发行 | `scripts/rebuild-daemon-deps.mjs`、`scripts/collect-daemon-deps.mjs` |

排查搜索空结果时先区分匹配条件、Git 忽略规则、实际搜索根和 rg/Node 后端；工具详情正文缺失还须检查历史保存与上下文降级。排查终端增量停滞时须核对绝对 `cursor` 与 `bufferStartOffset`，区分环形缓冲覆写截断与无新输出。

修改执行运行时应保护以下核心不变量：跨会话隔离句柄、取消传播至受管进程、审批拒绝阻断执行、版本冲突与多处匹配不写入、截断读取不整文件覆盖。已有行为用例位于 `packages/backend/tests/unit/services/execution/` 和 `packages/backend/tests/unit/services/workspace/`，具体运行结果以实际执行的 CI/测试记录为准。
