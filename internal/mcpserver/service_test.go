package mcpserver

import (
	"context"
	"sync/atomic"

	"GoNavi-Wails/internal/ai"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
)

type fakeBackend struct {
	savedConnections      []connection.SavedConnectionView
	savedConnectionsErr   error
	editableConnection    connection.SavedConnectionView
	editableErr           error
	databasesResult       connection.QueryResult
	tablesResult          connection.QueryResult
	viewsResult           connection.QueryResult
	objectsResult         connection.QueryResult
	allColumnsResult      connection.QueryResult
	columnsResult         connection.QueryResult
	indexesResult         connection.QueryResult
	foreignKeysResult     connection.QueryResult
	triggersResult        connection.QueryResult
	ddlResult             connection.QueryResult
	serverVersionResult   connection.QueryResult
	queryResult           connection.QueryResult
	inspection            appcore.SQLInspection
	safetyLevel           ai.SQLPermissionLevel
	maskingSettings       ai.ResultMaskingSettings
	maskingSettingsErr    error
	queryCalled           bool
	queryContext          context.Context
	queryMaxRowsPerResult int
	authorizeErr          error
	authorizeCalls        int
	authorizedConfig      connection.ConnectionConfig
	authorizedSQL         string
	events                []string
}

type cancellableTablesBackend struct {
	*fakeBackend
	started chan struct{}
	calls   atomic.Int32
}

func (b *cancellableTablesBackend) DBGetTables(ctx context.Context, _ connection.ConnectionConfig, _ string) connection.QueryResult {
	if b.calls.Add(1) > 1 {
		return b.tablesResult
	}
	select {
	case b.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return connection.QueryResult{Success: false, Message: ctx.Err().Error()}
}

type cancellableViewsBackend struct {
	*fakeBackend
	started chan struct{}
}

type cancellableColumnsBackend struct {
	*fakeBackend
	started chan struct{}
}

type resolvedDialectBackend struct {
	*fakeBackend
	effectiveDialect string
}

func (b *resolvedDialectBackend) ExecuteAuthorizedSQLFromMCP(ctx context.Context, _ string, _ connection.ConnectionConfig, _ string, _ string, _ bool, maxRowsPerResult int) (connection.QueryResult, string) {
	b.queryCalled = true
	b.queryContext = ctx
	b.queryMaxRowsPerResult = maxRowsPerResult
	b.events = append(b.events, "query")
	return b.queryResult, b.effectiveDialect
}

func (b *cancellableViewsBackend) DBGetViews(ctx context.Context, _ connection.ConnectionConfig, _ string) connection.QueryResult {
	select {
	case b.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return connection.QueryResult{Success: false, Message: ctx.Err().Error()}
}

func (b *cancellableColumnsBackend) DBGetColumns(ctx context.Context, _ connection.ConnectionConfig, _ string, _ string) connection.QueryResult {
	select {
	case b.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return connection.QueryResult{Success: false, Message: ctx.Err().Error()}
}

func (f *fakeBackend) Close(context.Context) error {
	return nil
}

func (f *fakeBackend) GetSavedConnections() ([]connection.SavedConnectionView, error) {
	return f.savedConnections, f.savedConnectionsErr
}

func (f *fakeBackend) GetEditableSavedConnection(id string) (connection.SavedConnectionView, error) {
	return f.editableConnection, f.editableErr
}

func (f *fakeBackend) DBGetDatabases(context.Context, connection.ConnectionConfig) connection.QueryResult {
	return f.databasesResult
}

func (f *fakeBackend) DBGetTables(context.Context, connection.ConnectionConfig, string) connection.QueryResult {
	return f.tablesResult
}

func (f *fakeBackend) DBGetViews(context.Context, connection.ConnectionConfig, string) connection.QueryResult {
	return f.viewsResult
}

func (f *fakeBackend) DBGetObjects(context.Context, connection.ConnectionConfig, string) connection.QueryResult {
	return f.objectsResult
}

func (f *fakeBackend) DBGetAllColumns(context.Context, connection.ConnectionConfig, string) connection.QueryResult {
	return f.allColumnsResult
}

func (f *fakeBackend) DBGetColumns(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult {
	return f.columnsResult
}

func (f *fakeBackend) DBGetIndexes(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult {
	return f.indexesResult
}

func (f *fakeBackend) DBGetForeignKeys(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult {
	return f.foreignKeysResult
}

func (f *fakeBackend) DBGetTriggers(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult {
	return f.triggersResult
}

func (f *fakeBackend) DBShowCreateTable(context.Context, connection.ConnectionConfig, string, string) connection.QueryResult {
	return f.ddlResult
}

func (f *fakeBackend) DBGetServerVersion(context.Context, connection.ConnectionConfig) connection.QueryResult {
	if f.serverVersionResult.Success || f.serverVersionResult.Message != "" || f.serverVersionResult.Data != nil {
		return f.serverVersionResult
	}
	return connection.QueryResult{Success: true, Message: "", Data: []map[string]interface{}{}}
}

func (f *fakeBackend) ExecuteSQLFromMCP(ctx context.Context, config connection.ConnectionConfig, dbName string, query string, maxRowsPerResult int) connection.QueryResult {
	f.queryCalled = true
	f.queryContext = ctx
	f.queryMaxRowsPerResult = maxRowsPerResult
	f.events = append(f.events, "query")
	return f.queryResult
}

func (f *fakeBackend) InspectSQL(dbType string, sql string) appcore.SQLInspection {
	return f.inspection
}

func (f *fakeBackend) GetSQLSafetyLevel() ai.SQLPermissionLevel {
	if f.safetyLevel == "" {
		return ai.PermissionReadOnly
	}
	return f.safetyLevel
}

func (f *fakeBackend) GetResultMaskingSettings() (ai.ResultMaskingSettings, error) {
	return f.maskingSettings, f.maskingSettingsErr
}

func (f *fakeBackend) AuthorizeSQLConnection(config connection.ConnectionConfig, sql string) error {
	f.authorizeCalls++
	f.authorizedConfig = config
	f.authorizedSQL = sql
	f.events = append(f.events, "authorize")
	return f.authorizeErr
}
