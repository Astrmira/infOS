# 前端架构与性能优化

> **适用范围**：`packages/frontend/` 全部代码
> **技术栈**：Vue 3 + Vite + Pinia + TailwindCSS 4 + logic composables
> **最后更新**：2026-11-12

---

## 1. 核心架构

对话 Store 记录服务端主侧类型、代次与操作能力，窗口单独保存会话选择。角色状态 Store 按 Agent 缓存共享投影。主线过程通过 Surface 的 `processCollapsed` 默认收起，实时与历史沿用统一字段，重置通知和 `threadGeneration` 用于丢弃迟到结果。完整规则见 [主侧会话](./B26_MAIN_SIDE_THREADS.md)。

前端采用 **"视图-Store-逻辑"** 三层分离架构，并引入 **Transport 层** 实现跨环境兼容。

```
┌─────────────────────────────────────────────────────────┐
│  View 层 (views/ components/)                            │
│  职责：UI 渲染、组件编排、用户交互                        │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Logic 层 (composables/)                                 │
│  职责：响应式业务逻辑 (useXxx)、生命周期管理、UI 状态控制   │
└───────────┬───────────┴───────────┬─────────────────────┘
            │                       │
┌───────────▼───────────┐   ┌───────▼─────────────────────┐
│  State 层 (stores/)    │   │  Transport 层 (api/)         │
│  职责：跨组件全局数据    │   │  职责：通信适配 (IPC/REST)   │
└───────────────────────┘   └─────────────────────────────┘
```

---

## 2. 跨环境兼容 (Transport)

同一组件必须能同时运行在 **Electron (桌面)** 和 **Browser (Docker 版)** 中。

- **业务通信**：Electron 和浏览器均通过 HTTP、SSE 与 WebSocket 连接当前服务端；`api/transport.ts` 管理地址、设备凭据和请求。
- **客户端能力**：桌面窗口、托盘等 Electron 专有操作通过 `window.electron` 与主进程 IPC；浏览器环境使用相应 Web 能力或受限回退。

所有 API 调用统一封装在 `api/` 目录下，并根据环境自动切换实现。

### 首次上手引导

桌面版引导分启动器和主界面两段，步骤文案定义在 `composables/launcher/onboardingScripts.ts`，由 `OnboardingOverlay.vue` 渲染。启动器允许在高亮区域选择伙伴，再通过真实启动按钮进入主界面；主界面优先介绍聊天。`DesktopOnboarding.vue` 仅依据当前角色或主模型的指派以及模型列表判断是否已有模型，不将此判断视为连接测试；查询失败或环境变量等未覆盖的配置使用可跳过的选择。用户选择配置模型后，非模态提示随实际模型配置页面显示，可收起或返回聊天。

`onboardingFlow.ts` 通过本地缓存和服务端配置保存启动器、主界面及完成状态，使用 `runId` 防止旧窗口覆盖后发起的引导。跳过和完成均记为完成，启动器“关于”中可重新打开；配置中途关闭应用时，下次会从主界面引导重新开始。

---

## 3. 性能优化 (P0 级别)

> 本规范基于 infOS 现有渲染审计和流式性能优化经验。

### 3.1 `<keep-alive>` 白名单

- **原则**：只缓存切换频繁且初始化开销大的页面。
- **顶层路由**：Electron 和浏览器共用 `MainView`；`App.vue` 在完成认证后仅将 `MainView` 加入顶层缓存。
- **主界面 Tab**：`MainView.vue` 承载 7 个一级主舞台入口（`ChatTab`、`StrongholdTab`、`WorkspaceTab`、`CompanionsTab`、`MemoryHubTab`、`TasksTab`，Electron 桌面端另有独立的 `CardsTab`），统一纳入 `:max="7"` 的 `KeepAlive` 缓存；已就绪的一级入口通过 `useMainNav.ts` 双帧 `requestAnimationFrame` 调度切换（首帧先更新 `activeNavTab` 高亮，次帧激活目标页面），并在 `onActivated` 中执行带新鲜度窗口的后台静默刷新（SWR），不再闪烁骨架屏。二级聚合台（伙伴、记忆馆）默认静态直载高频首屏子页，其余子标签与居中模态设置中心（`SettingsHubModal.vue`）继续采用 `v-if` 按需挂载，离开子标签或关闭设置弹窗时立即卸载以释放 DOM 与响应式内存；`LogsTab.vue` 在收起或切换会话条目时同步清空已拉取的调试消息数组，`BackupsTab.vue` 仅在展开底部折叠面板时按需加载嵌入态 `ResetTab.vue`。组件在停用和卸载时分别处理连接、计时器及重型视图资源。
- **独立路由**：`LauncherView` 和 `Pet3DView` 仅 Electron 可访问，浏览器对应路径转向主界面。

