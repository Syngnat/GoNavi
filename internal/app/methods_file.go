package app

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	goRuntime "runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
	"GoNavi-Wails/internal/uievents"

	"github.com/google/uuid"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const minExportQueryTimeout = 5 * time.Minute
const minClickHouseExportQueryTimeout = 2 * time.Hour
const maxSQLFileSizeBytes int64 = 50 * 1024 * 1024

const sqlFileErrorCodeNotFound = "file_not_found"
const sqlDirectoryErrorCodeNotFound = "directory_not_found"
const sqlFileBatchMaxStatements = 1000
const sqlFileBatchMaxBytes = 4 * 1024 * 1024
const sqlFileProgressStatementInterval = 100
const sqlFileProgressTimeInterval = time.Second
const sqlFileSessionCleanupTimeout = 5 * time.Second
const sqlFileMaxErrorDetails = 20
const sqlFileBatchIsolationSequentialThreshold = 16
const exportProgressEvent = "export:progress"
const exportProgressRowInterval int64 = 1000
const exportProgressTimeInterval = 500 * time.Millisecond
const sqlExportInsertBatchMaxRows = 200
const sqlExportInsertBatchMaxBytes = 256 * 1024
const defaultAppLogTailLineLimit = 80
const maxAppLogTailLineLimit = 200
const appLogTailReadWindowBytes int64 = 256 * 1024

