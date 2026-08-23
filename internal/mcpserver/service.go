package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"GoNavi-Wails/internal/ai"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	// 默认/上限刻意压低：MCP 只用于「少量样例数据」探查，避免把大结果集灌进 Agent 上下文。
	defaultMaxRowsPerResult = 50
	maxRowsPerResultLimit   = 200
	redactedOpaqueTarget    = "opaque-connection-string-configured"
)

type Service struct {
	backend Backend
}

func NewService(backend Backend) *Service {
	return &Service{backend: backend}
}

type emptyArgs struct{}

type connectionIDArgs struct {
	ConnectionID string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
}

type databaseArgs struct {
	ConnectionID string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName       string `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
}

type objectsArgs struct {
	ConnectionID string   `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName       string   `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
	ObjectTypes  []string `json:"objectTypes,omitempty" jsonschema:"可选对象类型过滤，例如 table、view、function、procedure、package、queue、topic、exchange。为空返回全部支持对象"`
}

type tableArgs struct {
	ConnectionID string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName       string `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
	TableName    string `json:"tableName" jsonschema:"目标表或视图名称"`
}

type executeSQLArgs struct {
	ConnectionID     string `json:"connectionId" jsonschema:"get_connections 返回的连接 ID"`
	DBName           string `json:"dbName,omitempty" jsonschema:"可选数据库/Schema 名称。为空时优先使用保存连接里的默认数据库"`
	SQL              string `json:"sql" jsonschema:"待执行的 SQL 文本，可以包含多条语句"`
	AllowMutating    bool   `json:"allowMutating,omitempty" jsonschema:"当 SQL 包含当前 AI 安全控制允许范围内的 DDL/DML 等非只读语句时，必须显式设为 true"`
	MaxRowsPerResult int    `json:"maxRowsPerResult,omitempty" jsonschema:"每个结果集最多返回多少行。默认 50，最大 200（少量数据探查）"`
}

type connectionDescriptor struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Host            string `json:"host,omitempty"`
	Port            int    `json:"port,omitempty"`
	Database        string `json:"database,omitempty"`
	Driver          string `json:"driver,omitempty"`
	Topology        string `json:"topology,omitempty"`
	Target          string `json:"target,omitempty"`
	UseSSH          bool   `json:"useSSH,omitempty"`
	UseProxy        bool   `json:"useProxy,omitempty"`
	UseHTTPTunnel   bool   `json:"useHttpTunnel,omitempty"`
	DefaultDatabase string `json:"defaultDatabase,omitempty"`
}

type getConnectionsResult struct {
	Connections []connectionDescriptor `json:"connections"`
}

type getDatabasesResult struct {
	ConnectionID string   `json:"connectionId"`
	Databases    []string `json:"databases"`
}

type getTablesResult struct {
	ConnectionID string   `json:"connectionId"`
	DBName       string   `json:"dbName,omitempty"`
	Tables       []string `json:"tables"`
	Views        []string `json:"views"`
	Message      string   `json:"message,omitempty"`
	Partial      bool     `json:"partial,omitempty"`
	Warnings     []string `json:"warnings,omitempty"`
	Retryable    bool     `json:"retryable,omitempty"`
	Truncated    bool     `json:"truncated,omitempty"`
	ScannedCount int      `json:"scannedCount,omitempty"`
}

type getViewsResult struct {
	ConnectionID string   `json:"connectionId"`
	DBName       string   `json:"dbName,omitempty"`
	Views        []string `json:"views"`
}

type getObjectsResult struct {
	ConnectionID      string                      `json:"connectionId"`
	DBName            string                      `json:"dbName,omitempty"`
	Objects           []connection.DatabaseObject `json:"objects"`
	Message           string                      `json:"message,omitempty"`
	Partial           bool                        `json:"partial,omitempty"`
	Warnings          []string                    `json:"warnings,omitempty"`
	FailedObjectTypes []string                    `json:"failedObjectTypes,omitempty"`
	Retryable         bool                        `json:"retryable,omitempty"`
	Truncated         bool                        `json:"truncated,omitempty"`
	ScannedCount      int                         `json:"scannedCount,omitempty"`
}

type getAllColumnsResult struct {
	ConnectionID string                                 `json:"connectionId"`
	DBName       string                                 `json:"dbName,omitempty"`
	Columns      []connection.ColumnDefinitionWithTable `json:"columns"`
	Message      string                                 `json:"message,omitempty"`
	Partial      bool                                   `json:"partial,omitempty"`
	Warnings     []string                               `json:"warnings,omitempty"`
}

type getColumnsResult struct {
	ConnectionID string                        `json:"connectionId"`
	DBName       string                        `json:"dbName,omitempty"`
	TableName    string                        `json:"tableName"`
	Columns      []connection.ColumnDefinition `json:"columns"`
}

type getIndexesResult struct {
	ConnectionID string                       `json:"connectionId"`
	DBName       string                       `json:"dbName,omitempty"`
	TableName    string                       `json:"tableName"`
	Indexes      []connection.IndexDefinition `json:"indexes"`
}

type getForeignKeysResult struct {
	ConnectionID string                            `json:"connectionId"`
	DBName       string                            `json:"dbName,omitempty"`
	TableName    string                            `json:"tableName"`
	ForeignKeys  []connection.ForeignKeyDefinition `json:"foreignKeys"`
}

