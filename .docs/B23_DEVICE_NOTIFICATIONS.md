# PeroperoChat 后台通知接入

infOS 负责通知持久化、设备鉴权、实时提示和分页补收；PeroperoChat 的原生接收服务负责本地收件箱、系统通知与点击导航。接收服务不依赖 WebView、聊天流、Live2D 或输入席位。Electron、源码服务和 Docker 使用同一协议，不需要额外部署推送服务器。

## 1. 设备凭据

扫描 infOS 的配对码后，向相同服务器发送：

```http
POST /api/client-access/pair
Content-Type: application/json

{"code":"配对码","name":"PeroperoChat 手机","remember":true,"credentialMode":"bearer"}
```

成功响应的 `data` 包含 `{deviceId, expiresAt, token}`，其中授权 `expiresAt` 为毫秒时间戳。原生端将此**设备令牌**写入安全存储，界面和后台服务共用同一令牌；后续 HTTP、WebSocket 握手携带 `Authorization: Bearer <token>`（区别于仅用于实例管理的管理员令牌，避免同一台手机重复配对）。默认浏览器配对仅写 `HttpOnly` Cookie 而不回传 `token`；`/login` 同样支持显式 `credentialMode`。

原生端独立于 WebView Cookie 存储，且不在日志或通知跳转参数中暴露 `token`。`expiresAt` 到期需重新授权；撤销设备或退出登录会使对应 WebSocket 失效。临时切换独立模式时仅断开订阅，**不调用 `/logout`**。

## 2. 轻量连接

连接 `<服务器同一入口>/ws/gateway`，HTTP 对应 `ws`，HTTPS 对应 `wss`。握手示例：

```json
{
  "protocolVersion": 1,
  "id": "每个请求的唯一 ID",
  "type": "hello",
  "sourceId": "peroperochat-background",
  "targetId": "backend",
  "timestamp": 1792627200000,
  "payload": {
    "profile": "notifications",
    "deviceName": "PeroperoChat 手机",
    "supportedVersions": [1]
  }
}
```

`hello.payload.token` 可省略。服务器优先使用 HTTP 升级时验证的设备身份，该兼容字段仅服务于未做传输层认证的连接，且仅校验设备令牌。`deviceId` 始终由服务器分配与绑定。

收到 `hello_ack` 后检查 `features` 包含 `notifications-v1`，并核对 `deviceId`。此连接仅开放 `gateway.notifications.pull`、`gateway.notifications.receipt`、`gateway.notifications.presence` 与心跳，不注册能力 Host，也不占用其他界面的 Node Session 或 Input Seat；其他业务请求返回 `GATEWAY_NOTIFICATION_ONLY`。

每 25～30 秒发送 `type: "heartbeat"`、空 payload，收到 `heartbeat_ack`。超过 90 秒无活动服务端会断开连接。原生端配置握手与心跳响应超时，采用带抖动且有上限的断线退避策略并在网络恢复时立即重连；遇认证失败或授权撤销则停止重试无效凭据并提示用户重新授权。

## 3. 实时提示与补收

所有 RPC 沿用上述信封，将 `type` 设为 `request`，`payload` 见下表；响应 `type: "response"`、`id` 与请求一致，数据位于 `payload` 中。

| 操作 | payload |
|---|---|
| 分页补收 | `{"action":"gateway.notifications.pull","afterSequence":0,"limit":50}` |
| 接收回执 | `{"action":"gateway.notifications.receipt","receipts":[{"notificationId":"…","revision":1,"state":"received"}]}` |
| 展示回执 | 同上，`state: "presented"` |
| 实际已读 | 同上，`state: "read"` |
| 前台状态 | `{"action":"gateway.notifications.presence","foreground":true,"threadId":"正在显示的会话"}` |

`hello_ack`、`heartbeat_ack` 均包含 `latestSequence`；新通知产生时另发 `push`，`payload` 为 `{"action":"notification_available","latestSequence":123}`。上述序号仅作为服务端水位提示（触发拉取），客户端分页游标仍由 `pull` 响应维护。

每次成功握手、网络恢复以及收到新序号提示后，串行拉取分页；若中途提示丢失，下一次握手或心跳也会发现游标落后。第一页 `afterSequence` 使用本地持久化游标（首次为 `0`），`limit` 取值范围 `1～100`。

补收进行中收到更高水位提示时记录最新目标水位；本轮完成后若本地游标仍落后则继续补收，确保不遗漏新通知。

分页响应：

```json
{
  "notifications": [{
    "sequence": 123,
    "notificationId": "conversation:thread-id:message-id",
    "principalId": "keromi",
    "revision": 1,
    "title": "可洛米 已回复",
    "body": "会话标题",
    "level": "info",
    "createdAt": "2026-10-21T08:00:00.000Z",
    "expiresAt": "2026-10-28T08:00:00.000Z",
    "source": "conversation",
    "target": {"kind":"conversation","agentId":"keromi","threadId":"thread-id","messageId":"message-id"},
    "presentation": "notify"
  }],
  "nextSequence": 123,
  "latestSequence": 123,
  "hasMore": false,
  "resetRequired": false
}
```

分页游标与序号覆盖该授权设备可访问的全部角色，跨重启持久化于数据库，独立于普通 Gateway 内存事件游标及当前选中角色。

**本地事务顺序：**

