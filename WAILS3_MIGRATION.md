# Wails 3 迁移

分支：`feat/wails3`。目标为 Wails v3.1.0（2026-11-01 正式版）。迁移期间 v2 仍是默认构建与发版路径，v3 入口通过 `wails3` 构建标签并行编译。

## 硬前提

- Wails v3.1.0 要求 Go ≥ 1.26。`go.mod` 已升到 `go 1.26.10`，CI 通过 `go-version-file: go.mod` 自动跟随。
- 若本机遇到 `checksum database disabled by GOSUMDB=off`，执行 `go env -w GOSUMDB=sum.golang.org` 后可自动切换工具链。
- Wails v3 CLI：`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`。
- 构建 v3 二进制：`node scripts/build-wails3.mjs`（先构建前端，再 `go build -tags wails3`）。
- CI：`.github/workflows/wails3-build.yml` 在 Windows 编译并上传 v3 产物。

## 已完成

### 基座

- `go.mod`：Go 1.26.10 + `github.com/wailsapp/wails/v3 v3.1.0`；默认 v2 构建保持可用。
- `internal/desktop`：桌面运行时边界。`!wails3` 委托 v2 runtime，`wails3` 映射到 v3 的 Dialog / Event / Clipboard / Browser / Window；58 个调用点已改走该层。
- 根 `main` 包仅在非 `wails3` 构建参与编译；v3 入口为 `cmd/wails3app`。

### 前端绑定

- `frontend/src/platform/wails3Bridge.ts`：v3 下同步安装 v2 形状的 `window.go` / `window.runtime`，绑定与运行时调用等待 `window._wails` 后懒加载 `@wailsio/runtime`。
- 332 个 `wailsjs/go` 导入与 110 处 `wailsjs/runtime` 调用无需改动；v2 与浏览器模式完全不受影响。
- 资产服务在主窗口与分离窗口注入 `window.__GONAVI_WAILS3__`，阻止前端误装浏览器 mock。
- 实测：真实连接（7 条）与 AI 供应商（3 个）经 v3 绑定读取，主界面完整渲染。

### 原生多窗口

- `internal/nativewindow/manager_v3.go`：`V3Manager` 用同进程 `application.WebviewWindow` 替代子进程 + 回环 HTTP 桥。
- 分离窗口 URL 为 `/__gonavi/detached/window/<id>`，资产服务注入 `__GONAVI_DETACHED__`，复用同一套 `window.go` 绑定完成 Bootstrap / Action / Present。
- 实测：AI 分离窗口打开、真实渲染、关闭全链路通过；工作台与查询结果窗口走同一入口。
- v2 的子进程 `nativewindow.Manager` 仍保留，供 v2 构建与插件窗口使用。

### 平台能力

- `SingleInstance`：二次启动立即退出并聚焦主窗口，替代 MSI 命名互斥方案。
- 文件关联：声明 `.sql`，`ApplicationOpenedWithFile` 与二次启动参数都会打开 SQL 文件；冷启动链接在前端就绪后补发。
- 原生深链：`ApplicationLaunchedWithUrl`、二次启动参数与冷启动参数统一转发现有的 `gonavi:deeplink` 事件。
- 关窗与 Cmd+Q 走 v3 `WindowClosing` / `ShouldQuit`，复用既有的未保存确认（`app:before-close-request`），确认前不会退出。
- 前端资源嵌入 `frontend` 包，v3 二进制自包含，可从任意目录启动。

### 进一步采用的原生能力

- 窗口外观：`Frameless` / `MacTitleBarHidden`（保留交通灯）/ `BackgroundType` / `MacBackdrop`，低内存模式回退不透明。
- 窗口关闭：`RegisterHook(WindowClosing)` 同步拦截 + `ShouldQuit`；每次 `WindowRuntimeReady` 回滚刷新后遗留的 SQL 事务。
- 后端事件：`uievents.WithEmitter` 注入 `app.Event.Emit`，恢复 `app:before-close-request`、连接变更、导入导出/同步/图库进度、AI Agent 流等推送。
- 资产路由：`AssetOptions.Middleware` 接入背景图库、字体库、插件页资源中间件；dev 下保留 Vite 代理与 HMR。
- Windows：`WebviewUserDataPath` 复用 v2 profile、AUMID 启动前设置、`NativeWindow()` 取 HWND 恢复品牌图标、`SetZoom`/`SetBounds` 替代 v2 反射、孤儿 WebView2 回收、更新维护期拒绝启动；焦点守卫在 v3 下为无操作。
- 屏幕与坐标：`App.Screen` 全局 DIP 工作区 + `Window.GetScreen`；分离窗口 bounds 按工作区归一化，拔屏后不会开到屏幕外。
- 文件与目录：`Env.OpenFileManager` 打开目录/选中文件、`Browser.OpenFile` 打开导出文件；`.sql` 关联写入 MSI 与 AppImage desktop。
- 分离窗口：`Control.Hide/HideForAISettings` 经 `V3Manager`；文件拖放改用 `data-file-drop-target` 并转发 `DropTargetDetails`。
- 插件窗口：子进程已从 v2 `wails.Run` 迁到 v3 `application`（Services 为空、权限全 deny、独立 WebView profile、拒绝 `/wails/`、DLL 搜索目录收紧），仍保持独立进程隔离。
- 生命周期：`web-server`、`plugin` CLI、`--data-root` 与 `--disable-plugins` 安全模式在 v3 入口可用；dev 构建通过 `main.devBuild` 跳过单实例与 `gonavi://` 注册，避免抢占正式版。
- v3 二进制不再链接任何 `wails/v2` 包（`go list -tags wails3 -deps ./cmd/wails3app` 为 0）。

