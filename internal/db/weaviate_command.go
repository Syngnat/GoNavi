package db

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
)

// 控制台命令识别不依赖驱动代理：app 层按它区分 Weaviate 的读写请求（只读保护、审计与 DBQuery 分流）。

// weaviateRESTRequest 是控制台里「METHOD /path，换行后跟 JSON 请求体」形式的 REST 请求。
type weaviateRESTRequest struct {
	method string
	path   string
	body   []byte
}

var weaviateRESTMethods = map[string]bool{"GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}

// parseWeaviateRESTRequest 解析 REST 请求；路径可以省略 /v1 前缀。
func parseWeaviateRESTRequest(text string) (weaviateRESTRequest, bool) {
	firstLine, rest, _ := strings.Cut(strings.TrimSpace(text), "\n")
	fields := strings.Fields(firstLine)
	if len(fields) != 2 {
		return weaviateRESTRequest{}, false
	}
	method := strings.ToUpper(fields[0])
	if !weaviateRESTMethods[method] || !strings.HasPrefix(fields[1], "/") {
		return weaviateRESTRequest{}, false
	}
	path := fields[1]
	if path != "/v1" && !strings.HasPrefix(path, "/v1/") {
		path = "/v1" + path
	}
	request := weaviateRESTRequest{method: method, path: path}
	if body := bytes.TrimSpace([]byte(rest)); len(body) > 0 {
		request.body = body
	}
	return request, true
}

// weaviateGraphQLText 识别 GraphQL 查询：{ Get ... }、query { ... }，或 /v1/graphql 的请求体 {"query": "..."}。
func weaviateGraphQLText(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "{") {
		var body struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal([]byte(trimmed), &body); err == nil && strings.TrimSpace(body.Query) != "" {
			return body.Query, true
		}
		return trimmed, true
	}
	if lower := strings.ToLower(trimmed); strings.HasPrefix(lower, "query") && len(lower) > len("query") {
		next := lower[len("query")]
		if next == '{' || next == ' ' || next == '\n' || next == '\r' || next == '\t' {
			return trimmed, true
		}
	}
	return "", false
}

// IsWeaviateReadCommand 报告控制台文本是否只读：SELECT、GraphQL（Weaviate 的 GraphQL 没有 mutation）、GET / HEAD 与 /v1/graphql。
func IsWeaviateReadCommand(text string) bool {
	trimmed := strings.TrimSpace(text)
	if _, ok := weaviateGraphQLText(trimmed); ok {
		return true
	}
	if request, ok := parseWeaviateRESTRequest(trimmed); ok {
		return request.method == http.MethodGet || request.method == http.MethodHead ||
			(request.method == http.MethodPost && request.path == "/v1/graphql")
	}
	return strings.HasPrefix(strings.ToLower(trimmed), "select")
}
