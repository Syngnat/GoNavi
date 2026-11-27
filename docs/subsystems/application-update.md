# 应用更新与安装

## 职责与边界

负责检查 GitHub Release、选择稳定/开发通道、下载并校验安装包、启动安装流程，以及在安装后重启应用。不负责驱动更新、插件更新或安全更新；这些分别走各自子系统。

## 真源

- 更新检查与下载：`internal/app/methods_update_check.go`、`methods_update_stage.go`、`update_manifest.go`
- 安装入口：`internal/app/methods_update_install.go`
- Windows 安装器：`internal/app/update_cleanup.go`、`windows_update*.ps1`
- macOS 安装器：`internal/app/methods_update_launch.go`
- Linux 安装器：`internal/app/methods_update_launch.go`
- 重启父进程等待：`internal/app/windows_restart_parent_*.go`
- 前端状态与确认：`frontend/src/hooks/appUpdate/`、`frontend/src/appShell/hooks/useAppQuitAndUpdate.tsx`

## 运行时路径

1. 前端检查更新，后端返回 `UpdateInfo`，下载包按 SHA-256 与大小校验后写入用户缓存目录。
2. 用户确认安装；前端先完成未保存 SQL、标签页和工作台状态处理。
3. `InstallUpdateAndRestart` 暂停同步任务并校验安装包与安装模式。
4. Windows 启动独立 PowerShell/MSI 安装器，Linux 启动脱离会话的脚本；进程退出后由安装器替换并重启。
5. macOS 在**主进程退出前同步执行** `update.sh`：挂载 DMG/解压 ZIP、替换 `.app`、用
   `--gonavi-restart-parent-pid=<旧 PID>` 启动新版本，再删除更新缓存。脚本返回成功后才退出旧进程。
6. 新进程在创建 Wails 应用前等待旧 PID 消失，避免 macOS 单实例与文件替换竞争。

macOS 不使用“退出后仍存活的 launchd 安装脚本”作为必要路径。部分环境会在宿主退出后回收该进程，
导致日志停在 `host process exited`，应用未替换且无法回报失败。

## 状态与不变量

- 安装成功前，旧应用必须保持可运行；安装失败时窗口不关闭，并返回错误与安装日志路径。
- macOS 新进程先占位等待，旧进程完全退出后才创建窗口和单实例锁。
- 安装包成功校验前不得执行替换；替换失败必须保留备份并回滚。
- 成功路径先启动新进程，再删除更新缓存；失败路径保留安装包与日志。

## 失败语义

- 下载失败、校验失败、安装包缺失：返回失败，不退出应用。
- macOS 挂载/解压、权限替换、目标可执行文件校验失败：脚本非零退出，应用保持打开并显示错误。
- 新进程启动失败：旧应用保持运行；目标包已替换时，下次手动启动仍会使用新版本。
- 旧进程超过 120 秒未退出：新进程放弃启动，避免多个实例长期等待。

## 验证

```bash
go test ./internal/app -run 'Update|Mac|RestartParent'
go build ./...
```

macOS 变更需在真实 `.app` 上验证：DMG 挂载、替换 `/Applications/GoNavi.app`、自动重启和版本号变化。