### 迁移审查修复

- 分离窗口协议与 v2 对齐：`ready` 不再转发给主窗口；原生关闭先否决并等待前端最终同步（10s 兜底）；`Bootstrap` 回填 `actionRevision`；`hide`/`open-ai-settings` 校验 `visibilityRevision`；`Open` 等待 ready（10s 超时回滚）；`Focus` 在 ready 前不再提前 Show。
- 窗口归属与状态：`OpenRequest.ownerWindowId` 与事件回传让嵌套分离窗口只更新来源窗口；`SyncHostState` 增加 `HostState` 重取；分离窗口启用 `EnableFileDrop` 并按窗口定向投递拖放事件。
- v3 入口补齐 v2 启动装配：AI Agent 工具目录（`internal/agenttools`）、MCP 客户端配置修复、更新重启父进程等待、更新维护闸门先于 headless、headless 失败返回非零退出码。
- 深链与文件打开：macOS 冷启动、第二实例与重载期统一排队到 `frontend-ready`；重载时复位就绪标记；文件路径去重并支持 `%u` 的 `file://` URI。
- 插件窗口：补齐 `UpdatePreferences`；插件页运行时阻止外部文件拖放导航，避免 WebView 被本地文件替换。
- 发版：Wails v3.1.0 无 WebKitGTK 4.0 构建路径，release/dev 的 4.0 矩阵行保留 v2 构建，4.1 行使用 v3；Linux desktop 的 scheme handler 改用 `%u`。
- UI 设置 origin：v3 窗口统一固定为 v2 的 origin（macOS/Linux `wails://wails/`，Windows `http://wails.localhost/`），不采用 v3 默认的 `wails://localhost`。因此当前 v2 latest、未来的 v3 latest 与 v3 dev 读取同一份 `lite-db-storage`，v2→v3 不需要搬 localStorage。`/__gonavi/legacy-local-storage` 与 Linux WebKitGTK 扫描保留给仍使用 v3 默认 origin 的构建，以及首次从 v2 升级的异常路径；当前固定 v2 origin 的构建不会依赖它：前端检测到 `wails://wails` / `http://wails.localhost` 会直接跳过迁移，避免把同一个库迁回自身。
- dev/latest 共享设置：Wails v3 的 `GetStartURL` 在 dev 下会把 Vite 端口写进 origin（如 `wails://localhost:9245`），因此不能依赖 v3 默认 origin。`resolveV3StartURL` 让所有 v3 窗口显式使用 v2 origin，`FRONTEND_DEVSERVER_URL` 只用于资源代理和 HMR；macOS 的 dev 构建同时放进使用生产 bundle id 的 `.app`，Windows/Linux 继续复用 v2 容器，因此 dev 与 latest 读写同一份 UI 设置。

### 有意保留的例外

- 插件窗口仍是独立进程：v3.1.0 没有按窗口限制绑定的原生沙箱，同进程窗口会让插件 JS 直接触达全部 Go Service；子进程内部已改用 v3 application，进程隔离保持不变。
- 更新器、web-server 内部（认证/多用户/TOTP）、自绘右键菜单、自定义快捷键、AI token 流（v3 Stream 需双传输适配）、系统通知、Autostart、macOS Dock 菜单、NSPanel、Windows 非客户区命中：要么与现有产品/安装器语义不兼容，要么 v3 无对应 API，保持现状并已在审计中确认。

### 开发闭环

- `Taskfile.yml` + `build/config.yml`：`wails3 dev` 启动 Vite（9245）并热重启 Go；`wails3 build DEV=true` 走快速开发构建，生产构建复用发版脚本。macOS 的 DEV 构建调用 `scripts/build-wails3-dev-app.mjs` 生成 `bin/GoNavi.app`（生产 bundle id `com.wails.GoNavi`），不再运行无 bundle id 的裸二进制。
- 资产处理器通过 v3 `AssetFileServerFS` 子请求注入 `__GONAVI_WAILS3__`/`__GONAVI_DETACHED__`，dev 下保留 Vite 代理与 HMR；插件窗口在 dev 下读取 `frontend/dist/plugin-window`。dev 窗口的 `URL` 由 `resolveV3StartURL` 固定为 v2 origin，HMR 仍连接 Vite 端口。
- 生产构建带 `production` tag（版本显示与 debug 环境正确）；Linux 带 `gtk3` tag 以匹配现有 GTK3/WebKit2GTK 依赖。
- `scripts/build-wails3.mjs` 复用 CI 平台脚本，本地产物与发版布局一致（含 Windows syso 与 macOS `.app`）。

