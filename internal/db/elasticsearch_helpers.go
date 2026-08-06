//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

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
	"GoNavi-Wails/internal/esconsole"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"

	"github.com/elastic/go-elasticsearch/v8"
	"github.com/elastic/go-elasticsearch/v8/esapi"
)

const defaultEsPort = 9200

// ---- 配置规范化工具 ----

// normalizeElasticsearchConfig 规范化 Elasticsearch 连接配置。
func normalizeElasticsearchConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyElasticsearchURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultEsPort
	}
	return runConfig
}

// applyElasticsearchURI 从 URI 中解析并回填连接参数。
func applyElasticsearchURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "http" && scheme != "https" {
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
		if strings.TrimSpace(config.SSLMode) == "" {
			config.SSLMode = "required"
		}
	}

	if host := strings.TrimSpace(parsed.Host); host != "" {
		if strings.TrimSpace(config.Host) == "" || config.Host == "localhost" {
			h, port, ok := parseHostPortWithDefault(host, defaultEsPort)
			if ok {
				config.Host = h
				config.Port = port
			}
		}
	}

	// 从 URI path 中解析默认索引（如 http://host:9200/my-index）
	if dbName := strings.TrimPrefix(strings.TrimSpace(parsed.Path), "/"); dbName != "" && strings.TrimSpace(config.Database) == "" {
		config.Database = dbName
	}

	return config
}

// ---- 通用判断工具 ----

// isJSONDSL 判断输入是否为 JSON DSL 格式。
func isJSONDSL(query string) bool {
	return strings.HasPrefix(strings.TrimSpace(query), "{")
}

// isESMetadataQuery 检测是否为关系型数据库元数据查询（information_schema / pg_catalog）。
// 前端为视图、函数、触发器等功能自动生成这些 SQL，ES 不支持，应返回空结果。
func isESMetadataQuery(query string) bool {
	lower := strings.ToLower(query)
	return strings.Contains(lower, "information_schema") ||
		strings.Contains(lower, "pg_catalog") ||
		strings.Contains(lower, "pg_class") ||
		strings.Contains(lower, "pg_namespace")
}

// esConsoleRequest 解析 Kibana DevTools 风格查询。
type esConsoleRequest struct {
	Method string // GET / POST
	Path   string // /index/_search
	Body   string // JSON body（可选）
}

// parseESConsoleRequest 尝试解析 DevTools 风格输入。
// 支持格式：
//
//	GET /logs-*/_search
//	{ "query": { "match_all": {} } }
//
// 返回 (request, true) 表示成功解析。
func parseESConsoleRequest(input string) (esConsoleRequest, bool) {
	lines := strings.SplitN(input, "\n", 2)
	firstLine := strings.TrimSpace(lines[0])
	if firstLine == "" {
		return esConsoleRequest{}, false
	}

	// 第一行格式：METHOD /path
	parts := strings.SplitN(firstLine, " ", 2)
	if len(parts) != 2 {
		return esConsoleRequest{}, false
	}

	method := strings.ToUpper(strings.TrimSpace(parts[0]))
	if method != "GET" && method != "POST" {
		return esConsoleRequest{}, false
	}

	path := strings.TrimSpace(parts[1])
	if !strings.HasPrefix(path, "/") {
		return esConsoleRequest{}, false
	}

	req := esConsoleRequest{Method: method, Path: path}

	// 空行之后是 JSON body（可选）
	if len(lines) > 1 {
		body := strings.TrimSpace(lines[1])
		if body != "" {
			req.Body = body
		}
	}

	return req, true
}

// resolveEsIndexName 从 dbName / tableName / 默认值中确定索引名。
func resolveEsIndexName(dbName, tableName, defaultDB string) string {
	if name := strings.TrimSpace(tableName); name != "" {
		return name
	}
	if name := strings.TrimSpace(dbName); name != "" {
		return name
	}
	return strings.TrimSpace(defaultDB)
}

