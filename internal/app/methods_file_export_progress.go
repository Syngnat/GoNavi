package app

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/uievents"
)

type exportProgressPayload struct {
	JobID          string `json:"jobId"`
	Status         string `json:"status"`
	Stage          string `json:"stage"`
	Current        int64  `json:"current"`
	Total          int64  `json:"total,omitempty"`
	TotalRowsKnown bool   `json:"totalRowsKnown,omitempty"`
	Format         string `json:"format,omitempty"`
	TargetName     string `json:"targetName,omitempty"`
	FilePath       string `json:"filePath,omitempty"`
	Message        string `json:"message,omitempty"`
}

type exportProgressReporter struct {
	app            *App
	jobID          string
	format         string
	targetName     string
	filePath       string
	totalRows      int64
	totalRowsKnown bool
	lastRows       int64
	lastEmittedAt  time.Time
}

func newExportProgressReporter(a *App, options ExportFileOptions, targetName string, filePath string) *exportProgressReporter {
	jobID := strings.TrimSpace(options.JobID)
	if a == nil || a.ctx == nil || jobID == "" {
		return nil
	}
	filePath = strings.TrimSpace(filePath)
	if a.webRuntime && filePath != "" {
		filePath = filepath.Base(filePath)
	}
	return &exportProgressReporter{
		app:            a,
		jobID:          jobID,
		format:         strings.ToLower(strings.TrimSpace(options.Format)),
		targetName:     strings.TrimSpace(targetName),
		filePath:       filePath,
		totalRows:      normalizeExportTotalRowsHint(options.TotalRowsHint, options.TotalRowsKnown),
		totalRowsKnown: options.TotalRowsKnown,
	}
}

func (r *exportProgressReporter) emit(status string, stage string, current int64, message string, force bool) {
	if r == nil || r.app == nil || r.app.ctx == nil || r.jobID == "" {
		return
	}
	now := time.Now()
	if !force && status == "running" {
		if current-r.lastRows < exportProgressRowInterval && (!r.lastEmittedAt.IsZero() && now.Sub(r.lastEmittedAt) < exportProgressTimeInterval) {
			return
		}
	}
	payload := exportProgressPayload{
		JobID:          r.jobID,
		Status:         strings.TrimSpace(status),
		Stage:          strings.TrimSpace(stage),
		Current:        current,
		Total:          r.totalRows,
		TotalRowsKnown: r.totalRowsKnown,
		Format:         r.format,
		TargetName:     r.targetName,
		FilePath:       r.filePath,
		Message:        strings.TrimSpace(message),
	}
	uievents.Emit(r.app.ctx, exportProgressEvent, payload)
	r.lastRows = current
	r.lastEmittedAt = now
}

func (r *exportProgressReporter) Start(stage string) {
	r.emit("start", stage, 0, "", true)
}

func (r *exportProgressReporter) Rows(current int64, stage string) {
	r.emit("running", stage, current, "", false)
}

func (r *exportProgressReporter) ForceRunning(current int64, stage string) {
	r.emit("running", stage, current, "", true)
}

func (r *exportProgressReporter) text(key string, params map[string]any) string {
	if r == nil || r.app == nil {
		return key
	}
	return r.app.appText(key, params)
}

func (r *exportProgressReporter) Finalizing(current int64) {
	stageKey := "data_export.progress.stage.finalizing_file_write"
	if r != nil {
		switch strings.ToLower(strings.TrimSpace(r.format)) {
		case "xlsx":
			stageKey = "data_export.progress.stage.finalizing_xlsx_package"
		case "csv":
			stageKey = "data_export.progress.stage.finalizing_csv_write"
		}
	}
	r.emit("finalizing", r.text(stageKey, nil), current, "", true)
}

func (r *exportProgressReporter) Done(current int64) {
	r.emit("done", r.text("file.backend.message.export_completed", nil), current, "", true)
}

func (r *exportProgressReporter) Error(current int64, message string) {
	r.emit("error", r.text("data_export.progress.stage.export_failed", nil), current, message, true)
}

func resolveExportTotalRowValue(value interface{}) (int64, bool) {
	switch v := value.(type) {
	case int:
		if v < 0 {
			return 0, false
		}
		return int64(v), true
	case int8:
		if v < 0 {
			return 0, false
		}
		return int64(v), true
	case int16:
		if v < 0 {
			return 0, false
		}
		return int64(v), true
	case int32:
		if v < 0 {
			return 0, false
		}
		return int64(v), true
	case int64:
		if v < 0 {
			return 0, false
		}
		return v, true
	case uint:
		if uint64(v) > math.MaxInt64 {
			return 0, false
		}
		return int64(v), true
	case uint8:
		return int64(v), true
	case uint16:
		return int64(v), true
	case uint32:
		return int64(v), true
	case uint64:
		if v > math.MaxInt64 {
			return 0, false
		}
		return int64(v), true
	case float32:
		if !isFiniteFloat64(float64(v)) || v < 0 {
			return 0, false
		}
		return int64(v), true
	case float64:
		if !isFiniteFloat64(v) || v < 0 {
			return 0, false
		}
		return int64(v), true
	case json.Number:
		if i, err := v.Int64(); err == nil && i >= 0 {
			return i, true
		}
		if f, err := v.Float64(); err == nil && isFiniteFloat64(f) && f >= 0 {
			return int64(f), true
		}
	case []byte:
		return resolveExportTotalRowValue(string(v))
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			return 0, false
		}
		if i, err := strconv.ParseInt(text, 10, 64); err == nil && i >= 0 {
			return i, true
		}
		if f, err := strconv.ParseFloat(text, 64); err == nil && isFiniteFloat64(f) && f >= 0 {
			return int64(f), true
		}
	}
	return 0, false
}

func isFiniteFloat64(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func resolveExportTotalRowsFromRows(rows []map[string]interface{}) (int64, bool) {
	if len(rows) == 0 || rows[0] == nil {
		return 0, false
	}
	row := rows[0]
	preferredKeys := []string{"total", "TOTAL", "count", "COUNT", "cnt", "CNT", "table_rows", "TABLE_ROWS"}
	for _, key := range preferredKeys {
		if value, ok := row[key]; ok {
			if total, ok := resolveExportTotalRowValue(value); ok {
				return total, true
			}
		}
	}
	for _, value := range row {
		if total, ok := resolveExportTotalRowValue(value); ok {
			return total, true
		}
	}
	return 0, false
}

func tryResolveExportTableTotalRows(dbInst db.Database, config connection.ConnectionConfig, tableName string) (int64, bool) {
	dbType := resolveDDLDBType(config)
	query := fmt.Sprintf("SELECT COUNT(*) AS total FROM %s", quoteQualifiedIdentByType(dbType, tableName))
	rows, _, err := queryDataForExport(dbInst, config, query)
	if err != nil {
		return 0, false
	}
	return resolveExportTotalRowsFromRows(rows)
}
