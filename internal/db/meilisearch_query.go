//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

func (m *MeilisearchDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultMeilisearchQueryTimeout)
	defer cancel()
	return m.QueryContext(ctx, query)
}

// QueryContext 执行只读请求：REST（GET、搜索类 POST，多个请求时返回最后一个的结果）或 SELECT。
func (m *MeilisearchDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.client == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	if requests, ok := parseDocumentRESTRequests(text); ok {
		var body []byte
		var last documentRESTRequest
		for _, request := range requests {
			if !meilisearchRequestIsRead(request) {
				return nil, nil, localizedDatabaseRuntimeError("db.backend.error.meilisearch_query_unsupported", nil)
			}
			if request.body != nil && !json.Valid(request.body) {
				return nil, nil, localizedDatabaseRuntimeError("db.backend.error.meilisearch_body_invalid", nil)
			}
			var err error
			if body, err = m.doRaw(ctx, request.method, request.path, request.body); err != nil {
				return nil, nil, err
			}
			last = request
		}
		rows, columns := documentRESTRows(body, m.restColumnOrder(ctx, last.path), nil, "results", "hits")
		return rows, columns, nil
	}
	if strings.HasPrefix(strings.ToLower(text), "select") {
		return m.querySelect(ctx, text)
	}
	return nil, nil, localizedDatabaseRuntimeError("db.backend.error.meilisearch_query_unsupported", nil)
}

var meilisearchDocumentPath = regexp.MustCompile(`^/indexes/([^/?]+)/(search|similar|documents)(/fetch)?/?(\?.*)?$`)

// restColumnOrder 让搜索与文档接口的结果按索引字段顺序排列列；其他接口返回 nil（按名称排序）。
func (m *MeilisearchDB) restColumnOrder(ctx context.Context, path string) []string {
	match := meilisearchDocumentPath.FindStringSubmatch(path)
	if match == nil {
		return nil
	}
	uid, err := url.PathUnescape(match[1])
	if err != nil {
		return nil
	}
	meta, err := m.indexMeta(ctx, uid)
	if err != nil {
		return nil
	}
	return meta.fields
}

// meilisearchSelect 是解析后的 SELECT。
type meilisearchSelect struct {
	meta   *meilisearchIndexMeta
	where  interface{}
	sort   []documentSortKey
	offset int
	limit  int
	fields []string
}

