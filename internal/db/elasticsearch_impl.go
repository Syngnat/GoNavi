//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	"github.com/elastic/go-elasticsearch/v8"
	"github.com/elastic/go-elasticsearch/v8/esapi"
)

const (
	defaultEsPingTimeout      = 5 * time.Second
	defaultEsQueryTimeout     = 30 * time.Second
	defaultEsIndexListTimeout = 10 * time.Second
	maxEsCatIndexListTimeout  = 4 * time.Second
)

// ElasticsearchDB 实现 Database 接口，提供 Elasticsearch 数据源连接能力。
type ElasticsearchDB struct {
	client           *elasticsearch.Client
	database         string // 默认索引名
	pingTimeout      time.Duration
	indexListTimeout time.Duration // 0 表示使用默认索引枚举总超时
	forwarder        *ssh.LocalForwarder
}

type esHTTPStatusError struct {
	statusCode int
	status     string
}

func (e *esHTTPStatusError) Error() string {
	return e.status
}

// Connect 建立到 Elasticsearch 集群的连接。
func (e *ElasticsearchDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = e.Close()
	defer func() {
		if err != nil {
			_ = e.Close()
		}
	}()

	runConfig := normalizeElasticsearchConfig(config)
	e.pingTimeout = getConnectTimeout(runConfig)
	e.database = strings.TrimSpace(runConfig.Database)

	logger.Infof("Elasticsearch 连接准备：地址=%s:%d 用户=%s SSL=%t SSH=%t 超时=%s",
		runConfig.Host, runConfig.Port, runConfig.User, runConfig.UseSSL, runConfig.UseSSH, e.pingTimeout)

	// SSH 隧道支持
	if runConfig.UseSSH {
		logger.Infof("Elasticsearch 使用 SSH 连接：地址=%s:%d", runConfig.Host, runConfig.Port)
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		e.forwarder = forwarder

		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("Elasticsearch 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	// SSL 回退尝试
	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var lastErr error
	for idx, attempt := range attempts {
		sslLabel := esSSLAttemptLabel(attempt, idx > 0)
		logger.Infof("Elasticsearch 连接尝试：%d/%d 模式=%s 地址=%s:%d",
			idx+1, len(attempts), sslLabel, attempt.Host, attempt.Port)

		esCfg := buildESClientConfig(attempt)
		client, err := elasticsearch.NewClient(esCfg)
		if err != nil {
			logger.Warnf("Elasticsearch 创建客户端失败：%d/%d 模式=%s 错误=%v", idx+1, len(attempts), sslLabel, err)
			lastErr = err
			continue
		}

		e.client = client
		if err := e.Ping(); err != nil {
			e.client = nil
			logger.Warnf("Elasticsearch 连接验证失败：%d/%d 模式=%s 错误=%v", idx+1, len(attempts), sslLabel, err)
			lastErr = err
			continue
		}
		logger.Infof("Elasticsearch 连接成功：%d/%d 模式=%s", idx+1, len(attempts), sslLabel)
		if idx > 0 {
			logger.Warnf("Elasticsearch SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}

	if lastErr != nil {
		return fmt.Errorf("Elasticsearch 连接失败：%w", lastErr)
	}
	return fmt.Errorf("Elasticsearch 连接失败：无可用连接方案")
}

// Close 关闭 Elasticsearch 连接并释放底层资源。
func (e *ElasticsearchDB) Close() error {
	if e.forwarder != nil {
		if err := e.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Elasticsearch SSH 端口转发失败：%v", err)
		}
		e.forwarder = nil
	}
	if e.client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.client.Close(ctx); err != nil {
			logger.Warnf("关闭 Elasticsearch 客户端失败：%v", err)
		}
		e.client = nil
	}
	return nil
}

// Ping 检测 Elasticsearch 连通性。
func (e *ElasticsearchDB) Ping() error {
	if e.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	timeout := e.pingTimeout
	if timeout <= 0 {
		timeout = defaultEsPingTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	res, err := e.client.Ping(e.client.Ping.WithContext(ctx))
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("Elasticsearch Ping 失败：%s", res.Status())
	}
	return nil
}

// Query 执行 Elasticsearch 查询，支持 JSON DSL 和 query_string 两种模式。
func (e *ElasticsearchDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultEsQueryTimeout)
	defer cancel()
	return e.queryWithContext(ctx, query)
}

// QueryContext 带上下文执行 Elasticsearch 查询，支持外部超时控制。
func (e *ElasticsearchDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return e.queryWithContext(ctx, query)
}

// queryWithContext 查询的核心实现，被 Query 和 QueryContext 共用。
func (e *ElasticsearchDB) queryWithContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if e.client == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}

	// Elasticsearch 不支持 information_schema / pg_catalog 等关系型元数据查询。
	// 前端会为视图、函数、触发器等功能自动生成这些查询，直接返回空结果避免报错。
	if isESMetadataQuery(query) {
		return []map[string]interface{}{}, []string{}, nil
	}

	// 优先尝试 DevTools 风格解析
	if req, ok := parseESConsoleRequest(query); ok {
		return e.esQueryConsole(ctx, req)
	}

	// JSON DSL（以 { 开头）
	if isJSONDSL(query) {
		return e.esQueryWithDSL(ctx, query)
	}

	// query_string
	return e.esQueryWithString(ctx, query)
}

