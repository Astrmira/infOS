# Channel、Thread 与角色路由

> **架构基线**：[A09_AIOS_ARCHITECTURE](./A09_AIOS_ARCHITECTURE.md)
> **最后更新**：2026-10-17

---

## 1. 持久Channel

infOS不再将`mode`作为Agent的可变全局状态。主应用Thread创建时写入不可变`channel`，当前联合仅包含：

| Channel   | 场景                                   | 上下文/运行时                   |
| --------- | -------------------------------------- | ------------------------------- |
| `desktop` | 标准桌面对话、语音输入、请求级陪伴行为 | PrincipalAgent Context Compiler |
| `group`   | Stronghold据点内部Agent视角Thread      | Stronghold Turn Runtime         |

- `group` 专属于 Stronghold，与 Social 及其他 Application 的会话体系隔离。
- `companion` 已退役为请求级 `ambient` Capability Scope，不再是持久 Channel；旧 Thread 已按迁移策略软删除。
- `social`、`arca`、`coding` 等为 Application Realm 身份或领域名称，不进入 `ThreadChannel`。
- `task` 为 Execution Class 或 Thread Purpose，而非 Channel。
- Channel 在单个 Thread 生命周期内固定不变；`lightweight` 为 Context Policy，而非模式。

## 2. Thread Purpose与请求作用域

`ThreadPurpose`用于区分持久记录用途：

```typescript
type ThreadPurpose = 'conversation' | 'background_task' | 'app_internal'
```

`capabilityScope = 'ambient'`是一次请求的收窄作用域，只能在所属Channel权限上做减法，不持久化为Thread属性，也不能解锁Skill或扩大资源范围。

## 3. 角色状态与执行归属

| 状态             | 含义                         | 权威位置                 |
| ---------------- | ---------------------------- | ------------------------ |
| Installed        | 存在可加载的Agent定义        | 官方/Workshop/用户资产层 |
| Enabled          | 可被调度或参与房间/路由      | Backend Agent状态        |
| Active（窗口级） | 当前窗口默认显示/交互的Agent | 前端UI状态               |

“Active”仅代表前端窗口级显示状态，而非后端全局状态。桌面对话由 Thread 的 `agentId` 决定，外部入站由 `InboundRoute` 决定，Scheduler 由 Task/Execution 自身的 `agentId` 和 `principalId` 决定，不以当前窗口或最后活跃角色推导执行主体。

## 4. Stronghold

- Facility 是据点实体，Room 是多人交互与权威消息流的最小单元。
- Dispatcher 根据 @提及、成员与调度策略决定 Agent 回应顺序。
- 每个 Agent 在同一 Room 拥有独立 `group` Thread，用于隔离人格、上下文与工具权限。
- 用户可见日志按 Room 权威消息流聚合，内部各 Agent Thread 统一收敛于所属 Room，不对外拆分为独立房间。
- Stronghold 永久归属主应用，不注册为 Application Realm。

## 5. Social 与入站路由

Social 由 `infos.social` Application Realm 运行时处理，使用 Realm 私有会话标识、Social Storage Port 与独立上下文编译流程，不创建 `social` ThreadChannel。

`InboundRoute(source, identifier)` 只负责把外部地址解析为目标 Agent 及可选会话复用信息。路由记录中的历史 `channel/threadId` 字段属于 Social 兼容输入，不用于扩充全局 `ThreadChannel`；Application 身份由 `appId/realmId` 表达。
