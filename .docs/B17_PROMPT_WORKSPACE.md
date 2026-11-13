# 提示词管理

> **适用范围**：`packages/backend/src/services/prompt/`、SillyTavern 预设兼容、历史时间标记、工作模式轨迹复用与提示词编排（入口：主应用「设置 → 提示词」）

人设仍在角色管理中编辑；提示词框架负责编排消息序列与变量注入。

---

## 1. 框架类型与基本使用

1. **框架类型**：「新建框架」支持「infOS 原生格式」「SillyTavern 格式」「自定义框架」：
   - **infOS 原生格式**：复制可编辑的默认编排。
   - **自定义框架**：从完整正文或空白自由编排开始，不复制内置槽位、人设、规则或能力装配（可关闭「保留对话历史」或改用原生 user/assistant 历史）。
   - **SillyTavern 格式**：使用独立宏解析器与历史插入规则，通过「全部对话 / 指定范围 / 稍后指派」或编辑区「指派此框架」设置生效范围。
2. **数据装配与区块**：「数据装配」按顺序生成变量，「区块」按顺序生成消息，均支持拖拽或箭头排序。
3. **模板引擎隔离**：原生格式、自定义框架、槽位、组件与任务正文使用 Nunjucks（显式调用 `{{ component("模板ID") }}`）；插入的历史、记忆、工具结果不再递归执行模板语法。SillyTavern 正文仅走酒馆宏解析器。
4. **指派优先级**：「指派」页选择生效框架与模板替换，优先级依次为 **全局 → 频道 → 角色 → 角色频道**；框架自身携带的模板替换作为基础，更具体的范围指派继续覆盖它。
5. **预览与 Token 估算**：预览读取当前角色人设和用户称呼，历史、记忆等动态材料使用可编辑的示例 JSON；Token 数为模板文本的 `o200k_base` 计数（不含多模态图片成本与 Provider 工具 Schema 开销）。
6. **发布生效时机**：保存仅更新草稿；发布通过格式、引用、循环依赖与消息角色顺序校验后生效（存在悬空引用或未支持启用宏时阻止发布）。整轮主对话 / 社交 ReAct 复用启动时快照，新发布从下一轮开始生效。
7. **内置框架与恢复**：内置框架包含「infOS 默认」「社交默认」与「我的预设」，现有工作区读取时自动补全缺失内置框架而保留用户定制；内置模板可编辑、停用或清空区块，复制的资源可删除；表达层组件（思考模式、手册）位于 `components/expression/`；工具栏「内置预设」可将草稿还原至默认模板，发布后生效。

---

## 2. SelfMind 引导与自定义框架入口

### 2.1 SelfMind 引导

- 「组件 → SelfMind 引导」对应 `components/expression/selfminding`，定义发言前引导正文与 `<selfMinding>` 输出约定；内置「输出约定」通过 `component()` 引用它，「infOS 默认」与「我的预设」沿用该格式。编辑保存并发布后，下次执行读取最新快照；组件内可使用 `agent_name`、`owner_appellation` 等变量，也可直接停用。
- 默认情况下，引用它的框架共享同一引导组件；若按角色或频道定制，可在「组件」复制副本并在「指派 → 模板替换」将 `components/expression/selfminding` 映射至副本。自定义框架同样可显式引用 `{{ component("components/expression/selfminding") }}`。
- 历史版本升级时，原样内置输出约定通过正文指纹自动转为组件引用，用户已修改或已替换的配置按显式引用保留（修改过输出约定的用户也可手动替换为该 `component()` 调用），历史发布原件留在版本库中。

### 2.2 整套自定义框架与命名

