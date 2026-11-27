# 桌面自动化

> **适用范围**：Electron Windows 桌面观察、元素图、键鼠执行、持续盯窗口、耳朵识别、陪看、环境事件与直通通道

---

## 1. 执行边界与观察协议

Windows 桌面输入由 Electron `desktopControl` 统一串行化，复用 Capability 授权、聊天／工作模式与本机审批；模型思考期间不锁定用户桌面。内置浏览器继续走独立的页面工具。

`Input Seat` 用于确认客户端归属；桌面控制权版本用于拒绝用户接管前的旧观察与排队动作。控制服务仅在内存中保存观察，重启不会恢复基于旧坐标的动作。

### 1.1 `take_screenshot` 观察视角与绑定约束

`take_screenshot` 返回 `observationId`、目标窗口与截图坐标映射；可指定 `windowId`、`displayId`、`includeElements`（返回带编号的元素图）、`ocr`（识别画面文字）、`annotate`（在截图上叠加编号）及 `watch`（持续盯一个窗口并支持同时开启耳朵与陪看）。观察分三种视角（`observation.scope`）：

- **`window`（传 `windowId`）**：客户端先等待用户空闲，再经桥接 `focus` 将目标切到前台（最小化窗口先还原；被系统前台锁拦截时临时挂接前台线程输入队列重试，并在 `300ms` 内核对），随后按窗口区域截图；infOS 自身窗口（主进程 PID 相同）只查看不切换。切焦点失败或用户正忙时仍正常截图，但观察标为只供查看，附带 `observation.blockedCode`（`DESKTOP_FOCUS_DENIED` / `DESKTOP_USER_BUSY`）及 `notice` 操作建议。
- **`region`**：局部放大，沿用参考观察的目标窗口与可操作状态判定。
- **`screen`（未传 `windowId`）**：仅作整屏查看，不默认绑定前台窗口（避免在 infOS 内对话时误操作自身）；引用其发起键鼠操作返回 `DESKTOP_WINDOW_REQUIRED`。

观察结果另附 `observation.windowState`（`minimized`、`occluded`、`elevated`）：被遮挡时由 `notice` 提醒截图混入上层窗口；目标以更高权限运行时仅可查看（`DESKTOP_TARGET_ELEVATED`，Windows 会静默拦截非提权模拟输入）。元素图内的所有矩形框均采用截图坐标。

每次观察绑定调用方、窗口句柄与进程、窗口边界、显示器布局及控制权版本，有效期由「眼睛」偏好 `observationTtlSec` 控制（`60–1800` 秒，默认 `600` 秒）；用户操作鼠标或键盘使注入类引用立即失效，执行一次动作后旧观察同样失效。跨屏窗口可通过指定 `displayId` 分别观察所选显示器上的可见区域。

### 1.2 `automation_execute`、稳定等待与审批复核

- **目标定位与原生输入**：可按元素编号 `ref`（见下文「手」），或指定 UIA 控件 `elementId` 执行 `invoke`、`set_value`、`toggle`、`select`、`expand`、`collapse`、`scroll`；指定 `elementId` 而控件不支持该模式时返回 `DESKTOP_PATTERN_UNSUPPORTED`，由模型重新观察后显式选择坐标操作（仅按 `ref` 编号时由系统执行「元素优先、坐标退路」）。原生输入支持点击、双击、三击、中键、修饰键加点击、移动、拖拽、滚轮、Unicode 文本、快捷键（含标点、小键盘、媒体与音量键）及按住／释放（按住最多保留 `2` 秒；中止与异常仅释放执行器自身持有的键和鼠标）。
- **画面稳定等待与回读**：动作发出后立即释放输入控制并等待画面稳定：每 `150ms` 按观察区域采样一张灰度指纹（`desktopFrame.ts`，32 列网格平均亮度），连续两次平均差异 `≤ 0.4%` 即判定稳定（默认上限 `1500ms`，可通过 `settleTimeoutMs` 在 `200–5000ms` 调节），结果返回 `settle{stable, waitedMs, samples}`。回读截图沿用动作前视角（窗口仍截同窗口、局部仍截同块 DIP 区域；若动作关闭或最小化了目标窗口，改截整屏并附 `targetClosed: true`）。等待与回读期间用户移动鼠标仅在新观察标注为可能变化，不触发接管暂停。`wait` 可纯等待 `100–3000ms` 后重观察，带 `until` 时改为条件轮询。动作已发出后由 `verify` 提供核验结论，模型需结合画面、控件或实际产物确认业务目标完成。
- **审批后复核**：执行动作经本机分区护栏（`desktopGuard`）审批返回 `prompted` 且用户批准后，`desktopControl` 核对目标窗口进程与位置未变、将目标切回前台（审批框会短暂抢走焦点），并重新采样比对观察区域画面指纹（差异 `≤ 3%` 判定画面未变）。复核全部通过即直接执行并消费该次“允许这一次”；否则返回 `DESKTOP_APPROVED_REOBSERVE`。单次批准保留 `2` 分钟，且仅对完全相同的动作意图有效一次（用户点击审批按钮导致的控制权版本变化在这条路径上由画面比对替代）。

