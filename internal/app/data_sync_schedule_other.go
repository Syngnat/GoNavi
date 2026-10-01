//go:build !windows

package app

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/syncjob"
	"GoNavi-Wails/internal/syncworker"
)

// 非 Windows 平台仍使用常驻 worker 模型：主应用被动，由登录自启动的
// 后台调度进程负责到点执行。

func (a *App) usesDataSyncWorker() bool {
	if a == nil || a.ctx == nil || a.headlessRuntime || a.webRuntime {
		return false
	}
	// Test binaries do not implement the main executable's special-mode entry.
	return !strings.HasSuffix(strings.TrimSuffix(strings.ToLower(os.Args[0]), ".exe"), ".test")
}

func (a *App) prepareDataSyncSchedule(definition syncjob.JobDefinition) error {
	if err := a.beginDataSyncJobsOperation(); err != nil {
		return err
	}
	defer a.dataSyncJobsOperations.Done()
	if !a.usesDataSyncWorker() || definition.Lifecycle != syncjob.JobLifecycleEnabled || definition.Schedule.Kind == syncjob.ScheduleManual {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := syncworker.Register(ctx, a.configDir, executable); err != nil {
		return fmt.Errorf("%s: %w", a.appText("data_sync.worker.registration_failed", nil), err)
	}
	return nil
}

func (a *App) unregisterDataSyncJobSchedule(jobID string) error {
	// 非 Windows 平台仍由单一的常驻 worker 登录任务覆盖全部任务，无需按任务注销。
	_ = jobID
	return nil
}

func (a *App) stopDataSyncWorkerForMaintenance() error {
	if !a.usesDataSyncWorker() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), dataSyncJobShutdownTimeout+5*time.Second)
	defer cancel()
	if err := syncworker.Stop(ctx, a.configDir); err != nil {
		return err
	}
	return syncworker.Unregister(ctx, a.configDir)
}

func (a *App) registerExistingDataSyncSchedules(ctx context.Context, manager *syncjob.Manager) error {
	if !a.usesDataSyncWorker() {
		return nil
	}
	jobs, err := manager.ListJobs(ctx)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if job.Lifecycle == syncjob.JobLifecycleEnabled && job.Schedule.Kind != syncjob.ScheduleManual {
			return a.prepareDataSyncSchedule(job)
		}
	}
	return nil
}
