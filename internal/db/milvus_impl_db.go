package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

func (m *MilvusDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = m.Close()
	defer func() {
		if err != nil {
			_ = m.Close()
		}
	}()

	runConfig := normalizeMilvusConfig(config)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("create Milvus SSH tunnel: %w", err)
		}
		m.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("parse Milvus local forwarding address: %w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("parse Milvus local forwarding port: %w", err)
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("Milvus connected through local port forwarding: %s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	m.database = milvusDatabaseFromConfig(runConfig)
	m.baseURL = buildMilvusBaseURL(runConfig)
	m.authHeaders = milvusAuthHeaders(runConfig)
	m.client = buildMilvusHTTPClient(runConfig)

	if err := m.Ping(); err != nil {
		_ = m.Close()
		return err
	}
	return nil
}

func (m *MilvusDB) Close() error {
	if m.forwarder != nil {
		if err := m.forwarder.Release(); err != nil {
			logger.Warnf("close Milvus SSH port forwarding failed: %v", err)
		}
		m.forwarder = nil
	}
	m.client = nil
	return nil
}

func (m *MilvusDB) Ping() error {
	if m.client == nil {
		return fmt.Errorf("connection is not open")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(m), 10*time.Second)
	defer cancel()
	_, err := m.listCollections(ctx, m.database)
	return err
}

func (m *MilvusDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultMilvusQueryTimeout)
	defer cancel()
	return m.QueryContext(ctx, query)
}

func (m *MilvusDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.client == nil {
		return nil, nil, fmt.Errorf("connection is not open")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("query cannot be empty")
	}
	if strings.HasPrefix(text, "{") {
		return m.queryJSON(ctx, text)
	}

	parsed, ok := parseMilvusSQL(text)
	if !ok {
		return nil, nil, fmt.Errorf("Milvus queries support JSON commands or simple SELECT previews")
	}
	if parsed.Count {
		total, err := m.countEntities(ctx, parsed.Collection, parsed.Filter)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	return m.queryEntities(ctx, parsed.Collection, parsed.Filter, parsed.OutputFields, parsed.Limit, parsed.Offset)
}

func (m *MilvusDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultMilvusQueryTimeout)
	defer cancel()
	return m.ExecContext(ctx, query)
}