var mysqlCreateViewPrefixPattern = regexp.MustCompile(`(?is)^\s*create\s+(?:algorithm\s*=\s*\w+\s+)?(?:definer\s*=\s*(?:` + "`[^`]+`" + `|\S+)\s*@\s*(?:` + "`[^`]+`" + `|\S+)\s+)?(?:sql\s+security\s+(?:definer|invoker)\s+)?view\s+`)
var sqlFileMySQLAutocommitAssignmentPattern = regexp.MustCompile(`(?is)(?:^|,)\s*(?:(?:session|local)\s+)?(?:@@\s*(?:session\s*\.\s*)?)?autocommit\s*(?::=|=)\s*([^,;\s]+)`)
var jsonNumberSQLLiteralPattern = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`)

type saveFileDialogFunc func(context.Context, runtime.SaveDialogOptions) (string, error)

func (a *App) showSaveFileDialog(options runtime.SaveDialogOptions) (string, error) {
	if a.saveFileDialog != nil {
		return a.saveFileDialog(a.ctx, options)
	}
	return runtime.SaveFileDialog(a.ctx, options)
}

type sqlFileExecutionProgress struct {
	Status     string
	Executed   int
	Failed     int
	Total      int
	BytesRead  int64
	CurrentSQL string
	Error      string
}

type sqlFileExecutionOptions struct {
	DBType                 string
	BatchMaxStatements     int
	BatchMaxBytes          int
	MaxStatementBytes      int64
	ContinueOnError        bool
	PreflightEachStatement bool
	TransactionMode        sqlFileTransactionMode
	StatementGuard         func(index int, stmt string) error
	SkipStatement          func(index int, stmt string) bool
	Text                   fileBackendTextFunc
	OnProgress             func(sqlFileExecutionProgress)
}

type sqlFileTransactionMode string

const (
	sqlFileTransactionModeOff    sqlFileTransactionMode = "off"
	sqlFileTransactionModeSingle sqlFileTransactionMode = "single"
)

type sqlFileExecutionPolicy struct {
	TransactionMode    sqlFileTransactionMode
	ForceFullPreflight bool
	StatementGuard     func(index int, stmt string) error
	SkipStatement      func(index int, stmt string) bool
	MySQLGTIDMode      mysqlGTIDImportMode
}

type sqlFileExecutionResult struct {
	Executed       int
	Failed         int
	Errors         []string
	OutcomeUnknown bool
}

type sqlFilePendingStatement struct {
	Index int
	SQL   string
}

var errSQLFileStoppedOnError = errors.New("sql file execution stopped on error")

type sqlFileCancelledError struct{}

func (sqlFileCancelledError) Error() string { return "已取消" }

func (sqlFileCancelledError) Unwrap() error { return context.Canceled }

var errSQLFileCancelled error = sqlFileCancelledError{}

type sqlFileStoppedOnError struct {
	detail string
}

type sqlFilePreflightRejectedError struct {
	reason              SQLImportPreflightReason
	executed            int
	failed              int
	possibleSideEffects bool
	outcomeUnknown      bool
}

// sqlFilePolicyRejectedError marks a statement guard denial found while the
// source is still being preflighted. The outer runner can then report it as a
// pre-execution failure rather than an open-file error.
type sqlFilePolicyRejectedError struct {
	err error
}

func (err *sqlFilePolicyRejectedError) Error() string {
	if err == nil || err.err == nil {
		return "SQL file execution policy rejected the source"
	}
	return err.err.Error()
}

func (err *sqlFilePolicyRejectedError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.err
}

func (err *sqlFilePreflightRejectedError) Error() string {
	if err == nil {
		return ""
	}
	reason := string(err.reason.Code)
	if err.reason.Directive != "" {
		reason += ": " + err.reason.Directive
	}
	if !err.possibleSideEffects && err.executed == 0 && err.failed == 0 {
		return fmt.Sprintf("SQL import preflight rejected unsupported client script (%s); no database statement was executed", reason)
	}
	return fmt.Sprintf("SQL import preflight rejected unsupported client script (%s); %d preceding statement(s) may already have completed", reason, err.executed+err.failed)
}

func buildSQLFilePreflightFailurePayload(err *sqlFilePreflightRejectedError) map[string]interface{} {
	executed := 0
	failed := 0
	reason := ""
	directive := ""
	if err != nil {
		executed = err.executed
		failed = err.failed
		reason = string(err.reason.Code)
		directive = err.reason.Directive
	}
	payload := buildSQLFileExecutionPayload(executed, failed, "failed")
	payload["preflightRejected"] = true
	payload["preflightReason"] = reason
	payload["preflightDirective"] = directive
	payload["previousStatementsMayHaveCompleted"] = err != nil && (err.possibleSideEffects || executed > 0 || failed > 0)
	payload["outcomeUnknown"] = err != nil && err.outcomeUnknown
	return payload
}

func isSQLFilePreExecutionValidationError(err error) bool {
	var preflightErr *sqlFilePreflightRejectedError
	var policyErr *sqlFilePolicyRejectedError
	var statementLimitErr *SQLStatementTooLargeError
	var sourceLimitErr *SQLImportSourceLimitError
	return errors.As(err, &preflightErr) || errors.As(err, &policyErr) || errors.As(err, &statementLimitErr) || errors.As(err, &sourceLimitErr)
}

func (e *sqlFileStoppedOnError) Error() string {
	if e == nil {
		return ""
	}
	return e.detail
}

func (e *sqlFileStoppedOnError) Unwrap() error {
	return errSQLFileStoppedOnError
}

type sqlFileStatementExecer interface {
	Exec(query string) (int64, error)
}

type sqlFileContextStatementExecer interface {
	ExecContext(ctx context.Context, query string) (int64, error)
}

type sqlFileBatchStatementExecer interface {
	ExecBatchContext(ctx context.Context, query string) (int64, error)
}

type SQLDirectoryEntry struct {
	Name     string              `json:"name"`
	Path     string              `json:"path"`
	IsDir    bool                `json:"isDir"`
	Children []SQLDirectoryEntry `json:"children,omitempty"`
}

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

type appLogTailSnapshot struct {
	LogPath               string         `json:"logPath"`
	Keyword               string         `json:"keyword,omitempty"`
	RequestedLineLimit    int            `json:"requestedLineLimit"`
	ReturnedLineCount     int            `json:"returnedLineCount"`
	FileWindowTruncated   bool           `json:"fileWindowTruncated"`
	MatchedLinesTruncated bool           `json:"matchedLinesTruncated"`
	LevelBreakdown        map[string]int `json:"levelBreakdown"`
	Lines                 []string       `json:"lines"`
}

func normalizeSQLFileName(rawName string) (string, error) {
	return normalizeSQLFileNameWithText(rawName, nil)
}

func normalizeSQLFileNameWithText(rawName string, text fileBackendTextFunc) (string, error) {
	name := strings.TrimSpace(rawName)
	if name == "" {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.sql_file_name_required", nil))
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.sql_file_name_no_separator", nil))
	}
	if !strings.EqualFold(filepath.Ext(name), ".sql") {
		name += ".sql"
	}
	return name, nil
}

func normalizeSQLDirectoryName(rawName string) (string, error) {
	return normalizeSQLDirectoryNameWithText(rawName, nil)
}

func normalizeSQLDirectoryNameWithText(rawName string, text fileBackendTextFunc) (string, error) {
	name := strings.TrimSpace(rawName)
	if name == "" {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_name_required", nil))
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_name_no_separator", nil))
	}
	return name, nil
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

func verifyOptionalDriverAgentReadyForExport(config connection.ConnectionConfig) error {
	driverType := normalizeDriverType(config.Type)
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") &&
		strings.EqualFold(strings.TrimSpace(config.Driver), "clickhouse") {
		driverType = "clickhouse"
	}
	if !db.IsOptionalGoDriver(driverType) {
		return nil
	}

	executablePath, err := resolveOptionalDriverAgentExecutablePathFunc("", driverType)
	if err != nil {
		return err
	}
	if _, err := verifyInstalledOptionalDriverAgentRevision(driverType, executablePath); err != nil {
		displayName := resolveDriverDisplayName(driverDefinition{Type: driverType})
		return fmt.Errorf("%s", defaultAppText("file.backend.error.export_driver_agent_streaming_required", map[string]any{
			"driver": displayName,
			"detail": err.Error(),
		}))
	}
	return nil
}

var exportFileNameSanitizer = strings.NewReplacer(
	"/", "_",
	"\\", "_",
	":", "_",
	"*", "_",
	"?", "_",
	"\"", "_",
	"<", "_",
	">", "_",
	"|", "_",
)

func sanitizeExportFileStem(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "export"
	}
	value = exportFileNameSanitizer.Replace(value)
	value = strings.Trim(value, ". ")
	if value == "" {
		return "export"
	}
	return value
}

func resolveSQLExportSuffix(includeSchema bool, includeData bool) string {
	if includeSchema && includeData {
		return "backup"
	}
	if includeData {
		return "data"
	}
	return "schema"
}

func normalizeExportNameList(names []string) []string {
	normalized := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		safeName := strings.TrimSpace(name)
		if safeName == "" {
			continue
		}
		if _, ok := seen[safeName]; ok {
			continue
		}
		seen[safeName] = struct{}{}
		normalized = append(normalized, safeName)
	}
	return normalized
}

func buildTablesExportDefaultFilename(dbName string, objectNames []string, includeSchema bool, includeData bool) string {
	suffix := resolveSQLExportSuffix(includeSchema, includeData)
	if len(objectNames) == 1 {
		return fmt.Sprintf("%s_%s.sql", sanitizeExportFileStem(objectNames[0]), suffix)
	}
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		safeDbName = "export"
	}
	return fmt.Sprintf("%s_%s_%dtables.sql", sanitizeExportFileStem(safeDbName), suffix, len(objectNames))
}

func buildDatabaseExportDefaultFilename(dbName string, includeData bool) string {
	suffix := "schema"
	if includeData {
		suffix = "backup"
	}
	return fmt.Sprintf("%s_%s.sql", sanitizeExportFileStem(dbName), suffix)
}

func resolveBatchObjectsTargetName(dbName string, objectNames []string) string {
	return resolveBatchObjectsTargetNameWithText(dbName, objectNames, nil)
}

func resolveBatchObjectsTargetNameWithText(dbName string, objectNames []string, text fileBackendTextFunc) string {
	if len(objectNames) == 1 {
		return objectNames[0]
	}
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		safeDbName = fileBackendText(text, "data_export.workbench.target.current_database", nil)
	}
	return fileBackendText(text, "data_export.workbench.target.batch_tables", map[string]any{
		"database": safeDbName,
		"count":    len(objectNames),
	})
}

func normalizeSQLDirectoryPath(directoryPath string) (string, error) {
	return normalizeSQLDirectoryPathWithText(directoryPath, nil)
}

func normalizeSQLDirectoryPathWithText(directoryPath string, text fileBackendTextFunc) (string, error) {
	target := strings.TrimSpace(directoryPath)
	if target == "" {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_path_required", nil))
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()}))
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.selected_path_not_directory", nil))
	}
	return target, nil
}

func normalizeExistingSQLDirectoryPath(directoryPath string) (string, os.FileInfo, error) {
	return normalizeExistingSQLDirectoryPathWithText(directoryPath, nil)
}

func normalizeExistingSQLDirectoryPathWithText(directoryPath string, text fileBackendTextFunc) (string, os.FileInfo, error) {
	target := strings.TrimSpace(directoryPath)
	if target == "" {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_path_required", nil))
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()}))
	}
	if !info.IsDir() {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.selected_path_not_directory", nil))
	}
	return target, info, nil
}

func normalizeExistingSQLFilePath(filePath string) (string, os.FileInfo, error) {
	return normalizeExistingSQLFilePathWithText(filePath, nil)
}

func normalizeExistingSQLFilePathWithText(filePath string, text fileBackendTextFunc) (string, os.FileInfo, error) {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.file_path_required", nil))
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()}))
	}
	if info.IsDir() {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil))
	}
	if !strings.EqualFold(filepath.Ext(target), ".sql") {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.sql_file_extension_required", nil))
	}
	return target, info, nil
}

func createSQLFileInDirectory(directoryPath string, rawName string) connection.QueryResult {
	return createSQLFileInDirectoryWithText(directoryPath, rawName, nil)
}

func createSQLFileInDirectoryWithText(directoryPath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	directory, err := normalizeSQLDirectoryPathWithText(directoryPath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLFileNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(directory, name)
	if _, err := os.Lstat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.sql_file_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.WriteFile(target, []byte(""), 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.create_sql_file_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target, "name": filepath.Base(target)}}
}

func createSQLDirectoryInDirectory(parentPath string, rawName string) connection.QueryResult {
	return createSQLDirectoryInDirectoryWithText(parentPath, rawName, nil)
}

func createSQLDirectoryInDirectoryWithText(parentPath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	parent, err := normalizeSQLDirectoryPathWithText(parentPath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLDirectoryNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(parent, name)
	if _, err := os.Stat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.directory_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.create_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "name": filepath.Base(target)}}
}

func deleteSQLFileByPath(filePath string) connection.QueryResult {
	return deleteSQLFileByPathWithText(filePath, nil)
}

func deleteSQLFileByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	target, _, err := normalizeExistingSQLFilePathWithText(filePath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := os.Remove(target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.delete_sql_file_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target}}
}

func deleteSQLDirectoryByPath(directoryPath string) connection.QueryResult {
	return deleteSQLDirectoryByPathWithText(directoryPath, nil)
}

func deleteSQLDirectoryByPathWithText(directoryPath string, text fileBackendTextFunc) connection.QueryResult {
	target := strings.TrimSpace(directoryPath)
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.directory_path_required", nil)}
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if os.IsNotExist(err) {
		return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "alreadyMissing": true}}
	}
	if err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()})}
	}
	if !info.IsDir() {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_directory", nil)}
	}
	if err := os.Remove(target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.delete_sql_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target}}
}

func renameSQLFileByPath(filePath string, rawName string) connection.QueryResult {
	return renameSQLFileByPathWithText(filePath, rawName, nil)
}

func renameSQLFileByPathWithText(filePath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	source, _, err := normalizeExistingSQLFilePathWithText(filePath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLFileNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(filepath.Dir(source), name)
	if source == target {
		return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target, "name": filepath.Base(target)}}
	}
	if _, err := os.Stat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.target_sql_file_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_target_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.Rename(source, target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.rename_sql_file_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target, "name": filepath.Base(target)}}
}

func renameSQLDirectoryByPath(directoryPath string, rawName string) connection.QueryResult {
	return renameSQLDirectoryByPathWithText(directoryPath, rawName, nil)
}

func renameSQLDirectoryByPathWithText(directoryPath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	source, _, err := normalizeExistingSQLDirectoryPathWithText(directoryPath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLDirectoryNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(filepath.Dir(source), name)
	if source == target {
		return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "name": filepath.Base(target)}}
	}
	if _, err := os.Stat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.target_directory_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_target_directory_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.Rename(source, target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.rename_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "name": filepath.Base(target)}}
}

func normalizeDirectoryDialogPath(currentDir string) string {
	defaultDir := strings.TrimSpace(currentDir)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = home
		}
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if defaultDir != "" && !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}
	return defaultDir
}

func absDialogPath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	if abs, err := filepath.Abs(trimmed); err == nil {
		return abs
	}
	return trimmed
}

// resolveFileOpenDialogDirectory picks the directory for OpenFileDialog.
// currentPath may be a previously selected file, including extensionless SSH keys
// such as id_rsa / id_ed25519 / custom names under ~/.ssh.
func resolveFileOpenDialogDirectory(currentPath string, emptyFallback string) string {
	path := strings.TrimSpace(currentPath)
	if path == "" {
		path = strings.TrimSpace(emptyFallback)
	}
	if path == "" {
		return ""
	}

	if info, err := os.Stat(path); err == nil {
		if info.IsDir() {
			return absDialogPath(path)
		}
		return absDialogPath(filepath.Dir(path))
	}

	// Path does not exist: treat it as a file location when a parent exists.
	parent := filepath.Dir(path)
	if parent != "" && parent != "." && parent != path {
		return absDialogPath(parent)
	}
	return absDialogPath(path)
}

type fileBackendTextFunc func(key string, params map[string]any) string

func fileBackendText(text fileBackendTextFunc, key string, params map[string]any) string {
	if text == nil {
		return key
	}
	return text(key, params)
}

func readSQLFileByPath(filePath string) connection.QueryResult {
	return readSQLFileByPathWithText(filePath, nil)
}

func resolveSQLFilePathInfoWithText(filePath string, text fileBackendTextFunc) (string, os.FileInfo, *connection.QueryResult) {
	selection := strings.TrimSpace(filePath)
	if selection == "" {
		result := connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.file_path_required", nil)}
		return "", nil, &result
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}

	fi, err := os.Stat(selection)
	if err != nil {
		data := map[string]interface{}{"filePath": selection}
		if os.IsNotExist(err) {
			data["errorCode"] = sqlFileErrorCodeNotFound
		}
		result := connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()}), Data: data}
		return "", nil, &result
	}
	if fi.IsDir() {
		result := connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil)}
		return "", nil, &result
	}
	return selection, fi, nil
}

func buildSQLFileSelectionMetadata(selection string, fileSize int64) map[string]interface{} {
	return map[string]interface{}{
		"filePath":   selection,
		"name":       filepath.Base(selection),
		"fileSize":   fileSize,
		"fileSizeMB": fmt.Sprintf("%.1f", float64(fileSize)/(1024*1024)),
	}
}

func readSQLFileByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	selection, fi, failed := resolveSQLFilePathInfoWithText(filePath, text)
	if failed != nil {
		return *failed
	}

	if fi.Size() > maxSQLFileSizeBytes {
		payload := buildSQLFileSelectionMetadata(selection, fi.Size())
		payload["isLargeFile"] = true
		return connection.QueryResult{
			Success: true,
			Data:    payload,
		}
	}

	content, err := os.ReadFile(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: string(content)}
}

func selectSQLFileForExecutionByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	selection, fi, failed := resolveSQLFilePathInfoWithText(filePath, text)
	if failed != nil {
		return *failed
	}
	return connection.QueryResult{
		Success: true,
		Data:    buildSQLFileSelectionMetadata(selection, fi.Size()),
	}
}

func sqlFileExecutionDialogFilters(text fileBackendTextFunc) []runtime.FileFilter {
	return sqlFileExecutionDialogFiltersForPlatform(text, goRuntime.GOOS)
}

func sqlFileExecutionDialogFiltersForPlatform(text fileBackendTextFunc, platform string) []runtime.FileFilter {
	pattern := "*.sql;*.sql.gz"
	includeAllFiles := true
	// Wails turns compound extensions into UTTypes on macOS. "sql.gz" is not
	// recognized and makes the native dialog abort; "gz" keeps gzip SQL selectable.
	if platform == "darwin" {
		pattern = "*.sql;*.gz"
		includeAllFiles = false
	}

	filters := []runtime.FileFilter{
		{
			DisplayName: fileBackendText(text, "file.backend.filter.sql_files", nil),
			Pattern:     pattern,
		},
	}
	if includeAllFiles {
		filters = append(filters, runtime.FileFilter{
			DisplayName: fileBackendText(text, "file.backend.filter.all_files_pattern", nil),
			Pattern:     "*.*",
		})
	}
	return filters
}

func readSQLFileWithMetadataByPath(filePath string) connection.QueryResult {
	return readSQLFileWithMetadataByPathWithText(filePath, nil)
}

func readSQLFileWithMetadataByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	result := readSQLFileByPathWithText(filePath, text)
	if !result.Success {
		return result
	}
	if data, ok := result.Data.(map[string]interface{}); ok {
		return connection.QueryResult{Success: true, Data: data}
	}
	selection := strings.TrimSpace(filePath)
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"content":  result.Data,
			"filePath": selection,
			"name":     filepath.Base(selection),
		},
	}
}

func writeSQLFileByPath(filePath string, content string) connection.QueryResult {
	return writeSQLFileByPathWithText(filePath, content, nil)
}

func writeSQLFileByPathWithText(filePath string, content string, text fileBackendTextFunc) connection.QueryResult {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.file_path_required", nil)}
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}

	info, err := os.Stat(target)
	if err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if info.IsDir() {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil)}
	}

	if err := os.WriteFile(target, []byte(content), info.Mode().Perm()); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target}}
}

func normalizeSQLExportDefaultFilename(rawName string) string {
	name := strings.TrimSpace(rawName)
	if name == "" {
		name = "query"
	}
	if idx := strings.LastIndexAny(name, `/\`); idx >= 0 {
		name = name[idx+1:]
	}
	if name == "." || name == string(filepath.Separator) {
		name = "query"
	}
	name = strings.NewReplacer(
		"/", "_",
		"\\", "_",
		":", "_",
		"*", "_",
		"?", "_",
		"\"", "_",
		"<", "_",
		">", "_",
		"|", "_",
	).Replace(strings.TrimSpace(name))
	if name == "" {
		name = "query"
	}
	if !strings.EqualFold(filepath.Ext(name), ".sql") {
		name += ".sql"
	}
	return name
}

func exportFormatExtension(format string) string {
	switch normalized := strings.ToLower(strings.TrimSpace(format)); normalized {
	case "csv", "xlsx", "json", "md", "html", "sql":
		return "." + normalized
	default:
		return ""
	}
}

func normalizeExportTargetPath(filePath string, format string) string {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return ""
	}
	if extension := exportFormatExtension(format); extension != "" && !strings.EqualFold(filepath.Ext(target), extension) {
		target += extension
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	return target
}

type exportTargetOverwriteConfirmationError struct {
	targetPath string
	extension  string
}

func (e *exportTargetOverwriteConfirmationError) Error() string {
	return fmt.Sprintf("target file already exists after adding %s: %s", e.extension, e.targetPath)
}

func resolveExportTargetPath(filePath string, format string) (string, error) {
	selected := strings.TrimSpace(filePath)
	target := normalizeExportTargetPath(selected, format)
	if selected == "" || target == "" {
		return target, nil
	}
	if abs, err := filepath.Abs(selected); err == nil {
		selected = abs
	}
	if filepath.Clean(selected) == filepath.Clean(target) {
		return target, nil
	}
	if _, err := os.Stat(target); err == nil {
		return "", &exportTargetOverwriteConfirmationError{
			targetPath: target,
			extension:  exportFormatExtension(format),
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return target, nil
}

func exportTargetPathErrorMessage(err error, text fileBackendTextFunc) string {
	var overwriteErr *exportTargetOverwriteConfirmationError
	if errors.As(err, &overwriteErr) {
		return fileBackendText(text, "file.backend.error.target_file_overwrite_confirmation_required", map[string]any{
			"extension": overwriteErr.extension,
			"path":      overwriteErr.targetPath,
		})
	}
	return fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})
}

func (a *App) resolveExportDialogTargetPath(filePath string, format string) (string, error) {
	target, err := resolveExportTargetPath(filePath, format)
	if err != nil {
		return "", errors.New(exportTargetPathErrorMessage(err, a.appText))
	}
	return target, nil
}

func exportFileDialogFilters(format string) []runtime.FileFilter {
	extension := exportFormatExtension(format)
	if extension == "" {
		return nil
	}
	return []runtime.FileFilter{{
		DisplayName: strings.ToUpper(strings.TrimPrefix(extension, ".")),
		Pattern:     "*" + extension,
	}}
}

func normalizeSQLExportTargetPath(filePath string) string {
	return normalizeExportTargetPath(filePath, "sql")
}

func writeExportedSQLFileByPath(filePath string, content string) connection.QueryResult {
	return writeExportedSQLFileByPathWithText(filePath, content, nil)
}

func writeExportedSQLFileByPathWithText(filePath string, content string, text fileBackendTextFunc) connection.QueryResult {
	target, targetErr := resolveExportTargetPath(filePath, "sql")
	if targetErr != nil {
		return connection.QueryResult{Success: false, Message: exportTargetPathErrorMessage(targetErr, text)}
	}
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.file_path_required", nil)}
	}
	if info, err := os.Stat(target); err == nil && info.IsDir() {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil)}
	} else if err != nil && !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target}}
}

func buildSQLDirectoryEntries(directory string) ([]SQLDirectoryEntry, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}

	result := make([]SQLDirectoryEntry, 0, len(entries))
	for _, entry := range entries {
		entryPath := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			children, childErr := buildSQLDirectoryEntries(entryPath)
			if childErr != nil {
				return nil, childErr
			}
			result = append(result, SQLDirectoryEntry{
				Name:     entry.Name(),
				Path:     entryPath,
				IsDir:    true,
				Children: children,
			})
			continue
		}
		if !strings.EqualFold(filepath.Ext(entry.Name()), ".sql") {
			continue
		}
		result = append(result, SQLDirectoryEntry{
			Name:  entry.Name(),
			Path:  entryPath,
			IsDir: false,
		})
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}

func (a *App) OpenSQLFile() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.select_sql_file", nil),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.sql_files", nil),
				Pattern:     "*.sql",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files_pattern", nil),
				Pattern:     "*.*",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	return readSQLFileWithMetadataByPathWithText(selection, a.appText)
}

func (a *App) SelectSQLFileForExecution() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   a.appText("file.backend.dialog.select_sql_file", nil),
		Filters: sqlFileExecutionDialogFilters(a.appText),
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	return selectSQLFileForExecutionByPathWithText(selection, a.appText)
}

func (a *App) SelectSQLDirectory(currentDir string) connection.QueryResult {
	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("file.backend.dialog.select_sql_directory", nil),
		DefaultDirectory: normalizeDirectoryDialogPath(currentDir),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	name := filepath.Base(selection)
	if name == "." || name == string(filepath.Separator) {
		name = selection
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection, "name": name}}
}

func (a *App) ListSQLDirectory(directory string) connection.QueryResult {
	target := strings.TrimSpace(directory)
	if target == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.directory_path_required", nil)}
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}

	info, err := os.Stat(target)
	if err != nil {
		data := map[string]interface{}{"directoryPath": target}
		if os.IsNotExist(err) {
			data["errorCode"] = sqlDirectoryErrorCodeNotFound
		}
		return connection.QueryResult{Success: false, Message: err.Error(), Data: data}
	}
	if !info.IsDir() {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.selected_path_not_directory", nil)}
	}

	entries, err := buildSQLDirectoryEntries(target)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: entries}
}

func (a *App) ReadSQLFile(filePath string) connection.QueryResult {
	return readSQLFileByPathWithText(filePath, a.appText)
}

func (a *App) ReadAppLogTail(lineLimit int, keyword string) connection.QueryResult {
	return readAppLogTailByPathWithText(logger.Path(), lineLimit, keyword, a.appText)
}

func (a *App) WriteSQLFile(filePath string, content string) connection.QueryResult {
	return writeSQLFileByPathWithText(filePath, content, a.appText)
}

func normalizeAppLogTailLineLimit(input int) int {
	if input <= 0 {
		return defaultAppLogTailLineLimit
	}
	if input > maxAppLogTailLineLimit {
		return maxAppLogTailLineLimit
	}
	return input
}

func redactAppLogSQLFields(line string) string {
	searchFrom := 0
	for searchFrom < len(line) {
		fieldStart, fieldLength := findSQLLogField(line, searchFrom)
		if fieldStart < 0 {
			break
		}
		valueStart := fieldStart + fieldLength
		if valueStart >= len(line) {
			break
		}
		valueEnd := valueStart
		var value string
		if line[valueStart] == '"' {
			valueEnd++
			escaped := false
			for valueEnd < len(line) {
				if escaped {
					escaped = false
					valueEnd++
					continue
				}
				if line[valueEnd] == '\\' {
					escaped = true
					valueEnd++
					continue
				}
				if line[valueEnd] == '"' {
					valueEnd++
					break
				}
				valueEnd++
			}
			if valueEnd > len(line) || valueEnd <= valueStart+1 {
				break
			}
			decoded, err := strconv.Unquote(line[valueStart:valueEnd])
			if err != nil {
				break
			}
			value = strconv.Quote(sqlaudit.RedactSQL(decoded))
		} else {
			valueEnd = len(line)
			value = sqlaudit.RedactSQL(line[valueStart:valueEnd])
		}
		line = line[:valueStart] + value + line[valueEnd:]
		searchFrom = valueStart + len(value)
	}
	return sqlaudit.RedactError(line)
}

func findSQLLogField(line string, start int) (int, int) {
	lower := strings.ToLower(line)
	bestIndex := -1
	bestLength := 0
	for _, marker := range []string{"sql片段=", "sqltext=", "sql="} {
		if index := strings.Index(lower[start:], marker); index >= 0 {
			index += start
			if bestIndex < 0 || index < bestIndex {
				bestIndex = index
				bestLength = len(marker)
			}
		}
	}
	return bestIndex, bestLength
}

func readAppLogTailWindow(filePath string, maxBytes int64) ([]byte, bool, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	size := fi.Size()
	if size <= 0 {
		return []byte{}, false, nil
	}

	offset := int64(0)
	truncated := false
	if maxBytes > 0 && size > maxBytes {
		offset = size - maxBytes
		truncated = true
	}

	buf := make([]byte, size-offset)
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return nil, false, err
	}
	if !truncated {
		return buf, false, nil
	}

	text := string(buf)
	if idx := strings.IndexByte(text, '\n'); idx >= 0 && idx+1 < len(text) {
		return []byte(text[idx+1:]), true, nil
	}
	return []byte{}, true, nil
}

func buildAppLogLevelBreakdown(lines []string) map[string]int {
	breakdown := map[string]int{
		"INFO":  0,
		"WARN":  0,
		"ERROR": 0,
		"OTHER": 0,
	}
	for _, line := range lines {
		switch {
		case strings.Contains(line, "[INFO]"):
			breakdown["INFO"]++
		case strings.Contains(line, "[WARN]"):
			breakdown["WARN"]++
		case strings.Contains(line, "[ERROR]"):
			breakdown["ERROR"]++
		default:
			breakdown["OTHER"]++
		}
	}
	return breakdown
}

func readAppLogTailByPath(filePath string, lineLimit int, keyword string) connection.QueryResult {
	return readAppLogTailByPathWithText(filePath, lineLimit, keyword, nil)
}

func readAppLogTailByPathWithText(filePath string, lineLimit int, keyword string, text fileBackendTextFunc) connection.QueryResult {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.app_log_file_not_found", nil)}
	}

	if _, err := os.Stat(target); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	windowBytes, fileWindowTruncated, err := readAppLogTailWindow(target, appLogTailReadWindowBytes)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	normalizedKeyword := strings.ToLower(strings.TrimSpace(keyword))
	normalizedLineLimit := normalizeAppLogTailLineLimit(lineLimit)
	rawLines := strings.Split(strings.ReplaceAll(string(windowBytes), "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(rawLines))
	for _, rawLine := range rawLines {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		lines = append(lines, redactAppLogSQLFields(line))
	}

	filteredLines := make([]string, 0, len(lines))
	for _, line := range lines {
		if normalizedKeyword != "" && !strings.Contains(strings.ToLower(line), normalizedKeyword) {
			continue
		}
		filteredLines = append(filteredLines, line)
	}

	matchedLinesTruncated := len(filteredLines) > normalizedLineLimit
	if matchedLinesTruncated {
		filteredLines = filteredLines[len(filteredLines)-normalizedLineLimit:]
	}

	snapshot := appLogTailSnapshot{
		LogPath:               target,
		Keyword:               strings.TrimSpace(keyword),
		RequestedLineLimit:    normalizedLineLimit,
		ReturnedLineCount:     len(filteredLines),
		FileWindowTruncated:   fileWindowTruncated,
		MatchedLinesTruncated: matchedLinesTruncated,
		LevelBreakdown:        buildAppLogLevelBreakdown(filteredLines),
		Lines:                 filteredLines,
	}
	return connection.QueryResult{Success: true, Data: snapshot}
}

func (a *App) CreateSQLFile(directoryPath string, name string) connection.QueryResult {
	return createSQLFileInDirectoryWithText(directoryPath, name, a.appText)
}

func (a *App) CreateSQLDirectory(directoryPath string, name string) connection.QueryResult {
	return createSQLDirectoryInDirectoryWithText(directoryPath, name, a.appText)
}

func (a *App) DeleteSQLFile(filePath string) connection.QueryResult {
	return deleteSQLFileByPathWithText(filePath, a.appText)
}

func (a *App) DeleteSQLDirectory(directoryPath string) connection.QueryResult {
	return deleteSQLDirectoryByPathWithText(directoryPath, a.appText)
}

func (a *App) RenameSQLFile(filePath string, name string) connection.QueryResult {
	return renameSQLFileByPathWithText(filePath, name, a.appText)
}

func (a *App) RenameSQLDirectory(directoryPath string, name string) connection.QueryResult {
	return renameSQLDirectoryByPathWithText(directoryPath, name, a.appText)
}

func (a *App) ExportSQLFile(defaultName string, content string) connection.QueryResult {
	filename, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("query_editor.action.export_sql_file", nil),
		DefaultFilename: normalizeSQLExportDefaultFilename(defaultName),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.sql_files", nil),
				Pattern:     "*.sql",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files_pattern", nil),
				Pattern:     "*.*",
			},
		},
	})
	if err != nil || strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	result := writeExportedSQLFileByPathWithText(filename, content, a.appText)
	if result.Success {
		result.Message = a.appText("query_editor.message.export_sql_file_success", nil)
	}
	return result
}

func normalizeSQLFileExecutionOptions(options sqlFileExecutionOptions) sqlFileExecutionOptions {
	if options.BatchMaxStatements <= 0 {
		options.BatchMaxStatements = sqlFileBatchMaxStatements
	}
	if options.BatchMaxBytes <= 0 {
		options.BatchMaxBytes = sqlFileBatchMaxBytes
	}
	if options.MaxStatementBytes <= 0 {
		options.MaxStatementBytes = DefaultSQLImportMaxStatementBytes
	}
	if options.TransactionMode != sqlFileTransactionModeSingle {
		options.TransactionMode = sqlFileTransactionModeOff
	}
	return options
}

func appendSQLFileBatchStatement(batch []sqlFilePendingStatement, index int, stmt string) []sqlFilePendingStatement {
	return append(batch, sqlFilePendingStatement{
		Index: index,
		SQL:   stmt,
	})
}

func joinSQLFileBatchStatements(batch []sqlFilePendingStatement) string {
	if len(batch) == 0 {
		return ""
	}
	totalLen := 0
	for _, item := range batch {
		totalLen += len(item.SQL) + 2
	}
	var builder strings.Builder
	builder.Grow(totalLen)
	for i, item := range batch {
		if i > 0 {
			builder.WriteString(";\n")
		}
		builder.WriteString(item.SQL)
	}
	return builder.String()
}

func sqlFileStatementSnippet(stmt string, maxLen int) string {
	snippet := strings.TrimSpace(sqlaudit.RedactSQL(stmt))
	if maxLen > 0 && len(snippet) > maxLen {
		return snippet[:maxLen] + "..."
	}
	return snippet
}

func sanitizeSQLFileExecutionError(message string) string {
	return sqlaudit.RedactError(message)
}

func sanitizeSQLFileExecutionErr(err error) string {
	if err == nil {
		return ""
	}
	return sanitizeSQLFileExecutionError(err.Error())
}

func execSQLFileStatement(ctx context.Context, execer sqlFileStatementExecer, stmt string) (int64, error) {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return 0, ctxErr
	}
	if e, ok := execer.(sqlFileContextStatementExecer); ok {
		return e.ExecContext(ctx, stmt)
	}
	return execer.Exec(stmt)
}

func rollbackSQLFileTransaction(execer sqlFileStatementExecer, rollbackSQL string) error {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), sqlFileSessionCleanupTimeout)
	defer cancel()
	if _, err := execSQLFileStatement(cleanupCtx, execer, rollbackSQL); err != nil {
		if discarder, ok := execer.(db.StatementExecerDiscarter); ok {
			if discardErr := discarder.Discard(); discardErr != nil {
				return fmt.Errorf("%w; discard contaminated session: %v", err, discardErr)
			}
		}
		return err
	}
	return nil
}

func isSQLFileBatchableWriteStatement(dbType string, stmt string) bool {
	if isReadOnlySQLQuery(dbType, stmt) {
		return false
	}
	if isPLSQLBlockStatementForDialect(dbType, stmt) {
		return false
	}
	if shouldTryQueryResultFirst(dbType, stmt) {
		return false
	}
	return isBatchableWriteSQLStatement(dbType, stmt)
}

func sqlFileBatchTransactionSQL(dbType string) (beginSQL string, commitSQL string, rollbackSQL string, ok bool) {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "diros", "starrocks", "sphinx", "oceanbase":
		return "START TRANSACTION", "COMMIT", "ROLLBACK", true
	case "sqlserver":
		return "BEGIN TRANSACTION", "COMMIT TRANSACTION", "ROLLBACK TRANSACTION", true
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlite", "duckdb", "iris":
		return "BEGIN", "COMMIT", "ROLLBACK", true
	default:
		return "", "", "", false
	}
}

func updateSQLFileTransactionState(dbType string, inTransaction bool, stmt string) bool {
	depth := 0
	if inTransaction {
		depth = 1
	}
	return updateSQLFileTransactionDepth(dbType, depth, stmt) > 0
}

func updateSQLFileTransactionDepth(dbType string, depth int, stmt string) int {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "begin":
		if sqlBeginStartsTransactionForDialect(dbType, stmt, keywordEnd) {
			if normalizeSQLClassifierDBType(dbType) == "sqlserver" {
				return depth + 1
			}
			return 1
		}
		return depth
	case "start":
		if second, _ := nextSQLKeyword(stmt, keywordEnd); second == "transaction" {
			return 1
		}
		return depth
	case "commit":
		if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
			return 1
		}
		if normalizeSQLClassifierDBType(dbType) == "sqlserver" && depth > 0 {
			return depth - 1
		}
		return 0
	case "rollback":
		if sqlFileRollbackTargetsSavepoint(stmt, keywordEnd) {
			return depth
		}
		if sqlFileSQLServerRollbackHasNamedTarget(dbType, stmt, keywordEnd) {
			if depth > 0 {
				return depth
			}
			// SQL Server uses the same syntax for transaction names and savepoints.
			// A successful named rollback without tracked depth therefore leaves the
			// session state uncertain; keep cleanup active rather than reusing it.
			return 1
		}
		if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
			return 1
		}
		return 0
	case "end":
		if !sqlFileStatementIsTransactionEndAlias(dbType, stmt, keywordEnd) {
			return depth
		}
		if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
			return 1
		}
		return 0
	case "abort":
		switch normalizeSQLClassifierDBType(dbType) {
		case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
			if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
				return 1
			}
			return 0
		default:
			return depth
		}
	default:
		return depth
	}
}

type sqlFileSQLServerTransactionTracker struct {
	depth                int
	outerTransactionName string
	savepointNames       map[string]struct{}
}

func (tracker sqlFileSQLServerTransactionTracker) reset() sqlFileSQLServerTransactionTracker {
	return sqlFileSQLServerTransactionTracker{}
}

func updateSQLFileSQLServerTransactionTracker(tracker sqlFileSQLServerTransactionTracker, stmt string) sqlFileSQLServerTransactionTracker {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "begin":
		if !sqlBeginStartsTransactionForDialect("sqlserver", stmt, keywordEnd) {
			return tracker
		}
		if tracker.depth == 0 {
			tracker.outerTransactionName, _ = sqlFileSQLServerBeginTransactionName(stmt, keywordEnd)
			tracker.savepointNames = nil
		}
		tracker.depth++
		return tracker
	case "save":
		if tracker.depth == 0 {
			return tracker
		}
		if name, ok := sqlFileSQLServerTransactionNameAfterCommand(stmt, keywordEnd); ok {
			if tracker.savepointNames == nil {
				tracker.savepointNames = make(map[string]struct{})
			}
			tracker.savepointNames[name] = struct{}{}
		}
		return tracker
	case "commit":
		if tracker.depth > 0 {
			tracker.depth--
		}
		if tracker.depth == 0 {
			return tracker.reset()
		}
		return tracker
	case "rollback":
		name, named := sqlFileSQLServerTransactionNameAfterCommand(stmt, keywordEnd)
		if !named {
			return tracker.reset()
		}
		if tracker.outerTransactionName != "" && name == tracker.outerTransactionName {
			return tracker.reset()
		}
		if _, isSavepoint := tracker.savepointNames[name]; isSavepoint {
			return tracker
		}
		// SQL Server uses identical syntax for outer transaction names and
		// savepoints. An unrecognised successful target is therefore uncertain;
		// retain the depth so EOF cleanup discards rather than reuses the session.
		if tracker.depth == 0 {
			tracker.depth = 1
		}
		return tracker
	default:
		return tracker
	}
}

func sqlFileSQLServerBeginTransactionName(stmt string, keywordEnd int) (string, bool) {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "distributed" {
		token, tokenEnd = nextSQLKeyword(stmt, tokenEnd)
	}
	if token != "transaction" && token != "tran" {
		return "", false
	}
	name, ok := sqlFileSQLServerIdentifierAt(stmt, tokenEnd)
	if !ok || strings.EqualFold(name, "with") {
		return "", false
	}
	return name, true
}

func sqlFileSQLServerTransactionNameAfterCommand(stmt string, keywordEnd int) (string, bool) {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token != "transaction" && token != "tran" {
		return "", false
	}
	return sqlFileSQLServerIdentifierAt(stmt, tokenEnd)
}

func sqlFileSQLServerIdentifierAt(stmt string, start int) (string, bool) {
	start = skipSQLTrivia(stmt, start)
	if start >= len(stmt) {
		return "", false
	}
	if stmt[start] == '@' {
		end := start + 1
		for end < len(stmt) && isSQLKeywordByte(stmt[end]) {
			end++
		}
		if end == start+1 {
			return "", false
		}
		return stmt[start:end], true
	}
	end, ok := skipSQLIdentifierToken(stmt, start, "sqlserver")
	if !ok {
		return "", false
	}
	name := strings.TrimSpace(stmt[start:end])
	if len(name) >= 2 {
		switch {
		case name[0] == '[' && name[len(name)-1] == ']':
			name = strings.ReplaceAll(name[1:len(name)-1], "]]", "]")
		case (name[0] == '"' && name[len(name)-1] == '"') || (name[0] == '`' && name[len(name)-1] == '`'):
			quote := string(name[0])
			name = strings.ReplaceAll(name[1:len(name)-1], quote+quote, quote)
		}
	}
	if name == "" {
		return "", false
	}
	// SQL Server transaction and savepoint names are case-sensitive even on
	// case-insensitive servers, so preserve their spelling for matching.
	return name, true
}

func isSQLFileMySQLCompatibleDialect(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		return true
	default:
		return false
	}
}

func sqlFileMySQLAutocommitAssignment(dbType string, stmt string) (disabled bool, known bool, assigned bool) {
	if !isSQLFileMySQLCompatibleDialect(dbType) {
		return false, false, false
	}
	start := skipSQLTrivia(stmt, 0)
	if start >= len(stmt) {
		return false, false, false
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, start)
	if keyword != "set" {
		return false, false, false
	}
	matches := sqlFileMySQLAutocommitAssignmentPattern.FindAllStringSubmatch(stmt[keywordEnd:], -1)
	if len(matches) == 0 || len(matches[len(matches)-1]) != 2 {
		return false, false, false
	}
	switch strings.ToLower(strings.TrimSpace(matches[len(matches)-1][1])) {
	case "0", "off", "false":
		return true, true, true
	case "1", "on", "true":
		return false, true, true
	default:
		return false, false, true
	}
}

func sqlFileMySQLImplicitCommitBeforeStatement(dbType string, stmt string) bool {
	if !isSQLFileMySQLCompatibleDialect(dbType) {
		return false
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "create", "drop":
		return !sqlFileMySQLTemporaryTableDDL(stmt, keywordEnd)
	case "alter", "analyze", "cache", "check", "flush", "grant", "install", "optimize", "rename", "repair", "revoke", "truncate", "uninstall":
		return true
	case "reset":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second != "persist"
	case "set":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "password"
	case "begin":
		return sqlBeginStartsTransactionForDialect(dbType, stmt, keywordEnd)
	case "start":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "transaction" || second == "replica" || second == "slave"
	case "stop":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "replica" || second == "slave"
	case "lock":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "tables"
	default:
		return false
	}
}

func sqlFileMySQLTableLockCommand(dbType string, stmt string) (locks bool, unlocks bool) {
	if !isSQLFileMySQLCompatibleDialect(dbType) {
		return false, false
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	second, _ := nextSQLKeyword(stmt, keywordEnd)
	if second != "tables" {
		return false, false
	}
	return keyword == "lock", keyword == "unlock"
}

func sqlFileMySQLTemporaryTableDDL(stmt string, keywordEnd int) bool {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "or" {
		if next, nextEnd := nextSQLKeyword(stmt, tokenEnd); next == "replace" {
			token, _ = nextSQLKeyword(stmt, nextEnd)
		}
	}
	return token == "temporary"
}

func sqlFileTransactionCommandUsesChain(stmt string, keywordEnd int) bool {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "work" || token == "transaction" {
		token, tokenEnd = nextSQLKeyword(stmt, tokenEnd)
	}
	if token != "and" {
		return false
	}
	token, tokenEnd = nextSQLKeyword(stmt, tokenEnd)
	if token == "no" {
		return false
	}
	return token == "chain"
}

func sqlFileRollbackTargetsSavepoint(stmt string, keywordEnd int) bool {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "work" || token == "transaction" {
		token, _ = nextSQLKeyword(stmt, tokenEnd)
	}
	return token == "to"
}

func sqlFileSQLServerRollbackHasNamedTarget(dbType string, stmt string, keywordEnd int) bool {
	if normalizeSQLClassifierDBType(dbType) != "sqlserver" {
		return false
	}
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token != "transaction" && token != "tran" {
		return false
	}
	return skipSQLTrivia(stmt, tokenEnd) < len(stmt)
}

func sqlFileStatementIsTransactionEndAlias(dbType string, stmt string, keywordEnd int) bool {
	next, _ := nextSQLKeyword(stmt, keywordEnd)
	switch normalizeSQLClassifierDBType(dbType) {
	case "sqlite":
		return next == "" || next == "transaction"
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return next == "" || next == "work" || next == "transaction" || next == "and"
	default:
		return false
	}
}

func sqlFileStatementFinishesTransaction(stmt string) bool {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "commit":
		return true
	case "rollback":
		return !sqlFileRollbackTargetsSavepoint(stmt, keywordEnd)
	default:
		return false
	}
}

func executeSQLFileBatch(ctx context.Context, execer sqlFileStatementExecer, batcher sqlFileBatchStatementExecer, dbType string, batchSQL string, useTransaction bool, text fileBackendTextFunc) (bool, error) {
	canFallback, _, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, dbType, batchSQL, useTransaction, text)
	return canFallback, err
}

func executeSQLFileBatchWithOutcome(ctx context.Context, execer sqlFileStatementExecer, batcher sqlFileBatchStatementExecer, dbType string, batchSQL string, useTransaction bool, text fileBackendTextFunc) (canFallback bool, outcomeUnknown bool, err error) {
	if !useTransaction {
		_, err = batcher.ExecBatchContext(ctx, batchSQL)
		return false, db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err), err
	}

	beginSQL, commitSQL, rollbackSQL, ok := sqlFileBatchTransactionSQL(dbType)
	if !ok {
		_, err = batcher.ExecBatchContext(ctx, batchSQL)
		return false, db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err), err
	}

	if _, err := execSQLFileStatement(ctx, execer, beginSQL); err != nil {
		unknown := db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
		if rollbackErr := rollbackSQLFileTransaction(execer, rollbackSQL); rollbackErr != nil {
			return false, true, errors.New(fileBackendText(text, "file.backend.error.sql_file_batch_rollback_failed", map[string]any{
				"detail":         sanitizeSQLFileExecutionErr(err),
				"rollbackDetail": sanitizeSQLFileExecutionErr(rollbackErr),
			}))
		}
		return false, unknown, err
	}
	if _, err := batcher.ExecBatchContext(ctx, batchSQL); err != nil {
		unknown := db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
		if rollbackErr := rollbackSQLFileTransaction(execer, rollbackSQL); rollbackErr != nil {
			return false, true, errors.New(fileBackendText(text, "file.backend.error.sql_file_batch_rollback_failed", map[string]any{
				"detail":         sanitizeSQLFileExecutionErr(err),
				"rollbackDetail": sanitizeSQLFileExecutionErr(rollbackErr),
			}))
		}
		// MySQL-family tables can use non-transactional engines. A successful
		// ROLLBACK therefore cannot prove that a partially executed batch left no
		// writes behind. Stop and surface the uncertainty instead of inviting a
		// blind replay.
		if unknown {
			return false, true, err
		}
		return true, isSQLFileMySQLCompatibleDialect(dbType), err
	}
	if _, err := execSQLFileStatement(ctx, execer, commitSQL); err != nil {
		if rollbackErr := rollbackSQLFileTransaction(execer, rollbackSQL); rollbackErr != nil {
			return false, true, errors.New(fileBackendText(text, "file.backend.error.sql_file_batch_rollback_failed", map[string]any{
				"detail":         sanitizeSQLFileExecutionErr(err),
				"rollbackDetail": sanitizeSQLFileExecutionErr(rollbackErr),
			}))
		}
		// Once COMMIT has been dispatched, an error does not prove whether the
		// server committed before the connection/context failure was observed.
		return false, true, err
	}
	return false, false, nil
}

func isSQLFileSingleTransactionDialectSupported(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlite", "duckdb", "iris", "sqlserver", "oracle", "dameng":
		return true
	default:
		return false
	}
}

func sqlFileSingleTransactionRequiresDriverExecer(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "oracle", "dameng":
		return true
	default:
		return false
	}
}

func sqlFileSingleTransactionSQL(dbType string) (beginSQL string, commitSQL string, rollbackSQL string, ok bool) {
	switch normalizeSQLClassifierDBType(dbType) {
	case "sqlserver":
		return "BEGIN TRANSACTION", "COMMIT TRANSACTION", "ROLLBACK TRANSACTION", true
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlite", "duckdb", "iris":
		return "BEGIN", "COMMIT", "ROLLBACK", true
	default:
		return "", "", "", false
	}
}

func isSQLFileSingleTransactionControlStatement(dbType, stmt string) bool {
	if isSQLTransactionControlStatement(stmt) {
		return true
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "end":
		return sqlFileStatementIsTransactionEndAlias(dbType, stmt, keywordEnd)
	case "abort":
		switch normalizeSQLClassifierDBType(dbType) {
		case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
			return true
		}
	case "set":
		// Session and transaction settings can alter the outer transaction's
		// semantics. Other SET statements are rejected below as unknown too.
		return sqlContainsKeyword(stmt, "autocommit", dbType) || sqlContainsKeyword(stmt, "transaction", dbType) || sqlContainsKeyword(stmt, "isolation", dbType)
	}
	return false
}

func validateSQLFileSingleTransactionStatement(dbType, stmt string) error {
	dbType = normalizeSQLClassifierDBType(dbType)
	if !isSQLFileSingleTransactionDialectSupported(dbType) {
		return fmt.Errorf("single-transaction SQL-file execution cannot prove atomicity for database type %q", dbType)
	}
	if isSQLFileMySQLCompatibleDialect(dbType) || sqlFileMySQLImplicitCommitBeforeStatement(dbType, stmt) {
		return errors.New("single-transaction SQL-file execution rejects MySQL-family implicit commits")
	}
	if isSQLFileSingleTransactionControlStatement(dbType, stmt) {
		return errors.New("single-transaction SQL-file execution rejects explicit transaction control or transaction settings")
	}
	if isReadOnlySQLQuery(dbType, stmt) || isBatchableWriteSQLStatement(dbType, stmt) {
		return nil
	}
	return errors.New("single-transaction SQL-file execution rejects statements whose atomicity cannot be proven")
}

func executeSQLFileSingleTransactionStream(ctx context.Context, dbInst db.Database, reader io.Reader, options sqlFileExecutionOptions, bytesRead func() int64) (result sqlFileExecutionResult, runErr error) {
	if options.ContinueOnError {
		return result, errors.New("single-transaction SQL-file execution does not support continue-on-error")
	}
	if !isSQLFileSingleTransactionDialectSupported(options.DBType) {
		return result, fmt.Errorf("single-transaction SQL-file execution cannot prove atomicity for database type %q", normalizeSQLClassifierDBType(options.DBType))
	}

	var execer sqlFileStatementExecer
	var closeHandle func() error
	var discardHandle func() error
	var rollbackTransaction func() error
	var commitTransaction func() error
	transactionActive := false
	discardOnCleanup := false

	if provider, ok := dbInst.(db.TransactionExecerProvider); ok {
		transaction, err := provider.OpenTransactionExecer(ctx)
		if err != nil {
			return result, err
		}
		execer = transaction
		transactionActive = true
		closeHandle = transaction.Close
		if discarder, ok := transaction.(db.StatementExecerDiscarter); ok {
			discardHandle = discarder.Discard
		}
		rollbackTransaction = func() error {
			transactionActive = false
			return transaction.Rollback()
		}
		commitTransaction = func() error {
			err := transaction.Commit()
			if err == nil {
				transactionActive = false
			}
			return err
		}
	} else {
		if sqlFileSingleTransactionRequiresDriverExecer(options.DBType) {
			return result, errors.New("single-transaction SQL-file execution requires a driver-backed transaction handle for this database type")
		}
		provider, ok := dbInst.(db.SessionExecerProvider)
		if !ok {
			return result, errors.New("single-transaction SQL-file execution requires a pinned database session")
		}
		session, err := provider.OpenSessionExecer(ctx)
		if err != nil {
			return result, err
		}
		execer = session
		closeHandle = session.Close
		if discarder, ok := session.(db.StatementExecerDiscarter); ok {
			discardHandle = discarder.Discard
		}
		beginSQL, commitSQL, rollbackSQL, ok := sqlFileSingleTransactionSQL(options.DBType)
		if !ok {
			_ = session.Close()
			return result, errors.New("single-transaction SQL-file execution cannot open a dialect transaction")
		}
		if _, err := execSQLFileStatement(ctx, execer, beginSQL); err != nil {
			discardOnCleanup = true
			if discardHandle != nil {
				_ = discardHandle()
			}
			_ = session.Close()
			return result, err
		}
		transactionActive = true
		rollbackTransaction = func() error {
			transactionActive = false
			return rollbackSQLFileTransaction(execer, rollbackSQL)
		}
		commitTransaction = func() error {
			_, err := execSQLFileStatement(ctx, execer, commitSQL)
			if err == nil {
				transactionActive = false
			}
			return err
		}
	}

	defer func() {
		if transactionActive && rollbackTransaction != nil {
			if err := rollbackTransaction(); err != nil {
				result.OutcomeUnknown = true
				discardOnCleanup = true
				logger.Warnf("ExecuteSQLFile single transaction rollback failed: type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
		if discardOnCleanup && discardHandle != nil {
			if err := discardHandle(); err != nil {
				logger.Warnf("ExecuteSQLFile single transaction discard failed: type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
		if closeHandle != nil {
			if err := closeHandle(); err != nil {
				if discardHandle != nil {
					_ = discardHandle()
				}
				logger.Warnf("ExecuteSQLFile single transaction session close failed: type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
	}()

	readBytes := func() int64 {
		if bytesRead == nil {
			return 0
		}
		return bytesRead()
	}
	var lastProgressAt time.Time
	emitProgress := func(currentSQL string) {
		if options.OnProgress == nil {
			return
		}
		total := result.Executed + result.Failed
		options.OnProgress(sqlFileExecutionProgress{
			Status:     "running",
			Executed:   result.Executed,
			Failed:     result.Failed,
			Total:      total,
			BytesRead:  readBytes(),
			CurrentSQL: currentSQL,
		})
		lastProgressAt = time.Now()
	}
	shouldEmitProgress := func() bool {
		total := result.Executed + result.Failed
		if total <= 10 || total%sqlFileProgressStatementInterval == 0 {
			return true
		}
		return !lastProgressAt.IsZero() && time.Since(lastProgressAt) >= sqlFileProgressTimeInterval
	}
	recordError := func(index int, stmt string, err error) string {
		result.Failed++
		detail := fileBackendText(options.Text, "file.backend.message.statement_failed", map[string]any{
			"index":  index + 1,
			"detail": sanitizeSQLFileExecutionError(err.Error()),
			"sql":    sqlFileStatementSnippet(stmt, 200),
		})
		if len(result.Errors) < sqlFileMaxErrorDetails {
			result.Errors = append(result.Errors, detail)
		}
		logger.Warnf("ExecuteSQLFile %s", detail)
		return detail
	}

	_, streamErr := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            options.DBType,
		MaxStatementBytes: options.MaxStatementBytes,
	}, func(index int, stmt string) error {
		if err := ctx.Err(); err != nil {
			return errSQLFileCancelled
		}
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			return nil
		}
		if options.PreflightEachStatement {
			preflightResult := PreflightSQLStatement(stmt, options.DBType, index)
			if !preflightResult.Safe && preflightResult.Reason != nil {
				return &sqlFilePreflightRejectedError{reason: *preflightResult.Reason}
			}
		}
		if options.StatementGuard != nil {
			if err := options.StatementGuard(index, stmt); err != nil {
				return err
			}
		}
		if options.SkipStatement != nil && options.SkipStatement(index, stmt) {
			return nil
		}
		if err := validateSQLFileSingleTransactionStatement(options.DBType, stmt); err != nil {
			return err
		}

		if _, err := execSQLFileStatement(ctx, execer, stmt); err != nil {
			if db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err) {
				// A driver can lose the response after dispatch without the
				// context being cancelled. Do not flatten that into an ordinary
				// statement failure: the transaction's server-side state is not
				// knowable from the client.
				result.OutcomeUnknown = true
			}
			if ctx.Err() != nil {
				// The driver may have sent the statement before cancellation was
				// observed, so a later rollback result cannot prove the outcome.
				result.OutcomeUnknown = true
				return errSQLFileCancelled
			}
			detail := recordError(index, stmt, err)
			if shouldEmitProgress() {
				emitProgress(sqlFileStatementSnippet(stmt, 100))
			}
			return &sqlFileStoppedOnError{detail: detail}
		}
		result.Executed++
		if shouldEmitProgress() {
			emitProgress(sqlFileStatementSnippet(stmt, 100))
		}
		return nil
	})
	if streamErr != nil {
		return result, streamErr
	}
	if err := ctx.Err(); err != nil {
		return result, errSQLFileCancelled
	}
	if err := commitTransaction(); err != nil {
		// A commit response can be lost after the server has committed. Retain
		// the ambiguity even when a best-effort rollback succeeds during cleanup.
		result.OutcomeUnknown = true
		discardOnCleanup = true
		return result, fmt.Errorf("single-transaction SQL-file commit failed: %w", err)
	}
	return result, nil
}

func executeSQLFileStream(ctx context.Context, dbInst db.Database, reader io.Reader, options sqlFileExecutionOptions, bytesRead func() int64) (sqlFileExecutionResult, error) {
	options = normalizeSQLFileExecutionOptions(options)
	if options.TransactionMode == sqlFileTransactionModeSingle {
		return executeSQLFileSingleTransactionStream(ctx, dbInst, reader, options, bytesRead)
	}
	var result sqlFileExecutionResult
	var batch []sqlFilePendingStatement
	var batchBytes int
	var lastProgressAt time.Time
	var userTransactionDepth int
	var sqlServerTransaction sqlFileSQLServerTransactionTracker
	var mysqlAutocommitDisabled bool
	var mysqlAutocommitTransactionActive bool
	var mysqlAutocommitStateUnknown bool
	var mysqlTablesLocked bool
	var useTransactionalBatch bool
	safeSequentialContinue := options.ContinueOnError && isSQLFileMySQLCompatibleDialect(options.DBType)
	var hasPinnedSession bool
	execer := sqlFileStatementExecer(dbInst)
	batcher, supportsBatch := dbInst.(sqlFileBatchStatementExecer)
	if capability, ok := dbInst.(db.BatchWriteCapability); ok && !capability.SupportsBatchWrites() {
		supportsBatch = false
		batcher = nil
	}
	if provider, ok := dbInst.(db.SessionExecerProvider); ok {
		sessionExecer, err := provider.OpenSessionExecer(ctx)
		if err != nil {
			return result, err
		}
		defer sessionExecer.Close()
		hasPinnedSession = true
		execer = sessionExecer
		if supportsBatch {
			var ok bool
			batcher, ok = sessionExecer.(sqlFileBatchStatementExecer)
			supportsBatch = ok
		}
		useTransactionalBatch = supportsBatch
	}
	defer func() {
		if userTransactionDepth > 0 || mysqlAutocommitTransactionActive {
			_, _, rollbackSQL, ok := sqlFileBatchTransactionSQL(options.DBType)
			if !ok {
				rollbackSQL = "ROLLBACK"
			}
			if err := rollbackSQLFileTransaction(execer, rollbackSQL); err != nil {
				logger.Warnf("ExecuteSQLFile 未结束事务清理失败，连接已尝试淘汰：type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
		if hasPinnedSession {
			if discarder, ok := execer.(db.StatementExecerDiscarter); ok {
				if err := discarder.Discard(); err != nil {
					logger.Warnf("ExecuteSQLFile 淘汰专用会话失败：type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
				}
			}
		}
	}()

	readBytes := func() int64 {
		if bytesRead == nil {
			return 0
		}
		return bytesRead()
	}

	emitProgress := func(currentSQL string) {
		if options.OnProgress == nil {
			return
		}
		total := result.Executed + result.Failed
		options.OnProgress(sqlFileExecutionProgress{
			Status:     "running",
			Executed:   result.Executed,
			Failed:     result.Failed,
			Total:      total,
			BytesRead:  readBytes(),
			CurrentSQL: currentSQL,
		})
		lastProgressAt = time.Now()
	}

	shouldEmitProgress := func() bool {
		total := result.Executed + result.Failed
		if total <= 10 {
			return true
		}
		if total%sqlFileProgressStatementInterval == 0 {
			return true
		}
		return !lastProgressAt.IsZero() && time.Since(lastProgressAt) >= sqlFileProgressTimeInterval
	}
	appendErrorDetail := func(detail string) {
		if len(result.Errors) < sqlFileMaxErrorDetails {
			result.Errors = append(result.Errors, detail)
		}
	}

	recordError := func(index int, stmt string, err error) string {
		result.Failed++
		errLog := fileBackendText(options.Text, "file.backend.message.statement_failed", map[string]any{
			"index":  index + 1,
			"detail": sanitizeSQLFileExecutionError(err.Error()),
			"sql":    sqlFileStatementSnippet(stmt, 200),
		})
		appendErrorDetail(errLog)
		if result.Failed <= sqlFileMaxErrorDetails || result.Failed%1000 == 0 {
			logger.Warnf("ExecuteSQLFile %s", errLog)
		}
		return errLog
	}

	executeSingle := func(item sqlFilePendingStatement) (bool, error) {
		if sqlFileMySQLImplicitCommitBeforeStatement(options.DBType, item.SQL) {
			// MySQL-family engines commit the current transaction before attempting
			// these statements. This state transition happens even when the DDL or
			// administrative statement itself subsequently fails.
			userTransactionDepth = 0
			mysqlAutocommitTransactionActive = false
		}
		if ctx.Err() != nil {
			return false, errSQLFileCancelled
		}
		if _, err := execSQLFileStatement(ctx, execer, item.SQL); err != nil {
			unknown := db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
			if unknown {
				// A lost response must stop the file even in transaction=off
				// continue mode; replaying the statement could duplicate a write.
				result.OutcomeUnknown = true
			}
			if sqlFileStatementFinishesTransaction(item.SQL) {
				// A user-authored COMMIT/ROLLBACK may have reached the server even
				// when its result (including cancellation) was not observed.
				result.OutcomeUnknown = true
			}
			if ctx.Err() != nil {
				result.OutcomeUnknown = true
				return false, errSQLFileCancelled
			}
			errLog := recordError(item.Index, item.SQL, err)
			if unknown {
				if shouldEmitProgress() {
					emitProgress(sqlFileStatementSnippet(item.SQL, 100))
				}
				return false, &sqlFileStoppedOnError{detail: errLog}
			}
			if !options.ContinueOnError {
				if shouldEmitProgress() {
					emitProgress(sqlFileStatementSnippet(item.SQL, 100))
				}
				return false, &sqlFileStoppedOnError{detail: errLog}
			}
			if shouldEmitProgress() {
				emitProgress(sqlFileStatementSnippet(item.SQL, 100))
			}
			return false, nil
		}
		result.Executed++
		if shouldEmitProgress() {
			emitProgress(sqlFileStatementSnippet(item.SQL, 100))
		}
		return true, nil
	}

	executeBatchSequentially := func(items []sqlFilePendingStatement) error {
		for _, item := range items {
			if _, err := executeSingle(item); err != nil {
				return err
			}
		}
		return nil
	}

	var executeIsolationBatch func([]sqlFilePendingStatement) error
	var isolateFailedBatch func([]sqlFilePendingStatement, error) error
	isolateFailedBatch = func(items []sqlFilePendingStatement, observedErr error) error {
		if len(items) == 0 {
			return nil
		}
		if ctx.Err() != nil {
			return errSQLFileCancelled
		}
		if len(items) == 1 {
			recordError(items[0].Index, items[0].SQL, observedErr)
			emitProgress(sqlFileStatementSnippet(items[0].SQL, 100))
			logger.Warnf("ExecuteSQLFile 已定位失败语句，未重复执行：第 %d 条: %s", items[0].Index+1, sanitizeSQLFileExecutionErr(observedErr))
			return nil
		}
		if len(items) <= sqlFileBatchIsolationSequentialThreshold {
			logger.Warnf("ExecuteSQLFile 失败子批已缩小到 %d 条，将逐条定位：第 %d 条起", len(items), items[0].Index+1)
			return executeBatchSequentially(items)
		}

		middle := len(items) / 2
		if err := executeIsolationBatch(items[:middle]); err != nil {
			return err
		}
		return executeIsolationBatch(items[middle:])
	}
	executeIsolationBatch = func(items []sqlFilePendingStatement) error {
		if ctx.Err() != nil {
			return errSQLFileCancelled
		}
		batchSQL := joinSQLFileBatchStatements(items)
		canFallback, outcomeUnknown, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, options.DBType, batchSQL, useTransactionalBatch, options.Text)
		if outcomeUnknown {
			result.OutcomeUnknown = true
			// Never bisect or replay a batch after a response whose server-side
			// outcome cannot be established.
			if err != nil {
				return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
					"index":  items[0].Index + 1,
					"detail": sanitizeSQLFileExecutionErr(err),
				}))
			}
		}
		if err == nil {
			result.Executed += len(items)
			if shouldEmitProgress() {
				emitProgress(sqlFileStatementSnippet(items[len(items)-1].SQL, 100))
			}
			return nil
		}
		if ctx.Err() != nil {
			if !useTransactionalBatch || !canFallback {
				result.OutcomeUnknown = true
			}
			return errSQLFileCancelled
		}
		if !canFallback {
			return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
				"index":  items[0].Index + 1,
				"detail": sanitizeSQLFileExecutionErr(err),
			}))
		}
		return isolateFailedBatch(items, err)
	}

	flushBatch := func() error {
		if len(batch) == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return errSQLFileCancelled
		default:
		}

		startIndex := batch[0].Index
		batchSQL := joinSQLFileBatchStatements(batch)
		canFallback, outcomeUnknown, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, options.DBType, batchSQL, useTransactionalBatch, options.Text)
		if outcomeUnknown {
			result.OutcomeUnknown = true
		}
		if err != nil {
			if ctx.Err() != nil {
				if !useTransactionalBatch || !canFallback {
					result.OutcomeUnknown = true
				}
				return errSQLFileCancelled
			}
			pending := append([]sqlFilePendingStatement(nil), batch...)
			batch = batch[:0]
			batchBytes = 0
			if !canFallback {
				return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
					"index":  startIndex + 1,
					"detail": sanitizeSQLFileExecutionErr(err),
				}))
			}
			if !options.ContinueOnError {
				errLog := fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
					"index":  startIndex + 1,
					"detail": sanitizeSQLFileExecutionErr(err),
				})
				result.Failed++
				appendErrorDetail(errLog)
				logger.Warnf("ExecuteSQLFile 批量执行失败并已停止，未逐条重放：第 %d 条起，共 %d 条: %s", startIndex+1, len(pending), sanitizeSQLFileExecutionErr(err))
				emitProgress(sqlFileStatementSnippet(pending[0].SQL, 100))
				return &sqlFileStoppedOnError{detail: errLog}
			}
			logger.Warnf("ExecuteSQLFile 批量执行 %d 条语句失败，将自适应拆分定位错误：第 %d 条起: %s", len(pending), startIndex+1, sanitizeSQLFileExecutionErr(err))
			return isolateFailedBatch(pending, err)
		}
		result.Executed += len(batch)
		if shouldEmitProgress() {
			emitProgress(sqlFileStatementSnippet(batch[len(batch)-1].SQL, 100))
		}
		batch = batch[:0]
		batchBytes = 0
		return nil
	}

	_, streamErr := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            options.DBType,
		MaxStatementBytes: options.MaxStatementBytes,
	}, func(index int, stmt string) error {
		select {
		case <-ctx.Done():
			return errSQLFileCancelled
		default:
		}

		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			return nil
		}
		if options.PreflightEachStatement {
			preflightResult := PreflightSQLStatement(stmt, options.DBType, index)
			if !preflightResult.Safe && preflightResult.Reason != nil {
				return &sqlFilePreflightRejectedError{
					reason:              *preflightResult.Reason,
					executed:            result.Executed,
					failed:              result.Failed,
					possibleSideEffects: result.Executed > 0 || result.Failed > 0,
					outcomeUnknown:      result.Failed > 0,
				}
			}
		}
		if options.StatementGuard != nil {
			if err := options.StatementGuard(index, stmt); err != nil {
				return err
			}
		}
		if options.SkipStatement != nil && options.SkipStatement(index, stmt) {
			return nil
		}

		if supportsBatch && !safeSequentialContinue && userTransactionDepth == 0 && !mysqlAutocommitDisabled && !mysqlTablesLocked && isSQLFileBatchableWriteStatement(options.DBType, stmt) {
			stmtBytes := len(stmt)
			if len(batch) > 0 && (len(batch) >= options.BatchMaxStatements || batchBytes+2+stmtBytes > options.BatchMaxBytes) {
				if err := flushBatch(); err != nil {
					return err
				}
			}
			if stmtBytes > options.BatchMaxBytes {
				if err := flushBatch(); err != nil {
					return err
				}
				canFallback, outcomeUnknown, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, options.DBType, stmt, useTransactionalBatch, options.Text)
				if outcomeUnknown {
					result.OutcomeUnknown = true
				}
				if err != nil {
					if ctx.Err() != nil {
						return errSQLFileCancelled
					}
					if !canFallback {
						return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_statement_execution_failed", map[string]any{
							"index":  index + 1,
							"detail": sanitizeSQLFileExecutionErr(err),
						}))
					}
					// This batch contains exactly one oversized statement. The failed
					// transactional attempt already executed that statement and rolled it
					// back, so calling executeSingle here would repeat the same SQL for no
					// diagnostic value and may duplicate writes on non-transactional tables.
					errLog := recordError(index, stmt, err)
					emitProgress(sqlFileStatementSnippet(stmt, 100))
					if !options.ContinueOnError {
						return &sqlFileStoppedOnError{detail: errLog}
					}
					logger.Warnf("ExecuteSQLFile 超大语句执行失败，已记录并继续，未重复执行：第 %d 条: %s", index+1, sanitizeSQLFileExecutionErr(err))
					return nil
				}
				result.Executed++
				if shouldEmitProgress() {
					emitProgress(sqlFileStatementSnippet(stmt, 100))
				}
				return nil
			}
			batch = appendSQLFileBatchStatement(batch, index, stmt)
			if batchBytes == 0 {
				batchBytes = stmtBytes
			} else {
				batchBytes += 2 + stmtBytes
			}
			return nil
		}

		if err := flushBatch(); err != nil {
			return err
		}
		succeeded, err := executeSingle(sqlFilePendingStatement{Index: index, SQL: stmt})
		if err != nil {
			return err
		}
		if succeeded {
			if normalizeSQLClassifierDBType(options.DBType) == "sqlserver" {
				sqlServerTransaction = updateSQLFileSQLServerTransactionTracker(sqlServerTransaction, stmt)
				userTransactionDepth = sqlServerTransaction.depth
			} else {
				userTransactionDepth = updateSQLFileTransactionDepth(options.DBType, userTransactionDepth, stmt)
			}
			if disabled, known, assigned := sqlFileMySQLAutocommitAssignment(options.DBType, stmt); assigned {
				wasKnownDisabled := mysqlAutocommitDisabled && !mysqlAutocommitStateUnknown
				mysqlAutocommitStateUnknown = !known
				if known {
					mysqlAutocommitDisabled = disabled
				} else {
					// A server-side variable can restore autocommit to either value.
					// Disable batching conservatively and discard this session at EOF.
					mysqlAutocommitDisabled = true
				}
				if known && !disabled {
					mysqlAutocommitTransactionActive = false
					if wasKnownDisabled {
						// In the MySQL family, changing autocommit from 0 to 1
						// commits an active explicit transaction as well.
						userTransactionDepth = 0
					}
				}
			} else if mysqlAutocommitDisabled {
				if mysqlAutocommitTransactionActive {
					mysqlAutocommitTransactionActive = updateSQLFileTransactionState(options.DBType, true, stmt)
				}
				if isBatchableWriteSQLStatement(options.DBType, stmt) {
					mysqlAutocommitTransactionActive = true
				}
			}
			if locksTables, unlocksTables := sqlFileMySQLTableLockCommand(options.DBType, stmt); locksTables {
				mysqlTablesLocked = true
			} else if unlocksTables && mysqlTablesLocked {
				// UNLOCK TABLES commits only when this session actually acquired
				// table locks. The tracked LOCK makes that conditional transition known.
				userTransactionDepth = 0
				mysqlAutocommitTransactionActive = false
				mysqlTablesLocked = false
			}
		}
		return nil
	})
	if streamErr != nil {
		return result, streamErr
	}
	if err := flushBatch(); err != nil {
		return result, err
	}
	if userTransactionDepth > 0 || mysqlAutocommitTransactionActive {
		detail := fileBackendText(options.Text, "file.backend.error.sql_file_unclosed_transaction", nil)
		result.Failed++
		appendErrorDetail(detail)
		return result, &sqlFileStoppedOnError{detail: detail}
	}
	return result, nil
}

// ExecuteSQLFile 在后端流式读取并执行大 SQL 文件，通过事件推送进度。
// 前端通过 EventsOn("sqlfile:progress", ...) 监听进度。
const sqlFileExecutionPreambleBytes = 64 * 1024
const sqlFileFullPreflightMaxRawBytes int64 = 64 << 20

type preparedSQLFileExecutionSource struct {
	source   *SQLImportSource
	reader   io.Reader
	preamble []byte
	rawSize  int64
}

type sqlImportContextReader struct {
	ctx        context.Context
	reader     io.Reader
	beforeRead func(context.Context)
}

type sqlFileRawProgressObserver struct {
	bytesRead    int64
	lastReported int64
	lastReportAt time.Time
	report       func(int64) error
}

func (observer *sqlFileRawProgressObserver) Write(buffer []byte) (int, error) {
	observer.bytesRead += int64(len(buffer))
	shouldReport := observer.lastReportAt.IsZero() ||
		observer.bytesRead-observer.lastReported >= 1<<20 ||
		time.Since(observer.lastReportAt) >= 250*time.Millisecond
	if shouldReport && observer.report != nil {
		observer.lastReported = observer.bytesRead
		observer.lastReportAt = time.Now()
		if err := observer.report(observer.bytesRead); err != nil {
			return len(buffer), err
		}
	}
	return len(buffer), nil
}

func (reader *sqlImportContextReader) Read(buffer []byte) (int, error) {
	if reader == nil || reader.reader == nil {
		return 0, io.EOF
	}
	if reader.ctx != nil {
		if err := reader.ctx.Err(); err != nil {
			return 0, err
		}
	}
	if reader.beforeRead != nil {
		reader.beforeRead(reader.ctx)
		if reader.ctx != nil {
			if err := reader.ctx.Err(); err != nil {
				return 0, err
			}
		}
	}
	read, err := reader.reader.Read(buffer)
	if reader.ctx != nil {
		if contextErr := reader.ctx.Err(); contextErr != nil {
			return read, contextErr
		}
	}
	return read, err
}

var sqlFilePreflightReadHook func(context.Context)

func (prepared *preparedSQLFileExecutionSource) Close() error {
	if prepared == nil || prepared.source == nil {
		return nil
	}
	return prepared.source.Close()
}

func readSQLFileExecutionPreambleStream(reader io.Reader) ([]byte, io.Reader, error) {
	buffer := make([]byte, sqlFileExecutionPreambleBytes)
	read, err := io.ReadFull(reader, buffer)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, nil, err
	}
	preamble := buffer[:read]
	return preamble, io.MultiReader(bytes.NewReader(preamble), reader), nil
}

func shouldFullyPreflightSQLFile(rawSize int64) bool {
	return rawSize >= 0 && rawSize <= sqlFileFullPreflightMaxRawBytes
}

func prepareSQLFileExecutionSource(filePath, dbType string, maxStatementBytes int64, rawObserver io.Writer) (*preparedSQLFileExecutionSource, error) {
	return prepareSQLFileExecutionSourceWithContext(context.Background(), filePath, dbType, maxStatementBytes, rawObserver, nil)
}

func prepareSQLFileExecutionSourceWithContext(ctx context.Context, filePath, dbType string, maxStatementBytes int64, rawObserver io.Writer, preflightRawObserver io.Writer) (*preparedSQLFileExecutionSource, error) {
	return prepareSQLFileExecutionSourceWithPolicyContext(ctx, filePath, dbType, maxStatementBytes, rawObserver, preflightRawObserver, sqlFileExecutionPolicy{})
}

func preflightSQLFileExecutionSourceWithPolicy(reader io.Reader, dbType string, maxStatementBytes int64, statementGuard func(index int, stmt string) error) (SQLImportPreflightResult, error) {
	if statementGuard == nil {
		return PreflightSQLImportWithOptions(reader, SQLStreamOptions{
			DBType:            dbType,
			MaxStatementBytes: maxStatementBytes,
		})
	}

	result := SQLImportPreflightResult{Safe: true}
	normalizedType := normalizeExplainLexicalDBType(dbType)
	_, err := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            normalizedType,
		MaxStatementBytes: maxStatementBytes,
	}, func(index int, stmt string) error {
		statementResult := PreflightSQLStatement(stmt, normalizedType, index)
		if !statementResult.Safe {
			result = statementResult
			return errSQLImportPreflightRejected
		}
		if err := statementGuard(index, strings.TrimSpace(stmt)); err != nil {
			return &sqlFilePolicyRejectedError{err: err}
		}
		return nil
	})
	if errors.Is(err, errSQLImportPreflightRejected) {
		return result, nil
	}
	if err != nil {
		return SQLImportPreflightResult{}, err
	}
	return result, nil
}

func prepareSQLFileExecutionSourceWithPolicyContext(ctx context.Context, filePath, dbType string, maxStatementBytes int64, rawObserver io.Writer, preflightRawObserver io.Writer, policy sqlFileExecutionPolicy) (*preparedSQLFileExecutionSource, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("SQL import source is a directory")
	}
	fullPreflight := policy.ForceFullPreflight || shouldFullyPreflightSQLFile(info.Size())
	var preamble []byte
	if fullPreflight {
		preflightSource, err := OpenSQLImportSource(filePath, SQLImportSourceOptions{RawObserver: preflightRawObserver})
		if err != nil {
			return nil, err
		}
		preflightPreamble, preflightReader, readErr := readSQLFileExecutionPreambleStream(&sqlImportContextReader{
			ctx:        ctx,
			reader:     preflightSource,
			beforeRead: sqlFilePreflightReadHook,
		})
		if readErr == nil {
			var preflightResult SQLImportPreflightResult
			preflightResult, readErr = preflightSQLFileExecutionSourceWithPolicy(preflightReader, dbType, maxStatementBytes, policy.StatementGuard)
			if readErr == nil && !preflightResult.Safe && preflightResult.Reason != nil {
				readErr = &sqlFilePreflightRejectedError{reason: *preflightResult.Reason}
			}
		}
		closeErr := preflightSource.Close()
		if readErr != nil {
			return nil, readErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		preamble = preflightPreamble
	}

	executionSource, err := OpenSQLImportSource(filePath, SQLImportSourceOptions{RawObserver: rawObserver})
	if err != nil {
		return nil, err
	}
	executionReader := io.Reader(&sqlImportContextReader{ctx: ctx, reader: executionSource})
	if !fullPreflight {
		preamble, executionReader, err = readSQLFileExecutionPreambleStream(executionReader)
		if err != nil {
			_ = executionSource.Close()
			return nil, err
		}
	}
	return &preparedSQLFileExecutionSource{
		source:   executionSource,
		reader:   executionReader,
		preamble: preamble,
		rawSize:  info.Size(),
	}, nil
}

func readSQLFileExecutionPreamble(reader io.ReadSeeker) ([]byte, error) {
	buffer := make([]byte, sqlFileExecutionPreambleBytes)
	read, err := io.ReadFull(reader, buffer)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return buffer[:read], nil
}

type goNaviMySQLDatabaseBackupPreamble struct {
	databaseName           string
	includesCreateDatabase bool
}

func parseGoNaviMySQLDatabaseBackupPreamble(preamble []byte) (goNaviMySQLDatabaseBackupPreamble, bool) {
	text := strings.TrimPrefix(string(preamble), "\ufeff")
	if !strings.HasPrefix(strings.TrimSpace(text), "-- GoNavi SQL Export") {
		return goNaviMySQLDatabaseBackupPreamble{}, false
	}

	databaseName := ""
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "-- Database:") {
			databaseName = strings.TrimSpace(strings.TrimPrefix(trimmed, "-- Database:"))
			break
		}
	}
	if databaseName == "" {
		return goNaviMySQLDatabaseBackupPreamble{}, false
	}

	quotedDatabase := quoteIdentByType("mysql", databaseName)
	if !strings.Contains(text, "USE "+quotedDatabase+";") {
		return goNaviMySQLDatabaseBackupPreamble{}, false
	}
	return goNaviMySQLDatabaseBackupPreamble{
		databaseName:           databaseName,
		includesCreateDatabase: strings.Contains(text, "CREATE DATABASE IF NOT EXISTS "+quotedDatabase+";"),
	}, true
}

func buildGoNaviMySQLDatabaseBackupBootstrapSQL(backup goNaviMySQLDatabaseBackupPreamble) string {
	if backup.includesCreateDatabase || strings.TrimSpace(backup.databaseName) == "" {
		return ""
	}
	return fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", quoteIdentByType("mysql", backup.databaseName))
}

func resolveSQLFileExecutionProgressPercent(status string, bytesRead, totalSize int64) float64 {
	if totalSize <= 0 {
		return 0
	}
	percent := float64(bytesRead) / float64(totalSize) * 100
	if percent < 0 {
		return 0
	}
	if percent > 100 {
		percent = 100
	}
	// The SQL splitter reads ahead before executing the statements found in that
	// chunk. Reaching EOF therefore means parsing is complete, not execution.
	// Reserve 100% for the successful terminal event.
	if !strings.EqualFold(strings.TrimSpace(status), "done") && percent >= 100 {
		return 99
	}
	return percent
}

func resolveSQLFileExecutionRunConfig(config connection.ConnectionConfig, dbName string, preamble []byte) connection.ConnectionConfig {
	runConfig := normalizeRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "mysql") {
		_, isGoNaviDatabaseBackup := parseGoNaviMySQLDatabaseBackupPreamble(preamble)
		if !isGoNaviDatabaseBackup {
			return runConfig
		}
		// A GoNavi database backup creates and selects its source database itself.
		// Connect at server level so restoring into a deleted database can start.
		runConfig.Database = ""
	}
	return runConfig
}

func buildSQLFileExecutionPayload(executed, failed int, outcome string) map[string]interface{} {
	outcome = strings.ToLower(strings.TrimSpace(outcome))
	completed := outcome == "completed" || outcome == "partial"
	stoppedOnError := outcome == "stopped"
	cancelled := outcome == "cancelled"
	return map[string]interface{}{
		"executed":       executed,
		"failed":         failed,
		"completed":      completed,
		"stoppedOnError": stoppedOnError,
		"cancelled":      cancelled,
		"outcome":        outcome,
	}
}

// ImportDatabaseSQL restores a database from a SQL file while honoring the
// connection protections that apply to destructive import workflows.
func (a *App) ImportDatabaseSQL(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool) connection.QueryResult {
	return a.importDatabaseSQLWithGTIDMode(config, dbName, filePath, jobID, continueOnError, mysqlGTIDImportModeReject)
}

func (a *App) ImportDatabaseSQLWithOptions(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mysqlGTIDMode string) connection.QueryResult {
	mode, err := normalizeMySQLGTIDImportMode(mysqlGTIDMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_mode_invalid", nil)}
	}
	return a.importDatabaseSQLWithGTIDMode(config, dbName, filePath, jobID, continueOnError, mode)
}

func (a *App) importDatabaseSQLWithGTIDMode(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mode mysqlGTIDImportMode) (result connection.QueryResult) {
	return a.importDatabaseSQLWithGTIDModeContext(context.Background(), config, dbName, filePath, jobID, continueOnError, mode)
}

func (a *App) importDatabaseSQLContext(ctx context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mysqlGTIDMode string) connection.QueryResult {
	mode := mysqlGTIDImportModeReject
	if strings.TrimSpace(mysqlGTIDMode) != "" {
		var err error
		mode, err = normalizeMySQLGTIDImportMode(mysqlGTIDMode)
		if err != nil {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_mode_invalid", nil)}
		}
	}
	return a.importDatabaseSQLWithGTIDModeContext(ctx, config, dbName, filePath, jobID, continueOnError, mode)
}

func (a *App) importDatabaseSQLWithGTIDModeContext(ctx context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mode mysqlGTIDImportMode) (result connection.QueryResult) {
	if err := a.validateDatabaseSQLImportAccess(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeSQLExecution)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	filePath = resolvedPath
	if a.webRuntime {
		defer func() { result = sanitizeWebManagedResult(result, filePath) }()
	}
	if !isMySQLGTIDImportConfig(config) {
		mode = ""
	}
	return a.executeSQLFileWithStatementLimitPolicyContextWithPolicy(
		ctx,
		config,
		dbName,
		filePath,
		jobID,
		continueOnError,
		DefaultSQLImportMaxStatementBytes,
		true,
		"sql_file",
		sqlFileExecutionPolicy{
			TransactionMode: sqlFileTransactionModeOff,
			MySQLGTIDMode:   mode,
		},
	)
}

func (a *App) ExecuteSQLFile(config connection.ConnectionConfig, dbName string, filePath string, jobID string) connection.QueryResult {
	return a.executeSQLFileContext(context.Background(), config, dbName, filePath, jobID)
}

func (a *App) executeSQLFileContext(ctx context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string) connection.QueryResult {
	// The generic SQL-file runner retains its established compatibility
	// behavior. Database restore calls ImportDatabaseSQL and chooses the policy
	// explicitly, defaulting to fail-fast in the UI.
	if err := ensureConnectionAllowsActionWithText(
		config,
		connectionProtectionScriptExecution,
		"connection.backend.action.import_data",
		a.appText,
	); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return a.executeSQLFileWithStatementLimitPolicyContext(ctx, config, dbName, filePath, jobID, true, DefaultSQLImportMaxStatementBytes, false, "sql_file")
}

func (a *App) executeSQLFile(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimit(config, dbName, filePath, jobID, continueOnError, DefaultSQLImportMaxStatementBytes)
}

func (a *App) executeSQLFileWithStatementLimit(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimitPolicy(config, dbName, filePath, jobID, continueOnError, maxStatementBytes, false)
}

func (a *App) executeSQLFileWithStatementLimitPolicy(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64, requirePinnedSession bool) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimitPolicyContext(
		context.Background(),
		config,
		dbName,
		filePath,
		jobID,
		continueOnError,
		maxStatementBytes,
		requirePinnedSession,
		"sql_file",
	)
}

// executeSQLFileWithStatementLimitPolicyContext is the shared streaming
// runner used by desktop and headless callers. The audit source stays an
// internal argument so an external caller cannot forge a provenance value.
func (a *App) executeSQLFileWithStatementLimitPolicyContext(parent context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64, requirePinnedSession bool, auditSource string) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimitPolicyContextWithPolicy(
		parent,
		config,
		dbName,
		filePath,
		jobID,
		continueOnError,
		maxStatementBytes,
		requirePinnedSession,
		auditSource,
		sqlFileExecutionPolicy{TransactionMode: sqlFileTransactionModeOff},
	)
}

func (a *App) executeSQLFileWithStatementLimitPolicyContextWithPolicy(parent context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64, requirePinnedSession bool, auditSource string, policy sqlFileExecutionPolicy) (result connection.QueryResult) {
	if parent == nil {
		parent = context.Background()
	}
	if policy.TransactionMode != sqlFileTransactionModeSingle {
		policy.TransactionMode = sqlFileTransactionModeOff
	}
	if policy.TransactionMode == sqlFileTransactionModeSingle {
		policy.ForceFullPreflight = true
		if continueOnError {
			return connection.QueryResult{Success: false, Message: "single-transaction SQL-file execution does not support continue-on-error"}
		}
		if !isSQLFileSingleTransactionDialectSupported(resolveDDLDBType(config)) {
			return connection.QueryResult{Success: false, Message: "single-transaction SQL-file execution cannot prove atomicity for this database type"}
		}
	}
	containsMySQLGTIDPurged := false
	if policy.MySQLGTIDMode != "" && isMySQLGTIDImportConfig(config) {
		policy.ForceFullPreflight = true
		originalGuard := policy.StatementGuard
		policy.StatementGuard = func(index int, statement string) error {
			if isMySQLGTIDPurgedStatement(statement) {
				containsMySQLGTIDPurged = true
			}
			if originalGuard != nil {
				return originalGuard(index, statement)
			}
			return nil
		}
		if policy.MySQLGTIDMode == mysqlGTIDImportModeSkip {
			policy.SkipStatement = func(_ int, statement string) bool {
				return isMySQLGTIDPurgedStatement(statement)
			}
		}
	}
	if maxStatementBytes <= 0 {
		maxStatementBytes = DefaultSQLImportMaxStatementBytes
	}
	if strings.ToLower(strings.TrimSpace(auditSource)) != "cli" {
		auditSource = "sql_file"
	}
	auditSQL := "EXECUTE SQL FILE"
	auditStatementCount := 0
	auditSafeError := "SQL file task failed before an execution summary was available"
	defer a.beginSQLAuditUserActionWithOptions(config, dbName, auditSource, &auditSQL, &result, sqlAuditUserActionOptions{
		StatementCount: &auditStatementCount,
		SafeError:      &auditSafeError,
	})()
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.file_path_empty", nil)}
	}
	if strings.TrimSpace(jobID) == "" {
		jobID = "sqlfile-" + uuid.NewString()
	}

	sourceIdentity, err := captureImportSourceIdentity(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
	}
	logger.Warnf("ExecuteSQLFile 开始：source=%s size=%d db=%s jobID=%s", sourceIdentity.Token, sourceIdentity.Size, dbName, jobID)

	ctx, cancel := context.WithCancel(parent)
	cleanupRegistration, registered := a.registerImportTask(jobID, cancel, importjob.KindSQL)
	if !registered {
		cancel()
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_already_running", nil)}
	}
	defer cancel()
	defer cleanupRegistration()

	managedJob, err := a.beginManagedImportJob(managedImportJobStart{
		ID:                  jobID,
		Kind:                importjob.KindSQL,
		SourcePath:          filePath,
		SourceIdentityToken: sourceIdentity.Token,
		SourceBytesTotal:    sourceIdentity.Size,
		ByteProgressKind:    "rawSource",
		TargetFingerprint:   buildImportTargetFingerprint(config, dbName, ""),
		ConnectionID:        config.ID,
		DatabaseName:        dbName,
		OptionsHash:         buildSQLImportOptionsHashWithGTIDMode(continueOnError, maxStatementBytes, policy.TransactionMode, policy.MySQLGTIDMode),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() {
		if finishErr := managedJob.finish(managedImportJobFinishFromResult(result)); finishErr != nil && result.Success {
			result = connection.QueryResult{Success: false, Message: finishErr.Error(), Data: result.Data}
		}
	}()
	mayHaveDatabaseSideEffects := false
	defer func() {
		if identityErr := validateImportSourceIdentity(filePath, sourceIdentity); identityErr != nil {
			payload, _ := result.Data.(map[string]interface{})
			if payload == nil {
				payload = map[string]interface{}{}
			}
			payload["sourceChanged"] = true
			payload["outcomeUnknown"] = mayHaveDatabaseSideEffects
			result = connection.QueryResult{
				Success: false,
				Message: a.appText("file.backend.error.import_source_changed", nil),
				Data:    payload,
			}
		}
	}()

	var jobPersistErr error
	preflightObserver := &sqlFileRawProgressObserver{report: func(bytesRead int64) error {
		uievents.Emit(a.ctx, "sqlfile:progress", map[string]interface{}{
			"jobId":             jobID,
			"status":            "running",
			"stage":             "preflight",
			"executed":          0,
			"failed":            0,
			"total":             0,
			"percent":           resolveSQLFileExecutionProgressPercent("running", bytesRead, sourceIdentity.Size),
			"bytesRead":         bytesRead,
			"totalBytes":        sourceIdentity.Size,
			"byteProgressKind":  "rawSource",
			"decodedBytes":      nil,
			"decodedTotalBytes": nil,
			"currentSQL":        "",
			"error":             "",
		})
		if managedJob == nil || jobPersistErr != nil {
			return jobPersistErr
		}
		jobPersistErr = managedJob.update(managedImportJobProgress{
			Stage:            "preflight",
			BytesRead:        bytesRead,
			SourceBytesTotal: sourceIdentity.Size,
			ByteProgressKind: "rawSource",
			Checkpoint:       importjob.Checkpoint{Safe: false, ByteOffset: bytesRead},
		})
		if jobPersistErr != nil {
			cancel()
		}
		return jobPersistErr
	}}
	fileDigest := sha256.New()
	preparedSource, err := prepareSQLFileExecutionSourceWithPolicyContext(ctx, filePath, resolveDDLDBType(config), maxStatementBytes, fileDigest, preflightObserver, policy)
	if err != nil {
		if jobPersistErr != nil {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "failed"),
				Message: a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()}),
			}
		}
		if errors.Is(err, context.Canceled) {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
				Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
			}
		}
		if isSQLFilePreExecutionValidationError(err) {
			var preflightErr *sqlFilePreflightRejectedError
			data := buildSQLFileExecutionPayload(0, 0, "failed")
			if errors.As(err, &preflightErr) {
				data = buildSQLFilePreflightFailurePayload(preflightErr)
			}
			var policyErr *HeadlessSQLPolicyError
			if errors.As(err, &policyErr) {
				data["errorKind"] = headlessResultErrorKindPolicy
			}
			return connection.QueryResult{
				Success: false,
				Data:    data,
				Message: a.appText("file.backend.error.sql_file_execution_failed_summary", map[string]any{"detail": err.Error(), "count": 0}),
			}
		}
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
	}
	defer preparedSource.Close()
	if err := validateImportSourceIdentity(filePath, sourceIdentity); err != nil {
		return connection.QueryResult{
			Success: false,
			Data: map[string]interface{}{
				"sourceChanged":  true,
				"outcomeUnknown": false,
			},
			Message: a.appText("file.backend.error.import_source_changed", nil),
		}
	}
	preamble := preparedSource.preamble
	backupPreamble := goNaviMySQLDatabaseBackupPreamble{}
	isGoNaviMySQLDatabaseBackup := false
	if strings.EqualFold(strings.TrimSpace(config.Type), "mysql") {
		backupPreamble, isGoNaviMySQLDatabaseBackup = parseGoNaviMySQLDatabaseBackupPreamble(preamble)
	}

	// GoNavi 的 MySQL 整库备份会在脚本中创建并 USE 源库，因此不能先连接到该库。
	runConfig := resolveSQLFileExecutionRunConfig(config, dbName, preamble)

	dbInst, err := a.getDatabaseWithContext(ctx, runConfig, false)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
				Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
			}
		}
		logger.Errorf("ExecuteSQLFile 获取连接失败：%s err=%s", formatConnSummary(runConfig), sanitizeSQLFileExecutionErr(err))
		result := connection.QueryResult{Success: false, Message: sanitizeSQLFileExecutionErr(err)}
		if strings.EqualFold(strings.TrimSpace(auditSource), "cli") {
			result.Data = map[string]interface{}{"errorKind": headlessResultErrorKindConnection}
		}
		return result
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{
			Success: false,
			Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
			Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
		}
	}
	if requirePinnedSession {
		if _, ok := dbInst.(db.SessionExecerProvider); !ok {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "failed"),
				Message: a.appText("data_import.capability.reason.pinned_session_unavailable", nil),
			}
		}
	}
	if containsMySQLGTIDPurged {
		switch policy.MySQLGTIDMode {
		case mysqlGTIDImportModeReject:
			state, stateErr := queryMySQLGTIDTargetState(dbInst)
			if stateErr != nil {
				return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(stateErr)})}
			}
			if strings.TrimSpace(state.GTIDExecuted) != "" {
				return connection.QueryResult{
					Success: false,
					Data:    buildMySQLGTIDPreflightPayload(true, state),
					Message: a.appText("file.backend.error.mysql_gtid_decision_required", nil),
				}
			}
		case mysqlGTIDImportModeReset:
			state, stateErr := queryMySQLGTIDTargetState(dbInst)
			if stateErr != nil {
				return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(stateErr)})}
			}
			resetStatement, resetErr := mysqlGTIDResetStatement(state.ServerVersion)
			if resetErr != nil {
				return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(resetErr)})}
			}
			mayHaveDatabaseSideEffects = true
			if _, resetErr = execSQLFileStatement(ctx, dbInst, resetStatement); resetErr != nil {
				return connection.QueryResult{
					Success: false,
					Data: map[string]interface{}{
						"gtidResetAttempted": true,
						"outcomeUnknown":     db.IsWriteOutcomeUnknown(resetErr) || db.IsAmbiguousWriteResponse(resetErr),
					},
					Message: a.appText("file.backend.error.mysql_gtid_reset_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(resetErr)}),
				}
			}
		}
	}

	totalSize := preparedSource.rawSize
	totalSizeKnown := true

	if bootstrapSQL := buildGoNaviMySQLDatabaseBackupBootstrapSQL(backupPreamble); isGoNaviMySQLDatabaseBackup && bootstrapSQL != "" {
		mayHaveDatabaseSideEffects = true
		if _, err := execSQLFileStatement(ctx, dbInst, bootstrapSQL); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return connection.QueryResult{
					Success: false,
					Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
					Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
				}
			}
			data := buildSQLFileExecutionPayload(0, 1, "failed")
			data["outcomeUnknown"] = true
			data["bootstrapAttempted"] = true
			return connection.QueryResult{Success: false, Data: data, Message: sanitizeSQLFileExecutionErr(err)}
		}
	}

	// 发送进度事件的辅助函数
	emitProgress := func(status string, executed, failed, total int, bytesRead int64, currentSQL string, errMsg string) {
		percent := resolveSQLFileExecutionProgressPercent(status, bytesRead, totalSize)
		uievents.Emit(a.ctx, "sqlfile:progress", map[string]interface{}{
			"jobId":             jobID,
			"status":            status,
			"stage":             "write",
			"executed":          executed,
			"failed":            failed,
			"total":             total,
			"percent":           percent,
			"bytesRead":         bytesRead,
			"totalBytes":        totalSize,
			"byteProgressKind":  "rawSource",
			"decodedBytes":      nil,
			"decodedTotalBytes": nil,
			"currentSQL":        currentSQL,
			"error":             errMsg,
		})
		if managedJob != nil && jobPersistErr == nil {
			jobPersistErr = managedJob.update(managedImportJobProgress{
				Stage:            "write",
				Current:          int64(total),
				Total:            int64(total),
				Succeeded:        int64(executed),
				Failed:           int64(failed),
				BytesRead:        bytesRead,
				SourceBytesTotal: totalSize,
				ByteProgressKind: "rawSource",
				Checkpoint: importjob.Checkpoint{
					Safe:           false,
					StatementIndex: int64(total),
					ByteOffset:     bytesRead,
				},
				ForcePersist: status != "running",
			})
			if jobPersistErr != nil {
				cancel()
			}
		}
	}

	emitProgress("running", 0, 0, 0, 0, "", "")

	startTime := time.Now()
	execResult, streamErr := executeSQLFileStream(ctx, dbInst, preparedSource.reader, sqlFileExecutionOptions{
		DBType:            resolveDDLDBType(runConfig),
		MaxStatementBytes: maxStatementBytes,
		ContinueOnError:   continueOnError,
		TransactionMode:   policy.TransactionMode,
		StatementGuard:    policy.StatementGuard,
		SkipStatement:     policy.SkipStatement,
		// Keep the callback guard even after a full small-file preflight so a
		// source replacement between the two opens cannot send client commands
		// to the database.
		PreflightEachStatement: true,
		Text:                   a.appText,
		OnProgress: func(progress sqlFileExecutionProgress) {
			emitProgress(
				progress.Status,
				progress.Executed,
				progress.Failed,
				progress.Total,
				progress.BytesRead,
				progress.CurrentSQL,
				progress.Error,
			)
		},
	}, func() int64 {
		return preparedSource.source.RawBytesRead()
	})

	duration := time.Since(startTime)
	executedCount := execResult.Executed
	failedCount := execResult.Failed
	errorLogs := execResult.Errors
	auditStatementCount = executedCount + failedCount
	auditSQL = fmt.Sprintf("EXECUTE SQL FILE EXECUTED_%d FAILED_%d", executedCount, failedCount)
	auditSafeError = fmt.Sprintf("SQL file task failed after executing %d statement(s); %d statement(s) failed", executedCount, failedCount)
	rawBytesRead := preparedSource.source.RawBytesRead()
	mayHaveDatabaseSideEffects = mayHaveDatabaseSideEffects || executedCount > 0 || failedCount > 0 || execResult.OutcomeUnknown
	contentSHA256 := ""
	if totalSizeKnown && rawBytesRead == totalSize {
		contentSHA256 = hex.EncodeToString(fileDigest.Sum(nil))
		auditSQL += " SHA256_" + contentSHA256
	}
	if managedJob != nil && jobPersistErr == nil {
		jobPersistErr = managedJob.update(managedImportJobProgress{
			Stage:               "write",
			Current:             int64(executedCount + failedCount),
			Total:               int64(executedCount + failedCount),
			Succeeded:           int64(executedCount),
			Failed:              int64(failedCount),
			BytesRead:           rawBytesRead,
			SourceBytesTotal:    totalSize,
			ByteProgressKind:    "rawSource",
			SourceContentSHA256: contentSHA256,
			Checkpoint: importjob.Checkpoint{
				Safe:           false,
				StatementIndex: int64(executedCount + failedCount),
				ByteOffset:     rawBytesRead,
			},
			OutcomeUnknown: execResult.OutcomeUnknown,
			ForcePersist:   true,
		})
	}
	if jobPersistErr != nil {
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "failed")
		data["outcomeUnknown"] = mayHaveDatabaseSideEffects
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()}),
		}
	}

	if errors.Is(streamErr, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		emitProgress("cancelled", executedCount, failedCount, executedCount+failedCount, rawBytesRead, "", a.appText("file.backend.message.user_cancelled", nil))
		logger.Warnf("ExecuteSQLFile 已取消：executed=%d failed=%d duration=%v", executedCount, failedCount, duration)
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "cancelled")
		data["outcomeUnknown"] = execResult.OutcomeUnknown
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.message.execution_cancelled", map[string]any{
				"executed": executedCount,
				"failed":   failedCount,
				"duration": duration.Round(time.Millisecond),
			}),
		}
	}
	safeStreamError := sanitizeSQLFileExecutionErr(streamErr)

	if errors.Is(streamErr, errSQLFileStoppedOnError) {
		emitProgress("error", executedCount, failedCount, executedCount+failedCount, rawBytesRead, "", safeStreamError)
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "stopped")
		if execResult.OutcomeUnknown {
			data["outcomeUnknown"] = true
		}
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.error.sql_file_stopped_on_error_summary", map[string]any{
				"detail":  safeStreamError,
				"success": executedCount,
				"failed":  failedCount,
			}),
		}
	}

	if streamErr != nil {
		emitProgress("error", executedCount, failedCount, executedCount+failedCount, rawBytesRead, "", safeStreamError)
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "failed")
		var preflightErr *sqlFilePreflightRejectedError
		if errors.As(streamErr, &preflightErr) {
			preflightErr.possibleSideEffects = preflightErr.possibleSideEffects || mayHaveDatabaseSideEffects
			preflightErr.outcomeUnknown = preflightErr.outcomeUnknown || failedCount > 0
			data = buildSQLFilePreflightFailurePayload(preflightErr)
		} else if execResult.OutcomeUnknown || failedCount > 0 {
			data["outcomeUnknown"] = true
		}
		var policyErr *HeadlessSQLPolicyError
		if errors.As(streamErr, &policyErr) {
			data["errorKind"] = headlessResultErrorKindPolicy
		}
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.error.sql_file_execution_failed_summary", map[string]any{
				"detail": safeStreamError,
				"count":  executedCount,
			}),
		}
	}

	emitProgress("done", executedCount, failedCount, executedCount+failedCount, totalSize, "", "")

	summary := a.appText("file.backend.message.execution_completed", map[string]any{
		"success":  executedCount,
		"failed":   failedCount,
		"duration": duration.Round(time.Millisecond),
	})
	if len(errorLogs) > 0 {
		maxShow := len(errorLogs)
		summary += "\n\n" + a.appText("file.backend.message.execution_error_detail_header", map[string]any{"count": maxShow}) + "\n" + strings.Join(errorLogs[:maxShow], "\n")
		if omitted := failedCount - maxShow; omitted > 0 {
			summary += "\n" + a.appText("file.backend.message.execution_more_errors", map[string]any{"count": omitted})
		}
	}

	logger.Warnf("ExecuteSQLFile 完成：executed=%d failed=%d duration=%v", executedCount, failedCount, duration)
	data := buildSQLFileExecutionPayload(executedCount, failedCount, func() string {
		if failedCount > 0 {
			return "partial"
		}
		return "completed"
	}())
	if execResult.OutcomeUnknown {
		data["outcomeUnknown"] = true
	}
	return connection.QueryResult{
		Success: failedCount == 0,
		Data:    data,
		Message: summary,
	}
}

// CancelSQLFileExecution 取消正在执行的 SQL 文件任务。
func (a *App) CancelSQLFileExecution(jobID string) connection.QueryResult {
	return a.cancelImportTaskByKind(jobID, importjob.KindSQL)
}

func readImportedConnectionConfigFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > connectionImportMaxFileBytes {
		return "", errConnectionImportFileTooLarge
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func (a *App) ImportConfigFile() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Config File",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "GoNavi Connection Package (*.gonavi-conn)",
				Pattern:     "*.gonavi-conn",
			},
			{
				DisplayName: "JSON Files (*.json)",
				Pattern:     "*.json",
			},
			{
				DisplayName: "MySQL Workbench Connections (*.xml)",
				Pattern:     "*.xml",
			},
			{
				DisplayName: "Navicat Connections (*.ncx)",
				Pattern:     "*.ncx",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	content, err := readImportedConnectionConfigFile(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageMessage(a.appText, err)}
	}

	return connection.QueryResult{Success: true, Data: content}
}

func (a *App) ExportConnectionsPackage(options ConnectionExportOptions) connection.QueryResult {
	filename, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("file.backend.dialog.export_connections", nil),
		DefaultFilename: "connections" + connectionPackageExtension,
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.connection_package", nil),
				Pattern:     "*.gonavi-conn",
			},
		},
	})
	if err != nil || strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	filename = normalizeConnectionPackageExportFilename(filename)

	content, err := a.buildExportedConnectionPackage(options)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, err)}
	}
	if len(content) > connectionImportMaxFileBytes {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, errConnectionImportFileTooLarge)}
	}
	if err := os.WriteFile(filename, content, 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

// ExportConnectionsPayload builds a recovery package for browser clients. The browser is
// responsible for saving it locally because a Web Server process cannot open its file dialog.
func (a *App) ExportConnectionsPayload(options ConnectionExportOptions) connection.QueryResult {
	content, err := a.buildExportedConnectionPackage(options)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, err)}
	}
	if len(content) > connectionImportMaxFileBytes {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, errConnectionImportFileTooLarge)}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data:    string(content),
	}
}

func normalizeConnectionPackageExportFilename(filename string) string {
	trimmed := strings.TrimSpace(filename)
	if trimmed == "" {
		return ""
	}
	if strings.EqualFold(filepath.Ext(trimmed), connectionPackageExtension) {
		return trimmed
	}
	return trimmed + connectionPackageExtension
}

// sshKeyFileDialogFilters intentionally returns nil. The macOS Wails adapter
// treats filters as filename extensions, which excludes extensionless OpenSSH
// keys such as ~/.ssh/id_ed25519. A nil filter list means all files.
func sshKeyFileDialogFilters() []runtime.FileFilter {
	return nil
}

func (a *App) SelectSSHKeyFile(currentPath string) connection.QueryResult {
	fallbackDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		fallbackDir = filepath.Join(home, ".ssh")
	}
	defaultDir := resolveFileOpenDialogDirectory(currentPath, fallbackDir)

	// OpenSSH private keys are commonly extensionless (id_ed25519, id_ecdsa,
	// custom names). Wails/macOS interprets filters as filename extensions, so
	// even an "all files" glob can hide extensionless keys. Omitting filters
	// lets the native dialog accept every file while still showing ~/.ssh items.
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("file.backend.dialog.select_ssh_key_file", nil),
		DefaultDirectory: defaultDir,
		ShowHiddenFiles:  true,
		Filters:          sshKeyFileDialogFilters(),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

// SelectSSHKnownHostsFile opens a local file dialog for a known_hosts file.
// It deliberately only selects an existing user-managed file: SSH host keys
// are never fetched, accepted, or written automatically by this application.
func (a *App) SelectSSHKnownHostsFile(currentPath string) connection.QueryResult {
	fallbackDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		fallbackDir = filepath.Join(home, ".ssh")
	}
	defaultDir := resolveFileOpenDialogDirectory(currentPath, fallbackDir)

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("file.backend.dialog.select_ssh_known_hosts_file", nil),
		DefaultDirectory: defaultDir,
		ShowHiddenFiles:  true,
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*.*",
			},
		},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) SelectCertificateFile(currentPath string, certKind string) connection.QueryResult {
	fallbackDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		fallbackDir = home
	}
	defaultDir := resolveFileOpenDialogDirectory(currentPath, fallbackDir)

	kind := strings.ToLower(strings.TrimSpace(certKind))
	titleKey := "file.backend.dialog.select_tls_certificate_file"
	displayNameKey := "file.backend.filter.certificate_files"
	// Certificate material usually has extensions. Client private keys are often
	// extensionless, so that dialog intentionally omits filters below.
	filterPattern := "*.pem;*.crt;*.cer;*.cert;*.key"
	var filters []runtime.FileFilter
	switch kind {
	case "ca":
		titleKey = "file.backend.dialog.select_ca_server_certificate_file"
	case "client-cert":
		titleKey = "file.backend.dialog.select_client_certificate_file"
	case "client-key":
		titleKey = "file.backend.dialog.select_client_private_key_file"
		displayNameKey = "file.backend.filter.private_key_files"
	}
	if kind != "client-key" {
		filters = []runtime.FileFilter{
			{
				DisplayName: a.appText(displayNameKey, nil),
				Pattern:     filterPattern,
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*.*",
			},
		}
	}

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText(titleKey, nil),
		DefaultDirectory: defaultDir,
		ShowHiddenFiles:  kind == "client-key",
		Filters:          filters,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) SelectDatabaseFile(currentPath string, driverType string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentPath)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = home
		}
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if defaultDir != "" && !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	normalizedType := strings.ToLower(strings.TrimSpace(driverType))
	filters := []runtime.FileFilter{
		{
			DisplayName: a.appText("file.backend.filter.database_files", nil),
			Pattern:     "*.db;*.sqlite;*.sqlite3;*.db3;*.duckdb;*.ddb",
		},
		{
			DisplayName: a.appText("file.backend.filter.all_files", nil),
			Pattern:     "*",
		},
	}
	titleKey := "file.backend.dialog.select_database_file"
	switch normalizedType {
	case "sqlite":
		titleKey = "file.backend.dialog.select_sqlite_file"
		filters = []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.sqlite_files", nil),
				Pattern:     "*.db;*.sqlite;*.sqlite3;*.db3",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*",
			},
		}
	case "duckdb":
		titleKey = "file.backend.dialog.select_duckdb_file"
		filters = []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.duckdb_files", nil),
				Pattern:     "*.duckdb;*.ddb;*.db",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*",
			},
		}
	}

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText(titleKey, nil),
		DefaultDirectory: defaultDir,
		Filters:          filters,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

// PreviewImportFile 解析导入文件，返回字段列表、总行数、前 5 行预览数据
func (a *App) PreviewImportFile(filePath string) connection.QueryResult {
	return a.previewImportFileContext(context.Background(), filePath, ImportFileOptions{})
}

// PreviewImportFileWithOptions previews a file with the same parser settings
// that will be used by ImportDataWithProgressOptions.
func (a *App) PreviewImportFileWithOptions(filePath string, options ImportFileOptions) (queryResult connection.QueryResult) {
	return a.previewImportFileContext(context.Background(), filePath, options)
}

func (a *App) previewImportFileContext(ctx context.Context, filePath string, options ImportFileOptions) (queryResult connection.QueryResult) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_file_empty", nil)}
	}
	fileReference := filePath
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeDataImport)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	filePath = resolvedPath
	if a.webRuntime {
		defer func() { queryResult = sanitizeWebManagedResult(queryResult, filePath) }()
	}
	if err := validateImportFileOptions(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	sourceIdentity, err := captureImportSourceIdentity(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	preview, err := buildImportPreviewWithOptionsContext(ctx, filePath, defaultImportPreviewLimit, options)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	result := map[string]interface{}{
		"columns":        preview.Columns,
		"totalRows":      preview.TotalRows,
		"totalRowsKnown": preview.TotalRowsKnown,
		"previewRows":    preview.PreviewRows,
		"filePath":       filePath,
		"fileSize":       sourceIdentity.Size,
		"sourceIdentity": sourceIdentity,
	}
	if a.webRuntime {
		result["filePath"] = fileReference
	}

	return connection.QueryResult{Success: true, Data: result}
}

func (a *App) ImportData(config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.import_data"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.import_data", map[string]any{"table": tableName}),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.data_files", nil),
				Pattern:     "*.csv;*.json;*.xlsx",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	// 返回文件路径供前端预览
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": selection}}
}

func normalizeColumnName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func buildImportColumnTypeMap(defs []connection.ColumnDefinition) map[string]string {
	result := make(map[string]string, len(defs))
	for _, def := range defs {
		key := normalizeColumnName(def.Name)
		if key == "" {
			continue
		}
		result[key] = strings.TrimSpace(def.Type)
	}
	return result
}

func isTimezoneAwareColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	return strings.Contains(typ, "with time zone") ||
		strings.Contains(typ, "with timezone") ||
		strings.Contains(typ, "datetimeoffset") ||
		strings.Contains(typ, "timestamptz")
}

func isDateTimeColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	return strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") || strings.Contains(typ, "timestamptz")
}

func isTimeOnlyColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	if strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") {
		return false
	}
	return strings.Contains(typ, "time") || strings.Contains(typ, "timetz")
}

func isDateOnlyColumnType(dbType, columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	if strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") || strings.Contains(typ, "time") {
		return false
	}
	if !strings.Contains(typ, "date") {
		return false
	}
	db := strings.ToLower(strings.TrimSpace(dbType))
	// Oracle/Dameng 的 DATE 带时间语义，不能按纯日期裁剪。
	return db != "oracle" && db != "dameng"
}

func isTemporalColumnType(dbType, columnType string) bool {
	return isDateTimeColumnType(columnType) || isTimeOnlyColumnType(columnType) || isDateOnlyColumnType(dbType, columnType)
}

func parseTemporalString(raw string) (time.Time, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return time.Time{}, false
	}

	layoutsWithZone := []string{
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05.999999999 -0700",
		"2006-01-02 15:04:05 -0700",
		time.RFC3339Nano,
		time.RFC3339,
	}

	for _, layout := range layoutsWithZone {
		parsed, err := time.Parse(layout, text)
		if err == nil {
			return parsed, true
		}
	}

	layoutsWithoutZone := []string{
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"15:04:05.999999999",
		"15:04:05",
	}

	for _, layout := range layoutsWithoutZone {
		parsed, err := time.ParseInLocation(layout, text, time.Local)
		if err == nil {
			return parsed, true
		}
	}

	return time.Time{}, false
}

func looksLikeTemporalText(raw string) bool {
	text := strings.TrimSpace(raw)
	if text == "" {
		return false
	}

	if len(text) >= 10 &&
		isDigit(text[0]) &&
		isDigit(text[1]) &&
		isDigit(text[2]) &&
		isDigit(text[3]) &&
		text[4] == '-' &&
		isDigit(text[5]) &&
		isDigit(text[6]) &&
		text[7] == '-' &&
		isDigit(text[8]) &&
		isDigit(text[9]) {
		return true
	}

	if len(text) >= 8 &&
		isDigit(text[0]) &&
		isDigit(text[1]) &&
		text[2] == ':' &&
		isDigit(text[3]) &&
		isDigit(text[4]) &&
		text[5] == ':' &&
		isDigit(text[6]) &&
		isDigit(text[7]) {
		return true
	}

	return false
}

func isDigit(ch byte) bool {
	return ch >= '0' && ch <= '9'
}

func normalizeExportTemporalText(text string) string {
	if !looksLikeTemporalText(text) {
		return text
	}
	if parsed, ok := parseTemporalString(text); ok {
		return parsed.Format("2006-01-02 15:04:05")
	}
	return text
}

func importTemporalFractionDigits(raw string) int {
	text := strings.TrimSpace(raw)
	for index := 0; index+8 < len(text); index++ {
		if !isDigit(text[index]) || !isDigit(text[index+1]) || text[index+2] != ':' ||
			!isDigit(text[index+3]) || !isDigit(text[index+4]) || text[index+5] != ':' ||
			!isDigit(text[index+6]) || !isDigit(text[index+7]) || text[index+8] != '.' {
			continue
		}
		digits := 0
		for cursor := index + 9; cursor < len(text) && isDigit(text[cursor]) && digits < 9; cursor++ {
			digits++
		}
		return digits
	}
	return 0
}

func importTemporalLayout(base string, fractionDigits int) string {
	if fractionDigits <= 0 {
		return base
	}
	return base + "." + strings.Repeat("0", fractionDigits)
}

func normalizeImportTemporalValue(dbType, columnType, raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return text
	}

	parsed, ok := parseTemporalString(text)
	if !ok {
		if isDateTimeColumnType(columnType) {
			candidate := strings.ReplaceAll(text, "T", " ")
			if len(candidate) >= 19 {
				prefix := candidate[:19]
				if _, err := time.Parse("2006-01-02 15:04:05", prefix); err == nil {
					return prefix
				}
			}
		}
		return text
	}

	fractionDigits := importTemporalFractionDigits(text)
	if isTimeOnlyColumnType(columnType) {
		return parsed.Format(importTemporalLayout("15:04:05", fractionDigits))
	}
	if isDateOnlyColumnType(dbType, columnType) {
		return parsed.Format("2006-01-02")
	}
	if isTimezoneAwareColumnType(columnType) {
		return parsed.Format(importTemporalLayout("2006-01-02 15:04:05", fractionDigits) + "-07:00")
	}
	return parsed.Format(importTemporalLayout("2006-01-02 15:04:05", fractionDigits))
}

func isPgLikeBooleanDBType(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "postgres", "postgresql", "pg", "pq", "pgx", "kingbase", "kingbase8", "kingbasees", "kingbasev8", "highgo", "vastbase", "opengauss", "open_gauss", "open-gauss", "gaussdb", "gauss_db", "gauss-db":
		return true
	default:
		return false
	}
}

func isBooleanColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	typ = strings.ReplaceAll(typ, `"`, "")
	if idx := strings.IndexAny(typ, " ("); idx >= 0 {
		typ = typ[:idx]
	}
	typ = strings.TrimPrefix(typ, "pg_catalog.")
	return typ == "bool" || typ == "boolean"
}

