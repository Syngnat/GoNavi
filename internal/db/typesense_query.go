//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

func (t *TypesenseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTypesenseQueryTimeout)
	defer cancel()
	return t.QueryContext(ctx, query)
}

// QueryContext 执行只读请求：REST（GET、多集合搜索，多个请求时返回最后一个的结果）或 SELECT。
func (t *TypesenseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if t.client == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	if requests, ok := parseDocumentRESTRequests(text); ok {
		var body []byte
		var last documentRESTRequest
		for _, request := range requests {
			if !typesenseRequestIsRead(request) {
				return nil, nil, localizedDatabaseRuntimeError("db.backend.error.typesense_query_unsupported", nil)
			}
			if request.body != nil && !json.Valid(request.body) {
				return nil, nil, localizedDatabaseRuntimeError("db.backend.error.typesense_body_invalid", nil)
			}
			var err error
			if body, err = t.doRaw(ctx, request.method, request.path, request.body); err != nil {
				return nil, nil, err
			}
			last = request
		}
		rows, columns := documentRESTRows(body, t.restColumnOrder(ctx, last.path), typesenseHitRow,
			"hits", "results", "keys", "synonyms", "overrides", "aliases")
		return rows, columns, nil
	}
	if strings.HasPrefix(strings.ToLower(text), "select") {
		return t.querySelect(ctx, text)
	}
	return nil, nil, localizedDatabaseRuntimeError("db.backend.error.typesense_query_unsupported", nil)
}

var typesenseDocumentsRoute = regexp.MustCompile(`^/collections/([^/?]+)/documents(/search|/export)?/?(\?.*)?$`)

// restColumnOrder 让搜索与导出的结果按集合字段顺序排列列；其他接口返回 nil（按名称排序）。
func (t *TypesenseDB) restColumnOrder(ctx context.Context, path string) []string {
	match := typesenseDocumentsRoute.FindStringSubmatch(path)
	if match == nil {
		return nil
	}
	name, err := url.PathUnescape(match[1])
	if err != nil {
		return nil
	}
	meta, err := t.collectionMeta(ctx, name)
	if err != nil {
		return nil
	}
	return meta.fields
}

// typesenseHitRow 展开搜索命中：document 并入行，文本相关度放进 _text_match 列。
func typesenseHitRow(value interface{}) map[string]interface{} {
	hit, ok := value.(map[string]interface{})
	if !ok {
		return map[string]interface{}{"value": value}
	}
	document, ok := hit["document"].(map[string]interface{})
	if !ok {
		return hit
	}
	row := copyDocument(document)
	if score, ok := hit["text_match"]; ok {
		row["_text_match"] = score
	}
	return row
}

// typesenseSelect 是解析后的 SELECT。
type typesenseSelect struct {
	meta   *typesenseCollectionMeta
	where  interface{}
	sort   []documentSortKey
	offset int
	limit  int
	fields []string
}

