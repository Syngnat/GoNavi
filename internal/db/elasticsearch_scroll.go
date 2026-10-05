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

const (
	esScrollPageSize  = 1000
	esScrollKeepAlive = "1m"
)

// scrollSimplifiedSelect 读取没写 LIMIT 的简化 SELECT 的全部命中（导出、备份与迁移按全表读取）：from + size 受
// index.max_result_window（默认 10000）限制，改用 scroll 逐页读取；offset 在客户端跳过。结束后清理 scroll 上下文。
// 显式列出的列总会出现在结果里（没有文档带该字段时为 NULL），导出按列清单取值时不会因为字段从未出现而失败。
func (e *ElasticsearchDB) scrollSimplifiedSelect(ctx context.Context, request esconsole.Request, offset int, projection string) ([]map[string]interface{}, []string, error) {
	var body map[string]interface{}
	if strings.TrimSpace(request.Body) != "" {
		if err := json.Unmarshal([]byte(request.Body), &body); err != nil {
			return nil, nil, fmt.Errorf("Elasticsearch 查询解析失败：%w", err)
		}
	}
	if body == nil {
		body = map[string]interface{}{}
	}
	body["size"] = esScrollPageSize
	delete(body, "from")
	encoded, _ := json.Marshal(body)
	separator := "?"
	if strings.Contains(request.Path, "?") {
		separator = "&"
	}
	response, err := e.performScrollRequest(ctx, http.MethodPost, request.Path+separator+"scroll="+esScrollKeepAlive, encoded)
	if err != nil {
		return nil, nil, err
	}
	var rows []map[string]interface{}
	var columns []string
	seen := map[string]bool{}
	if requested, all := parseDocumentProjection(projection); !all {
		for _, column := range requested {
			if !seen[column] {
				seen[column] = true
				columns = append(columns, column)
			}
		}
	}
	scrollID := ""
	defer func() {
		if scrollID != "" {
			clear, _ := json.Marshal(map[string]interface{}{"scroll_id": []string{scrollID}})
			_, _ = e.performScrollRequest(context.Background(), http.MethodDelete, "/_search/scroll", clear)
		}
	}()
	for {
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, nil, fmt.Errorf("Elasticsearch 查询错误 (HTTP %d)：%s", response.StatusCode, truncateElasticsearchQueryErrorBody([]byte(response.RawBody)))
		}
		var envelope struct {
			ScrollID string `json:"_scroll_id"`
		}
		_ = json.Unmarshal([]byte(response.RawBody), &envelope)
		if envelope.ScrollID != "" {
			scrollID = envelope.ScrollID
		}
		pageRows, pageColumns, err := parseSearchResponseJSON([]byte(response.RawBody))
		if err != nil {
			return nil, nil, err
		}
		for _, column := range pageColumns {
			if !seen[column] {
				seen[column] = true
				columns = append(columns, column)
			}
		}
		for _, row := range pageRows {
			if offset > 0 {
				offset--
				continue
			}
			rows = append(rows, row)
		}
		if len(pageRows) < esScrollPageSize || scrollID == "" {
			break
		}
		next, _ := json.Marshal(map[string]interface{}{"scroll": esScrollKeepAlive, "scroll_id": scrollID})
		if response, err = e.performScrollRequest(ctx, http.MethodPost, "/_search/scroll", next); err != nil {
			return nil, nil, err
		}
	}
	for _, row := range rows {
		for _, column := range columns {
			if _, ok := row[column]; !ok {
				row[column] = nil
			}
		}
	}
	return rows, columns, nil
}

// performScrollRequest 发出 scroll 读取的内部请求（_search?scroll、/_search/scroll）。这些请求只读且由驱动自己构造，
// 不经过控制台的端点白名单（白名单约束的是用户在控制台里手写的请求）。
func (e *ElasticsearchDB) performScrollRequest(ctx context.Context, method, path string, body []byte) (ElasticsearchConsoleResponse, error) {
	client := e.consoleClient
	if client == nil {
		return ElasticsearchConsoleResponse{}, fmt.Errorf("Elasticsearch transport is unavailable")
	}
	httpRequest, err := http.NewRequestWithContext(ctx, method, path, bytes.NewReader(body))
	if err != nil {
		return ElasticsearchConsoleResponse{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpResponse, err := client.Perform(httpRequest)
	if err != nil {
		return ElasticsearchConsoleResponse{}, fmt.Errorf("Elasticsearch 查询失败：%w", err)
	}
	defer httpResponse.Body.Close()
	raw, err := readResponseBodyWithLimit(httpResponse.Body, maxElasticsearchConsoleResponseBytes, "Elasticsearch 响应")
	if err != nil {
		return ElasticsearchConsoleResponse{}, err
	}
	return ElasticsearchConsoleResponse{StatusCode: httpResponse.StatusCode, RawBody: string(raw), ServerMajor: e.serverMajor}, nil
}