type getTriggersResult struct {
	ConnectionID string                         `json:"connectionId"`
	DBName       string                         `json:"dbName,omitempty"`
	TableName    string                         `json:"tableName"`
	Triggers     []connection.TriggerDefinition `json:"triggers"`
}

type getTableDDLResult struct {
	ConnectionID string `json:"connectionId"`
	DBName       string `json:"dbName,omitempty"`
	TableName    string `json:"tableName"`
	DDL          string `json:"ddl"`
}

type sqlStatementSummary struct {
	Index    int    `json:"index"`
	Keyword  string `json:"keyword,omitempty"`
	ReadOnly bool   `json:"readOnly"`
}

type sqlResultSet struct {
	StatementIndex int                      `json:"statementIndex,omitempty"`
	Columns        []string                 `json:"columns"`
	Rows           []map[string]interface{} `json:"rows"`
	Messages       []string                 `json:"messages,omitempty"`
	RowCount       int                      `json:"rowCount"`
	Truncated      bool                     `json:"truncated,omitempty"`
}

type executeSQLResult struct {
	RequestID         string                `json:"requestId,omitempty"`
	ConnectionID      string                `json:"connectionId"`
	DBName            string                `json:"dbName,omitempty"`
	StatementCount    int                   `json:"statementCount"`
	ReadOnly          bool                  `json:"readOnly"`
	QueryID           string                `json:"queryId,omitempty"`
	CancellationState string                `json:"cancellationState,omitempty"`
	Message           string                `json:"message,omitempty"`
	Truncated         bool                  `json:"truncated,omitempty"`
	Statements        []sqlStatementSummary `json:"statements"`
	Results           []sqlResultSet        `json:"results"`
}

func (s *Service) GetConnections(ctx context.Context, req *mcp.CallToolRequest, args emptyArgs) (*mcp.CallToolResult, getConnectionsResult, error) {
	_ = ctx
	_ = req
	_ = args

	items, err := s.backend.GetSavedConnections()
	if err != nil {
		return toolError("获取已保存连接失败: %v", err), getConnectionsResult{}, nil
	}

	result := getConnectionsResult{
		Connections: make([]connectionDescriptor, 0, len(items)),
	}
	for _, item := range items {
		cfg := item.Config
		result.Connections = append(result.Connections, connectionDescriptor{
			ID:              item.ID,
			Name:            item.Name,
			Type:            strings.TrimSpace(cfg.Type),
			Host:            strings.TrimSpace(cfg.Host),
			Port:            cfg.Port,
			Database:        strings.TrimSpace(cfg.Database),
			Driver:          strings.TrimSpace(cfg.Driver),
			Topology:        strings.TrimSpace(cfg.Topology),
			Target:          describeConnectionTarget(cfg),
			UseSSH:          cfg.UseSSH,
			UseProxy:        cfg.UseProxy,
			UseHTTPTunnel:   cfg.UseHTTPTunnel,
			DefaultDatabase: strings.TrimSpace(cfg.Database),
		})
	}
	return successResult(), result, nil
}

func (s *Service) GetDatabases(ctx context.Context, req *mcp.CallToolRequest, args connectionIDArgs) (*mcp.CallToolResult, getDatabasesResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getDatabasesResult{}, nil
	}

	queryResult := s.backend.DBGetDatabases(ctx, view.Config)
	if !queryResult.Success {
		return toolError("获取数据库列表失败: %s", strings.TrimSpace(queryResult.Message)), getDatabasesResult{}, nil
	}

	databases, err := decodeNamedStringSlice(queryResult.Data, "Database", "database", "name")
	if err != nil {
		return toolError("解析数据库列表失败: %v", err), getDatabasesResult{}, nil
	}

	return successResult(), getDatabasesResult{
		ConnectionID: view.ID,
		Databases:    ensureNonNilStrings(databases),
	}, nil
}

func (s *Service) GetTables(ctx context.Context, req *mcp.CallToolRequest, args databaseArgs) (*mcp.CallToolResult, getTablesResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getTablesResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBGetTables(ctx, view.Config, dbName)
	if !queryResult.Success {
		return toolError("获取表列表失败: %s", strings.TrimSpace(queryResult.Message)), getTablesResult{}, nil
	}

	tables, err := decodeNamedStringSlice(queryResult.Data, "Table", "table", "name")
	if err != nil {
		return toolError("解析表列表失败: %v", err), getTablesResult{}, nil
	}
	if err := ctx.Err(); err != nil {
		return toolError("获取表列表失败: %s", err), getTablesResult{}, nil
	}

	views := []string{}
	viewResult := s.backend.DBGetViews(ctx, view.Config, dbName)
	if err := ctx.Err(); err != nil {
		return toolError("获取表列表失败: %s", err), getTablesResult{}, nil
	}
	if viewResult.Success {
		if decodedViews, decodeErr := decodeNamedStringSlice(viewResult.Data, "View", "view", "name"); decodeErr == nil {
			views = decodedViews
		}
	}

	return successResult(), getTablesResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		Tables:       ensureNonNilStrings(tables),
		Views:        ensureNonNilStrings(views),
		Message:      strings.TrimSpace(queryResult.Message),
		Partial:      queryResult.Partial,
		Warnings:     objectMetadataWarnings(queryResult),
		Retryable:    queryResult.Retryable,
		Truncated:    queryResult.Truncated,
		ScannedCount: queryResult.ScannedCount,
	}, nil
}

