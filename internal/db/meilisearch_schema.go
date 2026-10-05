//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

// meilisearchIndexInfo 是 /indexes 列表的一项。
type meilisearchIndexInfo struct {
	UID        string  `json:"uid"`
	PrimaryKey *string `json:"primaryKey"`
	CreatedAt  string  `json:"createdAt"`
	UpdatedAt  string  `json:"updatedAt"`
}

// meilisearchAttributeRule 是 filterableAttributes 的一项：1.14 起可写成带 attributePatterns 与 features 的对象，
// 对象写法默认只开等值过滤、不开比较。
type meilisearchAttributeRule struct {
	pattern    string
	comparison bool
}

// meilisearchIndexMeta 是索引的主键、字段、设置与统计，按 meilisearchMetaTTL 缓存。
type meilisearchIndexMeta struct {
	uid          string
	primaryKey   string
	documents    int64
	updatedAt    string
	fields       []string
	types        map[string]string
	filterable   []meilisearchAttributeRule
	sortable     []string
	searchable   []string
	distinct     string
	maxTotalHits int
	settings     json.RawMessage
	loadedAt     time.Time
}

func newMeilisearchMetadataContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), defaultMeilisearchQueryTimeout)
}

// listIndexes 读取全部索引：0.28 起分页返回 {results, total}，之前直接返回数组（也不认分页参数）。
func (m *MeilisearchDB) listIndexes(ctx context.Context) ([]meilisearchIndexInfo, error) {
	if !m.paginatedLists() {
		var indexes []meilisearchIndexInfo
		err := m.doJSON(ctx, http.MethodGet, "/indexes", nil, &indexes)
		return indexes, err
	}
	all := make([]meilisearchIndexInfo, 0)
	for offset := 0; ; offset += meilisearchPageSize {
		var page struct {
			Results []meilisearchIndexInfo `json:"results"`
			Total   int                    `json:"total"`
		}
		if err := m.doJSON(ctx, http.MethodGet, fmt.Sprintf("/indexes?offset=%d&limit=%d", offset, meilisearchPageSize), nil, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Results...)
		if len(page.Results) < meilisearchPageSize || len(all) >= page.Total {
			return all, nil
		}
	}
}

// indexMeta 返回索引元数据；索引不存在时报 meilisearch_index_not_found。
func (m *MeilisearchDB) indexMeta(ctx context.Context, uid string) (*meilisearchIndexMeta, error) {
	uid = strings.TrimSpace(uid)
	m.mu.Lock()
	if cached := m.metaCache[uid]; cached != nil && time.Since(cached.loadedAt) < meilisearchMetaTTL {
		m.mu.Unlock()
		return cached, nil
	}
	m.mu.Unlock()

	var info meilisearchIndexInfo
	if err := m.doJSON(ctx, http.MethodGet, meilisearchIndexPath(uid, ""), nil, &info); err != nil {
		if isMeilisearchErrorCode(err, "index_not_found") {
			return nil, localizedDatabaseRuntimeError("db.backend.error.meilisearch_index_not_found", map[string]any{"index": uid})
		}
		return nil, err
	}
	meta := &meilisearchIndexMeta{uid: info.UID, updatedAt: info.UpdatedAt, types: map[string]string{}, maxTotalHits: 1000}
	if info.PrimaryKey != nil {
		meta.primaryKey = *info.PrimaryKey
	}
	if err := m.loadIndexSettings(ctx, meta); err != nil {
		return nil, err
	}
	var stats struct {
		NumberOfDocuments  int64            `json:"numberOfDocuments"`
		FieldDistribution  map[string]int64 `json:"fieldDistribution"`
		FieldsDistribution map[string]int64 `json:"fieldsDistribution"`
	}
	if err := m.doJSON(ctx, http.MethodGet, meilisearchIndexPath(uid, "/stats"), nil, &stats); err != nil {
		return nil, err
	}
	meta.documents = stats.NumberOfDocuments
	distribution := stats.FieldDistribution
	if distribution == nil {
		distribution = stats.FieldsDistribution
	}
	sample, err := m.sampleDocuments(ctx, uid)
	if err != nil {
		return nil, err
	}
	meta.fields, meta.types = meilisearchFieldsFromSample(meta.primaryKey, sample, distribution)

	m.mu.Lock()
	if m.metaCache == nil {
		m.metaCache = map[string]*meilisearchIndexMeta{}
	}
	meta.loadedAt = time.Now()
	m.metaCache[uid] = meta
	m.mu.Unlock()
	return meta, nil
}

