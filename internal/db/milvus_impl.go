package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultMilvusPort         = 19530
	defaultMilvusDatabase     = "default"
	defaultMilvusQueryTimeout = 30 * time.Second

	milvusCollectionsListPath     = "/v2/vectordb/collections/list"
	milvusCollectionsDescribePath = "/v2/vectordb/collections/describe"
	milvusCollectionsCreatePath   = "/v2/vectordb/collections/create"
	milvusCollectionsDropPath     = "/v2/vectordb/collections/drop"
	milvusDatabasesListPath       = "/v2/vectordb/databases/list"
	milvusEntitiesQueryPath       = "/v2/vectordb/entities/query"
	milvusEntitiesDeletePath      = "/v2/vectordb/entities/delete"
	milvusEntitiesInsertPath      = "/v2/vectordb/entities/insert"
	milvusEntitiesUpsertPath      = "/v2/vectordb/entities/upsert"
	milvusEntitiesSearchPath      = "/v2/vectordb/entities/search"
	milvusIndexesCreatePath       = "/v2/vectordb/indexes/create"
	milvusIndexesDropPath         = "/v2/vectordb/indexes/drop"
)

// MilvusDB adapts the Milvus REST v2 API to GoNavi's generic database surface.
// Collections are exposed as tables and entity rows as query results.
type MilvusDB struct {
	client      *http.Client
	baseURL     string
	database    string
	authHeaders map[string]string
	forwarder   *ssh.LocalForwarder
}

var _ BatchApplierContext = (*MilvusDB)(nil)

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
	primaryField, err := m.primaryField(ctx, collection)
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
		ids := milvusRowIDs(changes.Deletes, primaryField)
		if len(ids) != len(changes.Deletes) {
			return fmt.Errorf("Milvus delete is missing primary key field %q", primaryField)
		}
		if len(ids) > 0 {
			if err := m.deleteEntities(ctx, collection, milvusIDFilter(primaryField, ids)); err != nil {
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
			id, ok := milvusRowID(row, primaryField)
			if !ok {
				return writeError(fmt.Errorf("Milvus update is missing primary key field %q", primaryField))
			}
			existingRows, _, queryErr := m.queryEntities(ctx, collection, milvusIDFilter(primaryField, []interface{}{id}), []string{"*"}, 1, 0)
			if queryErr != nil {
				return writeError(queryErr)
			}
			if len(existingRows) == 0 {
				return writeError(fmt.Errorf("Milvus entity with %s=%v was not found", primaryField, id))
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

func normalizeMilvusConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyMilvusURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultMilvusPort
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		runConfig.SSLMode = "required"
	}
	return runConfig
}

func applyMilvusURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "http" && scheme != "https" && scheme != "milvus" {
		return config
	}
	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if password, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = password
		}
	}
	if scheme == "https" {
		config.UseSSL = true
	}
	if host := strings.TrimSpace(parsed.Host); host != "" {
		if parsedHost, port, ok := parseHostPortWithDefault(host, defaultMilvusPort); ok {
			config.Host = parsedHost
			config.Port = port
		}
	}
	if strings.TrimSpace(config.Database) == "" {
		if dbName := strings.Trim(strings.TrimSpace(parsed.Path), "/"); dbName != "" && !strings.HasPrefix(dbName, "v2/") {
			config.Database = dbName
		}
	}
	if strings.TrimSpace(config.Database) == "" {
		params := parsed.Query()
		config.Database = firstNonEmpty(params.Get("dbName"), params.Get("database"), params.Get("db"))
	}
	return config
}

func buildMilvusBaseURL(config connection.ConnectionConfig) string {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	host := strings.Trim(strings.TrimSpace(config.Host), "[]")
	return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(config.Port))
}

func milvusDatabaseFromConfig(config connection.ConnectionConfig) string {
	if name := strings.TrimSpace(config.Database); name != "" {
		return name
	}
	params := milvusConnectionParams(config)
	if name := firstNonEmpty(params.Get("dbName"), params.Get("database"), params.Get("db")); name != "" {
		return name
	}
	return defaultMilvusDatabase
}

func milvusConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "http", "https", "milvus"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func milvusAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := milvusConnectionParams(config)
	token := firstNonEmpty(params.Get("token"), params.Get("apiKey"), params.Get("apikey"), params.Get("api-key"), params.Get("authToken"))
	if token == "" {
		if user := strings.TrimSpace(config.User); user != "" {
			token = user + ":" + config.Password
		} else {
			token = strings.TrimSpace(config.Password)
		}
	}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	if headerName := strings.TrimSpace(params.Get("authHeader")); headerName != "" {
		if headerValue := strings.TrimSpace(params.Get("authHeaderValue")); headerValue != "" && isSafeConnectionParamKey(headerName) {
			headers[headerName] = headerValue
		}
	}
	return headers
}

func buildMilvusHTTPClient(config connection.ConnectionConfig) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialTimeout := getConnectTimeout(config)
	transport.DialContext = (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext
	if tlsConfig, err := resolveGenericTLSConfig(config); err == nil && tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	if config.UseProxy {
		proxyConfig := config.Proxy
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
			defer cancel()
			return proxytunnel.DialContext(dialCtx, proxyConfig, network, address)
		}
	}
	return &http.Client{Transport: transport}
}

func (m *MilvusDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if m.client == nil {
		return fmt.Errorf("connection is not open")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(m.baseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Type-Allow-Int64", "true")
	for key, value := range m.authHeaders {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}

	response, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := readLimitedJSONResponseBody(response.Body)
	if err != nil {
		return fmt.Errorf("read Milvus response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(string(responseBody))
		if message == "" {
			message = response.Status
		}
		return fmt.Errorf("Milvus REST API %s %s failed: %s", method, path, message)
	}
	if len(bytes.TrimSpace(responseBody)) == 0 {
		return nil
	}

	var envelope struct {
		Code    json.RawMessage `json:"code"`
		Message string          `json:"message"`
		Msg     string          `json:"msg"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &envelope); err != nil {
		return fmt.Errorf("decode Milvus response: %w", err)
	}
	if len(envelope.Code) > 0 && !milvusSuccessCode(envelope.Code) {
		message := firstNonEmpty(envelope.Message, envelope.Msg, strings.TrimSpace(string(responseBody)))
		return fmt.Errorf("Milvus REST API %s %s failed: %s", method, path, message)
	}
	if out == nil {
		return nil
	}
	data := envelope.Data
	if len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "null" {
		return nil
	}
	if err := decodeJSONWithUseNumber(data, out); err != nil {
		return fmt.Errorf("decode Milvus response data: %w", err)
	}
	return nil
}

func milvusSuccessCode(raw json.RawMessage) bool {
	value := strings.Trim(strings.TrimSpace(string(raw)), "\"")
	return value == "" || value == "0"
}

func (m *MilvusDB) databaseName(value string) string {
	if name := strings.TrimSpace(value); name != "" {
		return name
	}
	return m.database
}

func (m *MilvusDB) listCollections(ctx context.Context, database string) ([]string, error) {
	var raw interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusCollectionsListPath, map[string]interface{}{
		"dbName": m.databaseName(database),
	}, &raw); err != nil {
		return nil, err
	}
	return milvusNamesFromValue(raw, "collections", "collectionNames", "names"), nil
}

func (m *MilvusDB) getCollectionInfo(ctx context.Context, database, collection string) (map[string]interface{}, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, fmt.Errorf("collection name cannot be empty")
	}
	var info map[string]interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusCollectionsDescribePath, map[string]interface{}{
		"dbName":         m.databaseName(database),
		"collectionName": name,
	}, &info); err != nil {
		return nil, err
	}
	return info, nil
}

func (m *MilvusDB) queryEntities(ctx context.Context, collection, filter string, outputFields []string, limit, offset int) ([]map[string]interface{}, []string, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, nil, fmt.Errorf("collection name cannot be empty")
	}
	if limit <= 0 {
		limit = 200
	}
	if len(outputFields) == 0 {
		outputFields = []string{"*"}
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"outputFields":   outputFields,
		"limit":          limit,
	}
	if strings.TrimSpace(filter) != "" {
		body["filter"] = filter
	}
	if offset > 0 {
		body["offset"] = offset
	}
	var raw interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusEntitiesQueryPath, body, &raw); err != nil {
		return nil, nil, err
	}
	rows := milvusRowsFromValue(raw)
	return rows, collectColumns(rows), nil
}

func (m *MilvusDB) countEntities(ctx context.Context, collection, filter string) (int64, error) {
	rows, _, err := m.queryEntities(ctx, collection, filter, []string{"count(*)"}, 1, 0)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return milvusCountValue(firstExisting(rows[0], "count(*)", "count", "total")), nil
}

func (m *MilvusDB) searchEntities(ctx context.Context, collection string, cmd map[string]interface{}) ([]map[string]interface{}, []string, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, nil, fmt.Errorf("collection name cannot be empty")
	}
	data := milvusSearchData(cmd)
	if len(data) == 0 {
		return nil, nil, fmt.Errorf("Milvus search requires data or vector")
	}
	annsField := firstStringValue(cmd, "anns_field", "annsField", "vector_field", "vectorField")
	if annsField == "" {
		var err error
		annsField, err = m.vectorField(ctx, name)
		if err != nil {
			return nil, nil, err
		}
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"data":           data,
		"annsField":      annsField,
		"limit":          intFromAny(firstExisting(cmd, "limit", "n_results", "nResults"), 10),
	}
	if outputFields := stringSliceFromAny(firstExisting(cmd, "output_fields", "outputFields"), nil); len(outputFields) > 0 {
		body["outputFields"] = outputFields
	}
	if filter := firstStringValue(cmd, "filter", "expr"); filter != "" {
		body["filter"] = filter
	}
	if offset := intFromAny(firstExisting(cmd, "offset"), 0); offset > 0 {
		body["offset"] = offset
	}
	if params := firstExisting(cmd, "search_params", "searchParams", "params"); params != nil {
		body["searchParams"] = params
	}
	var raw interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusEntitiesSearchPath, body, &raw); err != nil {
		return nil, nil, err
	}
	rows := milvusRowsFromValue(raw)
	return rows, collectColumns(rows), nil
}

func (m *MilvusDB) queryJSON(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(text), &cmd); err != nil {
		return nil, nil, fmt.Errorf("decode Milvus JSON command: %w", err)
	}
	if hasAnyKey(cmd, "list_collections", "listCollections") {
		collections, err := m.listCollections(ctx, m.database)
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(collections))
		for _, name := range collections {
			rows = append(rows, map[string]interface{}{"name": name})
		}
		return rows, []string{"name"}, nil
	}
	if name := firstStringValue(cmd, "describe_collection", "describeCollection", "get_collection", "getCollection"); name != "" {
		info, err := m.getCollectionInfo(ctx, m.database, name)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{info}, collectColumns([]map[string]interface{}{info}), nil
	}
	if name := firstStringValue(cmd, "count", "collection"); name != "" && hasAnyKey(cmd, "count") {
		total, err := m.countEntities(ctx, name, firstStringValue(cmd, "filter", "expr"))
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	if name := firstStringValue(cmd, "search", "collection", "query"); name != "" && (hasAnyKey(cmd, "search", "vector", "query_vector", "queryVector", "data")) {
		return m.searchEntities(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "query", "scroll", "get", "collection"); name != "" {
		return m.queryEntities(
			ctx,
			name,
			firstStringValue(cmd, "filter", "expr"),
			stringSliceFromAny(firstExisting(cmd, "output_fields", "outputFields", "fields"), []string{"*"}),
			intFromAny(firstExisting(cmd, "limit"), 200),
			intFromAny(firstExisting(cmd, "offset"), 0),
		)
	}
	return nil, nil, fmt.Errorf("Milvus JSON query commands support list_collections/describe_collection/query/count/search")
}

func (m *MilvusDB) createCollection(ctx context.Context, collection string, cmd map[string]interface{}) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
	}
	if dimension := intFromAny(firstExisting(cmd, "dimension", "dim"), 0); dimension > 0 {
		body["dimension"] = dimension
	}
	for _, item := range []struct {
		keys []string
		name string
	}{
		{[]string{"metric_type", "metricType"}, "metricType"},
		{[]string{"primary_field_name", "primaryFieldName"}, "primaryFieldName"},
		{[]string{"vector_field_name", "vectorFieldName"}, "vectorFieldName"},
		{[]string{"vector_field_type", "vectorFieldType"}, "vectorFieldType"},
		{[]string{"id_type", "idType"}, "idType"},
		{[]string{"consistency_level", "consistencyLevel"}, "consistencyLevel"},
		{[]string{"description"}, "description"},
	} {
		if value := firstExisting(cmd, item.keys...); value != nil {
			body[item.name] = value
		}
	}
	if value := firstExisting(cmd, "auto_id", "autoID"); value != nil {
		body["autoID"] = milvusBoolValue(value, false)
	}
	if value := firstExisting(cmd, "schema"); value != nil {
		body["schema"] = value
	}
	if value := firstExisting(cmd, "index_params", "indexParams"); value != nil {
		body["indexParams"] = value
	}
	if value := firstExisting(cmd, "params"); value != nil {
		body["params"] = value
	}
	if value := firstExisting(cmd, "properties"); value != nil {
		body["properties"] = value
	}
	return m.doJSON(ctx, http.MethodPost, milvusCollectionsCreatePath, body, nil)
}

func (m *MilvusDB) dropCollection(ctx context.Context, collection string) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	return m.doJSON(ctx, http.MethodPost, milvusCollectionsDropPath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
	}, nil)
}

func (m *MilvusDB) insertEntities(ctx context.Context, collection string, rows []map[string]interface{}) error {
	return m.writeEntities(ctx, milvusEntitiesInsertPath, collection, rows, false)
}

func (m *MilvusDB) upsertEntities(ctx context.Context, collection string, rows []map[string]interface{}, partialUpdate bool) error {
	return m.writeEntities(ctx, milvusEntitiesUpsertPath, collection, rows, partialUpdate)
}

func (m *MilvusDB) writeEntities(ctx context.Context, path, collection string, rows []map[string]interface{}, partialUpdate bool) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	if len(rows) == 0 {
		return nil
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"data":           rows,
	}
	if partialUpdate {
		body["partialUpdate"] = true
	}
	return m.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (m *MilvusDB) deleteCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	filter := firstStringValue(cmd, "filter", "expr")
	count := int64(0)
	if filter == "" {
		ids := anySlice(firstExisting(cmd, "ids", "id", "primary_keys", "primaryKeys"))
		if len(ids) == 0 {
			return 0, fmt.Errorf("Milvus delete command requires filter or ids")
		}
		primaryField, err := m.primaryField(ctx, collection)
		if err != nil {
			return 0, err
		}
		filter = milvusIDFilter(primaryField, ids)
		count = int64(len(ids))
	}
	if err := m.deleteEntities(ctx, collection, filter); err != nil {
		return 0, err
	}
	return count, nil
}

func (m *MilvusDB) deleteEntities(ctx context.Context, collection, filter string) error {
	if strings.TrimSpace(filter) == "" {
		return fmt.Errorf("Milvus delete filter cannot be empty")
	}
	return m.doJSON(ctx, http.MethodPost, milvusEntitiesDeletePath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": strings.TrimSpace(collection),
		"filter":         filter,
	}, nil)
}

func (m *MilvusDB) createIndex(ctx context.Context, collection string, cmd map[string]interface{}) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	indexParams := firstExisting(cmd, "index_params", "indexParams")
	if indexParams == nil {
		fieldName := firstStringValue(cmd, "field_name", "fieldName")
		if fieldName == "" {
			return fmt.Errorf("Milvus create_index command requires field_name or index_params")
		}
		index := map[string]interface{}{"fieldName": fieldName}
		if indexName := firstStringValue(cmd, "index_name", "indexName"); indexName != "" {
			index["indexName"] = indexName
		}
		if metricType := firstStringValue(cmd, "metric_type", "metricType"); metricType != "" {
			index["metricType"] = metricType
		}
		if indexType := firstStringValue(cmd, "index_type", "indexType"); indexType != "" {
			index["indexType"] = indexType
		}
		if params := firstExisting(cmd, "params"); params != nil {
			index["params"] = params
		}
		indexParams = []map[string]interface{}{index}
	}
	return m.doJSON(ctx, http.MethodPost, milvusIndexesCreatePath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"indexParams":    indexParams,
	}, nil)
}

func (m *MilvusDB) dropIndex(ctx context.Context, collection, indexName string) error {
	if strings.TrimSpace(indexName) == "" {
		return fmt.Errorf("Milvus drop_index command requires index_name")
	}
	return m.doJSON(ctx, http.MethodPost, milvusIndexesDropPath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": strings.TrimSpace(collection),
		"indexName":      strings.TrimSpace(indexName),
	}, nil)
}

func (m *MilvusDB) primaryField(ctx context.Context, collection string) (string, error) {
	info, err := m.getCollectionInfo(ctx, m.database, collection)
	if err != nil {
		return "", err
	}
	for _, field := range milvusMapSlice(info["fields"]) {
		if milvusBoolValue(firstExisting(field, "primaryKey", "isPrimary", "isPrimaryKey"), false) {
			if name := firstStringValue(field, "name", "fieldName"); name != "" {
				return name, nil
			}
		}
	}
	return "", fmt.Errorf("Milvus collection %q has no primary key field", collection)
}

func (m *MilvusDB) vectorField(ctx context.Context, collection string) (string, error) {
	info, err := m.getCollectionInfo(ctx, m.database, collection)
	if err != nil {
		return "", err
	}
	for _, field := range milvusMapSlice(info["fields"]) {
		if !strings.Contains(strings.ToLower(firstStringValue(field, "type", "dataType")), "vector") {
			continue
		}
		if name := firstStringValue(field, "name", "fieldName"); name != "" {
			return name, nil
		}
	}
	return "", fmt.Errorf("Milvus collection %q has no vector field", collection)
}

type milvusParsedSQL struct {
	Collection   string
	Filter       string
	OutputFields []string
	Limit        int
	Offset       int
	Count        bool
}

var (
	milvusSQLFromRE   = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))`)
	milvusSQLSelectRE = regexp.MustCompile(`(?is)^\s*SELECT\s+(.+?)\s+FROM\s+`)
	milvusSQLLimitRE  = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	milvusSQLOffsetRE = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	milvusSQLWhereRE  = regexp.MustCompile(`(?is)\bWHERE\s+(.+?)(?:\s+\bLIMIT\b|\s+\bOFFSET\b|\s*;?\s*$)`)
)

func parseMilvusSQL(sqlText string) (milvusParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return milvusParsedSQL{}, false
	}
	matches := milvusSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return milvusParsedSQL{}, false
	}
	collection := firstNonEmpty(matches[1], matches[2], matches[3])
	if collection == "" {
		return milvusParsedSQL{}, false
	}
	parsed := milvusParsedSQL{Collection: collection, Limit: 200, OutputFields: []string{"*"}}
	if fieldsMatch := milvusSQLSelectRE.FindStringSubmatch(text); len(fieldsMatch) > 1 {
		parsed.OutputFields = milvusOutputFields(fieldsMatch[1])
		parsed.Count = strings.Contains(strings.ToLower(fieldsMatch[1]), "count(")
	}
	if match := milvusSQLLimitRE.FindStringSubmatch(text); len(match) > 1 {
		parsed.Limit, _ = strconv.Atoi(match[1])
	}
	if match := milvusSQLOffsetRE.FindStringSubmatch(text); len(match) > 1 {
		parsed.Offset, _ = strconv.Atoi(match[1])
	}
	if match := milvusSQLWhereRE.FindStringSubmatch(text); len(match) > 1 {
		parsed.Filter = strings.TrimSpace(match[1])
	}
	return parsed, true
}

func milvusOutputFields(raw string) []string {
	text := strings.TrimSpace(raw)
	if text == "" || text == "*" || strings.Contains(strings.ToLower(text), "count(") {
		return []string{"*"}
	}
	parts := strings.Split(text, ",")
	fields := make([]string, 0, len(parts))
	for _, part := range parts {
		field := strings.Trim(strings.TrimSpace(part), "`\"")
		if field == "" {
			continue
		}
		if aliasIndex := strings.Index(strings.ToLower(field), " as "); aliasIndex >= 0 {
			field = strings.TrimSpace(field[:aliasIndex])
		}
		fields = append(fields, field)
	}
	if len(fields) == 0 {
		return []string{"*"}
	}
	return fields
}

func milvusNamesFromValue(value interface{}, keys ...string) []string {
	if values := anySlice(value); len(values) > 0 {
		return milvusSortedUniqueNames(values)
	}
	if item, ok := value.(map[string]interface{}); ok {
		for _, key := range keys {
			if names := milvusNamesFromValue(item[key]); len(names) > 0 {
				return names
			}
		}
	}
	return []string{}
}

func milvusSortedUniqueNames(values []interface{}) []string {
	seen := make(map[string]struct{}, len(values))
	names := make([]string, 0, len(values))
	for _, value := range values {
		name := strings.TrimSpace(fmt.Sprintf("%v", value))
		if item, ok := value.(map[string]interface{}); ok {
			name = firstStringValue(item, "name", "collectionName", "dbName")
		}
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func milvusMapSlice(value interface{}) []map[string]interface{} {
	items := anySlice(value)
	result := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		if row, ok := item.(map[string]interface{}); ok {
			result = append(result, row)
		}
	}
	return result
}

func milvusRowsFromValue(value interface{}) []map[string]interface{} {
	if rows := milvusMapSlice(value); len(rows) > 0 {
		return rows
	}
	if item, ok := value.(map[string]interface{}); ok {
		for _, key := range []string{"data", "results", "entities"} {
			if rows := milvusRowsFromValue(item[key]); len(rows) > 0 {
				return rows
			}
		}
		if len(item) > 0 {
			return []map[string]interface{}{item}
		}
	}
	return []map[string]interface{}{}
}

func milvusCommandRows(cmd map[string]interface{}) []map[string]interface{} {
	return milvusMapSlice(firstExisting(cmd, "data", "rows", "entities"))
}

func milvusSearchData(cmd map[string]interface{}) []interface{} {
	if data := anySlice(firstExisting(cmd, "data")); len(data) > 0 {
		return data
	}
	vector := firstExisting(cmd, "vector", "query_vector", "queryVector", "embedding")
	if vector == nil {
		return nil
	}
	values := anySlice(vector)
	if len(values) == 0 {
		return nil
	}
	if _, nested := values[0].([]interface{}); nested {
		return values
	}
	return []interface{}{values}
}

func milvusCountValue(value interface{}) int64 {
	switch typed := value.(type) {
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			return parsed
		}
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil {
			return parsed
		}
	}
	return 0
}

func milvusBoolValue(value interface{}, fallback bool) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
		if err == nil {
			return parsed
		}
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil {
			return parsed != 0
		}
	case float64:
		return typed != 0
	case int:
		return typed != 0
	}
	return fallback
}

