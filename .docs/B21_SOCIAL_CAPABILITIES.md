# 社交应用：编排、账号与交付

> **适用范围**：`packages/apps/social/` 运行时、多平台适配器、群聊状态机、结果追踪与上下文编译

社交应用将同一人格在不同平台的账号映射到独立会话，负责入站持久化、参与决策、消息发送及异常恢复。宿主提供收窄的能力端口，平台协议差异留在适配器层，通用运行时基于统一规范字段运转，不解析 OneBot、Telegram 或 Discord 原始字段。

---

## 1. 模型入口与业务能力

### 1.1 `social_act` 与目录能力

模型在社交回合仅通过 **`social_act`** 行动；普通自然语言输出既不发送到平台，也不作为角色发言入库：

- **日常回复**：提交 `{"reply": "正文"}` 或分段消息数组。
- **查询与编排**：通过 `steps` 编排流程，其中的 `call` 步骤调用当前授权目录内的业务能力 `social`、`social_group`、`social_account`（参数格式 `{action, input, account_id?}`）。三者属于编排目录能力，不作为与 `social_act` 并列的独立模型工具暴露。

```json
{
  "steps": [
    { "op": "call", "tool": "social_group", "args": { "action": "state_get", "input": {} } }
  ]
}
```

- **定义与执行入口**：每种 `action` 的输入校验定义在 `packages/shared/src/socialTools.ts`、`packages/apps/social/runtime/socialCommonOperations.ts` 与各适配器操作表中；`socialActDefinition.ts` 动态将当前授权目录嵌入入口参数，`socialOrchestration.ts` 解释步骤、引用、依赖与恢复；遗留执行器名称仅作内部路由兼容。
- **Schema 兼容**：针对不支持 `anyOf` 的模型传输层，可合并分支的可选字段并保留 `action` 参数说明；执行层仍使用原始 Schema 校验，不放宽身份、操作范围或权限检查。

### 1.2 参与行为与步骤生命周期

- **参与控制参数**：
  - `pass`：结束本轮不发言，立即退出活跃续聊并推进群聊退避（见第 5 节）。
  - `wait`：暂停并等待后续补充。
  - `observe`：持续关注指定事件直至到期。
  - `defer`：保存稍后重新判断的意图。
  - `end_participation`：默认 `false`；单用相当于静默退回 `idle`，与 `reply` / `messages` 合用则在发送完成后退回 `idle`。
  - `low_activity`：设为 `true` 时在普通群聊回合结束进入 `mention_only` 低活跃。
- **步骤原语**（`call` / `send` / `wait` / `observe` / `if` / `parallel` / `yield`）：`parallel` 仅并发独立只读调用，`if` 基于真实结果判定分支；需要理解内容或组织措辞时通过 `yield` 或 `next: "continue"` 交回模型。
- **延时与续接语义**：`messages[].delay_ms` 从前一步完成后起算，表示已决定内容的延迟发送；`after` 表示发送后继续关注，两者均不同于保存重判意图的 `defer`。
- **引用与依赖**：步骤间通过 `{"$ref": "步骤ID.data.字段"}` 引用输出，存在前置成功依赖时需声明 `depends_on`。默认普通发送后结束、纯查询后返回模型，可通过显式 `next` 覆盖控制。
- **分步持久化与中断恢复**：步骤结果与已发送消息分别持久保存；后续步骤失败保留已确认送达部分，相关新消息到达会取消剩余未发送计划并触发重新判断，其他会话互不干扰。
- **过程元数据**：`reason` / `intention` 记录简短行为理由与后续关注点（不发送给平台，不记录逐字内部思考）；停止、切换角色或清理会话时同步取消未执行步骤。
- **提示词分工**：入口 Schema 规定精确参数，`prompts/social_rules.md` 维护跨操作行为指导，适配器提供平台变量与能力差异；不在模型提示词中混入存储、调度或迁移内部细节。

### 1.3 平台业务能力并集

下述能力为各平台适配器的功能并集，实际开放项以当前平台和账号授权目录为准：

