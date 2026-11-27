/**
 * @file 桌面操作护栏
 * @description 设备首次使用时默认关闭程序审批。用户开启后，桌面自动化按程序分区询问或拦截。
 *
 *              - 名单：内置草案 `packages/shared/src/safety-lists.draft.json`（与工具执行审批共用，打包进应用，需审阅定稿）+ 用户数据目录
 *                `desktop-safety.json`（普通区模式、追加的禁区 / 高危区、信任名单；用户可手动编辑，加载时校验）。
 *              - 用户文件带签名：在应用外修改（包括角色的文件工具）时，收紧的部分立即生效，放宽的部分要用户在
 *                设置页点「接受修改」并在独立审批窗口中同意；之前接受过的版本另存为 `desktop-safety.accepted.json`。
 *              - 主进程通过独立沙箱窗口取得用户决定；infOS 自己的进程属于内置禁区。
 *                审批后执行器复核目标和画面，发生变化时要求重新观察。
 *              - 角色可以收紧设置（立即生效）、申请放宽（独立审批窗口）、提交任务预批、关闭总开关；不能打开总开关。
 *
 *              按职责拆分：`desktopGuardModel`（通道与结构）、`desktopGuardCore`（名单、设置与审批）、
 *              `desktopGuardPrompt`（独立审批窗口）、`desktopGuardHandlers`（单例与接入点）；本文件统一再导出。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 2
 * @module electron/main/services/desktopGuard
 */

export * from './desktopGuardModel'
export * from './desktopGuardCore'
export * from './desktopGuardPrompt'
export * from './desktopGuardHandlers'
