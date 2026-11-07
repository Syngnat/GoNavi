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

## 阶段状态

| 阶段 | 状态 |
|---|---|
| Phase 0 工具链与最小启动器 | 完成 |
| Phase 1 桌面适配层与前端绑定 | 完成 |
| Phase 2 原生多窗口 | 应用窗口完成；插件窗口保留 v2 子进程隔离 |
| Phase 3 平台能力 | 单实例、深链、文件关联、文件拖放、启动显示握手、macOS 基础菜单完成；更新器待决策 |
| Phase 4 构建 | v3 二进制构建脚本与 Windows 编译 CI 完成；安装器待迁移 |
| Phase 5 清理 | 待 v3 正式发版后执行 |

## 待办

1. **插件窗口隔离**：v3 同进程窗口会让插件 JS 直接触达全部 Go Service，因此当前让插件窗口继续跑在 v2 子进程（`PluginController` + token 回环桥）。后续若要去掉 v2 依赖，需要先实现按窗口限制绑定或独立 helper 进程。
2. **更新器决策**：`app.Updater` 做的是原子替换二进制并重启，与 GoNavi 现在的「下载安装包 → 安装器升级 → 重启」模型不同；Windows MSI/NSIS 场景不应直接替换二进制。暂保留自研更新链路，待产品决策。
3. **打包发版**：接入 `wails3` Taskfile / `build/config.yml`，重做 NSIS/MSI/DMG/AppImage、签名公证、协议注册、npm CLI 与下载源校验；当前只有 v3 二进制编译 CI。
4. **macOS 菜单本地化**：基础 App/Edit/Window 角色与 SQL 菜单已接入，偏好设置菜单（语言/主题动态重建）仍待迁移。
5. **清理**：v3 正式发版后删除 v2 专属窗口补丁（`StartupWindowGate`、WebView2 边界刷新、MSI 单实例、重启父进程握手等）与未使用的 v2 依赖。

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