// reESSQLFrom 匹配 SELECT ... FROM "schema"."table" 或 FROM index（含多段点分标识符）。
// 支持三种格式：
//   - "a"."b"."c"  → a.b.c（引号包裹的多段标识符）
//   - "a.b.c"      → a.b.c（单引号包裹的完整名称）
//   - my_index      → my_index（无引号）
var reESSQLFrom = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"(?:\."([^"]+)")*|([a-zA-Z0-9_*][a-zA-Z0-9_.\-*]*))\s*(?:;|\s|$)`)

// extractESSQLFromTable 从 SQL 语句中提取 FROM 后的索引名。
// 支持多段引号格式（如 "schema"."table"."partition"）和单段格式。
// 返回提取的索引名（可能含 . 或 *），提取失败返回空串。
func extractESSQLFromTable(sql string) string {
	candidate := strings.TrimSpace(sql)
	if strings.HasPrefix(strings.ToUpper(candidate), "FROM ") {
		candidate = "SELECT * " + candidate
	}
	parsed, err := esconsole.ParseSimplifiedSelect(candidate)
	if err != nil {
		return ""
	}
	return parsed.Target
}

// ---- SQL → ES _search 转换层 ----

// esParsedSQL 解析后的 SQL 各组成部分。
type esParsedSQL struct {
	Table   string // FROM 后的索引名
	Columns string // SELECT 列（* 或具体列名）
	Where   string // WHERE 条件原文
	OrderBy string // ORDER BY 子句
	Limit   int    // LIMIT 值，0 表示未指定
	Offset  int    // OFFSET 值，0 表示未指定
}

// reSQLLimit 匹配 LIMIT n（可选 OFFSET m）。
var reSQLLimit = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?`)

// reSQLOffset 匹配独立的 OFFSET n。
var reSQLOffset = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)

// reSQLOrderBy 匹配 ORDER BY 子句。
var reSQLOrderBy = regexp.MustCompile(`(?i)\bORDER\s+BY\s+(.+?)(?:\bLIMIT\b|\bOFFSET\b|$)`)

func trimESTrailingClauseSyntax(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, " \t\r\n;；")
	return strings.TrimSpace(s)
}

// parseESSQL 解析简单 SELECT SQL 为结构化组成部分。
func parseESSQL(sql string) (esParsedSQL, bool) {
	compatibility, err := esconsole.ParseSimplifiedSelect(sql)
	if err != nil {
		return esParsedSQL{}, false
	}
	return esParsedSQL{
		Table:   compatibility.Target,
		Columns: compatibility.Columns,
		Where:   compatibility.Where,
		OrderBy: compatibility.OrderBy,
		Limit:   compatibility.Limit,
		Offset:  compatibility.Offset,
	}, true
}

// convertSQLWhereToESQuery 将简单 SQL WHERE 条件转换为 ES query DSL map。
// 支持的运算符：=, !=, <>, >, <, >=, <=, LIKE, IS NULL, IS NOT NULL。
// 支持 AND / OR 组合和括号分组。
// 对于无法转换的复杂条件，返回 match_all。
func convertSQLWhereToESQuery(where string) map[string]interface{} {
	where = strings.TrimSpace(where)
	if where == "" {
		return nil
	}

	// 去掉最外层括号
	for len(where) >= 2 && where[0] == '(' && where[len(where)-1] == ')' {
		inner := where[1 : len(where)-1]
		if balancedParens(inner) {
			where = inner
		} else {
			break
		}
	}
	where = strings.TrimSpace(where)
	if where == "" {
		return nil
	}

	// 尝试拆分顶层 AND
	if parts := splitTopLevel(where, "AND"); len(parts) > 1 {
		var clauses []map[string]interface{}
		for _, p := range parts {
			if q := convertSQLWhereToESQuery(p); q != nil {
				clauses = append(clauses, q)
			}
		}
		if len(clauses) == 1 {
			return clauses[0]
		}
		if len(clauses) > 1 {
			return map[string]interface{}{"bool": map[string]interface{}{"must": clauses}}
		}
		return nil
	}

	// 尝试拆分顶层 OR
	if parts := splitTopLevel(where, "OR"); len(parts) > 1 {
		var clauses []map[string]interface{}
		for _, p := range parts {
			if q := convertSQLWhereToESQuery(p); q != nil {
				clauses = append(clauses, q)
			}
		}
		if len(clauses) == 1 {
			return clauses[0]
		}
		if len(clauses) > 1 {
			return map[string]interface{}{"bool": map[string]interface{}{"should": clauses}}
		}
		return nil
	}

	// 解析单个条件：field op value
	return parseSingleCondition(where)
}

