package webserver

import (
	"fmt"
	"reflect"
	"slices"
	"strings"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/webidentity"
)

// viewerAllowedAppExact 是只读角色可以精确调用的 App 方法。
// 只读角色走白名单而不是黑名单：新增的写方法默认对 viewer 关闭。
var viewerAllowedAppExact = map[string]struct{}{
	"GetAppInfo":                      {},
	"GetBrandIconDataURL":             {},
	"GetSavedConnections":             {},
	"GetSavedQueries":                 {},
	"GetSavedQueryGroups":             {},
	"GetUnboundSavedQueries":          {},
	"GetSQLAuditEvents":               {},
	"GetSQLAuditHealth":               {},
	"GetSQLAuditSettings":             {},
	"GetSlowQueries":                  {},
	"GetSavedConnectionsHealthRun":    {},
	"GetDriverStatusList":             {},
	"GetDriverVersionList":            {},
	"GetDriverVersionPackageSize":     {},
	"GetDownloadSourceConfig":         {},
	"GetImportJob":                    {},
	"GetUpdateChannel":                {},
	"GetSecurityUpdateStatus":         {},
	"GetUpdateDownloadTask":           {},
	"GetRequestDiagnostic":            {},
	"GetRequestDiagnostics":           {},
	"GetDMLSnapshot":                  {},
	"ListImportJobs":                  {},
	"ListDriverDownloadTasks":         {},
	"ListInstalledFontFamilies":       {},
	"ListDMLSnapshots":                {},
	"DiagnoseQuery":                   {},
	"DiagnoseQueryWithOptions":        {},
	"AnalyzeQueryParameters":          {},
	"InspectSavedConnectionHealth":    {},
	"InspectSavedConnectionsHealth":   {},
	"InspectElasticsearchConsole":     {},
	"UserMgmtOverview":                {},
	"UserMgmtDescribePrincipal":       {},
	"DataSourceCapability":            {},
	"DataImportCapability":            {},
	"DataSyncCapability":              {},
	"MockDataInspect":                 {},
	"MockDataPreview":                 {},
	"CloudBackupGetConfig":            {},
	"CloudBackupGetStatus":            {},
	"CloudBackupListRestorePoints":    {},
	"CloudBackupPreviewRestore":       {},
	"ExportQuery":                     {},
	"ExportQueryWithOptions":          {},
	"ExportData":                      {},
	"ExportDataWithOptions":           {},
	"ExportTable":                     {},
	"ExportTableWithOptions":          {},
	"ExportDatabaseSQL":               {},
	"ExportDatabaseSQLWithOptions":    {},
	"ExportDatabasesSQLWithOptions":   {},
	"ExportSchemaSQL":                 {},
	"ExportSchemaSQLWithOptions":      {},
	"ExportTablesSQL":                 {},
	"ExportTablesSQLWithOptions":      {},
	"ExportTablesDataSQL":             {},
	"ExportImportErrorRows":           {},
	"ExportSQLAuditFile":              {},
	"BuildSQLAuditExport":             {},
	"VerifySQLAuditIntegrity":         {},
	"CancelQuery":                     {},
	"CancelConnectionTest":            {},
	"GenerateQueryID":                 {},
	"TestConnection":                  {},
	"TestConnectionWithProgress":      {},
	"NacosTestConnection":             {},
	"NacosTestConnectionWithProgress": {},
	"RedisTestConnection":             {},
	"XxlJobTestConnection":            {},
	"PreviewChanges":                  {},
	"ListDatabaseCharsets":            {},
	"ListDatabaseCollations":          {},
	"ListDuckDBAttachedDatasources":   {},
	"CheckDriverNetworkStatus":        {},
}

// viewerAllowedAppPrefix 是只读角色可以调用的只读方法前缀。
var viewerAllowedAppPrefix = []string{
	"DBGet",
	"DBList",
	"DBQuery",
	"DBShowCreateTable",
	"DBTableExists",
	"MySQLGet",
	"MySQLShowCreateTable",
	"MongoDiscoverMembers",
	"DataSyncDatabaseList",
	"DataSyncObjectList",
	"DataSyncFieldList",
	"DataSyncCapability",
	"DataSyncCDC",
	"DataSyncJobList",
	"DataSyncJobGet",
	"DataSyncJobPreflight",
	"DataSyncRunGet",
	"DataSyncRunList",
	"DataSyncRunPage",
	"DataSyncRunEventList",
	"DataSyncErrorRowList",
	"DataSyncErrorRowGet",
	"DataSyncCheckpointGet",
	"DataSyncAnalyze",
	"DataSyncPreview",
	"DataSyncSchedulePreview",
}

// viewerAllowedInvoke 判断只读角色能否调用某个 RPC。
// 非 app 命名空间（例如 AI 服务）默认拒绝：其内部工具可能直接执行 SQL。
func viewerAllowedInvoke(target string, method string) bool {
	if target != "app" {
		return false
	}
	if _, ok := viewerAllowedAppExact[method]; ok {
		return true
	}
	for _, prefix := range viewerAllowedAppPrefix {
		if strings.HasPrefix(method, prefix) {
			return true
		}
	}
	return false
}

// enforceViewerPolicy 在反射调用前做两件事：
// 1. 拒绝不在只读白名单里的方法；
// 2. 把所有 connection.ConnectionConfig 参数强制为只读。
//
// 只读参数是第二道防线：即使白名单出现漏网方法，App 层的
// ensureConnectionAllowsQuery 仍会拦下写 SQL。
func enforceViewerPolicy(actor webidentity.Actor, target string, method string, args []reflect.Value) error {
	if !viewerAllowedInvoke(target, method) {
		return fmt.Errorf("read-only user cannot perform this action")
	}
	for _, arg := range args {
		if !arg.IsValid() {
			continue
		}
		value := arg
		if value.Kind() == reflect.Pointer {
			if value.IsNil() {
				continue
			}
			value = value.Elem()
		}
		if value.Type() != reflect.TypeOf(connection.ConnectionConfig{}) {
			continue
		}
		config := value.Interface().(connection.ConnectionConfig)
		if !appcore.SupportsConnectionReadOnlyMode(config) {
			return fmt.Errorf("read-only user cannot use data source %q", strings.TrimSpace(config.Type))
		}
		if len(actor.AllowedConnectionIDs) > 0 {
			connectionID := strings.TrimSpace(config.ID)
			if connectionID == "" || !slices.Contains(actor.AllowedConnectionIDs, connectionID) {
				return fmt.Errorf("connection %q is not allowed for this user", connectionID)
			}
		}
		config.ReadOnly = true
		config.Protection = connection.ConnectionProtectionConfig{
			RestrictDataEdit:        true,
			RestrictStructureEdit:   true,
			RestrictScriptExecution: true,
			RestrictDataImport:      true,
		}
		value.Set(reflect.ValueOf(config))
	}
	return nil
}