func (m *MilvusDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if m.client == nil {
		return 0, fmt.Errorf("connection is not open")
	}
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("Milvus write commands must be JSON: %w", err)
	}

	if name := firstStringValue(cmd, "create_collection", "createCollection"); name != "" {
		return 1, m.createCollection(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "drop_collection", "dropCollection"); name != "" {
		return 1, m.dropCollection(ctx, name)
	}
	if name := firstStringValue(cmd, "insert", "collection"); name != "" && hasAnyKey(cmd, "insert") {
		rows := milvusCommandRows(cmd)
		if len(rows) == 0 {
			return 0, fmt.Errorf("Milvus insert command requires data or rows")
		}
		return int64(len(rows)), m.insertEntities(ctx, name, rows)
	}
	if name := firstStringValue(cmd, "upsert", "collection"); name != "" && hasAnyKey(cmd, "upsert") {
		rows := milvusCommandRows(cmd)
		if len(rows) == 0 {
			return 0, fmt.Errorf("Milvus upsert command requires data or rows")
		}
		return int64(len(rows)), m.upsertEntities(ctx, name, rows, false)
	}
	if name := firstStringValue(cmd, "delete", "collection"); name != "" && hasAnyKey(cmd, "delete") {
		return m.deleteCommand(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "create_index", "createIndex", "collection"); name != "" && hasAnyKey(cmd, "create_index", "createIndex") {
		return 1, m.createIndex(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "drop_index", "dropIndex", "collection"); name != "" && hasAnyKey(cmd, "drop_index", "dropIndex") {
		return 1, m.dropIndex(ctx, name, firstStringValue(cmd, "index_name", "indexName", "field_name", "fieldName"))
	}
	return 0, fmt.Errorf("Milvus JSON write commands support create_collection/drop_collection/insert/upsert/delete/create_index/drop_index")
}

func (m *MilvusDB) GetDatabases() ([]string, error) {
	if m.client == nil {
		return nil, fmt.Errorf("connection is not open")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(m), 10*time.Second)
	defer cancel()

	var raw interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusDatabasesListPath, map[string]interface{}{}, &raw); err != nil {
		if _, fallbackErr := m.listCollections(ctx, m.database); fallbackErr == nil {
			logger.Warnf("Milvus 数据库列表接口不可用，回退到当前数据库 %s: %v", m.database, err)
			return []string{m.database}, nil
		}
		return nil, err
	}
	names := milvusNamesFromValue(raw, "dbNames", "databases", "names")
	if len(names) == 0 {
		names = []string{m.database}
	}
	return names, nil
}

func (m *MilvusDB) GetTables(dbName string) ([]string, error) {
	return m.listCollections(metadataContextFor(m), m.databaseName(dbName))
}

func (m *MilvusDB) GetCreateStatement(dbName, tableName string) (string, error) {
	info, err := m.getCollectionInfo(metadataContextFor(m), m.databaseName(dbName), tableNameOrDB(dbName, tableName))
	if err != nil {
		return "", err
	}
	payload, _ := json.MarshalIndent(info, "", "  ")
	return fmt.Sprintf("// Milvus collection: %s\n%s", tableNameOrDB(dbName, tableName), string(payload)), nil
}

func (m *MilvusDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	info, err := m.getCollectionInfo(metadataContextFor(m), m.databaseName(dbName), tableNameOrDB(dbName, tableName))
	if err != nil {
		return nil, err
	}
	fields := milvusMapSlice(info["fields"])
	columns := make([]connection.ColumnDefinition, 0, len(fields))
	for _, field := range fields {
		name := firstStringValue(field, "name", "fieldName")
		if name == "" {
			continue
		}
		dataType := firstStringValue(field, "type", "dataType")
		if dataType == "" {
			dataType = "unknown"
		}
		nullable := "NO"
		if milvusBoolValue(firstExisting(field, "nullable"), false) {
			nullable = "YES"
		}
		key := ""
		if milvusBoolValue(firstExisting(field, "primaryKey", "isPrimary", "isPrimaryKey"), false) {
			key = "PRI"
			nullable = "NO"
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     name,
			Type:     dataType,
			Nullable: nullable,
			Key:      key,
			Comment:  firstStringValue(field, "description", "comment"),
		})
	}
	return columns, nil
}

func (m *MilvusDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := m.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	result := make([]connection.ColumnDefinitionWithTable, 0)
	var failures []MetadataObjectFailure
	for _, table := range tables {
		columns, columnErr := m.GetColumns(dbName, table)
		if columnErr != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: table, Err: columnErr})
			continue
		}
		for _, column := range columns {
			result = append(result, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      column.Name,
				Type:      column.Type,
				Comment:   column.Comment,
			})
		}
	}
	return result, NewPartialMetadataError(failures)
}