#### 本机程序审批

「桌面权限与安全 → 权限与保护规则」提供两个独立开关。「允许桌面操作」控制桌面能力的使用，「桌面操作护栏」控制按程序询问、附加名单、信任与任务预批。护栏首次使用默认关闭。启用后普通程序默认每个问一次，关闭已启用的护栏需要本人确认。内置禁区（含 infOS 自身窗口）、手动模式的逐次确认和 Home 的服务端许可各自生效。

`desktopGuardCore.ts` 从本机用户目录读取 `desktop-safety.json`、已接受副本和签名确认凭据。首次使用按护栏自己的文件判断。已签名的旧设置沿用原规则。配置损坏、签名不符或已初始化的副本残缺时，客户端保留可验证的禁令，逐次询问，并在设置页提供恢复入口。

`desktopGuardPrompt.ts` 串行打开独立沙箱窗口，操作详情取自主进程核实的窗口、控件和输入意图。专用 preload 只呈现文本并回传当前选项。主进程核对审批窗口、主帧和可选答案，关闭窗口按拒绝处理。配置在等待期间变化时需重新申请。

### 1.3 引导 Skill 与工具常驻策略

- **Skill 与流程约定**：`packages/backend/src/tools/screenVision/manifest.json` 的引导提示提及了 Skill `desktop-operation`（`get_active_windows` 找 `windowId` → `take_screenshot` 切前台并观察 → 元素编号或控件优先、坐标兜底 → `automation_execute` 操作 → 依据 `verify`、回读画面与 `settle` 核对，配合条件等待与直通通道 `desktop_direct`）。注意当前 `packages/backend/src/skills/desktop-operation/` 为空目录，尚未内置对应 `SKILL.md`。
- **常驻清单机制**：`take_screenshot` 常驻工具清单；`automation_execute`、`get_active_windows`、`activate_window` 属于高级工具包 `computerUse`（`packages/backend/src/tools/advancedTools.ts`）。当客户端打开「桌面操作」总开关时，`AgentService.prepareRuntimeContext` 在每次执行开始通过 `desktop.environment/control` 的 `status` 读取总开关状态（读不到视为关闭），并将上述三个工具作为 `DESKTOP_RESIDENT_TOOLS` 常驻清单（单次执行内保持不变，使提示词前缀缓存稳定，每轮增加约 2.8K 字符说明）。总开关关闭时三者保留在工具包内，需先调用 `expand_advanced_tools`；`get_mouse_position`、`desktop_direct`、`open_application`、`desktop_plan`、`desktop_safety` 始终留在包内。`automation_execute` 的 `ref`、`expect`、`until`、`modifiers` 参数简介保持精简。常驻不越过权限控制，展开禁用或未授权时依然裁剪，能力校验、审批与总开关拦截照常生效。

---

## 2. 截图分级退路、OCR 与元素图

### 2.1 三级截图与编码策略（`desktopWindowCapture.ts`）

1. **屏幕直接裁剪**：窗口未被遮挡时直接裁剪屏幕，速度最快且与用户所见一致。
2. **`PrintWindow` 与 WGC 回退**：窗口被遮挡时调用桥接 `capture` 走 `PrintWindow(PW_RENDERFULLCONTENT)`（裁到 DWM 可见边框）；抽样检测为全黑（UWP / WinUI / DirectComposition 常见）时切换为 `Windows.Graphics.Capture`（WGC，视觉助手内通过 `IGraphicsCaptureItemInterop` 按 HWND 建捕获项、自由线程帧池取帧并经 `SoftwareBitmap.CreateCopyFromSurfaceAsync` 取像素，仅用 .NET Framework `csc.exe` 编译）；两者均失败后退回屏幕裁剪。WGC 正常返回的暗色或纯黑画面保留。三级皆失败时按窗口状态返回第 0 步错误码（如 `DESKTOP_WINDOW_MINIMIZED`）并附前两级失败原因。
3. **返回元数据与编码**：`capture{method, fallbacks, format, bytes}` 记录实际采集方式；使用窗口自身画面时 `notice` 提醒“点击被挡住的位置会点到上层窗口”；局部放大、审批复核与动作回读均沿用同一种截图方式。PrintWindow 与 WGC 将原始 BGRA 写入系统临时目录 `infos-desktop`，由 `nativeImage.createFromBitmap` 读回后即删并统一设为不透明。编码阶段并行生成 JPEG 与 PNG 取体积较小者；JPEG 质量取「眼睛」偏好 `vision.imageQuality`（`50–95`，默认 `80`，局部放大不低于 `90`）。非 Windows 平台沿用 PNG 截图路径。