func (s *Service) GetViews(ctx context.Context, req *mcp.CallToolRequest, args databaseArgs) (*mcp.CallToolResult, getViewsResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getViewsResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBGetViews(ctx, view.Config, dbName)
	if !queryResult.Success {
		return toolError("获取视图列表失败: %s", strings.TrimSpace(queryResult.Message)), getViewsResult{}, nil
	}

	views, err := decodeNamedStringSlice(queryResult.Data, "View", "view", "name")
	if err != nil {
		return toolError("解析视图列表失败: %v", err), getViewsResult{}, nil
	}

	return successResult(), getViewsResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		Views:        ensureNonNilStrings(views),
	}, nil
}

func (s *Service) GetObjects(ctx context.Context, req *mcp.CallToolRequest, args objectsArgs) (*mcp.CallToolResult, getObjectsResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getObjectsResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBGetObjects(ctx, view.Config, dbName)
	if !queryResult.Success {
		output := getObjectsResult{
			ConnectionID:      view.ID,
			DBName:            dbName,
			Objects:           []connection.DatabaseObject{},
			Message:           strings.TrimSpace(queryResult.Message),
			Partial:           queryResult.Partial,
			Warnings:          objectMetadataWarnings(queryResult),
			FailedObjectTypes: queryResult.FailedObjectTypes,
			Retryable:         queryResult.Retryable,
			Truncated:         queryResult.Truncated,
			ScannedCount:      queryResult.ScannedCount,
		}
		if queryResult.Retryable {
			failedTypes := strings.Join(queryResult.FailedObjectTypes, ", ")
			if failedTypes != "" {
				return toolError("获取数据库对象列表失败（失败类别: %s，可重试）: %s", failedTypes, strings.TrimSpace(queryResult.Message)), output, nil
			}
			return toolError("获取数据库对象列表失败（可重试）: %s", strings.TrimSpace(queryResult.Message)), output, nil
		}
		return toolError("获取数据库对象列表失败: %s", strings.TrimSpace(queryResult.Message)), output, nil
	}

	objects, err := decodeDatabaseObjects(queryResult.Data)
	if err != nil {
		return toolError("解析数据库对象列表失败: %v", err), getObjectsResult{}, nil
	}

	return successResult(), getObjectsResult{
		ConnectionID:      view.ID,
		DBName:            dbName,
		Objects:           filterDatabaseObjects(objects, args.ObjectTypes),
		Message:           strings.TrimSpace(queryResult.Message),
		Partial:           queryResult.Partial,
		Warnings:          objectMetadataWarnings(queryResult),
		FailedObjectTypes: queryResult.FailedObjectTypes,
		Retryable:         queryResult.Retryable,
		Truncated:         queryResult.Truncated,
		ScannedCount:      queryResult.ScannedCount,
	}, nil
}

func objectMetadataWarnings(result connection.QueryResult) []string {
	if len(result.Warnings) > 0 {
		return result.Warnings
	}
	if message := strings.TrimSpace(result.Message); message != "" {
		return []string{message}
	}
	return nil
}

func (s *Service) GetAllColumns(ctx context.Context, req *mcp.CallToolRequest, args databaseArgs) (*mcp.CallToolResult, getAllColumnsResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getAllColumnsResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	if strings.TrimSpace(dbName) == "" {
		return toolError("dbName 不能为空"), getAllColumnsResult{}, nil
	}

	queryResult := s.backend.DBGetAllColumns(ctx, view.Config, dbName)
	if !queryResult.Success {
		return toolError("获取全库字段摘要失败: %s", strings.TrimSpace(queryResult.Message)), getAllColumnsResult{}, nil
	}

	columns, err := decodeColumnsWithTable(queryResult.Data)
	if err != nil {
		return toolError("解析全库字段摘要失败: %v", err), getAllColumnsResult{}, nil
	}

	return successResult(), getAllColumnsResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		Columns:      ensureNonNilColumnsWithTable(columns),
		Message:      strings.TrimSpace(queryResult.Message),
		Partial:      queryResult.Partial,
		Warnings:     objectMetadataWarnings(queryResult),
	}, nil
}

func (s *Service) GetColumns(ctx context.Context, req *mcp.CallToolRequest, args tableArgs) (*mcp.CallToolResult, getColumnsResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getColumnsResult{}, nil
	}

	tableName := strings.TrimSpace(args.TableName)
	if tableName == "" {
		return toolError("tableName 不能为空"), getColumnsResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBGetColumns(ctx, view.Config, dbName, tableName)
	if !queryResult.Success {
		return toolError("获取字段列表失败: %s", strings.TrimSpace(queryResult.Message)), getColumnsResult{}, nil
	}

	columns, err := decodeColumns(queryResult.Data)
	if err != nil {
		return toolError("解析字段列表失败: %v", err), getColumnsResult{}, nil
	}

	return successResult(), getColumnsResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		TableName:    tableName,
		Columns:      ensureNonNilColumns(columns),
	}, nil
}

