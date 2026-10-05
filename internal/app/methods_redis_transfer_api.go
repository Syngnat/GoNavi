package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) RedisExportKeys(config connection.ConnectionConfig, options RedisExportKeysOptions) (result connection.QueryResult) {
	config.Type = "redis"
	scope := normalizeRedisExportScope(options.Scope)
	if scope == "selected" && len(normalizeRedisTransferKeys(options.Keys)) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.export_no_keys", nil)}
	}

	defaultName := fmt.Sprintf("redis-db%d-keys.json", config.RedisDB)
	if scope == "selected" {
		defaultName = fmt.Sprintf("redis-db%d-selected-keys.json", config.RedisDB)
	}
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(defaultName, webDownloadMIMEForFormat("json"))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_data", nil),
			DefaultFilename: defaultName,
			Filters: []runtime.FileFilter{
				{
					DisplayName: a.appText("file.backend.filter.json_files", nil),
					Pattern:     "*.json",
				},
			},
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
	}
	filename = normalizeRedisTransferFilename(filename)

	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	payload, err := buildRedisExportPayload(client, config.RedisDB, options)
	if err != nil {
		if errors.Is(err, errRedisExportNoKeys) {
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.export_no_keys", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	content, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	if webTarget != nil {
		file, openErr := webTarget.openFile()
		if openErr != nil {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": openErr.Error()})}
		}
		_, writeErr := file.Write(content)
		closeErr := file.Close()
		if writeErr == nil {
			writeErr = closeErr
		}
		if writeErr != nil {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": writeErr.Error()})}
		}
	} else if err := os.WriteFile(filename, content, 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("redis.backend.message.export_success", nil),
		Data: map[string]any{
			"exported": len(payload.Keys),
			"file":     filename,
		},
	}
}

func (a *App) openRedisImportTransferFileDialog(dbIndex int) (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.import_data", map[string]any{
			"table": fmt.Sprintf("db%d", dbIndex),
		}),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.json_files", nil),
				Pattern:     "*.json",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*",
			},
		},
	})
}

func (a *App) RedisPreviewImportKeys(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	selection, err := a.openRedisImportTransferFileDialog(config.RedisDB)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	payload, err := readRedisTransferFileFromPath(selection)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_json_parse_failed", map[string]any{"detail": err.Error()})}
		}
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_payload_invalid", map[string]any{"detail": err.Error()})}
	}

	return connection.QueryResult{
		Success: true,
		Data:    buildRedisImportPreview(selection, payload),
	}
}

func (a *App) RedisImportKeys(config connection.ConnectionConfig, options RedisImportKeysOptions) connection.QueryResult {
	config.Type = "redis"
	selection := strings.TrimSpace(options.File)
	var err error
	if selection == "" {
		selection, err = a.openRedisImportTransferFileDialog(config.RedisDB)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	payload, err := readRedisTransferFileFromPath(selection)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_json_parse_failed", map[string]any{"detail": err.Error()})}
		}
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_payload_invalid", map[string]any{"detail": err.Error()})}
	}

	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	result, err := importRedisTransferPayload(client, payload, options)
	if err != nil {
		if errors.Is(err, errRedisImportNoKeysSelected) {
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_no_keys_selected", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("redis.backend.message.import_success", nil),
		Data: map[string]any{
			"imported": result["imported"],
			"skipped":  result["skipped"],
			"total":    result["total"],
			"file":     selection,
		},
	}
}
