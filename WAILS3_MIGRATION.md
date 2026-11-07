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
- 文件关联：声明 `.sql`，并转发 `ApplicationOpenedWithFile`。
- 原生深链：`ApplicationLaunchedWithUrl`、二次启动参数与冷启动参数统一转发现有的 `gonavi:deeplink` 事件。
- 前端资源嵌入 `frontend` 包，v3 二进制自包含，可从任意目录启动。

## 待办

1. **插件窗口**：v3 同进程窗口会让插件 JS 直接触达全部 Go Service，失去现有子进程隔离。需要先决定隔离方案（保留子进程 / 按窗口限制绑定 / 单独 helper 进程），再迁移 `internal/nativewindow` 的插件窗口桥。
2. **macOS 菜单**：把 `menu.AppMenu/EditMenu/WindowMenu` 与偏好设置菜单迁到 `app.Menu`，并验证动态语言/主题重建。
3. **更新器**：评估 `app.Updater` 替换自研 manifest + 重启父进程方案（保留 `download.syngnat.top` 下载源与签名策略）。
4. **打包发版**：接入 `wails3` Taskfile / `build/config.yml`，重做 NSIS/MSI/DMG/AppImage、签名公证、npm CLI 与下载源校验；当前只有 v3 二进制编译 CI。
5. **清理**：迁移完成后删除 v2 专属的窗口补丁（`StartupWindowGate`、WebView2 边界刷新、MSI 单实例、重启父进程握手等）与未使用的 v2 依赖。

## v2 特殊方案与 v3 原生能力对照

| 现状 | v3 |
|---|---|
| `internal/nativewindow` 子进程多窗口 | 已替换为 `V3Manager` + `application.WebviewWindow` |
| MSI 命名互斥单实例 | 已替换为 `Options.SingleInstance` |
| 自注册协议 + macOS `OnUrlOpen` | 已接 `ApplicationLaunchedWithUrl`；安装器协议注册待打包阶段 |
| 自研更新 manifest + 重启父进程 | 待评估 `app.Updater` |
| `StartupWindowGate` / WebView2 边界刷新 | 待清理，v3 窗口 options 与 hooks 替代 |
| 全局拖拽 | 已启用每窗口 `EnableFileDrop`；`gonavi:file-drop` 转发待接 Go 事件 |
| macOS dock 菜单 Objective-C | v3 暂无对应 API，保留 |
