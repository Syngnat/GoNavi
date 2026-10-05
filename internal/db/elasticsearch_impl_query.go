//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"GoNavi-Wails/internal/esconsole"
)

// Query 执行 Elasticsearch 查询，支持 JSON DSL 和 query_string 两种模式。
func (e *ElasticsearchDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(metadataContextFor(e), defaultEsQueryTimeout)
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

	// All legacy query entry points are normalized through the same parser and
	// allowlist as the dedicated console. This keeps JSON DSL, query_string and
	// simplified SELECT compatibility without allowing an index value to become
	// URL syntax in go-elasticsearch's WithIndex option.
	batch, err := esconsole.ParseSourceForMajor(query, e.database, e.serverMajor)
	if err != nil {
		return nil, nil, fmt.Errorf("Elasticsearch 查询解析失败：%w", err)
	}
	if len(batch.Requests) != 1 {
		return nil, nil, fmt.Errorf("旧 Elasticsearch 查询入口仅支持一个只读请求")
	}
	request := batch.Requests[0]
	if batch.Blocked || request.Risk == esconsole.RiskBlocked {
		reason := strings.TrimSpace(request.BlockReason)
		if reason == "" {
			reason = "请求不在只读端点白名单中"
		}
		return nil, nil, fmt.Errorf("Elasticsearch 查询拒绝：%s", reason)
	}
	if request.IsWrite || request.Risk != esconsole.RiskRead {
		return nil, nil, fmt.Errorf("旧 Elasticsearch 查询入口仅允许只读请求")
	}
	if compat, err := esconsole.ParseSimplifiedSelect(query); err == nil && !compat.Count && compat.Limit == 0 &&
		(request.Route == "/_search" || request.Route == "/{target}/_search") {
		return e.scrollSimplifiedSelect(ctx, request, compat.Offset, compat.Columns)
	}
	response, err := e.ExecuteElasticsearchConsoleRequest(ctx, ElasticsearchConsoleRequest{
		Method:   request.Method,
		Path:     request.Path,
		Body:     request.Body,
		BodyKind: ElasticsearchConsoleBodyKind(request.BodyKind),
	})
	if err != nil {
		return nil, nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("Elasticsearch 查询错误 (HTTP %d)：%s", response.StatusCode, truncateElasticsearchQueryErrorBody([]byte(response.RawBody)))
	}
	if request.Route == "/_search" || request.Route == "/{target}/_search" {
		return e.parseConsoleSearchResponse([]byte(response.RawBody))
	}
	if request.Route == "/_count" || request.Route == "/{target}/_count" {
		var payload map[string]interface{}
		if err := json.Unmarshal([]byte(response.RawBody), &payload); err != nil {
			return nil, nil, fmt.Errorf("解析 Elasticsearch count 响应失败：%w", err)
		}
		return []map[string]interface{}{{"count": payload["count"]}}, []string{"count"}, nil
	}
	if esconsole.IsQueryPluginRoute(request.Route) {
		if rows, columns, ok := esconsole.ParseJDBCResponse([]byte(response.RawBody)); ok {
			return rows, columns, nil
		}
	}
	var payload interface{}
	if err := json.Unmarshal([]byte(response.RawBody), &payload); err != nil {
		return []map[string]interface{}{{"result": response.RawBody}}, []string{"result"}, nil
	}
	formatted, _ := json.MarshalIndent(payload, "", "  ")
	return []map[string]interface{}{{"result": string(formatted)}}, []string{"result"}, nil
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
	body, err := readElasticsearchQueryResponseBody(httpRes.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("读取 DevTools 响应失败：%w", err)
	}

	if httpRes.StatusCode >= 400 {
		return nil, nil, fmt.Errorf("Elasticsearch DevTools 查询错误：%s", truncateElasticsearchQueryErrorBody(body))
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