// parseSingleCondition 解析单个 SQL 条件为 ES query。
func parseSingleCondition(cond string) map[string]interface{} {
	cond = strings.TrimSpace(cond)
	cond = strings.Trim(cond, "()")
	cond = strings.TrimSpace(cond)
	if cond == "" {
		return nil
	}

	// IS NOT NULL
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+IS\s+NOT\s+NULL$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		return map[string]interface{}{
			"exists": map[string]interface{}{"field": cleanIdentifier(m[1])},
		}
	}

	// IS NULL
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+IS\s+NULL$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		return map[string]interface{}{
			"bool": map[string]interface{}{
				"must_not": []map[string]interface{}{
					{"exists": map[string]interface{}{"field": cleanIdentifier(m[1])}},
				},
			},
		}
	}

	// NOT LIKE
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+NOT\s+LIKE\s+'(.+)'$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		pattern := strings.ReplaceAll(m[2], "%", "*")
		pattern = strings.ReplaceAll(pattern, "_", "?")
		return map[string]interface{}{
			"bool": map[string]interface{}{
				"must_not": []map[string]interface{}{
					{"wildcard": map[string]interface{}{cleanIdentifier(m[1]): pattern}},
				},
			},
		}
	}

	// LIKE
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+LIKE\s+'(.+)'$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		pattern := strings.ReplaceAll(m[2], "%", "*")
		pattern = strings.ReplaceAll(pattern, "_", "?")
		return map[string]interface{}{
			"wildcard": map[string]interface{}{cleanIdentifier(m[1]): pattern},
		}
	}

	// != 或 <>
	if idx := findOperator(cond, "!=", "<>"); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 2)
		if field != "" {
			return map[string]interface{}{
				"bool": map[string]interface{}{
					"must_not": []map[string]interface{}{
						{"term": map[string]interface{}{cleanIdentifier(field): parseSQLValue(value)}},
					},
				},
			}
		}
	}

	// >=
	if idx := findOperator(cond, ">="); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 2)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"gte": parseSQLValue(value)}},
			}
		}
	}

	// <=
	if idx := findOperator(cond, "<="); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 2)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"lte": parseSQLValue(value)}},
			}
		}
	}

	// >
	if idx := findOperator(cond, ">"); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 1)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"gt": parseSQLValue(value)}},
			}
		}
	}

	// <
	if idx := findOperator(cond, "<"); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 1)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"lt": parseSQLValue(value)}},
			}
		}
	}

	// =（放在最后，避免匹配 >= <= !=）
	if idx := findOperator(cond, "="); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 1)
		if field != "" {
			return map[string]interface{}{
				"term": map[string]interface{}{cleanIdentifier(field): parseSQLValue(value)},
			}
		}
	}

	// 无法识别的条件，降级为 query_string
	return map[string]interface{}{
		"query_string": map[string]interface{}{"query": cond},
	}
}

// cleanIdentifier 去掉标识符两端的引号。
func cleanIdentifier(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"'`)
	return s
}

// parseSQLValue 将 SQL 字面量转为 Go 值。
func parseSQLValue(s string) interface{} {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"'`)
	// 尝试数值转换
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		return n
	}
	if s == "true" || s == "TRUE" {
		return true
	}
	if s == "false" || s == "FALSE" {
		return false
	}
	return s
}

// findOperator 在条件字符串中查找顶层运算符位置。
func findOperator(cond string, ops ...string) int {
	inQuote := byte(0)
	depth := 0
	for i := 0; i < len(cond); i++ {
		ch := cond[i]
		if ch == '\'' || ch == '"' {
			if inQuote == 0 {
				inQuote = ch
			} else if inQuote == ch {
				inQuote = 0
			}
			continue
		}
		if inQuote != 0 {
			continue
		}
		if ch == '(' {
			depth++
			continue
		}
		if ch == ')' {
			depth--
			continue
		}
		if depth != 0 {
			continue
		}
		for _, op := range ops {
			if i+len(op) <= len(cond) && cond[i:i+len(op)] == op {
				// 确保不是 >= <= <> 的一部分
				if op == ">" && i+1 < len(cond) && (cond[i+1] == '=' || cond[i+1] == '>') {
					continue
				}
				if op == "<" && i+1 < len(cond) && (cond[i+1] == '=' || cond[i+1] == '>') {
					continue
				}
				if op == "!" && i+1 < len(cond) && cond[i+1] != '=' {
					continue
				}
				return i
			}
		}
	}
	return -1
}

// splitAtOperator 在运算符位置拆分 field 和 value。
func splitAtOperator(cond string, idx, opLen int) (string, string) {
	field := strings.TrimSpace(cond[:idx])
	value := strings.TrimSpace(cond[idx+opLen:])
	return field, value
}

// splitTopLevel 在顶层按关键词拆分（忽略括号和引号内的关键词）。
func splitTopLevel(s string, keyword string) []string {
	upper := strings.ToUpper(s)
	kwLen := len(keyword)
	inQuote := byte(0)
	depth := 0
	var parts []string
	last := 0

	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '\'' || ch == '"' {
			if inQuote == 0 {
				inQuote = ch
			} else if inQuote == ch {
				inQuote = 0
			}
			continue
		}
		if inQuote != 0 {
			continue
		}
		if ch == '(' {
			depth++
			continue
		}
		if ch == ')' {
			depth--
			continue
		}
		if depth != 0 {
			continue
		}
		if i+kwLen <= len(upper) && upper[i:i+kwLen] == keyword {
			// 确保是完整单词（前后是空格或括号）
			beforeOK := i == 0 || s[i-1] == ' ' || s[i-1] == '(' || s[i-1] == ')'
			afterIdx := i + kwLen
			afterOK := afterIdx >= len(s) || s[afterIdx] == ' ' || s[afterIdx] == '(' || s[afterIdx] == ')'
			if beforeOK && afterOK {
				parts = append(parts, strings.TrimSpace(s[last:i]))
				last = afterIdx
			}
		}
	}
	parts = append(parts, strings.TrimSpace(s[last:]))
	return parts
}

