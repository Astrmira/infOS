# P11 桌面预制件与收纳框

预制件是 infOS 内置的受信任卡片类型：生命周期管理、置顶、贴到桌面底层、`Ctrl/Cmd+W` 关闭、卡片页管理与开机恢复均沿用 [P03 阶段 4、5](./P03_DESKTOP_SHELL.md) 的卡片系统实现；差异在于渲染方式与受控能力（全透明窗口、不使用毛玻璃材质、通过页面内手势移动与缩放）。

| 维度 | 普通卡片（角色 HTML） | 预制件 |
| --- | --- | --- |
| 页面来源 | 角色提供的 `index.html` | 宿主内置空白文档，CSP 为 `script-src 'none'` |
| 界面绘制 | 页面内脚本 | 预制件 preload（`electron/preload/prefab.ts`）在隔离环境中绘制 |
| 暴露对象 | `window.infosCard` | 无（不调用 `contextBridge`） |
| 主进程能力 | 白名单数据、通知、绑定会话 | 按注册表声明的能力（见下表） |
| 30 张上限计数 | 计入 | 由 `countsTowardCardLimit` 决定（收纳框不计） |
| 收藏默认 | 新建时临时 | 新建即收藏，关闭不进入「最近关闭」 |

两类卡片共用沙箱环境（独立内存 session、禁代理、禁导航、禁新窗口、禁下载、禁权限请求），普通卡片调用预制件 IPC 通道统一返回 `DESKTOP_PREFAB_FORBIDDEN`。

---

## 1. 注册表与新增规范

定义位于 `packages/shared/src/desktopPrefabs.ts`：

- **`DESKTOP_PREFAB_KINDS`**：预制件种类枚举（当前仅 `fence`）。
- **`DESKTOP_PREFABS[kind]`**：声明 `version`、`capabilities`、`defaultSize`、`minSize`、`countsTowardCardLimit` 与 `normalizeState(value, fromVersion)`。
- **`card.json` 存储**：`prefab` 字段为 `{ kind, version, state }`，读取时按种类归一化迁移至当前版本；缺少对应种类的未知记录因无 `index.html` 由存储层直接跳过。

### 1.1 受控能力清单（`DESKTOP_PREFAB_CAPABILITIES`）

主进程严格核验预制件种类是否已声明对应能力，未声明即拒绝：

| 能力 | 含义 |
| --- | --- |
| `launch-registered` | 按项目 ID 启动本预制件登记或映射的项目 |
| `file-icons` | 由主进程读取并缓存系统图标与图片缩略图 |
| `folder-watch` | 监视映射文件夹内容变动并推送刷新 |
| `drop-reference` | 将拖入的文件登记为引用条目 |
| `collapse` | 折叠为仅保留标题栏 |
| `fullscreen-yield` | 前台存在全屏窗口时临时隐藏避让 |
| `window-gesture` | 通过页面指针手势移动与缩放自身窗口 |
| `drag-out` | 将项目作为系统文件拖出至外部窗口（仅按项目 ID） |

### 1.2 新增预制件步骤

1. **共享定义**：扩展 `DESKTOP_PREFAB_KINDS` 与 `DESKTOP_PREFABS`，状态与纯逻辑放入独立模块（参照 `packages/shared/src/desktopFence.ts`）。
2. **主进程处理器**：在 `electron/main/prefabs/desktopPrefabs.ts` 的 `handlers` 注册 `PrefabKindHandler`（系统能力通过依赖注入，方便测试替身）。
3. **预制件视图**：在 `electron/preload/prefab.ts` 的 `VIEWS` 注册视图。**重要打包约束**：预制件 preload 仅导入 `desktopPrefabs.ts` 常量与类型，不与 `card.ts` 共同引用 `desktopCards.ts` 等运行时模块，避免沙箱 preload 因构建拆出公共 chunk 而无法按相对路径 `require`。
4. **Agent 工具**：在 `packages/backend/src/tools/shell/` 新增工具并经外壳 `prefab` 能力调用，身份由 `shellHomeInput` 统一注入。
5. **版本迁移**：变更状态结构时递增 `version`，并在 `normalizeState` 实现向上迁移逻辑。

---

## 2. 收纳框（`fence`）设计与实现

将桌面上的程序、文件与文件夹以**路径引用**收纳在深色半透明直角边框框体中（不复制、不移动、不删除源文件）。

### 2.1 状态结构（`packages/shared/src/desktopFence.ts`）

| 字段 | 说明 |
| --- | --- |
| 标题（`card.name`） | 60 字以内 |
| `collapsed` | 折叠后窗口缩为 `30px` 标题栏（仅可调宽），`card.bounds` 保留展开高度 |
| `alwaysOnTop` / `desktopLayer` | 与普通卡片字段互斥（开启一项自动关闭另一项） |
| `iconSize` | `small` / `medium` / `large` |
| `sort` | `manual`（登记顺序，支持框内拖放排序）/ `name` / `type`（文件夹 → 程序 → 快捷方式 → 文件，再按名称） |
| `backgroundOpacity` | 背景不透明度 `0–100` 整数（默认 `42`；版本 2 新增，旧数据补默认值） |
| `items` | 手动登记项 `{ id: 'i-…', path, addedAt }`，上限 `200` 项，路径不区分大小写去重 |
| `folder` | 映射文件夹，展示直接子项（上限 `300` 项，子项 ID 为 `f-` + 名称 SHA-1 前缀） |
| `createdBy` | `{ kind: 'user' }` 或仅由宿主注入的 `{ kind: 'agent', agentId, sessionId }` |

