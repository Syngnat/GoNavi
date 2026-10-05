package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sqlaudit"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) GetSQLAuditHealth() connection.QueryResult {
	health := a.sqlAuditHealthSnapshot()
	var settings sqlaudit.Settings
	a.sqlAuditAppendMu.Lock()
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var settingsErr error
		settings, settingsErr = store.GetSettings()
		return settingsErr
	})
	a.sqlAuditAppendMu.Unlock()
	if err == nil {
		enabled := settings.Enabled
		health.CaptureEnabled = &enabled
		health.CaptureMode = settings.CaptureMode
	}
	return connection.QueryResult{Success: true, Data: health}
}

func (a *App) GetSQLAuditEvents(filter sqlaudit.Filter) connection.QueryResult {
	var page sqlaudit.Page
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var queryErr error
		page, queryErr = store.Query(filter)
		return queryErr
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

func (a *App) GetSQLAuditSettings() connection.QueryResult {
	var settings sqlaudit.Settings
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var settingsErr error
		settings, settingsErr = store.GetSettings()
		return settingsErr
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: settings}
}

func (a *App) UpdateSQLAuditSettings(settings sqlaudit.Settings) connection.QueryResult {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	health := a.sqlAuditHealthSnapshot()
	wasDegraded := health.Status == sqlAuditHealthStatusDegraded
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		if updateErr := store.UpdateSettingsWithControl(settings, sqlaudit.Event{
			Timestamp: time.Now().UnixMilli(),
			EventType: "audit_settings_change",
			Status:    "success",
			QueryID:   generateQueryID(),
			Source:    "audit_control",
		}); updateErr != nil {
			return updateErr
		}
		if wasDegraded {
			return store.AppendControl(buildSQLAuditGapEvent(health))
		}
		return nil
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	a.markSQLAuditSuccess(wasDegraded)
	return a.GetSQLAuditSettings()
}

func (a *App) VerifySQLAuditIntegrity() connection.QueryResult {
	return a.verifySQLAuditIntegrity(context.Background())
}

func (a *App) verifySQLAuditIntegrity(ctx context.Context) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	var report sqlaudit.IntegrityReport
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var verifyErr error
		report, verifyErr = store.VerifyIntegrityContext(ctx)
		return verifyErr
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: report}
}

func (a *App) ClearSQLAuditEvents(beforeTimestamp int64) connection.QueryResult {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	health := a.sqlAuditHealthSnapshot()
	wasDegraded := health.Status == sqlAuditHealthStatusDegraded
	var deleted int64
	gapMarkerRetained := false
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var clearErr error
		deleted, clearErr = store.ClearWithControl(beforeTimestamp, sqlaudit.Event{
			Timestamp:      time.Now().UnixMilli(),
			EventType:      "audit_clear",
			Status:         "success",
			QueryID:        generateQueryID(),
			Source:         "audit_control",
			StatementCount: 1,
		})
		if clearErr != nil {
			return clearErr
		}
		if wasDegraded {
			if appendErr := store.AppendControl(buildSQLAuditGapEvent(health)); appendErr != nil {
				return appendErr
			}
		}
		page, queryErr := store.Query(sqlaudit.Filter{EventType: "audit_gap", Page: 1, PageSize: 1})
		if queryErr != nil {
			return queryErr
		}
		gapMarkerRetained = page.Total > 0
		return nil
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if wasDegraded {
		a.markSQLAuditSuccess(true)
	}
	if !gapMarkerRetained {
		a.clearSQLAuditRecoveredGapState()
	}
	return connection.QueryResult{Success: true, Data: map[string]int64{"deleted": deleted}}
}

func (a *App) clearSQLAuditRecoveredGapState() {
	a.sqlAuditHealthMu.Lock()
	defer a.sqlAuditHealthMu.Unlock()
	state := normalizeSQLAuditHealth(a.sqlAuditHealth)
	if state.Status != sqlAuditHealthStatusHealthy || state.DroppedEvents == 0 {
		return
	}
	state.DroppedEvents = 0
	state.FirstFailureAt = 0
	state.LastFailureAt = 0
	state.LastError = ""
	path := a.sqlAuditHealthPath
	if strings.TrimSpace(path) == "" {
		path = filepath.Clean(a.sqlAuditHealthFilePath())
		a.sqlAuditHealthPath = path
	}
	a.sqlAuditHealth = state
	a.sqlAuditHealthRevision++
	a.persistSQLAuditHealth(state, path)
}

func (a *App) BuildSQLAuditExport(filter sqlaudit.Filter, format string) connection.QueryResult {
	content, normalizedFormat, err := a.buildSQLAuditExport(filter, format)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	mimeType := "application/json;charset=utf-8"
	if normalizedFormat == "csv" {
		mimeType = "text/csv;charset=utf-8"
	}
	return connection.QueryResult{Success: true, Data: sqlAuditExportPayload{
		FileName: fmt.Sprintf("gonavi-sql-audit-%s.%s", time.Now().Format("20060102-150405"), normalizedFormat),
		MimeType: mimeType,
		Content:  string(content),
	}}
}