## 阶段状态

| 阶段 | 状态 |
|---|---|
| Phase 0 工具链与最小启动器 | 完成 |
| Phase 1 桌面适配层与前端绑定 | 完成 |
| Phase 2 原生多窗口 | 完成；应用窗口走 v3，插件窗口保留 v2 子进程隔离 |
| Phase 3 平台能力 | 完成：单实例、深链、文件关联、文件拖放、启动显示握手、macOS 菜单（含语言/主题动态重建） |
| Phase 4 构建与打包 | 完成：release/dev 工作流默认使用 v3 构建，沿用现有 MSI/DMG/AppImage 打包；`GONAVI_WAILS3=0` 可回退 v2 |
| Phase 5 清理 | 完成：v3 路径不再包含 v2 窗口补丁；v2 代码仅作为回退构建保留 |

## 发版路径

- `release.yml` 与 `dev-build.yml` 的 Build 步骤默认调用
  `scripts/ci-build-wails3-release.sh`：按平台生成
  `build/bin/<build_name>.exe`、`build/bin/GoNavi.app` 或
  `build/bin/<build_name>`，后续 MSI/DMG/AppImage 打包步骤保持不变。
- 回退：在仓库 Actions 变量中设置 `GONAVI_WAILS3=0`，同一工作流改走
  `wails build`（v2）路径。
- 安装器仍沿用现有 WiX / create-dmg / AppImage 脚本；macOS 的
  `gonavi://` 与 `.sql` 关联由构建脚本写入 `Info.plist`，Windows 由应用启动时
  写入 HKCU 注册表（内置 AI 登录前会再确认），AppImage 的 desktop 文件声明
  `x-scheme-handler/gonavi`。三条路径都不再依赖 v2 构建产物。

## 更新器决策

保留现有自研更新链路，不切换到 `app.Updater`：v3 的更新器通过原子替换
二进制并重启完成升级，而 GoNavi 在 Windows 上以 MSI/NSIS 安装器升级、并带有
安装目录维护状态与重启父进程握手。直接替换二进制会绕过安装器状态与卸载
登记。`app.Updater` 仅作为未来「便携版 / 单文件分发」形态的备选评估。

## 已知边界

- 插件窗口仍是独立子进程（`PluginController` + token 回环桥），子进程内部已使用
  v3 `application`；保留进程隔离是因为 v3 同进程窗口无法提供按窗口的绑定沙箱。
- v3 的 macOS 插件子进程不再安装 WKWebsiteDataStore 非持久化 swizzle（该 cgo
  guard 在 v3 包内无法稳定链接）；v2 构建保留原实现，v3 仍依赖独立进程与窗口
  profile 隔离。
- v2 构建仍可用（`GONAVI_WAILS3=0`）作为回退通道。跨平台产物由 CI 发版任务
  验证：Windows amd64 已用同一脚本在本地实测；macOS/Linux 走相同脚本与既有
  打包步骤，下一次 release 产出 MSI/DMG/AppImage 时由工作流内的既有校验兜底。
- dev 与 latest 现在共享 `com.wails.GoNavi` 容器和 v2 的 `wails://wails/` origin，
  因此 UI 设置双向一致；两个实例同时运行时 WebKit 会并发打开同一份
  `localstorage.sqlite3`，切换通道前建议先退出另一个实例，避免 SQLite 写竞争。
- `build/darwin/Info.dev.plist` 的 bundle id 已改回 `com.wails.{{.Name}}`；
  代价是 dev 与 latest 复用同一份 macOS 图标缓存。
- 之前专门运行过 v3 preview 的机器，其 `wails://localhost` 库不会自动合并回 v2 origin；
  升级后以 latest/v2 的 `wails://wails` 库为准，避免两套 profile 互相覆盖。

## v2 特殊方案与 v3 原生能力对照

| 现状 | v3 |
|---|---|
| `internal/nativewindow` 子进程多窗口 | 已替换为 `V3Manager` + `application.WebviewWindow` |
| MSI 命名互斥单实例 | 已替换为 `Options.SingleInstance` |
| 自注册协议 + macOS `OnUrlOpen` | 已接 `ApplicationLaunchedWithUrl`；安装器协议注册待打包阶段 |
| 自研更新 manifest + 重启父进程 | 待评估 `app.Updater` |
| `StartupWindowGate` / WebView2 边界刷新 | 待清理，v3 窗口 options 与 hooks 替代 |
| 全局拖拽 | 已启用每窗口 `EnableFileDrop`，并按收到拖放的窗口定向投递 `gonavi:file-drop` |
| macOS dock 菜单 Objective-C | v3 暂无对应 API，保留 |