### 3.2 响应式性能

- **禁止深度响应**：对大型数组（消息列表、记忆列表、日志、任务）和物理引擎对象（Three.js）必须使用 `shallowRef` 或 `markRaw`。
- **避免多余 watch**：禁止在 `useStreamMarkdown` 等高产出逻辑中使用冗余的深度监听。

### 3.3 首帧同步富文本与流式帧合并 (60fps)

针对历史与 SSE 流式 Markdown 消息，采用 **"稳定区同步首帧 + 尾部区帧合并"** 分段架构：

1. **稳定区 (Stable)**：已闭合的消息与稳定分段在首帧同步执行 `renderChatRichTextResult` 并直接挂载净化后的 HTML，消除纯文本占位切换到富文本时的排版跳动。
2. **尾部区 (Tail)**：正在追加的流式块沿同一富文本管线渲染，不额外经历纯文本降级态。
3. **调度**：流式未闭合块通过 `requestAnimationFrame` 将同一显示帧内的多次 delta 合并为单次 DOM 更新（最高 60fps），收口转为 `stable` 时立即取消挂起帧并同步提交最终分段。

### 3.4 对话历史分页、渐进窗口与会话投影缓存

对话页不得一次加载并挂载整个 Thread，也不得依赖固定 200 条 Projection 上限掩盖 DOM 增长。采用以下组合策略：

- 首次只请求最新 60 条消息；`ChatContainer.vue` 初次仅挂载底部最新 24 条消息窗口，用户上滚接近窗口顶部时每次锁定锚点渐进展开 24 条，触达已拉取边界后再按游标继续加载更早历史。
- `useThreadStore.ts` 与 `ChatTab.vue` 维护最多 12 条最近访问会话的 LRU 投影快照与会话列表缓存（SWR），切换角色或重返已访问会话时 `0ms` 还原消息与 Compositor 作用域，并在后台静默校验增量；淘汰旧会话时同步调用 `compositor.disposeScope` 回收作用域。
- 流式消息、当前播放消息和交互 Surface 必须保持真实 DOM，不得被窗口化卸载。
- 已提交 Markdown 以源码为键使用有界 LRU 缓存；消息与 Surface 按 `messageId + revision` 保持对象身份。
- `useMessageVisibility.ts` 将同一批 `IntersectionObserver` 回调合并后通过 `setSuspendedBatch` 一次性提交，不可见时以容器样式类暂停动画并暂停 Video、Audio，卸载 iframe、Mermaid 与 Programmable Surface 等重型运行时；恢复时使用缓存高度避免滚动跳变。
- KaTeX、Mermaid 等重型渲染依赖按首次命中公式或图表语法时动态加载。

IntersectionObserver 负责可见性和重型节点生命周期，动态消息窗口负责控制 Vue 组件与普通 Markdown DOM 数量；两者职责不可混淆。

### 3.5 ReAct 执行段折叠

`ConversationSurface` 在 Markdown 分段与 NIT 父子调用归并之后，由 `compositor/executionGroups.ts` 将连续工具、思考、重试及状态节点归为执行段。可见正文构成段落边界；审批、提问、独立附件及错误提示保持在段外。空白正文不创建边界，工具结果按调用 ID 回填原卡片，不改变展示顺序或持久化内容。

含工具调用的执行段通过 `ExecutionProcess.vue` 渲染哑光微立体折叠胶囊（`正在探索`／`走过 {0} 步足迹`），左侧叠置最多 4 枚由 `TrajectoryIcon.vue` 绘制的双调微刻精工图标，中间汇总 NIT 连携计数、代码增删统计、提醒时间、异常徽标与总耗时，右侧提供独立微凸扳机小键；主会话 `processCollapsed` 外层总胶囊启用且仅包含单一工具执行段时，内层切换为 `headless` 模式仅输出纵向导轨以避免双重折叠头。执行中默认展开，Surface 从 `open` 进入结束状态时自动收起；历史记录初次挂载默认收起。用户可逐段展开，后续结果更新不覆盖选择；NIT 子调用仍留在原有父工具内部。折叠保留已挂载卡片和内部交互状态，同时通过 `active` 暂停隐藏内容的重型运行时。