func (s *Service) GetIndexes(ctx context.Context, req *mcp.CallToolRequest, args tableArgs) (*mcp.CallToolResult, getIndexesResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getIndexesResult{}, nil
	}

	tableName := strings.TrimSpace(args.TableName)
	if tableName == "" {
		return toolError("tableName 不能为空"), getIndexesResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBGetIndexes(ctx, view.Config, dbName, tableName)
	if !queryResult.Success {
		return toolError("获取索引定义失败: %s", strings.TrimSpace(queryResult.Message)), getIndexesResult{}, nil
	}

	indexes, err := decodeIndexes(queryResult.Data)
	if err != nil {
		return toolError("解析索引定义失败: %v", err), getIndexesResult{}, nil
	}

	return successResult(), getIndexesResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		TableName:    tableName,
		Indexes:      ensureNonNilIndexes(indexes),
	}, nil
}

func (s *Service) GetForeignKeys(ctx context.Context, req *mcp.CallToolRequest, args tableArgs) (*mcp.CallToolResult, getForeignKeysResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getForeignKeysResult{}, nil
	}

	tableName := strings.TrimSpace(args.TableName)
	if tableName == "" {
		return toolError("tableName 不能为空"), getForeignKeysResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBGetForeignKeys(ctx, view.Config, dbName, tableName)
	if !queryResult.Success {
		return toolError("获取外键关系失败: %s", strings.TrimSpace(queryResult.Message)), getForeignKeysResult{}, nil
	}

	foreignKeys, err := decodeForeignKeys(queryResult.Data)
	if err != nil {
		return toolError("解析外键关系失败: %v", err), getForeignKeysResult{}, nil
	}

	return successResult(), getForeignKeysResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		TableName:    tableName,
		ForeignKeys:  ensureNonNilForeignKeys(foreignKeys),
	}, nil
}

func (s *Service) GetTriggers(ctx context.Context, req *mcp.CallToolRequest, args tableArgs) (*mcp.CallToolResult, getTriggersResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getTriggersResult{}, nil
	}

	tableName := strings.TrimSpace(args.TableName)
	if tableName == "" {
		return toolError("tableName 不能为空"), getTriggersResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBGetTriggers(ctx, view.Config, dbName, tableName)
	if !queryResult.Success {
		return toolError("获取触发器定义失败: %s", strings.TrimSpace(queryResult.Message)), getTriggersResult{}, nil
	}

	triggers, err := decodeTriggers(queryResult.Data)
	if err != nil {
		return toolError("解析触发器定义失败: %v", err), getTriggersResult{}, nil
	}

	return successResult(), getTriggersResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		TableName:    tableName,
		Triggers:     ensureNonNilTriggers(triggers),
	}, nil
}

func (s *Service) GetTableDDL(ctx context.Context, req *mcp.CallToolRequest, args tableArgs) (*mcp.CallToolResult, getTableDDLResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, getTableDDLResult{}, nil
	}

	tableName := strings.TrimSpace(args.TableName)
	if tableName == "" {
		return toolError("tableName 不能为空"), getTableDDLResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.backend.DBShowCreateTable(ctx, view.Config, dbName, tableName)
	if !queryResult.Success {
		return toolError("获取建表语句失败: %s", strings.TrimSpace(queryResult.Message)), getTableDDLResult{}, nil
	}

	ddl, err := decodeString(queryResult.Data)
	if err != nil {
		return toolError("解析建表语句失败: %v", err), getTableDDLResult{}, nil
	}

	return successResult(), getTableDDLResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		TableName:    tableName,
		DDL:          ddl,
	}, nil
}

func (s *Service) ExecuteSQL(ctx context.Context, req *mcp.CallToolRequest, args executeSQLArgs) (*mcp.CallToolResult, executeSQLResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, executeSQLResult{}, nil
	}

	sqlText := strings.TrimSpace(args.SQL)
	if sqlText == "" {
		return toolError("sql 不能为空"), executeSQLResult{}, nil
	}

	inspection := s.backend.InspectSQL(view.Config.Type, sqlText)
	if inspection.StatementCount == 0 {
		return toolError("未识别到可执行的 SQL 语句"), executeSQLResult{}, nil
	}
	if !isConsistentSQLInspection(inspection) {
		return toolError("SQL 安全检查结果无效，已拒绝执行"), executeSQLResult{}, nil
	}

	safetyLevel := normalizeSQLSafetyLevel(s.backend.GetSQLSafetyLevel())
	safetyDecision := evaluateSQLSafety(safetyLevel, inspection)
	if len(safetyDecision.disallowed) > 0 {
		return toolError("%s", buildSafetyDeniedMessage(safetyLevel, safetyDecision.disallowed)), executeSQLResult{}, nil
	}
	if safetyDecision.requiresConfirm && !args.AllowMutating {
		return toolError("当前 SQL 已通过 GoNavi AI 安全控制（%s），但包含非只读语句 %s，请显式传入 allowMutating=true 后重试", safetyLevelDisplayName(safetyLevel), formatSafetyStatements(safetyDecision.confirmRequired)), executeSQLResult{}, nil
	}
	if err := s.backend.AuthorizeSQLConnection(view.Config, sqlText); err != nil {
		return toolError("连接写保护拒绝 SQL 执行: %s", strings.TrimSpace(err.Error())), executeSQLResult{}, nil
	}

	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult := s.executeAuthorizedSQL(ctx, view, dbName, sqlText, args.AllowMutating)
	if !queryResult.Success {
		if queryResult.CancellationState != "" {
			return toolError("SQL 执行失败（cancellationState=%s）: %s", queryResult.CancellationState, strings.TrimSpace(queryResult.Message)), executeSQLResult{}, nil
		}
		return toolError("SQL 执行失败: %s", strings.TrimSpace(queryResult.Message)), executeSQLResult{}, nil
	}

	resultSets, err := decodeResultSets(queryResult.Data)
	if err != nil {
		return toolError("解析 SQL 执行结果失败: %v", err), executeSQLResult{}, nil
	}

	normalizedResults, truncated := normalizeResultSets(resultSets, normalizeMaxRowsPerResult(args.MaxRowsPerResult))
	output := executeSQLResult{
		RequestID:         mcpRequestID(ctx),
		ConnectionID:      view.ID,
		DBName:            dbName,
		StatementCount:    inspection.StatementCount,
		ReadOnly:          inspection.ReadOnly,
		QueryID:           strings.TrimSpace(queryResult.QueryID),
		CancellationState: strings.TrimSpace(queryResult.CancellationState),
		Message:           strings.TrimSpace(queryResult.Message),
		Truncated:         truncated,
		Statements:        toStatementSummaries(inspection.Statements),
		Results:           normalizedResults,
	}
	return textResult(formatExecuteSQLResultContent(output)), output, nil
}