// balancedParens 检查字符串中的括号是否完全配对。
func balancedParens(s string) bool {
	depth := 0
	inQuote := byte(0)
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '\'' || ch == '"' {
			if inQuote == 0 {
				inQuote = ch
			} else if inQuote == ch {
				inQuote = 0
			}
			continue
		}
		if inQuote != 0 {
			continue
		}
		if ch == '(' {
			depth++
		} else if ch == ')' {
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	return depth == 0
}

// convertSQLOrderByToES 将 SQL ORDER BY 转换为 ES sort 数组。
// 支持 "field" ASC/DESC 和 _score DESC。
func convertSQLOrderByToES(orderBy string) []map[string]interface{} {
	orderBy = strings.TrimSpace(orderBy)
	if orderBy == "" {
		return nil
	}
	var sorts []map[string]interface{}
	for _, part := range strings.Split(orderBy, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		fields := strings.Fields(part)
		field := cleanIdentifier(fields[0])
		order := "asc"
		if len(fields) >= 2 {
			dir := strings.ToUpper(fields[1])
			if dir == "DESC" {
				order = "desc"
			}
		}
		sorts = append(sorts, map[string]interface{}{field: order})
	}
	return sorts
}

// esProductCheckBypassTransport 包装 http.RoundTripper，
// 为 ES 6.x / 7.x 早期版本注入 X-Elastic-Product 响应头。
// go-elasticsearch/v8 在首次成功响应时强制校验此头部，
// 但 ES < 7.14 不返回该头，导致 "unknown product" 错误。
type esProductCheckBypassTransport struct {
	inner http.RoundTripper
}

func (t *esProductCheckBypassTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.inner.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	// 仅在缺失时注入，避免覆盖 ES 7.14+ 已有的合法头部
	if resp.Header.Get("X-Elastic-Product") == "" {
		resp.Header.Set("X-Elastic-Product", "Elasticsearch")
	}
	return resp, nil
}

// ---- ES 客户端配置 ----

// esSSLAttemptLabel 返回连接尝试的模式标签。
func esSSLAttemptLabel(config connection.ConnectionConfig, fallback bool) string {
	if fallback {
		return "明文回退"
	}
	if config.UseSSL {
		return "SSL"
	}
	return "明文"
}

// buildESClientConfig 从连接配置构建 ES 客户端配置。
func buildESClientConfig(config connection.ConnectionConfig) elasticsearch.Config {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}

	address := fmt.Sprintf("%s://%s:%d", scheme, config.Host, config.Port)

	cfg := elasticsearch.Config{
		Addresses:  []string{address},
		Username:   strings.TrimSpace(config.User),
		Password:   config.Password,
		MaxRetries: 1,
	}

	// 从 ConnectionParams 中提取 API Key（优先级高于 Basic Auth）
	if params := connectionParamsFromText(config.ConnectionParams); len(params) > 0 {
		apiKey := strings.TrimSpace(params.Get("apiKey"))
		if apiKey != "" {
			cfg.APIKey = apiKey
			// API Key 认证时清除 Basic Auth
			cfg.Username = ""
			cfg.Password = ""
		}
		// 移除认证参数，不拼入 address URL
		params.Del("apiKey")
		// 重新构建 address（不含认证参数）
		if len(params) > 0 {
			address = fmt.Sprintf("%s://%s:%d?%s", scheme, config.Host, config.Port, params.Encode())
		} else {
			address = fmt.Sprintf("%s://%s:%d", scheme, config.Host, config.Port)
		}
		cfg.Addresses = []string{address}
	}

	// TLS 配置
	tlsConfig, _ := resolveGenericTLSConfig(config)
	if tlsConfig != nil {
		cfg.Transport = &http.Transport{
			TLSClientConfig: tlsConfig,
		}
	}

	// 代理支持
	if config.UseProxy {
		transport, ok := cfg.Transport.(*http.Transport)
		if !ok {
			transport = http.DefaultTransport.(*http.Transport).Clone()
		}
		proxyCfg := config.Proxy
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return proxytunnel.DialContext(ctx, proxyCfg, network, addr)
		}
		cfg.Transport = transport
	}

	// 超时设置
	timeout := getConnectTimeout(config)
	if cfg.Transport == nil {
		cfg.Transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	if transport, ok := cfg.Transport.(*http.Transport); ok {
		transport.ResponseHeaderTimeout = timeout
	}

	// 包装 transport：注入 X-Elastic-Product 头以兼容 ES 6.x / 7.x 早期版本。
	// go-elasticsearch/v8 要求响应中包含此头部，但 ES < 7.14 不返回。
	if cfg.Transport == nil {
		cfg.Transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	cfg.Transport = &esProductCheckBypassTransport{inner: cfg.Transport}

	return cfg
}

// ---- 查询响应解析 ----

// esReservedColumns ES 查询结果中的保留列名，业务字段不应覆盖。
var esReservedColumns = map[string]struct{}{
	"_index":        {},
	"_id":           {},
	"_score":        {},
	"_source":       {},
	"_aggregations": {},
}

// setESSourceField 安全地将 _source 字段写入结果行。
// 如果字段名与保留列冲突，则加 "source." 前缀避免覆盖。
func setESSourceField(row map[string]interface{}, key string, value interface{}) {
	if _, reserved := esReservedColumns[key]; reserved {
		row["source."+key] = value
		return
	}
	if _, exists := row[key]; exists {
		row["source."+key] = value
		return
	}
	row[key] = value
}

// flattenESSource 递归展开 _source 中的嵌套对象。
// 嵌套字段用点分路径表示（如 user.name），数组序列化为 JSON 字符串。
func flattenESSource(prefix string, value interface{}, row map[string]interface{}) {
	switch v := value.(type) {
	case map[string]interface{}:
		for k, child := range v {
			next := k
			if prefix != "" {
				next = prefix + "." + k
			}
			flattenESSource(next, child, row)
		}
	case []interface{}:
		b, _ := json.Marshal(v)
		setESSourceField(row, prefix, string(b))
	default:
		setESSourceField(row, prefix, v)
	}
}

// normalizeESFieldValue 将 ES fields 数组值转为单值或 JSON 字符串。
func normalizeESFieldValue(value interface{}) interface{} {
	arr, ok := value.([]interface{})
	if !ok {
		return value
	}
	if len(arr) == 1 {
		return arr[0]
	}
	b, err := json.Marshal(arr)
	if err != nil {
		return fmt.Sprint(arr)
	}
	return string(b)
}

// esQueryWithDSL 使用 JSON DSL 执行 _search 查询。
func (e *ElasticsearchDB) esQueryWithDSL(ctx context.Context, dsl string) ([]map[string]interface{}, []string, error) {
	indexName := e.database
	if indexName == "" {
		indexName = "*"
	}

	// 尝试从 DSL 的 index 字段中提取索引名
	var dslIndex struct {
		Index string `json:"index"`
	}
	if err := json.Unmarshal([]byte(dsl), &dslIndex); err == nil && strings.TrimSpace(dslIndex.Index) != "" {
		indexName = strings.TrimSpace(dslIndex.Index)
	}

	res, err := e.client.Search(
		e.client.Search.WithContext(ctx),
		e.client.Search.WithIndex(indexName),
		e.client.Search.WithBody(strings.NewReader(dsl)),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("Elasticsearch DSL 查询失败：%w", err)
	}
	defer res.Body.Close()

	return e.parseSearchResponse(res)
}

// esQueryWithString 解析 SQL 并转换为 ES _search API 调用。
// 从 SQL 中提取表名、WHERE 条件、LIMIT/OFFSET、ORDER BY，
// 转换为 ES query DSL 实现正确分页和筛选。
func (e *ElasticsearchDB) esQueryWithString(ctx context.Context, queryStr string) ([]map[string]interface{}, []string, error) {
	parsed, ok := parseESSQL(queryStr)
	if !ok {
		return e.esQueryStringFallback(ctx, queryStr)
	}

	// 检测 COUNT(*) 查询：使用 size=0 获取精确总数
	if isESCountQuery(parsed.Columns) {
		return e.esCountQuery(ctx, parsed.Table, parsed.Where)
	}

	// 构建 ES DSL
	dsl := make(map[string]interface{})

	// WHERE → query
	if parsed.Where != "" {
		if q := convertSQLWhereToESQuery(parsed.Where); q != nil {
			dsl["query"] = q
		}
	}
	if _, hasQuery := dsl["query"]; !hasQuery {
		dsl["query"] = map[string]interface{}{"match_all": map[string]interface{}{}}
	}

	// LIMIT → size, OFFSET → from
	if parsed.Limit > 0 {
		dsl["size"] = parsed.Limit
	} else {
		dsl["size"] = 200 // 默认返回 200 条
	}
	if parsed.Offset > 0 {
		dsl["from"] = parsed.Offset
	}

	// ORDER BY → sort
	if sorts := convertSQLOrderByToES(parsed.OrderBy); len(sorts) > 0 {
		dsl["sort"] = sorts
	}

	body, err := json.Marshal(dsl)
	if err != nil {
		return nil, nil, fmt.Errorf("构造 ES 查询失败：%w", err)
	}

	res, err := e.client.Search(
		e.client.Search.WithContext(ctx),
		e.client.Search.WithIndex(parsed.Table),
		e.client.Search.WithBody(bytes.NewReader(body)),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("Elasticsearch 查询失败：%w", err)
	}
	defer res.Body.Close()

	return e.parseSearchResponse(res)
}

// isESCountQuery 检测 SQL 列列表是否为 COUNT(*) 聚合查询。
func isESCountQuery(columns string) bool {
	upper := strings.ToUpper(strings.TrimSpace(columns))
	return strings.Contains(upper, "COUNT(")
}

// esCountQuery 使用 ES _search size=0 获取精确文档总数。
// 返回格式匹配前端 parseTotalFromCountRow 期望的 [{total: N}], ["total"]。
func (e *ElasticsearchDB) esCountQuery(ctx context.Context, indexName string, where string) ([]map[string]interface{}, []string, error) {
	dsl := map[string]interface{}{
		"size": 0,
	}
	if where != "" {
		if q := convertSQLWhereToESQuery(where); q != nil {
			dsl["query"] = q
		}
	}
	if _, ok := dsl["query"]; !ok {
		dsl["query"] = map[string]interface{}{"match_all": map[string]interface{}{}}
	}

	body, err := json.Marshal(dsl)
	if err != nil {
		return nil, nil, fmt.Errorf("构造 ES COUNT 查询失败：%w", err)
	}

	res, err := e.client.Search(
		e.client.Search.WithContext(ctx),
		e.client.Search.WithIndex(indexName),
		e.client.Search.WithBody(bytes.NewReader(body)),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("Elasticsearch COUNT 查询失败：%w", err)
	}
	defer res.Body.Close()

	respBody, err := readElasticsearchQueryResponseBody(res.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("读取 COUNT 响应失败：%w", err)
	}
	if res.IsError() {
		return nil, nil, fmt.Errorf("Elasticsearch COUNT 查询错误：%s", truncateElasticsearchQueryErrorBody(respBody))
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, nil, fmt.Errorf("解析 COUNT 响应失败：%w", err)
	}

	// 提取 hits.total：ES 6.x 为数字，ES 7.x+ 为 {value, relation} 对象
	var total int64
	if hits, ok := parsed["hits"].(map[string]interface{}); ok {
		switch v := hits["total"].(type) {
		case float64:
			total = int64(v)
		case int64:
			total = v
		case map[string]interface{}:
			if val, ok := v["value"].(float64); ok {
				total = int64(val)
			}
		}
	}

	logger.Infof("ES COUNT 查询结果：索引=%s total=%d", indexName, total)
	return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
}
func (e *ElasticsearchDB) esQueryStringFallback(ctx context.Context, queryStr string) ([]map[string]interface{}, []string, error) {
	indexName := e.database
	if indexName == "" {
		indexName = "*"
	}

	payload := map[string]interface{}{
		"query": map[string]interface{}{
			"query_string": map[string]interface{}{
				"query": queryStr,
			},
		},
		"size": 200,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("构造查询 DSL 失败：%w", err)
	}

	res, err := e.client.Search(
		e.client.Search.WithContext(ctx),
		e.client.Search.WithIndex(indexName),
		e.client.Search.WithBody(bytes.NewReader(body)),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("Elasticsearch 查询失败：%w", err)
	}
	defer res.Body.Close()

	return e.parseSearchResponse(res)
}

// parseSearchResponse 解析 ES 响应为标准行格式。
// 使用原始 JSON 解析，兼容 ES 6.x（hits.total 为数字）和 ES 7.x+（hits.total 为对象）。
func (e *ElasticsearchDB) parseSearchResponse(res *esapi.Response) ([]map[string]interface{}, []string, error) {
	body, err := readElasticsearchQueryResponseBody(res.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("读取查询结果失败：%w", err)
	}

	if res.IsError() {
		return nil, nil, fmt.Errorf("Elasticsearch 查询错误：%s", truncateElasticsearchQueryErrorBody(body))
	}

	return parseSearchResponseJSON(body)
}

func readElasticsearchQueryResponseBody(reader io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maxElasticsearchConsoleResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxElasticsearchConsoleResponseBytes {
		return nil, fmt.Errorf("Elasticsearch 响应超过 32 MiB 上限")
	}
	return body, nil
}

func truncateElasticsearchQueryErrorBody(body []byte) string {
	const maxErrorBytes = 64 << 10
	if len(body) <= maxErrorBytes {
		return string(body)
	}
	return string(body[:maxErrorBytes]) + "\n… [truncated]"
}

// parseSearchResponseJSON 从原始 JSON 字节解析 ES _search 响应。
// 兼容 ES 6.x 和 7.x+ 的 hits.total 格式差异。
func parseSearchResponseJSON(body []byte) ([]map[string]interface{}, []string, error) {
	var fullResp map[string]interface{}
	if err := json.Unmarshal(body, &fullResp); err != nil {
		return nil, nil, fmt.Errorf("解析查询结果失败：%w", err)
	}

	columnSet := make(map[string]bool)
	var data []map[string]interface{}

	// 解析 hits
	if hits, ok := fullResp["hits"].(map[string]interface{}); ok {
		if hitsList, ok := hits["hits"].([]interface{}); ok {
			data = make([]map[string]interface{}, 0, len(hitsList))
			for _, h := range hitsList {
				hit, ok := h.(map[string]interface{})
				if !ok {
					continue
				}
				row := make(map[string]interface{})
				row["_index"] = hit["_index"]
				row["_id"] = hit["_id"]
				if score, ok := hit["_score"]; ok && score != nil {
					row["_score"] = score
				}

				// 展开 _source
				if source, ok := hit["_source"].(map[string]interface{}); ok {
					flattenESSource("", source, row)
					sourceJSON, _ := json.Marshal(source)
					row["_source"] = string(sourceJSON)
				}

				// 合并 fields（ES 7.x+ 的 runtime fields / stored fields）
				if fields, ok := hit["fields"].(map[string]interface{}); ok {
					for key, value := range fields {
						setESSourceField(row, key, normalizeESFieldValue(value))
					}
				}

				for k := range row {
					columnSet[k] = true
				}
				data = append(data, row)
			}
		}
	}

	// 解析 aggregations
	if aggs, ok := fullResp["aggregations"].(map[string]interface{}); ok && len(aggs) > 0 {
		aggJSON, _ := json.MarshalIndent(aggs, "", "  ")
		if len(data) == 0 {
			// hits 为空但有 aggregation 结果
			data = append(data, map[string]interface{}{
				"_aggregations": string(aggJSON),
			})
		} else {
			// hits 有数据时，只在第一行附加 aggregation（避免每行重复）
			data[0]["_aggregations"] = string(aggJSON)
		}
		columnSet["_aggregations"] = true
	}

	if data == nil {
		data = make([]map[string]interface{}, 0)
	}

	// 收集并排序列名
	columns := make([]string, 0, len(columnSet))
	for k := range columnSet {
		columns = append(columns, k)
	}
	sort.Strings(columns)

	// 将元字段置首，与 ES 文档元数据惯例一致
	metaFields := []string{"_index", "_id", "_score", "_aggregations"}
	for _, meta := range metaFields {
		for i, col := range columns {
			if col == meta && i > 0 {
				columns = append(columns[:i], columns[i+1:]...)
				columns = append([]string{meta}, columns...)
				break
			}
		}
	}

	return data, columns, nil
}

// ---- 元数据获取辅助 ----

// esFetchIndexAliases 获取指定索引关联的所有别名。
func (e *ElasticsearchDB) esFetchIndexAliases(indexName string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetAlias(
		e.client.Indices.GetAlias.WithContext(ctx),
		e.client.Indices.GetAlias.WithIndex(indexName),
	)
	if err != nil {
		logger.Warnf("Elasticsearch 获取索引别名失败：%v", err)
		return nil
	}
	defer res.Body.Close()

	if res.IsError() {
		logger.Warnf("Elasticsearch 获取索引别名失败：%s", res.Status())
		return nil
	}

	// 响应格式：{ "index_name": { "aliases": { "alias_name": {} } } }
	var aliasMap map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&aliasMap); err != nil {
		logger.Warnf("Elasticsearch 解析索引别名失败：%v", err)
		return nil
	}

	var result []string
	for _, indexData := range aliasMap {
		data, ok := indexData.(map[string]interface{})
		if !ok {
			continue
		}
		aliases, ok := data["aliases"].(map[string]interface{})
		if !ok {
			continue
		}
		for aliasName := range aliases {
			if name := strings.TrimSpace(aliasName); name != "" {
				result = append(result, name)
			}
		}
	}
	return result
}

