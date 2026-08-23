package app

import (
	"io"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) ensureImportErrorArtifactStore() (*importErrorArtifactStore, error) {
	a.importArtifactMu.Lock()
	defer a.importArtifactMu.Unlock()
	if a.importErrorArtifacts != nil {
		return a.importErrorArtifacts, nil
	}
	configDir := strings.TrimSpace(a.configDir)
	if configDir == "" {
		configDir = resolveAppConfigDir()
	}
	store, err := newImportErrorArtifactStore(filepath.Join(configDir, "import-artifacts"))
	if err != nil {
		return nil, err
	}
	a.importErrorArtifacts = store
	return store, nil
}

// ExportImportErrorRows copies a managed rejected-row artifact to a path the
// desktop user explicitly selected. The opaque ID prevents arbitrary local
// files from being read through the RPC boundary.
func (a *App) ExportImportErrorRows(artifactID string) connection.QueryResult {
	store, err := a.ensureImportErrorArtifactStore()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	source, err := store.Open(artifactID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_error_artifact_not_found", nil)}
	}
	defer source.Close()

	targetPath, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("file.backend.dialog.export_import_errors", nil),
		DefaultFilename: "gonavi-import-errors.jsonl",
		Filters: []runtime.FileFilter{{
			DisplayName: "JSON Lines (*.jsonl)",
			Pattern:     "*.jsonl",
		}},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(targetPath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.message.user_cancelled", nil)}
	}
	target, err := createAtomicExportTarget(targetPath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer target.abort()
	if _, err := io.Copy(target.file, source); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := target.commit(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Data:    map[string]interface{}{"filePath": targetPath},
		Message: a.appText("file.backend.message.import_errors_exported", nil),
	}
}
