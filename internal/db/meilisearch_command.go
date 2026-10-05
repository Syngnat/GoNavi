package db

import (
	"net/http"
	"regexp"
	"strings"
)

// 控制台命令识别不依赖驱动代理：app 层按它区分 Meilisearch 的读写请求（只读保护、审计与 DBQuery 分流）。

// meilisearchReadPaths 是 POST 但只读的接口：搜索、多索引搜索、分面搜索、相似文档与按条件取文档。
var meilisearchReadPaths = regexp.MustCompile(`^/(multi-search|indexes/[^/]+/(search|facet-search|similar|documents/fetch))/?$`)

// meilisearchRequestIsRead 报告请求是否只读。
func meilisearchRequestIsRead(r documentRESTRequest) bool {
	switch r.method {
	case http.MethodGet, http.MethodHead:
		return true
	case http.MethodPost:
		return meilisearchReadPaths.MatchString(r.pathWithoutQuery())
	}
	return false
}

// IsMeilisearchReadCommand 报告控制台文本是否只读：SELECT、GET / HEAD 与搜索类 POST。
func IsMeilisearchReadCommand(text string) bool {
	trimmed := strings.TrimSpace(text)
	if requests, ok := parseDocumentRESTRequests(trimmed); ok {
		for _, request := range requests {
			if !meilisearchRequestIsRead(request) {
				return false
			}
		}
		return true
	}
	return strings.HasPrefix(strings.ToLower(trimmed), "select")
}