// querySelect 执行 SELECT：条件与排序能交给服务端时用文档接口或搜索接口，否则在客户端扫描整个索引后筛选、排序。
func (m *MeilisearchDB) querySelect(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	selection, countOnly, err := m.parseSelect(ctx, text)
	if err != nil {
		return nil, nil, err
	}
	if countOnly {
		total, err := m.count(ctx, selection.meta, selection.where)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	documents, err := m.fetchWindow(ctx, selection)
	if err != nil {
		return nil, nil, err
	}
	columns := selection.fields
	if len(columns) == 0 {
		columns = documentRowColumns(documents, selection.meta.fields)
	}
	rows := make([]map[string]interface{}, 0, len(documents))
	for _, document := range documents {
		if len(selection.fields) > 0 {
			document = projectDocument(document, selection.fields)
		}
		rows = append(rows, document)
	}
	fillDocumentRows(rows, columns)
	return rows, columns, nil
}

func (m *MeilisearchDB) parseSelect(ctx context.Context, text string) (meilisearchSelect, bool, error) {
	uid := parseSQLFromName(text)
	if uid == "" {
		return meilisearchSelect{}, false, localizedDatabaseRuntimeError("db.backend.error.meilisearch_query_unsupported", nil)
	}
	meta, err := m.indexMeta(ctx, uid)
	if err != nil {
		return meilisearchSelect{}, false, err
	}
	// 没写 LIMIT 时读取全部文档（导出、备份与迁移按全表读取；控制台的 SELECT 由编辑器自动补上 LIMIT）。
	clauses := splitRegistrySelectClauses(text, math.MaxInt32)
	selection := meilisearchSelect{meta: meta, offset: clauses.offset, limit: clauses.limit}
	if clauses.where != "" {
		if selection.where, err = parseRegistryWhere(clauses.where); err != nil {
			return meilisearchSelect{}, false, err
		}
	}
	if selection.sort, err = parseDocumentOrderBy(clauses.orderBy); err != nil {
		return meilisearchSelect{}, false, err
	}
	projection := sqlSelectProjection(text)
	if sqlContainsFunctionCall(projection, "COUNT") {
		return selection, true, nil
	}
	selection.fields, _ = parseDocumentProjection(projection)
	return selection, false, nil
}

// fetchWindow 读取 [offset, offset+limit) 的文档。路径按版本与索引设置选择：
// 无条件无排序用文档列表；1.16 起文档接口可同时过滤与排序，1.2 起可过滤；更早的版本用搜索接口，
// 但搜索最多返回 maxTotalHits 条，窗口超出时改在客户端处理。
func (m *MeilisearchDB) fetchWindow(ctx context.Context, selection meilisearchSelect) ([]map[string]interface{}, error) {
	meta := selection.meta
	if selection.limit <= 0 {
		return []map[string]interface{}{}, nil
	}
	if selection.where == nil && len(selection.sort) == 0 {
		return meilisearchPaged(selection.offset, selection.limit, func(offset, limit int) ([]map[string]interface{}, error) {
			return m.listDocuments(ctx, meta.uid, offset, limit)
		})
	}
	filter, filterOK := m.nativeFilter(meta, selection.where)
	sorts, sortOK := m.nativeSort(meta, selection.sort)
	if filterOK && sortOK {
		switch {
		case m.supportsDocumentSort() || (len(sorts) == 0 && m.supportsDocumentFilter()):
			return meilisearchPaged(selection.offset, selection.limit, func(offset, limit int) ([]map[string]interface{}, error) {
				return m.fetchDocuments(ctx, meta.uid, filter, sorts, offset, limit)
			})
		case selection.offset+selection.limit <= meta.maxTotalHits:
			return m.searchDocuments(ctx, meta.uid, filter, sorts, selection.offset, selection.limit)
		}
	}
	matched, err := m.scan(ctx, meta, selection.where, selection.sort)
	if err != nil {
		return nil, err
	}
	if selection.offset >= len(matched) {
		return []map[string]interface{}{}, nil
	}
	end := min(selection.offset+selection.limit, len(matched))
	window := make([]map[string]interface{}, 0, end-selection.offset)
	for _, document := range matched[selection.offset:end] {
		window = append(window, copyDocument(document))
	}
	return window, nil
}

// meilisearchPaged 按 meilisearchPageSize 分页读取 [offset, offset+limit) 的文档，直到读满或没有更多文档。
func meilisearchPaged(offset, limit int, fetch func(offset, limit int) ([]map[string]interface{}, error)) ([]map[string]interface{}, error) {
	documents := make([]map[string]interface{}, 0, min(limit, meilisearchPageSize))
	for len(documents) < limit {
		size := min(limit-len(documents), meilisearchPageSize)
		page, err := fetch(offset+len(documents), size)
		if err != nil {
			return nil, err
		}
		documents = append(documents, page...)
		if len(page) < size {
			break
		}
	}
	return documents, nil
}

// count 返回满足条件的文档数：无条件时取统计，1.2 起用带过滤的文档接口，0.30 起用搜索的精确总数
// （达到 maxTotalHits 时总数被截断，改为客户端计数），其余情况在客户端计数。
func (m *MeilisearchDB) count(ctx context.Context, meta *meilisearchIndexMeta, where interface{}) (int64, error) {
	if where == nil {
		return meta.documents, nil
	}
	if filter, ok := m.nativeFilter(meta, where); ok {
		switch {
		case m.supportsDocumentFilter():
			var page struct {
				Total int64 `json:"total"`
			}
			err := m.doJSON(ctx, http.MethodPost, meilisearchIndexPath(meta.uid, "/documents/fetch"), map[string]interface{}{"filter": filter, "limit": 0}, &page)
			return page.Total, err
		case m.supportsExactSearchTotal():
			var result struct {
				TotalHits int64 `json:"totalHits"`
			}
			body := map[string]interface{}{"q": "", "filter": filter, "hitsPerPage": 0}
			if err := m.doJSON(ctx, http.MethodPost, meilisearchIndexPath(meta.uid, "/search"), body, &result); err != nil {
				return 0, err
			}
			if result.TotalHits < int64(meta.maxTotalHits) {
				return result.TotalHits, nil
			}
		}
	}
	matched, err := m.scan(ctx, meta, where, nil)
	return int64(len(matched)), err
}

// listDocuments 按位置读取文档（0.28 起返回 {results}，之前返回数组）。
func (m *MeilisearchDB) listDocuments(ctx context.Context, uid string, offset, limit int) ([]map[string]interface{}, error) {
	body, err := m.doRaw(ctx, http.MethodGet, meilisearchIndexPath(uid, fmt.Sprintf("/documents?offset=%d&limit=%d", offset, limit)), nil)
	if err != nil {
		return nil, err
	}
	return decodeMeilisearchDocuments(body)
}

func (m *MeilisearchDB) fetchDocuments(ctx context.Context, uid, filter string, sorts []string, offset, limit int) ([]map[string]interface{}, error) {
	request := map[string]interface{}{"offset": offset, "limit": limit}
	if filter != "" {
		request["filter"] = filter
	}
	if len(sorts) > 0 {
		request["sort"] = sorts
	}
	payload, _ := json.Marshal(request)
	body, err := m.doRaw(ctx, http.MethodPost, meilisearchIndexPath(uid, "/documents/fetch"), payload)
	if err != nil {
		return nil, err
	}
	return decodeMeilisearchDocuments(body)
}

func (m *MeilisearchDB) searchDocuments(ctx context.Context, uid, filter string, sorts []string, offset, limit int) ([]map[string]interface{}, error) {
	request := map[string]interface{}{"q": "", "offset": offset, "limit": limit}
	if filter != "" {
		request["filter"] = filter
	}
	if len(sorts) > 0 {
		request["sort"] = sorts
	}
	payload, _ := json.Marshal(request)
	body, err := m.doRaw(ctx, http.MethodPost, meilisearchIndexPath(uid, "/search"), payload)
	if err != nil {
		return nil, err
	}
	return decodeMeilisearchDocuments(body)
}

func decodeMeilisearchDocuments(body []byte) ([]map[string]interface{}, error) {
	raws, err := meilisearchDocumentList(body)
	if err != nil {
		return nil, err
	}
	documents := make([]map[string]interface{}, 0, len(raws))
	for _, raw := range raws {
		var document map[string]interface{}
		if err := decodeJSONWithUseNumber(raw, &document); err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	return documents, nil
}