### 2.2 视觉助手、OCR 与 UIA 元素图

- **视觉助手**（`windowsVisionHelper.ts` / `windowsVisionSource.ts`）：因 OCR 与 WGC 需引用 WinRT 元数据，改由系统 `csc.exe` 编译并按源码哈希缓存至 `desktop-bridge/infos-vision-*.dll`。桥接先校验哈希并按字节加载反射调用；WinRT 调用运行于独立 MTA 线程（避免主执行 STA 线程死锁），支持取消与超时（超时不强杀原生线程）。前一个工作线程尚未退出时拒绝新视觉任务，退出后由主进程监测清理被放弃的像素文件。缺乏编译环境或元数据失败返回 `DESKTOP_VISION_UNAVAILABLE`，且 10 分钟内不重试。
- **OCR**（`desktopOcr.ts`）：使用原始清晰度画面识别（宽 `≤ 1600` 先放大 2 倍），未指定语言时读取 `vision.ocrLanguage`（空值跟随系统），物理像素框经 `physicalRectToScreenshot` 映射至截图坐标。OCR 不可用（`DESKTOP_OCR_NO_LANGUAGE`、`DESKTOP_VISION_UNAVAILABLE`、`DESKTOP_OCR_FAILED`）时在 `ocr{available: false, reason}` 降级，观察整体仍成功；仅取消信号向上抛出。
- **UIA 界面结构**（`windowsDesktopUiaSource.ts`）：`includeElements` 时通过 `CacheRequest` 广度遍历控件视图，同时登记可操作控件引用与当前值（跳过密码框），收集标签、状态栏、表格单元、列表项及文档正文（前 2000 字，最多 3 个文档）。单次遍历上限 `3000` 个节点、`150` 个控件、`300` 条文字、`4` 秒，超出标注 `truncated`。控件 ID 为进程内递增短编号（`e1`、`e2`…），跨观察不复用；Chromium/Electron 窗口首次读取先访问页面根节点唤醒无障碍树（最多等 `1` 秒）。
- **元素图融合与叠加**（`desktopElementMap.ts`、`desktopObserveLayers.ts`、`desktopAnnotate.ts`）：将 UIA 控件、UIA 文字与 OCR 文字按阅读顺序合并，从 `1` 开始编号；OCR 与 UIA 位置重叠（`IoU ≥ 0.5` 或互相包含）且文本一致的条目标为 `confirmed`，无名可操作控件用内部 OCR 补全名称，已被文档正文覆盖的 OCR 片段丢弃，其余 OCR 保留为只读 `OcrText`。当 UIA 结果过少（`< 5` 条或 `< 20` 字）时自动补做 OCR 并在 `notice` 说明。输出 `elementMap{format, lines, count, truncated?, notice?}`（每行格式 `编号 类型(*=可操作) "文字" [x,y,w,h] elementId 操作 = 当前值`，总长上限 `16000` 字符），替代大体积 `elements` JSON；`Observation.elementMap` 通过 `resolveElementRef(entries, n)` 反查目标、`elementId` 与中心点。`annotate: true` 时直接在 BGRA 位图上绘制带编号彩色框（可操作控件洋红、UIA 文字蓝、OCR 橙）。

---

## 3. 「手」：按编号操作、回读、等待与直通通道

键鼠动作在 `capabilityProvider` 进出 `desktopControl.execute` 前后分别经过 `desktopHands.ts` 处理；审批、禁区、高危名单、后端许可、用户接管与取消统一由 `desktopControl` 与护栏入口承载：

