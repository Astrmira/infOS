# NIT 编排引擎

> **适用范围**：`packages/backend/src/nit/`、`packages/backend/src/tools/runScript/` 及模型/工具循环保护

---

## 1. 定位与调用链路

NIT（Natural Instruction Threading）脚本以标准 Function Calling 工具 **`run_script`** 接入模型调用链，词法、语法与 AST 解释器均由仓库内 TypeScript 实现（`nit/lexer.ts`、`nit/parser.ts`、`nit/runtime.ts`），不占用额外系统提示词协议：

```text
LLM Function Call: run_script(code="...")
  → ToolRegistry / CapabilityGate 校验与 cwd 绑定
  → NitLexer / NitParser 解析 AST
  → NitRuntime 沙箱执行（子工具调用经闭包递归走 CapabilityGate 与 ToolExecutor）
```

---

## 2. 语法子集与执行预算

- **语法能力**：变量赋值、属性访问（`obj.field`）、字符串拼接、`if-else`、`for-in`、`try-catch`、`return` 以及 `parallel { ... }` 并发块。
- **沙箱限制**：不支持自定义函数定义、递归或直接网络/文件 IO；脚本必须通过注入的受权工具执行器间接调用已开放工具。
- **安全与超时上限**：
  - `NitRuntime` 单次执行上限：`MAX_ITERATIONS = 1000` 次迭代、`MAX_TOOL_CALLS = 50` 次工具调用（并发调用在启动时即计入配额）。
  - `run_script` 超时控制：纯脚本自身计算预算 `SCRIPT_TIMEOUT_MS = 30_000` ms（不含内部工具与审批等待），单次脚本最长墙钟耗时上限 `MAX_SCRIPT_WALL_TIME_MS = 10 * 60_000` ms，取消后清理等待上限 `5_000` ms。

---

## 3. 观察预算与跨轮上下文

- **工具结果分离**：内部子工具保留脚本编排所需的完整业务返回值，文件 diff 等仅用于界面展示的数据单独走展示通道；内部调用与直接调用共用观察回调，保留真实路径、版本与读取来源。
- **128K 观察裁剪**：脚本最终返回值（显式 `return` 或末条表达式）及普通工具观察共用 `MODEL_TOOL_OUTPUT_CHARACTERS = 128_000` 字符预算（`services/execution/toolObservation.ts`）；超限输出生成 30 分钟有效的短期读取引用供后续分段读取，避免重复触发有副作用的工具。

---

## 4. 退化生成与工具循环保护

为防止模型陷入无意义死循环同时避免误伤正常长任务，系统在模型输出流与工具调用层设置两级独立保护：

### 4.1 退化生成检测（`services/llm/outputLoopGuard.ts`）

- 统一按 `512` 字符块分通道检测正文、原生思考、工具名称和每个工具参数流（滑动窗口 `262_144` 字符，最大周期 `4096` 字符），仅匹配连续、逐字重复且含字母文字的周期（忽略纯空白、分隔线、数字及参数内 Base64 编码）。
- **触发阈值**：工具名称 `4096` 字符；普通正文与思考 `8192` 字符且重复 `16` 个周期；代码块与结构化排版 `32_768` 字符且重复 `32` 个周期；工具参数 `65_536` 字符且重复 `64` 个周期。
- **处理动作**：检出后抛出 `GenerationLoopError`（`retryable: false`），立即中止当前上游请求、丢弃未完成工具参数并保留已接收进度，不触发重试或回退模型。

### 4.2 工具调用循环保护（`services/agent/toolLoopGuard.ts`）

- 每次 ReAct 执行独立持有 `ToolLoopGuard`，直接工具调用与 NIT 子工具共享同一计数窗口（支持长度为 1–4 的动作周期）。
- **触发阈值**：相同参数与相同失败结果连续循环 `6` 次，或稳定只读工具（`read_file`、`list_directory`、`search_files` 等，剥离临时 `read_ref` 后比较）连续返回相同结果 `12` 次时，先拦截一次并提示模型纠偏；若继续原样重复则抛出 `ToolLoopError` 中止本次执行。
- **动态排除**：`wait`、`poll`、`terminal_read`、`screenshot`、`browser`、`social_act` 等动态观察操作不计入相同结果循环；目标参数变化或成功执行修改类操作后会重置对应只读循环窗口。纯计算 NIT 脚本按脚本内容比较，含子工具的脚本按实际子工具序列比较。
