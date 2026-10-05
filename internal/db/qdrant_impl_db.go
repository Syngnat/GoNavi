package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

func (q *QdrantDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = q.Close()
	defer func() {
		if err != nil {
			_ = q.Close()
		}
	}()

	runConfig := normalizeQdrantConfig(config)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		q.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("Qdrant 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	q.database = qdrantDatabaseFromConfig(runConfig)
	q.baseURL = buildQdrantBaseURL(runConfig)
	q.authHeaders = qdrantAuthHeaders(runConfig)
	q.client = buildQdrantHTTPClient(runConfig)

	if err := q.Ping(); err != nil {
		_ = q.Close()
		return err
	}
	return nil
}

func (q *QdrantDB) Close() error {
	if q.forwarder != nil {
		if err := q.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Qdrant SSH 端口转发失败：%v", err)
		}
		q.forwarder = nil
	}
	q.client = nil
	return nil
}

func (q *QdrantDB) Ping() error {
	if q.client == nil {
		return fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var resp qdrantListCollectionsResponse
	return q.doJSON(ctx, http.MethodGet, "/collections", nil, &resp)
}

func (q *QdrantDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultQdrantQueryTimeout)
	defer cancel()
	return q.QueryContext(ctx, query)
}

func (q *QdrantDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if q.client == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}

	if strings.HasPrefix(text, "{") {
		return q.queryJSON(ctx, text)
	}

	if parsed, ok := parseQdrantSQL(text); ok {
		if parsed.WhereError != nil {
			return nil, nil, fmt.Errorf("Qdrant WHERE 解析失败：%w", parsed.WhereError)
		}
		if parsed.Count {
			total, err := q.countPoints(ctx, parsed.Collection, parsed.Filter)
			if err != nil {
				return nil, nil, err
			}
			return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
		}
		return q.scrollPoints(ctx, parsed.Collection, parsed.Limit, parsed.Offset, parsed.Filter, true, parsed.IncludeVector)
	}

	return nil, nil, fmt.Errorf("Qdrant 查询仅支持 JSON 命令或简单 SELECT 预览")
}

func (q *QdrantDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultQdrantQueryTimeout)
	defer cancel()
	return q.ExecContext(ctx, query)
}