func booleanSQLLiteral(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func formatSignedBooleanSQLValue(v int64) (string, bool) {
	switch v {
	case 0:
		return "false", true
	case 1:
		return "true", true
	default:
		return "", false
	}
}

func formatUnsignedBooleanSQLValue(v uint64) (string, bool) {
	switch v {
	case 0:
		return "false", true
	case 1:
		return "true", true
	default:
		return "", false
	}
}

func formatFloatBooleanSQLValue(v float64) (string, bool) {
	if v == 0 {
		return "false", true
	}
	if v == 1 {
		return "true", true
	}
	return "", false
}

func formatBooleanStringSQLValue(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "t", "1", "yes", "y", "on":
		return "true", true
	case "false", "f", "0", "no", "n", "off":
		return "false", true
	default:
		return "", false
	}
}

func formatPostgresBooleanSQLValue(value interface{}) (string, bool) {
	switch val := value.(type) {
	case bool:
		return booleanSQLLiteral(val), true
	case int:
		return formatSignedBooleanSQLValue(int64(val))
	case int8:
		return formatSignedBooleanSQLValue(int64(val))
	case int16:
		return formatSignedBooleanSQLValue(int64(val))
	case int32:
		return formatSignedBooleanSQLValue(int64(val))
	case int64:
		return formatSignedBooleanSQLValue(val)
	case uint:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint8:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint16:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint32:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint64:
		return formatUnsignedBooleanSQLValue(val)
	case float32:
		return formatFloatBooleanSQLValue(float64(val))
	case float64:
		return formatFloatBooleanSQLValue(val)
	case []byte:
		if len(val) == 1 && (val[0] == 0 || val[0] == 1) {
			return booleanSQLLiteral(val[0] == 1), true
		}
		return formatBooleanStringSQLValue(string(val))
	case string:
		return formatBooleanStringSQLValue(val)
	default:
		return "", false
	}
}

