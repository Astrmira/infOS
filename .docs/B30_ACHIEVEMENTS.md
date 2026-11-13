# 成就与 Steam 提交

> **适用范围**：服务端内部成就系统、总览展示与 Electron Steam 提交适配器

---

## 1. 职责与身份边界

- **共享目录**：`packages/shared/src/achievements.ts` 定义成就目录与类型（服务端权威判定、前端展示、Electron 主进程负责 Steam SDK 提交，后端不直接依赖 Steam SDK）。
- **身份归属**：以鉴权后的 `ClientIdentity.id` 作为 `subject_id`，跨角色共享。使用同一管理凭据的客户端共用同一身份；不同配对设备各自独立，重新配对产生的新身份独立计数。
- **内部传入**：`chat.router` 从请求凭据解析身份后，向普通对话传入 `achievementSubjectId`；队列消息持久化该字段，在重启恢复时沿用原始提交者身份。

---

## 2. 成就目录与判定规则

当前内置成就为 **崭新启程**（内部 ID `fresh_start`，Steam API Name `ACH_FRESH_START`，描述：“完成与角色的首次有效对话。”）。

判定逻辑位于 `ConversationTurnService.persistAssistant`：

- 仅当输入来自普通 HTTP 对话入口（含 `achievementSubjectId`）、包含有效正文或已接收附件、属于 `desktop` 持久对话，且回复正文非空、未主动发起/交接/暂停/取消时触发达成（临时输出、后台任务、Realm 内部调用、续写/重生成及执行失败 `persistFailedAssistant` 均不计入）。
- `ThreadService` 将判定结果随回复传入 `ThreadRepository`，在同一 SQLite 事务内写入消息与达成行；复合主键 `(subject_id, achievement_id)` 保证幂等，事务回滚则同步撤销。
- 已有历史对话不自动追溯补记；删除单条对话、删除角色或重置记忆保留已解锁成就，恢复出厂设置清理内部记录。

---

## 3. 存储与接口

数据库迁移 `0024_achievements` 新增 `achievements` 表，记录 `subject_id`、成就标识、首次达成时间、来源消息、绑定的 Steam 账号及提交时间；`achievements.sourceId` 仅用于区分服务端通知来源。

- `GET /api/achievements`：返回当前鉴权身份的成就目录与达成状态。
- `POST /api/achievements/steam`：由已认证客户端认领 Steam 账号或记录 SDK 提交回执（`steamSubmittedAt` 表示本地 Steamworks SDK 已接受提交）；首次绑定 Steam 账号后保持锁定，不覆盖为其他账号，接口本身不接受客户端自报解锁。

---

## 4. Steam 适配与客户端投影

- **主进程同步**（`electron/main/services/steamAchievements.ts`）：独立读取已选服务端地址与客户端凭据，按本地目录中的 `steamApiName` 提交，流程为：检查 Steam 登录用户 → 拉取服务端快照 → 认领账号 → 调用 `steamworks.js` 接口 → 回写提交时间。每次异步返回后重新校验当前服务端、凭据与 Steam 用户一致性。
- **调度与容错**：启动后及每分钟定期补交，窗口收到回复通知或重新获得焦点时也会触发检查；Steam 不可用或后台成就未配置（见 `resources/steam/achievements/README.md`）时保留内部达成状态等待后续重试；账号不匹配时提示切换回首次绑定账号。
- **前端展示**：`useAchievementStore` 与 `useAchievements` 在鉴权后加载快照、监听连接恢复与窗口焦点；解锁通知按服务端来源、身份与成就 ID 去重，当本地 Steam SDK 已直接接受提交时抑制重复的应用内 Toast 提示。

---

## 5. 源码入口

- 共享定义：`packages/shared/src/achievements.ts`
- 判定与落盘：`packages/backend/src/services/conversation/conversationTurnService.ts`、`services/thread/threadService.ts`、`repositories/thread.repo.ts`
- 存储与路由：`packages/backend/src/repositories/achievement.repo.ts`、`services/system/achievementService.ts`、`routers/achievements.router.ts`
- Steam 与前端：`electron/main/services/steam.ts`、`steamAchievements.ts`、`packages/frontend/src/stores/useAchievementStore.ts`、`composables/system/useAchievements.ts`