func (s *Service) executeAuthorizedSQL(ctx context.Context, view connection.SavedConnectionView, dbName string, sqlText string, allowMutating bool) connection.QueryResult {
	if backend, ok := s.backend.(executionAuthorizingBackend); ok {
		return backend.ExecuteAuthorizedSQLFromMCP(ctx, view.ID, view.Config, dbName, sqlText, allowMutating)
	}
	return s.backend.ExecuteSQLFromMCP(ctx, view.Config, dbName, sqlText)
}

func successResult() *mcp.CallToolResult {
	return &mcp.CallToolResult{}
}

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: text},
		},
	}
}

func toolError(format string, args ...interface{}) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{
			&mcp.TextContent{Text: fmt.Sprintf(format, args...)},
		},
	}
}

func (s *Service) resolveConnection(connectionID string) (connection.SavedConnectionView, *mcp.CallToolResult) {
	id := strings.TrimSpace(connectionID)
	if id == "" {
		return connection.SavedConnectionView{}, toolError("connectionId 不能为空")
	}
	view, err := s.backend.GetEditableSavedConnection(id)
	if err != nil {
		return connection.SavedConnectionView{}, toolError("加载连接 %s 失败: %v", id, err)
	}
	return view, nil
}

func effectiveDBName(input string, config connection.ConnectionConfig) string {
	if trimmed := strings.TrimSpace(input); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(config.Database)
}

func describeConnectionTarget(config connection.ConnectionConfig) string {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	switch dbType {
	case "sqlite", "duckdb":
		if path := strings.TrimSpace(config.Database); path != "" {
			return path
		}
	}
	if len(config.Hosts) > 0 {
		return strings.Join(config.Hosts, ",")
	}
	if host := strings.TrimSpace(config.Host); host != "" {
		if config.Port > 0 {
			return fmt.Sprintf("%s:%d", host, config.Port)
		}
		return host
	}
	if uri := strings.TrimSpace(config.URI); uri != "" {
		return redactConnectionTarget(uri)
	}
	if dsn := strings.TrimSpace(config.DSN); dsn != "" {
		return redactConnectionTarget(dsn)
	}
	return strings.TrimSpace(config.Database)
}

func redactConnectionTarget(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}

	if parsed, err := url.Parse(trimmed); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.Fragment = ""
		return parsed.String()
	}

	if looksLikeOpaqueConnectionString(trimmed) {
		return redactedOpaqueTarget
	}
	return trimmed
}

func looksLikeOpaqueConnectionString(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	if lower == "" {
		return false
	}
	return strings.Contains(lower, "@") ||
		strings.Contains(lower, "password=") ||
		strings.Contains(lower, "pwd=") ||
		strings.Contains(lower, "user=") ||
		strings.Contains(lower, "uid=") ||
		strings.Contains(lower, "token=") ||
		strings.Contains(lower, "secret=") ||
		strings.Contains(lower, "access_key=") ||
		strings.Contains(lower, "api_key=")
}

func decodeNamedStringSlice(data interface{}, keys ...string) ([]string, error) {
	switch items := data.(type) {
	case nil:
		return []string{}, nil
	case []string:
		return ensureNonNilStrings(append([]string(nil), items...)), nil
	case []map[string]string:
		result := make([]string, 0, len(items))
		for _, item := range items {
			result = append(result, pickNamedStringFromStringMap(item, keys...))
		}
		return result, nil
	case []map[string]interface{}:
		result := make([]string, 0, len(items))
		for _, item := range items {
			result = append(result, pickNamedStringFromAnyMap(item, keys...))
		}
		return result, nil
	default:
		var decoded []map[string]interface{}
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return decodeNamedStringSlice(decoded, keys...)
	}
}

func pickNamedStringFromStringMap(item map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(item[key]); value != "" {
			return value
		}
	}
	for _, value := range item {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func pickNamedStringFromAnyMap(item map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key]; ok {
			if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
				return text
			}
		}
	}
	for _, value := range item {
		if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
			return text
		}
	}
	return ""
}

