# 运行时与依赖安全基线

> **适用范围**：客户端凭据生命周期、Node 运行时版本门禁、依赖漏洞审计回补与原生依赖发行校验

版本下限与安全公告来源统一由策略文件维护，每次审核与测试结果留存于 CI 与审计产物中。

---

## 1. 本机客户端凭据与请求恢复

- **短时读取复用与容错**：Electron 主进程 `clientCredential.ts` 读取当前数据目录 `client-access.json`：正常读取结果缓存复用 `1` 秒；遇到文件占用等临时 I/O 异常时最多复用最近 `5` 秒内成功读取的凭据，文件被删、损坏或切换数据目录时立即清除缓存。服务端仍逐请求验证凭据有效性，远程连接仅使用显式选定的服务器凭据而不回退至本机身份。
- **凭据发送与 401 处理**：可信主应用媒体拦截器仅补充缺失的非空 `Authorization`（不覆盖显式携带的身份），凭据 IPC 仅向可信窗口主帧开放，原始凭据不写入日志。前端仅向当前业务服务端附加凭据；遇 `401` 时本机 `GET / HEAD` 请求强制重读一次凭据，仅在取得不同的非空值时重试一次（写操作不重放，失效凭据不重复试，旧服务或旧凭据的迟到响应不触发当前登录退出）。
- **队列轮询鉴权收敛**：队列轮询未获本机凭据就绪时暂停业务读取；收到 `401` 后切换为间隔查询公开身份状态，确认就绪后再恢复队列读取，避免循环产生无效 `401`。

---

## 2. Node 运行时门禁与发行检查链

### 2.1 两类运行时判定边界

| 执行路径 | 实际运行时 | 判定依据 |
| --- | --- | --- |
| 源码后端、Linux 服务、Docker、CI 脚本 | 独立 Node.js | `nodeMinimums` |
| Electron 内置 Daemon 的 Node 模式 | Electron 内嵌 Node.js | `electronEmbeddedNodeMinimums` 与 Electron 基线 |

策略清单与实现分别为 `scripts/runtime-security-policy.json` 与 `scripts/runtime-security.cjs`：独立 Node 与内嵌 Node 分别核对主版本，未声明主版本及预发布版本默认拒绝；允许兼容例外时保留差异告警而不放宽独立 Node（Docker / Linux）门槛。升级宿主机 Node 不改变内置 Daemon 运行时，核验统一以目标可执行文件自身输出的 `process.versions` 为准。

### 2.2 五步发行检查链

1. `security:runtime`：核对 Node、版本清单、锁文件、Electron 配置与 Docker 镜像基线。
2. `security:electron`：探测本地 Electron 二进制（清理继承的 `NODE_OPTIONS`，不加载应用及用户数据）。
3. 标签发布流水线在业务构建前强制执行检查（覆盖标准版、Steam 与便携版）。
4. `scripts/electron-security-before-pack.cjs`：打包入口门禁检查（不可被安装器钩子绕过）。
5. `scripts/electron-security-after-pack.cjs`：核验最终解包产物的实际运行时版本，防止下载缓存或打包配置漂移。

变更运行时版本时需同步更新 `.node-version`、根 `package.json`、`pnpm-lock.yaml`、Electron 发行配置、Dockerfile 与工作流，具体版本下限以 `runtime-security-policy.json` 为单一权威。

---

## 3. 依赖审计与精确回补

- **审计与评估分离**：`scripts/dependency-security.cjs` 调用官方审计端点（`security:audit:raw` 输出原始结果 `TEMP/security-audit/raw.json`，`security:audit` 输出评估分类 `evaluation.json` 并执行门禁）。网络失败、不完整报告或缺失证据直接判定失败。
- **回补清单绑定**：`scripts/security-backports.json` 将每条精确回补绑定公告号、包名、精确版本、补丁文件、SHA-256 与回归测试；`pnpm.patchedDependencies`、`pnpm-lock.yaml`、实际补丁文件与清单必须完全一致，同包新公告、版本漂移、补丁失效或回归失败均会阻断。上游发布兼容修复后应升级依赖并成套清理补丁与清单项；回补仅抑制已验证行为风险而不改写原始报告记录：