// validateESConsolePath 校验 DevTools 风格请求的路径和方法是否安全。
// 使用规范化路径匹配，而非子字符串匹配。
func validateESConsolePath(method, rawPath string) error {
	method = strings.ToUpper(strings.TrimSpace(method))
	cleanPath := "/" + strings.TrimPrefix(strings.TrimSpace(rawPath), "/")

	// 拒绝写入端点
	for _, blocked := range []string{"/_bulk", "/_delete_by_query", "/_update_by_query"} {
		if cleanPath == blocked || strings.HasSuffix(cleanPath, blocked) {
			return fmt.Errorf("Elasticsearch DevTools 查询拒绝：不支持的写入端点 %s", rawPath)
		}
	}

	switch {
	// _search: GET / POST
	case cleanPath == "/_search" || strings.HasSuffix(cleanPath, "/_search"):
		if method != "GET" && method != "POST" {
			return fmt.Errorf("Elasticsearch _search 端点仅支持 GET/POST")
		}
		return nil

	// _mapping / _settings: 仅 GET
	case cleanPath == "/_mapping" || strings.HasSuffix(cleanPath, "/_mapping"):
		return requireESMethod(method, "GET")
	case cleanPath == "/_settings" || strings.HasSuffix(cleanPath, "/_settings"):
		return requireESMethod(method, "GET")

	// _cluster/health: 仅 GET
	case cleanPath == "/_cluster/health":
		return requireESMethod(method, "GET")

	// _resolve/index: 仅 GET（支持 /_resolve/index 和 /_resolve/index/*）
	case cleanPath == "/_resolve/index" || strings.HasPrefix(cleanPath, "/_resolve/index/"):
		return requireESMethod(method, "GET")

	default:
		return fmt.Errorf("Elasticsearch DevTools 查询拒绝：不支持的端点 %s（仅允许 _search/_mapping/_settings/_cluster/health/_resolve/index）", rawPath)
	}
}

// requireESMethod 检查方法是否在允许列表中。
func requireESMethod(method string, allowed ...string) error {
	for _, a := range allowed {
		if method == a {
			return nil
		}
	}
	return fmt.Errorf("Elasticsearch 端点不支持 %s 方法，仅允许 %s", method, strings.Join(allowed, "/"))
}