func (m *MilvusDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	info, err := m.getCollectionInfo(metadataContextFor(m), m.databaseName(dbName), tableNameOrDB(dbName, tableName))
	if err != nil {
		return nil, err
	}
	indexes := make([]connection.IndexDefinition, 0)
	for _, field := range milvusMapSlice(info["fields"]) {
		if !milvusBoolValue(firstExisting(field, "primaryKey", "isPrimary", "isPrimaryKey"), false) {
			continue
		}
		if name := firstStringValue(field, "name", "fieldName"); name != "" {
			indexes = append(indexes, connection.IndexDefinition{Name: "PRIMARY", ColumnName: name, NonUnique: 0, SeqInIndex: 1, IndexType: "PRIMARY"})
		}
	}
	hasVectorIndex := false
	for _, index := range milvusMapSlice(info["indexes"]) {
		fieldName := firstStringValue(index, "fieldName", "field", "columnName")
		if fieldName == "" {
			continue
		}
		indexName := firstStringValue(index, "indexName", "name")
		if indexName == "" {
			indexName = "VECTOR_" + fieldName
		}
		indexType := firstStringValue(index, "indexType", "type")
		if indexType == "" {
			indexType = "VECTOR"
		}
		indexes = append(indexes, connection.IndexDefinition{
			Name:       indexName,
			ColumnName: fieldName,
			NonUnique:  1,
			SeqInIndex: 1,
			IndexType:  indexType,
		})
		hasVectorIndex = true
	}
	if !hasVectorIndex {
		for _, field := range milvusMapSlice(info["fields"]) {
			fieldType := strings.ToLower(firstStringValue(field, "type", "dataType"))
			if !strings.Contains(fieldType, "vector") {
				continue
			}
			if name := firstStringValue(field, "name", "fieldName"); name != "" {
				indexes = append(indexes, connection.IndexDefinition{Name: "VECTOR_" + name, ColumnName: name, NonUnique: 1, SeqInIndex: 1, IndexType: "VECTOR"})
			}
		}
	}
	return indexes, nil
}

func (m *MilvusDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (m *MilvusDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (m *MilvusDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return m.ApplyChangesContext(context.Background(), tableName, changes)
}

func (m *MilvusDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	ctx, cancel := context.WithTimeout(ctx, defaultMilvusQueryTimeout)
	defer cancel()
	collection := strings.TrimSpace(tableName)
	if collection == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	primary, err := m.primaryFieldInfo(ctx, collection)
	if err != nil {
		return err
	}
	writeApplied := false
	writeError := func(err error) error {
		if writeApplied {
			return MarkWriteOutcomeUnknown(err)
		}
		return err
	}

	if len(changes.Deletes) > 0 {
		ids := milvusRowIDs(changes.Deletes, primary.name)
		if len(ids) != len(changes.Deletes) {
			return fmt.Errorf("Milvus delete is missing primary key field %q", primary.name)
		}
		if len(ids) > 0 {
			filter, filterErr := milvusIDFilterWithType(primary.name, primary.typeName, ids)
			if filterErr != nil {
				return writeError(filterErr)
			}
			if err := m.deleteEntities(ctx, collection, filter); err != nil {
				return writeError(err)
			}
			writeApplied = true
		}
	}

	if len(changes.Updates) > 0 {
		rows := make([]map[string]interface{}, 0, len(changes.Updates))
		for _, update := range changes.Updates {
			row := make(map[string]interface{}, len(update.Keys)+len(update.Values))
			for key, value := range update.Keys {
				row[key] = value
			}
			for key, value := range update.Values {
				row[key] = value
			}
			id, ok := milvusRowID(row, primary.name)
			if !ok {
				return writeError(fmt.Errorf("Milvus update is missing primary key field %q", primary.name))
			}
			filter, filterErr := milvusIDFilterWithType(primary.name, primary.typeName, []interface{}{id})
			if filterErr != nil {
				return writeError(filterErr)
			}
			existingRows, _, queryErr := m.queryEntities(ctx, collection, filter, []string{"*"}, 1, 0)
			if queryErr != nil {
				return writeError(queryErr)
			}
			if len(existingRows) == 0 {
				return writeError(fmt.Errorf("Milvus entity with %s=%v was not found", primary.name, id))
			}
			merged := existingRows[0]
			for key, value := range row {
				merged[key] = value
			}
			rows = append(rows, merged)
		}
		if len(rows) > 0 {
			if err := m.upsertEntities(ctx, collection, rows, false); err != nil {
				return writeError(err)
			}
			writeApplied = true
		}
	}

	if len(changes.Inserts) > 0 {
		if err := m.insertEntities(ctx, collection, changes.Inserts); err != nil {
			return writeError(err)
		}
	}
	return nil
}
