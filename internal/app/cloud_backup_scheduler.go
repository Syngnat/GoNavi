package app

import (
	"context"
	"time"

	"GoNavi-Wails/internal/logger"
)

func (a *App) initializeCloudBackup(ctx context.Context) {
	a.initializeCloudBackupLifecycle(ctx)
	// Startup must only inspect non-sensitive metadata. CloudBackupGetConfig
	// reads credentials from the OS keyring, which would trigger a macOS
	// authorization prompt on every development rebuild. Credentials are
	// loaded when the settings/API path or an actual sync operation is used.
	if _, err := a.loadCloudBackupConfig(); err != nil {
		logger.Warnf("加载云端备份配置失败：%v", err)
	}
	a.restartCloudBackupScheduler()
}

func (a *App) restartCloudBackupScheduler() {
	if a == nil || a.headlessRuntime {
		return
	}
	a.cloudBackupSchedulerMu.Lock()
	defer a.cloudBackupSchedulerMu.Unlock()
	if a.cloudBackupSchedulerCancel != nil {
		a.cloudBackupSchedulerCancel()
	}
	a.cloudBackupSchedulerCancel = nil
	config, err := a.loadCloudBackupConfig()
	if err != nil || !config.Enabled {
		return
	}
	interval := cloudBackupScheduleInterval(config.Schedule)
	if interval <= 0 {
		return
	}
	a.cloudBackupLifecycleMu.Lock()
	parent := a.cloudBackupLifecycleContextLocked(context.Background())
	if a.cloudBackupShuttingDown || parent.Err() != nil {
		a.cloudBackupLifecycleMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	a.cloudBackupSchedulerCancel = cancel
	a.cloudBackupBackgroundWG.Add(1)
	a.cloudBackupLifecycleMu.Unlock()
	go func() {
		defer a.cloudBackupBackgroundWG.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := a.cloudBackupSync(ctx); err != nil {
					logger.Warnf("自动同步云端备份失败：%v", err)
				}
			}
		}
	}()
}

func cloudBackupScheduleInterval(schedule string) time.Duration {
	switch schedule {
	case CloudBackupSchedule10Minutes:
		return 10 * time.Minute
	case CloudBackupSchedule30Minutes:
		return 30 * time.Minute
	case CloudBackupSchedule1Hour:
		return time.Hour
	default:
		return 0
	}
}

func (a *App) markCloudBackupDirty() {
	if a == nil || a.headlessRuntime {
		return
	}
	config, err := a.loadCloudBackupConfig()
	if err != nil || !config.Enabled {
		return
	}
	a.cloudBackupDirtyMu.Lock()
	a.cloudBackupDirty = true
	a.cloudBackupDirtyRevision++
	a.cloudBackupDirtyMu.Unlock()
	if config.Schedule != CloudBackupScheduleImmediate {
		return
	}
	a.queueImmediateCloudBackup()
}

func (a *App) initializeCloudBackupLifecycle(parent context.Context) {
	a.cloudBackupLifecycleMu.Lock()
	defer a.cloudBackupLifecycleMu.Unlock()
	if a.cloudBackupShuttingDown {
		return
	}
	a.cloudBackupLifecycleContextLocked(parent)
}

func (a *App) cloudBackupLifecycleContextLocked(parent context.Context) context.Context {
	if a.cloudBackupLifecycleCtx != nil {
		return a.cloudBackupLifecycleCtx
	}
	if parent == nil {
		parent = context.Background()
	}
	a.cloudBackupLifecycleCtx, a.cloudBackupLifecycleCancel = context.WithCancel(parent)
	a.cloudBackupImmediateSignal = make(chan struct{}, 1)
	return a.cloudBackupLifecycleCtx
}

func (a *App) queueImmediateCloudBackup() {
	a.cloudBackupLifecycleMu.Lock()
	if a.cloudBackupShuttingDown {
		a.cloudBackupLifecycleMu.Unlock()
		return
	}
	ctx := a.cloudBackupLifecycleContextLocked(context.Background())
	if ctx.Err() != nil {
		a.cloudBackupLifecycleMu.Unlock()
		return
	}
	if !a.cloudBackupImmediateStarted {
		a.cloudBackupImmediateStarted = true
		a.cloudBackupBackgroundWG.Add(1)
		go a.runImmediateCloudBackup(ctx, a.cloudBackupImmediateSignal)
	}
	select {
	case a.cloudBackupImmediateSignal <- struct{}{}:
	default:
	}
	a.cloudBackupLifecycleMu.Unlock()
}

func (a *App) runImmediateCloudBackup(ctx context.Context, signal <-chan struct{}) {
	defer a.cloudBackupBackgroundWG.Done()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		select {
		case <-ctx.Done():
			return
		case <-signal:
			if ctx.Err() != nil {
				return
			}
			if _, err := a.cloudBackupSync(ctx); err != nil && ctx.Err() == nil {
				logger.Warnf("修改后同步云端备份失败：%v", err)
			}
		}
	}
}

func (a *App) cloudBackupDirtyState() (bool, uint64) {
	a.cloudBackupDirtyMu.Lock()
	defer a.cloudBackupDirtyMu.Unlock()
	return a.cloudBackupDirty, a.cloudBackupDirtyRevision
}

func (a *App) clearCloudBackupDirty(revision uint64) {
	a.cloudBackupDirtyMu.Lock()
	if a.cloudBackupDirtyRevision == revision {
		a.cloudBackupDirty = false
	}
	a.cloudBackupDirtyMu.Unlock()
}

func (a *App) shutdownCloudBackup() {
	if a == nil || a.headlessRuntime {
		return
	}
	a.cloudBackupSchedulerMu.Lock()
	if a.cloudBackupSchedulerCancel != nil {
		a.cloudBackupSchedulerCancel()
		a.cloudBackupSchedulerCancel = nil
	}
	a.cloudBackupSchedulerMu.Unlock()
	a.cloudBackupLifecycleMu.Lock()
	a.cloudBackupShuttingDown = true
	if a.cloudBackupLifecycleCancel != nil {
		a.cloudBackupLifecycleCancel()
	}
	a.cloudBackupLifecycleMu.Unlock()
	a.cloudBackupBackgroundWG.Wait()
	config, err := a.loadCloudBackupConfig()
	if err != nil || !config.Enabled || config.Schedule != CloudBackupScheduleOnExit {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := a.cloudBackupSync(ctx); err != nil {
		logger.Warnf("退出前同步云端备份失败：%v", err)
	}
}