// querySelect 执行 SELECT：条件与排序能交给服务端时用搜索接口，否则导出整个集合在客户端筛选、排序。
func (t *TypesenseDB) querySelect(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	selection, countOnly, err := t.parseSelect(ctx, text)
	if err != nil {
		return nil, nil, err
	}
	if countOnly {
		total, err := t.count(ctx, selection.meta, selection.where)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	documents, err := t.fetchWindow(ctx, selection)
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

func (t *TypesenseDB) parseSelect(ctx context.Context, text string) (typesenseSelect, bool, error) {
	name := parseSQLFromName(text)
	if name == "" {
		return typesenseSelect{}, false, localizedDatabaseRuntimeError("db.backend.error.typesense_query_unsupported", nil)
	}
	meta, err := t.collectionMeta(ctx, name)
	if err != nil {
		return typesenseSelect{}, false, err
	}
	clauses := splitRegistrySelectClauses(text, typesenseDefaultSelectLimit)
	selection := typesenseSelect{meta: meta, offset: clauses.offset, limit: clauses.limit}
	if clauses.where != "" {
		if selection.where, err = parseRegistryWhere(clauses.where); err != nil {
			return typesenseSelect{}, false, err
		}
	}
	if selection.sort, err = parseDocumentOrderBy(clauses.orderBy); err != nil {
		return typesenseSelect{}, false, err
	}
	projection := sqlSelectProjection(text)
	if sqlContainsFunctionCall(projection, "COUNT") {
		return selection, true, nil
	}
	selection.fields, _ = parseDocumentProjection(projection)
	return selection, false, nil
}

// fetchWindow 读取 [offset, offset+limit) 的文档：条件与排序都能翻译时用搜索接口，否则客户端处理。
func (t *TypesenseDB) fetchWindow(ctx context.Context, selection typesenseSelect) ([]map[string]interface{}, error) {
	if selection.limit <= 0 {
		return []map[string]interface{}{}, nil
	}
	filter, filterOK := t.nativeFilter(selection.meta, selection.where)
	sortBy, sortOK := t.nativeSort(selection.meta, selection.sort)
	// 0.23 之前搜索结果跨页不稳定（同序的文档会重复或遗漏），集合不大时改在客户端按导出顺序分页。
	stable := t.stableSearchPaging() || selection.meta.documents > typesenseScanLimit
	if filterOK && sortOK && stable {
		return t.searchWindow(ctx, selection.meta.name, filter, sortBy, selection.offset, selection.limit)
	}
	matched, err := t.scan(ctx, selection.meta, selection.where, selection.sort)
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

// searchWindow 用搜索接口读取窗口：每页最多 250 条，0.25 起按 offset / limit 分段，之前按页码取覆盖窗口的页再截取。
func (t *TypesenseDB) searchWindow(ctx context.Context, collection, filter, sortBy string, offset, limit int) ([]map[string]interface{}, error) {
	documents := make([]map[string]interface{}, 0, min(limit, typesenseMaxPerPage))
	request := typesenseSearch{filter: filter, sort: sortBy}
	if t.supportsOffsetLimit() {
		for len(documents) < limit {
			request.offset, request.limit, request.useOffset = offset+len(documents), min(limit-len(documents), typesenseMaxPerPage), true
			result, err := t.searchDocuments(ctx, collection, request)
			if err != nil {
				return nil, err
			}
			documents = append(documents, result.documents...)
			if len(result.documents) < request.limit {
				break
			}
		}
		return documents, nil
	}
	if limit <= typesenseMaxPerPage && offset%limit == 0 {
		request.page, request.perPage = offset/limit+1, limit
		result, err := t.searchDocuments(ctx, collection, request)
		return result.documents, err
	}
	request.perPage = typesenseMaxPerPage
	skip := offset % typesenseMaxPerPage
	for page := offset/typesenseMaxPerPage + 1; len(documents) < limit; page++ {
		request.page = page
		result, err := t.searchDocuments(ctx, collection, request)
		if err != nil {
			return nil, err
		}
		for _, document := range result.documents[min(skip, len(result.documents)):] {
			if len(documents) < limit {
				documents = append(documents, document)
			}
		}
		skip = 0
		if len(result.documents) < typesenseMaxPerPage {
			break
		}
	}
	return documents, nil
}

// count 返回满足条件的文档数：能翻译的条件用搜索接口的 found（每页 0 条），否则客户端计数。
func (t *TypesenseDB) count(ctx context.Context, meta *typesenseCollectionMeta, where interface{}) (int64, error) {
	if filter, ok := t.nativeFilter(meta, where); ok {
		result, err := t.searchDocuments(ctx, meta.name, typesenseSearch{filter: filter, page: 1})
		return result.found, err
	}
	matched, err := t.scan(ctx, meta, where, nil)
	return int64(len(matched)), err
}

// typesenseSearch 是一次 q=* 搜索的参数：useOffset 时按 offset / limit，否则按 page / perPage（perPage 为 0 只取总数）。
type typesenseSearch struct {
	filter    string
	sort      string
	page      int
	perPage   int
	offset    int
	limit     int
	useOffset bool
}

type typesenseSearchResult struct {
	found     int64
	documents []map[string]interface{}
}

func (t *TypesenseDB) searchDocuments(ctx context.Context, collection string, request typesenseSearch) (typesenseSearchResult, error) {
	params := url.Values{"q": {"*"}}
	if request.useOffset {
		params.Set("offset", strconv.Itoa(request.offset))
		params.Set("limit", strconv.Itoa(request.limit))
	} else {
		params.Set("page", strconv.Itoa(max(request.page, 1)))
		params.Set("per_page", strconv.Itoa(request.perPage))
	}
	if request.filter != "" {
		params.Set("filter_by", request.filter)
	}
	if request.sort != "" {
		params.Set("sort_by", request.sort)
	}
	var response struct {
		Found int64 `json:"found"`
		Hits  []struct {
			Document map[string]interface{} `json:"document"`
		} `json:"hits"`
	}
	if err := t.doJSON(ctx, http.MethodGet, typesenseCollectionPath(collection, "/documents/search?"+params.Encode()), nil, &response); err != nil {
		return typesenseSearchResult{}, err
	}
	result := typesenseSearchResult{found: response.Found, documents: make([]map[string]interface{}, 0, len(response.Hits))}
	for _, hit := range response.Hits {
		if hit.Document != nil {
			normalizeDecodedJSONNumbers(&hit.Document)
			result.documents = append(result.documents, hit.Document)
		}
	}
	return result, nil
}