func (q *QdrantDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if q.client == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("Qdrant 写入命令必须是 JSON：%w", err)
	}
	if name := firstStringValue(cmd, "create_collection", "createCollection", "collection"); name != "" && hasAnyKey(cmd, "create_collection", "createCollection") {
		return 1, q.createCollection(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "delete_collection", "deleteCollection"); name != "" {
		return 1, q.deleteCollection(ctx, name)
	}
	if name := firstStringValue(cmd, "upsert", "collection"); name != "" && hasAnyKey(cmd, "upsert") {
		return q.upsertCommand(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "delete", "collection"); name != "" && hasAnyKey(cmd, "delete") {
		return q.deleteCommand(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "create_payload_index", "createPayloadIndex", "collection"); name != "" && hasAnyKey(cmd, "create_payload_index", "createPayloadIndex") {
		return 1, q.createPayloadIndex(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "delete_payload_index", "deletePayloadIndex", "collection"); name != "" && hasAnyKey(cmd, "delete_payload_index", "deletePayloadIndex") {
		fieldName := firstStringValue(cmd, "field_name", "fieldName", "field")
		if fieldName == "" {
			return 0, fmt.Errorf("Qdrant 删除 payload index 命令缺少 field_name")
		}
		return 1, q.deletePayloadIndex(ctx, name, fieldName)
	}
	return 0, fmt.Errorf("Qdrant JSON 写入命令仅支持 create_collection/delete_collection/upsert/delete/create_payload_index/delete_payload_index")
}

func (q *QdrantDB) GetDatabases() ([]string, error) {
	if q.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return []string{q.database}, nil
}

func (q *QdrantDB) GetTables(dbName string) ([]string, error) {
	collections, err := q.listCollections(metadataContextFor(q))
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(collections))
	for _, item := range collections {
		if strings.TrimSpace(item.Name) != "" {
			names = append(names, item.Name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (q *QdrantDB) GetCreateStatement(dbName, tableName string) (string, error) {
	info, err := q.getCollectionInfo(metadataContextFor(q), tableNameOrDB(dbName, tableName))
	if err != nil {
		return "", err
	}
	payload, _ := json.MarshalIndent(info, "", "  ")
	return fmt.Sprintf("// Qdrant collection: %s\n%s", tableNameOrDB(dbName, tableName), string(payload)), nil
}

func (q *QdrantDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	info, err := q.getCollectionInfo(metadataContextFor(q), tableNameOrDB(dbName, tableName))
	if err != nil {
		return nil, err
	}
	cols := []connection.ColumnDefinition{
		{Name: "id", Type: "point_id", Nullable: "NO", Key: "PRI", Comment: "Qdrant point id"},
		{Name: "vector", Type: "vector<float>", Nullable: "YES", Comment: "Vector or named vectors"},
		{Name: "payload", Type: "json", Nullable: "YES", Comment: "Full payload object"},
	}
	cols = append(cols, qdrantPayloadSchemaColumns(info)...)
	return cols, nil
}

func (q *QdrantDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := q.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	var failures []MetadataObjectFailure
	for _, table := range tables {
		cols, err := q.GetColumns(dbName, table)
		if err != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: table, Err: err})
			continue
		}
		for _, col := range cols {
			result = append(result, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      col.Name,
				Type:      col.Type,
				Comment:   col.Comment,
			})
		}
	}
	return result, NewPartialMetadataError(failures)
}

func (q *QdrantDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	indexes := []connection.IndexDefinition{
		{Name: "PRIMARY", ColumnName: "id", NonUnique: 0, SeqInIndex: 1, IndexType: "PRIMARY"},
	}
	info, err := q.getCollectionInfo(metadataContextFor(q), tableNameOrDB(dbName, tableName))
	if err == nil {
		indexes = append(indexes, qdrantVectorIndexes(info)...)
		indexes = append(indexes, qdrantPayloadIndexes(info)...)
	}
	if len(indexes) == 1 {
		indexes = append(indexes, connection.IndexDefinition{Name: "VECTOR", ColumnName: "vector", NonUnique: 1, SeqInIndex: 1, IndexType: "VECTOR"})
	}
	return indexes, nil
}

func (q *QdrantDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (q *QdrantDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (q *QdrantDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return q.ApplyChangesContext(context.Background(), tableName, changes)
}

func (q *QdrantDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQdrantQueryTimeout)
	defer cancel()
	writeApplied := false
	writeError := func(err error) error {
		if writeApplied {
			return MarkWriteOutcomeUnknown(err)
		}
		return err
	}

	if len(changes.Deletes) > 0 {
		ids := make([]interface{}, 0, len(changes.Deletes))
		for _, row := range changes.Deletes {
			if id, ok := qdrantRowID(row); ok {
				ids = append(ids, id)
			}
		}
		if len(ids) != len(changes.Deletes) {
			return fmt.Errorf("Qdrant 删除行缺少 id")
		}
		if len(ids) > 0 {
			if _, err := q.deleteCommand(ctx, tableName, map[string]interface{}{"points": ids}); err != nil {
				return writeError(err)
			}
			writeApplied = true
		}
	}

	if len(changes.Updates) > 0 {
		var upserts []map[string]interface{}
		for _, update := range changes.Updates {
			row := make(map[string]interface{}, len(update.Keys)+len(update.Values))
			for k, v := range update.Keys {
				row[k] = v
			}
			for k, v := range update.Values {
				row[k] = v
			}
			if _, hasVector := qdrantRowVector(row); hasVector {
				upserts = append(upserts, row)
				continue
			}
			if err := q.setPayloadFromRow(ctx, tableName, row); err != nil {
				return writeError(err)
			}
			if len(qdrantPayloadFromRow(row)) > 0 {
				writeApplied = true
			}
		}
		if len(upserts) > 0 {
			if err := q.upsertRows(ctx, tableName, upserts); err != nil {
				return writeError(err)
			}
			writeApplied = true
		}
	}

	if len(changes.Inserts) > 0 {
		if err := q.upsertRows(ctx, tableName, changes.Inserts); err != nil {
			return writeError(err)
		}
	}
	return nil
}