展开态通过 `trajectory-tactile.css` 的双线微刻压痕纵向主轴（`.traj-spine`）统一串联段内思考节点（`thinking` 采用 `2px` 错位叠纸碎碎念便签，`native-reasoning` 采用无框精简单行，提交后自动收起并保留单行正文预览）与异构工具节点（`ToolCallCard.vue`：NIT 编排双舱主条与虚线圆角分叉树及独立轻内凹沙箱脚本抽屉、NIT 纯沙箱演算条、代码变更 5 格内凹比例尺双舱条、定时提醒硬卡打孔小票、角色心情叙事胶囊、据点房间穿梭小键、托盘置物条、画面光圈条，以及常规高频工具的无框静默灵动行）。主轴节点统一挂载 `23×23px` 哑光微立体铭牌（`ToolArchetypeSignature.vue`），运行脉动与悬停微动严格遵循减少动态效果设置。

---

## 4. 组件规范

### 4.1 逻辑分层示例

```typescript
// composables/chat/useChat.ts (Logic 层)
export function useChat(options: UseChatOptions = {}) {
  const threadStore = useThreadStore()
  const compositorStore = useCompositorStore()
  async function sendMessage(content: string) {
    /* 通过 chatApi 与 Store 推进会话生命周期 */
  }
  return { sendMessage }
}
```

```vue
<!-- components/chat/ChatContainer.vue (View 层) -->
<script setup lang="ts">
import { useChat } from '../../composables/chat/useChat'

const { sendMessage } = useChat()
</script>
<template>
  <ConversationSurface ... />
  <InputBar @send="sendMessage" />
</template>
```

### 4.2 路由分包与主导航结构

`router/index.ts` 使用动态导入加载 `MainView`、`LauncherView`、`DetachedPanelView` 和 `Pet3DView`；`MainView.vue` 通过 `defineAsyncComponent` 和 `composables/main/tabRegistry.ts` 按需加载主界面各分区。

主界面采用 **「常驻紧凑图标轨 + 居中模态设置中心」** 两层扁平导航（`useMainNav.ts`）：

- **左侧常驻紧凑轨（`MainNav.vue`，`78px`）**：顶部常驻 `infOS` 品牌标识与 `PEROPEROCHAT` 英文副标；中部固定一级舞台入口（对话 `chat`、据点 `stronghold`、工作区 `workspace`、伙伴 `companions`、记忆馆 `memory_hub`、任务 `tasks`，Electron 桌面端另有独立的卡片 `cards`），桌面端切换页面时导航轨宽度恒定不跳变，任务与卡片均支持直接右键摘出为独立桌面面板；底部固定「设置」入口。
- **二级聚合工作台与独立功能页**：`CompanionsTab.vue`（状态总览／共享空间／伙伴设定）与 `MemoryHubTab.vue`（核心记忆／知识库／对话日志）以顶部横向标签组织子视图；`TasksTab.vue`（任务中心）与 `CardsTab.vue`（桌面卡片与收纳框预制件）各自作为独立一级页面运行。
- **居中模态设置中心（`SettingsHubModal.vue`）**：挂载于主首页工作面（`#desktop-home-panel`）内部，天然保留顶部窗口标签栏（含实时主题切换）且遮罩不叠加模糊；承载 4 大扁平分组（常规与陪伴、连接与服务、能力与安全、极客与维护）并提供关键字即时过滤，消除嵌套竖向侧边栏；弹窗独立声明浅/深色实体面板令牌，与全局壁纸半透明材质彻底解耦以保证表单可读性。`setTab(id)` 完整兼容历史 `pageId` 映射与桌面独立面板摘出重定向。

---

## 5. 3D 与动画规范 (Three.js)

- **资源管理**：所有 Texture/Geometry 必须在 `onUnmounted` 中手动 dispose。
- **画质选择**：桌宠画质档位调整渲染分辨率、阴影贴图和目标帧率；具体设置由客户端处理。
- **隐藏窗口**：桌宠隐藏时暂停画面更新，持续隐藏后回收视觉资源；重新显示时再加载。实现与使用方式见 [桌宠与 3D 造型](../packages/wiki/companion/desktop-pet.md)。

---

## 6. CSS 样式体系

### 6.1 核心原则：Tailwind-First

**Tailwind 是默认选择，scoped CSS 是例外。**

所有组件的布局、间距、颜色、字体、交互状态优先使用 Tailwind utility class 直接写在模板中。只有以下场景才使用 scoped CSS：

