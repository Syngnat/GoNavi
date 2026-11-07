# Wails 3 迁移

分支：`feat/wails3`。目标是 Wails v3.1.0（2026-11-01 正式版），v2 桌面构建在迁移完成前保持默认可用。

## 硬前提

- Wails v3.1.0 要求 Go ≥ 1.26。`go.mod` 已升到 `go 1.26.10`，CI 通过 `go-version-file: go.mod` 自动跟随。
- 本机若仍遇到 `checksum database disabled by GOSUMDB=off`，说明全局 Go 配置关闭了校验库；`go env -w GOSUMDB=sum.golang.org` 后可自动切换工具链。
- Wails v3 CLI：`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`。

## Phase 0（已完成）

- `cmd/wails3app`：带 `wails3` 构建标签的最小 v3 启动器，复用 `internal/app.App` 作为 Service、现有 `frontend/dist` 作为 Asset 目录、单主窗口。
- 验证：
  - `go build -tags wails3 ./cmd/wails3app` 通过（Windows）。
  - `wails3 generate bindings -ts -f "-tags wails3" ./cmd/wails3app` 生成 1 个 Service、521 个方法、147 个模型，产物结构为 `bindings/GoNavi-Wails/internal/app/app.ts`。
  - `go build ./...` 与默认标签构建不受影响。
- 默认构建不编译该目录；迁移完成前不要给 `internal/app` 之外的包加 v3 import。

## 待办（按阶段）

1. **基座**：`internal/desktop` 适配层（对话框、事件、窗口、菜单、剪贴板、浏览器、屏幕），58 个 `pkg/runtime` 调用点改为依赖适配层；v2/v3 各一份实现（`!wails3` / `wails3`）。
2. **前端绑定**：`frontend/src/platform` 运行时适配 + 生成绑定包装，避免一次性改 332 个导入点；测试 mock 保持可用。
3. **多窗口原生化**：用 `application.WebviewWindow` 替换 `internal/nativewindow` 的子进程 + 回环 HTTP 桥；先迁工作台窗口，插件窗口的进程隔离单独评估。
4. **平台能力**：`SingleInstance`、协议/文件关联、`ApplicationLaunchedWithUrl`、每窗口 `EnableFileDrop`、keybindings、原生右键菜单、`WebviewUserDataPath`、启动显示门控清理；评估 `app.Updater` 替换自研更新。
5. **构建发版**：`wails3` CLI + Taskfile + `build/config.yml`，重做 NSIS/MSI/DMG/AppImage 与 CI 矩阵。
6. **清理**：删除 v2 残留与补丁代码，三平台冒烟与关键路径 E2E。

## v2 特殊方案与 v3 原生能力对照

| 现状 | v3 |
|---|---|
| `internal/nativewindow` 子进程多窗口 | `app.Window.NewWithOptions` 同进程多窗口 |
| MSI 命名互斥单实例 | `Options.SingleInstance` |
| 自注册协议 + macOS `OnUrlOpen` | `build/config.yml` protocols + `ApplicationLaunchedWithUrl` |
| 自研更新 manifest + 重启父进程 | `app.Updater`（Provider/签名/原子替换） |
| `StartupWindowGate` / WebView2 边界刷新 | 窗口 options + `OnWindowEvent`/`RegisterHook` |
| 全局拖拽 | 每窗口 `EnableFileDrop` |
| macOS dock 菜单 Objective-C | v3 暂无对应 API，保留 |
