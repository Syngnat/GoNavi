package app

import (
	"GoNavi-Wails/internal/sync"
)

// DataSync executes a data synchronization task
func (a *App) DataSync(config sync.SyncConfig) sync.SyncResult {
	engine := sync.NewSyncEngine()
	return engine.RunSync(config)
}