func (m *MeilisearchDB) loadIndexSettings(ctx context.Context, meta *meilisearchIndexMeta) error {
	raw, err := m.doRaw(ctx, http.MethodGet, meilisearchIndexPath(meta.uid, "/settings"), nil)
	if err != nil {
		return err
	}
	meta.settings = json.RawMessage(bytes.TrimSpace(raw))
	var settings struct {
		FilterableAttributes []json.RawMessage `json:"filterableAttributes"`
		SortableAttributes   []string          `json:"sortableAttributes"`
		SearchableAttributes []string          `json:"searchableAttributes"`
		DistinctAttribute    *string           `json:"distinctAttribute"`
		Pagination           *struct {
			MaxTotalHits int `json:"maxTotalHits"`
		} `json:"pagination"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return err
	}
	meta.filterable = parseMeilisearchFilterable(settings.FilterableAttributes)
	meta.sortable = settings.SortableAttributes
	meta.searchable = settings.SearchableAttributes
	if settings.DistinctAttribute != nil {
		meta.distinct = *settings.DistinctAttribute
	}
	if settings.Pagination != nil && settings.Pagination.MaxTotalHits > 0 {
		meta.maxTotalHits = settings.Pagination.MaxTotalHits
	}
	return nil
}

func parseMeilisearchFilterable(items []json.RawMessage) []meilisearchAttributeRule {
	rules := make([]meilisearchAttributeRule, 0, len(items))
	for _, item := range items {
		var name string
		if json.Unmarshal(item, &name) == nil {
			rules = append(rules, meilisearchAttributeRule{pattern: name, comparison: true})
			continue
		}
		var object struct {
			AttributePatterns []string `json:"attributePatterns"`
			Features          struct {
				Filter *struct {
					Equality   *bool `json:"equality"`
					Comparison *bool `json:"comparison"`
				} `json:"filter"`
			} `json:"features"`
		}
		if json.Unmarshal(item, &object) != nil {
			continue
		}
		equality, comparison := true, false
		if filter := object.Features.Filter; filter != nil {
			if filter.Equality != nil {
				equality = *filter.Equality
			}
			if filter.Comparison != nil {
				comparison = *filter.Comparison
			}
		}
		if !equality {
			continue
		}
		for _, pattern := range object.AttributePatterns {
			rules = append(rules, meilisearchAttributeRule{pattern: pattern, comparison: comparison})
		}
	}
	return rules
}

// meilisearchPatternMatches 判断字段是否命中属性模式：支持 * 通配首尾，字段是已声明属性的嵌套字段（a.b 之于 a）也算命中。
func meilisearchPatternMatches(pattern, field string) bool {
	switch {
	case pattern == "*" || pattern == field || strings.HasPrefix(field, pattern+"."):
		return true
	case strings.HasPrefix(pattern, "*") && strings.HasSuffix(pattern, "*") && len(pattern) > 1:
		return strings.Contains(field, pattern[1:len(pattern)-1])
	case strings.HasPrefix(pattern, "*"):
		return strings.HasSuffix(field, pattern[1:])
	case strings.HasSuffix(pattern, "*"):
		return strings.HasPrefix(field, pattern[:len(pattern)-1])
	}
	return false
}

// filterRule 返回字段的过滤规则；字段不可过滤时 ok 为 false。
func (meta *meilisearchIndexMeta) filterRule(field string) (meilisearchAttributeRule, bool) {
	for _, rule := range meta.filterable {
		if meilisearchPatternMatches(rule.pattern, field) {
			return rule, true
		}
	}
	return meilisearchAttributeRule{}, false
}

func (meta *meilisearchIndexMeta) isSortable(field string) bool {
	for _, pattern := range meta.sortable {
		if meilisearchPatternMatches(pattern, field) {
			return true
		}
	}
	return false
}

// sampleDocuments 读取前 meilisearchSampleSize 个文档（保留字段顺序），用来推断列与类型。
func (m *MeilisearchDB) sampleDocuments(ctx context.Context, uid string) ([]json.RawMessage, error) {
	body, err := m.doRaw(ctx, http.MethodGet, meilisearchIndexPath(uid, fmt.Sprintf("/documents?limit=%d", meilisearchSampleSize)), nil)
	if err != nil {
		return nil, err
	}
	return meilisearchDocumentList(body)
}

// meilisearchDocumentList 取文档列表：0.28 起是 {results: [...]}，之前是数组。
func meilisearchDocumentList(body []byte) ([]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(body)
	var documents []json.RawMessage
	if len(trimmed) > 0 && trimmed[0] == '[' {
		err := json.Unmarshal(trimmed, &documents)
		return documents, err
	}
	var page struct {
		Results []json.RawMessage `json:"results"`
		Hits    []json.RawMessage `json:"hits"`
	}
	if err := json.Unmarshal(trimmed, &page); err != nil {
		return nil, err
	}
	if page.Results != nil {
		return page.Results, nil
	}
	return page.Hits, nil
}

// meilisearchFieldsFromSample 按样本文档里首次出现的顺序列出字段（主键在前），样本里没有、统计里有的字段按名称排在后面；
// 类型取样本中非空值的 JSON 类型，类型不一致时为 mixed。
func meilisearchFieldsFromSample(primaryKey string, sample []json.RawMessage, distribution map[string]int64) ([]string, map[string]string) {
	fields := make([]string, 0, len(distribution)+1)
	seen := map[string]bool{}
	add := func(name string) {
		if name != "" && !seen[name] {
			seen[name] = true
			fields = append(fields, name)
		}
	}
	add(primaryKey)
	types := map[string]string{}
	for _, raw := range sample {
		keys := orderedJSONObjectKeys(raw)
		var document map[string]interface{}
		if decodeJSONWithUseNumber(raw, &document) != nil {
			continue
		}
		for _, key := range keys {
			add(key)
			if value := document[key]; value != nil {
				kind := meilisearchJSONKind(value)
				switch previous := types[key]; {
				case previous == "":
					types[key] = kind
				case previous != kind:
					types[key] = "mixed"
				}
			}
		}
	}
	rest := make([]string, 0, len(distribution))
	for name := range distribution {
		if !seen[name] {
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	for _, name := range rest {
		add(name)
	}
	return fields, types
}

func meilisearchJSONKind(value interface{}) string {
	if _, ok := documentNumber(value); ok {
		return "number"
	}
	switch value.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case []interface{}:
		return "array"
	case map[string]interface{}:
		return "object"
	}
	return "mixed"
}

// orderedJSONObjectKeys 按出现顺序返回 JSON 对象的顶层键（map 解码会丢失顺序）。
func orderedJSONObjectKeys(raw json.RawMessage) []string {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	keys := make([]string, 0, 8)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return keys
		}
		key, _ := token.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			return keys
		}
	}
	return keys
}

// GetDatabases 返回唯一的 default 库：Meilisearch 没有库的概念。
func (m *MeilisearchDB) GetDatabases() ([]string, error) {
	if m.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	return []string{meilisearchDatabaseName}, nil
}

// GetTables 返回全部索引。
func (m *MeilisearchDB) GetTables(string) ([]string, error) {
	ctx, cancel := newMeilisearchMetadataContext()
	defer cancel()
	indexes, err := m.listIndexes(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(indexes))
	for _, index := range indexes {
		names = append(names, index.UID)
	}
	sort.Strings(names)
	return names, nil
}

// GetCreateStatement 给出能在控制台重建索引的 REST 脚本：创建索引（带主键）再写入全部设置。
func (m *MeilisearchDB) GetCreateStatement(_ string, tableName string) (string, error) {
	ctx, cancel := newMeilisearchMetadataContext()
	defer cancel()
	meta, err := m.indexMeta(ctx, tableName)
	if err != nil {
		return "", err
	}
	createBody, _ := json.MarshalIndent(struct {
		UID        string `json:"uid"`
		PrimaryKey string `json:"primaryKey,omitempty"`
	}{meta.uid, meta.primaryKey}, "", "  ")
	var settings bytes.Buffer
	if err := json.Indent(&settings, meta.settings, "", "  "); err != nil {
		settings.Write(meta.settings)
	}
	method := http.MethodPatch
	if !m.paginatedLists() {
		method = http.MethodPost
	}
	return fmt.Sprintf("POST /indexes\n%s\n\n%s %s\n%s", createBody, method, meilisearchIndexPath(meta.uid, "/settings"), settings.String()), nil
}

// GetColumns 返回索引字段：主键标为 PRI，注释里列出字段在设置中的角色（filterable / sortable / searchable / distinct）。
func (m *MeilisearchDB) GetColumns(_ string, tableName string) ([]connection.ColumnDefinition, error) {
	ctx, cancel := newMeilisearchMetadataContext()
	defer cancel()
	meta, err := m.indexMeta(ctx, tableName)
	if err != nil {
		return nil, err
	}
	return meilisearchColumns(meta), nil
}

func meilisearchColumns(meta *meilisearchIndexMeta) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(meta.fields))
	for _, field := range meta.fields {
		column := connection.ColumnDefinition{Name: field, Type: meta.fieldType(field), Nullable: "YES"}
		if field == meta.primaryKey {
			column.Key, column.Nullable = "PRI", "NO"
		}
		roles := make([]string, 0, 4)
		if _, ok := meta.filterRule(field); ok {
			roles = append(roles, "filterable")
		}
		if meta.isSortable(field) {
			roles = append(roles, "sortable")
		}
		for _, pattern := range meta.searchable {
			if meilisearchPatternMatches(pattern, field) {
				roles = append(roles, "searchable")
				break
			}
		}
		if field == meta.distinct {
			roles = append(roles, "distinct")
		}
		column.Comment = strings.Join(roles, ", ")
		columns = append(columns, column)
	}
	return columns
}

// fieldType 是字段的推断类型；样本里没有非空值时为 any。
func (meta *meilisearchIndexMeta) fieldType(field string) string {
	if kind := meta.types[field]; kind != "" {
		return kind
	}
	return "any"
}

// GetAllColumns 返回全部索引的字段（补全用）；单个索引读取失败时跳过。
func (m *MeilisearchDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := m.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := newMeilisearchMetadataContext()
	defer cancel()
	result := make([]connection.ColumnDefinitionWithTable, 0)
	for _, table := range tables {
		meta, err := m.indexMeta(ctx, table)
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				break
			}
			continue
		}
		for _, column := range meilisearchColumns(meta) {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: column.Name, Type: column.Type})
		}
	}
	return result, nil
}

// GetIndexes 把主键与 filterable / sortable / searchable / distinct 设置映射为索引，供表概览与结构页展示。
func (m *MeilisearchDB) GetIndexes(_ string, tableName string) ([]connection.IndexDefinition, error) {
	ctx, cancel := newMeilisearchMetadataContext()
	defer cancel()
	meta, err := m.indexMeta(ctx, tableName)
	if err != nil {
		return nil, err
	}
	indexes := make([]connection.IndexDefinition, 0)
	if meta.primaryKey != "" {
		indexes = append(indexes, connection.IndexDefinition{Name: "PRIMARY", ColumnName: meta.primaryKey, SeqInIndex: 1, IndexType: "PRIMARY"})
	}
	appendGroup := func(name, indexType string, attributes []string) {
		for i, attribute := range attributes {
			indexes = append(indexes, connection.IndexDefinition{Name: name, ColumnName: attribute, NonUnique: 1, SeqInIndex: i + 1, IndexType: indexType})
		}
	}
	filterable := make([]string, 0, len(meta.filterable))
	for _, rule := range meta.filterable {
		filterable = append(filterable, rule.pattern)
	}
	appendGroup("filterableAttributes", "FILTER", filterable)
	appendGroup("sortableAttributes", "SORT", meta.sortable)
	if len(meta.searchable) > 0 && !(len(meta.searchable) == 1 && meta.searchable[0] == "*") {
		appendGroup("searchableAttributes", "SEARCH", meta.searchable)
	}
	if meta.distinct != "" {
		appendGroup("distinctAttribute", "DISTINCT", []string{meta.distinct})
	}
	return indexes, nil
}

// GetForeignKeys 返回空列表：Meilisearch 没有外键。
func (m *MeilisearchDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

// GetTriggers 返回空列表：Meilisearch 没有触发器。
func (m *MeilisearchDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
