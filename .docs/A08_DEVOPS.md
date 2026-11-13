# DevOps 与运维规范

> **版本**：0.9.13 · **更新时间**：2026-10-26
> **适用范围**：CI/CD、数据库迁移、版本发布、安全、可观测性、API 文档
> **依赖规范**：[A04_DEPLOYMENT](./A04_DEPLOYMENT.md)、[S04_TESTING_STANDARDS](./S04_TESTING_STANDARDS.md)
>
> **当前事实**：普通 CI 执行安全审计、规范提示、跨平台测试、类型检查、全包构建及 Docker 构建烟测；Tag Release 复用质量门禁，构建 Windows 标准版、便携版和 Steam 版，验收最终便携包，并通过 GitHub Container Registry 发布前后端镜像。

---

## 1. CI/CD 流水线

工作流以 `.github/workflows/ci.yml`、`release.yml` 为权威入口，流水线依赖顺序、运行矩阵与 Action 版本均以工作流配置为准。

### 1.1 普通 CI 的职责

| 任务 | 内容与失败行为 |
| --- | --- |
| security | 按 `.node-version` 与运行时策略检查声明，执行依赖审计和精确回补核验；阻断并保留证据 |
| lint | ESLint 与格式提示；当前为非阻断任务，不是测试的前置依赖 |
| test | Linux / Windows 矩阵运行功能测试；不另起重复覆盖率任务 |
| build | 依赖 test，执行包/模板及测试代码类型检查、版本一致性、全包构建和 Daemon 发行依赖检查 |
| docker-smoke | 构建镜像，验证健康入口、代理、子应用启动及停止，最后清理隔离容器 |

CI 不设覆盖率百分比门禁；手动 `coverage` 用于定位测试缺口，测试选取标准见 [S04](./S04_TESTING_STANDARDS.md)。

Linux 测试使用四个 worker，Windows 使用两个，避免原生模块、PDF 阅读器与真实 Shell 冷启动争抢资源。PDF 跨格式读回用例保留 30 秒预算并断言真实产物中的完整中文正文；普通用例沿用默认超时并全量执行。依赖审计先验证报告与公告结构，再惰性解析工作区锁文件，遇到损坏报告立即拒绝。

客户端配对凭据沿用同步持久化契约（`packages/backend/src/lib/atomicJson.ts`）：先写入同目录临时文件，再原子替换正式文件。`atomicJson.ts` 对短暂占用错误最多重试五次、总等待上限 620 毫秒；持久失败保留旧凭据并向调用方报错，不降级覆盖正式文件，并与异步原子 JSON 写入共用错误分类和临时文件清理规则。

### 1.2 触发与发行

`push` 到 `main`/`dev` 或面向 `main` 的 PR 触发普通 CI；Release 通过 `workflow_call` 复用质量门禁。普通 `main` push 仅执行常规 CI；版本标签（Tag）发行额外构建 Windows 标准版、便携版和 Steam 产物，并以当前仓库 `GITHUB_TOKEN` 发布 GHCR 镜像，等待标准版、最终便携包验收、Steam 构建及镜像发布全部完成（Steam Depot 上传与审核另行执行）。

`.github/workflows/wiki.yml` 在 `main` 更新时独立构建 Wiki 并部署到 GitHub Pages，也支持从 `main` 手动触发。产物目录为 `packages/wiki/.vitepress/dist`，站点使用根路径，目标自定义域名为 `wiki.perofamily.top`。发布需要仓库 Pages 来源保持为 GitHub Actions，并在 `github-pages` 环境的部署分支规则中允许 `main`；域名切换还需在 GitHub Pages 和 DNS 服务商处配置。普通 CI 全包构建会校验 Wiki，Release 质量门禁不触发站点部署。

Wiki 面向普通用户，目录按读者意图分为 `guide/`（开始使用）、`companion/`（和伙伴相处）、`work/`（请伙伴帮忙）、`deployment/` 与 `advanced/`（进阶与原理），侧栏在 `packages/wiki/.vitepress/config.mts` 中维护。移动或删除页面时需同步更新 `packages/wiki/.vitepress/theme/redirects.ts`（GitHub Pages 对旧路径返回 404 页，由浏览器端查表跳转）。站内角色使用 Pero 与佩诺菈，素材位于 `packages/wiki/public/characters/`（由应用角色图压缩的 WebP）；正文提示使用 `<CompanionNote who="pero|penora">`，页面 frontmatter 的 `buddy` 切换或关闭右侧陪读角色，页面正文不写死版本号。