- **按元素编号**（`desktopHandsRef.ts` / `desktopObservationIndex.ts`）：`ref` 必须与同一次观察的 `observationId` 配对，由观察索引表（最多保留 32 份，按调用方隔离）查回条目。条目对应本次 UIA 控件且支持该操作时走控件执行（点击带 `invoke` 的控件改为 `invoke`），否则取框中心按坐标执行；`set_value / expand / collapse` 无控件时返回 `DESKTOP_PATTERN_UNSUPPORTED`，`type / hotkey` 不接受 `ref`。结果返回 `target{ref, role, text, method: uia|point}`，并将元素文字作为 `refText` 传入后端许可分类以识别「发送」「付款」等高危动作。
- **点击点与跨程序拖拽窗口校验**：按坐标点击、拖动（含起点和终点）或滚动前，先经桥接只读请求 `windowAt`（`WindowFromPoint` → `GetAncestor(GA_ROOT)`）检查点击点下方的顶层窗口；若进程与观察窗口不同则拒绝执行，返回 `DESKTOP_POINT_OTHER_WINDOW` 并附实际顶层 `windowId`（桥接在移动鼠标前再次核对；同进程弹出菜单与下拉框正常放行）。拖拽终点支持跨进程落在另一窗口：主进程写入终点窗口事实（`__hostFacts.drop`）与 `dropPid`，终点程序同步校验本机护栏（禁区含浏览器内 infOS 网页端均拒绝）及后端许可（`parameters.dropApp` 需声明并授权），审批弹窗明确提示“把 X 拖到 Y”及终点程序（拖入聊天、邮件或浏览器本身不直接归类为发送，拖入终端或系统设置按终点高危分类）。
- **每步回读与结论分级**（`desktopVerify.ts`）：控件操作前后桥接各读一次状态（值、勾选、展开、选中），`set_value` 额外读取完整值校验 `valueMatches`；`type` 操作前后比对焦点控件文本（统计目标串出现次数是否 `added`，不读密码框，焦点不在目标控件时如实报出）并记录在 `actionReceipt`。支持 `expect{text, gone, window}`：需核对文字时自动带元素图（元素图缺失或截断时不轻下结论），`window` 仅认动作后新出现的窗口；无控件与文本可核对时回退比较同视角前后画面指纹（平均差异 `< 0.05%` 提示画面几乎未变）。结论字段 `verify{status, checks, reason?, suggestion?}` 分为 `confirmed`、`failed`、`no_change`、`changed`、`unverified`（任何不确切依据均报 `unverified`，`message` 直接给出核对结论）。
- **条件等待**（`desktopWaitFor.ts`）：`wait` 带 `until{window|text|gone}` 时，`window` 按标题或进程名匹配无需预先观察；`text / gone` 依据观察确定窗口并调用桥接只读 `findText` 检索控件树（遍历名称、当前值与前 3 个文档的前 4000 字，不切前台、不登记控件引用；上限 `4000` 节点 / `2.5s`，桥接超时 `6s`）。默认每 `500ms` 检查一次、超时 `10s`（上限 `30s`），超时返回 `DESKTOP_WAIT_TIMEOUT` 并附现有窗口列表；轮询前经 `desktopControl.assertAvailable` 检查可用性，触发停控或取消时立即终止。
- **按键表扩展**（`windowsDesktopHandsSource.ts`）：补齐标点键（`; = , - . / \` [ ] \ '`）、`PLUS`、`Num0–Num9` 及小键盘运算键、`NumLock`、`CapsLock`、`ScrollLock`、`Pause`、`PrintScreen`、`Menu`、右侧修饰键及媒体／音量键并正确设置扩展键标志。鼠标支持 `button: middle` 与 `triple_click`，`modifiers`（`ctrl / alt / shift`，不收 Win）支持点击、滚动、拖动并在 `finally` 释放；后端工具层与客户端在发出前先行校验非法键值。
- **直通通道**（`desktop_direct`，`desktopDirect.ts`）：对应能力 `desktop.environment/desktopDirect`（`elevated`），支持 `clipboard_read`、`clipboard_write`、`media_key`、`open_url`。统一进入 `desktopActionGuard`，分区应用名分别映射为 `clipboard`、`media-keys` 与系统默认浏览器（`app.getApplicationInfoForProtocol('https://')`），批准后先 `consume` 再执行、执行后 `complete`。`media_key` 与 `open_url` 复用 `desktopControl.mutate`；`open_url` 仅限不含账号密码的 `http/https`；`clipboard_read` 上限 `20000` 字，遇到密码管理器常用的 `ExcludeClipboardContentFromMonitorProcessing` / `Clipboard Viewer Ignore` 标记时拒绝读取（`DESKTOP_CLIPBOARD_PROTECTED`）。启动应用继续走 `open_application`，文件访问走后端 `home_files`。

---

## 4. 持续盯窗口、耳朵与陪看模式

### 4.1 持续盯窗口（`desktopWatch.ts` / `desktopWatchService.ts`）

`take_screenshot` 的 `watch{action, fps, durationSec}` 运行在只读路径（不切前台、不进键鼠队列），思路参照 Watch Buddy 公开 README 自行实现：