- **日常社交**：联系人与资料查询、备注修改、好友申请与删除、历史消息拉取与转发、图片按需读取与资源获取、收藏表情管理、资料卡点赞、戳一戳、消息回应与撤回、已读上报、联系人记忆、主人私聊模式与状态卡片。
- **群事务**：群资料与成员列表、群名片、群名与群头像、禁言与成员管理、入群申请处理、群公告与精华消息、群文件与目录、群相册查询上传及互动。
- **账号与空间**：资料、签名、头像、在线状态设置；文字与多图说说发布、可见范围设置、发布记录查看与删除；好友动态、说说列表与详情、点赞、评论和转发。
- **工作控制与宿主联动**：任务控制、私有心流与宿主通信按当前身份条件注入 `call` 目录；等待与延后由 `social_act` 行为参数统一承担。

---

## 2. 人格、账号隔离与跨端闭环

### 2.1 统一身份与会话隔离

- 桌面与社交共用同一个 `agentId`。`AgentAccountIdentity` 区分人格、平台与账号，`AgentConversationIdentity` 进一步区分私聊、群聊与会话标识。
- 各入口共享人格与已授权工作状态，而历史记录、私有心流与发送权限严格按会话隔离。已绑定平台的主人私聊可通过 `call` 调用 `manage_task` 查询同一人格下的任务，任务结果仍按创建时的原始来源渠道投递。
- 社交使用独立上下文编译器读取本会话历史与 Realm 心流；显式宿主咨询携带真实 Realm，仅将应用提交的请求与辅助资料交给角色处理并返回原应用，角色级长记忆沿来源与授权边界接入。

### 2.2 宿主能力收窄（`SocialHostCapabilityPort`）

- 宿主通过 `SocialHostCapabilityPort` 向社交运行时提供当前工作摘要与浏览器工具，每次调用重新核验平台、已连接账号与主人身份。
- 仅已绑定主人私聊获得该端口的浏览器能力，普通联系人与群聊不继承主机权限；端口复用主应用的 `RegistryToolExecutor`、策略校验、审批、取消与回执，不提供通用终端或直接读取 Cookie 的接口。视觉能力关闭时裁剪截图工具，客户端浏览器离线时不生成对应工具定义。
- 浏览器登录分区按人格与平台账号派生，各会话独立持有活动页面，后台任务继承来源账号登录分区并使用自己的页面会话；页面切换、关闭、下载记录与站点存储均受该分区约束（模型参数无法覆盖宿主绑定），NIT 内部调用继续沿用同一范围。

### 2.3 主应用委派、交接账本与取消顺序

- 主应用 `interact_with_social` 显式接收 `platform` 与 `account_id`，经后台任务系统持久化派发并返回任务编号；执行器使用稳定关联号调用应用清单中的 `chat_in_group`（参数含 `group_id`、`intent` 及可选 `platform`、`account_id`，多候选时显式选择）。
- 托管编排返回 `waiting` 后，任务续行通过 `get_task` 查询直至真实终态才提交交付；取消动作传播至 `cancel_task`，派发记录丢失时进入阻塞状态以防重复发送。委派任务继承父 Execution 上下文，且不占用后台槽位等待同类槽位。任务、宿主咨询与每日记忆回流统一按当前 Persona Grant 路由。
- 普通后台任务向私聊投递结果时，先以稳定投递编号写入原私聊历史，再发起平台发送；历史中的“已生成”与平台送达状态分离，发送失败或结果不明由 `TaskDelivery` 独立账本持续跟踪。父任务等待子任务时获取实际结果、失败原因、产出引用与验证等级。
- 取消或修订任务时，同一修订事务记录 `cancellationPending` 意图，先撤销全部子任务再收口外部委派；应用离线或进程中断后由续行扫描重试取消，旧委派未收口前不执行修订后的新任务，也不移除尚未完成的取消记录。

---

## 3. 适配器架构、配置与存储范围

### 3.1 通用边界与操作路由

- 通用运行时仅依赖 `ISocialAdapter`（`packages/apps/social/adapters/ISocialAdapter.ts`）、`SocialOperationProvider` 与存储端口。`adapters/registry.ts` 是内置适配器装配根，注册了 NapCat（QQ）、微信 iLink 私聊、Telegram Bot 与 Discord Bot。
- 平台协议实现（如 OneBot 原始字段、数字 QQ 号、`message_seq`、QQ 原生表情与空间访问）全部收敛在 `adapters/napcat/` 目录内，新增平台无需向通用调度器或宿主桥接层添加协议分支。
- `SocialOperations` 按可信入站现场绑定平台路由业务，`SocialCommonOperations` 提供本地群状态机与机器人标记等通用能力；各平台仅暴露自身支持的动作。
- 多平台配置下，业务调用省略平台选择且无法由回合推导时明确失败；普通联系人禁止切换账号，群状态配置即便在主人回合也仅限修改当前账号的当前群；私聊会话标识不要求等于主人用户标识。
- 动作权限元数据由操作提供者声明并交给宿主策略执行器审批；内部权限元数据不透传给模型，未知社交动作按保守策略审批，平台执行器在运行边界再次复核权限。

