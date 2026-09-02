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
	ExecuteSQLFromMCP(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult
	InspectSQL(dbType string, sql string) appcore.SQLInspection
	GetSQLSafetyLevel() ai.SQLPermissionLevel
	AuthorizeSQLConnection(config connection.ConnectionConfig, sql string) error
}

// executionAuthorizingBackend is intentionally optional for non-App backend
// implementations. Production AppBackend uses it to close the gap between the
// service's presentation-time policy check and database dispatch.
type executionAuthorizingBackend interface {
	ExecuteAuthorizedSQLFromMCP(context.Context, string, connection.ConnectionConfig, string, string, bool) connection.QueryResult
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
	return &AppBackend{app: a, mcpQueryExecutor: appcore.NewMCPQueryExecutor(a)}, nil
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

// ExecuteAuthorizedSQLFromMCP resolves the saved connection and checks its
// current protections immediately before dispatching SQL. The service's
// earlier display snapshot is not trusted for this authorization boundary.
func (b *AppBackend) ExecuteSQLFromMCP(ctx context.Context, config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	return b.executeAuthorizedSQLFromMCP(ctx, strings.TrimSpace(config.ID), config, dbName, query, true)
}

// ExecuteAuthorizedSQLFromMCP is the explicit authorization-bound entry point
// used by Service. It re-reads the saved connection immediately before SQL is
// dispatched, closing the stale-view TOCTOU window.
func (b *AppBackend) ExecuteAuthorizedSQLFromMCP(ctx context.Context, connectionID string, config connection.ConnectionConfig, dbName string, query string, allowMutating bool) connection.QueryResult {
	return b.executeAuthorizedSQLFromMCP(ctx, strings.TrimSpace(connectionID), config, dbName, query, allowMutating)
}

func (b *AppBackend) executeAuthorizedSQLFromMCP(ctx context.Context, connectionID string, config connection.ConnectionConfig, dbName string, query string, allowMutating bool) connection.QueryResult {
	if b == nil || b.mcpQueryExecutor == nil {
		return connection.QueryResult{Success: false, Message: "MCP backend is unavailable"}
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return connection.QueryResult{Success: false, Message: "MCP saved connection ID is required"}
	}
	config.ID = connectionID
	return b.mcpQueryExecutor.DBQueryMultiAuthorizedContext(ctx, config, dbName, query, allowMutating)
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

func (b *AppBackend) AuthorizeSQLConnection(config connection.ConnectionConfig, sql string) error {
	if b == nil || b.app == nil {
		return fmt.Errorf("MCP backend is unavailable")
	}
	return b.app.AuthorizeMCPConnectionSQL(config, sql)
}