路径校验仅接受本机绝对路径，拒绝 `\\server\share` UNC 网络路径、`\\?\` 设备路径、相对路径、`..` 跨越段与控制字符，避免解析图标时发起外部网络访问。

### 2.2 条目展示、图标缩略图与拖放启动

- **存储隔离**：增删条目仅改写 `card.json`，删除收纳框仅删除 `desktop-cards/<ID>/`。映射文件夹自动过滤点开头文件与 Windows 隐藏属性文件（通过 `GetFileAttributesW` 检查，koffi 不可用时退回按名称过滤）；手动登记项不受过滤限制。
- **系统图标缓存**：调用 `app.getFileIcon(path, { size: 'large' })`；`.lnk` 优先通过 `shell.readShortcutLink` 读取图标或目标路径，均不可用时读取 `.lnk` 自身。按「路径 + 修改时间 + 大小」缓存最多 `512` 项。
- **异步排队缩略图**：`png / jpg / jpeg / webp / gif / bmp` 通过 `nativeImage.createThumbnailFromPath` 生成（图标档位 2 倍尺寸，等比缩放并 `object-fit: contain` 居中；先展示系统图标再异步替换，超过 `64MB` 或失败沿用系统图标并记录按「像素 + 路径 + 修改时间 + 大小」缓存，最多 `600` 项）。因 Windows 下 `createThumbnailFromPath` 实际阻塞主线程且工具进程缺少 `nativeImage`，主进程在内部排队调度（每轮事件循环启动 1 个、间隔 `16ms`、最大并发 `3` 个；页面并发上限 4 张，视图变更丢弃排队旧请求），读图标时 2 秒内共用条目列表避免重复遍历目录。
- **大列表渲染优化**：列表项采用 `content-visibility: auto` 与图标 `decoding="async"`（不使用对 data URL 无效的 `loading="lazy"`）。`FenceView` 下发给页面的数据仅含 ID、显示名、类型、缺失标记、是否来自文件夹、修改时间与大小版本、是否图片及可否拖出标记，不包含真实文件系统路径。
- **启动与拖入/拖出**：
  - **启动**：页面传 `launch` + 项目 ID，主进程在本框当前条目反查路径后调用 `shell.openPath`（每框每分钟限 `20` 次；传路径、他框 ID 或已移出 ID 返回 `DESKTOP_FENCE_ITEM_NOT_FOUND`）。
  - **拖入**：preload 在原生 `drop` 事件中经 `webUtils.getPathForFile` 取得路径，主进程校验后登记引用（不触发启动）；`reorder` 仅接收 `i-` 前缀项。
  - **拖出与排序合一**：`dragstart` 取消 HTML5 拖拽并调用 `desktop-prefab:drag-out` 仅传项目 ID；主进程反查路径并过滤隐藏属性、系统属性、点开头文件与 infOS 凭据等受保护文件（共用后端 `protectedFiles.ts` 名单；文件夹可整体拖出）后，以只允许复制与引用的方式调用 `webContents.startDrag`（每框每分钟限 `60` 次，同时仅 1 个在途；缺失、隐藏或受保护登记项保留 `dragOut: false` 在框内以 HTML5 排序）。落回本框由 `fenceDropOutcome` 判定为框内排序或忽略（Windows 下因 `startDrag` 阻塞返回与 `drop` 事件顺序不固定，页面在 `startDrag` 返回后延迟 `800ms` 才清除「本框发起」标记）。
  - **文件夹监视**：使用非递归 `fs.watch`，合并 `400ms` 内变更后推送新视图；关闭窗口或删除收纳框时停止监听。

### 2.3 透明窗口、手势与系统集成

- **逐像素透明与防穿透**：预制件窗口设 `transparent: true` 与 `#00000000` 底色，不使用会与透明冲突并在失焦时变灰的 `backgroundMaterial`；背景透明度通过 `--fence-bg-alpha` 调节，保证图标与文字不随背景变淡（窗口级 `card.opacity` 为 `1` 时不调用 `setOpacity`）。为防止全透明区域穿透鼠标，实际绘制背景最低保持 `FENCE_MIN_HIT_ALPHA`（约 `3/255`），圆角外侧由缩放手柄覆盖。
- **指针移动、缩放与 DPI 防漂移**：标题栏（不含按钮）采用指针捕获手势移动（禁用 `-webkit-app-region`，位移 `> 4px` 触发拖动，双击改名由纯函数 `FencePress` 于 `electron/preload/prefabs/fencePointer.ts` 判定）。窗口设 `resizable: false`，通过隐形边缘手柄缩放（左右下边 `10px`、上边 `8px`、四角 `16px`；内容区左右下预留 `10px`；折叠保留左右边，贴桌面时隐藏）。手势以动画帧上报相对按下的**累计增量**（`screenX / screenY`），由 `fenceGestureBounds` 基于 `begin` 初始值累加计算避免混合 DPI 漂移，`end` 时经 `commitWindowBounds` 立即落盘；`windowBounds` 将无原生下限的窗口尺寸钳制在 `140×80`（折叠 `140×30`）并在折叠/展开之间双向换算以保留展开高度。
- **关闭与贴桌面约束**：标题栏最右关闭按钮平时隐身占位、悬停显示深色底，与 `Ctrl/Cmd+W` 共用 `DesktopCards.close`（可在卡片页重新打开）。贴附到 `WorkerW` 桌面图标层后不可拖动与缩放（`begin` 返回 `DESKTOP_CARD_PINNED`，折叠仅通过 `setSize` 调高）。
- **全屏让开**（`electron/main/prefabs/fullscreenYield.ts`）：存在声明 `fullscreen-yield` 的框体时，每 `1.5s` 检测前沿窗口经 `screen.screenToDipRect` 换算后是否在 `2px` 容差内覆盖对应显示器（排除 `Progman`、`WorkerW` 与任务栏，贴桌面窗口不隐藏），覆盖即隐藏并在退出全屏后 `showInactive`。实现参考 [Lively Wallpaper](https://github.com/rocksdanister/lively)（GPL-3.0）理念并独立编写。
- **隐藏桌面原图标**（`electron/main/prefabs/desktopIcons.ts`）：仅开放给主窗口与桌面面板卡片页切换，向桌面 `SHELLDLL_DefView` 发送 `WM_COMMAND 0x7402` 由资源管理器自行切换并记录是否由 infOS 在 `desktop-prefabs.json` 中触发隐藏，再次发送即恢复。

---

## 3. 通道清单与 Agent 工具 `shell_fence`

### 3.1 IPC 通道

| 通道 | 发送方 | 说明 |
| --- | --- | --- |
| `desktop-prefab:state` | 预制件窗口主 frame | 读取当前视图 |
| `desktop-prefab:icon` | 同上 | `(itemId, variant?)` 获取图标，传 `'thumbnail'` 取缩略图（需 `file-icons`） |
| `desktop-prefab:action` | 同上 | `(action, payload)` 按种类校验并执行动作（支持 `launch`、`collapse/pin/layer`、`iconSize`、`sort`、`backgroundOpacity`、`rename`、`remove/reorder`、`drop`） |
| `desktop-prefab:gesture` | 同上 | `(phase, payload)` `begin / update / end` 传累计增量，限作用于发送者窗口（需 `window-gesture`） |
| `desktop-prefab:drag-out` | 同上 | `(itemId)` 发起系统文件拖拽（需 `drag-out`，Windows 上拖拽结束后返回） |
| `desktop-prefab:changed` | 主进程推送 | 视图变更广播 |
| `desktop-prefab-admin:create-fence` | 主窗口 / 桌面面板 | `{ folder?: boolean }` 创建框体或弹窗选映射文件夹 |
| `desktop-prefab-admin:desktop-icons` / `set-desktop-icons` | 同上 | 读取 / 切换隐藏桌面原图标状态 |

### 3.2 Agent 工具 `shell_fence`

通过 `desktop.shell` 的 `prefab` 能力调用：后端 `shellHomeInput` 丢弃模型伪造的 `__homeScope / homeBinding / createdBy` 并注入运行上下文 `agentId / threadId`（Electron 缺乏可信身份时返回 `DESKTOP_PREFAB_SCOPE_REQUIRED`），新建收纳框自动记录为 `createdBy`。支持动作：`list`、`desktop`（只读列出用户桌面与公共桌面直接子项）、`create`、`update`、`add`、`remove`、`reorder`、`arrange`（`column / row / grid`，自动跳过贴桌面框体）与 `delete`；启动项目走桌面操作授权流程。

---

## 4. 源码入口

- **共享契约**：`packages/shared/src/desktopPrefabs.ts`、`packages/shared/src/desktopFence.ts`
- **卡片挂钩**：`electron/main/windows/desktopCardModel.ts`（`DesktopCardPrefabHooks`）、`desktopCardManager.ts`、`desktopCardWindow.ts`
- **主进程实现**：`electron/main/prefabs/`（`desktopPrefabs.ts`、`prefabRuntime.ts`、`prefabDocument.ts`、`prefabNative.ts`、`fullscreenYield.ts`、`desktopIcons.ts`、`fence/` 子目录 `fenceService.ts`、`fenceEntries.ts`、`fenceIcons.ts`、`fenceDrag.ts`、`fenceAgent.ts`、`fencePageActions.ts`）
- **Preload 与动效**：`electron/preload/prefab.ts`、`electron/preload/prefabs/`（`fencePointer.ts`、`fenceView.ts` 等；动效内联 [S07](./S07_MOTION_LAYER.md) 的 `motion.css`）
- **后端与前端**：`packages/backend/src/tools/shell/fence.ts`、`homeScope.ts`；`packages/frontend/src/components/shell/cards/FenceToolbar.vue`