// esQueryConsole 执行 Kibana DevTools 风格查询。
// 使用低层 Perform 方法发送原始 HTTP 请求。
func (e *ElasticsearchDB) esQueryConsole(ctx context.Context, req esConsoleRequest) ([]map[string]interface{}, []string, error) {
	if err := validateESConsolePath(req.Method, req.Path); err != nil {
		return nil, nil, err
	}

	// 构建 HTTP 请求
	var bodyReader *bytes.Reader
	if req.Body != "" {
		bodyReader = bytes.NewReader([]byte(req.Body))
	} else {
		bodyReader = bytes.NewReader([]byte{})
	}

	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.Path, bodyReader)
	if err != nil {
		return nil, nil, fmt.Errorf("构造 DevTools 请求失败：%w", err)
	}
	if req.Body != "" {
		httpReq.Header.Set("Content-Type", "application/json")
	}

	// 发送请求
	httpRes, err := e.client.Perform(httpReq)
	if err != nil {
		return nil, nil, fmt.Errorf("Elasticsearch DevTools 请求失败：%w", err)
	}
	defer httpRes.Body.Close()

	// 读取响应
	body, err := io.ReadAll(httpRes.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("读取 DevTools 响应失败：%w", err)
	}

	if httpRes.StatusCode >= 400 {
		return nil, nil, fmt.Errorf("Elasticsearch DevTools 查询错误：%s", string(body))
	}

	// _search 端点使用标准响应解析
	if strings.Contains(req.Path, "/_search") {
		return e.parseConsoleSearchResponse(body)
	}

	// 其他端点返回原始 JSON 作为单行结果
	var pretty map[string]interface{}
	if err := json.Unmarshal(body, &pretty); err != nil {
		// 非 JSON 响应，返回纯文本
		return []map[string]interface{}{{"result": string(body)}}, []string{"result"}, nil
	}
	formatted, _ := json.MarshalIndent(pretty, "", "  ")
	return []map[string]interface{}{{"result": string(formatted)}}, []string{"result"}, nil
}

// parseConsoleSearchResponse 解析 DevTools _search 响应。
func (e *ElasticsearchDB) parseConsoleSearchResponse(body []byte) ([]map[string]interface{}, []string, error) {
	return parseSearchResponseJSON(body)
}

// Exec 不支持 Elasticsearch 非查询语句执行。
func (e *ElasticsearchDB) Exec(query string) (int64, error) {
	return 0, fmt.Errorf("Elasticsearch 不支持执行非查询语句")
}

// ExecContext 带上下文的 Exec，ES 不支持非查询语句执行。
func (e *ElasticsearchDB) ExecContext(_ context.Context, _ string) (int64, error) {
	return 0, fmt.Errorf("Elasticsearch 不支持执行非查询语句")
}

// GetDatabases 列出所有 Elasticsearch 索引。
func (e *ElasticsearchDB) GetDatabases() ([]string, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	totalTimeout := e.indexListTimeout
	if totalTimeout <= 0 {
		totalTimeout = defaultEsIndexListTimeout
	}
	deadline := time.Now().Add(totalTimeout)
	catTimeout := totalTimeout / 2
	if catTimeout > maxEsCatIndexListTimeout {
		catTimeout = maxEsCatIndexListTimeout
	}
	if catTimeout <= 0 {
		catTimeout = totalTimeout
	}

	catCtx, cancelCat := context.WithTimeout(context.Background(), catTimeout)
	indices, catErr := e.getDatabasesViaCat(catCtx)
	cancelCat()
	if catErr == nil {
		return normalizeESIndexNames(indices), nil
	}

	logger.Warnf("Elasticsearch CAT 索引枚举失败，回退 Alias API：%v", catErr)
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, fmt.Errorf("获取索引列表失败：CAT Indices API: %v；Alias API: 总超时 %s 已耗尽", catErr, totalTimeout)
	}

	aliasCtx, cancelAlias := context.WithTimeout(context.Background(), remaining)
	indices, aliasErr := e.getDatabasesViaAlias(aliasCtx)
	cancelAlias()
	if aliasErr == nil {
		return normalizeESIndexNames(indices), nil
	}
	return nil, fmt.Errorf("获取索引列表失败：CAT Indices API: %v；Alias API: %v", catErr, aliasErr)
}

func (e *ElasticsearchDB) getDatabasesViaCat(ctx context.Context) ([]string, error) {
	indices, err := e.getDatabasesViaCatRequest(ctx, true)
	if err == nil {
		return indices, nil
	}

	var statusErr *esHTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.statusCode != http.StatusBadRequest {
		return nil, err
	}

	indices, compatibilityErr := e.getDatabasesViaCatRequest(ctx, false)
	if compatibilityErr != nil {
		return nil, fmt.Errorf("全量通配请求: %v；旧版兼容请求: %v", err, compatibilityErr)
	}
	return indices, nil
}

