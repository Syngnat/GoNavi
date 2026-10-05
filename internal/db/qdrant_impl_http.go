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
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
)

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
