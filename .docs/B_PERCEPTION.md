# 桌面感知与手动陪看

> **适用范围**：桌面环境采样、耳朵识别、临时感知上下文与陪看插话调度

---

## 1. 设置与采样来源

- **配置管理**：「感知与桌宠」设置对应用户数据目录下的 `desktop-home.json`（共享结构定义在 `packages/shared/src/types/perception.ts`），常驻授权使用独立的 perception 分区并按版本迁移。
- **采集与脱敏**：前台窗口与环境事件（空闲、全屏、后台任务完成）由 Electron 主进程采集；过滤与脱敏在客户端完成后，通过持有管理 Bearer 凭据的原生入口上报（限定来源、长度、图像数、序号与过期时间）。
- **耳朵识别**（`electron/main/services/ears/`）：模型文件按用户操作下载校验（`earsModel.ts`），在独立 `utilityProcess` 中加载 `sherpa-onnx-node` 运行识别；音频源切换、停止与进程退出共用代次清理。

---

## 2. 临时上下文与主动感知

- **短期快照**：`PerceptionSnapshotStore` 在内存中保留短期快照，单次续期最长 12 秒。普通桌面执行由 `perceptionTurn.ts` 附加 `transientSource=perception` 临时消息（按模型视觉能力与选项决定是否附带图像）。
- **场景隔离**：据点、Realm、后台任务与主动执行各自通过对应入口获取感知上下文，普通桌面入口不接入据点适配器。执行审计、热轨迹与检查点使用去除临时消息并脱敏后的副本。
- **主动感知发言**：通过受限的 perception 作用域运行，模型可自主判断是否发言；正式回复写入主线独立消息，过程归属于当前 Execution（主侧与据点合同见 [B26 主侧会话](./B26_MAIN_SIDE_THREADS.md)）。

---

## 3. 手动陪看与停止边界

- **启动与校验**：用户发起陪看后，`take_screenshot` 以 `watch.start` + `companion=true` 开启观察与间歇插话。工具入口与插话入口共用 `isWatchAlongMainThread` 校验角色主线与当前代次；侧会话请求会提示在角色主会话中开启。
- **时钟与优先级**：Electron 维护画面活动、播放时钟、发言间隔与小时配额，后端再次核对角色、主线、忙碌状态、许可与预算。用户输入拥有最高优先级，会立即让陪看执行让位，停止、失联、过期或角色切换均取消旧回合；语音复用角色 TTS 座席并在播放后清理临时音频。
- **代次停止与恢复**：硬停止、暂停、音频源切换与设置变更通过许可代次同步传播至主进程与后端；待补图请求在发送前复核代次与过期时间，确保过期录音、图像与执行结果被安全丢弃。重启后依据已保存设置与有效许可恢复状态。

---

## 4. 源码入口

- **Electron 端**：`electron/main/home/`、`electron/main/services/home/`、`electron/main/services/ears/`、`electron/main/services/companion/`
- **后端服务与路由**：`packages/backend/src/services/perception/`、`services/companion/`、`services/conversation/perceptionContext.ts` 与 `perceptionTurn.ts`、`routers/watchAlong.routes.ts`
- **前端组件**：`packages/frontend/src/components/desktop/perception/`、`composables/usePerception.ts`、`composables/chat/useWatchAlongInput.ts`