func (e *ElasticsearchDB) getDatabasesViaCatRequest(ctx context.Context, expandAll bool) ([]string, error) {
	options := []func(*esapi.CatIndicesRequest){
		e.client.Cat.Indices.WithContext(ctx),
		e.client.Cat.Indices.WithFormat("json"),
		e.client.Cat.Indices.WithH("index"),
	}
	if expandAll {
		options = append(options, e.client.Cat.Indices.WithExpandWildcards("all"))
	}

	res, err := e.client.Cat.Indices(options...)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.IsError() {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil, &esHTTPStatusError{statusCode: res.StatusCode, status: res.Status()}
	}

	var rows []struct {
		Index string `json:"index"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rows); err != nil {
		return nil, fmt.Errorf("解析响应失败：%w", err)
	}

	indices := make([]string, 0, len(rows))
	for _, row := range rows {
		indices = append(indices, row.Index)
	}
	return indices, nil
}

func (e *ElasticsearchDB) getDatabasesViaAlias(ctx context.Context) ([]string, error) {
	res, err := e.client.Indices.GetAlias(
		e.client.Indices.GetAlias.WithContext(ctx),
		e.client.Indices.GetAlias.WithIndex("*"),
		e.client.Indices.GetAlias.WithExpandWildcards("all"),
		e.client.Indices.GetAlias.WithAllowNoIndices(true),
		e.client.Indices.GetAlias.WithIgnoreUnavailable(true),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.IsError() {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil, &esHTTPStatusError{statusCode: res.StatusCode, status: res.Status()}
	}

	var indexMap map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&indexMap); err != nil {
		return nil, fmt.Errorf("解析响应失败：%w", err)
	}

	indices := make([]string, 0, len(indexMap))
	for name := range indexMap {
		indices = append(indices, name)
	}
	return indices, nil
}

func normalizeESIndexNames(indices []string) []string {
	seen := make(map[string]struct{}, len(indices))
	result := make([]string, 0, len(indices))
	for _, index := range indices {
		name := strings.TrimSpace(index)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

// GetTables 对 ES 而言索引即表，返回索引自身名称及别名。
func (e *ElasticsearchDB) GetTables(dbName string) ([]string, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	target := strings.TrimSpace(dbName)
	if target == "" {
		target = e.database
	}
	if target == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	tables := []string{target}
	aliases := e.esFetchIndexAliases(target)
	tables = append(tables, aliases...)
	return tables, nil
}

// GetCreateStatement 返回索引的 settings + mappings 组合 JSON。
func (e *ElasticsearchDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if e.client == nil {
		return "", localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(dbName, tableName, e.database)
	if indexName == "" {
		return "", fmt.Errorf("未指定索引名")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.Get(
		[]string{indexName},
		e.client.Indices.Get.WithContext(ctx),
	)
	if err != nil {
		return "", fmt.Errorf("获取索引定义失败：%w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return "", fmt.Errorf("获取索引定义失败：%s", res.Status())
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", fmt.Errorf("读取索引定义失败：%w", err)
	}

	var pretty map[string]interface{}
	if err := json.Unmarshal(body, &pretty); err != nil {
		return string(body), nil
	}
	formatted, _ := json.MarshalIndent(pretty, "", "  ")
	return fmt.Sprintf("// Elasticsearch index: %s\n%s", indexName, string(formatted)), nil
}

// GetColumns 返回索引的 mapping 字段定义。
func (e *ElasticsearchDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(dbName, tableName, e.database)
	if indexName == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	mapping, err := e.esFetchIndexMapping(indexName)
	if err != nil {
		return nil, err
	}
	return extractColumnsFromMapping(indexName, mapping), nil
}

// GetAllColumns 返回索引的全部字段定义（带表名标识）。
func (e *ElasticsearchDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	target := strings.TrimSpace(dbName)
	if target == "" {
		target = e.database
	}
	if target == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	mapping, err := e.esFetchIndexMapping(target)
	if err != nil {
		return nil, err
	}

	columns := extractColumnsFromMapping(target, mapping)
	result := make([]connection.ColumnDefinitionWithTable, 0, len(columns))
	for _, col := range columns {
		result = append(result, connection.ColumnDefinitionWithTable{
			TableName: target,
			Name:      col.Name,
			Type:      col.Type,
			Comment:   col.Comment,
		})
	}
	return result, nil
}

// GetIndexes 返回索引的 settings 中定义的分片与副本信息。
func (e *ElasticsearchDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(dbName, tableName, e.database)
	if indexName == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetSettings(
		e.client.Indices.GetSettings.WithContext(ctx),
		e.client.Indices.GetSettings.WithIndex(indexName),
	)
	if err != nil {
		return nil, fmt.Errorf("获取索引设置失败：%w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("获取索引设置失败：%s", res.Status())
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("读取索引设置失败：%w", err)
	}

	var settings map[string]map[string]interface{}
	if err := json.Unmarshal(body, &settings); err != nil {
		return nil, fmt.Errorf("解析索引设置失败：%w", err)
	}

	var indexes []connection.IndexDefinition

	// ES 无传统主键概念，_id 字段是每条文档的唯一标识，等效于主键。
	// 返回 _id 作为 "PRIMARY" 索引，使前端识别到唯一标识并解除只读模式。
	indexes = append(indexes, connection.IndexDefinition{
		Name:       "PRIMARY",
		ColumnName: "_id",
		NonUnique:  0,
		SeqInIndex: 1,
		IndexType:  "PRIMARY",
	})

	for name, data := range settings {
		idxSettings, _ := data["settings"].(map[string]interface{})
		indexSection, _ := idxSettings["index"].(map[string]interface{})

		shards := "1"
		replicas := "1"
		if s, ok := indexSection["number_of_shards"].(string); ok {
			shards = s
		}
		if r, ok := indexSection["number_of_replicas"].(string); ok {
			replicas = r
		}

		indexes = append(indexes, connection.IndexDefinition{
			Name:       name,
			ColumnName: fmt.Sprintf("shards=%s replicas=%s", shards, replicas),
			NonUnique:  0,
			SeqInIndex: 1,
			IndexType:  "INDEX",
		})
	}
	return indexes, nil
}

// GetForeignKeys ES 不支持外键，返回空列表。
func (e *ElasticsearchDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

// GetTriggers ES 不支持触发器，返回空列表。
func (e *ElasticsearchDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

// esBulkActionMeta 构建 ES _bulk API 的 action 行元数据。
// ES 6.x 需要 _type 字段，ES 7.x+ 已废弃。
func (e *ElasticsearchDB) esBulkActionMeta(action, indexName string, docID string) map[string]interface{} {
	meta := map[string]interface{}{
		"_index": indexName,
		"_type":  "_doc",
	}
	if docID != "" {
		meta["_id"] = docID
	}
	return map[string]interface{}{action: meta}
}

// resolveWriteIndex 解析别名对应的实际可写索引名。
// 如果 indexOrAlias 是直接索引名，原样返回。
// 如果是别名，返回该别名下最新的索引名（按名称倒序）。
func (e *ElasticsearchDB) resolveWriteIndex(indexOrAlias string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetAlias(
		e.client.Indices.GetAlias.WithContext(ctx),
		e.client.Indices.GetAlias.WithIndex(indexOrAlias),
	)
	if err != nil {
		return indexOrAlias, nil // 网络错误时回退到原名
	}
	defer res.Body.Close()

	if res.IsError() {
		// 404 表示不是别名而是直接索引名
		return indexOrAlias, nil
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return indexOrAlias, nil
	}

	var aliasMap map[string]interface{}
	if err := json.Unmarshal(body, &aliasMap); err != nil {
		return indexOrAlias, nil
	}

	// aliasMap 的 key 是实际索引名，如果没有 key 或只有一个，直接用
	var indices []string
	for name := range aliasMap {
		indices = append(indices, name)
	}

	if len(indices) == 0 {
		return indexOrAlias, nil
	}
	if len(indices) == 1 {
		return indices[0], nil
	}

	// 多个索引对应同一别名时，取名称最新的（ES 通常用日期后缀，倒序取第一个）
	sort.Sort(sort.Reverse(sort.StringSlice(indices)))
	return indices[0], nil
}

// isESMetaField 判断字段名是否为 ES 元字段（不应写入文档 _source）。
func isESMetaField(name string) bool {
	switch strings.TrimSpace(name) {
	case "_id", "_index", "_type", "_score", "_source", "_routing", "_version", "_seq_no", "_primary_term", "_aggregations":
		return true
	}
	return false
}

// ApplyChanges 实现 BatchApplier 接口，通过 ES _bulk API 批量提交增删改。
func (e *ElasticsearchDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if e.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(tableName, "", e.database)
	if indexName == "" {
		return fmt.Errorf("未指定索引名")
	}

	var bulkBody bytes.Buffer

	// 如果目标是别名（非直接索引），解析出实际的可写索引名。
	writeIndexName := indexName
	if resolved, err := e.resolveWriteIndex(indexName); err == nil && resolved != "" {
		writeIndexName = resolved
	}

	// resolveWriteIndex 确定写操作的目标索引。
	// 如果文档数据中包含 _index（来自查询结果），使用实际索引名而非别名。
	resolveWriteIndex := func(vals map[string]interface{}) string {
		if idx, ok := vals["_index"]; ok {
			if idxStr := strings.TrimSpace(fmt.Sprintf("%v", idx)); idxStr != "" {
				return idxStr
			}
		}
		return writeIndexName
	}

	// 删除操作
	for _, pk := range changes.Deletes {
		idVal, ok := pk["_id"]
		if !ok {
			return fmt.Errorf("删除操作缺少 _id")
		}
		writeIdx := resolveWriteIndex(pk)
		actionJSON, _ := json.Marshal(e.esBulkActionMeta("delete", writeIdx, fmt.Sprintf("%v", idVal)))
		bulkBody.Write(actionJSON)
		bulkBody.WriteByte('\n')
	}

	// 更新操作
	for _, update := range changes.Updates {
		idVal, ok := update.Keys["_id"]
		if !ok {
			return fmt.Errorf("更新操作缺少 _id")
		}
		writeIdx := resolveWriteIndex(update.Values)
		actionJSON, _ := json.Marshal(e.esBulkActionMeta("update", writeIdx, fmt.Sprintf("%v", idVal)))
		bulkBody.Write(actionJSON)
		bulkBody.WriteByte('\n')

		// 过滤 ES 元字段，只保留实际文档字段
		doc := make(map[string]interface{}, len(update.Values))
		for k, v := range update.Values {
			if !isESMetaField(k) {
				doc[k] = v
			}
		}
		wrapper := map[string]interface{}{"doc": doc}
		docJSON, _ := json.Marshal(wrapper)
		bulkBody.Write(docJSON)
		bulkBody.WriteByte('\n')
	}

	// 新增操作
	for _, insert := range changes.Inserts {
		var docID string
		if id, ok := insert["_id"]; ok {
			docID = fmt.Sprintf("%v", id)
		}

		// 从文档中移除 _id 和其他 ES 元字段
		doc := make(map[string]interface{}, len(insert))
		for k, v := range insert {
			if !isESMetaField(k) {
				doc[k] = v
			}
		}

		writeIdx := resolveWriteIndex(insert)
		actionJSON, _ := json.Marshal(e.esBulkActionMeta("index", writeIdx, docID))
		bulkBody.Write(actionJSON)
		bulkBody.WriteByte('\n')
		docJSON, _ := json.Marshal(doc)
		bulkBody.Write(docJSON)
		bulkBody.WriteByte('\n')
	}

	if bulkBody.Len() == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	res, err := e.client.Bulk(
		bytes.NewReader(bulkBody.Bytes()),
		e.client.Bulk.WithContext(ctx),
	)
	if err != nil {
		return fmt.Errorf("ES 批量操作失败：%w", err)
	}
	defer res.Body.Close()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("读取 ES 批量操作响应失败：%w", err)
	}

	if res.IsError() {
		return fmt.Errorf("ES 批量操作错误：%s", string(body))
	}

	// 检查是否有单条操作失败
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err == nil {
		if hasErrors, ok := result["errors"].(bool); ok && hasErrors {
			if items, ok := result["items"].([]interface{}); ok {
				for _, item := range items {
					itemMap, ok := item.(map[string]interface{})
					if !ok {
						continue
					}
					for _, op := range itemMap {
						opMap, ok := op.(map[string]interface{})
						if !ok {
							continue
						}
						if errMap, ok := opMap["error"].(map[string]interface{}); ok {
							reason, _ := errMap["reason"].(string)
							return fmt.Errorf("ES 批量操作部分失败：%s", reason)
						}
					}
				}
			}
			return fmt.Errorf("ES 批量操作部分失败")
		}
	}

	logger.Infof("ES 批量操作完成：索引=%s 删除=%d 更新=%d 新增=%d",
		indexName, len(changes.Deletes), len(changes.Updates), len(changes.Inserts))
	return nil
}
