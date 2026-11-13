# Pictoria 画布工作室

> **适用范围**：`packages/apps/pictoria/` 画布编辑、助手提案、视频接续、参考图用途与项目包导入导出（供应商配置与任务执行仍由 Pictoria 自治 Host 管理）

---

## 1. 架构、依赖与布局

- **前端入口**：`packages/apps/pictoria/client/src/components/CanvasStudio.vue`。
- **共享哈希依赖**：画布文档摘要使用 `@noble/hashes`，同时列为 Pictoria 生产依赖与官方 Host 外部依赖；`scripts/build-official-apps.mjs` 负责依赖边界校验，`scripts/collect-daemon-deps.mjs` 从生产依赖收集运行文件。新增 Host 依赖时须同步维护上述声明与发行配置。
- **工作区布局**：右上角常驻画布助手与项目工具菜单（助手展开时创作栏让出侧栏空间）；图片编辑与编组位于选中节点的浮动工具条，图像编辑器将蒙版方式与步骤选择收进弹窗参数栏并复用 Pictoria 图标、下拉组件与深浅色变量；多图任务与图片卡片显示候选数量并支持展开/收起候选面板；空画布隐藏小地图，非空画布可手动收起小地图（`CanvasMinimap.vue`）。

---

## 2. 图像编辑与候选结果

- **本地图像编辑**（`client/src/components/ImageStudio.vue`）：基于原素材像素建立画布，画笔支持橡皮擦与撤销/重做（显示缩放不影响蒙版坐标）；裁剪支持拖框与数值坐标，网格切图最多 `20` 张，重采样支持平滑与最近邻算法。上述本地处理直接生成新 PNG 素材与历史来源连线，原素材保留不变；单次图像处理上限约 `6400` 万像素，单素材上传上限沿用 `20 MiB`。
- **局部编辑模式**：仅创建步骤草稿，用户补齐参数后主动执行。支持两种模式：
  - **多图参考**：传递原图与蓝色区域标注图交由模型理解编辑范围。
  - **独立蒙版**：要求步骤声明单独 `mask` 素材字段并显式约定透明区域或白色区域可编辑；模型步骤与 API 适配通过 Schema 与 `ServiceClient` 执行。
- **候选管理与重试**：任务卡片 `outputIds` 始终保存素材 ID，输出素材通过 `candidateGroupId` 指向任务卡片，由 `primaryAssetId` 决定默认展示项；展开状态随项目持久化，已参与后续输入连线的素材在候选收起时保持可见。单张重试沿用当前同版本步骤与原输入创建新任务（公开数量参数设 `1`）并保留原结果；不支持单张数量参数的步骤需从创建栏显式重建。

---

## 3. 助手、会话与增量提案

### 3.1 增量协议与实时上下文

