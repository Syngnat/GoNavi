package app

import (
	"context"
	"regexp"
	"time"

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

type SQLDirectoryEntry struct {
	Name     string              `json:"name"`
	Path     string              `json:"path"`
	IsDir    bool                `json:"isDir"`
	Children []SQLDirectoryEntry `json:"children,omitempty"`
}
