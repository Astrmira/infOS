# Package 与用户空间贡献系统

> **适用范围**：`packages/backend/src/packages/`、`packages/shared/src/types/package.types.ts`
> **状态**：内置贡献与显式授权的用户插件共存；安装、授权与激活相互独立
> **最后更新**：2026-10-28

---

## 1. 定位与安装根

`Package` 是 infOS 的安装、签名、版本、升级与分发单元，本身不是运行时实例或权限主体（早期 Extension Loader、ExtensionManager、ServiceRunner 与 HookRegistry 已全面移除）。

```text
Package Manifest
→ Package Installer
→ Package Registry
→ Package Runtime
→ Contribution Activator
→ Lifecycle Scope
→ Runtime Object / Capability Offer / Tool ABI / Resource
```

安装、激活与授权三者解耦：发现、安装或加载任何 Contribution 均不产生隐式授权。用户 Package 的统一物理安装根为 `@data/packages`（仅允许在安装边界对旧 `@data/extensions` 执行一次性原子目录迁移）。

---

## 2. Manifest V2 与当前开放范围

公共静态 ABI 定义在 `packages/shared/src/types/package.types.ts`：

```typescript
interface PackageManifest {
  manifestVersion: 2
  packageId: string
  name: string
  version: string
  trust: 'official' | 'signed' | 'user' | 'generated'
  contributions: PackageContribution[]
  requires?: PackageCapabilityRequirement[]
  permissions?: PackagePermission[]
  platforms?: PlatformId[]
}
```

Manifest 只描述静态意图，不存储运行实例、连接、Handle、进程或健康状态。`PackageContributionKind` 联合类型包含：

```text
application / service / capability-provider / runtime-adapter / tool / skill
policy / event-subscriber / presenter / web-ui / asset / context-provider / agent-flow
```

注：数据库 Schema 与迁移由所属领域内部维护，`PackageContributionKind` 中不提供 `schema` 或 `migration` 类型。

### 2.1 当前生产开放与托管策略

用户通过「工具与扩展 → 插件」上传 ZIP 安装至数据目录，安装阶段仅解析校验，不加载模块或安装依赖：

1. **来源可信度**：用户上传包限定 `trust: user | generated`（仅内建来源为 `official`，`signed` 须通过 Publisher 与文件签名校验）。
2. **授权与重载复审**：用户确认版本、内容摘要与申请权限后，执行型贡献方可获得 `runtime:execute` Grant；更新、回退或本地修改均需重新审核，启用状态跨进程重启保留。
3. **当前开放的 Kind**：生产插件入口已开放 `tool`、`skill`、`event-subscriber`、`service`、`capability-provider`、`context-provider`、`agent-flow`、`presenter`、`web-ui`、`asset`。
4. **受控系统级 Kind**：`runtime-adapter`、`application`、`policy` 仅限内置受控入口接入，用户上传包声明上述类型将在激活阶段失败。
5. **代码信任边界**：`runtime:execute` 代表对本机 Node 代码的显式信任授权而非 OS 进程沙箱；Node 插件持有服务端进程的系统权限，Agent 工具调用仍需经过 CapabilityGate、Realm、执行模式与审批。`PackageProcessSupervisor` 管理 `service` 子进程用于生命周期隔离而非系统级沙盒，缺少 Capability Binding 的 Requirement 不构成授权。

---

## 3. 安装边界与运行时原子激活

### 3.1 `PackageInstaller` 职责

- 发现 `manifest.json` 并校验 Manifest V2 结构；
- 拒绝越出 Package Root 的路径 Entry；
- 将历史清单输入一次性投影为 Manifest V2（`历史 manifest.json → LegacyPackageManifestInput → legacyPackageManifestToPackage() → PackageManifest V2 → Registry`；兼容投影仅留于安装边界做结构升级）；
- 将历史 `@data/extensions` 原子迁移至 `@data/packages`；
- 将已验证清单登记入 `PackageRegistry`。

### 3.2 `PackageRuntime` 原子激活约束

```text
installed → activating → active → deactivating → installed
```