- **本地比对与拼图**（`desktopWatchAtlas.ts`）：`start` 后按帧率截取目标窗口（被遮挡取窗口自身画面，最小化跳过），首次成功截图锁定 PID，后续若窗口关闭或句柄 PID 变更立即停止。每帧按比例缩放至长边 `≤ 480`（不放大），与上一帧用 `pixelmatch` 按 `12px` 网格比对（单格 `< 3` 变化像素忽略）。`poll` 将相邻变化网格合并外扩 1 格并按尺寸与像素去重（同内容位置记于 `alsoAt`），最多取 `12` 块按原清晰度拼为带编号拼图，附 `since/until/frames`、`frame` 信息及 `frame / physical / atlas` 三套坐标（`atlas` 坐标严格对齐编码后图片宽高）。首次拉取、尺寸变动或变化面积过半时直接发整帧（`kind: full`）；无净变化返回 `changed: false` 且不附带图片，中间波动后复原只报 `transientCells`。`status` 返回运行指标与内存占用，`stop` 结束并连带停止耳朵与陪看。
- **配额与自动停止**：帧率 `0.2–2 fps`（默认 `1`）、单次时长 `10s–1h`（默认 `30min`）、并发上限 `2` 个观察者（含仍在收尾的截屏请求）、全局每秒最多 `4` 次捕获、单帧输出长边上限 `1600`、原始窗口像素超过 `32 × 1024 × 1024` 拒绝捕获；内存中仅保留最新一帧原图与两张比对缩略图。出现窗口关闭或 PID 变更、连续 `10` 次截屏失败、到时、总开关关闭、桌面暂停、锁屏休眠、桥接断开或退出时自动停止（由 `desktopObservationLifecycle.ts` 广播通知），停止后迟到帧不写回，具体原因在后续 `status / poll` 返回。会话按「角色 + Thread」隔离跨轮维持。

### 4.2 耳朵实时转写（`electron/main/services/ears/`）

在设置开启耳朵且模型下载校验通过后，由 `watch.start` 传入 `listen: true`（或 `companion: true`；不传 `windowId` 时仅听不看）激活录音；未就绪时返回 `ears{listening: false, reason}`（`EARS_DISABLED` / `EARS_MODEL_MISSING`），不影响盯窗口本身：

- **录音模式与无缝退回**（`earsCaptureSelect.ts`）：默认 `selfExclusion: process` 在 Windows 10 2004（Build 19041）及以上采用进程回环，直接排除 infOS 主进程树（含渲染与识别子进程）录制整机声音，自身 TTS 不会混入且不影响其他播放声音；设为 `drop`、系统低于要求或助手故障时无缝切回整机回环降级模式（同次运行 `10` 分钟内不重试进程回环），并在设置页通过 `earsCapture` / `earsCaptureFallback` 展示当前模式及原因。
- **进程回环实现**（`earsLoopback.ts` / `earsLoopbackSource.ts`）：经 `ActivateAudioInterfaceAsync("VAD\Process_Loopback")` 与 `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` + `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` 请求 `16 kHz` 单声道 float32（`AUTOCONVERTPCM`），由系统 `csc.exe` 缓存编译为 `desktop-bridge/infos-ears-loopback-<hash>.dll` 并使用与视觉助手相同的字节完整性校验加载；无音频包期间按墙钟向 stdout 补零使 VAD 准确判句尾，stderr 每行输出 `ready` / `error` JSON（错误码 `EARS_LOOPBACK_UNSUPPORTED / UNAVAILABLE / FAILED` 仅触发退回），关闭 stdin 结束。实现参考 Microsoft ApplicationLoopback 示例与 NAudio（均 MIT），归属说明见 `THIRD_PARTY_NOTICES.md`。
- **整机回环与静音闸门**（`earsCapture.ts`、`electron/preload/earsCapture.ts`、`earsAudio.ts`）：降级路径使用隐藏空白页 `infos-ears://capture/` 与独立内存 session 注册 `setDisplayMediaRequestHandler({ audio: 'loopback' })`，拿到音频流后立刻停止画面轨、重采样为 `16 kHz` 单声道每 `0.5s` 输出一块；`webContents.isCurrentlyAudible` 检测到 infOS 自身出声期间及停声后 `0.6s` 内整块丢弃。闸门根据 `ears.silenceThreshold` 在发声后再送 `1.2s` 静音促成断句，随后静音直接丢弃。
- **离线识别与中文实测参数**（`earsWorker.ts` / `earsEngine.ts`）：在独立 `utilityProcess` 中加载 `sherpa-onnx-node`（Apache-2.0，由 `asarUnpack` 解包）运行 silero VAD + SenseVoice int8 离线识别（输出前由 `tidyText` 修正逆文本规范化产生的「十0」「三.7」类数字拆解）。默认参数 `DEFAULT_TUNING` 按中文视频实测确定：**VAD 阈值 `0.4`、句末静音 `0.3s`、最短 `0.25s`、最长一句 `8s`**（相比 `0.5`，`0.4` 可避免背景音乐中的人声被整段漏掉，而 `0.3` 会在纯解说视频引入误识别；BGM 下单句常拖至 `12–20s`，上限压至 `8s` 后开口到交付平均延迟从 `10.6s` 降至约 `8s` 且字错率不变；`zh` 与 `auto` 区别很小故默认 `auto`；两线程实时率约 `0.02`，即 1 分钟音频耗时约 `1.2s`）。各段起止时间戳根据每块原始时刻折算回墙钟时间，静音丢弃不产生时间漂移。
- **台词缓存与模型下载**（`earsTranscript.ts` / `earsModel.ts`）：内存按调用方游标保留最近 `400` 句 / `2` 小时；`take_screenshot` 与 `watch.poll` 附带增量 `heard{since, until, count, lines, more?}`（单次最多 60 句 `[时:分:秒] 台词`），`watch.heard` 支持 `from/to` 或 `lastSec` 只读回查。模型不随安装包分发，由用户点击下载至用户数据目录 `ears-model/sense-voice-2024-07-17/`：
  - `silero_vad.onnx`（`643,854` 字节，来自 sherpa-onnx 发布页）
  - `tokens.txt`（`315,894` 字节）与 `model.int8.onnx`（`239,233,841` 字节，来自 Hugging Face `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`，不可达时回退 `hf-mirror.com`）
  下载流式计算 SHA-256，校验异常删除文件并报 `EARS_MODEL_SIZE_MISMATCH` / `EARS_MODEL_HASH_MISMATCH` / `EARS_MODEL_DOWNLOAD_FAILED`；通过后记录大小、mtime 与哈希，后续启动仅快检大小与 mtime。
