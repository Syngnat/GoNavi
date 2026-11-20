package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/requesttrace"
	"GoNavi-Wails/internal/scriptlib"
)

// Backend 抽象 GoNavi 后端能力，便于复用真实 App 和单元测试替身。
type Backend interface {
	Close(context.Context) error
	GetSavedConnections() ([]connection.SavedConnectionView, error)
	GetEditableSavedConnection(id string) (connection.SavedConnectionView, error)
	DBGetDatabases(context.Context, connection.ConnectionConfig) connection.QueryResult
	DBGetTables(context.Context, connection.ConnectionConfig, string) connection.QueryResult
	DBGetViews(context.Context, connection.ConnectionConfig, string) connection.QueryResult
	DBGetObjects(context.Context, connection.ConnectionConfig, string) connection.QueryResult
	DBGetAllColumns(context.Context, connection.ConnectionConfig, string) connection.QueryResult
	DBGetColumns(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult
	DBGetIndexes(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult
	DBGetForeignKeys(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult
	DBGetTriggers(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult
	DBShowCreateTable(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult
	DBGetServerVersion(context.Context, connection.ConnectionConfig) connection.QueryResult
	ExecuteSQLFromMCP(context.Context, connection.ConnectionConfig, string, string, int) connection.QueryResult
	InspectSQL(dbType string, sql string) appcore.SQLInspection
	GetSQLSafetyLevel() ai.SQLPermissionLevel
	GetResultMaskingSettings() (ai.ResultMaskingSettings, error)
	AuthorizeSQLConnection(config connection.ConnectionConfig, sql string) error
	GetScriptLibrarySnapshot(context.Context) connection.QueryResult
	SaveScriptLibraryScript(context.Context, scriptlib.SaveScriptInput) connection.QueryResult
	PrepareScriptWorkbenchWrite(context.Context, appcore.ScriptWorkbenchRunRequest) connection.QueryResult
	RunScriptWorkbench(context.Context, appcore.ScriptWorkbenchRunRequest) connection.QueryResult
	GetScriptWorkbenchRun(context.Context, string) connection.QueryResult
	GetScriptWorkbenchOutput(context.Context, string, int, int, int) connection.QueryResult
	CancelScriptWorkbenchRun(context.Context, string) connection.QueryResult
	ListScriptInputSheets(context.Context, appcore.ScriptWorkbenchInput) connection.QueryResult
}

// executionAuthorizingBackend is intentionally optional for non-App backend
// implementations. Production AppBackend uses it to close the gap between the
// service's presentation-time policy check and database dispatch.
type executionAuthorizingBackend interface {
	ExecuteAuthorizedSQLFromMCP(context.Context, string, connection.ConnectionConfig, string, string, bool, int) (connection.QueryResult, string)
}

// AppBackend 基于现有 internal/app.App 暴露 MCP 所需数据库能力。
type AppBackend struct {
	app              *appcore.App
	mcpQueryExecutor *appcore.MCPQueryExecutor
	ownsApp          bool
	// configDir is kept alongside the App so callers that explicitly select a
	// data root (notably the agent CLI) read the matching AI safety policy. The
	// previous implementation consulted the process-global active root here,
	// which could silently authorize against a different profile.
	configDir string
}

func NewAppBackend(ctx context.Context) (*AppBackend, error) {
	return NewAppBackendWithDataRoot(ctx, "")
}

// NewAppBackendWithDataRoot creates a headless backend rooted at dataRoot.
// An empty root preserves the normal active-root resolution rules.
func NewAppBackendWithDataRoot(ctx context.Context, dataRoot string) (*AppBackend, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	root := strings.TrimSpace(dataRoot)
	var err error
	if root == "" {
		root, err = appdata.ResolveActiveRoot()
	} else {
		root, err = appdata.ResolveRoot(root)
	}
	if err != nil {
		return nil, err
	}
	a, err := appcore.NewHeadlessApp(ctx, root)
	if err != nil {
		return nil, err
	}
	return &AppBackend{app: a, mcpQueryExecutor: appcore.NewMCPQueryExecutor(a), ownsApp: true, configDir: root}, nil
}

// NewAppBackendFromApp borrows the desktop application's initialized runtime.
// The returned backend never shuts the App down; lifecycle ownership remains
// with the Wails host. This keeps desktop Agent tools on the same connection
// cache, saved-connection store and query audit path as the rest of the app.
func NewAppBackendFromApp(a *appcore.App) (*AppBackend, error) {
	if a == nil {
		return nil, fmt.Errorf("GoNavi App is required")
	}
	return &AppBackend{
		app:              a,
		mcpQueryExecutor: appcore.NewMCPQueryExecutor(a),
		configDir:        appcore.ConfigDirForIntegration(a),
	}, nil
}

func (b *AppBackend) Close(ctx context.Context) error {
	if b == nil || b.app == nil || !b.ownsApp {
		return nil
	}
	b.app.Shutdown()
	return nil
}

func (b *AppBackend) RequestTraceStore() *requesttrace.Store {
	if b == nil || b.app == nil {
		return nil
	}
	return appcore.RequestTraceStoreForEntryPoint(b.app)
}

func (b *AppBackend) GetSavedConnections() ([]connection.SavedConnectionView, error) {
	return b.app.GetSavedConnections()
}

func (b *AppBackend) GetEditableSavedConnection(id string) (connection.SavedConnectionView, error) {
	return b.app.GetEditableSavedConnection(id)
}

func (b *AppBackend) DBGetDatabases(ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
	return b.app.DBGetDatabasesContext(ctx, config)
}

func (b *AppBackend) DBGetTables(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return b.app.DBGetTablesContext(ctx, config, dbName)
}

func (b *AppBackend) DBGetViews(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return b.app.DBGetViewsContext(ctx, config, dbName)
}

func (b *AppBackend) DBGetObjects(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return b.app.DBGetObjectsContext(ctx, config, dbName)
}

func (b *AppBackend) DBGetAllColumns(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return b.app.DBGetAllColumnsContext(ctx, config, dbName)
}

func (b *AppBackend) DBGetColumns(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return b.app.DBGetColumnsContext(ctx, config, dbName, tableName)
}

func (b *AppBackend) DBGetIndexes(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return b.app.DBGetIndexesContext(ctx, config, dbName, tableName)
}

func (b *AppBackend) DBGetForeignKeys(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return b.app.DBGetForeignKeysContext(ctx, config, dbName, tableName)
}

func (b *AppBackend) DBGetTriggers(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return b.app.DBGetTriggersContext(ctx, config, dbName, tableName)
}

func (b *AppBackend) DBShowCreateTable(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return b.app.DBShowCreateTableContext(ctx, config, dbName, tableName)
}

func (b *AppBackend) DBGetServerVersion(ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
	return b.app.DBGetServerVersionContext(ctx, config)
}

// ExecuteAuthorizedSQLFromMCP resolves the saved connection and checks its
// current protections immediately before dispatching SQL. The service's
// earlier display snapshot is not trusted for this authorization boundary.
// maxRowsPerResult 限制每个结果集的物化行数（0 表示不限制）。
func (b *AppBackend) ExecuteSQLFromMCP(ctx context.Context, config connection.ConnectionConfig, dbName string, query string, maxRowsPerResult int) connection.QueryResult {
	result, _ := b.executeAuthorizedSQLFromMCP(ctx, strings.TrimSpace(config.ID), config, dbName, query, true, maxRowsPerResult)
	return result
}

// ExecuteAuthorizedSQLFromMCP is the explicit authorization-bound entry point
// used by Service. It re-reads the saved connection immediately before SQL is
// dispatched, closing the stale-view TOCTOU window.
func (b *AppBackend) ExecuteAuthorizedSQLFromMCP(ctx context.Context, connectionID string, config connection.ConnectionConfig, dbName string, query string, allowMutating bool, maxRowsPerResult int) (connection.QueryResult, string) {
	return b.executeAuthorizedSQLFromMCP(ctx, strings.TrimSpace(connectionID), config, dbName, query, allowMutating, maxRowsPerResult)
}

func (b *AppBackend) executeAuthorizedSQLFromMCP(ctx context.Context, connectionID string, config connection.ConnectionConfig, dbName string, query string, allowMutating bool, maxRowsPerResult int) (connection.QueryResult, string) {
	if b == nil || b.mcpQueryExecutor == nil {
		return connection.QueryResult{Success: false, Message: "MCP backend is unavailable"}, ""
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return connection.QueryResult{Success: false, Message: "MCP saved connection ID is required"}, ""
	}
	config.ID = connectionID
	return b.mcpQueryExecutor.DBQueryMultiAuthorizedContextWithDialect(ctx, config, dbName, query, allowMutating, maxRowsPerResult)
}

func (b *AppBackend) InspectSQL(dbType string, sql string) appcore.SQLInspection {
	return appcore.InspectSQL(dbType, sql)
}

func (b *AppBackend) GetSQLSafetyLevel() ai.SQLPermissionLevel {
	configDir := ""
	if b != nil {
		configDir = strings.TrimSpace(b.configDir)
	}
	if configDir == "" {
		configDir = appdata.MustResolveActiveRoot()
	}
	inspection, err := aiservice.NewProviderConfigStore(configDir, nil).Inspect()
	if err != nil {
		logger.Error(err, "加载 MCP SQL 安全控制失败，按只读模式回退")
		return ai.PermissionReadOnly
	}

	switch inspection.Snapshot.SafetyLevel {
	case ai.PermissionReadOnly, ai.PermissionReadWrite, ai.PermissionFull:
		return inspection.Snapshot.SafetyLevel
	default:
		return ai.PermissionReadOnly
	}
}

func (b *AppBackend) GetResultMaskingSettings() (ai.ResultMaskingSettings, error) {
	configDir := ""
	if b != nil {
		configDir = strings.TrimSpace(b.configDir)
	}
	if configDir == "" {
		configDir = appdata.MustResolveActiveRoot()
	}
	inspection, err := aiservice.NewProviderConfigStore(configDir, nil).Inspect()
	if err != nil {
		return ai.ResultMaskingSettings{}, err
	}
	return ai.NormalizeResultMaskingSettings(inspection.Snapshot.ResultMasking), nil
}

func (b *AppBackend) AuthorizeSQLConnection(config connection.ConnectionConfig, sql string) error {
	if b == nil || b.app == nil {
		return fmt.Errorf("MCP backend is unavailable")
	}
	return b.app.AuthorizeMCPConnectionSQL(config, sql)
}

func (b *AppBackend) GetScriptLibrarySnapshot(ctx context.Context) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.GetScriptLibrarySnapshot()
}

func (b *AppBackend) SaveScriptLibraryScript(ctx context.Context, input scriptlib.SaveScriptInput) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.SaveScriptLibraryScript(input)
}

func (b *AppBackend) PrepareScriptWorkbenchWrite(ctx context.Context, request appcore.ScriptWorkbenchRunRequest) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.PrepareScriptWorkbenchWrite(b.scriptRequestWithPolicy(request))
}

func (b *AppBackend) RunScriptWorkbench(ctx context.Context, request appcore.ScriptWorkbenchRunRequest) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.RunScriptWorkbench(b.scriptRequestWithPolicy(request))
}

func (b *AppBackend) GetScriptWorkbenchRun(ctx context.Context, runID string) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.GetScriptWorkbenchRun(runID)
}