func formatImportSQLValue(dbType, columnType string, value interface{}) string {
	if value == nil {
		return "NULL"
	}
	if literal, ok := formatImportCompositeJSONSQLValue(dbType, value); ok {
		return literal
	}

	if isPgLikeBooleanDBType(dbType) && isBooleanColumnType(columnType) {
		if literal, ok := formatPostgresBooleanSQLValue(value); ok {
			return literal
		}
	}

	if isTemporalColumnType(dbType, columnType) {
		normalized := normalizeImportTemporalValue(dbType, columnType, fmt.Sprintf("%v", value))
		return "'" + escapeSQLStringLiteralBody(dbType, normalized) + "'"
	}
	if text, ok := value.(string); ok {
		return "'" + escapeSQLStringLiteralBody(dbType, text) + "'"
	}

	return formatSQLValue(dbType, value)
}

func formatImportCompositeJSONSQLValue(dbType string, value interface{}) (string, bool) {
	if _, rawBytes := value.([]byte); rawBytes {
		return "", false
	}
	valueType := reflect.TypeOf(value)
	if valueType == nil {
		return "", false
	}
	switch valueType.Kind() {
	case reflect.Map, reflect.Slice, reflect.Array:
		encoded, err := json.Marshal(value)
		if err != nil {
			return "NULL", true
		}
		return "'" + escapeSQLStringLiteralBody(dbType, string(encoded)) + "'", true
	default:
		return "", false
	}
}

