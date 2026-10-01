//go:build !windows

package syncworker

import (
	"context"

	"GoNavi-Wails/internal/syncjob"
)

// 非 Windows 平台暂未接入一次性调度模型：登录自启动仍走常驻 worker 的
// Register/Unregister（autostart_*.go）。以下桩仅保证接线代码可全平台编译；
// 平台分流由 internal/app 的构建标签文件（data_sync_schedule_windows.go /
// data_sync_schedule_other.go）完成，非 Windows 接线不会调用这些桩。

func RegisterJobSchedule(ctx context.Context, root, executable, jobID string, spec syncjob.ScheduleSpec) error {
	return nil
}

func UnregisterJobSchedule(ctx context.Context, root, jobID string) error {
	return nil
}

func UnregisterLegacyLogonTask(ctx context.Context, root string) error {
	return nil
}

func StopLegacyWorker(ctx context.Context, root string) error {
	return nil
}