- **停止与可见指示**：最后一个调用方停用、关闭开关、识别进程退出或录音页报错时立即停录；录音期间工作台顶部常驻不可关闭的红色提示条（带「停止」按钮），最小化后在系统托盘保留状态与停止入口，桌宠旁可选显示 `ears.petIndicator` 状态标识。

### 4.3 陪看模式（`electron/main/services/companion/companionService.ts`、`companionClock.ts`）

- 在对话会话中调用 `watch.start` 并设 `companion: true` 时激活陪看（同时联动耳朵与盯窗口）。
- **播放状态与频率配额**：画面有变化或听到新台词计为播放中（媒体时间仅在播放时累计），静默超过 `pauseAfterSec` 视为暂停（本地继续按帧率检测恢复，不发图也不插话）。主动插话需同时满足宿主间隔 `minIntervalSec`、小时上限 `maxPerHour` 与服务端滚动配额（按角色强制最少 `3` 分钟、每小时最多 `20` 次，重连不重置、后端重启清空内存）；关闭 `companion.interject` 时仅回应用户发言。
- **触发、不剧透与安全边界**：每 `5s` 检查满足条件后，通过携带管理凭据显式 Bearer 的 `POST /api/scheduler/proactive/watch-along`（`watchAlongTurn.ts`，复用主动执行器，不受「智能陪伴」总开关限制）提交主动回合，随附新台词（需要画面时由模型调 `poll`，提示要求只依据已播出内容不剧透后续情节）；返回 `busy` 时退回台词不计额度。送达时间估算采用本地生成耗时指数平滑值；主窗口通过可信 IPC 每 `5s` 续期输入在场信号（`15s` 过期，不传送草稿），用户开始说话即取消进行中的陪看插话。`watch-along` 与在场接口拒绝浏览器 Origin、设备凭据和 Cookie。盯窗口停止或 `watch.stop` 时自动结束陪看。

---

## 5. 区域截图、坐标映射与内置浏览器联动

- **双向线性换算**（`desktopCoordinateMapping.ts`）：观察结果 `coordinateContext.mapping` 提供截图像素、桌面 DIP 与物理像素（通过 `screen.dipToScreenRect` 计入 125%/150% DPI 缩放与副屏偏移）的双向线性变换：`目标 = offset + 截图坐标 × scale`，`scale = (区域尺寸 - 1) / (截图尺寸 - 1)`，与 `resolveDesktopPoint` 保持两端对齐；`get_mouse_position`、控件 `bounds` 及 `coordinateSpace: desktop` 均为物理像素，反向换算为 `(物理 - offset) / scale`。
- **局部放大**（`take_screenshot.region`）：传入 `{x, y, width, height}`（完全位于参考图内部）及参考 `observationId`，由客户端按观察记录解析窗口、显示器与 DIP 范围并实时重采当前画面，返回新 `observationId`、实际宽高及 `coordinateContext.bounds`（支持嵌套放大）。不再统一压至 `1280px`，`desktopImageEncode.ts` 默认 `DEFAULT_MAX_WIDTH` 为整屏 `1600`、窗口 `1920`、局部 `2560`（显式传 `maxWidth` 可在 `320–2560` 间指定），窗口与局部在上限内保留原清晰度；其他桌面平台复用同一只读区域观察与绑定校验。
- **内置浏览器兼容扩展**：`browser_screenshot` 与 `browser_page_image` 支持同结构 `region` 并返回有效期 `2` 分钟的 `screenshotId`（绑定调用方、账号/会话与标签页，附带 CSS 视口、在隔离世界跟踪的页面代次与缩放比）；`browser_interact` 的 `click / hover` 支持传 `screenshotId` + 截图像素 `x / y`（与元素 `target / handle` 互斥），执行消费当前截图引用，页面跳转、滚动或缩放后需重新截图。

---

## 6. 「桌面与家」配置、环境事件与接管暂停

### 6.1 配置存储与设置拆分（`electron/main/services/home/`）

