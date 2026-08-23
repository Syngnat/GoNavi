package db

import (
	"bytes"
	"context"
	"encoding/base64"
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
	defaultQdrantPort         = 6333
	defaultQdrantDatabase     = "default"
	defaultQdrantQueryTimeout = 30 * time.Second
)

type QdrantDB struct {
	client      *http.Client
	baseURL     string
	database    string
	authHeaders map[string]string
	forwarder   *ssh.LocalForwarder
}

type qdrantCollectionInfo struct {
	Name string `json:"name"`
}

type qdrantListCollectionsResponse struct {
	Result struct {
		Collections []qdrantCollectionInfo `json:"collections"`
	} `json:"result"`
}

type qdrantCollectionResponse struct {
	Result map[string]interface{} `json:"result"`
}

type qdrantPoint struct {
	ID      interface{}            `json:"id"`
	Payload map[string]interface{} `json:"payload"`
	Vector  interface{}            `json:"vector"`
	Score   interface{}            `json:"score"`
	Version interface{}            `json:"version"`
}

type qdrantScrollResponse struct {
	Result struct {
		Points         []qdrantPoint `json:"points"`
		NextPageOffset interface{}   `json:"next_page_offset"`
	} `json:"result"`
}

type qdrantSearchResponse struct {
	Result []qdrantPoint `json:"result"`
}

type qdrantCountResponse struct {
	Result struct {
		Count int64 `json:"count"`
	} `json:"result"`
}

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
	ctx, cancel := context.WithTimeout(context.Background(), defaultQdrantQueryTimeout)
	defer cancel()

	if len(changes.Deletes) > 0 {
		ids := make([]interface{}, 0, len(changes.Deletes))
		for _, row := range changes.Deletes {
			if id, ok := qdrantRowID(row); ok {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			if _, err := q.deleteCommand(ctx, tableName, map[string]interface{}{"points": ids}); err != nil {
				return err
			}
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
				return err
			}
		}
		if len(upserts) > 0 {
			if err := q.upsertRows(ctx, tableName, upserts); err != nil {
				return err
			}
		}
	}

	if len(changes.Inserts) > 0 {
		if err := q.upsertRows(ctx, tableName, changes.Inserts); err != nil {
			return err
		}
	}
	return nil
}

func normalizeQdrantConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyQdrantURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultQdrantPort
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		runConfig.SSLMode = "required"
	}
	return runConfig
}

func applyQdrantURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "http" && scheme != "https" && scheme != "qdrant" {
		return config
	}
	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}
	if scheme == "https" {
		config.UseSSL = true
	}
	if host := strings.TrimSpace(parsed.Host); host != "" {
		if h, port, ok := parseHostPortWithDefault(host, defaultQdrantPort); ok {
			config.Host = h
			config.Port = port
		}
	}
	if dbName := strings.Trim(strings.TrimSpace(parsed.Path), "/"); dbName != "" && !strings.HasPrefix(dbName, "collections") && strings.TrimSpace(config.Database) == "" {
		config.Database = dbName
	}
	return config
}

func buildQdrantBaseURL(config connection.ConnectionConfig) string {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s:%d", scheme, strings.TrimSpace(config.Host), config.Port)
}

func qdrantDatabaseFromConfig(config connection.ConnectionConfig) string {
	if dbName := strings.TrimSpace(config.Database); dbName != "" {
		return dbName
	}
	return defaultQdrantDatabase
}

func qdrantConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "http", "https", "qdrant"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func qdrantAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := qdrantConnectionParams(config)
	apiKey := firstNonEmpty(params.Get("apiKey"), params.Get("apikey"), params.Get("api-key"), params.Get("token"), params.Get("authToken"))
	if apiKey == "" && strings.TrimSpace(config.User) == "" {
		apiKey = strings.TrimSpace(config.Password)
	}
	if apiKey != "" {
		headers["api-key"] = apiKey
	} else if user := strings.TrimSpace(config.User); user != "" {
		raw := user + ":" + config.Password
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(raw))
	}
	if headerName := strings.TrimSpace(params.Get("authHeader")); headerName != "" {
		if headerValue := strings.TrimSpace(params.Get("authHeaderValue")); headerValue != "" && isSafeConnectionParamKey(headerName) {
			headers[headerName] = headerValue
		}
	}
	return headers
}