func (a *App) ExportSQLAuditFile(filter sqlaudit.Filter, format string) connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{
			Success: false,
			Message: "desktop file export is unavailable in web runtime; use BuildSQLAuditExport",
		}
	}
	content, normalizedFormat, err := a.buildSQLAuditExport(filter, format)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	fileName, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           "Export SQL audit",
		DefaultFilename: fmt.Sprintf("gonavi-sql-audit-%s.%s", time.Now().Format("20060102-150405"), normalizedFormat),
		Filters:         exportFileDialogFilters(normalizedFormat),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(fileName) == "" {
		return connection.QueryResult{Success: false, Message: "cancelled"}
	}
	fileName, err = a.resolveExportDialogTargetPath(fileName, normalizedFormat)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := a.validateSQLAuditExportTarget(fileName); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLAuditExportAtomically(fileName, content); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]string{"path": fileName}}
}

func (a *App) validateSQLAuditExportTarget(fileName string) error {
	for _, protectedPath := range []string{
		a.sqlAuditDatabasePath(),
		a.sqlAuditDatabasePath() + "-wal",
		a.sqlAuditDatabasePath() + "-shm",
		a.sqlAuditHealthFilePath(),
	} {
		same, err := sameSQLAuditFilePath(fileName, protectedPath)
		if err != nil {
			return err
		}
		if same {
			return errors.New("SQL audit export target cannot replace an internal audit storage file")
		}
	}
	return nil
}

func sameSQLAuditFilePath(left, right string) (bool, error) {
	leftAbs, err := resolveSQLAuditComparisonPath(left)
	if err != nil {
		return false, err
	}
	rightAbs, err := resolveSQLAuditComparisonPath(right)
	if err != nil {
		return false, err
	}
	if filepath.Clean(leftAbs) == filepath.Clean(rightAbs) ||
		strings.EqualFold(filepath.Clean(leftAbs), filepath.Clean(rightAbs)) {
		return true, nil
	}
	leftInfo, leftErr := os.Stat(leftAbs)
	rightInfo, rightErr := os.Stat(rightAbs)
	if leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo) {
		return true, nil
	}
	return false, nil
}

func resolveSQLAuditComparisonPath(path string) (string, error) {
	absPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absPath); resolveErr == nil {
		return filepath.Clean(resolved), nil
	}
	// Export targets can be new files. Resolve their existing parent so a
	// symlinked directory cannot bypass protection for a currently absent
	// SQLite WAL/SHM sidecar.
	parent := filepath.Dir(absPath)
	resolvedParent, resolveErr := filepath.EvalSymlinks(parent)
	if resolveErr == nil {
		return filepath.Join(resolvedParent, filepath.Base(absPath)), nil
	}
	return filepath.Clean(absPath), nil
}

func (a *App) buildSQLAuditExport(filter sqlaudit.Filter, format string) ([]byte, string, error) {
	normalizedFormat := strings.ToLower(strings.TrimSpace(format))
	if normalizedFormat != "json" && normalizedFormat != "csv" {
		return nil, "", fmt.Errorf("unsupported SQL audit export format %q", format)
	}
	health, healthRevision := a.sqlAuditHealthSnapshotWithRevision()
	if health.Status == sqlAuditHealthStatusDegraded {
		return nil, "", fmt.Errorf(
			"SQL audit export is unavailable while the writer is degraded (%d known dropped event(s)); retry after recovery records an audit_gap marker",
			health.DroppedEvents,
		)
	}
	var content []byte
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var exportErr error
		if a.webRuntime {
			content, exportErr = store.BuildExportWithLimits(
				filter,
				normalizedFormat,
				webSQLAuditExportMaxRecords,
				webSQLAuditExportMaxBytes,
			)
		} else {
			content, exportErr = store.BuildExport(filter, normalizedFormat)
		}
		return exportErr
	})
	if err == nil {
		afterHealth, afterRevision := a.sqlAuditHealthSnapshotWithRevision()
		if afterHealth.Status == sqlAuditHealthStatusDegraded || afterRevision != healthRevision {
			return nil, "", errors.New("SQL audit health changed during export; discard this export and retry after the writer is healthy")
		}
	}
	return content, normalizedFormat, err
}

func writeSQLAuditExportAtomically(fileName string, content []byte) error {
	return writeSQLAuditExportAtomicallyWithReplace(fileName, content, true)
}

func writeSQLAuditExportAtomicallyNoReplace(fileName string, content []byte) error {
	return writeSQLAuditExportAtomicallyWithReplace(fileName, content, false)
}

func writeSQLAuditExportAtomicallyWithReplace(fileName string, content []byte, replace bool) error {
	directory := filepath.Dir(filepath.Clean(fileName))
	temporary, err := os.CreateTemp(directory, ".gonavi-sql-audit-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	var publishErr error
	if replace {
		publishErr = replaceSQLAuditFile(temporaryName, fileName)
	} else {
		publishErr = atomicCreateSQLAuditFile(temporaryName, fileName)
	}
	if publishErr != nil {
		return publishErr
	}
	return os.Chmod(fileName, 0o600)
}
