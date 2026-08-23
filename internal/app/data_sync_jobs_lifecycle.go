package app

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/syncjob"
	"GoNavi-Wails/internal/uievents"
)

const dataSyncJobShutdownTimeout = 15 * time.Second

func (a *App) dataSyncJobDatabasePath() string {
	root := strings.TrimSpace(a.configDir)
	if root == "" {
		root = resolveAppConfigDir()
	}
	return filepath.Join(root, "data_sync", "sync_jobs.db")
}

func (a *App) initializeDataSyncJobs(context.Context) {
	if _, err := a.ensureDataSyncJobManager(); err != nil {
		logger.Warnf("初始化数据同步任务管理器失败：%v", err)
	}
}

func (a *App) ensureDataSyncJobManager() (*syncjob.Manager, error) {
	if a == nil {
		return nil, fmt.Errorf("application is unavailable")
	}
	a.dataSyncJobsMu.Lock()
	defer a.dataSyncJobsMu.Unlock()
	if a.dataSyncJobsDraining {
		return nil, fmt.Errorf("data sync job manager is shutting down")
	}
	if a.dataSyncJobManager != nil {
		return a.dataSyncJobManager, nil
	}
	store, err := syncjob.Open(a.dataSyncJobDatabasePath())
	if err != nil {
		return nil, err
	}
	manager, err := syncjob.NewManager(context.Background(), store, appDataSyncJobExecutor{app: a}, syncjob.ManagerOptions{
		LeaseOwner: a.dataSyncJobLeaseOwner,
		Hooks: syncjob.ManagerHooks{
			OnRunEvent: func(event syncjob.RunEvent) {
				uievents.Emit(a.ctx, "sync:run-event", event)
			},
		},
	})
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	a.dataSyncJobStore = store
	a.dataSyncJobManager = manager
	return manager, nil
}

func (a *App) shutdownDataSyncJobs() {
	if a == nil {
		return
	}
	a.dataSyncJobsMu.Lock()
	manager := a.dataSyncJobManager
	store := a.dataSyncJobStore
	a.dataSyncJobManager = nil
	a.dataSyncJobStore = nil
	a.dataSyncJobsDraining = manager != nil || store != nil
	a.dataSyncJobsMu.Unlock()

	if manager != nil {
		ctx, cancel := context.WithTimeout(context.Background(), dataSyncJobShutdownTimeout)
		err := manager.Shutdown(ctx)
		cancel()
		if err != nil {
			logger.Warnf("等待数据同步任务停止失败：%v", err)
			a.finishDataSyncJobDrainInBackground(manager, store)
			return
		}
	}
	if store != nil {
		if err := store.Close(); err != nil {
			logger.Warnf("关闭数据同步任务存储失败：%v", err)
		}
	}
	a.dataSyncJobsMu.Lock()
	a.dataSyncJobsDraining = false
	a.dataSyncJobsMu.Unlock()
}

func (a *App) suspendDataSyncJobs() (bool, error) {
	if a == nil {
		return false, nil
	}
	a.dataSyncJobsMu.Lock()
	if a.dataSyncJobsDraining {
		a.dataSyncJobsMu.Unlock()
		return false, fmt.Errorf("data sync job manager is already shutting down")
	}
	wasActive := a.dataSyncJobManager != nil || a.dataSyncJobStore != nil
	manager := a.dataSyncJobManager
	store := a.dataSyncJobStore
	a.dataSyncJobManager = nil
	a.dataSyncJobStore = nil
	a.dataSyncJobsDraining = wasActive
	a.dataSyncJobsMu.Unlock()
	if manager != nil {
		ctx, cancel := context.WithTimeout(context.Background(), dataSyncJobShutdownTimeout)
		err := manager.Shutdown(ctx)
		cancel()
		if err != nil {
			a.finishDataSyncJobDrainInBackground(manager, store)
			return false, err
		}
	}
	if store != nil {
		if err := store.Close(); err != nil {
			a.dataSyncJobsMu.Lock()
			a.dataSyncJobsDraining = false
			a.dataSyncJobsMu.Unlock()
			return false, err
		}
	}
	a.dataSyncJobsMu.Lock()
	a.dataSyncJobsDraining = false
	a.dataSyncJobsMu.Unlock()
	return wasActive, nil
}

func (a *App) finishDataSyncJobDrainInBackground(manager *syncjob.Manager, store *syncjob.Store) {
	go func() {
		if manager != nil {
			_ = manager.Shutdown(context.Background())
		}
		if store != nil {
			if err := store.Close(); err != nil {
				logger.Warnf("后台关闭数据同步任务存储失败：%v", err)
			}
		}
		a.dataSyncJobsMu.Lock()
		a.dataSyncJobsDraining = false
		a.dataSyncJobsMu.Unlock()
	}()
}

func (a *App) resumeDataSyncJobs(wasActive bool) {
	if !wasActive {
		return
	}
	if _, err := a.ensureDataSyncJobManager(); err != nil {
		logger.Warnf("恢复数据同步任务管理器失败：%v", err)
	}
}