func decodeColumns(data interface{}) ([]connection.ColumnDefinition, error) {
	switch cols := data.(type) {
	case nil:
		return []connection.ColumnDefinition{}, nil
	case []connection.ColumnDefinition:
		return ensureNonNilColumns(append([]connection.ColumnDefinition(nil), cols...)), nil
	default:
		var decoded []connection.ColumnDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilColumns(decoded), nil
	}
}

func decodeColumnsWithTable(data interface{}) ([]connection.ColumnDefinitionWithTable, error) {
	switch cols := data.(type) {
	case nil:
		return []connection.ColumnDefinitionWithTable{}, nil
	case []connection.ColumnDefinitionWithTable:
		return ensureNonNilColumnsWithTable(append([]connection.ColumnDefinitionWithTable(nil), cols...)), nil
	default:
		var decoded []connection.ColumnDefinitionWithTable
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilColumnsWithTable(decoded), nil
	}
}

func decodeIndexes(data interface{}) ([]connection.IndexDefinition, error) {
	switch indexes := data.(type) {
	case nil:
		return []connection.IndexDefinition{}, nil
	case []connection.IndexDefinition:
		return ensureNonNilIndexes(append([]connection.IndexDefinition(nil), indexes...)), nil
	default:
		var decoded []connection.IndexDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilIndexes(decoded), nil
	}
}

func decodeForeignKeys(data interface{}) ([]connection.ForeignKeyDefinition, error) {
	switch foreignKeys := data.(type) {
	case nil:
		return []connection.ForeignKeyDefinition{}, nil
	case []connection.ForeignKeyDefinition:
		return ensureNonNilForeignKeys(append([]connection.ForeignKeyDefinition(nil), foreignKeys...)), nil
	default:
		var decoded []connection.ForeignKeyDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilForeignKeys(decoded), nil
	}
}

func decodeTriggers(data interface{}) ([]connection.TriggerDefinition, error) {
	switch triggers := data.(type) {
	case nil:
		return []connection.TriggerDefinition{}, nil
	case []connection.TriggerDefinition:
		return ensureNonNilTriggers(append([]connection.TriggerDefinition(nil), triggers...)), nil
	default:
		var decoded []connection.TriggerDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilTriggers(decoded), nil
	}
}

func decodeString(data interface{}) (string, error) {
	switch value := data.(type) {
	case nil:
		return "", nil
	case string:
		return value, nil
	default:
		return fmt.Sprint(value), nil
	}
}

func decodeResultSets(data interface{}) ([]connection.ResultSetData, error) {
	switch items := data.(type) {
	case nil:
		return []connection.ResultSetData{}, nil
	case []connection.ResultSetData:
		return ensureNonNilResultSets(append([]connection.ResultSetData(nil), items...)), nil
	default:
		var decoded []connection.ResultSetData
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilResultSets(decoded), nil
	}
}

func decodeDatabaseObjects(data interface{}) ([]connection.DatabaseObject, error) {
	switch items := data.(type) {
	case nil:
		return []connection.DatabaseObject{}, nil
	case []connection.DatabaseObject:
		return ensureNonNilDatabaseObjects(append([]connection.DatabaseObject(nil), items...)), nil
	default:
		var decoded []connection.DatabaseObject
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilDatabaseObjects(decoded), nil
	}
}

func filterDatabaseObjects(items []connection.DatabaseObject, objectTypes []string) []connection.DatabaseObject {
	if len(objectTypes) == 0 {
		return ensureNonNilDatabaseObjects(items)
	}
	allowed := make(map[string]struct{}, len(objectTypes))
	for _, objectType := range objectTypes {
		normalized := strings.ToLower(strings.TrimSpace(objectType))
		if normalized == "" {
			continue
		}
		switch normalized {
		case "routine", "routines":
			allowed["function"] = struct{}{}
			allowed["procedure"] = struct{}{}
		case "functions":
			allowed["function"] = struct{}{}
		case "procedures":
			allowed["procedure"] = struct{}{}
		case "views":
			allowed["view"] = struct{}{}
		case "tables":
			allowed["table"] = struct{}{}
		case "queues":
			allowed["queue"] = struct{}{}
		case "topics":
			allowed["topic"] = struct{}{}
		case "exchanges":
			allowed["exchange"] = struct{}{}
		case "packages":
			allowed["package"] = struct{}{}
		default:
			allowed[normalized] = struct{}{}
		}
	}
	if len(allowed) == 0 {
		return ensureNonNilDatabaseObjects(items)
	}
	result := make([]connection.DatabaseObject, 0, len(items))
	for _, item := range items {
		if _, ok := allowed[strings.ToLower(strings.TrimSpace(item.Type))]; ok {
			result = append(result, item)
		}
	}
	return ensureNonNilDatabaseObjects(result)
}

func remarshal(from interface{}, to interface{}) error {
	payload, err := json.Marshal(from)
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, to)
}

func normalizeMaxRowsPerResult(input int) int {
	if input <= 0 {
		return defaultMaxRowsPerResult
	}
	if input > maxRowsPerResultLimit {
		return maxRowsPerResultLimit
	}
	return input
}