func buildQdrantHTTPClient(config connection.ConnectionConfig) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialTimeout := getConnectTimeout(config)
	transport.DialContext = (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext
	if tlsConfig, err := resolveGenericTLSConfig(config); err == nil && tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	if config.UseProxy {
		proxyCfg := config.Proxy
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
			defer cancel()
			return proxytunnel.DialContext(dialCtx, proxyCfg, network, addr)
		}
	}
	return &http.Client{Transport: transport}
}

func (q *QdrantDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if q.client == nil {
		return fmt.Errorf("连接未打开")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(q.baseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range q.authHeaders {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}
	res, err := q.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return fmt.Errorf("读取 Qdrant 响应失败：%w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		message := strings.TrimSpace(string(resBody))
		if message == "" {
			message = res.Status
		}
		return fmt.Errorf("Qdrant API %s %s 失败：%s", method, path, message)
	}
	if out == nil || len(bytes.TrimSpace(resBody)) == 0 {
		return nil
	}
	if err := decodeJSONWithUseNumber(resBody, out); err != nil {
		return fmt.Errorf("解析 Qdrant 响应失败：%w", err)
	}
	return nil
}

func (q *QdrantDB) listCollections(ctx context.Context) ([]qdrantCollectionInfo, error) {
	var resp qdrantListCollectionsResponse
	if err := q.doJSON(ctx, http.MethodGet, "/collections", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Result.Collections, nil
}

func (q *QdrantDB) getCollectionInfo(ctx context.Context, collection string) (map[string]interface{}, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, fmt.Errorf("collection 名称不能为空")
	}
	var resp qdrantCollectionResponse
	if err := q.doJSON(ctx, http.MethodGet, fmt.Sprintf("/collections/%s", url.PathEscape(name)), nil, &resp); err != nil {
		return nil, err
	}
	return resp.Result, nil
}

func (q *QdrantDB) scrollPoints(ctx context.Context, collection string, limit int, offset interface{}, filter interface{}, withPayload bool, withVector bool) ([]map[string]interface{}, []string, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, nil, fmt.Errorf("collection 名称不能为空")
	}
	if limit <= 0 {
		limit = 200
	}
	body := map[string]interface{}{
		"limit":        limit,
		"with_payload": withPayload,
		"with_vector":  withVector,
	}
	if offset != nil && strings.TrimSpace(fmt.Sprintf("%v", offset)) != "" {
		body["offset"] = qdrantNormalizePointID(offset)
	}
	if filter != nil {
		body["filter"] = filter
	}
	var resp qdrantScrollResponse
	if err := q.doJSON(ctx, http.MethodPost, fmt.Sprintf("/collections/%s/points/scroll", url.PathEscape(name)), body, &resp); err != nil {
		return nil, nil, err
	}
	rows := qdrantPointRows(resp.Result.Points)
	if resp.Result.NextPageOffset != nil {
		for _, row := range rows {
			row["next_page_offset"] = resp.Result.NextPageOffset
		}
	}
	return rows, collectColumns(rows), nil
}

func (q *QdrantDB) searchPoints(ctx context.Context, collection string, cmd map[string]interface{}) ([]map[string]interface{}, []string, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, nil, fmt.Errorf("collection 名称不能为空")
	}
	vector := firstExisting(cmd, "vector", "query_vector", "queryVector")
	if vector == nil {
		return nil, nil, fmt.Errorf("Qdrant search 命令缺少 vector")
	}
	body := map[string]interface{}{
		"vector":       normalizeQdrantVector(vector),
		"limit":        intFromAny(firstExisting(cmd, "limit", "n_results", "nResults"), 10),
		"with_payload": qdrantBoolValue(firstExisting(cmd, "with_payload", "withPayload"), true),
		"with_vector":  qdrantBoolValue(firstExisting(cmd, "with_vector", "withVector"), true),
	}
	for _, key := range []string{"filter", "params", "score_threshold", "offset"} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	var resp qdrantSearchResponse
	if err := q.doJSON(ctx, http.MethodPost, fmt.Sprintf("/collections/%s/points/search", url.PathEscape(name)), body, &resp); err != nil {
		return nil, nil, err
	}
	rows := qdrantPointRows(resp.Result)
	return rows, collectColumns(rows), nil
}