func milvusRowIDs(rows []map[string]interface{}, primaryField string) []interface{} {
	ids := make([]interface{}, 0, len(rows))
	for _, row := range rows {
		if id, ok := milvusRowID(row, primaryField); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

func milvusRowID(row map[string]interface{}, primaryField string) (interface{}, bool) {
	value := firstExisting(row, primaryField)
	if value == nil && primaryField != "id" {
		value = firstExisting(row, "id", "_id")
	}
	if value == nil || strings.TrimSpace(fmt.Sprintf("%v", value)) == "" {
		return nil, false
	}
	return value, true
}

func milvusIDFilter(primaryField string, ids []interface{}) string {
	literals := make([]string, 0, len(ids))
	for _, id := range ids {
		literals = append(literals, milvusFilterLiteral(id))
	}
	return fmt.Sprintf("%s in [%s]", strings.TrimSpace(primaryField), strings.Join(literals, ", "))
}

func milvusFilterLiteral(value interface{}) string {
	switch typed := value.(type) {
	case json.Number:
		return typed.String()
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", typed)
	case bool:
		return strconv.FormatBool(typed)
	default:
		encoded, err := json.Marshal(fmt.Sprintf("%v", value))
		if err != nil {
			return "\"\""
		}
		return string(encoded)
	}
}