1. 激活前必须解析通过所有 `required = true` 的 Capability Requirement；
2. 每个 Activator 必须返回释放函数或向 `LifecycleScope` 注册资源清理；
3. 任一 Contribution 激活失败时，已激活项必须按逆序完整回滚；
4. 停用时须完全回收 Tool、Skill 目录、Event Subscriber、Provider Offer、子进程及其他句柄；
5. Package 内部隔离运行，不持有全局 `AppContext` 或直接访问其他 Package 实例。

---

## 4. Contribution 语义与跨包协作

### 4.1 贡献种类语义

- **Tool ABI**：Tool 为面向模型的调用契约而非跨包通信协议；Tool Handler 仅调用 Bound Port，不直接持有 Provider 实例（`LLM Tool Call → ToolExecutor → CapabilityGate / Policy / Approval → Bound Port → Kernel Envelope → Provider`）。
- **Skill Resource**：Skill 为按会话勾选的流程知识与 Context Resource（`SKILL.md → SkillLoader → Context Resource → Requirement → 现有 Handle/Policy 权限交集`），勾选后将正文装配入上下文；`requiredTools` 仅作 Capability Requirement 投影，不单独解锁工具权限（详见 [会话 Skills](M02_CAPABILITY_GATE.md#32-会话-skills)）。
- **Service Process**：通过 `PackageProcessSupervisor` 托管与 `PackageProcessTransport`（默认逐行 JSON-RPC stdio）通信；服务能力须经由 Capability Offer 对外提供，不开放 `serviceId + method` 任意调用。
- **Event Subscriber 与 Interceptor**：观察逻辑使用 Durable / Ephemeral Event Subscriber，串行转换或中止入口使用 `PackageInterceptor`（已废弃全局万能 Hook 管道）。
- **Capability Provider / Runtime Adapter**：Provider 声明操作能力，Adapter 将外部运行时投影为 Kernel Object、Snapshot、Stable Handle 与 Verification；Consumer 权限独立核验。
- **Presenter**：将业务事实或 Snapshot 投影为声明式 Surface Node，不持有前端组件实例且不向 SSE 写入二进制正文。

### 4.2 跨 Package 协作与权限交集

跨 Package 交互唯一标准链路：`Capability Definition → Provider Offer / Consumer Requirement → Capability Directory → Policy Binding → Capability Handle → Bound Port → Kernel Envelope → Provider`。

实际有效权限始终取下列集合的交集（`Provider` 不代替 `Consumer` 扩权）：

```text
Consumer Handle ∩ Provider Offer ∩ Provider 运行权限 ∩ 当前 Policy ∩ 资源 Scope ∩ Deadline / Generation
```

设计边界禁止：直接 `import` 其他 Package 实现、共享 `AppContext / Repository / 数据库连接`、以 Tool 名称做包间 RPC、使用全局 Service Locator 或将 `Capability Handle` 注入 Prompt/日志。

### 4.3 权限层级与临时授权

| 层次 | 含义 |
| --- | --- |
| `Package Permission` | 安装声明的静态权限意图 |
| `Capability Requirement` | 运行时所需的抽象能力声明 |
| `Capability Handle` | 实际获得的受限调用句柄 |
| `Policy / Approval` | 当前执行现场的实时策略与审批裁决 |

审批产生的临时授权绑定 Principal、Execution、资源与操作，并支持撤销、到期与进一步收窄。

---

## 5. 资源原语与统一 Application 模型

### 5.1 资源原语与扩展顺序

通用资源原语（服务于 Browser、Social 附件、Cloud Sync、模型资源、MCP 与 Document Runtime；随需求渐进开放对应产品能力）包括：`Asset / File Handle`、`Transfer Object`、`Runtime Event Subscription`、`Scoped Credential`。扩展实现必须按固定次序推进：**Kernel Object 与 Execution 身份 → Envelope 与 Capability Handle/Bound Port → Runtime Adapter、Web/Document Runtime 与更强隔离**。

### 5.2 统一 Application 与三层第三方接入

- **单一 Application 模型**：所有内置与第三方应用统一为具备稳定 `Application Identity`、独立 Host 逻辑、按需独立 Store/Authority、故障边界及可选 Capability / Client / Tool ABI / SubAgent 的自治实体；`Tool`、`Service`、`Client`、`Runtime Adapter`、`SubAgent` 为应用内部构件。Application 不直接读取 Kernel 数据库或主 Agent Thread，而是通过联邦协议发布 Offer、声明 Requirement 并接收收窄 Handle；处于 `disconnected_from_kernel` 时本地受限运行并暂停依赖 Kernel 凭据、远程 Node 或主 Agent 资源的操作。
- **三层第三方 Adapter**：不把外部开源应用作为同进程插件直接加载，而是解耦为：（1）infOS 官方通用 Integration Foundation；（2）infOS 侧 Backend / Frontend Adapter（使用 Bound Port 并仅将获准 Operation 投影为 Tool）；（3）目标应用内部 Plugin / Extension / MCP Server / Sidecar（第二、三层迭代不要求修改 Kernel 服务，详情见 [A10](./A10_APPLICATION_INTEGRATION.md)）。
- **异步长任务移交（`submitTask`）**：耗时任务由目标 Application 持久化接收后立即返回 `taskId`，随后在独立 Application Principal、Kernel Execution 与 Abort 域内异步执行（调用 Tool 的 `AbortSignal` 仅覆盖提交阶段，主 Agent 取消不隐式取消外部 Task；长任务不应以同步 Tool Promise、复用主 `parentExecutionId` 或绑定 Agent Scope 销毁的方式实现）。

### 5.3 激活与释放核心不变量

- 校验并拒绝 Manifest 重复 ID、无效 Entry 与越界路径；
- 缺失必需 Capability 时拒绝激活，激活失败执行逆序回滚；
- 停用时全面释放 Tool、Provider、Skill、Event 与 Subprocess；
- Consumer 仅持 Bound Port；目录与云同步统一落入 `packages/`（不再引入旧 `extensions` Loader/Runner 路径）。

---

## 6. 用户插件管理、扩展列表与设置面板

### 6.1 发行目录与安装包规则

```text
@data/packages/.managed/index.json              安装记录、启用状态与审核摘要
@data/packages/.managed/releases/<UUID>/        独立版本代码、锁文件与 node_modules
@data/package-cache/                            pnpm 下载缓存
@data/package-data/<packageId 的 SHA-256 前缀>/ 插件持久数据（重载/更新保留）
```

- Electron 标准版、便携版与 Docker 均通过 `PathResolver` 映射数据目录（不写入 ASAR 或源码包），上传接口直接接收字节流；插件数据写入工厂参数 `host.dataDirectory`。
- **ZIP 包限制**：根目录或唯一顶层目录须含 `manifest.json`；支持已编译 ESM（`.mjs` / `type: module` `.js`，不在服务端编译 TypeScript）；拒绝路径逃逸、Windows 保留名、预装 `node_modules` 及包管理器配置注入，限制压缩包与展开大小及文件数（安装包 `≤ 20 MiB` ZIP / `≤ 64 MiB` 解包）。
- **依赖安装**：依据包内 `package.json` 的 `dependencies / optionalDependencies` 声明（支持精确及 `^` / `~` 范围，拒绝 `file:`、`workspace:`、`git` 与 URL 依赖），启用时由随发行版自带的 `pnpm` 默认拉取 npm 官方源并使用 `--ignore-scripts`（不执行任意安装期生命周期脚本，原生依赖需自带适配产物）。
- **更新与重载隔离**：更新导入后自动停用并留存上一版本待复审启用；回退同样停用待审；重载复制到新代际目录以完整刷新入口和所有相对 `import`（读取本地修改同建新代际并撤销旧授权）。独立运行数据目录不参与源码摘要校验。

| 操作 | 接口 |
| --- | --- |
| 列表 / 上传安装 | `GET /api/packages` / `POST /api/packages/install` |
| 内容授权 | `POST /api/packages/:id/authorize`（`digest`、`permissions`） |
| 启停控制 | `PUT /api/packages/:id/enabled` |
| 重载 / 审阅本地改 / 回退 | `POST /api/packages/:id/reload|review|rollback` |
| 卸载代码 | `DELETE /api/packages/:id`（保留运行数据目录） |
| 面板插槽与动作 | `GET /api/packages/panels/:slot` / `POST /api/packages/panel-actions` |
| 静态资源访问 | `GET /api/packages/assets/:encodedPackageId/contributionId?file=相对路径` |

### 6.2 「已安装」拓展 Tab 统一投影（`services/integrations/extensionInventory.ts`）

`GET /api/integrations/installed` 汇总插件、Skill、角色包、桌宠模型、MCP 与集成功能（只做数据投影，不另存安装状态或读取客户端文件系统）：

| 分类 | 权威来源 | 管理入口 |
| --- | --- | --- |
| 插件与内置扩展 | `PackageRegistry`、`PackageManagementService`、`IntegrationService` | 对应插件或集成配置卡片 |
| Skill | `SkillLoader`、`ToolRegistry` | 独立技能进入技能页；包内技能进入所属插件卡片 |
| 角色包 | `AgentManager` | 角色档案页；包内归属插件卡片 |
| 桌宠模型 | `AssetRegistry` | 仅展示元数据索引（扫描 `@data/models`、`INFOS_RESOURCES_ROOT/assets/3d` 或 `public/assets/3d`；与客户端无关） |
| MCP | MCP 配置与实时连接状态 | 对应 MCP 服务管理面板 |
| 联网搜索、PDF 解析 | `IntegrationService` | 对应集成设置入口 |

- **筛选与脱敏**：按真实登记根路径判定插件归属与来源（不依赖自报声明），仅展示已声明版本与环境要求（缺省版本不自动填 `1.0.0`），基于已加载集合判定 Skill 依赖；角色列表不返提示词/私密设置/社交绑定，MCP 列表不返启动命令/环境变量/凭据。
- **独立失败降级**：各分类独立读取，单项异常时标为 `unavailable` 供前端显式报错而不致其余分类不可用或误显为空列表；普通进页读已登记状态，用户刷新调用 `POST /api/assets/rescan`（保留筛选条件，不查询市场更新）。

### 6.3 插件设置与本机页面

`presenter.panel.settings.kind` 支持 `tool-groups` 与 `local-page`（注册到 `integrations` 并在插件卡片呈现「工具管理」或「打开页面」入口）。`POST /api/packages/panel-actions` 接收 `{panelId, actionId, payload?}`（上限 `1 MiB`、限时 `10` 秒、异步回调前复核激活身份，重载/停用中旧响应返回失效）：

| 入口类型 | 动作 | 协议约定 |
| --- | --- | --- |
| `tool-groups` | `settings.load` | 返回完整 `PackageToolSettingsSnapshot`（字段、工具描述与参数、分组、禁用清单、可选提示、新工具列表） |
| `tool-groups` | `settings.save` | 接收 `revision`、`values`、`groups`（`pinned / ondemand / off`）、`ungroupedState`、`disabledTools`，返回新快照；`revision` 冲突抛 `PACKAGE_SETTINGS_CONFLICT`（HTTP 409 / `CONFLICT`） |
| `tool-groups` | `settings.check` | 接收 `field`、`value`，返回 `{ ok: boolean }` |
| `local-page` | `page.url` | 返回 `{ url }`，仅校验通过 `localhost / 127.0.0.1 / [::1]` 无凭据 HTTP(S) 回环地址（否则返回 `PACKAGE_PAGE_INVALID`） |

宿主同时校验快照结构、工具/分组 ID 唯一性（暂不可用旧工具保留原分组引用）。桌面版通过现有窗口打开本机页面，浏览器版在点击时预留标签页（请求失败关闭空白页）。前端入口：`PackageCardExtraActions.vue`、`PackageToolSettingsDialog.vue`、`composables/packages/usePackageExtraPanels.ts`；后端入口：`packages/packageUiRegistry.ts`、`packageSettingsEntry.ts`、`routers/packages.router.ts`；i18n 命名空间为 `ui.package-tool-settings` 与 `server.packages`。

---

## 7. 贡献开发示例与钩子契约

最小工具包清单示例：

```json
{
  "manifestVersion": 2,
  "packageId": "example.hello",
  "name": "示例工具",
  "version": "1.0.0",
  "trust": "user",
  "permissions": [],
  "contributions": [{ "id": "hello", "kind": "tool", "entry": "hello.mjs" }]
}
```

模块可导出静态对象或 `createContribution(host)` 工厂（工厂仅获取受控公共作用域，通过 `host.onDispose` 回收监听器/定时器/连接并通过 `signal` 响应停用；多贡献共享模块时各自拥有独立工厂上下文）：

```js
export function createContribution(host) {
  const controller = new AbortController()
  host.onDispose(() => controller.abort())
  return {
    definition: {
      name: 'example_hello',
      description: '返回一句问候',
      parameters: { type: 'object', properties: {} }
    },
    async execute(args, toolContext) {
      return '你好'
    }
  }
}
```

| Kind | 模块契约与挂载位置 |
| --- | --- |
| `tool` | `definition`、`execute(args, toolContext)`；接入工具注册表与权限链（重名拒绝覆盖） |
| `skill` | `entry` 指向技能目录；装卸知识正文而不授予工具权 |
| `event-subscriber` | `hooks` 或 `onEvent`，接入 `PackageHookBus / KernelEventBus` |
| `agent-flow` | `hooks`；响应 Agent 运行、模型请求与工具调用前后事件 |
| `context-provider` | `provide(request)` 返回资料区块，宿主归一化为 `package:<packageId>/<contributionId>` 并作为本轮动态 user 资料入模 |
| `presenter` | `panel` 及可选 `onAction(actionId)`；声明式卡片与操作 |
| `web-ui` | `webUi` 声明静态页，可选 `entry` 导出 `actions` 供页面 SDK 调用 |
| `asset` | `entry` 指向资源目录，仅激活期间开放白名单 MIME 读取 |
| `capability-provider` | `definition`、`offer`、`invoke`；接入 `CapabilityDirectory` |
| `service` | `entry` 由 `PackageProcessSupervisor` 启停与回收 |

- **流程钩子实发点**：`agent:beforeRun`、`agent:afterRun`、`agent:beforeRequest`、`agent:afterRequest`、`chat:beforeSend`、`chat:afterReply`、`chat:beforeToolCall`、`chat:afterToolCall`。请求前钩子限修改普通消息正文（超预算时回退原请求），工具参数调整发生在权限校验与审批之前；`context.abort()` 仅终止当前钩子链传播，不影响外层 Execution 取消契约（异步钩子带超时与隔离，纯同步代码可靠性依赖 `runtime:execute` 授权）。
- **`context-provider` 约束**：每次至多返回 `20` 项，单条 `content` 至多 `32,000` JS 字符、`priority` 上限 `50`、可带 `validUntil`，调用限时 `3` 秒（异常/超时返回空）；由 Selector 重新计费、过期过滤、去重与预算控制，仅入选的 `package:` conversation 正文进入请求（原生框架置于 `turn_context`，酒馆插入当前输入之前，详见 [A09 §8.1](./A09_AIOS_ARCHITECTURE.md#81-contextregion)；Social 使用独立编译器不读取此 Registry）。
- **记忆观察点与声明式 UI**：支持 `memory:beforeCreate`、`memory:afterCreate`、`memory:beforeDelete`、`memory:afterRetrieve`（`agent:onSwitch / agent:onMoodChange` 仅留类型兼容）。声明式 UI 固定挂载于 `dashboard.overview`、`chat.header`、`chat.footer`、`integrations`（基于 `PCard / PButton` 渲染，停用后即时撤销动作并同步撤下视图）。

---

## 8. 完整 WebUI 贡献与页面 SDK

### 8.1 清单声明与前端构架

单包可同时提供多个工具、面板与完整 WebUI（在插件卡片打开，激活态可用，加载于拓展 Tab 内部而不侵入全局导航；静态文件与模块均来自当前已连接后端，适配本机 Electron、远程 Electron 与 Docker/Web）：

```json
{
  "manifestVersion": 2,
  "packageId": "example.preferences",
  "name": "偏好示例",
  "version": "1.0.0",
  "trust": "user",
  "contributions": [
    {
      "id": "preferences",
      "kind": "web-ui",
      "entry": "preferences.mjs",
      "webUi": {
        "root": "web",
        "index": "index.html",
        "title": "偏好设置",
        "actions": ["load", "save"]
      }
    }
  ]
}
```

- 静态资源 `webUi.root` 下入口 `index` 默认 `index.html`（UTF-8 并包含显式 `<head>`），支持预先构建的 Vue/React 静态产物（配置相对资源路径如 Vite `base: './'` 与 Hash 路由）；纯静态页可省略 `entry` 与 `actions`，含服务端入口则复用 `runtime:execute` 授权。

### 8.2 后端动作与 `window.infosPlugin` SDK

后端模块导出 `actions` 或 `createContribution(host)`，仅响应清单声明的动作；持久数据通过 `host.dataDirectory` 管理：

```js
export function createContribution(host) {
  let draft = { text: '' }
  return {
    actions: {
      load() { return draft },
      async save(input, context) {
        context.signal.throwIfAborted()
        if (typeof input?.text !== 'string' || input.text.length > 1000)
          throw new Error('输入内容无效')
        context.report({ stage: 'saving' })
        draft = { text: input.text }
        // 持久数据应写入 host.dataDirectory
        return draft
      }
    }
  }
}
```

宿主在入口 HTML `<head>` 头部注入 `window.infosPlugin`（类型 `PackageWebUiClient`）：

```js
const unsubscribe = infosPlugin.onContext(({ theme, locale }) => {
  // theme 为 light / dark；页面依据 locale 翻译界面文本
})
const controller = new AbortController()
const result = await infosPlugin.call('save', { text: '你好' }, {
  signal: controller.signal,
  onProgress(value) { /* 更新界面进度 */ }
})
unsubscribe()
```

- `call` 通过宿主鉴权发送一次 POST 并通过 SSE 接收进度与终态结果（断流不自动重放写动作，动作持有备份写入计数至结束防止与快照错位）。`context.clientId` 来自已验证客户端，`context.signal` 绑定页面关闭、身份撤销、停用与超时。服务端保留完整异常诊断，界面收到本地化信息；SDK 本地协议异常以 `PACKAGE_WEB_UI_*` 抛出。

### 8.3 会话 API、沙箱隔离与限额

| 接口 | 职责 |
| --- | --- |
| `POST /api/packages/web-ui/open` | 以当前客户端身份打开指定 `packageId` 与 `contributionId` |
| `GET /api/packages/web-ui/sessions/:id` | 核对身份与激活实例并续期宿主心跳 |
| `DELETE /api/packages/web-ui/sessions/:id` | 关闭页面会话并取消在途动作 |
| `POST /api/packages/web-ui/sessions/:id/call` | 触发清单声明动作并通过 SSE 流式返回 |
| `GET /api/packages/web-ui/files/:ticket/*` | 按只读票据返回静态文件（不接受业务请求） |

- **沙箱与 CSP**：iframe 严格配置 `sandbox="allow-scripts"`（无同源权、Electron API 或宿主凭据），消息经窗口来源、`opaque origin` 与随机通道三重校验；静态票据按激活摘要与真实路径双校验（返回正确模块 JS/CSS MIME 与 CORS 头，不改写静态 JSON）。CSP 允许脚本/样式/图片/字体及读取当前票据资源，禁止直接访问宿主业务 API、任意外网、子框架、表单提交与 Worker。资源票据与业务会话分离（业务调用核验会话创建者身份与凭据；打开页面不自动赋予角色身份与 Agent 权）。
- **并发与资源配额**：单页同时至多 `8` 个在途动作，单动作限时 `60` 秒，输入与输出上限 `256 KiB`，单次最多 `128` 条进度事件（每条 `≤ 8 KiB`）；静态单文件上限 `16 MiB`；页面会话无心跳 `5` 分钟超时（前端每 `15` 秒确认），停用/重载/更新/回退/卸载/撤销立即销毁旧会话与在途请求（后端重启需重新打开）。
- **反向代理要求**：Docker Nginx `/api/` 须配 `^~` 前缀路由防止静态正则截获票据文件，其他反向代理需透传外部 `Host`、不缓存票据响应并完整透传 `/api/packages/web-ui/` 资源与 SSE 流。
- **源码入口与参考**：后端 `packages/packageWebUi.ts`、`packageWebUiBootstrap.ts`、`routers/packageWebUi.router.ts`；前端 `packages/frontend/src/components/integrations/PackageWebUiPane.vue`、`api/modules/packageWebUiApi.ts`。隔离模型参照 [HTML iframe sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) 与 [MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)。
