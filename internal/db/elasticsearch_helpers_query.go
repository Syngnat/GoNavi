//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"GoNavi-Wails/internal/logger"

	"github.com/elastic/go-elasticsearch/v8/esapi"
)

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
	return readResponseBodyWithLimit(reader, maxRemoteJSONResponseBytes, "Elasticsearch 响应")
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