- 复杂动画 (`@keyframes`)
- 伪元素 (`::before`, `::after`)
- 滚动条自定义 (`::-webkit-scrollbar`)
- WebGL/Canvas 容器的特殊布局

**禁止的做法**：在 `<style scoped>` 中用自定义类名重新发明 Tailwind 已经提供的 utility（如 `display: flex`、`padding: 8px`、`color: xxx`）。

### 6.2 架构分层

```
┌─────────────────────────────────────────────────────────┐
│  Tailwind Utilities (模板 class="..." 中直接使用)        │
│  ★ 主力：布局/间距/颜色/字体/交互/响应式 全部在这里      │
└──────────────────┬──────────────────────────────────────┘
                   │ 混合使用
┌──────────────────▼──────────────────────────────────────┐
│  全局像素类 (style.css 中定义)                           │
│  pixel-border-*, pixel-btn-*, press-effect, font-pixel  │
│  ★ 像素风视觉语言，直接在模板 class 中引用               │
└──────────────────┬──────────────────────────────────────┘
                   │ 支撑
┌──────────────────▼──────────────────────────────────────┐
│  tokens.css (CSS Variables)                              │
│  颜色令牌单一真相源 → 通过 @theme 桥接到 Tailwind        │
└──────────────────┬──────────────────────────────────────┘
                   │ 仅在必要时
┌──────────────────▼──────────────────────────────────────┐
│  <style scoped> (例外场景)                               │
│  仅用于: @keyframes / 伪元素 / 滚动条 / 复杂选择器       │
└─────────────────────────────────────────────────────────┘
```

### 6.3 模板写法示例

```vue
<!-- ✅ 正确：Tailwind + 全局像素类混合 -->
<div class="flex items-center gap-3 p-4 bg-white pixel-border-sky press-effect">
  <span class="text-sm font-bold text-slate-600 font-pixel">标题</span>
</div>

<!-- ❌ 错误：用 scoped CSS 重写同样效果 -->
<div class="my-card">
  <span class="my-card-title">标题</span>
</div>
<style scoped>
.my-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
}
.my-card-title {
  font-size: 14px;
  font-weight: 700;
}
</style>
```

### 6.4 Tailwind 使用范围

#### ✅ 允许使用

| 用途   | 示例                                                                 |
| ------ | -------------------------------------------------------------------- |
| 布局   | `flex`, `grid`, `items-center`, `justify-between`                    |
| 间距   | `p-4`, `m-2`, `gap-3`, `space-y-2`                                   |
| 排版   | `text-lg`, `font-bold`, `font-pixel`, `tracking-wide`                |
| 尺寸   | `w-10`, `h-10`, `min-w-0`, `max-w-xs`                                |
| 颜色   | `bg-white`, `bg-sky-50`, `text-slate-700`, `bg-sky-face`             |
| 边框   | `border`, `border-sky-100`, `rounded-xl`                             |
| 阴影   | `shadow-md`, `shadow-sky-100/50`                                     |
| 交互   | `hover:bg-sky-50`, `group-hover:scale-105`, `active:translate-y-0.5` |
| 过渡   | `transition-all`, `duration-300`                                     |
| 响应式 | `md:grid-cols-2`, `sm:hidden`                                        |
| 条件   | `:class="[cond ? 'bg-white' : 'bg-transparent']"`                    |

#### ❌ 禁止

| 禁止行为                                       | 原因                                                 |
| ---------------------------------------------- | ---------------------------------------------------- |
| `bg-[#ff00ff]` 硬编码颜色                      | 必须通过 tokens.css → @theme 桥接                    |
| `w-[137px]` 硬编码尺寸                         | 用标准尺寸或极端情况 scoped CSS                      |
| `@apply` 在 scoped style 中大量使用            | 失去了 Tailwind 的优势                               |
| scoped CSS 重写 Tailwind utility               | 不要用 `.card { display: flex }` 代替 `class="flex"` |
| 用 Tailwind `box-shadow` 替代 `pixel-border-*` | 像素风类是项目核心视觉，不可替代                     |

### 6.5 色彩使用优先级

```
1. @theme 桥接色 (bg-sky-face, text-pink-shadow, border-sky-100)
   ↓ 通用中性色
2. Tailwind 原生色板 (bg-white, text-slate-700, bg-emerald-50)
   ↓ 极端情况需要自定义
3. tokens.css var() 在 scoped CSS 中 (仅 @keyframes / 伪元素等)
   ↓ 禁止
4. ❌ 硬编码 (bg-[#ff0000], color: #xxx)
```