// ImportDataWithProgress 执行导入并发送进度事件
func (a *App) ImportDataWithProgress(config connection.ConnectionConfig, dbName, tableName, filePath string) (result connection.QueryResult) {
	return a.ImportDataWithProgressOptions(config, dbName, tableName, filePath, ImportFileOptions{})
}

func buildImportExecutionPayload(resultData importExecutionResult, summary string, cancelled bool) map[string]interface{} {
	total := resultData.Total
	if cancelled || (resultData.StoppedOnError && !resultData.OutcomeUnknown) {
		// Rows parsed into a buffer but never attempted are not processed rows.
		// A failed batch remains unknown because the batch API may have written a
		// subset before returning its error.
		total = resultData.Success + resultData.Skipped + resultData.Failed
	}
	return map[string]interface{}{
		"success":                       resultData.Success,
		"skipped":                       resultData.Skipped,
		"failed":                        resultData.Failed,
		"total":                         total,
		"affectedRows":                  int64(resultData.Success),
		"errorLogs":                     resultData.ErrorLogs,
		"errorLogsOmitted":              max(0, resultData.Failed-len(resultData.ErrorLogs)),
		"errorArtifactId":               resultData.ErrorArtifactID,
		"errorArtifactCount":            resultData.ErrorArtifactCount,
		"errorArtifactBytes":            resultData.ErrorArtifactBytes,
		"errorArtifactOmittedCount":     resultData.ErrorArtifactOmittedCount,
		"errorArtifactTruncated":        resultData.ErrorArtifactTruncated,
		"errorArtifactRetryableCount":   resultData.ErrorArtifactRetryableCount,
		"errorArtifactUnretryableCount": resultData.ErrorArtifactUnretryableCount,
		"errorArtifactScopeKnown":       resultData.ErrorArtifactScopeKnown,
		"errorArtifactMaxRows":          resultData.ErrorArtifactMaxRows,
		"errorArtifactMaxBytes":         resultData.ErrorArtifactMaxBytes,
		"errorSummary":                  summary,
		"cancelled":                     cancelled,
		"stoppedOnError":                resultData.StoppedOnError,
		"outcomeUnknown":                resultData.OutcomeUnknown,
	}
}

func (a *App) cancelledImportResult(resultData importExecutionResult) connection.QueryResult {
	summary := a.appText("file.backend.message.import_cancelled", map[string]any{
		"imported": resultData.Success,
		"skipped":  resultData.Skipped,
		"failed":   resultData.Failed,
	})
	return connection.QueryResult{
		Success: false,
		Data:    buildImportExecutionPayload(resultData, summary, true),
		Message: summary,
	}
}

func (a *App) stoppedImportResult(resultData importExecutionResult, detail string) connection.QueryResult {
	summary := a.appText("file.backend.error.import_stopped_on_error", map[string]any{
		"imported": resultData.Success,
		"skipped":  resultData.Skipped,
		"failed":   resultData.Failed,
		"detail":   detail,
	})
	return connection.QueryResult{
		Success: false,
		Data:    buildImportExecutionPayload(resultData, summary, false),
		Message: summary,
	}
}

// ImportDataWithProgressOptions executes a streamed import with optional source-header
// to database-column mappings. ImportDataWithProgress remains the compatibility entrypoint.
func (a *App) ImportDataWithProgressOptions(config connection.ConnectionConfig, dbName, tableName, filePath string, options ImportFileOptions) (result connection.QueryResult) {
	return a.importDataWithProgressContext(context.Background(), config, dbName, tableName, filePath, options)
}

func (a *App) importDataWithProgressContext(parent context.Context, config connection.ConnectionConfig, dbName, tableName, filePath string, options ImportFileOptions) (result connection.QueryResult) {
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeDataImport)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	filePath = resolvedPath
	if a.webRuntime {
		defer func() { result = sanitizeWebManagedResult(result, filePath) }()
	}
	return a.importDataWithProgressOptionsContext(parent, config, dbName, tableName, filePath, options, nil)
}

func (a *App) importDataWithProgressOptions(
	config connection.ConnectionConfig,
	dbName, tableName, filePath string,
	options ImportFileOptions,
	recovery *tableImportRecoveryPlan,
) (result connection.QueryResult) {
	return a.importDataWithProgressOptionsContext(context.Background(), config, dbName, tableName, filePath, options, recovery)
}

func (a *App) importDataWithProgressOptionsContext(
	parent context.Context,
	config connection.ConnectionConfig,
	dbName, tableName, filePath string,
	options ImportFileOptions,
	recovery *tableImportRecoveryPlan,
) (result connection.QueryResult) {
	if parent == nil {
		parent = context.Background()
	}
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_file_empty", nil)}
	}
	dbType := resolveDDLDBType(config)
	schemaName, pureTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	auditTarget := strings.TrimSpace(tableName)
	if pureTableName != "" {
		auditTarget = quoteTableIdentByType(dbType, schemaName, pureTableName)
	}
	if auditTarget == "" {
		auditTarget = "TARGET_TABLE"
	}
	auditSQL := "IMPORT DATA INTO " + auditTarget
	auditSafeError := "data import task failed"
	defer a.beginSQLAuditUserActionWithOptions(config, dbName, "data_import", &auditSQL, &result, sqlAuditUserActionOptions{
		SafeError: &auditSafeError,
	})()
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.import_data"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := validateImportFileOptions(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := validateImportConflictPolicyForDB(dbType, options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(options.ResumeJobID) != "" && recovery == nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_resume_unavailable", nil)}
	}
	sourceIdentity, err := captureImportSourceIdentity(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if expected := strings.TrimSpace(options.SourceIdentityToken); expected != "" && expected != sourceIdentity.Token {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_source_changed", nil)}
	}
	if recovery != nil {
		if err := a.validateTableImportRecovery(recovery, config, dbName, tableName, options, sourceIdentity); err != nil {
			return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
		}
	}
	importCtx, importCancel := context.WithCancel(parent)
	defer importCancel()
	jobID := strings.TrimSpace(options.JobID)
	if recovery != nil && jobID == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_resume_unavailable", nil)}
	}
	var managedJob *managedImportJob
	var managedArtifact *managedImportErrorArtifact
	mayHaveDatabaseSideEffects := false
	if jobID != "" {
		cleanupRegistration, registered := a.registerImportTask(jobID, importCancel, importjob.KindTable)
		if !registered {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_already_running", nil)}
		}
		defer cleanupRegistration()
		if recovery != nil {
			if err := a.claimTableImportRecovery(recovery, sourceIdentity.Token, buildImportTargetFingerprint(config, dbName, tableName), buildImportFileOptionsHash(options)); err != nil {
				return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
			}
		}
		start := managedImportJobStart{
			ID:                  jobID,
			Kind:                importjob.KindTable,
			SourcePath:          filePath,
			SourceIdentityToken: sourceIdentity.Token,
			SourceBytesTotal:    sourceIdentity.Size,
			ByteProgressKind:    "rawSource",
			TargetFingerprint:   buildImportTargetFingerprint(config, dbName, tableName),
			ConnectionID:        config.ID,
			DatabaseName:        dbName,
			TableName:           tableName,
			OptionsHash:         buildImportFileOptionsHash(options),
			TableImportOptions:  importJobTableOptionsFromImportFileOptions(options),
		}
		if recovery != nil {
			start.Stage = "resuming"
			start.ParentJobID = recovery.ParentJob.ID
			start.RecoveryAction = "resume"
			start.Current = recovery.ParentJob.Checkpoint.SourceRow
			start.Succeeded = recovery.ParentJob.Succeeded
			start.Skipped = recovery.ParentJob.Skipped
			start.Failed = recovery.ParentJob.Failed
			start.BytesRead = recovery.ParentJob.Checkpoint.ByteOffset
			start.Checkpoint = recovery.ParentJob.Checkpoint
		}
		managedJob, err = a.beginManagedImportJob(start)
		if err != nil {
			if recovery != nil {
				_ = a.releaseTableImportRecovery(recovery)
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer func() {
			if finishErr := managedJob.finish(managedImportJobFinishFromResult(result)); finishErr != nil && result.Success {
				result = connection.QueryResult{Success: false, Message: finishErr.Error(), Data: result.Data}
			}
		}()
		managedArtifact, err = a.beginManagedImportErrorArtifact(jobID)
		if err != nil {
			if recovery != nil {
				_ = a.releaseTableImportRecovery(recovery)
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer managedArtifact.abort()
	}
	defer func() {
		if identityErr := validateImportSourceIdentity(filePath, sourceIdentity); identityErr != nil {
			payload, _ := result.Data.(map[string]interface{})
			if payload == nil {
				payload = map[string]interface{}{}
			}
			payload["sourceChanged"] = true
			payload["outcomeUnknown"] = mayHaveDatabaseSideEffects
			result = connection.QueryResult{
				Success: false,
				Message: a.appText("file.backend.error.import_source_changed", nil),
				Data:    payload,
			}
		}
	}()
	if err := importCtx.Err(); err != nil {
		return a.cancelledImportResult(importExecutionResult{})
	}
	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabaseSynchronouslyWithContext(importCtx, runConfig, false)
	if err != nil {
		if errors.Is(importCtx.Err(), context.Canceled) {
			return a.cancelledImportResult(importExecutionResult{})
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := importCtx.Err(); err != nil {
		return a.cancelledImportResult(importExecutionResult{})
	}
	tableCapability := ResolveDataImportCapability(runConfig, dbInst).TableImport
	if !tableCapability.Supported {
		reason := strings.TrimSpace(tableCapability.Reason)
		if reason == "" {
			reason = DataImportReasonTableRuntimeUnavailable
		}
		return connection.QueryResult{
			Success: false,
			Message: a.appText("data_import.capability.reason."+reason, nil),
		}
	}

	targetColumns, colErr := a.importTargetColumnsContext(importCtx, dbInst, config, dbName, tableName)
	if errors.Is(importCtx.Err(), context.Canceled) {
		return a.cancelledImportResult(importExecutionResult{})
	}
	if colErr != nil && options.ColumnMappings != nil {
		return connection.QueryResult{Success: false, Message: colErr.Error()}
	}

	writer := newImportDatabaseRowWriterWithOptions(dbInst, dbType, tableName, newImportColumnTypeLookup(targetColumns), options)
	var jobPersistErr error
	batchConsumer := newImportBatchConsumer(writer, defaultImportApplyBatchSize, 0, false, resolveImportContinueOnError(options), func(state importProgressState) {
		if state.Success+state.Skipped+state.Errors > 0 {
			mayHaveDatabaseSideEffects = true
		}
		uievents.Emit(a.ctx, "import:progress", state)
		if managedJob == nil || jobPersistErr != nil {
			return
		}
		jobPersistErr = managedJob.update(managedImportJobProgress{
			Stage:            state.Stage,
			Current:          int64(state.Current),
			Total:            int64(state.Total),
			Succeeded:        int64(state.Success),
			Skipped:          int64(state.Skipped),
			Failed:           int64(state.Errors),
			BytesRead:        state.BytesRead,
			SourceBytesTotal: state.TotalBytes,
			ByteProgressKind: "rawSource",
			Checkpoint: importjob.Checkpoint{
				Safe:       state.CheckpointSafe,
				SourceRow:  int64(state.Current),
				ByteOffset: state.BytesRead,
			},
			ForcePersist: state.CheckpointSafe,
		})
		if jobPersistErr != nil {
			importCancel()
		}
	})
	batchConsumer.SetContext(importCtx)
	batchConsumer.jobID = jobID
	if recovery != nil {
		batchConsumer.SetInitialProgress(
			int(recovery.ParentJob.Checkpoint.SourceRow),
			int(recovery.ParentJob.Succeeded),
			int(recovery.ParentJob.Skipped),
			int(recovery.ParentJob.Failed),
		)
	}
	if managedArtifact != nil {
		batchConsumer.SetRowErrorHandler(managedArtifact.append)
	}
	mappedConsumer, err := newImportColumnMappingConsumer(batchConsumer, options.ColumnMappings, targetColumns)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	var consumer importFileConsumer = mappedConsumer
	if recovery != nil {
		consumer = newImportResumeSkippingConsumer(consumer, recovery.ParentJob.Checkpoint.SourceRow)
	}
	finishArtifact := func(resultData *importExecutionResult) error {
		if managedArtifact == nil {
			return nil
		}
		return managedArtifact.finish(resultData)
	}
	if err := streamImportFileWithOptionsContext(importCtx, filePath, consumer, options); err != nil {
		resultData := batchConsumer.Result()
		if jobPersistErr != nil {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				jobPersistErr = errors.Join(jobPersistErr, artifactErr)
			}
			message := a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()})
			return connection.QueryResult{
				Success: false,
				Data:    buildImportExecutionPayload(resultData, message, false),
				Message: message,
			}
		}
		if errors.Is(err, context.Canceled) {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
			}
			maybeReleaseFileTransferMemory("import-cancelled", int64(resultData.Success+resultData.Failed), filePath)
			return a.cancelledImportResult(resultData)
		}
		if !errors.Is(err, errImportStoppedOnError) && managedArtifact != nil {
			managedArtifact.append(ImportRowError{
				SourceRow: int64(resultData.Total + 1),
				Category:  "parse",
				Message:   err.Error(),
			})
		}
		if artifactErr := finishArtifact(&resultData); artifactErr != nil {
			return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
		}
		maybeReleaseFileTransferMemory("import-stream-error", int64(resultData.Total), filePath)
		if errors.Is(err, errImportStoppedOnError) {
			return a.stoppedImportResult(resultData, err.Error())
		}
		return connection.QueryResult{
			Success: false,
			Data:    buildImportExecutionPayload(resultData, err.Error(), false),
			Message: err.Error(),
		}
	}
	if err := batchConsumer.Flush(); err != nil {
		resultData := batchConsumer.Result()
		if jobPersistErr != nil {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				jobPersistErr = errors.Join(jobPersistErr, artifactErr)
			}
			message := a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()})
			return connection.QueryResult{
				Success: false,
				Data:    buildImportExecutionPayload(resultData, message, false),
				Message: message,
			}
		}
		if errors.Is(err, context.Canceled) {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
			}
			maybeReleaseFileTransferMemory("import-cancelled", int64(resultData.Success+resultData.Failed), filePath)
			return a.cancelledImportResult(resultData)
		}
		if artifactErr := finishArtifact(&resultData); artifactErr != nil {
			return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
		}
		maybeReleaseFileTransferMemory("import-flush-error", int64(resultData.Total), filePath)
		if errors.Is(err, errImportStoppedOnError) {
			return a.stoppedImportResult(resultData, err.Error())
		}
		return connection.QueryResult{
			Success: false,
			Data:    buildImportExecutionPayload(resultData, err.Error(), false),
			Message: err.Error(),
		}
	}

	resultData := batchConsumer.Result()
	if artifactErr := finishArtifact(&resultData); artifactErr != nil {
		return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
	}
	if resultData.Total == 0 {
		maybeReleaseFileTransferMemory("import-empty", 0, filePath)
		return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.import_no_data", nil)}
	}

	summary := a.appText("file.backend.message.import_summary", map[string]any{
		"imported": resultData.Success,
		"skipped":  resultData.Skipped,
		"failed":   resultData.Failed,
	})
	resultPayload := buildImportExecutionPayload(resultData, summary, false)

	maybeReleaseFileTransferMemory("import-finished", int64(resultData.Total), filePath)
	return connection.QueryResult{Success: true, Data: resultPayload, Message: summary}
}

func (a *App) importTargetColumnsContext(
	ctx context.Context,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName, tableName string,
) ([]connection.ColumnDefinition, error) {
	// A second connection to :memory: is a different SQLite or DuckDB database.
	// Prefer a same-instance Context API for file-local engines so cancellation
	// does not regress their in-memory import path. Other databases retain the
	// isolated metadata session, which avoids binding request Context to a shared
	// cached driver instance.
	dbType := resolveDDLDBType(config)
	if dbType == "sqlite" || dbType == "duckdb" {
		if getter, ok := dbInst.(db.ColumnDefinitionContexter); ok {
			schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
			return getter.GetColumnsContext(ctx, schemaName, pureTableName)
		}
	}
	metadataResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		return session.DBGetColumns(config, dbName, tableName)
	})
	if !metadataResult.Success {
		return nil, errors.New(metadataResult.Message)
	}
	targetColumns, _ := metadataResult.Data.([]connection.ColumnDefinition)
	return targetColumns, nil
}

func (a *App) ApplyChanges(config connection.ConnectionConfig, dbName, tableName string, changes connection.ChangeSet) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("APPLY CHANGES TO %s", strings.TrimSpace(tableName))
	defer a.beginSQLAuditUserAction(config, dbName, "data_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsDataEdit(config, "connection.backend.action.apply_result_changes"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if applier, ok := dbInst.(db.BatchApplier); ok {
		targetTableName := resolveChangeTargetTableName(config, dbName, tableName)
		preview := buildChangePreview(dbInst, config, targetTableName, changes)
		err := applier.ApplyChanges(targetTableName, changes)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error(), Data: preview}
		}
		return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.transaction_committed", nil), Data: preview}
	}

	return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.batch_commit_unsupported", nil)}
}

// ChangePreview 变更预览结果
type ChangePreview struct {
	Deletes []string `json:"deletes"`
	Updates []string `json:"updates"`
	Inserts []string `json:"inserts"`
}

func resolveChangeTargetTableName(config connection.ConnectionConfig, dbName, tableName string) string {
	targetTableName := strings.TrimSpace(tableName)
	dbType := resolveDDLDBType(config)
	if dbType == "dameng" {
		schemaName, pureTableName := splitDamengChangeTarget(dbName, targetTableName)
		if strings.TrimSpace(pureTableName) == "" {
			return targetTableName
		}
		if strings.TrimSpace(schemaName) == "" {
			return quoteIdentByType(dbType, pureTableName)
		}
		return quoteIdentByType(dbType, schemaName) + "." + quoteIdentByType(dbType, pureTableName)
	}
	if dbType != "oracle" {
		return targetTableName
	}

	schemaName, pureTableName := normalizeSchemaAndTableByType(dbType, dbName, targetTableName)
	if strings.TrimSpace(schemaName) == "" || strings.TrimSpace(pureTableName) == "" {
		return targetTableName
	}
	return strings.TrimSpace(schemaName) + "." + strings.TrimSpace(pureTableName)
}

func splitDamengChangeTarget(dbName, tableName string) (string, string) {
	schemaName := strings.TrimSpace(dbName)
	targetTableName := strings.TrimSpace(tableName)
	if targetTableName == "" {
		return schemaName, ""
	}

	// GetTables historically returns OWNER.TABLE_NAME without quoting. The
	// selected dbName is the authoritative boundary when OWNER itself has dots.
	if schemaName != "" && len(targetTableName) > len(schemaName) &&
		strings.EqualFold(targetTableName[:len(schemaName)], schemaName) &&
		targetTableName[len(schemaName)] == '.' {
		pureTableName := strings.TrimSpace(targetTableName[len(schemaName)+1:])
		if parsedSchema, parsedTable := db.SplitSQLQualifiedNameForDialect(pureTableName, "dameng"); parsedSchema == "" && parsedTable != "" {
			pureTableName = parsedTable
		}
		return schemaName, pureTableName
	}

	parsedSchema, parsedTable := db.SplitSQLQualifiedNameForDialect(targetTableName, "dameng")
	if parsedTable == "" {
		return schemaName, targetTableName
	}
	if parsedSchema != "" {
		return parsedSchema, parsedTable
	}
	return schemaName, parsedTable
}

func buildChangePreview(dbInst db.Database, config connection.ConnectionConfig, tableName string, changes connection.ChangeSet) ChangePreview {
	if previewer, ok := dbInst.(db.ChangePreviewer); ok {
		deletes, updates, inserts := previewer.PreviewChanges(tableName, changes)
		return ChangePreview{Deletes: deletes, Updates: updates, Inserts: inserts}
	}

	dbType := resolveDDLDBType(config)
	quoter := func(s string) string { return quoteIdentByType(dbType, s) }
	tableQuoter := func(s string) string { return quoteQualifiedIdentByType(dbType, s) }
	deletes, updates, inserts := db.GenerateChangePreviewWithDialect(tableName, changes, dbType, quoter, tableQuoter)
	return ChangePreview{Deletes: deletes, Updates: updates, Inserts: inserts}
}

func (a *App) PreviewChanges(config connection.ConnectionConfig, dbName, tableName string, changes connection.ChangeSet) connection.QueryResult {
	if err := ensureConnectionAllowsDataEdit(config, "connection.backend.action.preview_result_changes"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	targetTableName := resolveChangeTargetTableName(config, dbName, tableName)
	return connection.QueryResult{Success: true, Data: buildChangePreview(dbInst, config, targetTableName, changes)}
}

func (a *App) ExportTable(config connection.ConnectionConfig, dbName string, tableName string, format string) connection.QueryResult {
	return a.ExportTableWithOptions(config, dbName, tableName, ExportFileOptions{Format: format})
}

func buildExportTableSelectQuery(dbType string, tableName string, columns []string) string {
	selectList := "*"
	if len(columns) > 0 {
		quotedColumns := make([]string, len(columns))
		for index, column := range columns {
			quotedColumns[index] = quoteIdentByType(dbType, column)
		}
		selectList = strings.Join(quotedColumns, ", ")
	}
	return fmt.Sprintf("SELECT %s FROM %s", selectList, quoteQualifiedIdentByType(dbType, tableName))
}

// closeExportFile 在导出成功路径上显式关闭文件并把 Close 错误返回给调用方。
// 写路径上 Close 的错误意味着数据未真正落盘：网络盘回写缓存与磁盘配额耗尽常常直到 close(2)
// 才报 ENOSPC/EIO，此时 Write 已经返回成功。若像读路径那样用 defer 丢弃，用户会拿到被截断的
// 文件却收到“导出成功”，等于静默数据丢失。调用方仍应保留 defer 兜底关闭以覆盖错误路径。
func closeExportFile(f io.Closer) error {
	return f.Close()
}

func (a *App) ExportTableWithOptions(config connection.ConnectionConfig, dbName string, tableName string, options ExportFileOptions) (result connection.QueryResult) {
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	format := options.Format
	if format != "sql" {
		if err := verifyOptionalDriverAgentReadyForExport(config); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	defaultFilename := fmt.Sprintf("%s.%s", tableName, format)
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(fmt.Sprintf("%s.%s", sanitizeExportFileStem(tableName), format), webDownloadMIMEForFormat(format))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_table", map[string]any{"table": tableName}),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters(format),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, format)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, tableName, reporterPath)
	reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if format != "sql" && !options.TotalRowsKnown {
		if totalRows, ok := tryResolveExportTableTotalRows(dbInst, runConfig, tableName); ok {
			options.TotalRowsHint = totalRows
			options.TotalRowsKnown = true
			if reporter != nil {
				reporter.totalRows = totalRows
				reporter.totalRowsKnown = true
				reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
			}
		}
	}

	if format == "sql" {
		reporter.Start(a.appText("data_export.progress.stage.exporting_sql_file", nil))
		target, err := createAtomicExportTarget(filename, webDownloadBudgetForTarget(webTarget))
		if err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer target.abort()

		w := bufio.NewWriterSize(target.file, 1024*1024)

		if err := writeSQLHeader(w, runConfig, dbName); err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
		if err := writeSQLDropIfExistsPreamble(
			w,
			runConfig,
			dbName,
			[]string{tableName},
			viewLookup,
			true,
			options,
		); err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, tableName, true, true, viewLookup); err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		if err := writeSQLFooter(w, runConfig); err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}

		reporter.Finalizing(0)
		if err := w.Flush(); err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		if err := target.commit(); err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		reporter.Done(0)
		maybeReleaseFileTransferMemory("export-table-sql-finished", 0, filename)
		return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
	}

	dbType := resolveDDLDBType(config)
	query := buildExportTableSelectQuery(dbType, tableName, options.Columns)

	f, err := openExportFileForTarget(webTarget, filename)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() { _ = f.Close() }()
	rowCount, _, err := exportQueryResultToFile(f, dbInst, runConfig, query, options, reporter)
	if err != nil {
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(rowCount, errMsg)
		maybeReleaseFileTransferMemory("export-table-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}
	if err := closeExportFile(f); err != nil {
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(rowCount, errMsg)
		maybeReleaseFileTransferMemory("export-table-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}
	reporter.Done(rowCount)
	maybeReleaseFileTransferMemory("export-table-finished", rowCount, filename)

	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

func (a *App) ExportTablesSQL(config connection.ConnectionConfig, dbName string, tableNames []string, includeData bool) connection.QueryResult {
	return a.ExportTablesSQLWithOptions(config, dbName, tableNames, true, includeData, ExportFileOptions{Format: "sql"})
}

func (a *App) ExportTablesDataSQL(config connection.ConnectionConfig, dbName string, tableNames []string) connection.QueryResult {
	return a.ExportTablesSQLWithOptions(config, dbName, tableNames, false, true, ExportFileOptions{Format: "sql"})
}

func (a *App) ExportTablesSQLWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	tableNames []string,
	includeSchema bool,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	if !includeSchema && !includeData {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.invalid_export_mode", nil)}
	}

	objects := normalizeExportNameList(tableNames)
	options = normalizeExportFileOptions("sql", options)
	options.TotalRowsHint = int64(len(objects))
	options.TotalRowsKnown = true

	defaultFilename := buildTablesExportDefaultFilename(dbName, objects, includeSchema, includeData)
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(defaultFilename, webDownloadMIMEForFormat("sql"))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_tables_sql", nil),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters("sql"),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, "sql")
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, resolveBatchObjectsTargetNameWithText(dbName, objects, a.appText), reporterPath)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_batch_tables_export", nil))
	}
	return a.exportTablesSQLToFile(config, dbName, objects, includeSchema, includeData, filename, reporter, options, webDownloadBudgetForTarget(webTarget))
}

func (a *App) exportTablesSQL(config connection.ConnectionConfig, dbName string, tableNames []string, includeSchema bool, includeData bool) connection.QueryResult {
	if !includeSchema && !includeData {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.invalid_export_mode", nil)}
	}
	objects := normalizeExportNameList(tableNames)

	filename, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("file.backend.dialog.export_tables_sql", nil),
		DefaultFilename: buildTablesExportDefaultFilename(dbName, objects, includeSchema, includeData),
		Filters:         exportFileDialogFilters("sql"),
	})
	if err != nil || strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	filename, err = a.resolveExportDialogTargetPath(filename, "sql")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return a.exportTablesSQLToFile(
		config,
		dbName,
		objects,
		includeSchema,
		includeData,
		filename,
		nil,
		ExportFileOptions{Format: "sql"},
		nil,
	)
}

type atomicExportFile interface {
	io.Writer
	io.Closer
	Sync() error
}