func normalizeResultSets(resultSets []connection.ResultSetData, maxRows int) ([]sqlResultSet, bool) {
	normalized := make([]sqlResultSet, 0, len(resultSets))
	truncatedAny := false
	for _, resultSet := range resultSets {
		rows := ensureNonNilRows(resultSet.Rows)
		rowCount := len(rows)
		truncated := false
		if maxRows > 0 && len(rows) > maxRows {
			rows = append([]map[string]interface{}(nil), rows[:maxRows]...)
			truncated = true
			truncatedAny = true
		}
		normalized = append(normalized, sqlResultSet{
			StatementIndex: resultSet.StatementIndex,
			Columns:        ensureNonNilStrings(append([]string(nil), resultSet.Columns...)),
			Rows:           rows,
			Messages:       ensureNonNilStrings(append([]string(nil), resultSet.Messages...)),
			RowCount:       rowCount,
			Truncated:      truncated,
		})
	}
	return normalized, truncatedAny
}

func formatExecuteSQLResultContent(result executeSQLResult) string {
	var builder strings.Builder
	builder.WriteString("SQL 执行成功")
	if result.QueryID != "" {
		builder.WriteString("，queryId=")
		builder.WriteString(result.QueryID)
	}
	builder.WriteString("\n")
	builder.WriteString(fmt.Sprintf("语句数：%d，结果集：%d", result.StatementCount, len(result.Results)))
	if result.Truncated {
		builder.WriteString("，结果已截断")
	}
	if result.CancellationState != "" {
		builder.WriteString("\n取消状态：")
		builder.WriteString(result.CancellationState)
	}
	if result.Message != "" {
		builder.WriteString("\n消息：")
		builder.WriteString(result.Message)
	}
	if len(result.Results) == 0 {
		builder.WriteString("\n无结果集返回。")
		return builder.String()
	}

	for index, resultSet := range result.Results {
		builder.WriteString("\n\n")
		builder.WriteString(fmt.Sprintf("结果集 %d", index+1))
		if resultSet.StatementIndex > 0 {
			builder.WriteString(fmt.Sprintf("（语句 #%d）", resultSet.StatementIndex))
		}
		builder.WriteString(fmt.Sprintf("：%d 行", resultSet.RowCount))
		if resultSet.Truncated {
			builder.WriteString(fmt.Sprintf("，仅显示前 %d 行", len(resultSet.Rows)))
		}
		if len(resultSet.Messages) > 0 {
			builder.WriteString("\n消息：")
			builder.WriteString(strings.Join(resultSet.Messages, "\n"))
		}
		if len(resultSet.Columns) == 0 {
			if len(resultSet.Rows) == 0 {
				builder.WriteString("\n无列/行数据。")
				continue
			}
			resultSet.Columns = inferColumnsFromRows(resultSet.Rows)
		}
		if len(resultSet.Columns) == 0 {
			continue
		}
		builder.WriteString("\n")
		builder.WriteString(formatMarkdownTable(resultSet.Columns, resultSet.Rows))
	}
	return builder.String()
}

func inferColumnsFromRows(rows []map[string]interface{}) []string {
	seen := make(map[string]struct{})
	columns := []string{}
	for _, row := range rows {
		keys := make([]string, 0, len(row))
		for key := range row {
			if _, ok := seen[key]; ok {
				continue
			}
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			seen[key] = struct{}{}
			columns = append(columns, key)
		}
	}
	return columns
}

func formatMarkdownTable(columns []string, rows []map[string]interface{}) string {
	var builder strings.Builder
	builder.WriteString("|")
	for _, column := range columns {
		builder.WriteString(" ")
		builder.WriteString(escapeMarkdownTableCell(column))
		builder.WriteString(" |")
	}
	builder.WriteString("\n|")
	for range columns {
		builder.WriteString(" --- |")
	}
	for _, row := range rows {
		builder.WriteString("\n|")
		for _, column := range columns {
			builder.WriteString(" ")
			builder.WriteString(escapeMarkdownTableCell(formatSQLValue(row[column])))
			builder.WriteString(" |")
		}
	}
	return builder.String()
}

func formatSQLValue(value interface{}) string {
	if value == nil {
		return "NULL"
	}
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	case fmt.Stringer:
		return typed.String()
	}
	data, err := json.Marshal(value)
	if err == nil {
		return string(data)
	}
	return fmt.Sprint(value)
}

func escapeMarkdownTableCell(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "|", "\\|")
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	value = strings.ReplaceAll(value, "\n", "<br>")
	return value
}

func toStatementSummaries(items []appcore.SQLStatementInspection) []sqlStatementSummary {
	result := make([]sqlStatementSummary, 0, len(items))
	for _, item := range items {
		result = append(result, sqlStatementSummary{
			Index:    item.Index,
			Keyword:  item.Keyword,
			ReadOnly: item.ReadOnly,
		})
	}
	return result
}

func ensureNonNilStrings(items []string) []string {
	if items == nil {
		return []string{}
	}
	return items
}

func ensureNonNilColumns(items []connection.ColumnDefinition) []connection.ColumnDefinition {
	if items == nil {
		return []connection.ColumnDefinition{}
	}
	return items
}

func ensureNonNilColumnsWithTable(items []connection.ColumnDefinitionWithTable) []connection.ColumnDefinitionWithTable {
	if items == nil {
		return []connection.ColumnDefinitionWithTable{}
	}
	return items
}

func ensureNonNilIndexes(items []connection.IndexDefinition) []connection.IndexDefinition {
	if items == nil {
		return []connection.IndexDefinition{}
	}
	return items
}

func ensureNonNilForeignKeys(items []connection.ForeignKeyDefinition) []connection.ForeignKeyDefinition {
	if items == nil {
		return []connection.ForeignKeyDefinition{}
	}
	return items
}