- **界面拆分**：主设置中心将感知（`DesktopPerceptionSettingsTab.vue`，`perception_pet`）与权限安全（`DesktopSecuritySettingsTab.vue`，`desktop_security`、`DesktopSafetySettings.vue`）拆分呈现，共享空间归入 `CompanionsTab.vue`；`DesktopHomeSettings.vue`（`desktop_home`）支持在 Electron 中摘出为独立面板（`#/panel/desktop_home`）。浏览器端仅展示共享空间、授权记录与后端 `/api/home` 文件保护。
- **持久化契约**（`homeSettings.ts`、`homeSettingsSchema.ts`、`homeSettingsMigrations.ts`）：选项统一写入用户数据目录 `desktop-home.json`（当前 `version: 2`，v1→v2 新增 `environment` 并丢弃 v1 同名残留字段；兼容并在首次读取时合并删除旧 `desktop-vision.json`；写回失败本次仍用迁移值、保留旧文件）。文件超 `256 KB`、非对象或版本不兼容时回退默认值；读取时越界数值裁剪、未登记字段丢弃；设置页提交的修改严格拒绝未知字段与非法类型/枚举，写入先落临时文件再原子重命名。桌面操作总开关与停止快捷键独立由 `desktopControlSettings.ts` 即时签名保存。
- **分区默认值**：
  - `vision`：`{imageQuality: 80, observationTtlSec: 600, ocrLanguage: ""}`
  - `ears`：`{enabled: false, language: "auto", silenceThreshold: 0.008, petIndicator: true, selfExclusion: "process"}`
  - `companion`：`{interject: true, minIntervalSec: 120, maxPerHour: 30, pauseAfterSec: 20}`
  - `environment`：`{enabled: false, idle: true, idleMinutes: 5, fullscreen: true, taskCompleted: true}`
  - `internal`（不展示于界面）：耳朵模型校验信息、编译缓存 DLL 的 SHA-256 与签名。
- **IPC 通道与文件保护**：`desktop-home:get`（返回 `{settings, status}`）、`desktop-home:update({section, patch})`、`desktop-home:model(download|cancel|remove)`、`desktop-home:stop-listening`、`desktop-home:status`（录音、陪看、模型进度推送）、`desktop-home:environment-take(agentId)`（发消息前取走）、`desktop-home:environment-task({agentId, taskId})`（任务完成转发）。`desktop-home.json` 与 `desktop-bridge/` 均列入受保护名单，Agent 文件工具改动需逐次确认。

### 6.2 环境事件（`environmentRuntime.ts`、`environmentEvents.ts`）

- 默认关闭（`environment.enabled`），仅采样三种状态翻转信号：**空闲**（无系统输入达到 `idleMinutes` 记离开，恢复输入记回来）、**第三方全屏**（非 infOS 且非桌面的其他前台窗口与某块屏幕边界重合，仅记布尔状态不记应用名与画面）与 **后台任务完成**（由界面经推送转告主进程，仅记所属角色、同任务去重）。
- 主进程每 `5s` 采样一次，进入有界信箱（最多 `50` 条 / 最长 `24` 小时，首次采样仅记基线）；总开关关闭、桌面操作关闭、锁屏休眠时暂停采样，暂停或断线重连（`desktopObservationLifecycle.ts`）后重新建立基线，关闭某类开关立即清除该类未取事件。
- 用户发送对话消息前由前端取走并从信箱移除最多 `20` 条（发送失败不补发），后端 `services/conversation/environmentContext.ts` 校验任务归属与完成态后整理为 `<desktop_environment>` 附加到本轮用户消息末尾送给模型（不写入 Thread 正文，也不主动唤醒模型）。

### 6.3 用户接管、暂停分级与执行模式接入

- **空闲等待**：注入动作开始前等待系统连续 `600ms` 无键鼠输入（最长等 `2s`），持续繁忙返回 `DESKTOP_USER_BUSY`（不视作明确接管，模型可继续文件、终端或内置浏览器工作）；控制权版本变更仍使旧观察失效。
- **接管检测与恢复**：Windows 桥接标记自身注入事件，任何未标记键鼠活动视为用户接管，触发监听失效则拒绝输入。普通会话遇接管、锁屏、停控快捷键、监听失效或结果不明时中止执行并保存 `executionPause` 与原工具结果（界面显示暂停）；用户点击「继续任务」后同步解除设备暂停并发起续接轮次（后台 Agent 工具无法自行解除接管；结果不明动作继续要求先核验）。后台任务进入可恢复暂停并保留检查点；NIT 脚本遇接管时同步取消内部工具与脚本。主应用与任务详情提供暂停/继续控制，桌宠呈现短提醒与跳转入口。
- **两级暂停（`desktopControl.pause` / `pauseInput`）**：
  - **只暂停输入**：用户操作期间误触键鼠、执行中断或结果不确定时触发；作废可操作观察并释放执行器按住的键鼠，同时放行 `assertAvailable(signal, 'observe')` 让盯窗口、耳朵与陪看继续运行。
  - **完全停止**：停止快捷键（默认 `Control+Alt+Escape`，可在设置录入）、总开关关闭、锁屏休眠、断线、桥接退出、客户端退出、红色提示条或顶部操作提示条的停止按钮触发；调用 `stopDesktopObservations` 一并停止输入与全部观察，且已完全停止状态不降级为只暂停输入。