- **增量操作集**（`src/canvasDocument.ts`）：支持便签（`note`）、移动、尺寸、命名、删除、编组、解组、选择、视口、连线及步骤草稿（`draft` / `update_draft`），不包含脚本执行或直接提交生成任务。操作在文档副本依次校验，客户端核验当前步骤输入 Schema 与连线素材类型后写入项目并建立撤销点。
- **实时上下文**（`canvas.context.set/get/close`）：按 `owner / projectId / sessionId` 隔离驻留内存（含画布、选择、视口、可用步骤、上下文序号与文档基准），`120` 秒未心跳续期即失效，不作项目持久化。`canvas_read` 未指定项目时，仅单一活动会话直接返回上下文，多窗口会话则返回列表供调用者显式选择（返回的 JSON Schema 即 Agent 构造提案的权威字段契约）。
- **提案确认与合并**：`canvas.propose` 校验读取时的上下文序号后持久化待确认提案；确认应用时再次核对 `documentKey`（节点、标题或连线变动时要求重新生成；仅选区/视口变更不影响基准），`canvas.proposal.resolve` 通过 `revision` 幂等防重；生成草稿须由用户主动执行。`client/src/components/CanvasProposalReview.vue` 在内部滚动列表完整展示节点名称、成员、便签全文、草稿参数及连线对象。`update_draft` 合并既有草稿保留未指定字段，按提案顺序移除被改写字段当时已有的输入连线后再建立新连线；分析文字可通过 `note` 写便签或通过 `draft` 建新草稿。
- **桌面桥接白名单**：挂载模式下请求经 `electron/main/services/pictoriaSurface.ts` 白名单转发至宿主控制面；新增助手准备、上下文、会话、提案或 `project.rename` 接口时，须在桌面桥接白名单与应用 Manifest 同步声明。未知操作直接拒绝并指明操作名（白名单在 Electron 主进程注册时加载，刷新画布页面不重载权限表）。
- **助手对话与任务隔离**：对话使用 `canvas.conversation.get/save`（带预期 `revision`）按项目持久化；`canvas.assistant.prepare` 建立内置文本步骤（挂载模式走宿主模型授权，独立模式使用 Pictoria 自己的 OpenAI 兼容供应商与加密凭据引用），经 `task.submit` 执行并使用 `assistant:<projectId>` 隔离项目 ID（区分普通画布任务与素材输出）。请求先落盘提交信息与幂等键以便刷新后继续查询恢复，原始无效回复保留供排查。

### 3.2 助手设置与视觉上下文

- **设置存储与界面**：助手头部显示当前模型，齿轮入口在同一侧栏切换设置视图（按模型、生成、上下文与创作偏好分组，常用字段两列排列，内容区滚动、保存栏固定）。`src/assistantSettings.ts` 定义参数范围与默认值，通过 `canvas.assistant.settings.get/save`（带预期 `revision`）按 `owner / projectId` 存于 `canvas-assistant-settings`（独立于会话保存；重置仅恢复生成、上下文与偏好参数并保留已选供应商；设置不含凭据，也不随当前版本项目包迁移）。
- **模型与采样参数**：挂载模式默认沿用 infOS 主模型（通过 `implementation.options` 与可选 `HostPort.generate.options` 透传采样、长度与思考强度，留空不覆盖默认值、显式零值保留；协议与推理方言由 infOS 模型配置决定）。独立模式继续通过 `ServiceClient` 调用 OpenAI 兼容 Chat Completions，原生推理模型传 `max_completion_tokens`、常规模型传 `max_tokens`（代表供应商总输出上限），思考强度按标准 `reasoning_effort` 传递。
- **上下文范围与预算**（`client/src/services/assistantContext.ts`）：支持全画布或选中项（选中分组自动包含成员，空选区直接报错而不退回整画布）。序列化字符上限 `64,000`（按字符而非 Token 计，超限先移除最早整条历史，当前请求与范围内节点不截断，仍超限则拒绝发送）；超时范围 `30–600` 秒（默认 `600` 秒），挂载与独立模式统一生效。
- **创作偏好与图片输入**：创作偏好附加在固定提案协议后，每次提交冻结设置快照与上下文（变更后创建新内部快照但不改写已接受任务，内部快照不挤占用户步骤/服务列表）。看图开关由每次会话显式勾选控制（不随设置持久化）：普通上下文仅传输结构与文本；勾选「分析所选图片」后本次请求额外附带显式选中的 PNG / JPEG / WebP（最多 `4` 张、总计 `20 MiB`），按 `imageBindings` 顺序对应多模态图片并保留素材引用以便刷新恢复；挂载模式走宿主视觉模型，独立模式经声明式 `openai_content` 编码并在报错时脱敏错误正文。

---

## 4. 视频接续与片段序列