func (q *QdrantDB) countPoints(ctx context.Context, collection string, filter interface{}) (int64, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return 0, fmt.Errorf("collection 名称不能为空")
	}
	body := map[string]interface{}{"exact": true}
	if filter != nil {
		body["filter"] = filter
	}
	var resp qdrantCountResponse
	if err := q.doJSON(ctx, http.MethodPost, fmt.Sprintf("/collections/%s/points/count", url.PathEscape(name)), body, &resp); err != nil {
		return 0, err
	}
	return resp.Result.Count, nil
}

func (q *QdrantDB) queryJSON(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(text), &cmd); err != nil {
		return nil, nil, fmt.Errorf("Qdrant JSON 命令解析失败：%w", err)
	}
	if hasAnyKey(cmd, "list_collections", "listCollections") {
		collections, err := q.listCollections(ctx)
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(collections))
		for _, collection := range collections {
			rows = append(rows, map[string]interface{}{"name": collection.Name})
		}
		return rows, collectColumns(rows), nil
	}
	if name := firstStringValue(cmd, "get_collection", "getCollection"); name != "" {
		info, err := q.getCollectionInfo(ctx, name)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{info}, collectColumns([]map[string]interface{}{info}), nil
	}
	if name := firstStringValue(cmd, "count", "collection"); name != "" && hasAnyKey(cmd, "count") {
		total, err := q.countPoints(ctx, name, cmd["filter"])
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	if name := firstStringValue(cmd, "search", "query", "collection"); name != "" && hasAnyKey(cmd, "search", "query", "vector", "query_vector", "queryVector") {
		return q.searchPoints(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "scroll", "get", "collection"); name != "" {
		limit := intFromAny(cmd["limit"], 200)
		offset := firstExisting(cmd, "offset", "next_page_offset", "nextPageOffset")
		return q.scrollPoints(
			ctx,
			name,
			limit,
			offset,
			cmd["filter"],
			qdrantBoolValue(firstExisting(cmd, "with_payload", "withPayload"), true),
			qdrantBoolValue(firstExisting(cmd, "with_vector", "withVector"), true),
		)
	}
	return nil, nil, fmt.Errorf("Qdrant JSON 查询命令仅支持 list_collections/get_collection/count/scroll/search")
}

func (q *QdrantDB) createCollection(ctx context.Context, name string, cmd map[string]interface{}) error {
	collection := strings.TrimSpace(name)
	if collection == "" {
		return fmt.Errorf("collection 名称不能为空")
	}
	body := make(map[string]interface{})
	if vectors, ok := cmd["vectors"]; ok {
		body["vectors"] = vectors
	} else {
		size := intFromAny(firstExisting(cmd, "size", "vector_size", "vectorSize"), 0)
		if size <= 0 {
			return fmt.Errorf("Qdrant create_collection 命令缺少 vectors 或 size")
		}
		distance := firstStringValue(cmd, "distance", "metric")
		if distance == "" {
			distance = "Cosine"
		}
		body["vectors"] = map[string]interface{}{"size": size, "distance": distance}
	}
	for _, key := range []string{
		"sparse_vectors",
		"shard_number",
		"replication_factor",
		"write_consistency_factor",
		"on_disk_payload",
		"hnsw_config",
		"optimizers_config",
		"wal_config",
		"quantization_config",
		"strict_mode_config",
		"init_from",
	} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	return q.doJSON(ctx, http.MethodPut, fmt.Sprintf("/collections/%s", url.PathEscape(collection)), body, nil)
}

func (q *QdrantDB) deleteCollection(ctx context.Context, name string) error {
	collection := strings.TrimSpace(name)
	if collection == "" {
		return fmt.Errorf("collection 名称不能为空")
	}
	return q.doJSON(ctx, http.MethodDelete, fmt.Sprintf("/collections/%s", url.PathEscape(collection)), nil, nil)
}

func (q *QdrantDB) createPayloadIndex(ctx context.Context, collection string, cmd map[string]interface{}) error {
	fieldName := firstStringValue(cmd, "field_name", "fieldName", "field")
	if fieldName == "" {
		return fmt.Errorf("Qdrant create_payload_index 命令缺少 field_name")
	}
	fieldSchema := firstExisting(cmd, "field_schema", "fieldSchema", "schema")
	if fieldSchema == nil {
		fieldSchema = "keyword"
	}
	body := map[string]interface{}{
		"field_name":   fieldName,
		"field_schema": fieldSchema,
	}
	return q.doJSON(ctx, http.MethodPut, fmt.Sprintf("/collections/%s/index", url.PathEscape(collection)), body, nil)
}

func (q *QdrantDB) deletePayloadIndex(ctx context.Context, collection, fieldName string) error {
	return q.doJSON(ctx, http.MethodDelete, fmt.Sprintf("/collections/%s/index/%s", url.PathEscape(collection), url.PathEscape(fieldName)), nil, nil)
}

func (q *QdrantDB) upsertCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	if rowsValue, ok := cmd["rows"].([]interface{}); ok {
		rows := make([]map[string]interface{}, 0, len(rowsValue))
		for _, raw := range rowsValue {
			if row, ok := raw.(map[string]interface{}); ok {
				rows = append(rows, row)
			}
		}
		return int64(len(rows)), q.upsertRows(ctx, collection, rows)
	}
	if points, ok := cmd["points"]; ok {
		body := map[string]interface{}{"points": points}
		return int64(len(anySlice(points))), q.doJSON(ctx, http.MethodPut, fmt.Sprintf("/collections/%s/points?wait=true", url.PathEscape(collection)), body, nil)
	}
	return 0, fmt.Errorf("Qdrant upsert 命令缺少 rows 或 points")
}