- **顶部操作标识与执行模式**：执行跨应用操作期间（`phase=running` 及动作间隔 8 秒内），`electron/main/home/homeOperatingBar.ts` 在屏幕顶部居中显示置顶、不抢焦、设置 `setContentProtection` 防进截图的「她正在操作「窗口」」条与停止按钮。后端随 `__desktopCaller` 传入会话执行模式：手动模式下即便目标应用已信任或已预批，仍逐动作本机弹窗确认；发消息、付款、系统设置与终端在任意模式下均强制逐次确认。

---

## 7. 桥接完整性、超时控制与源码入口

- **按需编译与缓存完整性**（`windowsDesktopProtocol.ts`、`home/assemblyIntegrity.ts`）：隐藏 PowerShell 桥接使用系统 .NET Framework UIA 与 Win32 API，源码内置于主进程并按内容哈希编译缓存为 `desktop-bridge/infos-desktop-*.dll`（首次编译输出 `{"compiling":true}`，启动超时从 `20s` 放宽至 `60s`，`DesktopControlState.preparing` 为真时界面显示「正在准备桌面组件」；缓存不可用时退回内存编译）。编译时记录 SHA-256 及 `settingsSigner` HMAC 签名（存入 `desktop-home.json` `internal` 分区；系统加密不可用时退回仅哈希），PowerShell 与 C# 加载阶段均直接读取字节验证哈希并通过 `Assembly.Load(byte[])` 加载，校验不通过立即删除重编。
- **请求超时与文件回收**（`desktopBridgeFiles.ts`）：单请求超时为 `observe` `15s`、`ocr` `20s`、`capture` `12s`、其余 `10s`；超时发送取消并丢弃迟到回音，返回 `DESKTOP_REQUEST_TIMEOUT`（注入请求标记 `dispatched: true`）。被放弃请求或原生视觉工作线程超过 `30s` 无响应时回收桥接进程；仅在迟到回音、原生线程结束或桥接退出后清理登记在专用临时目录的 UUID 像素文件。Capability 取消信号经工具端口与 WebSocket 下传至桥接（字符与拖拽步之间检查中断；已发送输入不可撤销）。截图进入视觉上下文最多保留最近两组，工具审计剥离图像像素、检查点仅留摘要。
- **详细故障码与第三方致谢**：截图错误由 `desktopCaptureFailure.ts` 细分为 `SCREEN_CAPTURE_DENIED`（权限受限/锁屏/UAC/RDP 断开）、`SCREEN_CAPTURE_SOURCE_MISSING`、`SCREEN_CAPTURE_REGION_INVALID`、`SCREEN_CAPTURE_EMPTY`、`SCREEN_CAPTURE_FAILED` 与 `DESKTOP_WINDOW_MINIMIZED`，执行中目标关闭返回 `DESKTOP_WINDOW_GONE`。部分 C# 移植自 `dsh-computer-use-win`（MIT），元素图融合参考 `clawdcursor`（MIT），进程回环参考 Microsoft ApplicationLoopback 与 NAudio（MIT），均已在仓库根目录 `THIRD_PARTY_NOTICES.md` 声明；耳朵使用 `sherpa-onnx-node`（Apache-2.0）。
- **核心源码入口**：
  - Electron 控制器与桥接：`electron/main/services/desktopAutomation.ts`、`desktopControl.ts`、`desktopControlSettings.ts`、`desktopObserve.ts`、`desktopActionFollowUp.ts`、`desktopSettle.ts`、`windowsDesktop.ts`、`windowsDesktopSource.ts`、`windowsDesktopUiaSource.ts`、`windowsDesktopCaptureSource.ts`、`windowsDesktopVisionSource.ts`、`windowsVisionSource.ts`
  - Electron 常驻感知与界面：`electron/main/services/home/`（`homeSettings.ts`、`assemblyIntegrity.ts`、`environmentRuntime.ts`）、`electron/main/home/homeOperatingBar.ts`、`electron/main/services/ears/`、`electron/main/services/companion/`
  - 后端与文档：`packages/backend/src/services/conversation/environmentContext.ts`、`packages/backend/src/services/execution/desktopPause.ts`、`packages/backend/src/tools/advancedTools.ts`；常驻感知整体边界见 [常驻感知](B_PERCEPTION.md)