- **接续工作室**（`client/src/components/VideoContinuationStudio.vue`、`client/src/services/videoContinuation.ts`）：复用图像工作室浮层与变量，通过视频节点「接着生成」打开；使用浏览器原生解码读取末尾候选帧或当前播放位置 JPEG（按浏览器定位时间工作，适合序列预览而非离线逐帧精确剪辑）。挂载模式下视频预览上限按已有素材总量放宽至 `100 MiB`（图片及其他素材保持 `20 MiB`），源视频与在播片段受媒体引用租约保护不被淘汰。
- **Schema 与来源绑定**：图生视频步骤在输入 Schema 中声明 `x-pictoria-video: { startFrameField: "images" }`（支持单素材对象或数组首项；普通多图参考无此声明不开放接续）。接续草稿持久化 `continuation`（源素材引用、源节点与名称、源定位时间、原片时长与抽取画面引用），执行与输出沿用此来源而不随源任务新结果改写；旧首尾帧不自动继承，人物/风格等辅助参考仅在对应字段可用且用户勾选继承时复用（未标注或仅标构图的图片不混入）；更换起始帧后需重建接续关系。「片段序列」追溯固定素材祖先并展示接续分支，在记录定位点切换连播而不裁切原片；抽帧、选帧、草稿与执行（仍走 `createRun` / Host）均不依赖 Agent。

---

## 5. 参考图用途、编组与项目包

- **参考图用途**：创建栏与草稿卡片按步骤、字段和素材 ID 保存 `referenceUses`（无可用文本说明字段时不开放用途编辑）；`src/creativeInputs.ts` 提交时按实际引用位置向兼容文本字段附加用途指令，同时保留原草稿标注以便重试不重复拼接，并随项目包递归导出重映射。
- **编组与视口**：分组为独立 `group` 节点，成员通过 `groupId` 引用且坐标始终为画布绝对坐标；整组拖动递归移动成员，解组保留坐标并恢复上级组关系，复制组自动重映射成员关系，删除组框保留成员。项目 `viewport` 统一保存平移与缩放，随加载、撤销、重做与小地图同步更新。
- **项目包导入导出**（`client/src/services/projectPackage.ts`）：ZIP 格式 `pictoria.project`（v1）由 `project.json` 清单与 `assets/<序号>` 原始字节构成，递归收集画布与创建栏素材引用（含输入顺序、主图与输出素材，跳过运行中任务、执行标识与凭据）并使用兼容普通 HTTP 浏览器的本地算法记录字节长度与 SHA-256。导入限制压缩包与声明解压量各 `256 MiB`、`2000` 个节点/素材与 `8000` 条边，先完整校验（拒绝异常路径、重复条目、缺失/篡改资源与循环分组）并弹窗确认，确认后上传重映射全部资源 ID 并保存为新项目（失败保留原项目，中断时已上传素材留存资源库，运行记录不迁移执行权，API 草稿采用当前环境有效步骤配置）。

---

## 6. 可编辑文档与源码入口

- **可写文档属性**：项目、工作流、备注及字段 Schema 中会被编辑器修改的属性（`title`、`label`、`usageDescription`）必须提供可写字段，不可定义为仅 getter；默认备注、示例与步骤字段创建时通过 i18n 生成普通文本随用户内容保存，纯界面菜单继续动态翻译，空画布默认标题通过成对 getter/setter 保持语言响应并兼容加载、重命名与撤销/重做。
- **核心源码入口**：
  - **Host 与领域**：`packages/apps/pictoria/src/canvasStudio.ts`、`canvasDocument.ts`、`assistantSettings.ts`、`creativeInputs.ts`
  - **客户端状态与服务**：`client/src/composables/useCanvas.ts`、`useCanvasAssistant.ts`、`client/src/services/assistantContext.ts`、`videoContinuation.ts`、`projectPackage.ts`
  - **界面组件与桌面桥接**：`client/src/components/CanvasStudio.vue`、`ImageStudio.vue`、`VideoContinuationStudio.vue`、`CanvasProposalReview.vue`、`CanvasMinimap.vue`、`electron/main/services/pictoriaSurface.ts`