func (q *QdrantDB) deleteCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	body := make(map[string]interface{})
	if points, ok := cmd["points"]; ok {
		body["points"] = qdrantPointIDSlice(points)
	} else if ids, ok := cmd["ids"]; ok {
		body["points"] = qdrantPointIDSlice(ids)
	} else if filter, ok := cmd["filter"]; ok {
		body["filter"] = filter
	}
	if len(body) == 0 {
		return 0, fmt.Errorf("Qdrant delete 命令缺少 points/ids/filter")
	}
	count := int64(len(anySlice(firstExisting(body, "points"))))
	return count, q.doJSON(ctx, http.MethodPost, fmt.Sprintf("/collections/%s/points/delete?wait=true", url.PathEscape(collection)), body, nil)
}

func (q *QdrantDB) upsertRows(ctx context.Context, collection string, rows []map[string]interface{}) error {
	if len(rows) == 0 {
		return nil
	}
	points := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		id, ok := qdrantRowID(row)
		if !ok {
			return fmt.Errorf("Qdrant 写入行缺少 id")
		}
		vector, hasVector := qdrantRowVector(row)
		if !hasVector {
			return fmt.Errorf("Qdrant upsert 行缺少 vector/embedding")
		}
		points = append(points, map[string]interface{}{
			"id":      id,
			"vector":  vector,
			"payload": qdrantPayloadFromRow(row),
		})
	}
	body := map[string]interface{}{"points": points}
	return q.doJSON(ctx, http.MethodPut, fmt.Sprintf("/collections/%s/points?wait=true", url.PathEscape(collection)), body, nil)
}

func (q *QdrantDB) setPayloadFromRow(ctx context.Context, collection string, row map[string]interface{}) error {
	id, ok := qdrantRowID(row)
	if !ok {
		return fmt.Errorf("Qdrant payload 更新缺少 id")
	}
	payload := qdrantPayloadFromRow(row)
	if len(payload) == 0 {
		return nil
	}
	body := map[string]interface{}{
		"points":  []interface{}{id},
		"payload": payload,
	}
	return q.doJSON(ctx, http.MethodPost, fmt.Sprintf("/collections/%s/points/payload?wait=true", url.PathEscape(collection)), body, nil)
}

