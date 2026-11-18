// Package rpctimeout names App methods whose RPC response can legitimately
// outlive ordinary HTTP / detached-window timeouts.
package rpctimeout

// IsLongRunningAppMethod reports whether a Wails/Web App method may wait on a
// database or import job until the caller cancels it. These methods must not
// inherit the one-minute HTTP WriteTimeout or the detached-window 30s RPC
// deadline; progress is pushed on a separate event stream.
func IsLongRunningAppMethod(method string) bool {
	switch method {
	case "DBQuery",
		"DBQueryApplicationWithCancel",
		"DBQueryWithCancel",
		"DBQueryMulti",
		"DBQueryMultiCompact",
		"DBQueryMultiWithOptions",
		"DBQueryMultiWithOptionsCompact",
		"DBQueryMultiWithParams",
		"DBQueryMultiWithParamsInTransaction",
		"DBQueryMultiTransactional",
		"DBQueryMultiTransactionalWithParams",
		"DBQueryMultiTransactionalWithOptions",
		"DBQueryMultiInTransaction",
		"DBQueryMultiInTransactionWithOptions",
		"DBQueryAudited",
		"DBQueryAI",
		"DBQueryIsolated",
		"MySQLQuery",
		"ExecuteElasticsearchConsole",
		"ExecuteSQLFile",
		"ImportDatabaseSQL",
		"ImportDatabaseSQLWithOptions",
		"ImportDataWithProgress",
		"ImportDataWithProgressOptions",
		"ResumeImportJob",
		"RetryImportJobFailedRows",
		"MockDataGenerate",
		"BackgroundGalleryRefresh",
		"BackgroundGalleryDownload",
		"FontGalleryRefresh",
		"FontGalleryDownload",
		"FontGalleryPreview",
		"DataSyncJobPreflight",
		"DataSyncJobApprovalBegin",
		"DataSyncJobApprove",
		"DataSyncJobSave",
		"DataSync":
		return true
	default:
		return false
	}
}