| 回补对象 | 必须保护的安全行为 |
| --- | --- |
| `http-cache-semantics` 缓存重校验 | 清零或不可存储响应不被客户端 `max-stale` 重新激活；保留正常公开缓存，覆盖 `Cookie`、`private`、`no-store`、`no-cache`、`Vary` 边界 |
| `file-type` CommonJS 兼容链 | 校验 ASF 子头整数、最小尺寸与剩余长度合法性，防止负负载导致游标倒退，同时保留合法图像识别与 CommonJS API |

- **私有工作区 Importer 误报过滤**：针对审计工具将工作区路径末段与应用版本拼成同名 npm 包的误报，评估器仅在同时满足「属于私有包、真实包名不同、版本完全一致、无实际依赖路径、完整锁文件不存在同版本依赖」五项条件时予以识别过滤；混合 Finding 继续保留真实依赖风险（该过滤不影响 Electron 二进制门禁）。

---

## 4. 应用安全边界

- **主窗口隔离**：固定开启 `sandbox`、`contextIsolation`、`webSecurity`，关闭 Node 集成、`webview` 与混合不安全内容，附加窗口选项禁止覆盖上述安全配置。
- **桌宠资源协议与 CORS**：仅受理只读请求并核验 Origin；正式 `file` 页面与精确开发来源分别设置 CORS，不关闭 `webSecurity`。
- **外部浏览器视图**：使用独立内存 Session，默认拒绝浏览器权限请求与权限检查，网页内容不继承宿主权限。
- **窗口激活**：仅委托客户端 `WindowProvider` 处理，目标名称作为纯数据传递而不拼接进 Shell 或脚本；缺乏提供者、非法目标或激活失败分别返回稳定错误，不降级为本机命令行执行。
- **剪贴板异步提交**：写入必须 `await` 成功后才向调用方确认。

软件策略与 OS 隔离详见 [B01](./B01_PRODUCTIVITY_RUNTIME.md)，身份、Capability 与 Realm 授权链见 [M02](./M02_CAPABILITY_GATE.md) 与 [A09](./A09_AIOS_ARCHITECTURE.md)。

---

## 5. 原生依赖、Koffi 与构建目标边界

- **原生 npm 依赖构建**：TriviumDB、`node-pty`、`better-sqlite3` 等均通过 npm 接入（仓库不维护其 Rust 源码或 Cargo 工程）。`scripts/rebuild-daemon-deps.mjs` 按 Electron 声明重编 ABI，`scripts/collect-daemon-deps.mjs` 收集运行产物；升级时同步核对 ABI、存储格式、资源路径与目标架构。
- **Windows x64 Koffi 收集与产物 FFI 自检**：Koffi 3 用于全局按住说话、原生窗口图标与透明背景；原生二进制位于 `@koromix/koffi-win32-x64`。公共 `afterPack` 阶段调用 `scripts/electron-native-runtime.cjs` 从 Koffi 作用域解析同版本平台包，将二进制与许可证复制至 `resources/koffi/win32_x64/` 并记录版本、架构与 SHA-256（缺失即中止打包）。同一流水线随后复制最终 Electron 二进制并在独立 Node 模式子进程中从 `app.asar` 入口加载 Koffi、核对目录版本并调用 `user32.GetAsyncKeyState` 验证 Windows FFI（覆盖标准版、Steam 与便携版；实际交互体验另需实机验证）。
- **透明窗口与前端兼容目标**：Windows 透明窗口通过 Koffi 调用 DWM 仅关闭系统 backdrop（原接口不可用时保持透明配置），不使用易破坏透明合成的 Electron `backgroundMaterial`；维护需检查桌宠、开屏与通知窗的首次显窗与恢复显示。前端语法兼容目标集中定义于 `scripts/vite-browser-compat.ts`，需同时覆盖 `optimizeDeps` 预打包与正式产出（涵盖 Web、Electron、子应用与 Wiki 入口）。

---

## 6. 排查顺序与回归入口

- **排障顺序**：先区分问题归属（版本声明、实际二进制、上游审计、回补证据或原生收集），再定位并修改对应权威清单，保持失败报错完整透传；新增兼容例外时须明确作用域、差异说明与消除条件。
- **单元测试入口**：回补校验用例位于清单指定文件，运行时门禁与审计分类回归分别位于 `packages/shared/tests/runtimeSecurity.test.ts` 与 `dependencySecurity.test.ts`（涵盖过旧版本、漏洞依赖混入、缺失锁文件与补丁篡改等失败分支）。执行测试或构建指令需遵守仓库根目录 `AGENTS.md`。
