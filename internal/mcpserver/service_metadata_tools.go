package mcpserver

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

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
	partial := queryResult.Partial
	warnings := objectMetadataWarnings(queryResult)
	retryable := queryResult.Retryable
	viewResult := s.backend.DBGetViews(ctx, view.Config, dbName)
	if err := ctx.Err(); err != nil {
		return toolError("获取表列表失败: %s", err), getTablesResult{}, nil
	}
	viewMetadataFailed := !viewResult.Success
	if !viewMetadataFailed {
		decodedViews, decodeErr := decodeNamedStringSlice(viewResult.Data, "View", "view", "name")
		if decodeErr != nil {
			viewMetadataFailed = true
		} else {
			views = decodedViews
		}
	}
	if viewMetadataFailed {
		partial = true
		retryable = retryable || viewResult.Retryable
		warnings = append(warnings, "获取视图元数据失败，返回的对象集合不完整")
	}

	return successResult(), getTablesResult{
		ConnectionID: view.ID,
		DBName:       dbName,
		Tables:       ensureNonNilStrings(tables),
		Views:        ensureNonNilStrings(views),
		Message:      strings.TrimSpace(queryResult.Message),
		Partial:      partial,
		Warnings:     warnings,
		Retryable:    retryable,
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