`packages/site` 为萌动链接官网：Vite + Vue 静态单页，`base: './'`，构建产物位于 `packages/site/dist`。`.github/workflows/site.yml` 在 `main` 更新或从 `main` 手动触发时构建官网，检查入口后保存 `official-site` 静态产物，再核对发布凭据并上传到 Cloudflare Pages 项目 `peroperochat-site` 的 `main` 生产分支。凭据缺失时发布任务失败，已完成的构建产物仍可下载排查或由本机已授权 CLI 部署；同一时刻只执行一次官网发布，普通 CI 全包构建也会构建官网。

官网发布需在 Cloudflare 创建生产分支为 `main` 的 Pages 项目 `peroperochat-site`，并在 GitHub 仓库 Secrets 中配置 `CLOUDFLARE_ACCOUNT_ID` 与具备该账户 Pages 编辑权限的 `CLOUDFLARE_API_TOKEN`。目标域名 `www.perofamily.top` 需在 Pages 绑定并在 DNS 服务商处将 `www` 指向 Pages 地址；若项目启用过 Cloudflare Git 自动部署应予以关闭，避免与工作流重复发布。

本机 `wrangler login` 的 OAuth 登录状态不随源码同步给 GitHub Actions，CI 需配置独立的 Pages 编辑 API 令牌；GitHub Pages 的域名与 HTTPS 设置由仓库 Pages 后台管理（独立于仓库内 `CNAME` 文件）。

官网工作流通过 `pnpm dlx` 运行固定版本的 Wrangler，不向工作区根目录添加部署依赖；升级 CLI 时同步核对 Pages 行为与 Node 版本要求。