func ensureNonNilTriggers(items []connection.TriggerDefinition) []connection.TriggerDefinition {
	if items == nil {
		return []connection.TriggerDefinition{}
	}
	return items
}

func ensureNonNilRows(items []map[string]interface{}) []map[string]interface{} {
	if items == nil {
		return []map[string]interface{}{}
	}
	return items
}

func ensureNonNilResultSets(items []connection.ResultSetData) []connection.ResultSetData {
	if items == nil {
		return []connection.ResultSetData{}
	}
	return items
}

func ensureNonNilDatabaseObjects(items []connection.DatabaseObject) []connection.DatabaseObject {
	if items == nil {
		return []connection.DatabaseObject{}
	}
	return items
}

type sqlSafetyStatement struct {
	Index         int
	Keyword       string
	OperationType ai.SQLOperationType
}

type sqlSafetyDecision struct {
	requiresConfirm bool
	disallowed      []sqlSafetyStatement
	confirmRequired []sqlSafetyStatement
}

func isConsistentSQLInspection(inspection appcore.SQLInspection) bool {
	if inspection.StatementCount <= 0 || inspection.StatementCount != len(inspection.Statements) {
		return false
	}
	readOnly := true
	for index, statement := range inspection.Statements {
		if statement.Index != index+1 {
			return false
		}
		if !statement.ReadOnly {
			readOnly = false
		}
	}
	return inspection.ReadOnly == readOnly
}

func evaluateSQLSafety(level ai.SQLPermissionLevel, inspection appcore.SQLInspection) sqlSafetyDecision {
	decision := sqlSafetyDecision{
		disallowed:      []sqlSafetyStatement{},
		confirmRequired: []sqlSafetyStatement{},
	}

	for _, stmt := range inspection.Statements {
		statement := sqlSafetyStatement{
			Index:         stmt.Index,
			Keyword:       strings.TrimSpace(stmt.Keyword),
			OperationType: classifyStatementOperation(stmt),
		}
		if !isOperationAllowed(level, statement.OperationType) {
			decision.disallowed = append(decision.disallowed, statement)
			continue
		}
		if statement.OperationType != ai.SQLOpQuery {
			decision.requiresConfirm = true
			decision.confirmRequired = append(decision.confirmRequired, statement)
		}
	}

	return decision
}

func classifyStatementOperation(stmt appcore.SQLStatementInspection) ai.SQLOperationType {
	if stmt.ReadOnly {
		return ai.SQLOpQuery
	}

	switch strings.ToLower(strings.TrimSpace(stmt.Keyword)) {
	case "insert", "update", "delete", "replace", "merge", "upsert":
		return ai.SQLOpDML
	case "create", "alter", "drop", "truncate", "rename":
		return ai.SQLOpDDL
	default:
		return ai.SQLOpOther
	}
}

func isOperationAllowed(level ai.SQLPermissionLevel, opType ai.SQLOperationType) bool {
	switch normalizeSQLSafetyLevel(level) {
	case ai.PermissionReadOnly:
		return opType == ai.SQLOpQuery
	case ai.PermissionReadWrite:
		return opType == ai.SQLOpQuery || opType == ai.SQLOpDML
	case ai.PermissionFull:
		return true
	default:
		return opType == ai.SQLOpQuery
	}
}

func normalizeSQLSafetyLevel(level ai.SQLPermissionLevel) ai.SQLPermissionLevel {
	switch level {
	case ai.PermissionReadOnly, ai.PermissionReadWrite, ai.PermissionFull:
		return level
	default:
		return ai.PermissionReadOnly
	}
}

func buildSafetyDeniedMessage(level ai.SQLPermissionLevel, statements []sqlSafetyStatement) string {
	return fmt.Sprintf("当前 GoNavi AI 安全控制为%s，已阻止以下语句：%s。%s", safetyLevelDisplayName(level), formatSafetyStatements(statements), safetyLevelRuleText(level))
}

func safetyLevelDisplayName(level ai.SQLPermissionLevel) string {
	switch normalizeSQLSafetyLevel(level) {
	case ai.PermissionReadOnly:
		return "只读模式"
	case ai.PermissionReadWrite:
		return "读写模式"
	case ai.PermissionFull:
		return "完全模式"
	default:
		return "只读模式"
	}
}

func safetyLevelRuleText(level ai.SQLPermissionLevel) string {
	switch normalizeSQLSafetyLevel(level) {
	case ai.PermissionReadOnly:
		return "只读模式仅允许查询语句。"
	case ai.PermissionReadWrite:
		return "读写模式仅允许查询和 DML 语句。"
	case ai.PermissionFull:
		return "完全模式允许所有 SQL 操作；高风险或未识别语句仍会要求确认。"
	default:
		return "只读模式仅允许查询语句。"
	}
}

func formatSafetyStatements(statements []sqlSafetyStatement) string {
	parts := make([]string, 0, len(statements))
	for _, stmt := range statements {
		keyword := strings.TrimSpace(stmt.Keyword)
		if keyword == "" {
			keyword = "unknown"
		}
		parts = append(parts, fmt.Sprintf("#%d %s(%s)", stmt.Index, strings.ToLower(keyword), strings.ToUpper(string(stmt.OperationType))))
	}
	return strings.Join(parts, "，")
}
