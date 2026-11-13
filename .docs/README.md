# 开发者技术文档

本目录供开发者、贡献者和维护者理解系统、定位实现、修改契约与排查故障。文档仅描述当前实现与明确约束；未实现方案保留在规划文档并单独标注。

## 阅读入口与文档职责

| 要解决的问题 | 阅读入口 |
| --- | --- |
| 项目有哪些包、如何组织依赖 | [A01 项目结构](./A01_PROJECT_STRUCTURE.md) |
| 服务装配、持久化、Gateway、错误处理 | [A02 后端架构](./A02_BACKEND_ARCHITECTURE.md) |
| 界面状态、Surface 与组件组织 | [A03 前端架构](./A03_FRONTEND_ARCHITECTURE.md) |
| 源码、Docker、Electron、远程节点如何部署 | [A04 部署](./A04_DEPLOYMENT.md) |
| 事件记忆、检索与来源追溯 | [A05 记忆引擎](./A05_MEMORY_ENGINE.md) |
| 扩展、应用装配与跨包接口 | [A06 扩展系统](./A06_EXTENSION_SYSTEM.md)、[A10 应用集成](./A10_APPLICATION_INTEGRATION.md)、[A11 子应用工具管理](./A11_APPLICATION_TOOL_MANAGER.md) |
| 平台差异与客户端能力边界 | [A07 跨平台](./A07_CROSS_PLATFORM.md) |
| CI、发行与数据兼容 | [A08 开发运维](./A08_DEVOPS.md) |
| Realm、Principal、Execution、Capability 等核心模型 | [A09 AIOS 架构](./A09_AIOS_ARCHITECTURE.md) |

- **A 类**：跨领域架构
- **B 类**：具体子系统的调用链与运行契约
- **M 类**：核心模式与机制
- **P 类**：桌面外壳、卡片、主题与预制件
- **S 类**：工程协作与接口规范

## 子系统参考

| 领域 | 技术文档 |
| --- | --- |
| 文件、终端、审批、工作区 | [B01 生产力运行时](./B01_PRODUCTIVITY_RUNTIME.md)、[B08 撤回](./B08_WORKSPACE_REWIND.md)、[B14 文件预览](./B14_WORKSPACE_FILE_PREVIEW.md) |
| 客户端桌面能力 | [B02 桌面自动化](./B02_DESKTOP_AUTOMATION.md)、[B11 桌宠 HUD](./B11_PET_HUD.md) |
| 知识与状态 | [B03 文档知识库](./B03_DOCUMENT_KNOWLEDGE.md)、[B06 天气](./B06_WEATHER.md)、[B10 角色状态](./B10_CHARACTER_STATE.md) |
| 社交与画布应用 | [B21 社交能力](./B21_SOCIAL_CAPABILITIES.md)、[B04 状态卡片](./B04_SOCIAL_STATUS_CARDS.md)、[B05 NapCat 管理页](./B05_NAPCAT_WEBUI.md)、[B30 Pictoria 画布工作室](./B30_PICTORIA_STUDIO.md) |
| 据点生活 | [B32 据点生活、活动与关注](./B32_STRONGHOLD_LIFE.md)、[主侧会话与亲历](./B26_MAIN_SIDE_THREADS.md) |
| 工具、资源与文档 | [B07 工具扩展](./B07_TOOLS_AND_EXTENSIONS.md)、[B12 消息资源](./B12_MESSAGE_RESOURCES.md)、[B24 文档工具](./B24_DOCUMENT_TOOLS.md) |
| 会话与任务 | [B09 交互模式](./B09_THREAD_INTERACTION_MODE.md)、[B13 任务计划](./B13_TASK_PLANS.md)、[B19 执行模式](./B19_THREAD_EXECUTION_MODES.md)、[B20 主动工作](./B20_PROACTIVE_WORK.md)、[B26 对话队列](./B26_CONVERSATION_QUEUE.md) |
| 桌面生活与外壳 | [B31 共同的家](./B31_COMMON_HOME.md)、[桌面感知](./B_PERCEPTION.md)、[桌面外壳](./P03_DESKTOP_SHELL.md)、[桌面预制件](./P11_DESKTOP_PREFABS.md) |
| 角色资源与表达 | [角色卡](./P05_AGENT_CARD.md)、[表达调教](./B26_EXPRESSION.md)、[自定义主题](./P02_CUSTOM_THEME.md) |
| 模型与上下文 | [B17 提示词工作区](./B17_PROMPT_WORKSPACE.md)、[B22 服务商连接](./B22_PROVIDER_CONNECTIONS.md)、[B16 用量账本](./B16_TOKEN_USAGE.md) |
| 界面与通知 | [B15 背景](./B15_APP_BACKGROUND.md)、[B18 完成提醒](./B18_COMPLETION_ALERTS.md)、[B23 设备通知](./B23_DEVICE_NOTIFICATIONS.md)、[B25 国际化](./B25_I18N.md)、[B30 成就](./B30_ACHIEVEMENTS.md) |
| 安全与诊断 | [B27 运行时安全](./B27_RUNTIME_SECURITY.md)、[B28 运行时调试](./B28_RUNTIME_DEBUG.md)、[B29 索引维护与诊断](./B29_INDEX_MAINTENANCE.md) |

模式机制见 [M01 模式系统](./M01_MODE_SYSTEM.md)、[M02 能力门控](./M02_CAPABILITY_GATE.md)、[M03 NIT 引擎](./M03_NIT_ENGINE.md)、[M04 Steam 集成](./M04_STEAM_INTEGRATION.md)。协作规范见 [S01 命名](./S01_NAMING_CONVENTIONS.md)、[S02 API](./S02_API_SPEC.md)、[S03 日志](./S03_LOGGING_SPEC.md)、[S04 测试](./S04_TESTING_STANDARDS.md)、[S05 代码](./S05_CODE_STANDARDS.md)、[S06 UI/UX](./S06_UI_UX_DESIGN_SPEC.md) 与 [S07 动效层](./S07_MOTION_LAYER.md)。

## 原生依赖的维护边界

infOS 的应用逻辑与编排使用 TypeScript。TriviumDB、better-sqlite3、sherpa-onnx-node 等原生能力通过上游 npm 包接入，仓库内只维护 TS 适配层、数据格式、ABI 匹配与发行资源收集（见 `scripts/rebuild-daemon-deps.mjs` 与 `scripts/collect-daemon-deps.mjs`）。细节见 [A05](./A05_MEMORY_ENGINE.md)、[A08](./A08_DEVOPS.md)、[B27](./B27_RUNTIME_SECURITY.md)。

## 文档维护约定

- 修改系统行为时，按入口、权威数据、状态转换、权限作用域、失败恢复与客户端投影核对并同步对应文档；同一事实由单一主题文档维护，其他位置采用引用。
- 长期文档只保留当前约束、必要参数、设计取舍与排障路径；版本流水账、测试数量与临时审批记录留在提交历史与 CI。
- `archived/` 与 `TODO-LIST/` 仅作历史与规划参考，不作为当前实现契约。
