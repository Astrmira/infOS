# 会话执行模式

> **适用范围**：Thread 工具审批级别、高危操作边界与自动审批机制

---

## 1. 四种执行模式

聊天栏提供四种 Thread 执行模式，主对话与工作区协作栏共用状态；工具可见范围仍由交互模式（[B09](./B09_THREAD_INTERACTION_MODE.md)）和逐项工具开关控制：

| 模式 | 执行规则 |
| --- | --- |
| 手动审批 `manual` | 终端、脚本及其他高危操作逐次确认，其余工具按默认策略审批 |
| 自动执行 `auto` | 普通工具自动放行，所有终端、脚本及其他高危操作由用户逐次确认 |
| 自动审批 `auto_approve` | 远程终端的中断、结束与关闭交由审批模型判断，高危操作由用户确认 |
| 完整权限 `full` | 已开放的普通工具跳过常规审批、命令策略与工作区路径限制；高危操作仍由用户确认 |

`manage_task` 在聊天与工作模式下默认开放（可在会话工具开关中单独禁用），极简模式不开放。新建后台任务继承来源会话的执行模式与禁用工具（来源为聊天模式时升级为工作模式，极简模式保持极简）。后台任务直接完成当前目标，不再嵌套创建通用子任务；社交交办通过 `interact_with_social` 复用父任务校验与收口机制（见 [B21](./B21_SOCIAL_CAPABILITIES.md)）。

---

## 2. 高危操作边界

**高危操作在任何执行模式下（含 `full`）均须用户本人逐次确认，不进入自动审批模型，也不支持 `allow_session` 会话级放行。** 高危名单与桌面操作护栏（[P03](./P03_DESKTOP_SHELL.md)）共用 `packages/shared/src/safety-lists.draft.json`，由 `packages/shared/src/desktopSafety.ts` 的 `isHighRiskToolCall` 在 Hook 处理后的最终参数上判定：

- **终端与脚本执行**：`terminal_execute`、`terminal_create`、`terminal_write`、`remote_terminal_create`、`remote_terminal_write`、`run_script`，以及带代码参数的 `runtime_debug` 与运行时动态注册工具（编排脚本及其内部高危子调用分别审批）。
- **工作区外删除**：按解析符号链接和 Junction 后的真实路径判定。
- **系统敏感位置变更**：写入、修改或删除 `sensitivePaths` 覆盖的路径（hosts、开机启动项与计划任务、环境变量与 Shell 启动脚本、受信任证书、注册表与系统/程序目录，以及 `desktop-control.json`、`desktop-startup.json`、`desktop-safety*.json`、`desktop-home.json`、`desktop-bridge`、签名密钥等安全配置；判定时展开 `%变量%` 与 `~`，Windows 忽略大小写）。

单次批准严格绑定 `agent`、`session`、`thread`、`task`、工具名与完整参数摘要，执行前原子领取后即消费。显式配置的参数禁止策略在 `manual` / `auto` / `auto_approve` 下均生效，在 `full` 下跳过但仍保留上述高危底线。

---

## 3. 确定性只读终端查询

`terminal_execute` 与 `terminal_create` 在 Hook 后识别完全由封闭只读语法构成的指令：

- **支持语法**：Windows 支持 `Get-Location`、`Get-ChildItem`、`Get-Content`、`Select-String -SimpleMatch` 及常用别名，可组合固定字段的 `Select-Object`、`Sort-Object`、`Format-Table`；POSIX 支持 `pwd`、`ls`、`cat`、`head`、`tail` 及行数截取管道。
- **执行方式**：仅接受常量参数；确认后由宿主 `readOnlyTerminal.ts` 直接执行目录枚举与文件读取，不启动模型指定的 Shell 或外部解释器（目录和字段投影默认输出 JSON 行，`Format-Table` 输出制表符分列文本），并同样生成带 `terminalId` 的已结束终端记录。
- **范围与限制**：上限为 `4096` 个目录条目、单文件与总输出不超过 `2 MiB`，跳过符号链接与二进制文件；包含变量展开、重定向、脚本块或未收录命令（如 `git`、`rg`）时交回原终端审批流程。只读查询在所有模式下仍需用户确认。

---

## 4. 自动审批模型

自动审批当前用于远程终端的中断、结束与关闭判断（模型配置键 `model.task.approval`，未设置时跟随主模型）：

- **审查输入**：附带当前用户请求、近期上下文、最终工具参数、工作目录、相关脚本内容（最多 4 份，单份上限 `24 KB`）及交互终端近期输出；省略图片像素、思考过程与系统提示词。
- **决策与超时**：模型仅返回 `allow` 或 `deny` 及一句中文理由（通过固定为“范围受控”）；单次审查超时上限 60 秒，任一待审脚本未完整读取、脚本中途变化或服务异常时均按拒绝处理。
- **结果码**：
  - 正常拒绝返回 `AUTOMATIC_APPROVAL_DENIED`（`source: automatic_reviewer`），与用户手动拒绝 `APPROVAL_DENIED` 区分。
  - 异常拒绝返回 `AUTOMATIC_APPROVAL_ERROR`（附带 `errorCode`: `timeout` / `model_error` / `invalid_response` / `context_unavailable` / `context_changed`），工具返回 `isError=true`、`shouldTerminate=false`，供 Agent 调整方案继续执行。

---

## 5. 配置、迁移与源码入口

- **Thread 字段与接口**：数据库 `execution_mode` 替代旧 `auto_execute_tools`（`false/true` 对应 `manual/auto`）；`PUT /api/chat/threads/:id/execution-mode` 接受 `executionMode` 并兼容 `autoExecuteTools`。
- **新会话继承**：新建普通对话继承同角色最近活跃会话的模式，若原模式为 `auto_approve` 或 `full`，新会话回落为 `manual`（详见 [B09](./B09_THREAD_INTERACTION_MODE.md)）。
- **源码与测试入口**：
  - 权限与审批：`packages/backend/src/services/execution/approvalService.ts`、`automaticApprovalService.ts`、`policyEngine.ts`、`readOnlyTerminal.ts`
  - 高危判定：`packages/shared/src/desktopSafety.ts`、`packages/shared/src/safety-lists.draft.json`
  - 回归入口：`packages/backend/tests/unit/services/execution/automaticApproval.test.ts`、`policyApproval.test.ts`