### 3.2 连接配置与传输生命周期

`social.connections` 数组描述各平台连接，每项包含 `id`、`adapter`、`enabled?`、`ownerId?` 及适配器专属字段：

```json
{
  "connections": [
    { "id": "qq", "adapter": "napcat", "ownerId": "12345678", "enabled": true }
  ]
}
```

- 每个平台注册单一网关实例管理多个登录账号，禁止配置重复平台或重复连接标识（不允许多消费者重复消费入站消息）。平台 ID 为小写协议标识，用户、账号、会话与消息 ID 均为有长度限制的不透明字符串。
- **旧配置兼容**：缺少 `connections` 的旧配置在装配根自动转换为默认 NapCat 连接，兼容顶层 `ownerQq`、旧群策略与无前缀名单。新名单采用 `平台:标识` 格式，无前缀旧身份仅归属声明兼容的旧适配器。
- **动态重载**：配置更新串行执行；变更主人配置会撤销持有旧身份的会话，禁用或替换连接先注销业务提供者、释放传输入口并触发 `disconnect()` 清理重连与监听，停止时优先取消等待中的 `connect(signal)` 操作。
- **反向 WebSocket**：宿主传输入口为 `/api/social/ws?platform=qq`，通过请求头申报账号，宿主不读取 OneBot 字段；仅存在唯一传输入口时兼容省略 `platform` 参数（多入口时拒绝隐式回退，Electron 生成的 NapCat 配置已显式附带平台）。新装配统一调用 `registerSocialTransport`。

### 3.3 身份存储与迁移

- 消息、会话、回合、队列、删除屏障、重放上下文与群策略均按 `(角色, 平台, 账号, 会话类型, 会话标识)` 隔离；消息表唯一键为 `(角色, 平台, 账号, 会话类型, 会话标识, 消息标识)`，所有消息查询在数据库执行 `LIMIT` 前强制施加身份筛选，无法定位身份的旧查询直接失败。
- 入站消息在适配器边界转换为 `messageId`、`accountId`、`timestampMs`、`isMentioned`、附件与引用等规范字段，保留原始诊断负载；历史分页游标为不透明字符串，由各适配器自行解释。
- 迁移脚本 `0023_social_platform_scope.sql` 为回合与删除屏障补全平台范围、重建消息唯一索引与待处理队列；旧回合按已保存规范事件回填，缺失历史身份时兼容归属 `qq`。

---

## 4. 设置界面的平台层级

前端设置沿用直角像素风（平台入口、图标底座、面板、输入框、标签与二维码容器均使用直角边框），组件位于 `packages/frontend/src/components/social/`：

- **一级平台导航**：QQ、微信、Telegram、Discord 始终作为独立一级入口展示；进入未启用平台页面不会自动开启连接。各平台内部提供连接与账号、联系人与本平台会话数据清理（按当前平台过滤）。
- **各平台专属页**：
  - `QqSettings.vue` + `platforms/NapcatSettings.vue`：管理 NapCat 进程、管理页、日志与主人 QQ；收藏表情（`AccountStickers.vue`）与状态卡片（`StatusCardDesigner.vue`）作为 QQ 二级功能呈现。
  - `WeixinSettings.vue`：组织扫码二维码、扫码确认、验证码与私聊账号列表；过期二维码立即停止展示为可扫码状态，不提供群聊设置。
  - `TelegramSettings.vue`：提供 BotFather 指引、Token、群隐私模式确认、群组与论坛话题说明及数字主人 User ID。
  - `DiscordSettings.vue`：提供 Bot Token、Message Content Intent 指引、服务器与频道授权、线程权限及主人 User ID。
- **通用设置与全局清理**：`SocialCommonSettings.vue` 与 `SocialDataSettings.vue` 承载跨平台默认策略与影响全部平台的全局数据清理；切换设置页时自动取消在途管理请求、停止轮询并清除前端缓存的 Token 与验证码。

---

## 5. 群聊状态机与主动观察

