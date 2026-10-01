//go:build windows

package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/syncjob"
	"GoNavi-Wails/internal/syncworker"
)

// Windows 的定时调度不依赖常驻进程：主应用在线时由进程内调度器执行，
// 关闭后由系统计划任务到点拉起 run-sync-job 一次性进程。是否真正到期
// 始终以共享存储的 NextRunAt 判定为准，触发器只是唤醒网格。

func (a *App) usesDataSyncWorker() bool { return false }

// shouldTouchOSScheduler 与旧实现 usesDataSyncWorker 的运行时守卫保持一致：
// 测试二进制、无 UI 上下文与 headless/web 运行时不触碰真实任务计划程序，
// 避免测试产生系统副作用或改变迁移路径的错误内容。
func (a *App) shouldTouchOSScheduler() bool {
	if a == nil || a.ctx == nil || a.headlessRuntime || a.webRuntime {
		return false
	}
	return !strings.HasSuffix(strings.TrimSuffix(strings.ToLower(os.Args[0]), ".exe"), ".test")
}

// prepareDataSyncSchedule 在任务保存后按存储中的最新状态对齐全部计划任务
// 注册（启用、停用与调度变更都在同一条保存路径上生效）。带超时：schtasks
// 挂起时不能无限阻塞保存动作与退出排空。
func (a *App) prepareDataSyncSchedule(definition syncjob.JobDefinition) error {
	if !a.shouldTouchOSScheduler() {
		return nil
	}
	if err := a.beginDataSyncJobsOperation(); err != nil {
		return err
	}
	defer a.dataSyncJobsOperations.Done()
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return a.reconcileDataSyncSchedules(ctx, manager)
}

func (a *App) registerExistingDataSyncSchedules(ctx context.Context, manager *syncjob.Manager) error {
	if !a.shouldTouchOSScheduler() {
		return nil
	}
	reconcileCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := a.reconcileDataSyncSchedules(reconcileCtx, manager); err != nil {
		return err
	}
	// 升级到一次性调度模型后的一次性回收：停掉旧常驻 worker 并注销其登录任务。
	if err := syncworker.StopLegacyWorker(ctx, a.configDir); err != nil {
		logger.Warnf("停止旧后台调度进程失败：%v", err)
	}
	if err := syncworker.UnregisterLegacyLogonTask(ctx, a.configDir); err != nil {
		logger.Warnf("注销旧后台调度登录任务失败：%v", err)
	}
	return nil
}

// reconcileDataSyncSchedules 让全部任务的 OS 计划任务注册与存储状态一致：
// 启用且可调度的任务注册，其余（停用、草稿、归档、手动、持续型）注销。
func (a *App) reconcileDataSyncSchedules(ctx context.Context, manager *syncjob.Manager) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	jobs, err := manager.ListJobs(ctx)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		schedulable := job.Lifecycle == syncjob.JobLifecycleEnabled && job.Enabled &&
			job.Schedule.Kind != syncjob.ScheduleManual && job.Schedule.Kind != syncjob.ScheduleContinuous
		if schedulable {
			if err := syncworker.RegisterJobSchedule(ctx, a.configDir, executable, job.ID, job.Schedule); err != nil {
				return fmt.Errorf("%s: %w", a.appText("data_sync.worker.registration_failed", nil), err)
			}
			continue
		}
		if err := syncworker.UnregisterJobSchedule(ctx, a.configDir, job.ID); err != nil {
			return err
		}
	}
	return a.sweepOrphanJobSchedules(ctx, manager)
}

// sweepOrphanJobSchedules 清理 marker 目录里已无对应任务的孤儿注册
// （注销失败等异常路径的残留），避免它们周期性拉起空进程。
func (a *App) sweepOrphanJobSchedules(ctx context.Context, manager *syncjob.Manager) error {
	jobs, err := manager.ListJobs(ctx)
	if err != nil {
		return err
	}
	expected := make(map[string]struct{}, len(jobs))
	for _, job := range jobs {
		expected[syncworker.JobScheduleTaskName(a.configDir, job.ID)] = struct{}{}
	}
	entries, err := os.ReadDir(filepath.Join(a.configDir, "data_sync", "schedules"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		taskName := strings.TrimSuffix(entry.Name(), ".xml")
		if _, ok := expected[taskName]; ok {
			continue
		}
		if err := syncworker.UnregisterJobScheduleTaskName(ctx, a.configDir, taskName); err != nil {
			return err
		}
	}
	return nil
}

// unregisterDataSyncJobSchedule 在任务被永久删除后移除其 OS 计划任务注册。
func (a *App) unregisterDataSyncJobSchedule(jobID string) error {
	if !a.shouldTouchOSScheduler() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return syncworker.UnregisterJobSchedule(ctx, a.configDir, jobID)
}

// stopDataSyncWorkerForMaintenance 在数据根迁移前移除旧根上的全部任务注册；
// 一次性模型没有常驻进程，无需额外停止动作。
func (a *App) stopDataSyncWorkerForMaintenance() error {
	if !a.shouldTouchOSScheduler() {
		return nil
	}
	a.dataSyncJobsMu.Lock()
	manager := a.dataSyncJobManager
	a.dataSyncJobsMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), dataSyncJobShutdownTimeout+5*time.Second)
	defer cancel()
	if manager == nil {
		// 启动初始化失败等场景 manager 缺失：轻量打开存储补齐注销。
		store, err := syncjob.Open(a.dataSyncJobDatabasePath())
		if err != nil {
			return err
		}
		jobs, listErr := store.ListJobs(ctx)
		closeErr := store.Close()
		if listErr != nil {
			return listErr
		}
		if closeErr != nil {
			return closeErr
		}
		return a.unregisterDataSyncJobSchedules(ctx, jobs)
	}
	jobs, err := manager.ListJobs(ctx)
	if err != nil {
		return err
	}
	return a.unregisterDataSyncJobSchedules(ctx, jobs)
}

func (a *App) unregisterDataSyncJobSchedules(ctx context.Context, jobs []syncjob.JobDefinition) error {
	for _, job := range jobs {
		if err := syncworker.UnregisterJobSchedule(ctx, a.configDir, job.ID); err != nil {
			return err
		}
	}
	return nil
}