### 6.6 像素风全局类 (pixel-\*)

以下定义在 `style.css` 中的类是项目核心视觉语言，**直接在模板 class 中引用**：

| 类别     | 类名                                                                                                     | 用途                      |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| 像素边框 | `pixel-border-sm`, `pixel-border-sky`, `pixel-border-pink`, `pixel-border-emerald`, `pixel-border-amber` | FC 风多层 box-shadow 边框 |
| 像素按钮 | `pixel-btn-sky`, `pixel-btn-pink`, `pixel-btn-yellow`                                                    | 完整像素风按钮样式        |
| 像素卡片 | `pixel-card`, `pixel-card-moe`                                                                           | 像素风卡片容器            |
| 像素字体 | `font-pixel`                                                                                             | Zpix/DotGothic16 像素字体 |
| 像素网格 | `pixel-grid-overlay`                                                                                     | 4px 网格纹理叠加层        |
| 交互效果 | `press-effect`, `bouncy-hover`, `pixel-hover-lift`                                                       | 按下/悬浮/抬升效果        |
| 像素动画 | `animate-pixel-bounce`, `animate-pixel-float`, `animate-pixel-shake`                                     | 像素步进动画              |

### 6.7 scoped CSS 保留场景

仅在以下场景使用 `<style scoped>`：

```vue
<style scoped>
/* ✅ 动画关键帧 */
@keyframes fade-slide { ... }
.fade-slide-enter-active { ... }

/* ✅ 伪元素 */
.indicator::before { content: ''; ... }

/* ✅ 滚动条 */
.scrollarea::-webkit-scrollbar { width: 4px; }

/* ✅ 多层嵌套选择器（Tailwind 无法表达） */
.timeline-item:last-child { border-bottom: none; }

/* ❌ 禁止：重写 Tailwind utility */
.my-box { display: flex; padding: 8px; color: red; }
</style>
```

## 7. AIOS 前端状态边界

前端是后端持久资源的视图订阅者，详细模型见 [A09_AIOS_ARCHITECTURE](./A09_AIOS_ARCHITECTURE.md)。

- `activeAgentId`、`activeThreadId` 与窗口布局属于**窗口级 UI 状态**，后端不维护全局活跃角色或会话。
- Store 缓存的 Agent、Thread、消息等展示数据以服务端 API 与事件流为准；发送聊天请求只提交 `{ threadId, content, attachmentIds? }`，不将前端消息数组作为上下文上传。
- 切换 Agent 时联动选择或创建属于该 Agent 的 Thread，保持身份一致。
- group 日志按据点 `roomId` 聚合展示；后端按 Agent 划分的 group Thread 仅服务隔离上下文，不作为用户可见的房间分组。
- SSE 流以显式 `done` 标志判定成功结束，工具事件通过 `callId` 关联。

---

## 8. Surface Protocol 与 Compositor

### 8.1 权威边界

Surface 是领域事实的语义视觉投影：后端持有业务事实、Execution 状态、Projection 与可恢复的最终 Surface Commit；客户端 Compositor 持有窗口级 Surface Tree、布局、可见性、动画、输入焦点与 Stable Block/Active Tail，Renderer 崩溃、DOM 销毁或断线后由领域事实与 Projection Snapshot 重建。

Internal Surface Protocol 供系统组件、Projection、Shell 与 Compositor 使用。第三方 Application 通过第二层 Frontend Adapter 接入 Tab、任务、会话、状态与授权 UI；远程非信任内容使用 External Presentation Protocol 或隔离 WebView/iframe 呈现（不向主 Renderer 注入 Vue 组件、HTML、脚本或 DOM Patch）。Frontend Adapter 仅通过类型化 IPC 访问自身 Backend Adapter，不直接持有远程凭据、Kernel Service 或任意本地端口权限。

### 8.2 语义节点与操作

当前节点类型包括 `markdown`、`thinking`、`native-reasoning`、`model-retry`、`code`、`math`、`mermaid`、`tool-call`、`tool-result`、`status`、`error`、`attachment`、`approval`、`progress`、`input`、`panel`、`table`、`notification`、`document` 和 `programmable-island`（均带有 `nodeId`、`revision` 与生命周期标记，完整定义见 `packages/shared/src/types/surface.types.ts`）。

协议操作固定为：

```text
surface.open / surface.append-text / surface.append-tool-arguments
surface.upsert-node / surface.patch-node / surface.commit / surface.fail / surface.dispose
```