### 5.1 回合分类与任务区分

- 普通社交聊天持久化记录使用 `kind: conversation`，主应用显式委派的单次工作使用 `kind: task`。工具调用、步骤失败、`pass`、`wait` 与编排不会把普通聊天升级为任务。
- 任务中心仅查询 `kind=task`，“社交回合”诊断面板（`SocialTurnPanel.vue`）保留恢复状态与诊断记录。旧数据按 `social:command:` 委派标识兼容分类（普通记录默认归为 `conversation`），存储层在终态 100 条裁剪限制之前先按 `kind` 筛选，防止日常聊天记录挤掉真实任务记录。

### 5.2 主动观察调度与参与节奏

- **每群独立窗口**：主动观察按平台、角色、账号与群 ID 独立维护 `nextReviewTime`，不共享跨群观察名额或全局冷却；共享请求限流仍作为资源保护机制存在，但不替代状态机。
- **默认观察参数**：收到新消息 `30s` 后具备首次观察资格，正常观察间隔 `180s`，触发需满足至少 `3` 条待观察消息且当前未处于运行、收集、重试、延后或托管编排阶段；轮询间隔 `10s`，默认 `0–8` 点静音，单批覆盖 `1–20` 条消息（主动观察仅提供判断窗口，不强制发言）。
- **活跃续聊与即时退出**：回复后保持 `120s` 活跃续聊窗口；提交 `pass` 立即退出 `engaged`（回合执行期间积压的普通消息留在观察缓冲等待下次批量观察，不再以 3 秒续聊窗口连续请求模型），排队中的新提及独立保留并在领取批次时优先纳入。私聊不应用群聊 PASS 退避。

### 5.3 PASS 退避与低活跃模式

- **连续 PASS 冷却**：群聊连续前三次普通 `pass` 依次施加 `10 / 20 / 60` 分钟观察冷却，第四次起进入 `mention_only` 低活跃。冷却期满仍需满足待观察消息门槛，不进行空轮询；修改策略或覆盖配置不会缩短已经生效的冷却截止时间。
- **计数重置**：新的明确群提及开始处理或模型实际回复会重置连续 PASS 计数与冷却；普通消息、重试与同一已完成回合恢复不重复累加或重置计数。
- **低活跃行为**：进入 `mention_only` 后，不会因普通消息堆积、时钟流逝或应用重启恢复自主观察；新提及可触发短暂交流，续聊自然到期或再次 `pass` 后回归低活跃。模型可通过 `social_act({"low_activity": true})` 主动进入（可与 `reply` / `messages` 合用，不能与 `wait` / `defer` / `yield` / `next: "continue"` 混用）。低活跃仅约束群自主唤醒，不暂停社交记忆整理与明确委派任务，委派任务也不改写群参与模式或退避计数。
- **状态持久化**：`socialActivityStore.ts` 按平台、角色、账号与群 ID 将模式、连续 PASS 次数、冷却截止时间与最后应用的回合 ID 持久化于配置键 `social.groupActivity`（不保存正文），串行写入成功后同步内存；Bridge 在连接适配器前加载该状态，加载失败时拒绝按默认活跃模式上线。

### 5.4 手动恢复、动态配置与 `end_participation`

- **管理面查看与恢复**：通用设置中的群聊节奏面板（`SocialActivityPanel.vue`）调用 `GET /api/social/group-activity/:agentId` 与 `POST /api/social/group-activity/:agentId/resume`，按已连接平台账号与群 ID 清除退避并重新按正常观察间隔等待，不复活历史旧计划，且不解除互聊资源保护。
- **动态群策略工具**：Agent 在 `social_act` 的 `call` 步骤调用 `social_group`：
  - `state_get`：`input: {group_id}` 返回当前生效策略、群覆盖、待观察消息数、当前阶段、门控原因与下一次观察时间。
  - `state_configure`：`input: {group_id, policy: {...}}` 更新 `proactiveGroupEnabled`、`minMessagesForReview`、`reviewIntervalSeconds`（`30–3600s`）、`nightSilenceEnabled`、`nightSilenceStart`、`nightSilenceEnd`，或传 `{group_id, reset: true}` 恢复继承默认策略。群覆盖存于 `social.mode.groupPolicies`（按平台、角色、账号与群 ID 索引），保存默认设置不覆盖运行时新增的群策略，外部配置改动即时同步。