type atomicExportTarget struct {
	file       atomicExportFile
	tempPath   string
	targetPath string
	closed     bool
	committed  bool
}

func createAtomicExportTarget(targetPath string, budgets ...*webTransferBudget) (*atomicExportTarget, error) {
	temporary, err := os.CreateTemp(filepath.Dir(targetPath), ".gonavi-export-*.part")
	if err != nil {
		return nil, err
	}
	var file atomicExportFile = temporary
	if len(budgets) > 0 && budgets[0] != nil {
		file, err = newWebTransferFile(temporary, budgets[0])
		if err != nil {
			_ = temporary.Close()
			_ = os.Remove(temporary.Name())
			return nil, err
		}
	}
	return &atomicExportTarget{
		file:       file,
		tempPath:   temporary.Name(),
		targetPath: targetPath,
	}, nil
}

func (target *atomicExportTarget) abort() {
	if target == nil {
		return
	}
	if !target.closed {
		_ = target.file.Close()
		target.closed = true
	}
	if !target.committed {
		_ = os.Remove(target.tempPath)
	}
}

func (target *atomicExportTarget) commit() error {
	if target == nil || target.file == nil {
		return errors.New("invalid atomic export target")
	}
	if err := target.file.Sync(); err != nil {
		return err
	}
	closeErr := target.file.Close()
	target.closed = true
	if closeErr != nil {
		return closeErr
	}
	if err := atomicReplaceSQLAuditFile(target.tempPath, target.targetPath); err != nil {
		return err
	}
	target.committed = true
	return nil
}

func (a *App) exportTablesSQLToFile(
	config connection.ConnectionConfig,
	dbName string,
	tableNames []string,
	includeSchema bool,
	includeData bool,
	filename string,
	reporter *exportProgressReporter,
	options ExportFileOptions,
	budget *webTransferBudget,
) connection.QueryResult {
	if !includeSchema && !includeData {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.invalid_export_mode", nil)}
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
	objects := buildExportObjectOrder(runConfig, dbName, normalizeExportNameList(tableNames), viewLookup, false)

	target, err := createAtomicExportTarget(filename, budget)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer target.abort()

	w := bufio.NewWriterSize(target.file, 1024*1024)

	if err := writeSQLHeader(w, runConfig, dbName); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLDropIfExistsPreamble(
		w,
		runConfig,
		dbName,
		objects,
		viewLookup,
		includeSchema,
		options,
	); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index, objectName := range objects {
		if reporter != nil {
			reporter.ForceRunning(int64(index), a.appText("data_export.progress.stage.exporting_item_with_progress", map[string]any{
				"name":    objectName,
				"current": index + 1,
				"total":   len(objects),
			}))
		}
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, objectName, includeSchema, includeData, viewLookup); err != nil {
			if reporter != nil {
				reporter.Error(int64(index), err.Error())
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if err := writeSQLFooter(w, runConfig); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if reporter != nil {
		reporter.Finalizing(int64(len(objects)))
	}
	if err := w.Flush(); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := target.commit(); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if reporter != nil {
		reporter.Done(int64(len(objects)))
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data: map[string]interface{}{
			"filePath":    filename,
			"objectCount": len(objects),
		},
	}
}

func (a *App) ExportDatabaseSQL(config connection.ConnectionConfig, dbName string, includeData bool) connection.QueryResult {
	return a.ExportDatabaseSQLWithOptions(config, dbName, includeData, ExportFileOptions{
		Format:                 "sql",
		IncludeDatabaseContext: true,
	})
}

func (a *App) ExportDatabaseSQLWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.database_name_required", nil)}
	}
	options = normalizeExportFileOptions("sql", options)

	defaultFilename := buildDatabaseExportDefaultFilename(safeDbName, includeData)
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(defaultFilename, webDownloadMIMEForFormat("sql"))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_database_sql", map[string]any{"database": safeDbName}),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters("sql"),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, "sql")
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	return a.exportDatabaseSQLToFile(config, safeDbName, includeData, filename, options, webDownloadBudgetForTarget(webTarget))
}

func (a *App) ExportDatabasesSQLWithOptions(
	config connection.ConnectionConfig,
	dbNames []string,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	normalizedDbNames := normalizeExportNameList(dbNames)
	if len(normalizedDbNames) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("sidebar.message.select_database_required", nil)}
	}

	directory := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		archiveMode := "schema"
		if includeData {
			archiveMode = "backup"
		}
		archiveName := fmt.Sprintf("gonavi_%s_%d-databases.zip", archiveMode, len(normalizedDbNames))
		webTarget, err = a.newWebDownloadTarget(archiveName, webDownloadMIMEForFormat("zip"))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		directory = filepath.Join(webTarget.dir, "batch")
		if err := os.MkdirAll(directory, 0o700); err != nil {
			webTarget.abort()
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer func() { result = webTarget.finish(result) }()
		defer func() {
			if cleanupErr := os.RemoveAll(directory); cleanupErr != nil && result.Success {
				result = connection.QueryResult{Success: false, Message: cleanupErr.Error()}
			}
		}()
	} else {
		directory, err = runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
			Title:            a.appText("file.backend.dialog.select_batch_export_directory", nil),
			DefaultDirectory: normalizeDirectoryDialogPath(""),
		})
		if err != nil || strings.TrimSpace(directory) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
	}

	options = normalizeExportFileOptions("sql", options)
	options.TotalRowsHint = int64(len(normalizedDbNames))
	options.TotalRowsKnown = true
	reporterPath := directory
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, a.appText("data_export.workbench.target.batch_databases", map[string]any{"count": len(normalizedDbNames)}), reporterPath)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_batch_databases_export", nil))
	}

	entries := make([]webDownloadZipEntry, 0, len(normalizedDbNames))
	for index, name := range normalizedDbNames {
		if reporter != nil {
			reporter.ForceRunning(int64(index), a.appText("data_export.progress.stage.exporting_item_with_progress", map[string]any{
				"name":    name,
				"current": index + 1,
				"total":   len(normalizedDbNames),
			}))
		}
		entryName := buildDatabaseExportDefaultFilename(name, includeData)
		if webTarget != nil {
			entryName = fmt.Sprintf("%03d-%s", index+1, entryName)
		}
		targetFile := filepath.Join(directory, entryName)
		innerOptions := options
		innerOptions.JobID = ""
		result := a.exportDatabaseSQLToFile(config, name, includeData, targetFile, innerOptions, webDownloadBudgetForTarget(webTarget))
		if !result.Success {
			displayTarget := targetFile
			if webTarget != nil {
				displayTarget = entryName
			}
			result.Message = fmt.Sprintf("%s: %s", displayTarget, result.Message)
			if reporter != nil {
				reporter.Error(int64(index), result.Message)
			}
			return result
		}
		if webTarget != nil {
			entries = append(entries, webDownloadZipEntry{Name: filepath.Base(targetFile), Path: targetFile})
		}
	}
	if webTarget != nil {
		if err := writeWebDownloadZip(webTarget.path, entries, webTarget.budget); err != nil {
			if reporter != nil {
				reporter.Error(int64(len(normalizedDbNames)), err.Error())
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	if reporter != nil {
		reporter.Finalizing(int64(len(normalizedDbNames)))
		reporter.Done(int64(len(normalizedDbNames)))
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data: map[string]interface{}{
			"directoryPath": directory,
			"fileCount":     len(normalizedDbNames),
		},
	}
}

func (a *App) exportDatabaseSQLToFile(
	config connection.ConnectionConfig,
	dbName string,
	includeData bool,
	filename string,
	options ExportFileOptions,
	budgets ...*webTransferBudget,
) connection.QueryResult {
	var budget *webTransferBudget
	if len(budgets) > 0 {
		budget = budgets[0]
	}
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.database_name_required", nil)}
	}
	reporter := newExportProgressReporter(a, options, safeDbName, filename)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(dbName)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
	objects := buildExportObjectOrder(runConfig, dbName, tables, viewLookup, true)
	if reporter != nil {
		reporter.totalRows = int64(len(objects))
		reporter.totalRowsKnown = true
		reporter.ForceRunning(0, a.appText("data_export.progress.stage.exporting_sql_file", nil))
	}

	target, err := createAtomicExportTarget(filename, budget)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer target.abort()

	w := bufio.NewWriterSize(target.file, 1024*1024)

	if err := writeSQLDatabaseExportHeader(w, runConfig, dbName, options.IncludeDatabaseContext); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLDropIfExistsPreambleWithDatabaseContext(
		w,
		runConfig,
		dbName,
		objects,
		viewLookup,
		true,
		options,
		options.IncludeDatabaseContext,
	); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index, objectName := range objects {
		if reporter != nil {
			reporter.ForceRunning(int64(index), a.appText("data_export.progress.stage.exporting_item_with_progress", map[string]any{
				"name":    objectName,
				"current": index + 1,
				"total":   len(objects),
			}))
		}
		if err := dumpTableSQLWithDatabaseContext(
			w,
			dbInst,
			runConfig,
			dbName,
			objectName,
			true,
			includeData,
			viewLookup,
			options.IncludeDatabaseContext,
		); err != nil {
			if reporter != nil {
				reporter.Error(int64(index), err.Error())
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if err := writeSQLFooter(w, runConfig); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if reporter != nil {
		reporter.Finalizing(int64(len(objects)))
	}
	if err := w.Flush(); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := target.commit(); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if reporter != nil {
		reporter.Done(int64(len(objects)))
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data: map[string]interface{}{
			"filePath": filename,
		},
	}
}

func (a *App) ExportSchemaSQL(config connection.ConnectionConfig, dbName string, schemaName string, includeData bool) connection.QueryResult {
	return a.ExportSchemaSQLWithOptions(config, dbName, schemaName, includeData, ExportFileOptions{Format: "sql"})
}

func (a *App) ExportSchemaSQLWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	schemaName string,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	safeDbName := strings.TrimSpace(dbName)
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeDbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.database_name_required", nil)}
	}
	if safeSchemaName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.schema_name_required", nil)}
	}
	options = normalizeExportFileOptions("sql", options)

	suffix := "schema"
	if includeData {
		suffix = "backup"
	}

	defaultFilename := fmt.Sprintf("%s_%s_%s.sql", safeDbName, safeSchemaName, suffix)
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(
			fmt.Sprintf("%s_%s_%s.sql", sanitizeExportFileStem(safeDbName), sanitizeExportFileStem(safeSchemaName), suffix),
			webDownloadMIMEForFormat("sql"),
		)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_database_sql", map[string]any{"database": safeDbName + "." + safeSchemaName}),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters("sql"),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, "sql")
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, safeDbName+"."+safeSchemaName, reporterPath)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(dbName)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
	filteredTables := filterExportObjectsBySchema(runConfig, dbName, tables, safeSchemaName)
	filteredViews := filterExportViewLookupBySchema(runConfig, dbName, viewLookup, safeSchemaName)
	objects := buildExportObjectOrder(runConfig, dbName, filteredTables, filteredViews, true)
	if len(objects) == 0 {
		message := a.appText("file.backend.error.schema_export_no_objects", map[string]any{"schema": safeSchemaName})
		if reporter != nil {
			reporter.Error(0, message)
		}
		return connection.QueryResult{Success: false, Message: message}
	}
	if reporter != nil {
		reporter.totalRows = int64(len(objects))
		reporter.totalRowsKnown = true
		reporter.ForceRunning(0, a.appText("data_export.progress.stage.exporting_sql_file", nil))
	}

	target, err := createAtomicExportTarget(filename, webDownloadBudgetForTarget(webTarget))
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer target.abort()

	w := bufio.NewWriterSize(target.file, 1024*1024)

	if err := writeSQLSchemaExportHeader(w, runConfig, dbName, safeSchemaName); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLDropIfExistsPreamble(
		w,
		runConfig,
		dbName,
		objects,
		filteredViews,
		true,
		options,
	); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index, objectName := range objects {
		if reporter != nil {
			reporter.ForceRunning(int64(index), a.appText("data_export.progress.stage.exporting_item_with_progress", map[string]any{
				"name":    objectName,
				"current": index + 1,
				"total":   len(objects),
			}))
		}
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, objectName, true, includeData, filteredViews); err != nil {
			if reporter != nil {
				reporter.Error(int64(index), err.Error())
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if err := writeSQLFooter(w, runConfig); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if reporter != nil {
		reporter.Finalizing(int64(len(objects)))
	}
	if err := w.Flush(); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := target.commit(); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if reporter != nil {
		reporter.Done(int64(len(objects)))
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data: map[string]interface{}{
			"filePath": filename,
		},
	}
}

type tableDataClearMode string

const (
	tableDataClearModeTruncate  tableDataClearMode = "truncate"
	tableDataClearModeDeleteAll tableDataClearMode = "delete_all"
)

func supportsTruncateTableForDBType(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "oceanbase", "starrocks", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "iris", "oracle", "dameng", "clickhouse", "duckdb":
		return true
	default:
		return false
	}
}

func buildTableDataClearSQL(config connection.ConnectionConfig, objectName string, mode tableDataClearMode) (string, error) {
	return buildTableDataClearSQLWithText(config, objectName, mode, nil)
}

func buildTableDataClearSQLWithText(config connection.ConnectionConfig, objectName string, mode tableDataClearMode, text fileBackendTextFunc) (string, error) {
	dbType := resolveDDLDBType(config)
	quotedObject := quoteQualifiedIdentByType(dbType, objectName)

	switch mode {
	case tableDataClearModeTruncate:
		if !supportsTruncateTableForDBType(dbType) {
			return "", errors.New(fileBackendText(text, "file.backend.error.table_data_truncate_unsupported", map[string]any{"type": strings.TrimSpace(dbType)}))
		}
		return fmt.Sprintf("TRUNCATE TABLE %s", quotedObject), nil
	case tableDataClearModeDeleteAll:
		if dbType == "mongodb" {
			return fmt.Sprintf(`{"delete":"%s","deletes":[{"q":{},"limit":0}]}`, objectName), nil
		}
		return fmt.Sprintf("DELETE FROM %s", quotedObject), nil
	default:
		return "", errors.New(fileBackendText(text, "file.backend.error.table_data_mode_unsupported", map[string]any{"mode": string(mode)}))
	}
}

func tableDataClearActionLabels(mode tableDataClearMode) (actionLabel string, progressLabel string) {
	switch mode {
	case tableDataClearModeTruncate:
		return "truncate_table", "truncate"
	default:
		return "clear_table", "clear"
	}
}

func tableDataClearMessageKeys(mode tableDataClearMode, partial bool) (failureKey string, successKey string) {
	switch mode {
	case tableDataClearModeTruncate:
		if partial {
			return "file.backend.error.table_data_truncate_failed_partial", "file.backend.message.table_data_truncate_succeeded"
		}
		return "file.backend.error.table_data_truncate_failed", "file.backend.message.table_data_truncate_succeeded"
	default:
		if partial {
			return "file.backend.error.table_data_clear_failed_partial", "file.backend.message.table_data_clear_succeeded"
		}
		return "file.backend.error.table_data_clear_failed", "file.backend.message.table_data_clear_succeeded"
	}
}

func (a *App) runTableDataClear(config connection.ConnectionConfig, dbName string, tableNames []string, mode tableDataClearMode) (result connection.QueryResult) {
	auditAction := "DELETE TABLE DATA"
	if mode == tableDataClearModeTruncate {
		auditAction = "TRUNCATE TABLE DATA"
	}
	auditSQL := auditAction + " " + strings.Join(tableNames, ", ")
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	actionLabel, progressLabel := tableDataClearActionLabels(mode)
	if err := ensureConnectionAllowsDataEdit(config, actionLabel); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runConfig := normalizeRunConfig(config, dbName)

	// 参数校验
	if len(tableNames) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.table_data_no_tables", nil)}
	}

	objects := make([]string, 0, len(tableNames))
	seen := make(map[string]struct{}, len(tableNames))
	for _, t := range tableNames {
		tt := strings.TrimSpace(t)
		if tt == "" {
			continue
		}
		if _, ok := seen[tt]; ok {
			continue
		}
		seen[tt] = struct{}{}
		objects = append(objects, tt)
	}

	if len(objects) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.table_data_no_tables", nil)}
	}
	const maxBatchSize = 200
	if len(objects) > maxBatchSize {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.table_data_batch_limit", map[string]any{"max": maxBatchSize, "count": len(objects)})}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	logger.Warnf("%s 开始：%s db=%s tables=%v（共 %d 张）", actionLabel, formatConnSummary(runConfig), dbName, objects, len(objects))

	var executedSQLs []string
	for i, objectName := range objects {
		sql, sqlErr := buildTableDataClearSQLWithText(runConfig, objectName, mode, a.appText)
		if sqlErr != nil {
			return connection.QueryResult{
				Success: false,
				Message: sqlErr.Error(),
				Data: map[string]interface{}{
					"executedSQLs": executedSQLs,
					"count":        len(executedSQLs),
				},
			}
		}

		if _, err := dbInst.Exec(sql); err != nil {
			logger.Warnf("%s 第 %d/%d 张表失败：%s table=%s err=%v（已成功%s %d 张）", actionLabel, i+1, len(objects), formatConnSummary(runConfig), objectName, err, progressLabel, len(executedSQLs))
			failureKey, _ := tableDataClearMessageKeys(mode, len(executedSQLs) > 0)
			errMsg := a.appText(failureKey, map[string]any{"table": objectName, "detail": err.Error(), "count": len(executedSQLs)})
			return connection.QueryResult{
				Success: false,
				Message: errMsg,
				Data: map[string]interface{}{
					"executedSQLs": executedSQLs,
					"count":        len(executedSQLs),
				},
			}
		}
		executedSQLs = append(executedSQLs, sql)
	}

	logger.Warnf("%s 完成：%s db=%s 共%s %d 张表", actionLabel, formatConnSummary(runConfig), dbName, progressLabel, len(executedSQLs))

	_, successKey := tableDataClearMessageKeys(mode, false)
	return connection.QueryResult{
		Success: true,
		Message: a.appText(successKey, nil),
		Data: map[string]interface{}{
			"executedSQLs": executedSQLs,
			"count":        len(executedSQLs),
		},
	}
}

// TruncateTables 截断指定表的数据；仅在明确支持 TRUNCATE TABLE 的数据库类型上执行。
func (a *App) TruncateTables(config connection.ConnectionConfig, dbName string, tableNames []string) connection.QueryResult {
	return a.runTableDataClear(config, dbName, tableNames, tableDataClearModeTruncate)
}

// ClearTables 清空指定表的数据；关系型数据库使用 DELETE FROM，MongoDB 使用 delete 命令。
func (a *App) ClearTables(config connection.ConnectionConfig, dbName string, tableNames []string) connection.QueryResult {
	return a.runTableDataClear(config, dbName, tableNames, tableDataClearModeDeleteAll)
}

func quoteIdentByType(dbType string, ident string) string {
	if strings.TrimSpace(ident) == "" {
		return ""
	}

	dbType = resolveDDLDBType(connection.ConnectionConfig{Type: dbType})
	if segments := db.SplitSQLIdentifierPathForDialect(ident, dbType); len(segments) == 1 && segments[0].Quoted {
		ident = segments[0].Value
	}

	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "tdengine", "clickhouse":
		return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
	case "kingbase":
		return db.QuoteKingbaseIdentifier(ident)
	case "sqlserver":
		escaped := strings.ReplaceAll(ident, "]", "]]")
		return "[" + escaped + "]"
	default:
		return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
	}
}

func quoteQualifiedIdentByType(dbType string, ident string) string {
	raw := strings.TrimSpace(ident)
	if raw == "" {
		return raw
	}

	dbType = resolveDDLDBType(connection.ConnectionConfig{Type: dbType})
	if dbType == "trino" {
		segments := db.SplitSQLIdentifierPathForDialect(raw, dbType)
		parts := make([]string, 0, len(segments))
		for _, segment := range segments {
			parts = append(parts, segment.Value)
		}
		switch {
		case len(parts) >= 3:
			catalog := strings.TrimSpace(parts[0])
			schema := strings.TrimSpace(parts[1])
			table := strings.TrimSpace(strings.Join(parts[2:], "."))
			if catalog != "" && schema != "" && table != "" {
				return quoteIdentByType(dbType, catalog) + "." + quoteIdentByType(dbType, schema) + "." + quoteIdentByType(dbType, table)
			}
		case len(parts) <= 2:
			return quoteIdentByType(dbType, raw)
		}
	}
	if dbType == "kingbase" {
		schema, table := db.SplitKingbaseQualifiedName(raw)
		if table == "" {
			return quoteIdentByType(dbType, raw)
		}
		if schema == "" {
			return quoteIdentByType(dbType, table)
		}
		return quoteIdentByType(dbType, schema) + "." + quoteIdentByType(dbType, table)
	}
	if dbType == "dameng" {
		schema, table := db.SplitSQLQualifiedNameForDialect(raw, dbType)
		if table == "" {
			return quoteIdentByType(dbType, raw)
		}
		if schema == "" {
			return quoteIdentByType(dbType, table)
		}
		return quoteIdentByType(dbType, schema) + "." + quoteIdentByType(dbType, table)
	}

	segments := db.SplitSQLIdentifierPathForDialect(raw, dbType)
	if len(segments) <= 1 {
		return quoteIdentByType(dbType, raw)
	}

	quotedParts := make([]string, 0, len(segments))
	for _, segment := range segments {
		part := strings.TrimSpace(segment.Value)
		if part == "" {
			continue
		}
		quotedParts = append(quotedParts, quoteIdentByType(dbType, part))
	}

	if len(quotedParts) == 0 {
		return quoteIdentByType(dbType, raw)
	}
	return strings.Join(quotedParts, ".")
}

func writeSQLHeader(w *bufio.Writer, config connection.ConnectionConfig, dbName string) error {
	return writeSQLHeaderWithDatabaseBootstrap(w, config, dbName, true, false)
}

func writeSQLSchemaExportHeader(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	schemaName string,
) error {
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeSchemaName == "" {
		return errors.New("schema name is required")
	}
	if err := writeSQLHeader(w, config, dbName); err != nil {
		return err
	}
	if _, err := w.WriteString(fmt.Sprintf("-- Schema: %s\n\n", safeSchemaName)); err != nil {
		return err
	}
	dbType := resolveDDLDBType(config)
	if isPostgresSchemaDDLDBType(dbType) {
		_, err := w.WriteString(fmt.Sprintf(
			"CREATE SCHEMA IF NOT EXISTS %s;\n\n",
			quoteIdentByType(dbType, safeSchemaName),
		))
		return err
	}
	return nil
}

func writeSQLDatabaseBackupHeader(w *bufio.Writer, config connection.ConnectionConfig, dbName string) error {
	return writeSQLHeaderWithDatabaseBootstrap(w, config, dbName, true, true)
}

func writeSQLDatabaseExportHeader(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	includeDatabaseContext bool,
) error {
	return writeSQLHeaderWithDatabaseBootstrap(
		w,
		config,
		dbName,
		includeDatabaseContext,
		includeDatabaseContext,
	)
}

func writeSQLHeaderWithDatabaseBootstrap(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	includeDatabaseContext bool,
	createDatabase bool,
) error {
	now := time.Now().Format("2006-01-02 15:04:05")
	if _, err := w.WriteString(fmt.Sprintf("-- GoNavi SQL Export\n-- Time: %s\n", now)); err != nil {
		return err
	}
	if strings.TrimSpace(dbName) != "" {
		if _, err := w.WriteString(fmt.Sprintf("-- Database: %s\n\n", dbName)); err != nil {
			return err
		}
	}

	if supportsMySQLDatabaseContext(config) && strings.TrimSpace(dbName) != "" {
		if includeDatabaseContext && createDatabase {
			if _, err := w.WriteString(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s;\n\n", quoteIdentByType("mysql", dbName))); err != nil {
				return err
			}
		}
		if includeDatabaseContext {
			if _, err := w.WriteString(fmt.Sprintf("USE %s;\n\n", quoteIdentByType("mysql", dbName))); err != nil {
				return err
			}
		}
		if _, err := w.WriteString("SET FOREIGN_KEY_CHECKS=0;\n\n"); err != nil {
			return err
		}
	}

	return nil
}

func supportsMySQLDatabaseContext(config connection.ConnectionConfig) bool {
	return strings.EqualFold(strings.TrimSpace(config.Type), "mysql")
}

func writeSQLFooter(w *bufio.Writer, config connection.ConnectionConfig) error {
	if strings.ToLower(strings.TrimSpace(config.Type)) == "mysql" {
		if _, err := w.WriteString("\nSET FOREIGN_KEY_CHECKS=1;\n"); err != nil {
			return err
		}
	}
	return nil
}

func buildSQLDropIfExistsStatement(
	config connection.ConnectionConfig,
	dbName string,
	objectName string,
	isView bool,
) string {
	return buildSQLDropIfExistsStatementWithDatabaseContext(config, dbName, objectName, isView, true)
}

func buildSQLDropIfExistsStatementWithDatabaseContext(
	config connection.ConnectionConfig,
	dbName string,
	objectName string,
	isView bool,
	includeDatabaseContext bool,
) string {
	dbType := resolveDDLDBType(config)
	schemaName, pureObjectName := normalizeSchemaAndTableByType(dbType, dbName, objectName)
	if strings.TrimSpace(pureObjectName) == "" {
		return ""
	}

	objectType := "TABLE"
	// ClickHouse exposes views (including materialized views) through the table
	// namespace and removes them with DROP TABLE.
	if isView && dbType != "clickhouse" {
		objectType = "VIEW"
	}
	qualifiedObject := quoteTableIdentByType(dbType, schemaName, pureObjectName)
	if supportsMySQLDatabaseContext(config) && !includeDatabaseContext {
		qualifiedObject = quoteIdentByType(dbType, pureObjectName)
	}
	if strings.TrimSpace(qualifiedObject) == "" {
		return ""
	}

	// Not every supported Oracle version has native DROP ... IF EXISTS.
	// Use a PL/SQL guard so exported SQL remains backward compatible.
	if dbType == "oracle" {
		dropSQL := fmt.Sprintf("DROP %s %s", objectType, qualifiedObject)
		return fmt.Sprintf(
			"BEGIN\n  EXECUTE IMMEDIATE '%s';\nEXCEPTION\n  WHEN OTHERS THEN\n    IF SQLCODE != -942 THEN\n      RAISE;\n    END IF;\nEND;\n/",
			escapeSQLLiteral(dropSQL),
		)
	}

	return fmt.Sprintf("DROP %s IF EXISTS %s;", objectType, qualifiedObject)
}

func writeSQLDropIfExistsPreamble(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	objects []string,
	viewLookup map[string]string,
	includeSchema bool,
	options ExportFileOptions,
) error {
	return writeSQLDropIfExistsPreambleWithDatabaseContext(
		w,
		config,
		dbName,
		objects,
		viewLookup,
		includeSchema,
		options,
		true,
	)
}

func writeSQLDropIfExistsPreambleWithDatabaseContext(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	objects []string,
	viewLookup map[string]string,
	includeSchema bool,
	options ExportFileOptions,
	includeDatabaseContext bool,
) error {
	if !includeSchema || !options.IncludeDropIfExists || len(objects) == 0 {
		return nil
	}

	wroteStatement := false
	for index := len(objects) - 1; index >= 0; index-- {
		objectName := strings.TrimSpace(objects[index])
		if objectName == "" {
			continue
		}
		objectKey := normalizeExportObjectKey(config, dbName, objectName)
		_, isView := viewLookup[objectKey]
		statement := buildSQLDropIfExistsStatementWithDatabaseContext(
			config,
			dbName,
			objectName,
			isView,
			includeDatabaseContext,
		)
		if statement == "" {
			continue
		}
		if !wroteStatement {
			if _, err := w.WriteString("\n-- Drop existing objects before recreation\n"); err != nil {
				return err
			}
			wroteStatement = true
		}
		if _, err := w.WriteString(statement + "\n"); err != nil {
			return err
		}
	}
	if wroteStatement {
		_, err := w.WriteString("\n")
		return err
	}
	return nil
}

func qualifyTable(schemaName, tableName string) string {
	schemaName = strings.TrimSpace(schemaName)
	tableName = strings.TrimSpace(tableName)
	if schemaName == "" {
		return tableName
	}
	return schemaName + "." + tableName
}

func ensureSQLTerminator(sql string) string {
	trimmed := strings.TrimSpace(sql)
	if trimmed == "" {
		return sql
	}
	if strings.HasSuffix(trimmed, ";") {
		return sql
	}
	return sql + ";"
}

func buildExportObjectOrder(
	config connection.ConnectionConfig,
	dbName string,
	rawObjects []string,
	viewLookup map[string]string,
	includeAllViews bool,
) []string {
	tableSet := make(map[string]string, len(rawObjects))
	viewSet := make(map[string]string, len(rawObjects))

	for _, rawName := range rawObjects {
		objectName := strings.TrimSpace(rawName)
		if objectName == "" {
			continue
		}
		key := normalizeExportObjectKey(config, dbName, objectName)
		if key == "" {
			continue
		}
		if canonicalViewName, ok := viewLookup[key]; ok {
			if strings.TrimSpace(canonicalViewName) == "" {
				canonicalViewName = objectName
			}
			viewSet[key] = canonicalViewName
			delete(tableSet, key)
			continue
		}
		if _, isView := viewSet[key]; isView {
			continue
		}
		if _, exists := tableSet[key]; !exists {
			tableSet[key] = objectName
		}
	}

	if includeAllViews {
		for key, viewName := range viewLookup {
			canonicalViewName := strings.TrimSpace(viewName)
			if canonicalViewName == "" {
				continue
			}
			viewSet[key] = canonicalViewName
			delete(tableSet, key)
		}
	}

	tables := mapValuesSorted(tableSet)
	views := mapValuesSorted(viewSet)
	return append(tables, views...)
}

func filterExportObjectsBySchema(
	config connection.ConnectionConfig,
	dbName string,
	rawObjects []string,
	schemaName string,
) []string {
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeSchemaName == "" {
		return append([]string(nil), rawObjects...)
	}

	filtered := make([]string, 0, len(rawObjects))
	for _, rawName := range rawObjects {
		objectName := strings.TrimSpace(rawName)
		if objectName == "" {
			continue
		}
		objectSchemaName, _ := normalizeSchemaAndTable(config, dbName, objectName)
		if strings.EqualFold(strings.TrimSpace(objectSchemaName), safeSchemaName) {
			filtered = append(filtered, objectName)
		}
	}
	return filtered
}