1. 以服务器实例、设备身份、`notificationId + revision` 去重，将整页通知与 `nextSequence` 一起持久化到本地收件箱。
2. 本地事务提交成功后再发送 `received` 回执（确保落盘后才确认接收）。
3. 按本地未展示队列触发系统通知；展示成功后持久化展示标记，再发送 `presented`。
4. 即使返回空通知页也持久化 `nextSequence` 作为下次拉取起点，并在 `hasMore` 为 `true` 时基于 `nextSequence` 继续翻页（而非跳用 `latestSequence`）。

每批回执上限 100 条。服务端返回 `{accepted}` 后移除该批待发回执；过时修订或已删除项目会被忽略而无需继续重试，失败则保留重试。重连后即使从零拉取也会自动过滤该设备已确认 `received` 的条目，**提交 `received` 回执后即由本地收件箱负责尚未展示通知的恢复**。每台设备仅运行一套原生通知消费服务，避免前端或界面再起第二套消费循环。

当数据库恢复到旧快照导致客户端游标高于服务器序号时，服务端返回 `resetRequired: true`；客户端保留本地去重记录并将游标复位为 `0` 重新补收。若用户主动清空本地通知库，建议重新配对为新设备以避免受旧设备 `received` 记录过滤。

## 4. 收到、展示与已读

- `received`：该设备已安全落盘通知，仅代表投递确认而非已读。
- `presented`：该设备已触发系统通知展示，与其他设备的待收记录互不影响。
- `read`：用户实际查看后提交，将通知标记为全局已读并停止其他设备后续补收（独立于任务中心自身的已读状态）。

旧桌面 `gateway.notifications.ack` 保留原有请求格式，认证设备的回执在服务端记录为该设备的 `presented`（各端独立跟踪展示状态）。已弹出的系统通知生命周期由本地客户端管理，协议层面不支持跨设备撤回已展示的系统通知。

## 5. 前台静默与导航

界面与后台复用同一设备身份，并使用各自独立的连接标识。界面打开目标会话时发送 `presence`，每 30 秒及会话切换时更新；退后台发送 `foreground:false`。前台声明 90 秒或断线后自动失效，普通心跳不续期。原生 Service 可代界面发送声明，并在界面退出后停止声明前台状态。

同设备正在显示目标会话时，分页条目的 `presentation` 为 `silent`（正常落盘并提交 `received` 回执，但跳过系统横幅，仍不标记为 `read`）；其余情况为 `notify`。原生端展示前复核当前实际界面状态与 `expiresAt`，防止网络传输途中用户已切至对应会话。

每台设备指定单一前台状态发布者（推荐由 Service 统一接收界面生命周期事件并上报），避免多方同时发冲突的 `presence`；若服务器根据租约推算的 `presentation` 与客户端实时界面状态不一致，以原生端当前真实界面状态为准。

`target.kind` 支持 `conversation`、`task`、`reminder`、`application`，按实际存在的 `threadId/messageId/taskId/scheduleId/applicationCallId` 导航。点击通知后核对服务器与当前模式，调用 HTTP 接口读取目标详情；若会话已删除、消息已撤回或任务不存在，仅显示简短提示并退回会话列表或任务中心。

## 6. 来源、过期与模式隔离

已接入普通桌面对话成功完成、已保存的主动消息、后台任务重要状态、定时提醒和应用创作结果。回复通知使用后台专用投递，保留现有 Electron 完成提醒，避免多弹一次桌面 Toast。通知生成时就写库，手机未连接也会记录；同一通知 ID 重试创建不会重复入库。

后台通道仅返回预览：标题最多 200、正文最多 1000 个 UTF-16 单元，不切断代理字符对。完整任务结果通过目标页面读取，不随通知传输工具记录或完整任务正文。

默认补收有效期为生成后七天；过期和全局已读条目不再补收。升级时只把近期未读历史通知纳入新补收序列，旧版本已展示的历史通知不重新轰炸。任务或应用删除后的既有通知抑制规则继续应用。

只有 PeroperoChat **远程模式**允许启动此服务。模式必须由手机持久保存：切回独立模式时关闭通知连接、取消重连和在途请求，停止展示旧服务器队列；切回远程模式再按服务器与设备恢复收件箱。模式切换、退出登录、撤销授权都应让旧连接的异步回调失效。切换模式不停止 infOS 服务端任务，不修改服务器全局模式。

服务被系统停止、手机断网或 infOS 未运行时，实时连接不能投递；服务恢复连接后再补收。Android 的后台存活和系统通知权限由移动端实现。

## 维护入口与协议验证

服务端通知持久化入口为 `packages/backend/src/repositories/durableNotification.repo.ts`，设备目标筛选位于 `packages/backend/src/services/gateway/notificationTargetFilter.ts`；Web 客户端补收逻辑为 `packages/frontend/src/composables/main/useRemoteNotifications.ts`。迁移 `packages/backend/src/database/migrations/0022_device_notifications.sql` 定义对应持久结构。

协议回归验证围绕设备隔离、游标分页、重复回执、失效连接、前台状态过期与配对撤销展开（移动端系统后台保活与通知权限需结合移动端实机环境验证）。故障排查依次核对持久通知记录、目标设备筛选、补收游标与 `received`/`presented`/`read` 回执状态，区分服务端生成、投递确认与客户端实际展示三个阶段。
