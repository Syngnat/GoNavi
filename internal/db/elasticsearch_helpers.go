//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
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

// ---- SQL → ES _search 转换层 ----

// ---- ES 客户端配置 ----

// ---- 查询响应解析 ----

// ---- 元数据获取辅助 ----

// ---- Mapping 字段提取 ----