func filterExportViewLookupBySchema(
	config connection.ConnectionConfig,
	dbName string,
	viewLookup map[string]string,
	schemaName string,
) map[string]string {
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeSchemaName == "" {
		cloned := make(map[string]string, len(viewLookup))
		for key, value := range viewLookup {
			cloned[key] = value
		}
		return cloned
	}

	filtered := make(map[string]string, len(viewLookup))
	for key, objectName := range viewLookup {
		objectSchemaName, _ := normalizeSchemaAndTable(config, dbName, objectName)
		if strings.EqualFold(strings.TrimSpace(objectSchemaName), safeSchemaName) {
			filtered[key] = objectName
		}
	}
	return filtered
}

func mapValuesSorted(values map[string]string) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func normalizeExportObjectKey(config connection.ConnectionConfig, dbName string, objectName string) string {
	schemaName, pureName := normalizeSchemaAndTable(config, dbName, objectName)
	return normalizeExportObjectKeyByParts(schemaName, pureName)
}

func normalizeExportObjectKeyByParts(schemaName, objectName string) string {
	return strings.ToLower(strings.TrimSpace(qualifyTable(schemaName, objectName)))
}

func listViewNameLookup(dbInst db.Database, config connection.ConnectionConfig, dbName string) map[string]string {
	viewLookup, _ := listViewNameLookupWithStatus(dbInst, config, dbName)
	return viewLookup
}

func listViewNameLookupWithStatus(dbInst db.Database, config connection.ConnectionConfig, dbName string) (map[string]string, error) {
	viewLookup := make(map[string]string)
	var firstErr error
	querySucceeded := false
	queries := buildListViewQueries(config, dbName)
	for _, query := range queries {
		if strings.TrimSpace(query) == "" {
			continue
		}
		rows, _, err := queryDataForExport(dbInst, config, query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		querySucceeded = true
		for _, row := range rows {
			tableType := strings.ToUpper(exportRowValueCI(row, "table_type", "type"))
			if tableType != "" && tableType != "VIEW" {
				continue
			}
			schemaName := exportRowValueCI(row, "schema_name", "table_schema", "owner", "schema", "db")
			viewName := exportRowValueCI(row, "object_name", "view_name", "table_name", "name")
			if viewName == "" {
				viewName = exportInferObjectName(row)
			}
			if strings.TrimSpace(viewName) == "" {
				continue
			}
			fullName := strings.TrimSpace(qualifyTable(schemaName, viewName))
			if fullName == "" {
				fullName = strings.TrimSpace(viewName)
			}
			key := normalizeExportObjectKey(config, dbName, fullName)
			if key == "" {
				continue
			}
			if _, exists := viewLookup[key]; !exists {
				viewLookup[key] = fullName
			}
		}
	}
	if !querySucceeded && firstErr != nil {
		return viewLookup, firstErr
	}
	return viewLookup, nil
}

func buildListViewQueries(config connection.ConnectionConfig, dbName string) []string {
	dbType := resolveDDLDBType(config)
	escapedDbName := escapeSQLLiteral(dbName)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		queries := []string{
			fmt.Sprintf(`SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, TABLE_TYPE AS table_type FROM information_schema.tables WHERE TABLE_TYPE='VIEW' AND %s ORDER BY TABLE_NAME`, mysqlMetadataSchemaPredicate("TABLE_SCHEMA", dbName)),
		}
		if strings.TrimSpace(dbName) != "" {
			queries = append(queries, fmt.Sprintf("SHOW FULL TABLES FROM %s WHERE Table_type = 'VIEW'", quoteIdentByType("mysql", dbName)))
		} else {
			queries = append(queries, "SHOW FULL TABLES WHERE Table_type = 'VIEW'")
		}
		return queries
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return []string{
			`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name`,
		}
	case "sqlserver":
		safeDBName := strings.TrimSpace(config.Database)
		if safeDBName == "" {
			safeDBName = strings.TrimSpace(dbName)
		}
		if safeDBName == "" {
			return nil
		}
		safeDB := quoteIdentByType("sqlserver", safeDBName)
		return []string{
			fmt.Sprintf(`SELECT s.name AS schema_name, v.name AS object_name FROM %s.sys.views v JOIN %s.sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name`, safeDB, safeDB),
		}
	case "oracle", "dameng":
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT VIEW_NAME AS object_name FROM user_views ORDER BY VIEW_NAME`,
			}
		}
		return []string{
			fmt.Sprintf("SELECT OWNER AS schema_name, VIEW_NAME AS object_name FROM all_views WHERE OWNER = '%s' ORDER BY VIEW_NAME", strings.ToUpper(escapedDbName)),
		}
	case "sqlite":
		return []string{
			"SELECT name AS object_name FROM sqlite_master WHERE type='view' ORDER BY name",
		}
	case "duckdb":
		return []string{
			`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name`,
		}
	case "clickhouse":
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT database AS schema_name, name AS object_name FROM system.tables WHERE engine LIKE '%View%' ORDER BY database, name`,
			}
		}
		return []string{
			fmt.Sprintf(`SELECT database AS schema_name, name AS object_name FROM system.tables WHERE engine LIKE '%%View%%' AND database='%s' ORDER BY name`, escapedDbName),
		}
	default:
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views`,
			}
		}
		return []string{
			fmt.Sprintf(`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema='%s'`, escapedDbName),
		}
	}
}

func tryGetViewCreateStatement(
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName string,
	schemaName string,
	viewName string,
) (string, bool) {
	queries := buildViewCreateQueries(config, dbName, schemaName, viewName)
	for _, query := range queries {
		if strings.TrimSpace(query) == "" {
			continue
		}
		rows, _, err := queryDataForViewDDL(dbInst, config, query)
		if err != nil || len(rows) == 0 {
			continue
		}
		createSQL := strings.TrimSpace(extractViewCreateSQL(rows[0]))
		if createSQL == "" {
			continue
		}
		if looksLikeSelectOrWith(createSQL) {
			dbType := resolveDDLDBType(config)
			createSQL = fmt.Sprintf("CREATE VIEW %s AS %s", quoteTableIdentByType(dbType, schemaName, viewName), strings.TrimSuffix(strings.TrimSpace(createSQL), ";"))
		}
		return ensureSQLTerminator(createSQL), true
	}
	return "", false
}

type viewDDLQueryCollector struct {
	columns []string
	rows    []map[string]interface{}
}

func (c *viewDDLQueryCollector) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *viewDDLQueryCollector) ConsumeRow(row map[string]interface{}) error {
	c.rows = append(c.rows, row)
	return nil
}

func queryDataForViewDDL(
	dbInst db.Database,
	config connection.ConnectionConfig,
	query string,
) ([]map[string]interface{}, []string, error) {
	switch resolveDDLDBType(config) {
	case "oracle", "dameng":
		collector := &viewDDLQueryCollector{}
		if err := streamQueryDataForExport(dbInst, config, query, collector); err != nil {
			return nil, nil, err
		}
		return collector.rows, collector.columns, nil
	default:
		return queryDataForExport(dbInst, config, query)
	}
}

func buildViewCreateQueries(config connection.ConnectionConfig, dbName, schemaName, viewName string) []string {
	dbType := resolveDDLDBType(config)
	safeSchema := strings.TrimSpace(schemaName)
	safeView := strings.TrimSpace(viewName)
	if safeView == "" {
		return nil
	}
	escapedSchema := escapeSQLLiteral(safeSchema)
	escapedView := escapeSQLLiteral(safeView)
	escapedDB := escapeSQLLiteral(dbName)

	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SHOW CREATE VIEW %s.%s", quoteIdentByType("mysql", safeSchema), quoteIdentByType("mysql", safeView)),
			}
		}
		return []string{
			fmt.Sprintf("SHOW CREATE VIEW %s", quoteIdentByType("mysql", safeView)),
		}
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		if safeSchema == "" {
			safeSchema = "public"
		}
		regClassName := fmt.Sprintf(`"%s"."%s"`, strings.ReplaceAll(safeSchema, `"`, `""`), strings.ReplaceAll(safeView, `"`, `""`))
		regClassName = strings.ReplaceAll(regClassName, "'", "''")
		return []string{
			fmt.Sprintf("SELECT pg_get_viewdef('%s'::regclass, true) AS ddl", regClassName),
		}
	case "sqlserver":
		schema := safeSchema
		if schema == "" {
			schema = "dbo"
		}
		safeDBName := strings.TrimSpace(dbName)
		if safeDBName == "" {
			safeDBName = strings.TrimSpace(config.Database)
		}
		if safeDBName == "" {
			return nil
		}
		safeDB := quoteIdentByType("sqlserver", safeDBName)
		return []string{
			fmt.Sprintf(`SELECT m.definition AS ddl
FROM %s.sys.views v
JOIN %s.sys.schemas s ON v.schema_id = s.schema_id
JOIN %s.sys.sql_modules m ON v.object_id = m.object_id
WHERE s.name = '%s' AND v.name = '%s'`,
				safeDB, safeDB, safeDB, escapeSQLLiteral(schema), escapedView),
		}
	case "oracle", "dameng":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('VIEW', '%s', '%s') AS ddl FROM DUAL", strings.ToUpper(escapedView), strings.ToUpper(escapeSQLLiteral(safeSchema))),
				fmt.Sprintf("SELECT TEXT AS ddl FROM ALL_VIEWS WHERE OWNER = '%s' AND VIEW_NAME = '%s'", strings.ToUpper(escapeSQLLiteral(safeSchema)), strings.ToUpper(escapedView)),
			}
		}
		return []string{
			fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('VIEW', '%s') AS ddl FROM DUAL", strings.ToUpper(escapedView)),
			fmt.Sprintf("SELECT TEXT AS ddl FROM USER_VIEWS WHERE VIEW_NAME = '%s'", strings.ToUpper(escapedView)),
		}
	case "sqlite":
		return []string{
			fmt.Sprintf("SELECT sql AS ddl FROM sqlite_master WHERE type='view' AND name='%s'", escapedView),
		}
	case "duckdb":
		if safeSchema == "" {
			safeSchema = "main"
			escapedSchema = "main"
		}
		return []string{
			fmt.Sprintf("SELECT sql AS ddl FROM duckdb_views() WHERE view_name = '%s' AND schema_name = '%s' LIMIT 1", escapedView, escapedSchema),
			fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedSchema),
		}
	case "clickhouse":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteIdentByType("clickhouse", safeSchema), quoteIdentByType("clickhouse", safeView)),
			}
		}
		return []string{
			fmt.Sprintf("SHOW CREATE TABLE %s", quoteIdentByType("clickhouse", safeView)),
		}
	default:
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedSchema),
			}
		}
		if strings.TrimSpace(dbName) != "" {
			return []string{
				fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedDB),
			}
		}
		return []string{
			fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' LIMIT 1", escapedView),
		}
	}
}

func extractViewCreateSQL(row map[string]interface{}) string {
	if row == nil {
		return ""
	}
	ddl := exportRowValueCI(row, "create view", "create_statement", "create_sql", "ddl", "sql", "view_definition", "definition")
	if ddl != "" {
		return normalizeMySQLViewCreateSQL(ddl)
	}
	for _, value := range row {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			continue
		}
		lower := strings.ToLower(text)
		if strings.HasPrefix(lower, "create ") || strings.HasPrefix(lower, "select ") || strings.HasPrefix(lower, "with ") {
			return normalizeMySQLViewCreateSQL(text)
		}
	}
	return ""
}

func normalizeMySQLViewCreateSQL(sql string) string {
	trimmed := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(sql), ";"))
	if trimmed == "" {
		return ""
	}
	if mysqlCreateViewPrefixPattern.MatchString(trimmed) {
		return mysqlCreateViewPrefixPattern.ReplaceAllString(trimmed, "CREATE OR REPLACE VIEW ")
	}
	return trimmed
}

func exportRowValueCI(row map[string]interface{}, candidates ...string) string {
	if len(row) == 0 || len(candidates) == 0 {
		return ""
	}
	for _, candidate := range candidates {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		for key, value := range row {
			normalizedKey := strings.ToLower(strings.TrimSpace(key))
			if normalizedKey != candidate {
				continue
			}
			if value == nil {
				return ""
			}
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text == "<nil>" {
				return ""
			}
			return text
		}
	}
	return ""
}

func exportInferObjectName(row map[string]interface{}) string {
	if len(row) == 0 {
		return ""
	}
	for key, value := range row {
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		if normalizedKey == "" {
			continue
		}
		if strings.Contains(normalizedKey, "type") {
			continue
		}
		if strings.Contains(normalizedKey, "table") || strings.Contains(normalizedKey, "view") || strings.Contains(normalizedKey, "name") || strings.Contains(normalizedKey, "ddl") || strings.Contains(normalizedKey, "sql") {
			if value == nil {
				continue
			}
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text == "" || text == "<nil>" {
				continue
			}
			return text
		}
	}
	for _, value := range row {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			continue
		}
		return text
	}
	return ""
}

func trimLeadingSQLComments(sql string) string {
	trimmed := strings.TrimSpace(sql)
	for trimmed != "" {
		switch {
		case strings.HasPrefix(trimmed, "--"):
			if newline := strings.IndexByte(trimmed, '\n'); newline >= 0 {
				trimmed = strings.TrimSpace(trimmed[newline+1:])
				continue
			}
			return ""
		case strings.HasPrefix(trimmed, "#"):
			if newline := strings.IndexByte(trimmed, '\n'); newline >= 0 {
				trimmed = strings.TrimSpace(trimmed[newline+1:])
				continue
			}
			return ""
		case strings.HasPrefix(trimmed, "/*"):
			if end := strings.Index(trimmed, "*/"); end >= 0 {
				trimmed = strings.TrimSpace(trimmed[end+2:])
				continue
			}
			return ""
		}
		break
	}
	return trimmed
}

func looksLikeSelectOrWith(sql string) bool {
	trimmed := trimLeadingSQLComments(strings.TrimSuffix(sql, ";"))
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	return hasLeadingReadonlySQLKeyword(lower, "select") || hasLeadingReadonlySQLKeyword(lower, "with")
}

func hasLeadingReadonlySQLKeyword(sql string, keyword string) bool {
	if sql == keyword {
		return true
	}
	if !strings.HasPrefix(sql, keyword) {
		return false
	}
	if len(sql) <= len(keyword) {
		return true
	}
	return unicode.IsSpace(rune(sql[len(keyword)]))
}

func escapeSQLLiteral(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "'", "''")
}

// dialectEscapesBackslashInStringLiteral 判断方言是否把反斜杠当作字符串字面量里的转义符。
//
// 命中的方言必须在生成字面量时把反斜杠翻倍，否则还原时 \n \t \0 会被解释成控制字符
// （静默改写数据），且以反斜杠结尾的值会吞掉闭合单引号，让后续文本越出字面量。
//   - MySQL 协议系（mysql/mariadb/tidb/oceanbase/doris/starrocks）：默认 sql_mode 不含
//     NO_BACKSLASH_ESCAPES，反斜杠为转义符。
//   - ClickHouse 与 TDengine：字面量同样支持 C 风格反斜杠转义。
//
// 不命中的方言（postgres 系在 standard_conforming_strings=on 下、oracle、sqlserver、
// sqlite 等）反斜杠是普通字面字符，翻倍反而会写入两个反斜杠、损坏数据。
func dialectEscapesBackslashInStringLiteral(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "tidb", "oceanbase", "diros", "doris", "starrocks",
		"clickhouse", "tdengine", "taos":
		return true
	default:
		return false
	}
}

// escapeSQLStringLiteralBody 按方言转义字符串字面量的内容（不含外层单引号）。
// 反斜杠必须先于单引号处理，避免二次转义。非 MySQL 系方言（standard_conforming_strings）
// 只需翻倍单引号，反斜杠保持字面量含义。
func escapeSQLStringLiteralBody(dbType string, value string) string {
	if dialectEscapesBackslashInStringLiteral(dbType) {
		value = strings.ReplaceAll(value, "\\", "\\\\")
	}
	return strings.ReplaceAll(value, "'", "''")
}

func isMySQLHexLiteral(s string) bool {
	if len(s) < 3 || !(strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X")) {
		return false
	}
	for i := 2; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func formatSQLValue(dbType string, v interface{}) string {
	if v == nil {
		return "NULL"
	}

	switch val := v.(type) {
	case bool:
		if isPgLikeBooleanDBType(dbType) {
			return booleanSQLLiteral(val)
		}
		if val {
			return "1"
		}
		return "0"
	case int:
		return strconv.Itoa(val)
	case int8, int16, int32, int64:
		return fmt.Sprintf("%d", val)
	case uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", val)
	case float32:
		f := float64(val)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(f, 'f', -1, 32)
	case float64:
		if math.IsNaN(val) || math.IsInf(val, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	case json.Number:
		literal := strings.TrimSpace(val.String())
		if !jsonNumberSQLLiteralPattern.MatchString(literal) {
			return "NULL"
		}
		// JSON numbers may exceed float64 while remaining valid database numeric
		// literals. The strict token pattern above prevents SQL injection; let the
		// target column/driver decide its actual numeric range instead of silently
		// replacing a valid value with NULL.
		return literal
	case time.Time:
		return "'" + val.Format("2006-01-02 15:04:05") + "'"
	case string:
		normalizedType := strings.ToLower(strings.TrimSpace(dbType))
		if (normalizedType == "mysql" || normalizedType == "oceanbase" || normalizedType == "diros" || normalizedType == "starrocks") && isMySQLHexLiteral(val) {
			return val
		}
		return "'" + escapeSQLStringLiteralBody(dbType, val) + "'"
	default:
		return "'" + escapeSQLStringLiteralBody(dbType, fmt.Sprintf("%v", v)) + "'"
	}
}

func dumpTableSQL(
	w *bufio.Writer,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName,
	tableName string,
	includeSchema bool,
	includeData bool,
	viewLookup map[string]string,
) error {
	return dumpTableSQLWithDatabaseContext(
		w,
		dbInst,
		config,
		dbName,
		tableName,
		includeSchema,
		includeData,
		viewLookup,
		true,
	)
}

func dumpTableSQLWithDatabaseContext(
	w *bufio.Writer,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName,
	tableName string,
	includeSchema bool,
	includeData bool,
	viewLookup map[string]string,
	includeDatabaseContext bool,
) error {
	dbType := resolveDDLDBType(config)
	metadataSchemaName, metadataTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	ddlSchemaName, ddlTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	objectKey := normalizeExportObjectKey(config, dbName, tableName)
	_, isView := viewLookup[objectKey]
	var createSQL string

	if includeSchema {
		if isView {
			viewDDL, ok := tryGetViewCreateStatement(dbInst, config, dbName, metadataSchemaName, metadataTableName)
			if ok {
				createSQL = viewDDL
			} else {
				ddl, err := dbInst.GetCreateStatement(metadataSchemaName, metadataTableName)
				if err != nil {
					return err
				}
				createSQL = ddl
			}
		} else {
			ddl, err := resolveCreateStatementWithFallback(dbInst, config, dbName, tableName)
			if err != nil {
				if viewDDL, ok := tryGetViewCreateStatement(dbInst, config, dbName, metadataSchemaName, metadataTableName); ok {
					createSQL = viewDDL
					isView = true
				} else {
					return err
				}
			} else {
				createSQL = ddl
			}
		}
	}

	if includeData && !includeSchema && !isView {
		if _, ok := tryGetViewCreateStatement(dbInst, config, dbName, metadataSchemaName, metadataTableName); ok {
			isView = true
		}
	}

	objectLabel := "Table"
	if isView {
		objectLabel = "View"
	}

	if _, err := w.WriteString("\n-- ----------------------------\n"); err != nil {
		return err
	}
	if _, err := w.WriteString(fmt.Sprintf("-- %s: %s\n", objectLabel, qualifyTable(ddlSchemaName, ddlTableName))); err != nil {
		return err
	}
	if _, err := w.WriteString("-- ----------------------------\n\n"); err != nil {
		return err
	}

	if includeSchema {
		if _, err := w.WriteString(ensureSQLTerminator(createSQL)); err != nil {
			return err
		}
		if _, err := w.WriteString("\n\n"); err != nil {
			return err
		}
	}

	if !includeData {
		return nil
	}

	if isView {
		if _, err := w.WriteString("-- View data export skipped (INSERT for views is not emitted).\n"); err != nil {
			return err
		}
		return nil
	}

	selectSQL := fmt.Sprintf("SELECT * FROM %s", quoteTableIdentByType(dbType, ddlSchemaName, ddlTableName))
	outputTableName := quoteTableIdentByType(dbType, ddlSchemaName, ddlTableName)
	if supportsMySQLDatabaseContext(config) && !includeDatabaseContext {
		outputTableName = quoteIdentByType(dbType, ddlTableName)
	}
	columnTypeMap := map[string]string{}
	if defs, colErr := dbInst.GetColumns(metadataSchemaName, metadataTableName); colErr == nil {
		columnTypeMap = buildImportColumnTypeMap(defs)
	}
	insertConsumer := &sqlInsertExportConsumer{
		w:             w,
		dbType:        dbType,
		quotedTable:   outputTableName,
		columnTypeMap: columnTypeMap,
	}
	if err := streamQueryDataForExport(dbInst, config, selectSQL, insertConsumer); err != nil {
		if flushErr := insertConsumer.Flush(); flushErr != nil {
			return flushErr
		}
		return err
	}
	if err := insertConsumer.Flush(); err != nil {
		return err
	}
	if insertConsumer.rowCount == 0 {
		if _, err := w.WriteString("-- (0 rows)\n"); err != nil {
			return err
		}
		return nil
	}

	return nil
}

// ExportData exports provided data to a file
func (a *App) ExportData(data []map[string]interface{}, columns []string, defaultName string, format string) connection.QueryResult {
	return a.ExportDataWithOptions(data, columns, defaultName, ExportFileOptions{Format: format})
}

func (a *App) ExportDataWithOptions(data []map[string]interface{}, columns []string, defaultName string, options ExportFileOptions) (result connection.QueryResult) {
	if defaultName == "" {
		defaultName = "export"
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if !options.TotalRowsKnown {
		options.TotalRowsKnown = true
		options.TotalRowsHint = int64(len(data))
	}
	format := options.Format
	logger.Infof("ExportData 开始：rows=%d cols=%d format=%s defaultName=%s", len(data), len(columns), strings.ToLower(strings.TrimSpace(format)), strings.TrimSpace(defaultName))
	defaultFilename := fmt.Sprintf("%s.%s", defaultName, strings.ToLower(format))
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(
			fmt.Sprintf("%s.%s", sanitizeExportFileStem(defaultName), strings.ToLower(format)),
			webDownloadMIMEForFormat(format),
		)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_data", nil),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters(format),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			logger.Infof("ExportData 已取消或未选择文件：err=%v", err)
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, format)
		if err != nil {
			logger.Warnf("ExportData 目标文件无效：file=%s err=%v", filename, err)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	logger.Infof("ExportData 选定文件：%s", filename)
	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, defaultName, reporterPath)
	reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))

	f, err := openExportFileForTarget(webTarget, filename)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() { _ = f.Close() }()
	writtenRows, err := writeRowsToFileWithReporter(f, data, columns, options, reporter)
	if err != nil {
		logger.Warnf("ExportData 写入失败：file=%s err=%v", filename, err)
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(writtenRows, errMsg)
		maybeReleaseFileTransferMemory("export-data-error", writtenRows, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}
	if err := closeExportFile(f); err != nil {
		logger.Warnf("ExportData 落盘失败：file=%s err=%v", filename, err)
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(writtenRows, errMsg)
		maybeReleaseFileTransferMemory("export-data-error", writtenRows, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}

	logger.Infof("ExportData 完成：file=%s rows=%d", filename, len(data))
	reporter.Done(writtenRows)
	maybeReleaseFileTransferMemory("export-data-finished", writtenRows, filename)
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

// ExportQuery exports by executing the provided SELECT query on backend side.
// This avoids frontend IPC payload limits when exporting very large/long-text columns (e.g. base64).
func (a *App) ExportQuery(config connection.ConnectionConfig, dbName string, query string, defaultName string, format string) connection.QueryResult {
	return a.ExportQueryWithOptions(config, dbName, query, defaultName, ExportFileOptions{Format: format})
}

func (a *App) ExportQueryWithOptions(config connection.ConnectionConfig, dbName string, query string, defaultName string, options ExportFileOptions) (result connection.QueryResult) {
	query = strings.TrimSpace(query)
	if query == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.query_required", nil)}
	}

	if defaultName == "" {
		defaultName = "export"
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	format := options.Format
	if format != "sql" {
		if err := verifyOptionalDriverAgentReadyForExport(config); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	defaultFilename := fmt.Sprintf("%s.%s", defaultName, strings.ToLower(format))
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(
			fmt.Sprintf("%s.%s", sanitizeExportFileStem(defaultName), strings.ToLower(format)),
			webDownloadMIMEForFormat(format),
		)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_query_result", nil),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters(format),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			logger.Infof("ExportQuery 已取消或未选择文件：err=%v", err)
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, format)
		if err != nil {
			logger.Warnf("ExportQuery 目标文件无效：file=%s err=%v", filename, err)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	logger.Infof("ExportQuery 开始：type=%s db=%s format=%s file=%s sql=%q", strings.TrimSpace(config.Type), strings.TrimSpace(dbName), strings.ToLower(strings.TrimSpace(format)), filename, sqlSnippet(query))
	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, defaultName, reporterPath)
	reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if format == "sql" {
		options.InsertSQLDialect = resolveDDLDBType(runConfig)
		options.InsertSQLTargetTable = resolveChangeTargetTableName(runConfig, dbName, options.InsertSQLTargetTable)
		if options.InsertSQLTargetTable != "" {
			schemaName, pureTableName := normalizeSchemaAndTable(runConfig, dbName, options.InsertSQLTargetTable)
			if options.InsertSQLDialect == "dameng" {
				schemaName, pureTableName = splitDamengChangeTarget(dbName, options.InsertSQLTargetTable)
			}
			if defs, colErr := dbInst.GetColumns(schemaName, pureTableName); colErr == nil {
				options.InsertSQLColumnTypes = buildImportColumnTypeMap(defs)
				options.InsertSQLTargetColumns = make(map[string]string, len(defs))
				for _, def := range defs {
					if key := normalizeColumnName(def.Name); key != "" {
						options.InsertSQLTargetColumns[key] = strings.TrimSpace(def.Name)
					}
				}
			}
		}
	}

	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	if !looksLikeSelectOrWith(query) {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.select_with_query_required", nil)}
	}

	f, err := openExportFileForTarget(webTarget, filename)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() { _ = f.Close() }()

	rowCount, columns, err := exportQueryResultToFile(f, dbInst, runConfig, query, options, reporter)
	if err != nil {
		logger.Warnf("ExportQuery 查询失败：type=%s db=%s err=%v sql=%q", strings.TrimSpace(config.Type), strings.TrimSpace(dbName), err, sqlSnippet(query))
		reporter.Error(rowCount, err.Error())
		maybeReleaseFileTransferMemory("export-query-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := closeExportFile(f); err != nil {
		logger.Warnf("ExportQuery 落盘失败：file=%s err=%v", filename, err)
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(rowCount, errMsg)
		maybeReleaseFileTransferMemory("export-query-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}

	logger.Infof("ExportQuery 完成：file=%s rows=%d cols=%d", filename, rowCount, len(columns))
	reporter.Done(rowCount)
	maybeReleaseFileTransferMemory("export-query-finished", rowCount, filename)
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

func queryDataForExport(dbInst db.Database, config connection.ConnectionConfig, query string) ([]map[string]interface{}, []string, error) {
	return queryDataForExportWithContext(db.MetadataContext(dbInst), dbInst, config, query)
}

// queryDataForExportWithContext is the buffered export fallback. It retains
// the caller's cancellation signal instead of creating an unrelated
// background deadline, which is required for the headless CLI export path.
func queryDataForExportWithContext(parent context.Context, dbInst db.Database, config connection.ConnectionConfig, query string) ([]map[string]interface{}, []string, error) {
	if parent == nil {
		parent = context.Background()
	}
	timeout := getExportQueryTimeout(config)
	dbType := resolveDDLDBType(config)
	if dbType == "clickhouse" {
		logger.Infof("ClickHouse 导出查询开始：timeout=%s SQL片段=%q", timeout, sqlSnippet(query))
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if q, ok := dbInst.(interface {
		QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
	}); ok {
		data, columns, err := q.QueryContext(ctx, query)
		if err == nil && ctx.Err() != nil {
			err = ctx.Err()
		}
		if err != nil && dbType == "clickhouse" {
			logger.Warnf("ClickHouse 导出查询失败：timeout=%s SQL片段=%q err=%v", timeout, sqlSnippet(query), err)
		}
		return data, columns, err
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	data, columns, err := dbInst.Query(query)
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	if err != nil && dbType == "clickhouse" {
		logger.Warnf("ClickHouse 导出查询失败（无 QueryContext）：timeout=%s SQL片段=%q err=%v", timeout, sqlSnippet(query), err)
	}
	return data, columns, err
}

func getExportQueryTimeout(config connection.ConnectionConfig) time.Duration {
	if config.QueryTimeout > 0 {
		return time.Duration(config.QueryTimeout) * time.Second
	}
	timeout := time.Duration(config.Timeout) * time.Second
	if timeout <= 0 {
		timeout = minExportQueryTimeout
	}
	if resolveDDLDBType(config) == "clickhouse" {
		if timeout < minClickHouseExportQueryTimeout {
			timeout = minClickHouseExportQueryTimeout
		}
		return timeout
	}
	if timeout < minExportQueryTimeout {
		timeout = minExportQueryTimeout
	}
	return timeout
}

type exportFileWriter interface {
	db.QueryStreamConsumer
	Close() error
}

type exportValueStreamConsumer interface {
	ConsumeRowValues(values []interface{}) error
}

type exportColumnProjectionConsumer struct {
	delegate         db.QueryStreamConsumer
	requestedColumns []string
	columns          []string
	columnIndexes    []int
	values           []interface{}
}

func (c *exportColumnProjectionConsumer) SetColumns(columns []string) error {
	selectedColumns, err := resolveRequestedExportColumns(columns, c.requestedColumns)
	if err != nil {
		return err
	}
	indexByColumn := make(map[string]int, len(columns))
	for index, column := range columns {
		if _, exists := indexByColumn[column]; !exists {
			indexByColumn[column] = index
		}
	}

	c.columns = selectedColumns
	c.columnIndexes = make([]int, len(selectedColumns))
	for index, column := range selectedColumns {
		c.columnIndexes[index] = indexByColumn[column]
	}
	c.values = make([]interface{}, len(c.columns))
	if c.delegate == nil {
		return nil
	}
	return c.delegate.SetColumns(c.columns)
}

func (c *exportColumnProjectionConsumer) ConsumeRow(row map[string]interface{}) error {
	if c.delegate == nil {
		return nil
	}
	return c.delegate.ConsumeRow(row)
}

func (c *exportColumnProjectionConsumer) ConsumeRowValues(values []interface{}) error {
	for selectedIndex, sourceIndex := range c.columnIndexes {
		if sourceIndex < len(values) {
			c.values[selectedIndex] = values[sourceIndex]
		} else {
			c.values[selectedIndex] = nil
		}
	}
	if c.delegate == nil {
		return nil
	}
	if valueConsumer, ok := c.delegate.(exportValueStreamConsumer); ok {
		return valueConsumer.ConsumeRowValues(c.values)
	}
	row := make(map[string]interface{}, len(c.columns))
	for index, column := range c.columns {
		row[column] = c.values[index]
	}
	return c.delegate.ConsumeRow(row)
}

type countingExportConsumer struct {
	delegate db.QueryStreamConsumer
	columns  []string
	rowCount int64
	reporter *exportProgressReporter
}

func (c *countingExportConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	if c.delegate != nil {
		if err := c.delegate.SetColumns(columns); err != nil {
			return err
		}
	}
	if c.reporter != nil {
		c.reporter.ForceRunning(c.rowCount, c.reporter.text("data_export.progress.stage.writing_file", nil))
	}
	return nil
}

func (c *countingExportConsumer) ConsumeRow(row map[string]interface{}) error {
	if c.delegate != nil {
		if err := c.delegate.ConsumeRow(row); err != nil {
			return err
		}
	}
	c.rowCount++
	if c.reporter != nil {
		c.reporter.Rows(c.rowCount, c.reporter.text("data_export.progress.stage.writing_file", nil))
	}
	return nil
}

func (c *countingExportConsumer) ConsumeRowValues(values []interface{}) error {
	if c.delegate != nil {
		if valueConsumer, ok := c.delegate.(exportValueStreamConsumer); ok {
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
		} else {
			row := make(map[string]interface{}, len(c.columns))
			for i, column := range c.columns {
				if i < len(values) {
					row[column] = values[i]
				} else {
					row[column] = nil
				}
			}
			if err := c.delegate.ConsumeRow(row); err != nil {
				return err
			}
		}
	}
	c.rowCount++
	if c.reporter != nil {
		c.reporter.Rows(c.rowCount, c.reporter.text("data_export.progress.stage.writing_file", nil))
	}
	return nil
}

type csvExportFileWriter struct {
	writer  *csv.Writer
	columns []string
	record  []string
}

func newCSVExportFileWriter(f io.Writer) (*csvExportFileWriter, error) {
	if _, err := f.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
		return nil, err
	}
	return &csvExportFileWriter{writer: csv.NewWriter(f)}, nil
}

func (w *csvExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	w.record = make([]string, len(columns))
	return w.writer.Write(columns)
}

func (w *csvExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	return w.writer.Write(fillExportRecordFromRow(w.record, row, w.columns, false))
}

func (w *csvExportFileWriter) ConsumeRowValues(values []interface{}) error {
	return w.writer.Write(fillExportRecordFromValues(w.record, values, false))
}

func (w *csvExportFileWriter) Close() error {
	w.writer.Flush()
	return w.writer.Error()
}

type jsonExportFileWriter struct {
	file    io.Writer
	encoder *json.Encoder
	columns []string
	rowBuf  map[string]interface{}
	first   bool
}

func newJSONExportFileWriter(f io.Writer) (*jsonExportFileWriter, error) {
	if _, err := io.WriteString(f, "[\n"); err != nil {
		return nil, err
	}
	encoder := json.NewEncoder(f)
	encoder.SetIndent("  ", "  ")
	return &jsonExportFileWriter{file: f, encoder: encoder, first: true}, nil
}

func (w *jsonExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	w.rowBuf = make(map[string]interface{}, len(columns))
	return nil
}

func (w *jsonExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	for _, col := range w.columns {
		w.rowBuf[col] = normalizeExportJSONValue(row[col])
	}
	return w.writeCurrentRow()
}

func (w *jsonExportFileWriter) ConsumeRowValues(values []interface{}) error {
	for i, col := range w.columns {
		if i < len(values) {
			w.rowBuf[col] = normalizeExportJSONValue(values[i])
		} else {
			w.rowBuf[col] = nil
		}
	}
	return w.writeCurrentRow()
}

func (w *jsonExportFileWriter) writeCurrentRow() error {
	if !w.first {
		if _, err := io.WriteString(w.file, ",\n"); err != nil {
			return err
		}
	}
	if err := w.encoder.Encode(w.rowBuf); err != nil {
		return err
	}
	w.first = false
	return nil
}

func (w *jsonExportFileWriter) Close() error {
	_, err := io.WriteString(w.file, "\n]")
	return err
}

type markdownExportFileWriter struct {
	file    io.Writer
	columns []string
	record  []string
}

func (w *markdownExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	w.record = make([]string, len(columns))
	if _, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(columns, " | ")); err != nil {
		return err
	}
	seps := make([]string, len(columns))
	for i := range seps {
		seps[i] = "---"
	}
	_, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(seps, " | "))
	return err
}

func (w *markdownExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	_, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(fillExportRecordFromRow(w.record, row, w.columns, true), " | "))
	return err
}

func (w *markdownExportFileWriter) ConsumeRowValues(values []interface{}) error {
	_, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(fillExportRecordFromValues(w.record, values, true), " | "))
	return err
}

func (w *markdownExportFileWriter) Close() error {
	return nil
}

type htmlExportFileWriter struct {
	writer   *bufio.Writer
	columns  []string
	rowCount int64
}

func newHTMLExportFileWriter(f io.Writer) *htmlExportFileWriter {
	return &htmlExportFileWriter{writer: bufio.NewWriterSize(f, 1024*256)}
}

func (w *htmlExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	if _, err := w.writer.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GoNavi Export</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8f9fa;
      --card: #ffffff;
      --line: #dee2e6;
      --text: #212529;
      --muted: #6c757d;
      --hover: #f1f3f5;
      --zebra: #f8f9fa;
      --head: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
    }
    .export-wrap {
      max-width: 100%;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .export-head {
      padding: 16px 20px;
      background: var(--head);
      border-bottom: 2px solid var(--line);
    }
    .export-head h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
    }
    .export-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .table-wrap {
      width: 100%;
      overflow: auto;
      padding: 16px;
    }
    table {
      border-collapse: collapse;
      width: auto;
      font-size: 13px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--head);
      text-align: left;
      font-weight: 600;
      white-space: nowrap;
      border-bottom: 2px solid var(--line);
      color: var(--text);
      padding: 12px 16px;
    }
    td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      max-width: 500px;
      color: var(--text);
    }
    tbody tr:nth-child(even) {
      background: var(--zebra);
    }
    tbody tr:hover {
      background: var(--hover);
    }
    td.empty {
      text-align: center;
      color: var(--muted);
      font-style: italic;
    }
    @media (max-width: 768px) {
      body { padding: 16px; }
      .export-head { padding: 12px 16px; }
      .table-wrap { padding: 12px; }
      th, td { padding: 8px 12px; font-size: 12px; }
    }
    @media print {
      body { background: white; padding: 0; }
      .export-wrap { border: none; }
    }
  </style>
</head>
<body>
  <div class="export-wrap">
    <div class="export-head">
      <h1>GoNavi Data Export</h1>
      <div class="export-meta">`); err != nil {
		return err
	}

	if _, err := fmt.Fprintf(w.writer, "Columns: %d · Generated: %s", len(columns), time.Now().Format("2006-01-02 15:04:05")); err != nil {
		return err
	}

	if _, err := w.writer.WriteString(`</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>`); err != nil {
		return err
	}

	for _, col := range columns {
		if _, err := fmt.Fprintf(w.writer, "<th>%s</th>", html.EscapeString(col)); err != nil {
			return err
		}
	}

	_, err := w.writer.WriteString(`</tr></thead><tbody>`)
	return err
}