- **「完整正文」**：直接编写系统提示词（变量与模板语法可选），创建后可继续拆分、排序区块。
- **「自由编排」**：从空白消息序列开始，新增系统消息默认插在对话历史之前；**「保留对话历史」** 控制是否注入原生 user/assistant 历史。
- **指派方式**：「全部对话」把全局及已有角色、频道（含社交）切换至新框架，同时保留原模板替换与任务提示词；「指定范围」绑定特定角色/频道（更具体指派继续优先）；「稍后指派」仅保存草稿。
- **目录名称规范**：内置组件目录统一使用中文名称（自动纠正旧配置与本地草稿中和文件名一致的默认名称，保留用户自定义名与原文），英文模板 ID 作为稳定引用标识不变。

---

## 3. 历史对话时间、轨迹窗口与动态填充深度

### 3.1 历史对话时间标记

- 上下文编译器基于已有 `thread_messages.timestamp` 派生时间标记，不新增数据库字段也不改写数据库正文。
- 每个会话按用户消息追加顺序计算：首条带有效时间的消息作为起点，此后距上次标记满 `1` 小时的首条用户消息追加一行标记（长期空白间隔不补空行，恢复对话时刻成为新起点）。原生历史与 `conversation_history` 模板变量统一输出 `【对话记录时间：YYYY-MM-DD HH:mm】`。
- 已入库的当前用户输入使用同一套用户时间索引计算标记（命中规则则在发出时带同一行标记，转为历史后正文一致以保持前缀与热轨迹缓存身份），附件重建多模态正文时保留该行；应用通信、主动回合等不入库临时输入不加标记（当前时间由状态注入提供）。窗口滑动时依据从会话起点至读取边界的完整时间索引投影，避免重排既定标记；无效或缺失时间跳过，旧本地时间保留原值，来源自带时区偏移时保留偏移，标记格式不随界面语言翻译。

### 3.2 工作模式窗口与轨迹复用

- **主线与侧线读取**：主线通过 `ThreadService.getConversationHistory` 按独立消息与 `historyTokenBudget` 读取历史并在预算内恢复 `conversation_executions` 完整工具过程（详见 [主侧会话](./B26_MAIN_SIDE_THREADS.md)）。侧会话冷启动通过 `ThreadService.getWorkingMessagePairs` 按预算每页 8 个完整对话对（含失败与中断记录）向前分页；存在已提交热轨迹时，`ContextCompiler` 从 `promptReplayHistoryStart(channel:agentId:threadId)` 读取起点并沿游标加载后续对话对。
- **来源校验与滑窗**：`preparePromptReplay` 按持久来源核对保留窗口顺序、内容身份、已送达回复、模型、工具、审批与系统前缀，并通过消息上的 `cacheControl.replayAnchor` 追踪工具结果、回复与动态快照的输入来源（即便输入滑出窗口，仍校验保留结果的来源）。`reactLoop` 派发前计算含工具定义的完整输入预算，超限时按闭合工具组前移至约 `80%` 目标预算（保护当前框架槽位、淘汰旧动态快照），成功运行提交投影后才更新读取起点；历史编辑、撤回、Skills 变动或模型/权限变化触发热轨迹失效并回退权威编译。
- **进程内生命周期**：起点与热轨迹缓存有效期 `30` 分钟，最多 `64` 项、合计 `32 MiB`（单项超过 `16 MiB` 跳过保存），重启、过期或淘汰后重新按预算分页（实际发生滑窗仍会改变前缀，供应商缓存命中以接口用量为准）。源码入口：`services/llm/promptCache.ts`、`services/context/contextCompiler.ts`、`services/context/promptWindow.ts`、`services/thread/threadService.ts`。

### 3.3 动态填充深度

