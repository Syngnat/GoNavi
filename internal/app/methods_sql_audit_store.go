package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

func (a *App) sqlAuditDatabasePath() string {
	return filepath.Join(a.auditRootDir(), "audit", "sql_audit.db")
}

func (a *App) sqlAuditHealthFilePath() string {
	return filepath.Join(a.auditRootDir(), "audit", "sql_audit_health.json")
}

func normalizeSQLAuditHealth(state sqlAuditHealthState) sqlAuditHealthState {
	state.CaptureEnabled = nil
	state.CaptureMode = ""
	if state.Status != sqlAuditHealthStatusDegraded {
		state.Status = sqlAuditHealthStatusHealthy
	}
	if state.DroppedEvents < 0 {
		state.DroppedEvents = 0
	}
	if state.FirstFailureAt < 0 {
		state.FirstFailureAt = 0
	}
	if state.LastFailureAt < 0 {
		state.LastFailureAt = 0
	}
	if state.LastSuccessAt < 0 {
		state.LastSuccessAt = 0
	}
	state.LastError = sqlaudit.RedactError(state.LastError)
	return state
}

func (a *App) loadSQLAuditHealth(path string, pendingGap sqlAuditPendingGap) {
	path = filepath.Clean(path)
	loaded := sqlAuditHealthState{Status: sqlAuditHealthStatusHealthy}
	payload, err := os.ReadFile(path)
	if err == nil {
		if decodeErr := json.Unmarshal(payload, &loaded); decodeErr != nil {
			loaded = sqlAuditHealthState{
				Status:         sqlAuditHealthStatusDegraded,
				DroppedEvents:  1,
				FirstFailureAt: time.Now().UnixMilli(),
				LastFailureAt:  time.Now().UnixMilli(),
				LastError:      "SQL audit health state could not be decoded",
			}
		}
	} else if !os.IsNotExist(err) {
		loaded = sqlAuditHealthState{
			Status:         sqlAuditHealthStatusDegraded,
			DroppedEvents:  1,
			FirstFailureAt: time.Now().UnixMilli(),
			LastFailureAt:  time.Now().UnixMilli(),
			LastError:      "SQL audit health state could not be read",
		}
	}
	loaded = normalizeSQLAuditHealth(loaded)

	// Carry only events actually dropped during the suspension. Historical state
	// belongs to the selected target root (whether migrated or pre-existing) and
	// must not be copied or max-merged from the previous root.
	a.sqlAuditHealthMu.Lock()
	if pendingGap.DroppedEvents > 0 {
		if loaded.Status != sqlAuditHealthStatusDegraded {
			loaded.Status = sqlAuditHealthStatusDegraded
			loaded.DroppedEvents = 0
			loaded.FirstFailureAt = pendingGap.FirstFailureAt
		} else if pendingGap.FirstFailureAt > 0 && (loaded.FirstFailureAt == 0 || pendingGap.FirstFailureAt < loaded.FirstFailureAt) {
			loaded.FirstFailureAt = pendingGap.FirstFailureAt
		}
		loaded.DroppedEvents += pendingGap.DroppedEvents
		if pendingGap.LastFailureAt >= loaded.LastFailureAt {
			loaded.LastFailureAt = pendingGap.LastFailureAt
			loaded.LastError = pendingGap.LastError
		}
	}
	a.sqlAuditHealth = normalizeSQLAuditHealth(loaded)
	a.sqlAuditHealthPath = path
	a.sqlAuditHealthRevision++
	snapshot := a.sqlAuditHealth
	a.sqlAuditHealthMu.Unlock()

	if snapshot.Status == sqlAuditHealthStatusDegraded {
		a.persistSQLAuditHealth(snapshot, path)
	}
}

func (a *App) persistSQLAuditHealth(state sqlAuditHealthState, path string) {
	state = normalizeSQLAuditHealth(state)
	payload, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		logger.Warnf("编码 SQL 审计健康状态失败：%v", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		logger.Warnf("创建 SQL 审计健康状态目录失败：%v", err)
		return
	}
	if err := writeSQLAuditExportAtomically(path, append(payload, '\n')); err != nil {
		logger.Warnf("持久化 SQL 审计健康状态失败：%v", err)
	}
}

func (a *App) sqlAuditHealthSnapshot() sqlAuditHealthState {
	state, _ := a.sqlAuditHealthSnapshotWithRevision()
	return state
}

func (a *App) sqlAuditHealthSnapshotWithRevision() (sqlAuditHealthState, uint64) {
	a.sqlAuditHealthMu.RLock()
	defer a.sqlAuditHealthMu.RUnlock()
	return normalizeSQLAuditHealth(a.sqlAuditHealth), a.sqlAuditHealthRevision
}