官网四位角色的立绘、表情帧、Q 版与场景插画位于 `packages/site/public/art/`。立绘的眨眼和说话通过表情补丁实现，位置定义在 `packages/site/src/faces.json`（重新生成立绘时需同步更新）。角色台词改写自角色档案，维护在 `packages/site/src/characters.ts`；简体中文、繁體中文、英语和日语词库与切换方式见 [国际化说明](./B25_I18N.md#官网语言)。页面粒子等动态效果跟随系统或用户的减少动态效果设置。

### 1.3 运行时与依赖门禁

Node、Electron 声明、锁文件与 Docker 镜像须符合 `scripts/runtime-security-policy.json`。独立 Node 与 Electron 内嵌 Node 分别校验，兼容下限放行时仍记录对应的安全差异。Release 在构建前、beforePack 与 afterPack 检查实际 Electron 二进制。完整规则和回补证据见 [B27](./B27_RUNTIME_SECURITY.md)。

### 1.4 Electron 启动环境

Electron 启动环境必须在派生进程前清理继承的 `NODE_OPTIONS`（先于主进程初始化阶段）。开发入口同时移除继承的 `ELECTRON_RUN_AS_NODE`；发行版 Daemon、Application Host 与打包烟雾测试仅显式设置 `ELECTRON_RUN_AS_NODE=1`。普通 Node 开发后台、终端任务和 `NODE_EXTRA_CA_CERTS` 保持正常透传。

---

## 2. 数据库迁移策略

### 2.1 SQLite 迁移 — Drizzle Kit

```bash
# 生成迁移文件
pnpm drizzle-kit generate

# 执行迁移（兼容既有单基线库）
pnpm --filter @infos/backend db:migrate

# 推送 schema 变更（开发阶段快捷方式）
pnpm drizzle-kit push
```

### 2.2 迁移文件管理

```
packages/backend/src/database/
  ├── schema.ts              ← Drizzle schema 定义（唯一真理源）
  ├── migrations/             ← 按 journal 顺序执行的 Drizzle SQL 与快照
  │   ├── 0000_baseline.sql
  │   ├── 0001_remove_work_context.sql
  │   └── meta/
  └── schemaMigrations.ts    ← 旧单基线库登记薄层；实际迁移交给 Drizzle
```

### 2.3 迁移原则

- **向前兼容**：新增列给默认值，不删除现有列（可标记 deprecated）
- **不可逆操作需确认**：删表、改列类型等操作需要人工审批
- **迁移目的明确、顺序稳定**：每个迁移聚焦相关结构变化；多迁移按 journal 顺序执行，不改写已发布迁移
- **TriviumDB 升级与文件组保护**：当前固定 `0.9.0` 正式版，主文件格式为 v10；首次可写打开 v5–v9 库前，注册表持有共享读锁并保留完整、带 SHA-256 清单的副本，再由引擎迁移并保存向量类型、元素宽度与头部 CRC。依赖升级不触发 Embedding 重算或全库重建。遇到待恢复 WAL（尤其是历史仅 WAL、无类型空检查点附带非空 WAL 的库）时停止旧格式迁移，先用原版本正常恢复并完成检查点后退出。备份始终覆盖完整文件组而非单个 `.tdb` 主文件。

新升级备份位于 `@data/.store-upgrades/0.9.0/<原数据库相对路径>/<文件组摘要>/`，不参与分布式同步。`0.8.9`、`0.8.11`、`0.9.0-beta.2`、`0.9.0-beta.3`、`0.9.0-beta.4` 等旧版本备份继续保留，并纳入角色发现、重建、清空和永久删除的定向清理，确保已遗忘正文不被恢复。回退版本前须先停止应用，并从同一备份目录恢复整组文件；旧引擎不可直接接管 v10 主文件或半发布中断现场，社交图谱属于正式业务存储。

0.9.0 正式版沿用 beta.4 的索引格式：属性索引采用 `.pidx` v8，旧复合 posting 按主文件事实查询，普通复合索引需按原字段列表重新创建；唯一约束从主文件定义恢复。`.quiver.meta` v2 将索引与主文件、向量及 ID/slot 绑定；旧 v1 元数据遵循 `missingIndexPolicy`，注册表现有 `fallback` 策略支持回退，显式重建可发布新索引，主文件迁移与索引重建均先完成备份。兼容依据见[上游 beta.4 变更说明](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0-beta.4/docs/changes/0.9.0-beta.4.md)。

从 beta.4 切换至正式版不新增主文件格式迁移。升级前先关闭旧实例并保存完整文件组；正式版的 Windows 打开身份校验、维度迁移原子发布和关闭排空规则由引擎负责（实际部署需文件系统支持排他原子重命名），应用层沿用引擎原生打开、锁与错误传播机制。依据见[上游 0.9.0 正式版说明](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0/docs/changes/0.9.0.md)。

0.8.10 起的 Mmap 发布恢复增加 `.tdb.publish` 和发布副本；beta.2 将副本扩展为 `.tdb.publish.0`–`.tdb.publish.8`，覆盖主文件、向量、flush marker、QuIVer、文本及属性/图索引。受管文件识别、备份与重建清理包含这些文件及其 `.tmp` 文件，避免在恢复前移除未恢复日志或旧代备份。可写句柄由引擎恢复未提交发布；只读检查遇到待恢复状态时返回错误，防止使用半发布文件创建同步快照。快照发现同时检查仅有旁路文件的库，确保主文件暂缺时仍保留恢复现场。

分布式导出使用 bundle v2，记录引擎版本及格式上限 v10；接收端兼容旧 bundle v1 与旧格式 v9，拒绝高于 v10 的未来格式。完整备份导入同样通过 `TRIVIUM_FORMAT` 校验上限。导出时暂停引擎自动压实、同步刷新并冻结 SQLite 与数据库文件组，随后从独立暂存目录打包（避免异步遍历变化中的 `.tdb.pld.<generation>`）。旧版与新版在格式跨版本升级后应保持双端同步升级。

现有 SQLite 库早期由启动器直接执行 `0000_baseline`，没有 Drizzle 迁移记录。启动时的薄层只为这类库登记已完成的基线；新旧库后续都由 Drizzle migrator 按 `_journal.json` 执行。`0001_remove_work_context` 删除旧工作正文列与逐轮表，保留目标与私有事实；`0003_remove_tool_observations` 删除退役的工具摘录表。近期工具正文改为进程内短期缓存，来源随原对话元数据保存。旧摘录不迁入长期历史，新迁移不修改对话消息。

---

## 3. 版本发布策略

### 3.1 版本号规范

采用 **SemVer**（语义化版本）：`MAJOR.MINOR.PATCH`

| 类型   | 含义                        | 示例            |
| ------ | --------------------------- | --------------- |
| MAJOR  | 不兼容的 API / 数据格式变更 | `2.0.0`         |
| MINOR  | 新功能（向后兼容）          | `1.1.0`         |
| PATCH  | Bug 修复                    | `1.0.1`         |
| 预发布 | Alpha / Beta / RC           | `1.0.0-alpha.1` |

所有子包版本号通过 `pnpm version:sync` 统一同步。

### 3.2 版本变更与 Release 正文

根脚本保留 changesets 的变更记录与包发布入口，统一应用版本通过 `pnpm version:sync` 同步。GitHub 标签发行的正文由 `scripts/generate-release-notes.mjs` 生成：优先读取 `.github/release-notes/<标签>.md` 的人工摘要，再附上前一标签至当前提交的记录与下载说明；包发布流程与 Electron 发行产物检查各自独立。

维护者应按最终改动编写版本摘要、重构要点、兼容性与升级说明；一次性调查过程和测试流水账留在 CI/提交记录。发布会产生远程变更，是否执行仍按用户授权决定。

### 3.3 发布渠道

| 渠道           | 触发条件                               | 产物                                  |
| -------------- | -------------------------------------- | ------------------------------------- |
| GitHub Release | 推送版本 Tag                           | `.exe` 安装包 + 便携版 + 发布说明     |
| Steam          | Tag Release 构建，SteamPipe 另行发布   | Depot 构建产物                        |
| GitHub Container Registry | 推送版本 Tag，质量门禁通过 | Backend/Frontend 版本镜像与通道标签 |

---

## 4. 安全规范

### 4.1 输入验证

后端已通过 Hono + Zod 在 Router 层做 schema 验证：

```typescript
// 所有用户输入使用项目级validate()包装器
app.post('/api/chat', validate('json', chatSchema), handler)
```

**补充要点**：

- **校验信封**：Zod 失败统一返回 HTTP 400、`VALIDATION_ERROR` 和 `data.fields`，Router 统一使用项目级 `validate()` 包装器
- **响应契约**：业务码必须注册；HTTP 201 绑定 `CREATED`，HTTP 202 绑定 `ACCEPTED`
- **路径遍历防护**：受管逻辑前缀由 `PathResolver`（`packages/backend/src/core/pathResolver.ts`）约束根目录；工作区等业务路径须再经各自的范围和权限检查，绝对路径与 `resolvePrincipal()` 仅用于路径定位而非授权依据
- **SQL 注入**：Drizzle ORM 的参数化查询天然防注入
- **XSS**：Vue 的模板自动转义 + CSP 头（Electron 版由 `webPreferences` 控制）

### 4.2 依赖安全

```bash
# 定期检查依赖漏洞
pnpm audit

# GitHub Dependabot 自动创建漏洞修复 PR
# 配置 .github/dependabot.yml
```

### 4.3 敏感信息管理

| 信息类型      | 存储位置                | 注意事项                       |
| ------------- | ----------------------- | ------------------------------ |
| LLM API Key   | 模型/连接持久配置（SQLite 等，见 B22） | 不提交 Git；进入手动完整同步包时必须使用同步会话密钥加密，并由目标 Server 主密钥重新封装 |
| Gateway Token | `gateway_token.json`    | 机器身份凭据，不进入同步包；目标 Server 保留自己的 Token |
| Steam App ID  | 代码硬编码 `4457100`    | 公开信息，无需保护             |

---

## 5. 可观测性

### 5.1 日志（已有）

见 [S03_LOGGING_SPEC](./S03_LOGGING_SPEC.md)，使用 consola；中文原文作为 i18n 查询键，显示跟随运行端语言。

### 5.2 健康检查

公开健康入口为 `GET /api/health`（路由前缀含 `/api`），实现位于 `packages/backend/src/routers/health.router.ts`，返回版本、运行时、进程时长与内存摘要；`/api/system/health` 是系统路由中的另一管理入口，调用方按所需认证与响应契约选择。

Docker healthcheck 以实际 Compose/Dockerfile 为准，探测服务端监听地址。进程健康仅反映本进程可达，外部模型、社交账号与客户端 Capability 状态由对应领域端口独立判断；日志查询接口保持原有后端权限与分页契约。

### 5.3 OpenTelemetry

后端入口为 `packages/backend/src/lib/telemetry.ts`，统一创建 LLM 调用 Span，并接入请求 Trace Context。配置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`，或回退使用 `OTEL_EXPORTER_OTLP_ENDPOINT`，可启用批量 OTLP HTTP 导出；`OTEL_SERVICE_NAME` 覆盖服务名。`INFOS_OTEL_CONSOLE=true` 可使用控制台导出，`OTEL_SDK_DISABLED=true` 禁用初始化。

未配置导出器时仍保留本地 Span 与上下文传播。退出时调用 `shutdownTelemetry` 刷新批量数据；排查无链路时须同时核对初始化、导出地址、Trace Context 与退出刷新流程，确认数据实际送达观测后端。

---

### 5.4 Execution与系统性能预算

架构变更必须同时记录正确性、安全性与性能结果，至少覆盖：

- 用户提交到接收确认、首Token与首Surface延迟；
- 流式帧率、最长主线程阻塞和长消息DOM变更量；
- 对话首屏消息数、历史分页响应时间、已挂载消息组件数与占位高度误差；
- Markdown缓存命中率、富文本解析P95、重型Surface挂载数和Renderer内存；
- 每个Execution的内存、Token、LLM、工具与并发I/O用量；
- 前台任务受后台负载影响的P95延迟；
- Provider超时、取消、stale-handle和重复消息比率；
- 重启后Task、Surface、Outbox与Checkpoint恢复成功率；
- 数据迁移、WAL checkpoint、备份与回滚成功率。

Scheduler必须保证交互优先、同Agent与跨Agent公平、模型与Provider并发预算、Backpressure、Deadline、暂停恢复和饥饿保护。后台状态必须向用户解释WaitReason、资源占用与取消结果。

---

## 6. API 文档

### 6.1 当前接口来源

当前后端使用 Hono Router、项目级 `validate()` 包装器和 Zod 校验；接口信封与稳定错误见 [S02](./S02_API_SPEC.md)，精确字段以 Router Schema 为准。仓库暂未启用 OpenAPIHono / Scalar 统一文档服务或 `/openapi.json`、`/docs` 端点。

### 6.2 接口变更的维护范围

变更时同步核对 Router 校验、共享 DTO、前端 API 客户端和 `S02`，明确兼容期与弃用行为。若后续新增 OpenAPI 导出，须从实际 Schema 生成并覆盖真实错误与认证契约。

---

## 7. 安全与验证基线

### 7.1 信任层级

```text
Kernel Core
> Built-in System Service
> Signed/Official Application
> User-installed Application
> External MCP/Provider
> Model-generated Code / Web Content
```

不同层级对应不同的默认 Capability、隔离与审批要求。Markdown 不执行脚本；Programmable Surface、Web Application 和 Document Island 均在独立沙箱中运行，与主前端全局对象隔离。截图、剪贴板、Cookie、网络拦截与原生输入属于高风险能力；Audit 记录能力决策与副作用而不默认落盘敏感明文，Snapshot 进入模型前先脱敏，Capability Handle 仅用于内部路由而不进入 Prompt 或普通日志。

### 7.2 强制验证矩阵

- **协议契约**：Shared 序列化、版本协商、Correlation/Causation、Generation、Cancellation、Deadline 与 Capability 作用域边界；
- **状态机**：Execution、Task、Application、Surface 与 Capability 的非法跃迁、重复请求和崩溃恢复；
- **故障注入**：SSE 断开、Provider 掉线、Tool 超时、Approval 跨重启、SQLite 提交后 Surface 未送达、TDB flush 中断、Application 崩溃、Kernel 短时断线、主 Agent Execution 取消、旧 Generation 与重复 Idempotency Key；
- **性能回归**：Surface、Scheduler 和 IPC 变更同步与基线对比。

第三方 Application Adapter 还须覆盖配对与身份校验、协议降级、应用版本不兼容、Capability 过期/撤销、任务重复提交、断线重连、Adapter 崩溃重启和主 Agent 取消后的任务独立性。默认测试环境使用 Mock Kernel，生态贡献者测试隔离于真实用户 Credential 与私有数据。

### 7.3 数据与兼容策略

领域表与 TriviumDB 继续持有业务权威；同一事务写入 Outbox 并异步产生 Durable Event（不采用全面事件溯源）。迁移使用 Strangler Adapter，兼容层须注明移除条件并在迁移完成后清理内部重复协议，同时保持用户能力与持久数据向后兼容。

---

## 8. 维护入口

| 变更类型 | 必须共同审阅的配置/实现 |
| --- | --- |
| 运行时和原生依赖升级 | 运行时策略、依赖声明/锁文件、重编译与收集脚本、beforePack/afterPack；见 B27 |
| 存储结构与格式 | Drizzle Schema、迁移及 journal、Store 注册表与完整文件组；见 A05 |
| 版本发行 | `scripts/sync-version.ts`、标签工作流、版本摘要与产物验证 |
| Docker 部署 | Dockerfile、Compose、运行时配置与实际镜像健康检查；见 A04 |
| 接口与可观测性 | Router Schema、S02、日志 i18n 与 Trace Context |

排查与变更时需区分源码配置、构建产物、运行环境与用户数据，针对实际问题在对应层保留证据并验证。具体构建、检查与测试命令执行遵守根目录 `AGENTS.md` 的权限约定。