type qdrantParsedSQL struct {
	Collection    string
	Limit         int
	Offset        interface{}
	Count         bool
	IncludeVector bool
	Filter        interface{}
	WhereError    error
}

var qdrantSQLFromRE = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))`)
var qdrantSQLLimitRE = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
var qdrantSQLOffsetRE = regexp.MustCompile(`(?i)\bOFFSET\s+([a-zA-Z0-9_.\-]+)`)

func parseQdrantSQL(sqlText string) (qdrantParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return qdrantParsedSQL{}, false
	}
	matches := qdrantSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return qdrantParsedSQL{}, false
	}
	collection := firstNonEmpty(matches[1], matches[2], matches[3])
	if collection == "" {
		return qdrantParsedSQL{}, false
	}
	parsed := qdrantParsedSQL{Collection: collection, Limit: 200}
	lower := strings.ToLower(text)
	parsed.Count = strings.Contains(lower, "count(")
	parsed.IncludeVector = strings.Contains(lower, "vector")
	whereExpr, _, whereErr := parseVectorSQLWhere(text)
	if whereErr == nil {
		whereErr = validateQdrantWhereExpr(whereExpr)
	}
	parsed.WhereError = whereErr
	if whereErr == nil && whereExpr != nil {
		parsed.Filter = qdrantFilterFromExpr(whereExpr)
	}
	if m := qdrantSQLLimitRE.FindStringSubmatch(text); len(m) > 1 {
		parsed.Limit, _ = strconv.Atoi(m[1])
	}
	if m := qdrantSQLOffsetRE.FindStringSubmatch(text); len(m) > 1 {
		parsed.Offset = qdrantNormalizePointID(m[1])
	}
	return parsed, true
}

func qdrantPointRows(points []qdrantPoint) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(points))
	for _, point := range points {
		row := map[string]interface{}{"id": point.ID}
		if point.Score != nil {
			row["score"] = point.Score
		}
		if point.Version != nil {
			row["version"] = point.Version
		}
		if point.Vector != nil {
			row["vector"] = normalizeJSONLikeValue(point.Vector)
		}
		if point.Payload != nil {
			row["payload"] = point.Payload
			for key, value := range point.Payload {
				row["payload."+key] = value
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func qdrantRowID(row map[string]interface{}) (interface{}, bool) {
	raw := firstExisting(row, "id", "_id")
	if raw == nil {
		return nil, false
	}
	text := strings.TrimSpace(fmt.Sprintf("%v", raw))
	if text == "" || text == "<nil>" {
		return nil, false
	}
	return qdrantNormalizePointID(raw), true
}

func qdrantNormalizePointID(value interface{}) interface{} {
	switch v := value.(type) {
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return n
		}
	case float64:
		if v == float64(int64(v)) {
			return int64(v)
		}
	case float32:
		if v == float32(int64(v)) {
			return int64(v)
		}
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return v
	case string:
		text := strings.TrimSpace(v)
		if n, err := strconv.ParseInt(text, 10, 64); err == nil {
			return n
		}
		return text
	}
	return value
}

func qdrantPointIDSlice(value interface{}) []interface{} {
	items := anySlice(value)
	result := make([]interface{}, 0, len(items))
	for _, item := range items {
		result = append(result, qdrantNormalizePointID(item))
	}
	return result
}

func qdrantRowVector(row map[string]interface{}) (interface{}, bool) {
	vector := firstExisting(row, "vector", "_vector", "vectors", "embedding", "_embedding")
	if vector == nil {
		return nil, false
	}
	return normalizeQdrantVector(vector), true
}

func normalizeQdrantVector(value interface{}) interface{} {
	if text, ok := value.(string); ok {
		var parsed interface{}
		if err := decodeJSONWithUseNumber([]byte(text), &parsed); err == nil {
			return parsed
		}
	}
	return value
}

func qdrantPayloadFromRow(row map[string]interface{}) map[string]interface{} {
	payload := make(map[string]interface{})
	if raw, ok := row["payload"].(map[string]interface{}); ok {
		for key, value := range raw {
			payload[key] = value
		}
	}
	for key, value := range row {
		if isQdrantReservedRowField(key) {
			continue
		}
		if strings.HasPrefix(key, "payload.") {
			payload[strings.TrimPrefix(key, "payload.")] = value
			continue
		}
		payload[key] = value
	}
	return payload
}

func isQdrantReservedRowField(key string) bool {
	switch key {
	case "id", "_id", "vector", "_vector", "vectors", "embedding", "_embedding", "payload", "score", "version", "next_page_offset":
		return true
	default:
		return false
	}
}

func qdrantBoolValue(value interface{}, fallback bool) bool {
	if value == nil {
		return fallback
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		text := strings.TrimSpace(strings.ToLower(v))
		if text == "" {
			return fallback
		}
		return text == "1" || text == "true" || text == "yes" || text == "on"
	default:
		return fallback
	}
}

func qdrantVectorIndexes(info map[string]interface{}) []connection.IndexDefinition {
	vectors := nestedMapValue(info, "config", "params", "vectors")
	if len(vectors) == 0 {
		return nil
	}
	if _, ok := vectors["size"]; ok {
		return []connection.IndexDefinition{{Name: "VECTOR", ColumnName: "vector", NonUnique: 1, SeqInIndex: 1, IndexType: "VECTOR"}}
	}
	var indexes []connection.IndexDefinition
	names := make([]string, 0, len(vectors))
	for name := range vectors {
		names = append(names, name)
	}
	sort.Strings(names)
	for index, name := range names {
		indexes = append(indexes, connection.IndexDefinition{
			Name:       "VECTOR_" + name,
			ColumnName: "vector." + name,
			NonUnique:  1,
			SeqInIndex: index + 1,
			IndexType:  "VECTOR",
		})
	}
	return indexes
}

func qdrantPayloadIndexes(info map[string]interface{}) []connection.IndexDefinition {
	schema := nestedMapValue(info, "payload_schema")
	if len(schema) == 0 {
		schema = nestedMapValue(info, "payload_schema", "schema")
	}
	if len(schema) == 0 {
		return nil
	}
	names := make([]string, 0, len(schema))
	for name := range schema {
		names = append(names, name)
	}
	sort.Strings(names)
	indexes := make([]connection.IndexDefinition, 0, len(names))
	for index, name := range names {
		indexes = append(indexes, connection.IndexDefinition{
			Name:       "PAYLOAD_" + name,
			ColumnName: "payload." + name,
			NonUnique:  1,
			SeqInIndex: index + 1,
			IndexType:  "PAYLOAD",
		})
	}
	return indexes
}

func qdrantPayloadSchemaColumns(info map[string]interface{}) []connection.ColumnDefinition {
	schema := nestedMapValue(info, "payload_schema")
	if len(schema) == 0 {
		schema = nestedMapValue(info, "payload_schema", "schema")
	}
	if len(schema) == 0 {
		return nil
	}
	names := make([]string, 0, len(schema))
	for name := range schema {
		if strings.TrimSpace(name) != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	columns := make([]connection.ColumnDefinition, 0, len(names))
	for _, name := range names {
		fieldType := "json"
		if definition, ok := schema[name].(map[string]interface{}); ok {
			if dataType := strings.TrimSpace(mapString(definition, "data_type")); dataType != "" {
				fieldType = dataType
			}
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     "payload." + name,
			Type:     fieldType,
			Nullable: "YES",
			Comment:  "Payload schema field",
		})
	}
	return columns
}

func nestedMapValue(value interface{}, path ...string) map[string]interface{} {
	current := value
	for _, key := range path {
		m, ok := current.(map[string]interface{})
		if !ok {
			return nil
		}
		current = m[key]
	}
	if m, ok := current.(map[string]interface{}); ok {
		return m
	}
	return nil
}
