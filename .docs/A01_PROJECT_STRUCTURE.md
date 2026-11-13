# 项目结构与 Monorepo 规范

> **适用范围**：infOS-TS 项目整体

---

## 1. Monorepo 配置

使用 **pnpm workspace** 管理（见根 `pnpm-workspace.yaml`）：

```yaml
packages:
  - 'packages/*'
  - 'packages/apps/*'
  - 'electron'
```

---

## 2. 目录结构

```
infOS/
├── packages/
│   ├── shared/                    # @infos/shared — 跨包稳定协议、DTO、Port、校验器与纯工具
│   │   └── src/
│   │       ├── constants/         # 共享常量（responseCodes.ts 等）
│   │       ├── data/              # 内置静态数据（天气等）
│   │       ├── i18n/              # 三语言词条与格式化工具
│   │       ├── node/              # Node 协议编解码与类型
│   │       ├── tarot/             # 塔罗牌面数据与规则
│   │       ├── types/             # 共享类型定义
│   │       └── index.ts           # 桶导出
│   │
│   ├── backend/                   # @infos/backend — Hono + Drizzle + TriviumDB
│   │   └── src/
│   │       ├── app.ts             # Hono 应用入口与路由挂载
│   │       ├── container.ts       # DI 容器与服务装配
│   │       ├── database/          # Drizzle Schema、连接与迁移执行器
│   │       ├── migrations/        # SQL 迁移脚本与兼容引导
│   │       ├── repositories/      # 数据访问层（SQLite / TriviumDB）
│   │       ├── services/          # 业务逻辑层（按功能域分目录）
│   │       ├── routers/           # HTTP 路由层
│   │       ├── middleware/        # 中间件（错误处理 / 鉴权 / 契约校验 / 日志）
│   │       ├── schemas/           # 通用请求与领域校验 Schema
│   │       ├── kernel/            # Kernel Scheduler、Execution 与 Outbox 运行时
│   │       ├── observer/          # Observer 测量与派生状态管线
│   │       ├── projections/       # 会话与 Surface 投影构建
│   │       ├── runtime/           # 宿主运行时适配器与环境桥接
│   │       ├── applications/      # Application Realm、Host ABI 与应用接入基础设施
│   │       ├── capabilities/      # CapabilityGate、Provider 注册与调用桥接
│   │       ├── providers/         # 本机与跨进程能力提供者封装
│   │       ├── packages/          # Package Manifest 与扩展生命周期
│   │       ├── nit/               # NIT 编排脚本词法、语法与 AST 运行时
│   │       ├── tools/             # 内置 Tool（按能力域分目录）
│   │       ├── skills/            # 内置 Skill 资源目录
│   │       ├── assets/            # 内置角色、提示词与默认资产
│   │       ├── lifecycle/         # 启动、关闭与生命周期管理（startup.ts）
│   │       ├── core/              # PathResolver、资产注册表与领域基础设施
│   │       ├── lib/               # 底层工具库（logger、env、appError、i18n）
│   │       └── shared/            # 后端内部共享工具（llmJsonParser 等）
│   │
│   ├── frontend/                  # @infos/frontend — Vue 3 + Pinia
│   │   └── src/
│   │       ├── api/               # HTTP / SSE / WS 客户端与 Transport 层
│   │       ├── applications/      # 子应用集成与 Surface 入口
│   │       ├── assets/            # 样式、字体与图标资源
│   │       ├── components/        # UI 组件（pixel / chat / avatar / dashboard / settings 等）
│   │       ├── composables/       # Vue Composables（按域分目录）
│   │       ├── compositor/        # Surface Compositor 状态机与分段管线
│   │       ├── i18n/              # 前端本地化桥接
│   │       ├── lib/               # 日志与底层辅助
│   │       ├── router/            # Vue Router
│   │       ├── services/          # 前端持久服务与媒体缓存
│   │       ├── stores/            # Pinia Stores
│   │       ├── utils/             # IPC 适配与通用工具
│   │       └── views/             # 页面级视图（MainView / LauncherView / Pet3DView）
│   │
│   ├── document-engine/           # @infos/document-engine — 语义文档权威与投影
│   ├── avatar-assets/             # @infos/avatar-assets — 3D 角色（YSM）资产与清单生成
│   ├── node-sdk/                  # @infos/node-sdk — Node 协议客户端
│   ├── node-host/                 # @infos/node-host — 独立 Capability Provider 宿主
│   ├── daemon/                    # @infos/daemon — Backend Daemon 发行入口
│   ├── wiki/                      # @infos/wiki — VitePress 文档站
│   ├── site/                      # @infos/site — 官网（独立静态页）
│   └── apps/
│       ├── social/                # @infos/social — 社交应用 Realm
│       ├── arca/                  # @infos/arca — Arca Host 与独立 Client
│       └── pictoria/              # @infos/pictoria — Pictoria Host 与独立 Client
│
├── electron/                      # infos-electron — Electron 桌面壳层
│   ├── main/                      # 主进程（index.ts、ipcBridge.ts、home/、prefabs/、services/、windows/ 等）
│   ├── preload/                   # 预加载脚本（含 prefabs/）
│   ├── shared/                    # 主进程与预加载共享协议
│   └── splash/                    # 启动过渡页
│
├── scripts/                       # 构建、版本同步、原生依赖收集与安全检查脚本
├── .docs/                         # 开发者技术文档
├── .github/workflows/             # CI/CD 工作流
└── package.json                   # 根脚本与工作区统一覆盖声明
```