实时帧携带协议版本、Surface 身份、`generation`、`revision`、`sequence`（同一代次内递增）、`operationId` 与操作载荷。聊天区 HTML 保持源码展示，可执行内容仅在独立沙箱 Surface 运行；流式帧仅做帧合并，不人为拆词减速，也不落入持久日志。

### 8.3 Compositor 与核心交互规则

- **Surface 树与生命周期**：Compositor 管理 Surface Tree、Revision 与稳定 Node ID，路由键鼠与无障碍输入，按可见性冻结动画、Canvas、视频与重型组件；流式渲染分离稳定区（已完成复杂子树保持稳定身份，Mermaid/KaTeX/代码/工具卡各自持有独立生命周期）与活动尾部，非当前视图继续推进 Projection 但暂停无效 DOM 更新。
- **富文本与公式缓存**（`chatRichRenderer`）：同步返回 HTML 使用 `renderChatRichText`，管理缓存使用返回 `{html, mathReady}` 的 `renderChatRichTextResult`，`prepareChatRichText` 按需加载公式依赖（`peromath` 围栏与渲染共用 Marked 词法与语言归一化规则）。窗口内存驻留含资源卡、隔离预览分段与已净化 HTML 的渲染快照（源码、预览模式与语言未变时复用分段对象及 DOM）；未就绪公式降级结果不入底层 HTML 缓存、组件驻留快照或共享缓存，待依赖就绪事件到达后对可见视图重渲染（离屏等恢复可见再渲染，预览销毁或替换时清理订阅）。缓存只存当前窗口内存。
- **全局审批兜底**：`useApprovalStore` 前台每 `4` 秒拉取全局 pending 列表，窗口隐藏或被应用标签遮盖时降为每 `60` 秒补齐，恢复可见立即刷新（弥补 Gateway 仅向当前角色输入席位推送的局限）；等价结果复用原 Map 引用避免冗余更新，停止轮询时清理定时器。
- **游标分页与预算**：Conversation Projection 按游标返回请求窗口与 `hasMoreBefore / beforeCursor`，追加历史时按 `messageId + revision` 复用对象，工具结果按 `callId` 建立索引（不在模板渲染阶段线性扫描 Surface Node）。输入栏 Token 计数在 ReAct 期间读取当前 Thread 与 Principal 的活动 Surface 逐轮更新（区分请求估算与上游实测，与累计 Token 消费分列）并暂停草稿预算请求，切换角色或 Thread 清空旧预览；草稿预算预览不触发远程记忆检索并标注「不含待检索记忆」。模型配置页重拉模型列表先清空旧候选，接口失败展示后端真实错误，返回空列表时提示手动输入模型名。
- **附件上传与录音入口**：输入栏单个「文件」选择入口、拖拽文件与粘贴文件复用同一流式处理——立即生成本地 `0ms` 缩略占位，最多 `3` 路并发异步校验能力、建会话并上传原件（上传完成前锁定发送按钮直至获取 `attachmentId`）；单文件上限 `100 MiB`，适格图片与小文本分别走原生识图、转述或上下文装配，超大文本、非 UTF-8、未知格式或模型不支持的图像保留原件引用（Agent 仅获得服务端存储路径与引用，目录拖入提示先压缩，嵌套输入栏防重传，切换会话撤销未完成上传批次）。录音按钮按会话设置所选模式（转写／原音）并在开始前复核真实能力。
- **会话设置面板与滑块**（`SessionSettingsPanel.vue`、`SessionModelControls.vue`、`SessionSlider.vue`、`SessionSegment.vue`）：
  - 输入栏页脚左侧入口复用 `InputBarFoldout`（`variant="text"`，自定义 `trigger` 与 `head-actions` 插槽，点击外部/Escape/外部滚动/切 Thread 关闭、窗口缩放重定位、`no-drag` 标记）展示模式图标、当前模式与模型名称；`SessionModelControls.vue` 读写模型与思考设置，`InputBar.vue` 保存模式、执行权限与识图／语音，采用**乐观先行 + Last-Write-Wins**，后台持久化不阻塞连续切换与发送，失败回滚至最近权威值。
  - `SessionSlider.vue` 由同一组档位名称生成等宽标签与刻度，原生透明 `input[type=range]` 对齐可见刻度（`input` 预览、`change` 与点按节点直接提交，失焦/切换 Thread 清理预览，思考首档为「跟随」）。
  - 思考档位按钮按模型支持顺序循环切换；`SessionSegment.vue` 用 `transform` 移动等宽选中条并支持 `radiogroup` 键盘导航、网格等高说明与 `grid-template-rows` 折叠过渡；执行权限提升至 `auto_approve` 或 `full` 时先进入虚线手柄待确认状态，经用户确认后再保存。