- 全局配置 `system.dynamicContextDepth`（设置中心「系统设定」或「提示词 → 回复策略」维护）存 `'0'`（默认「贴近本轮输入」）或 `'1'`（「前移到上轮输入」），后者将 `turn_context` 与附带插件资料移至上一条真实用户输入之前；完整工具组、当前附件与运行中执行状态保留原位置，若缺乏上轮用户输入或已滑出窗口则退回默认位置。
- `PromptWorkspace.prepare` 将配置写入 `CompiledPromptPlan.dynamicContextDepth`，主上下文编译器与社交编译器通过 `bindDynamicContext` 绑定上一轮用户来源，最终 `requestCompiler.compileModelRequest` 在请求副本中重排带 `cacheControl.dynamicContextBefore` 的资料（保留规范消息历史并附加时间语义说明，同一轮重试、工具续轮与检查点沿用同份策略，变更深度在下一轮生效）。前移会随上一轮输入附近变化带来新前缀，请按需权衡提示词缓存收益；显式引用 `components/state/turn_context` 的区块由动态资料标记识别，酒馆预设 `in_chat` 深度沿用各自规则。源码入口：`packages/shared/src/contentMode.ts`、`services/prompt/requestCompiler.ts`、`services/context/contextCompiler.ts`、`packages/apps/social/runtime/compiler.ts`。

---

## 4. 任务模板、版本恢复与 API

### 4.1 已接入任务

- 已接入任务共 8 项：**事件补记、记忆反思、每日札记、图片转述、知识整理、自动审批、社交记忆、据点管家叙述**。
- 前 6 项通过稳定任务标识匹配 `tasks/runtime/*` 模板，社交记忆与管家继续使用原 MDP 模板键并走同一发布解析器；模型的选择、工具权限、输出校验与错误处理由各自领域服务持有（新增任务模板仅作为已有任务的覆盖正文，不自动创建新调度器；后台记忆固定 `task` 频道，自动审批沿用被审批操作原频道；未被运行时消费的历史 MD 归入组件管理）。

### 4.2 版本、存储损坏恢复与 HTTP API

- **持久存储与版本**：工作区保存于 `configs` 表的 `prompt.workspace.v1`（不改写仓库内置模板文件），发布保留最近 `30` 个完整版本并支持对比与回滚到草稿；JSON 导出覆盖完整工作区，导入校验通过后替换草稿。酒馆预设 JSON 为增量新增框架（先审阅兼容报告与排序方案再选择指派范围，单个框架也可导出为酒馆预设；缺 `format` 的旧配置内置归原生、其余归自定义）。
- **酒馆附加面板**：酒馆框架额外提供「辅助提示词」「角色覆盖」「持久变量」面板——前两项随草稿发布与工作区导出，持久变量为独立运行时状态。
- **并发与损坏保护**：保存使用修订号串行写入（冲突拒绝旧覆盖）；未保存修改暂存当前设备本地草稿（源码未闭合时亦保留文本）。存储损坏时自动备份原始内容并在管理页显示恢复错误，明确阻断依赖提示词的运行请求（不静默替换内置正文），重新发布有效配置即可恢复。

| 接口 | 说明 |
| --- | --- |
| `GET /api/prompts` | 读取草稿、默认目录、版本摘要与变量 |
| `PUT /api/prompts/draft` | `{revision, bundle}` 保存草稿 |
| `POST /api/prompts/validate` | 校验配置格式与引用 |
| `POST /api/prompts/preview` | 基于示例渲染预览（不触发 RAG 或模型请求） |
| `POST /api/prompts/publish` | 发布当前已保存草稿 |
| `GET /api/prompts/versions/:id` | 读取指定发布版本完整内容 |
| `POST /api/prompts/restore` | 将历史版本恢复至草稿 |
| `POST /api/prompts/import/sillytavern` | `{preset, name?, profile?}` 解析预设并返回审阅结果 |
| `POST /api/prompts/export/sillytavern` | `{bundle, frameworkId}` 导出草稿中的酒馆框架 |
| `GET /api/prompts/variables?scope=...` | 查看全局（`$global`）或会话持久变量与作用域目录 |
| `POST /api/prompts/variables/reset` | `{scope?}` 清空指定作用域或全部酒馆变量 |

---

## 5. 酒馆预设兼容契约

入口：「设置 → 提示词 → 新建框架 → SillyTavern 格式」或顶部「导入」审阅 JSON 预设（导入仅进草稿不自动发布）。