func (b *AppBackend) GetScriptWorkbenchOutput(ctx context.Context, runID string, outputIndex int, page int, pageSize int) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.GetScriptWorkbenchOutput(runID, outputIndex, page, pageSize)
}

func (b *AppBackend) CancelScriptWorkbenchRun(ctx context.Context, runID string) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.CancelScriptWorkbenchRun(runID)
}

func (b *AppBackend) ListScriptInputSheets(ctx context.Context, input appcore.ScriptWorkbenchInput) connection.QueryResult {
	if result, ok := checkMCPContext(ctx); !ok {
		return result
	}
	if b == nil || b.app == nil {
		return mcpScriptBackendUnavailable()
	}
	return b.app.ListScriptInputSheets(input)
}

func (b *AppBackend) scriptRequestWithPolicy(request appcore.ScriptWorkbenchRunRequest) appcore.ScriptWorkbenchRunRequest {
	level := normalizeSQLSafetyLevel(b.GetSQLSafetyLevel())
	policy := appcore.ScriptWorkbenchExecutionPolicy{
		AllowWrites: level == ai.PermissionReadWrite || level == ai.PermissionFull,
		AllowDDL:    level == ai.PermissionFull,
	}
	request.ExecutionPolicy = &policy
	return request
}

func checkMCPContext(ctx context.Context) (connection.QueryResult, bool) {
	if ctx == nil {
		return connection.QueryResult{Success: false, Message: "MCP request context is required"}, false
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}, false
	}
	return connection.QueryResult{}, true
}

func mcpScriptBackendUnavailable() connection.QueryResult {
	return connection.QueryResult{Success: false, Message: "script workbench is unavailable"}
}
