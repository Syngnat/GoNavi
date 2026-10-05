package db

import (
	"net/http"
	"strings"
)

// 控制台命令识别不依赖驱动代理：app 层按它区分 Typesense 的读写请求（只读保护、审计与 DBQuery 分流）。

// typesenseRequestIsRead 报告请求是否只读：GET / HEAD（含搜索与导出）以及多集合搜索 POST /multi_search。
func typesenseRequestIsRead(r documentRESTRequest) bool {
	switch r.method {
	case http.MethodGet, http.MethodHead:
		return true
	case http.MethodPost:
		return strings.TrimSuffix(r.pathWithoutQuery(), "/") == "/multi_search"
	}
	return false
}

// IsTypesenseReadCommand 报告控制台文本是否只读：SELECT、GET / HEAD 与多集合搜索。
func IsTypesenseReadCommand(text string) bool {
	trimmed := strings.TrimSpace(text)
	if requests, ok := parseDocumentRESTRequests(trimmed); ok {
		for _, request := range requests {
			if !typesenseRequestIsRead(request) {
				return false
			}
		}
		return true
	}
	return strings.HasPrefix(strings.ToLower(trimmed), "select")
}