func (w *htmlExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	if _, err := w.writer.WriteString("<tr>"); err != nil {
		return err
	}
	for _, col := range w.columns {
		if _, err := fmt.Fprintf(w.writer, "<td>%s</td>", formatExportHTMLCell(row[col])); err != nil {
			return err
		}
	}
	if _, err := w.writer.WriteString("</tr>"); err != nil {
		return err
	}
	w.rowCount++
	return nil
}

func (w *htmlExportFileWriter) ConsumeRowValues(values []interface{}) error {
	if _, err := w.writer.WriteString("<tr>"); err != nil {
		return err
	}
	for i := range w.columns {
		var value interface{}
		if i < len(values) {
			value = values[i]
		}
		if _, err := fmt.Fprintf(w.writer, "<td>%s</td>", formatExportHTMLCell(value)); err != nil {
			return err
		}
	}
	if _, err := w.writer.WriteString("</tr>"); err != nil {
		return err
	}
	w.rowCount++
	return nil
}

func (w *htmlExportFileWriter) Close() error {
	if w.rowCount == 0 {
		colspan := len(w.columns)
		if colspan <= 0 {
			colspan = 1
		}
		if _, err := fmt.Fprintf(w.writer, `<tr><td class="empty" colspan="%d">(0 rows)</td></tr>`, colspan); err != nil {
			return err
		}
	}
	if _, err := w.writer.WriteString(`</tbody></table>
    </div>
  </div>
</body>
</html>`); err != nil {
		return err
	}
	return w.writer.Flush()
}

type sqlInsertExportConsumer struct {
	w             *bufio.Writer
	dbType        string
	quotedTable   string
	columnTypeMap map[string]string
	columns       []string
	quotedCols    []string
	columnList    string
	columnTypes   []string
	targetColumns map[string]string
	valueBuf      []string
	rowCount      int64
	mode          sqlInsertExportMode
	pendingRows   int
	statementBuf  strings.Builder
}

type sqlInsertExportMode int

const (
	sqlInsertExportModeSingle sqlInsertExportMode = iota
	sqlInsertExportModeMultiValues
	sqlInsertExportModeInsertAll
)

func resolveSQLInsertExportMode(dbType string) sqlInsertExportMode {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "sqlite", "duckdb", "clickhouse", "iris":
		return sqlInsertExportModeMultiValues
	case "oracle", "dameng":
		return sqlInsertExportModeInsertAll
	default:
		return sqlInsertExportModeSingle
	}
}

func (c *sqlInsertExportConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	c.quotedCols = make([]string, 0, len(columns))
	c.columnTypes = make([]string, len(columns))
	c.valueBuf = make([]string, len(columns))
	for _, column := range columns {
		targetColumn := column
		if len(c.targetColumns) > 0 {
			mappedColumn, ok := c.targetColumns[normalizeColumnName(column)]
			if !ok || strings.TrimSpace(mappedColumn) == "" {
				return fmt.Errorf("query result column %q does not match the INSERT target table", column)
			}
			targetColumn = mappedColumn
		}
		c.quotedCols = append(c.quotedCols, quoteIdentByType(c.dbType, targetColumn))
	}
	for i, column := range columns {
		c.columnTypes[i] = c.columnTypeMap[normalizeColumnName(column)]
	}
	c.columnList = strings.Join(c.quotedCols, ", ")
	c.mode = resolveSQLInsertExportMode(c.dbType)
	return nil
}

func (c *sqlInsertExportConsumer) ConsumeRow(row map[string]interface{}) error {
	for i, column := range c.columns {
		c.valueBuf[i] = formatImportSQLValue(c.dbType, c.columnTypeMap[normalizeColumnName(column)], row[column])
	}
	return c.consumeValueBuf()
}

func (c *sqlInsertExportConsumer) ConsumeRowValues(values []interface{}) error {
	for i := range c.columns {
		var value interface{}
		if i < len(values) {
			value = values[i]
		}
		c.valueBuf[i] = formatImportSQLValue(c.dbType, c.columnTypes[i], value)
	}
	return c.consumeValueBuf()
}

func (c *sqlInsertExportConsumer) consumeValueBuf() error {
	rowValues := "(" + strings.Join(c.valueBuf, ", ") + ")"
	switch c.mode {
	case sqlInsertExportModeMultiValues, sqlInsertExportModeInsertAll:
		return c.appendBatchRow(rowValues)
	default:
		if _, err := c.w.WriteString(fmt.Sprintf("INSERT INTO %s (%s) VALUES %s;\n", c.quotedTable, c.columnList, rowValues)); err != nil {
			return err
		}
		c.rowCount++
		return nil
	}
}

func (c *sqlInsertExportConsumer) appendBatchRow(rowValues string) error {
	if c.pendingRows > 0 {
		separatorLen := 2
		if c.mode == sqlInsertExportModeInsertAll {
			separatorLen = 3
		}
		if c.pendingRows >= sqlExportInsertBatchMaxRows || c.statementBuf.Len()+len(rowValues)+separatorLen >= sqlExportInsertBatchMaxBytes {
			if err := c.Flush(); err != nil {
				return err
			}
		}
	}

	switch c.mode {
	case sqlInsertExportModeMultiValues:
		if c.pendingRows == 0 {
			c.statementBuf.WriteString("INSERT INTO ")
			c.statementBuf.WriteString(c.quotedTable)
			c.statementBuf.WriteString(" (")
			c.statementBuf.WriteString(c.columnList)
			c.statementBuf.WriteString(") VALUES ")
		} else {
			c.statementBuf.WriteString(",\n")
		}
		c.statementBuf.WriteString(rowValues)
	case sqlInsertExportModeInsertAll:
		if c.pendingRows == 0 {
			c.statementBuf.WriteString("INSERT ALL\n")
		}
		c.statementBuf.WriteString("  INTO ")
		c.statementBuf.WriteString(c.quotedTable)
		c.statementBuf.WriteString(" (")
		c.statementBuf.WriteString(c.columnList)
		c.statementBuf.WriteString(") VALUES ")
		c.statementBuf.WriteString(rowValues)
		c.statementBuf.WriteByte('\n')
	default:
		if _, err := c.w.WriteString(fmt.Sprintf("INSERT INTO %s (%s) VALUES %s;\n", c.quotedTable, c.columnList, rowValues)); err != nil {
			return err
		}
		c.rowCount++
		return nil
	}

	c.pendingRows++
	if c.pendingRows >= sqlExportInsertBatchMaxRows || c.statementBuf.Len() >= sqlExportInsertBatchMaxBytes {
		return c.Flush()
	}
	return nil
}

func (c *sqlInsertExportConsumer) Flush() error {
	if c == nil || c.pendingRows == 0 {
		return nil
	}
	switch c.mode {
	case sqlInsertExportModeMultiValues:
		c.statementBuf.WriteString(";\n")
	case sqlInsertExportModeInsertAll:
		c.statementBuf.WriteString("SELECT 1 FROM DUAL;\n")
	default:
		return nil
	}
	if _, err := c.w.WriteString(c.statementBuf.String()); err != nil {
		return err
	}
	c.rowCount += int64(c.pendingRows)
	c.pendingRows = 0
	c.statementBuf.Reset()
	return nil
}

type sqlInsertExportFileWriter struct {
	writer   *bufio.Writer
	consumer *sqlInsertExportConsumer
	closed   bool
}

func newSQLInsertExportFileWriter(f io.Writer, options ExportFileOptions) (*sqlInsertExportFileWriter, error) {
	dialect := strings.TrimSpace(options.InsertSQLDialect)
	targetTable := strings.TrimSpace(options.InsertSQLTargetTable)
	if dialect == "" {
		return nil, fmt.Errorf("INSERT SQL export requires a database dialect")
	}
	if targetTable == "" && !options.InsertSQLAllowEmptyTargetTable {
		return nil, fmt.Errorf("INSERT SQL export requires a target table")
	}
	quotedTable := quoteQualifiedIdentByType(dialect, "<table_name>")
	if targetTable != "" {
		quotedTable = quoteQualifiedIdentByType(dialect, targetTable)
	}

	writer := bufio.NewWriterSize(f, 1024*1024)
	return &sqlInsertExportFileWriter{
		writer: writer,
		consumer: &sqlInsertExportConsumer{
			w:             writer,
			dbType:        dialect,
			quotedTable:   quotedTable,
			columnTypeMap: options.InsertSQLColumnTypes,
			targetColumns: options.InsertSQLTargetColumns,
		},
	}, nil
}

func (w *sqlInsertExportFileWriter) SetColumns(columns []string) error {
	return w.consumer.SetColumns(columns)
}

func (w *sqlInsertExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	return w.consumer.ConsumeRow(row)
}

func (w *sqlInsertExportFileWriter) ConsumeRowValues(values []interface{}) error {
	return w.consumer.ConsumeRowValues(values)
}

func (w *sqlInsertExportFileWriter) Close() error {
	if w == nil || w.closed {
		return nil
	}
	w.closed = true
	if err := w.consumer.Flush(); err != nil {
		return err
	}
	return w.writer.Flush()
}

func resolveExportColumns(columns []string, data []map[string]interface{}) []string {
	if len(columns) > 0 || len(data) == 0 {
		return columns
	}
	keySet := make(map[string]bool)
	for _, row := range data {
		for key := range row {
			keySet[key] = true
		}
	}
	derived := make([]string, 0, len(keySet))
	for key := range keySet {
		derived = append(derived, key)
	}
	sort.Strings(derived)
	return derived
}

func resolveRequestedExportColumns(columns []string, requested []string) ([]string, error) {
	if len(requested) == 0 {
		return columns, nil
	}
	available := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		available[column] = struct{}{}
	}
	selected := make([]string, 0, len(requested))
	for _, column := range requested {
		if _, exists := available[column]; !exists {
			return nil, fmt.Errorf("requested export column %q was not found in query result", column)
		}
		selected = append(selected, column)
	}
	return selected, nil
}

func newExportFileWriter(f io.Writer, options ExportFileOptions) (exportFileWriter, error) {
	options = normalizeExportFileOptions("", options)
	switch options.Format {
	case "csv":
		return newCSVExportFileWriter(f)
	case "json":
		return newJSONExportFileWriter(f)
	case "md":
		return &markdownExportFileWriter{file: f}, nil
	case "html":
		return newHTMLExportFileWriter(f), nil
	case "xlsx":
		file, ok := f.(xlsxExportOutputFile)
		if !ok {
			return nil, fmt.Errorf("xlsx export requires a seekable file")
		}
		writeOptions := xlsxExportWriteOptions{}
		if managed, ok := f.(*webTransferFile); ok {
			writeOptions.tempDir = filepath.Dir(managed.file.Name())
			writeOptions.budget = managed.budget
		}
		return newXLSXExportFileWriter(file, options.XLSXMaxRowsPerSheet, writeOptions)
	case "sql":
		return newSQLInsertExportFileWriter(f, options)
	default:
		return nil, fmt.Errorf("unsupported format: %s", options.Format)
	}
}

func streamQueryDataForExport(dbInst db.Database, config connection.ConnectionConfig, query string, consumer db.QueryStreamConsumer) error {
	return streamQueryDataForExportWithContext(db.MetadataContext(dbInst), dbInst, config, query, consumer)
}

// streamQueryDataForExportWithContext preserves the existing streaming and
// fallback behavior while allowing headless callers to cancel a live export.
func streamQueryDataForExportWithContext(ctx context.Context, dbInst db.Database, config connection.ConnectionConfig, query string, consumer db.QueryStreamConsumer) error {
	if consumer == nil {
		return fmt.Errorf("export consumer required")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	timeout := getExportQueryTimeout(config)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if streamer, ok := dbInst.(db.StreamQueryExecer); ok {
		return streamer.StreamQueryContext(ctx, query, consumer)
	}

	if provider, ok := dbInst.(db.SessionExecerProvider); ok {
		session, err := provider.OpenSessionExecer(ctx)
		if err != nil {
			logger.Warnf("导出流式会话打开失败，回退到缓冲导出：type=%s err=%v", strings.TrimSpace(config.Type), err)
		} else {
			defer session.Close()
			if streamer, ok := session.(db.StreamQueryExecer); ok {
				return streamer.StreamQueryContext(ctx, query, consumer)
			}
		}
	}

	logger.Warnf("导出流式查询不可用，回退到缓冲导出：type=%s", strings.TrimSpace(config.Type))
	data, columns, err := queryDataForExportWithContext(ctx, dbInst, config, query)
	if err != nil {
		return err
	}
	columns = resolveExportColumns(columns, data)
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}
	for _, row := range data {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func exportQueryResultToFile(f io.Writer, dbInst db.Database, config connection.ConnectionConfig, query string, options ExportFileOptions, reporter *exportProgressReporter) (int64, []string, error) {
	return exportQueryResultToFileWithContext(context.Background(), f, dbInst, config, query, options, reporter)
}

func exportQueryResultToFileWithContext(ctx context.Context, f io.Writer, dbInst db.Database, config connection.ConnectionConfig, query string, options ExportFileOptions, reporter *exportProgressReporter) (int64, []string, error) {
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return 0, nil, err
	}
	writer, err := newExportFileWriter(f, options)
	if err != nil {
		return 0, nil, err
	}

	if reporter != nil {
		reporter.Start(reporter.text("data_export.progress.stage.querying_data", nil))
	}
	var projection *exportColumnProjectionConsumer
	delegate := db.QueryStreamConsumer(writer)
	if len(options.Columns) > 0 {
		projection = &exportColumnProjectionConsumer{
			delegate:         writer,
			requestedColumns: options.Columns,
		}
		delegate = projection
	}
	consumer := &countingExportConsumer{delegate: delegate, reporter: reporter}
	streamErr := streamQueryDataForExportWithContext(ctx, dbInst, config, query, consumer)
	if reporter != nil && streamErr == nil {
		reporter.Finalizing(consumer.rowCount)
	}
	closeErr := writer.Close()
	exportedColumns := consumer.columns
	if projection != nil {
		exportedColumns = projection.columns
	}
	if streamErr != nil {
		return consumer.rowCount, exportedColumns, streamErr
	}
	if closeErr != nil {
		return consumer.rowCount, exportedColumns, closeErr
	}
	return consumer.rowCount, exportedColumns, nil
}

func fillExportRecordFromValues(record []string, values []interface{}, markdown bool) []string {
	if len(record) != len(values) {
		record = make([]string, len(values))
	}
	for i, val := range values {
		record[i] = formatExportRecordValue(val, markdown)
	}
	return record
}

func fillExportRecordFromRow(record []string, row map[string]interface{}, columns []string, markdown bool) []string {
	if len(record) != len(columns) {
		record = make([]string, len(columns))
	}
	for i, col := range columns {
		record[i] = formatExportRecordValue(row[col], markdown)
	}
	return record
}

func formatExportRecordValue(val interface{}, markdown bool) string {
	if val == nil {
		return ""
	}
	text := formatExportCellText(val)
	if markdown {
		text = strings.ReplaceAll(text, "|", "\\|")
		text = strings.ReplaceAll(text, "\n", "<br>")
	}
	return text
}

func writeRowsToFile(f io.Writer, data []map[string]interface{}, columns []string, options ExportFileOptions) error {
	_, err := writeRowsToFileWithReporter(f, data, columns, options, nil)
	return err
}

func writeRowsToFileWithReporter(f io.Writer, data []map[string]interface{}, columns []string, options ExportFileOptions, reporter *exportProgressReporter) (int64, error) {
	if f == nil {
		return 0, fmt.Errorf("file required")
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return 0, err
	}
	columns = resolveExportColumns(columns, data)
	columns, err := resolveRequestedExportColumns(columns, options.Columns)
	if err != nil {
		return 0, err
	}
	writer, err := newExportFileWriter(f, options)
	if err != nil {
		return 0, err
	}
	if err := writer.SetColumns(columns); err != nil {
		_ = writer.Close()
		return 0, err
	}
	if reporter != nil {
		reporter.ForceRunning(0, reporter.text("data_export.progress.stage.writing_file", nil))
	}
	for index, row := range data {
		if err := writer.ConsumeRow(row); err != nil {
			_ = writer.Close()
			return int64(index), err
		}
		if reporter != nil {
			reporter.Rows(int64(index+1), reporter.text("data_export.progress.stage.writing_file", nil))
		}
	}
	if reporter != nil {
		reporter.Finalizing(int64(len(data)))
	}
	if err := writer.Close(); err != nil {
		return int64(len(data)), err
	}
	return int64(len(data)), nil
}

func formatExportHTMLCell(val interface{}) string {
	text := formatExportCellText(val)
	escaped := html.EscapeString(text)
	escaped = strings.ReplaceAll(escaped, "\r\n", "\n")
	escaped = strings.ReplaceAll(escaped, "\r", "\n")
	return strings.ReplaceAll(escaped, "\n", "<br>")
}

func writeRowsToHTML(f *os.File, data []map[string]interface{}, columns []string) error {
	w := bufio.NewWriterSize(f, 1024*256)

	if _, err := w.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GoNavi Export</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8f9fa;
      --card: #ffffff;
      --line: #dee2e6;
      --text: #212529;
      --muted: #6c757d;
      --hover: #f1f3f5;
      --zebra: #f8f9fa;
      --head: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
    }
    .export-wrap {
      max-width: 100%;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .export-head {
      padding: 16px 20px;
      background: var(--head);
      border-bottom: 2px solid var(--line);
    }
    .export-head h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
    }
    .export-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .table-wrap {
      width: 100%;
      overflow: auto;
      padding: 16px;
    }
    table {
      border-collapse: collapse;
      width: auto;
      font-size: 13px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--head);
      text-align: left;
      font-weight: 600;
      white-space: nowrap;
      border-bottom: 2px solid var(--line);
      color: var(--text);
      padding: 12px 16px;
    }
    td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      max-width: 500px;
      color: var(--text);
    }
    tbody tr:nth-child(even) {
      background: var(--zebra);
    }
    tbody tr:hover {
      background: var(--hover);
    }
    td.empty {
      text-align: center;
      color: var(--muted);
      font-style: italic;
    }
    @media (max-width: 768px) {
      body { padding: 16px; }
      .export-head { padding: 12px 16px; }
      .table-wrap { padding: 12px; }
      th, td { padding: 8px 12px; font-size: 12px; }
    }
    @media print {
      body { background: white; padding: 0; }
      .export-wrap { border: none; }
    }
  </style>
</head>
<body>
  <div class="export-wrap">
    <div class="export-head">
      <h1>GoNavi Data Export</h1>
      <div class="export-meta">`); err != nil {
		return err
	}

	if _, err := fmt.Fprintf(w, "Rows: %d · Columns: %d · Generated: %s", len(data), len(columns), time.Now().Format("2006-01-02 15:04:05")); err != nil {
		return err
	}

	if _, err := w.WriteString(`</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>`); err != nil {
		return err
	}

	for _, col := range columns {
		if _, err := fmt.Fprintf(w, "<th>%s</th>", html.EscapeString(col)); err != nil {
			return err
		}
	}

	if _, err := w.WriteString(`</tr></thead><tbody>`); err != nil {
		return err
	}

	if len(data) == 0 {
		colspan := len(columns)
		if colspan <= 0 {
			colspan = 1
		}
		if _, err := fmt.Fprintf(w, `<tr><td class="empty" colspan="%d">(0 rows)</td></tr>`, colspan); err != nil {
			return err
		}
	} else {
		for _, rowMap := range data {
			if _, err := w.WriteString("<tr>"); err != nil {
				return err
			}
			for _, col := range columns {
				if _, err := fmt.Fprintf(w, "<td>%s</td>", formatExportHTMLCell(rowMap[col])); err != nil {
					return err
				}
			}
			if _, err := w.WriteString("</tr>"); err != nil {
				return err
			}
		}
	}

	if _, err := w.WriteString(`</tbody></table>
    </div>
  </div>
</body>
</html>`); err != nil {
		return err
	}

	return w.Flush()
}

func formatExportCellText(val interface{}) string {
	if val == nil {
		return ""
	}

	switch v := val.(type) {
	case time.Time:
		return v.Format("2006-01-02 15:04:05")
	case *time.Time:
		if v == nil {
			return ""
		}
		return v.Format("2006-01-02 15:04:05")
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(f, 'f', -1, 32)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		text := strings.TrimSpace(v.String())
		if text == "" {
			return "NULL"
		}
		return text
	case string:
		return normalizeExportTemporalText(v)
	default:
		text := fmt.Sprintf("%v", val)
		return normalizeExportTemporalText(text)
	}
}

func normalizeExportJSONValue(val interface{}) interface{} {
	if val == nil {
		return nil
	}

	switch v := val.(type) {
	case time.Time:
		return v.Format("2006-01-02 15:04:05")
	case *time.Time:
		if v == nil {
			return nil
		}
		return v.Format("2006-01-02 15:04:05")
	case string:
		return normalizeExportTemporalText(v)
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		return json.Number(strconv.FormatFloat(f, 'f', -1, 32))
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return json.Number(strconv.FormatFloat(v, 'f', -1, 64))
	case json.Number:
		text := strings.TrimSpace(v.String())
		if text == "" {
			return nil
		}
		return json.Number(text)
	case map[string]interface{}:
		out := make(map[string]interface{}, len(v))
		for key, item := range v {
			out[key] = normalizeExportJSONValue(item)
		}
		return out
	case []interface{}:
		items := make([]interface{}, len(v))
		for i, item := range v {
			items[i] = normalizeExportJSONValue(item)
		}
		return items
	}

	rv := reflect.ValueOf(val)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		return normalizeExportJSONValue(rv.Elem().Interface())
	case reflect.Map:
		if rv.IsNil() {
			return nil
		}
		out := make(map[string]interface{}, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			out[fmt.Sprint(iter.Key().Interface())] = normalizeExportJSONValue(iter.Value().Interface())
		}
		return out
	case reflect.Slice:
		if rv.IsNil() {
			return nil
		}
		if rv.Type().Elem().Kind() == reflect.Uint8 {
			return val
		}
		fallthrough
	case reflect.Array:
		size := rv.Len()
		items := make([]interface{}, size)
		for i := 0; i < size; i++ {
			items[i] = normalizeExportJSONValue(rv.Index(i).Interface())
		}
		return items
	default:
		return val
	}
}

// writeRowsToXlsx 使用 excelize 写入真正的 xlsx 格式文件
func writeRowsToXlsx(filename string, data []map[string]interface{}, columns []string) (err error) {
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := file.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	writer, err := newXLSXExportFileWriter(file, 0)
	if err != nil {
		return err
	}
	if err := writer.SetColumns(columns); err != nil {
		return err
	}
	for _, rowMap := range data {
		if err := writer.ConsumeRow(rowMap); err != nil {
			return err
		}
	}
	return writer.Close()
}
