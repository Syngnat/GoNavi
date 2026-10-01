package app

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/syncjob"
	"GoNavi-Wails/internal/syncworker"
	"GoNavi-Wails/internal/uievents"
)

// RunSyncWorker starts only the backend task runtime; no Wails window is created.
func RunSyncWorker(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("sync-worker", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataRoot := flags.String("data-root", "", "GoNavi data directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("sync-worker accepts only --data-root")
	}
	root, err := appdata.ResolveActiveRoot()
	if strings.TrimSpace(*dataRoot) != "" {
		root, err = appdata.ResolveRoot(*dataRoot)
	}
	if err != nil {
		return err
	}
	return syncworker.Run(ctx, root, func(workerCtx context.Context) (func(), error) {
		application, err := NewHeadlessApp(workerCtx, root)
		if err != nil {
			return nil, err
		}
		manager, err := application.ensureDataSyncJobManager()
		if err != nil {
			application.Shutdown()
			return nil, err
		}
		return func() {
			// Keep the process lock until every executor has released its resources.
			if err := manager.Shutdown(context.Background()); err != nil {
				logger.Warnf("关闭后台调度失败：%v", err)
			}
			application.Shutdown()
		}, nil
	})
}

// RunScheduledJobOnce 以一次性进程执行单个已到期的定时任务。调度与执行
// 复用共享存储上的租约仲裁，与在线主应用互斥安全；OS 计划任务触发器只是
// 唤醒网格，是否真正到期以 store 的 NextRunAt 判定为准——未启用或未到期
// 的任务直接静默返回。
func RunScheduledJobOnce(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("run-sync-job", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataRoot := flags.String("data-root", "", "GoNavi data directory")
	jobFlag := flags.String("job", "", "data sync job id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	jobID := strings.TrimSpace(*jobFlag)
	if jobID == "" || flags.NArg() != 0 {
		return fmt.Errorf("run-sync-job accepts --job <id> and optional --data-root")
	}
	root, err := appdata.ResolveActiveRoot()
	if strings.TrimSpace(*dataRoot) != "" {
		root, err = appdata.ResolveRoot(*dataRoot)
	}
	if err != nil {
		return err
	}
	if !syncJobDueForRun(ctx, filepath.Join(root, "data_sync", "sync_jobs.db"), jobID) {
		return nil
	}
	application, err := NewHeadlessApp(ctx, root)
	if err != nil {
		return err
	}
	manager, store, managerErr := application.newDataSyncJobManager(ctx)
	if managerErr != nil {
		application.Shutdown()
		return managerErr
	}
	run, enqueued, enqueueErr := manager.EnqueueDueJobRun(ctx, jobID)
	if enqueueErr != nil || !enqueued {
		finishDataSyncJobRunner(manager, store, application)
		return enqueueErr
	}
	finalRun, waitErr := manager.WaitRun(ctx, run.ID, time.Second)
	finishDataSyncJobRunner(manager, store, application)
	if waitErr != nil {
		return waitErr
	}
	switch finalRun.Status {
	case syncjob.RunStatusSucceeded:
		logger.Infof("定时同步任务完成：job=%s run=%s", jobID, finalRun.ID)
		return nil
	case syncjob.RunStatusPartial:
		logger.Warnf("定时同步任务部分完成：job=%s run=%s", jobID, finalRun.ID)
		return nil
	default:
		logger.Warnf("定时同步任务未成功：job=%s run=%s status=%s message=%s", jobID, finalRun.ID, finalRun.Status, finalRun.Message)
		return fmt.Errorf("data sync job run finished with status %s", finalRun.Status)
	}
}

// syncJobDueForRun 用轻量 store 打开判定任务是否到期，避免未到期唤醒时
// 拉起完整应用（HeadlessApp 会恢复全部连接）。判定失败时返回 false，让
// 下一次唤醒重试。
func syncJobDueForRun(ctx context.Context, databasePath, jobID string) bool {
	store, err := syncjob.Open(databasePath)
	if err != nil {
		logger.Warnf("定时任务到期预检打开存储失败，本次唤醒跳过：%v", err)
		return false
	}
	defer store.Close()
	dueJobs, err := store.ListDueJobs(ctx, time.Now().UnixMilli())
	if err != nil {
		logger.Warnf("定时任务到期预检查询失败，本次唤醒跳过：%v", err)
		return false
	}
	for _, definition := range dueJobs {
		if definition.ID == jobID {
			return true
		}
	}
	return false
}

// newDataSyncJobManager 为一次性执行进程构建执行管理器。与主应用的
// ensureDataSyncJobManager 相同的执行器与租约配置，但不触发常驻 worker，
// 也不自行扫描到期任务：只执行 EnqueueDueJobRun 入队的那一个任务，
// 其余到期任务（含持续型）归各自的触发器或在线主应用。
func (a *App) newDataSyncJobManager(ctx context.Context) (*syncjob.Manager, *syncjob.Store, error) {
	if err := a.beginDataSyncJobsOperation(); err != nil {
		return nil, nil, err
	}
	defer a.dataSyncJobsOperations.Done()
	store, err := syncjob.Open(a.dataSyncJobDatabasePath())
	if err != nil {
		return nil, nil, err
	}
	manager, err := syncjob.NewManager(ctx, store, appDataSyncJobExecutor{app: a}, syncjob.ManagerOptions{
		LeaseOwner:        a.dataSyncJobLeaseOwner,
		SchedulerDisabled: true,
		Hooks: syncjob.ManagerHooks{
			OnRunEvent: func(event syncjob.RunEvent) {
				uievents.Emit(a.ctx, "sync:run-event", event)
			},
		},
	})
	if err != nil {
		_ = store.Close()
		return nil, nil, err
	}
	return manager, store, nil
}

// finishDataSyncJobRunner 释放一次性执行进程的资源：先宽限等待调度器
// 排空，再关闭应用。
func finishDataSyncJobRunner(manager *syncjob.Manager, store *syncjob.Store, application *App) {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), dataSyncJobShutdownTimeout)
	if err := manager.Shutdown(shutdownCtx); err != nil {
		logger.Warnf("等待一次性调度器停止失败：%v", err)
	}
	cancel()
	if err := store.Close(); err != nil {
		logger.Warnf("关闭一次性调度存储失败：%v", err)
	}
	application.Shutdown()
}

func (a *App) ensureDataSyncWorker() error {
	if !a.usesDataSyncWorker() {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := syncworker.Ensure(ctx, a.configDir, executable); err != nil {
		return fmt.Errorf("%s: %w", a.appText("data_sync.worker.start_failed", nil), err)
	}
	return nil
}
