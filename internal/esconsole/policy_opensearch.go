package esconsole

import (
	"encoding/json"
	"strings"
)

// classifyOpenSearchPluginEndpoint 在 OpenSearch 插件端点（_plugins）里只放行 SQL / PPL 查询与 explain；
// 安全、ISM、告警等管理端点保持拦截。对 Elasticsearch 连接这些路径不存在，服务端会直接返回错误。
func classifyOpenSearchPluginEndpoint(req *Request, segments []string) bool {
	if len(segments) < 2 || len(segments) > 3 || req.Method != "POST" {
		return true
	}
	plugin := segments[1]
	if plugin != "_sql" && plugin != "_ppl" {
		return true
	}
	route := "/_plugins/" + plugin
	if len(segments) == 3 {
		if segments[2] != "_explain" {
			return true
		}
		route += "/_explain"
	}
	if plugin == "_sql" && !openSearchSQLIsReadOnly(req.Body) {
		blockRequest(req, "sql_not_read_only")
		return true
	}
	allowRequest(req, RiskRead, route, "")
	return true
}

// openSearchSQLIsReadOnly 只认 SELECT / SHOW / DESCRIBE / EXPLAIN 开头的语句：
// 服务端开启 plugins.sql.delete.enabled 后 SQL 插件也执行 DELETE，不能当作只读请求放行。
func openSearchSQLIsReadOnly(body string) bool {
	var payload struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return false
	}
	statement := strings.TrimLeft(strings.TrimSpace(payload.Query), "(")
	fields := strings.Fields(statement)
	if len(fields) == 0 {
		return false
	}
	switch strings.ToUpper(fields[0]) {
	case "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH":
		return true
	default:
		return false
	}
}