| 格式 | 起点 | 正文处理 |
| --- | --- | --- |
| infOS 原生格式 | 可编辑的内置槽位与数据装配 | Nunjucks |
| SillyTavern 格式 | 酒馆 JSON 预设或新建编排 | 独立酒馆宏解析器 |
| 自定义框架 | 完整正文或空白自由编排 | Nunjucks，不强制引用内置模板 |

### 5.1 支持范围与宏语义

- **预设与条目结构**：兼容 Chat Completion 预设 `prompts`、`prompt_order`（默认优先选用 `character_id = 100001`，可在导入审阅选择其他方案）、启停、角色、位置、深度、顺序及触发类型；旧版 `main_prompt`、`nsfw_prompt`、`jailbreak_prompt` 转换为可编辑条目。支持新聊天、新群聊、示例分隔、群聊点名、续写、代写、空消息替代、性格与场景格式等辅助字段导入编辑与回写。原预设未知字段、采样与连接参数作为源数据在导出时回写，不改写 infOS 模型设置或凭据。
- **角色与示例消息**：描述、性格、场景、用户设定、示例对话与世界信息字段支持映射运行时变量、角色资料、手填或留空（世界信息不自动映射 infOS 记忆检索）。示例对话解析 `<START>` 与说话人行并拆为独立 user/assistant 消息（仅替换名字占位而不执行资料中的任意宏；无法识别说话人时保留原文并提示）。角色覆盖支持主提示词、历史后指令、`original` 展开（每条最多一次）与 `forbid_overrides`。
- **宏、条件与变量**：支持常见名字与消息宏、嵌套参数、注释、空白控制、大小写反转、`random/pick/roll`（`pick` 在同一编译种子下稳定）、`if / else / /if`、块级 `setvar`、`#` 保留空白，以及 `.name / $name` 简写和 `= / ++ / -- / += / -= / || / ?? / ||= / ??= / == / != / > / >= / < / <=`（未命中分支与未采用默认值不写入变量）。`datetimeformat` 支持 `YYYY / MM / DD / HH / mm / ss`（暂不支持自定义时区与其他格式，预览报错）；运行时提供当前窗口消息序号（而非库内绝对序号）。替换产出的历史、资料与变量值不再递归执行宏。
- **校验限制**：不导入 Text Completion 模板；未知触发类型保存在草稿但停用条目提示警告且启用时阻止发布；重复标识、缺失排序引用与损坏格式直接拒绝导入。

### 5.2 深度排序、角色转换与持久变量