- **输入栏工具轨与 Skills**（`InputBar.vue`、`input-toolbar.css`、`ThreadSkillControls.vue`、`ThreadExperiences.vue`）：
  - 入口统一使用 `input-tool-trigger` 机械分仓键帽样式；左侧会话设置、Skills 与会话工具采用「色块徽标仓 + 标签计数」双仓键帽，末尾为指令与添加文件；右侧承载角色主会话「生活经历」（`ThreadExperiences.vue`，展开右侧抽屉时自动收起输入栏弹层）、会话心流与像素切角晶环上下文容量指示器（默认展示顺时针占用晶环与百分比，悬停/聚焦显示精确现用／上限 Token 与轮次），紧接语音与发送主键帽；仅据点群聊在输入框上方保留房间与成员状态条。紧凑布局收敛为等宽图标键帽，移动布局扩大触控热区。
  - 会话工具弹窗按「已启用系统协议项 → 普通启用项 → 关闭项（含模式未开放项）」分组，组内按 `packageId` 聚合同包工具并按函数名排序，开关变化即时重排且搜索保持排序顺序。
  - `ThreadSkillControls.vue` 提供本会话 Skills 勾选、搜索与一键全关，保存期间锁定发送与冲突配置操作，极简模式暂停生效但保留选择（契约见 [M02](./M02_CAPABILITY_GATE.md#32-会话-skills)）。
- **Diff 预览与正文排版**：文件写入与编辑折叠栏与展开视图共用一次预览计算，参数流按 `75ms` 合并更新并在结束时对齐真实执行统计（支持读取引用、行范围与批量步骤；旧文不可用时删除数标为待确认）；折叠释放 Diff 轨道、后台暂停解析、长文件保持窗口化渲染。Markdown 正文行距 `1.9`（段落/标题/引用/列表各自留白，流式分块间保留同节奏且空块不占位），工具轨迹与原生思考宽度为正文的 `96%`（窄屏铺满）。

### 8.4 性能与 UX 不变量

Surface 协议处理保持 `generation`、帧序号 `sequence` 与提交状态一致；工具与审批节点恢复沿用稳定身份。缺少 `commit / done` 结束标记的流标记为截断并保留恢复所需的原始记录。

### 8.5 工作区焦点与材料展示

工作区 Tab 等待真实 Thread 就绪后创建文件树与终端会话；切换 Agent 或 Thread 时清除终端引用与显式选区并保护未保存编辑器缓冲。「本轮材料」展示下一次请求将附带的文件、选区与终端；近期工具结果由统一上下文预算自动管理，不另设手动材料入口，具体裁剪与采用情况可在 Context Manifest 查看。

---

## 9. Electron 应用标签宿主

Electron 主窗口顶部使用 `DesktopTabBar`，固定首页承载原综合面板，`DesktopNewTab` 提供网址搜索、应用与工作区快捷入口；浏览器与独立 Web 子应用由主进程 `DesktopTabManager` 基于 `WebContentsView` 托管，前端通过 `useDesktopTabs` 投影带 Revision 的标签快照：

- 主进程持有标签、原生视图、可见性与关闭流程，前端持有新标签页输入与布局测量（浏览器部署保持原综合面板，不引入前端 Electron 依赖）。
- 切换标签保留页面，关闭标签释放 `webContents` 而不终止 Arca Host 等后台任务；用户浏览器标签独立于 Agent 临时页面空闲回收，各自维护活动目标。
- 外壳负责主题、更新中心与系统窗口控制（嵌入模式下隐藏子应用内重复窗口控制）；Arca 使用受限 preload 上报草稿状态以保护关闭流程，外部网页不挂载系统 preload；全局对话框可见时隐藏原生子视图，关闭后按最新布局尺寸恢复。
- 对话容器通过 `BrowserObserver.vue` 呈现 Agent 浏览器只读旁观小窗（位置与尺寸由前端维护，仅调用发现与取帧接口，收起或不可见时停止取帧，规则见 [A04](./A04_DEPLOYMENT.md#只读旁观画面)）。
- 侧栏移除独立应用分组；社交配置并入系统设置；Arca 的运行、连接与诊断由其自身「设置 → 连接与运行」承载（Electron 从新标签页进入，浏览器从状态栏应用入口进入，Host 离线仍可进入连接设置）。

---

## 10. 桌宠 HUD 与主应用对话

`Pet3DView` 是角色的轻量交互面（不承载完整历史，已移除旧统一大气泡路径）：空闲仅留菜单入口，悬停展示「对话 / 语音 / 互动 / 更多」，触碰反应、语音状态、字幕与待办分别独立展示；完整正文保存在主应用同一 Thread，通过 `agentId / threadId / messageId` 定位。

语音设置由 Electron 主进程持有，Windows 全局 PTT 支持鼠标侧键与按下／松开状态，麦克风预先准备并具备关闭、取消与延迟授权边界；TTS 仅读取独立 `spokenReply` 通道，缺少口语答复时不回退朗读正文。

---

## 11. 个人与外观、桌面感知及权限设置

### 11.1 个人与外观整页草稿

- **页面分工**：`UserSettingsTab`（「个人与外观」）管理用户信息、语言、外观、健全模式、壁纸与感官动效统一草稿；助手回复预填充与动态填充深度拆分至 `PromptManagementTab` 的「回复策略」（`PromptReplyStrategyPanel.vue`）。开关与选项立即提交，文本改动进入草稿由保存按钮整页提交（移除旧可选自动保存开关）。
- **统一提交队列**（`useSystemSettingsPage`）：按页面作用域收集快照，每次点击固定当前值——KV 配置批量写入，背景、天气与设备操作按同一队列顺序执行以防乱序；背景材质滑块于调整结束时保存，天气文本参与保存，头像在确认裁切后上传。未成功读取的配置不以默认值回填覆盖；部分失败保留草稿供重试，后续保存仅继续尚未完成的设备/资源步骤而不重复执行已成功部分（刷新不丢失未保存文本草稿）。

### 11.2 桌面感知、权限与独立面板

- **三处拆分**：主窗口将原桌面与家拆分为共享空间（归入 `CompanionsTab.vue`）、桌宠快捷键与感知（设置中心 `DesktopPerceptionSettingsTab.vue`，`perception_pet`）与桌面权限安全（`DesktopSecuritySettingsTab.vue`，`desktop_security`）；状态栏感知卡片支持就地启停并由 `MainView` 直达对应设置页（独立面板摘出时经 `revealPerceptionSettings()` 定位）。
- **独立面板同步**：`DesktopHomeSettings.vue` 注册为 `desktop_home` 承接 Electron 摘出面板窗口（`#/panel/desktop_home`），各子分区通过 `v-if` 按需挂载，角色与 Thread 选择器由共享空间与授权记录共用；`usePerception` 在订阅期间通过同源 `BroadcastChannel` 传递跳转请求，最后一个订阅者卸载时关闭通道。桌面操作总开关与停止快捷键走 `DesktopControlSettings` 即时保存，原生设备设置走 IPC，后端文件保护提供保存与重置；浏览器端只呈现共享空间、授权记录与文件保护（详细契约见 [B02](./B02_DESKTOP_AUTOMATION.md)）。

---

## 12. 内容区宽度与紧凑工作台

- **容器断点**：主应用 `.main-content` 为 `app-content` 内联尺寸容器，角色管理、已安装扩展与备份页的布局断点（集中于 `assets/responsive-pages.css`）均依据此容器宽度计算；角色图鉴在窄内容区将列表切换为横向条目、档案置于下方工作区并保留抽屉入口。
- **角色卡工具行**（`AgentCardTransfer.vue`）：左栏标题、数量与刷新合为一行；导入按钮、PNG/ZIP 导出按钮组、数量角标、刷新与新增按钮采用显式直角边框（共用拖放与批量导入预览，有未保存修改时禁用导入导出并给出提示行）。窄内容区将工具行移至横向列表上方、隐藏常驻拖放说明并将完整动作名保留在 `title` 与无障碍标签中。
- **工作区局部紧凑模式**（`useWorkspaceLayout`）：通过 `ResizeObserver` 监听工作区自身可用宽度，`≤ 1000px` 时进入局部紧凑模式并初次收起两侧栏，展开资源或协作栏时互斥呈现并提供遮罩与 Escape 关闭；该模式不修改 Electron 全局移动布局标记，宽窗口继续保留三栏与拖拽调宽。
- **启动器状态检测**（`composables/launcher/launcherChecks.ts`）：未配置模型显示警告并允许进入应用；模型列表读取失败展示检查未完成状态（不混作未配置，卡片不暴露原始错误正文）。