---

## 3. 包依赖关系

以下为各工作区包的实际内部依赖（外部第三方依赖见各包 `package.json`）：

- `@infos/shared`：无内部依赖，承载跨包协议、DTO、Port、校验器与无领域归属的工具。
- `@infos/avatar-assets`：无内部依赖，提供 YSM 角色资产与清单生成。
- `@infos/document-engine`：依赖 `@infos/shared`。
- `@infos/node-sdk`：依赖 `@infos/shared`。
- `@infos/node-host`：依赖 `@infos/shared`、`@infos/node-sdk`。
- `@infos/arca`：依赖 `@infos/shared`、`@infos/document-engine`、`@infos/node-sdk`、`@infos/node-host`；包内通过 `@infos/arca/client` 提供独立 Vue Client。
- `@infos/pictoria`：依赖 `@infos/shared`、`@infos/node-sdk`、`@infos/node-host`；包内通过 `@infos/pictoria/client` 提供独立 Vue Client。
- `@infos/backend`：依赖 `@infos/shared`、`@infos/node-sdk`、`@infos/node-host`、`@infos/arca`、`@infos/pictoria`。
- `@infos/social`：依赖 `@infos/shared`、`@infos/backend`。
- `@infos/frontend`：依赖 `@infos/shared`、`@infos/arca`、`@infos/avatar-assets`。
- `@infos/daemon`：依赖 `@infos/backend`、`@infos/arca`、`@infos/shared`。
- `infos-electron`（`electron/`）：依赖 `@infos/shared`、`@infos/avatar-assets`。
- `@infos/wiki`、`@infos/site`：无内部工作区依赖。

跨包导入和层级依赖约束见 [S05 代码质量标准](./S05_CODE_STANDARDS.md#7-依赖管理)。

---

## 4. 后端 Service 目录

`packages/backend/src/services/` 按功能域划分模块：

- **核心交互与记忆**：`agent/`、`context/`、`conversation/`、`expression/`、`flow/`、`memory/`、`prompt/`、`retrieval/`、`thread/`
- **模型与算力接入**：`embedding/`、`llm/`、`model/`、`tokenizer/`、`voice/`
- **执行与扩展能力**：`execution/`、`integrations/`、`knowledge/`、`mcp/`、`mdp/`、`runtime/`、`task/`、`workspace/`
- **系统、通信与场景**：`attachment/`、`backup/`、`companion/`、`debug/`、`distributed/`、`document/`、`gateway/`、`home/`、`maintenance/`、`perception/`、`pipeline/`、`scheduler/`、`session/`、`social/`、`stronghold/`、`system/`、`theme/`、`weather/`

---

## 5. 架构文档分工与原生依赖边界

核心架构主题由以下文档分别维护：

| 主题 | 权威文档 |
| --- | --- |
| AIOS 核心模型、Execution、Capability 与 Context | [A09](./A09_AIOS_ARCHITECTURE.md) |
| Backend 分层、DI、Gateway 与模型恢复 | [A02](./A02_BACKEND_ARCHITECTURE.md) |
| Surface Protocol、Compositor 与前端性能 | [A03](./A03_FRONTEND_ARCHITECTURE.md) |
| EventNote 记忆引擎、检索与来源追溯 | [A05](./A05_MEMORY_ENGINE.md) |
| Package 扩展与跨包 Port | [A06](./A06_EXTENSION_SYSTEM.md) |
| 跨平台能力边界与资源隔离 | [A07](./A07_CROSS_PLATFORM.md) |
| 第三方 Application 接入规范与 Arca 参考实现 | [A10](./A10_APPLICATION_INTEGRATION.md) |
| CI、发行与数据迁移规范 | [A08](./A08_DEVOPS.md) |

TriviumDB、better-sqlite3、sherpa-onnx-node 等原生能力均通过上游 npm 包接入，仓库内只维护 TypeScript 适配层与打包脚本，不包含自有 Rust/Cargo 工程。ABI 适配与发行安全见 [B27 运行时安全](./B27_RUNTIME_SECURITY.md)。