// esFetchIndexMapping 获取索引的 mapping 定义。
func (e *ElasticsearchDB) esFetchIndexMapping(indexName string) (map[string]interface{}, error) {
	if e.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetMapping(
		e.client.Indices.GetMapping.WithContext(ctx),
		e.client.Indices.GetMapping.WithIndex(indexName),
	)
	if err != nil {
		return nil, fmt.Errorf("获取索引 mapping 失败：%w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("获取索引 mapping 失败：%s", res.Status())
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("读取 mapping 响应失败：%w", err)
	}

	var mappingResult map[string]interface{}
	if err := json.Unmarshal(body, &mappingResult); err != nil {
		return nil, fmt.Errorf("解析 mapping 失败：%w", err)
	}

	return mappingResult, nil
}

// ---- Mapping 字段提取 ----

// extractColumnsFromMapping 从 mapping JSON 中提取字段定义。
// 递归处理嵌套对象（user.name）和多字段（title.keyword）。
// 兼容 ES 6.x（mappings.{type}.properties）和 ES 7.x+（mappings.properties）。
func extractColumnsFromMapping(indexName string, mapping map[string]interface{}) []connection.ColumnDefinition {
	indexData, ok := mapping[indexName].(map[string]interface{})
	if !ok {
		// 响应可能直接包含 index 数据（无外层索引名包裹），尝试自动查找
		for _, v := range mapping {
			if data, ok := v.(map[string]interface{}); ok {
				indexData = data
				break
			}
		}
	}
	if indexData == nil {
		return []connection.ColumnDefinition{}
	}

	mappings, ok := indexData["mappings"].(map[string]interface{})
	if !ok {
		return []connection.ColumnDefinition{}
	}

	properties, _ := mappings["properties"].(map[string]interface{})

	// ES 6.x：properties 在 type 层下面（如 mappings.doc.properties）
	if properties == nil {
		for _, v := range mappings {
			if typeMap, ok := v.(map[string]interface{}); ok {
				if props, ok := typeMap["properties"].(map[string]interface{}); ok {
					properties = props
					break
				}
			}
		}
	}

	if properties == nil {
		return []connection.ColumnDefinition{}
	}

	var columns []connection.ColumnDefinition
	expandESProperties(properties, "", &columns)

	// _id 是 ES 文档的唯一标识，等效于关系型数据库的主键。
	// 始终放在列首，使前端 editLocator 能识别主键并启用行编辑。
	idCol := connection.ColumnDefinition{
		Name:    "_id",
		Type:    "keyword",
		Key:     "PRI",
		Comment: "ES 文档唯一标识",
	}
	columns = append([]connection.ColumnDefinition{idCol}, columns...)

	return columns
}

// expandESProperties 递归展开 ES mapping properties。
// prefix 用于构建嵌套字段的点分路径（如 user.name）。
func expandESProperties(properties map[string]interface{}, prefix string, columns *[]connection.ColumnDefinition) {
	for name, prop := range properties {
		fullName := name
		if prefix != "" {
			fullName = prefix + "." + name
		}

		propMap, _ := prop.(map[string]interface{})
		colType := extractEsFieldType(prop)

		// 从 mapping 属性中提取注释
		comment := ""
		if propMap != nil {
			if desc, ok := propMap["description"].(string); ok {
				comment = desc
			}
		}

		col := connection.ColumnDefinition{
			Name:     fullName,
			Type:     colType,
			Nullable: "YES",
			Comment:  comment,
		}

		// 提取默认值（ES 7.x+ 的 null_value 作为参考）
		if propMap != nil {
			if nullVal, ok := propMap["null_value"]; ok {
				defaultStr := fmt.Sprintf("%v", nullVal)
				col.Default = &defaultStr
			}
		}

		*columns = append(*columns, col)

		// 递归处理嵌套对象的子字段
		if propMap != nil {
			if nested, ok := propMap["properties"].(map[string]interface{}); ok {
				expandESProperties(nested, fullName, columns)
			}
		}

		// 展开多字段（fields），如 title.keyword
		if propMap != nil {
			if fields, ok := propMap["fields"].(map[string]interface{}); ok {
				for fieldName, fieldDef := range fields {
					fieldType := extractEsFieldType(fieldDef)
					multiFieldName := fullName + "." + fieldName
					*columns = append(*columns, connection.ColumnDefinition{
						Name:     multiFieldName,
						Type:     fieldType,
						Nullable: "YES",
						Comment:  "multi-field",
					})
				}
			}
		}
	}
}

// extractEsFieldType 从字段属性中提取类型描述。
func extractEsFieldType(prop interface{}) string {
	propMap, ok := prop.(map[string]interface{})
	if !ok {
		return "unknown"
	}
	fieldType, _ := propMap["type"].(string)
	if fieldType == "" {
		if _, ok := propMap["properties"]; ok {
			return "object"
		}
		return "unknown"
	}
	return fieldType
}