- **深度计算与合并**：按最旧到最新原生 user/assistant 消息（含当前用户消息）计深度：深度 `0` 位于最新消息之后、深度 `1` 位于最新消息之前、超出历史长度则插在开头；同深度按顺序升序并依 `assistant → user → system` 分组，同序同角色以换行合并。当前用户消息保留独立锚点以挂载附件与工作区上下文（关闭聊天历史开关仍保留本次用户消息，临时输入同样参与深度计算而不重复追加）。
- **历史内部 system 消息转换**：由于通用 Provider 兼容层仅保证开头的 `system`，历史开始后出现的 `system` 条目留在原位置并转为带 `【系统指令】` 标记的 `user` 消息（预览同时标示原角色与转换警告，导出保持 `system` 角色）。
- **变量持久契约**：回合开始读取变量快照，宏执行时只在内存累积变更，主对话或社交生成正常结束后经 SQLite 同一配置行原子提交（携带本轮所读版本校验以防并发覆盖，LLM 失败/取消不提交且不影响已执行工具与回复；主应用检查点携带待提交变更与去重 ID）。聊天变量按角色与会话隔离，全局变量在本机共享；会话分支时局部变量复制至新会话作用域随事务提交（详见 [会话分支](./B09_THREAD_INTERACTION_MODE.md#会话分支)）；主线重置通过 `resetThread` 推进 `scopeEpochs` 同事务清理局部变量并保持全局值，删除侧线另留墓碑。限额：单值 `200K` 字符、单轮每类最多 `1000` 个变量名、总存储 `4M` 字符 / `2000` 会话、提交去重保留最近 `512` ID。

### 5.3 兼容与上下文边界

- **世界书与运行时边界**：世界书激活结果统一置于当前输入之前，不经过酒馆「世界信息（前/后）」插槽；不支持酒馆扩展脚本与 STScript。单个 ReAct 周期内整个宏与装配状态保持稳定（不在每次工具调用后重算）；支持 `normal` / `regenerate` / `quiet` 等 `generationType`（预览可切换，产品层暂不复刻酒馆续写拼接与 swipe 交互）。
- **回答预填充（`system.assistantPrefill`）**：开关与正文（最多 `8000` 字符）支持 `once`（首次输出正式正文前每轮追加，纯工具轮次不消耗）与 `continuous`（每轮 ReAct 追加；社交链路独立请求，`once` 仅首轮生效）；旧配置按 `once` 迁移。执行开始时 `requestCompiler.resolveEffectivePromptPlan` 调用 `@infos/shared` 的 `resolveAssistantPrefillForChain` 按当前模型及回退链计算固定计划（生成 `assistantPrefill` 支持方式 `assistant_tail / deepseek_prefix` 或 `assistantPrefillSkipped` 跳过原因，由 `ModelRequestSnapshot.prefill / prefillSkipped` 持久化与热轨迹复用；任一链节点不支持或方式不一致时整体跳过并在首轮状态附带原因与 i18n 日志，不回退改写为 user/system 指令，也不在被接口拒绝后静默剥离重试）。预填充仅混入请求副本并仅在收到真实正文时拼回，工具空轮/失败/取消不写入正式消息（已生成真实片段以未完成进度保留）；缓冲在完成、失败或首次取消时确保释放。规则声明详见 [B22](./B22_PROVIDER_CONNECTIONS.md#回答预填充能力)。
- **动态资料与工具定义**：`turn_context`、状态与 RAG 位于当前用户输入侧（可受「动态填充深度」前移），固定规则位于系统区域；插件 `context-provider` 在 Region 选材后插入本轮动态 user 资料，具体边界见 [A09 §8.1](./A09_AIOS_ARCHITECTURE.md#81-contextregion)。工具定义与 Schema 键统一稳定排序，工具菜单未变时复用装配结果；后台任务模板独立管理，不跟随聊天预设转成酒馆宏。

### 5.4 实现与参考

- **实现源码**：`packages/shared/src/promptFormats.ts`、`types/promptWorkspace.types.ts`、`packages/backend/src/services/prompt/`（`promptWorkspace.ts`、`sillyTavernPreset.ts`、`sillyTavernMacros.ts`、`sillyTavernFramework.ts`、`requestCompiler.ts`）、前端 `packages/frontend/src/components/dashboard/tabs/PromptManagementTab.vue`、`SillyTavernFrameworkEditor.vue`；单测入口 `packages/backend/tests/unit/services/prompt/promptWorkspace.test.ts`。
- **上游参考**：[SillyTavern Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)、[SillyTavern 宏](https://docs.sillytavern.app/usage/core-concepts/macros/)、[Default.json](https://github.com/SillyTavern/SillyTavern/blob/release/default/content/presets/openai/Default.json)、[openai.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js)。

---

## 6. 编译链与维护契约

`promptWorkspace.ts` 管理草稿、发布与指派；主 `ContextCompiler` 或 `SocialAppCompiler` 读取各自隔离的数据域后交由 `MdpEngine` 装配生效框架快照，再由 `requestCompiler` 生成最终请求。排查问题时需区分示例 JSON 预览与真实运行时环境（缺失示例变量应报错提示，跨通道材料不可混用）：社交来源参见 [B21](./B21_SOCIAL_CAPABILITIES.md)，角色状态参见 [B10](./B10_CHARACTER_STATE.md)，知识/事实召回参见 [B03](./B03_DOCUMENT_KNOWLEDGE.md)。