// withSQLAuditStore serializes store lifecycle changes with operations. SQLite
// still owns record-level concurrency; this lock prevents a data-root switch
// from closing the handle between lookup and use.
func (a *App) withSQLAuditStore(requireRuntimeActive bool, operation func(*sqlaudit.Store) error) error {
	for {
		a.sqlAuditMu.RLock()
		if a.sqlAuditSuspended {
			a.sqlAuditMu.RUnlock()
			return errSQLAuditTemporarilyUnavailable
		}
		if requireRuntimeActive && !a.sqlAuditRuntimeActive {
			a.sqlAuditMu.RUnlock()
			return nil
		}
		path := filepath.Clean(a.sqlAuditDatabasePath())
		if a.sqlAuditStore != nil && filepath.Clean(a.sqlAuditStorePath) == path {
			var err error
			if operation != nil {
				err = operation(a.sqlAuditStore)
			}
			a.sqlAuditMu.RUnlock()
			return err
		}
		a.sqlAuditMu.RUnlock()

		a.sqlAuditMu.Lock()
		if a.sqlAuditSuspended {
			a.sqlAuditMu.Unlock()
			return errSQLAuditTemporarilyUnavailable
		}
		if requireRuntimeActive && !a.sqlAuditRuntimeActive {
			a.sqlAuditMu.Unlock()
			return nil
		}
		_, err := a.ensureSQLAuditStoreLocked()
		a.sqlAuditMu.Unlock()
		if err != nil {
			return err
		}
	}
}

func (a *App) ensureSQLAuditStoreLocked() (*sqlaudit.Store, error) {
	path := filepath.Clean(a.sqlAuditDatabasePath())
	if a.sqlAuditStore != nil && filepath.Clean(a.sqlAuditStorePath) == path {
		return a.sqlAuditStore, nil
	}
	if a.sqlAuditStore != nil {
		if err := a.sqlAuditStore.Close(); err != nil {
			logger.Warnf("关闭旧 SQL 审计存储失败：%v", err)
		}
		a.sqlAuditStore = nil
		a.sqlAuditStorePath = ""
	}
	store, err := sqlaudit.Open(path)
	if err != nil {
		return nil, err
	}
	a.sqlAuditStore = store
	a.sqlAuditStorePath = path
	return store, nil
}

func (a *App) activateSQLAudit() {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	pendingGap := sqlAuditPendingGap{
		DroppedEvents:  a.sqlAuditSuspensionDropped,
		FirstFailureAt: a.sqlAuditSuspensionFirstAt,
		LastFailureAt:  a.sqlAuditSuspensionLastAt,
		LastError:      a.sqlAuditSuspensionLastError,
	}
	a.sqlAuditSuspensionDropped = 0
	a.sqlAuditSuspensionFirstAt = 0
	a.sqlAuditSuspensionLastAt = 0
	a.sqlAuditSuspensionLastError = ""

	a.sqlAuditMu.Lock()
	// Keep all appenders out until both the store and its persisted health state
	// have been restored for the current data root.
	a.sqlAuditRuntimeActive = false
	a.sqlAuditSuspended = true
	_, err := a.ensureSQLAuditStoreLocked()
	a.loadSQLAuditHealth(a.sqlAuditHealthFilePath(), pendingGap)
	if err != nil {
		// SQL execution remains fail-open; users can see the same error when opening
		// the audit center instead of losing the database operation itself.
		a.markSQLAuditFailure(0, err)
	}
	// Keep runtime auditing active even after an open failure so a later write can
	// retry opening the store and close the degraded state with a durable marker.
	a.sqlAuditRuntimeActive = true
	a.sqlAuditSuspended = false
	a.sqlAuditMu.Unlock()
	if err != nil {
		logger.Warnf("初始化 SQL 审计存储失败：%v", err)
	}
}

func (a *App) suspendSQLAudit() (bool, error) {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	a.sqlAuditSuspensionDropped = 0
	a.sqlAuditSuspensionFirstAt = 0
	a.sqlAuditSuspensionLastAt = 0
	a.sqlAuditSuspensionLastError = ""
	a.sqlAuditMu.Lock()
	wasActive := a.sqlAuditRuntimeActive
	a.sqlAuditRuntimeActive = false
	a.sqlAuditSuspended = true
	var closeErr error
	if a.sqlAuditStore != nil {
		if closeErr = closeSQLAuditStoreHandle(a.sqlAuditStore); closeErr != nil {
			logger.Warnf("暂停 SQL 审计时 checkpoint/关闭存储失败：%v", closeErr)
		}
	}
	a.sqlAuditStore = nil
	a.sqlAuditStorePath = ""
	a.sqlAuditMu.Unlock()
	return wasActive, closeErr
}

func (a *App) resumeSQLAudit(wasActive bool) {
	if wasActive {
		a.activateSQLAudit()
		return
	}
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	a.sqlAuditMu.Lock()
	a.sqlAuditSuspended = false
	a.sqlAuditMu.Unlock()
}

func (a *App) closeSQLAuditStore() {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	a.sqlAuditMu.Lock()
	defer a.sqlAuditMu.Unlock()
	a.sqlAuditRuntimeActive = false
	a.sqlAuditSuspended = true
	if a.sqlAuditStore == nil {
		return
	}
	if err := closeSQLAuditStoreHandle(a.sqlAuditStore); err != nil {
		logger.Warnf("关闭 SQL 审计存储失败：%v", err)
	}
	a.sqlAuditStore = nil
	a.sqlAuditStorePath = ""
}