- **重启动与结束参与**：重启后不恢复无账号的空观察会话，未完成回合与明确请求按原账号恢复，旧历史不重新作为新话题触发。`social_act.end_participation` 只退出当前会话的活跃续聊（不退群、不禁用会话、不影响其他群，禁与 `wait` / `defer` / `yield` / `next: "continue"` 混用）；纯 `pass` 可在互聊保护阻止继续发言时收尾（保留既有送达结果、不执行能力或发送、不重置保护预算），夹带步骤或消息的 `pass` 在参数校验阶段拒绝。

---

## 6. QQ 空间、操作日志与收藏表情

### 6.1 QQ 空间发布与浏览（`adapters/napcat/qzoneClient.ts`）

- **发布与删除**：调用 NapCat 原生 `send_qzone_msg` / `delete_qzone_msg`，每次发布记录 `tid`、正文、可见范围与时间（发表记录独立保留最近 500 条），删除后更新记录标记。可见范围支持 `public`、`friends`、`selected`、`private`、`exclude`，其中 `selected` 与 `exclude` 必须提供 `target_uins`。
- **浏览与互动**：通过 NapCat 获取当前账号临时空间凭据后访问固定空间 CGI 地址。凭据仅存于内存（不落盘、不传给模型），响应设置超时与大小上限，仅解析 JSON / JSONP 与动态数据（不执行返回脚本，不跟随重定向）。列表与详情返回绑定账号且 30 分钟有效的 `post_id` 供详情和互动引用；CGI 异常直接返回失败，不伪装为空列表。
- **协议核对参考**：[NapCat 4.18.38 Action](https://github.com/NapNeko/NapCatQQ/tree/v4.18.38/packages/napcat-onebot/action)、[空间发布实现](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-onebot/action/extends/SendQzoneMsg.ts)、[空间 CGI 参考](https://github.com/Eganchiyu/qzone-sdk/tree/main/src/qzone_sdk)。

### 6.2 结果不明的操作日志与恢复

- 写操作发出前写入操作日志并按账号串行执行。相同调用恢复时复用已完成结果，相同参数的 `pending` 或 `uncertain` 记录阻止自动重放；网络超时、取消、断连或投递后记账失败均进入 `uncertain` 态。
- 主人可通过 `social_account.operations` 检索记录，核实真实结果后调用 `operation_resolve` 人工标记为 `completed` 或 `not_sent`。未确认日志不随普通消息历史截断而删除。

### 6.3 按需读图、原生表情与收藏表情

- **按需读图**（`runtime/socialImageReader.ts`）：入站与引用消息默认只附带正文、占位及来源标记；模型可在 `call` 步骤调用 `social.image_read`（参数 `input: {message_ids, max_images?}`，`max_images` 为 `1–3` 默认 `3`），随后通过 `yield` 或 `next: "continue"` 回传当前模型。同一编排入口多个读图或视觉步骤共享去重后最多 3 张的多模态输出上限，超出数量计入 `images_omitted`。图片仅通过多模态分片传递，文字观察保留数量与来源（不复制 base64）；取消信号直接向上传播。
- **QQ 原生 `face` 表情**（`adapters/napcat/nativeEmoji.ts`）：`[QQ表情:编号]` 仅表示入站占位，存在真实图片资源时可读取画面，否则返回 `native_emoji_no_pixels`。复用原生表情需先调用 `emoji_list` 取得真实引用再以 `[native_emoji:来源引用]` 发送；NapCat 在长文拆分前与协议转换阶段均拒绝直接发送入站占位 `[QQ表情:编号]` 并返回 `DELIVERY_NOT_SENT`。
- **账号收藏表情**（`runtime/stickerService.ts`、`adapters/napcat/napcatStickers.ts`）：
  - 表情收藏归属平台登录账号（忽略历史 `use_stickers` 角色预设配置），仅在社交回合通过 `social` 目录调用 `sticker_list`、`sticker_search`、`sticker_read`、`sticker_collect`、`sticker_describe`、`sticker_delete`（内部 `social_sticker` 仅作路由兼容）。
  - 回复中使用 `[sticker:查询ID]` 引用，发送前按所在账号复核收藏有效性并交错发送文字与表情，失效标签静默过滤且不计为发送成功。
  - `collect` 接收当前会话 `message_id`、从 1 开始的 `image_index` 及最多 200 字描述，在 NapCat 主机端下载（兼容分机部署）；无视觉能力的模型调用 `read` 时返回现有文本描述。
  - **NapCat 接口与确认机制**：底层调用 `fetch_custom_face_detail`、`add_custom_face`、`set_custom_face_desc`、`delete_custom_face`、`download_file`。`download_file` 未指定文件名时按文件 MD5 命名用于去重与确认，删除使用 `resId`；写操作串行并在完成后重新拉取列表核验。收藏成功但更新描述失败时返回已收藏 ID 与警告，超时或结果不明时提示先同步核实。列表缓存 30 秒，单次最多拉取 4096 条（超限返回 `truncated`），工具默认每页 20 条，前端 `AccountStickers.vue` 每页 30 条（保留 GIF 动图并在卡片内完成删除确认）；图片预览限制 `20 MB` / `15s`（仅允许 PNG、JPEG、GIF、WebP）。

---

## 7. 微信、Telegram 与 Discord 接入

### 7.1 私有凭据隔离与通用收发契约

- **私有存储**：连接凭据与接收游标使用 AES-256-GCM 加密文件保存于 `@data/social_private`（密钥同处该私有根目录，原子临时文件替换写入，同连接写操作串行），不写入可导出的 `social` 配置；管理接口仅返回账号标识、连接状态与稳定错误码（登录与管理响应禁止缓存）。媒体缓存按内容哈希保留 7 天、最多 200 文件 / 约 `256 MiB`，单附件上限 `25 MiB`（Telegram 下载上限 `20 MiB`）。
- **收发与就绪契约**：
  - `deliverMessage(message, signal)` 仅在规范消息与队列持久提交（或按策略明确忽略）后确认，入库失败不推进游标，停止或迟到入库不重激活已停止状态机。
  - 微信与 Telegram 在持久落盘后确认游标；Discord 先存入私有待处理队列并在失败时保留重试，同时利用 SDK 会话恢复与频道历史分页补拉提升连续性。
  - 原始 Token、上下文令牌、媒体密钥与带凭据下载链接不进入通用消息记录，由适配器完成下载或解密后再交付本地文件。
  - `canObserveGroup` 独立门控群主动观察资格；`getSendReadiness` 在发送与任务投递前核验前置条件（例如微信缺少对端上下文时拦截发送）。
  - 发送账本生成 `deliveryId` 用于平台侧去重（Discord `nonce`、微信 `client_id`）；不以请求已接受代替服务端消息号或对端已读，分段失败与网络异常继续进入 `uncertain` 恢复链路。

### 7.2 平台实现特性

- **微信私聊**（`adapters/weixin/weixinAdapter.ts`）：
  - 基于 [Tencent/openclaw-weixin 协议说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md) 与 [扫码实现](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts) 独立实现 `weixin-ilink` 协议（固定兼容版本 `2.4.10`，不依赖 OpenClaw 运行时）。
  - 支持扫码登录、验证码、服务重定向、二维码过期与取消，扫码确认身份可作为默认主人候选。每账号独立维护 `get_updates_buf`、对端上下文（不预设固定有效期）与长轮询取消信号；支持文字、图片、视频、文件（经加密 CDN）及带转写文本的语音附件。文本与媒体使用独立请求，部分成功时保留 `uncertain` 账本状态。当前仅支持私聊，不声明群聊、好友目录、朋友圈或远程历史能力。
- **Telegram**（`adapters/telegram/telegramAdapter.ts`）：
  - 使用 `telegram-bot`，基于 grammY 客户端与自控确认顺序的长轮询。存在远端 Webhook 时拒绝启用（不擅自移除旧部署），遇到 `409` 消费冲突时提示排查其他正在运行的部署实例；账号、`chat ID`、论坛话题 `thread ID`（含在不透明会话标识内）与发送者独立映射。
  - 启用主动群观察需在管理页确认开启完整群读取，并在 Telegram 关闭隐私模式或赋予管理员权限（未开启仍可响应命令、提及与私聊）；原生 `is_bot` 自动接入互聊保护。消息正文默认纯文本，结构化提及单独转换为 Telegram 实体；当前不声明任意远程历史、好友目录或全量成员枚举。
- **Discord**（`adapters/discord/discordAdapter.ts`）：
  - 使用 `discord-bot`，基于 discord.js Gateway + REST；仅申请必要 Intent，启用主动群观察前需在开发者后台打开 Message Content Intent 并授予频道查看、历史读取与发送权限（不申请全量成员或在线状态）。
  - 私聊频道、文字频道与帖子线程各自独立维护会话，支持按不透明游标分页补拉已有频道历史；结构化提及采用明确用户白名单，默认关闭 `@everyone`、角色提及与隐式回复提及；关闭 SDK POST 自动重试防止结果不明时重发，断开时销毁 Gateway 并清理收件箱任务。当前不提供语音频道、屏幕共享及管理写操作。
- **发行与联调约束**：`grammY`、`discord.js` 等作为 Social 生产依赖由依赖收集器递归打包，发行版本需实测解析版本、适配器加载与媒体缓存路径；平台账号权限、限流、二维码有效期与设备兼容性须以真实账号联调为准。

---

## 8. 社交上下文编译与源码导航

### 8.1 `SocialAppCompiler` 上下文来源

`SocialAppCompiler`（`runtime/compiler.ts`）独立于主应用 `ContextCompiler`，各材料来源与默认编排位置如下：

| 材料 | 来源与作用域 | 默认编排位置 |
| --- | --- | --- |
| 人格及称呼 | Persona Grant、角色配置（`owner_appellation` 仅影响称呼表达） | 稳定人格与规则区 |
| 长期社交记忆 | 应用私有 `social.tdb`（`SocialScorer` 维护，BM25 / 关键词检索） | 动态区 `long_term_memory` |
| 原生对话历史 | 当前角色、平台、账号与会话范围的持久消息 | 原生 `user/assistant` 历史 |
| 联系人印象 | 当前触发者的持久印象资料（仅作背景资料，不构成授权） | `social_context` / `contact_context` |
| 跨会话私聊 | 群场景读取触发者最近私聊（≤10 条，存储层在 `LIMIT` 前限制平台与账号） | `social_context` / `cross_session_private_chat` |
| 身份与平台现场 | 可信入站消息、绑定账号与适配器 | `social_session` / `current_social_turn` |
| 私有心流 | `Realm × 平台 × 账号 × 会话类型 × 会话标识 × Agent` | 动态 `flow_state` |

- **作用域隔离与降级**：跨会话记录由 `socialStorageScope.ts` 在数据库查询 `LIMIT` 前限制平台和账号；补充读取失败时可缺省对应材料，不阻断当前群聊回合。
- **受管理框架与状态隔离**：通过 `prepareManagedFramework` 获取生效框架快照并生成历史与 `turn_context`，缺失时回退编译器默认编排。主应用的 `mood / vibe / mind` 三状态与桌面会话心流不传入社交编译器，模板按通道隔离对应变量。主提示词工作区见 [B17](./B17_PROMPT_WORKSPACE.md)。
- **预览排查**：预览提示“示例变量未提供”仅说明示例 JSON 未填充该变量，排查时需区分预览示例、生效框架、Compiler 实参变量与最终请求负载。

### 8.2 源码导航与扩展规范

除跨越包边界的文件外，下表路径均相对于 `packages/apps/social/`：

| 职责 | 源码入口 |
| --- | --- |
| 入站装配、授权与能力目录 | `runtime/index.ts`、`packages/shared/src/socialTools.ts` |
| 入口参数与步骤编排 | `runtime/socialActDefinition.ts`、`runtime/socialOrchestration.ts` |
| 上下文编译与社交记忆 | `runtime/compiler.ts`、`runtime/socialScorer.ts` |
| 存储作用域与数据库实现 | `runtime/socialStorageScope.ts`、`packages/backend/src/applications/sqliteSocialStoragePort.ts` |
| 通用操作与平台业务路由 | `runtime/socialCommonOperations.ts`、`runtime/socialOperations.ts` |
| 适配器注册与平台实现 | `adapters/registry.ts`、`adapters/napcat/*`、`adapters/weixin/weixinAdapter.ts`、`adapters/telegram/telegramAdapter.ts`、`adapters/discord/discordAdapter.ts` |
| 提示词模板与任务 | `prompts/social_rules.md`、`prompts/abilities/sticker_expression.md`、`prompts/tasks/social_segment_summarizer.md` |
| 前端平台与管理面板 | `packages/frontend/src/components/social/` |

新增平台须实现规范消息映射、完整身份作用域、取消传播、投递回执与可选能力声明；新增操作须同步完善参数校验、权限元数据、平台执行器与结果不明恢复，不引入通用核心的平台特殊分支。
