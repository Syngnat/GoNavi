//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

// typesenseField 是集合 schema 里的一个字段。index / sort 缺省时由服务端按类型决定：
// 字段默认参与索引，数值与布尔默认可排序，字符串要显式 sort: true。
type typesenseField struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Facet    bool   `json:"facet"`
	Optional bool   `json:"optional"`
	Index    *bool  `json:"index"`
	Sort     *bool  `json:"sort"`
}

func (f typesenseField) indexed() bool { return f.Index == nil || *f.Index }

func (f typesenseField) numeric() bool {
	switch f.Type {
	case "int32", "int64", "float":
		return true
	}
	return false
}

func (f typesenseField) sortable() bool {
	if f.Sort != nil {
		return *f.Sort
	}
	return f.numeric() || f.Type == "bool"
}

// isPattern 报告字段名是否为 auto schema 的正则模式（如 .*、.*_facet）。
func (f typesenseField) isPattern() bool { return strings.ContainsAny(f.Name, "*") }

// typesenseCollectionMeta 是集合的字段、类型、文档数与原始 schema，按 typesenseMetaTTL 缓存。
type typesenseCollectionMeta struct {
	name        string
	documents   int64
	defaultSort string
	fields      []string
	schema      map[string]typesenseField
	extras      map[string]bool
	raw         json.RawMessage
	loadedAt    time.Time
}

func (meta *typesenseCollectionMeta) field(name string) (typesenseField, bool) {
	if name == "id" {
		return typesenseField{Name: "id", Type: "string"}, true
	}
	field, ok := meta.schema[name]
	return field, ok
}

// fieldType 是字段的 schema 类型；只存储未建索引的字段为 any。
func (meta *typesenseCollectionMeta) fieldType(name string) string {
	if field, ok := meta.field(name); ok {
		return field.Type
	}
	return "any"
}

func newTypesenseMetadataContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), defaultTypesenseQueryTimeout)
}

type typesenseCollectionInfo struct {
	Name                string           `json:"name"`
	Fields              []typesenseField `json:"fields"`
	DefaultSortingField string           `json:"default_sorting_field"`
	NumDocuments        int64            `json:"num_documents"`
}

// collectionMeta 返回集合元数据；集合不存在时报 typesense_collection_not_found。
func (t *TypesenseDB) collectionMeta(ctx context.Context, name string) (*typesenseCollectionMeta, error) {
	name = strings.TrimSpace(name)
	t.mu.Lock()
	if cached := t.metaCache[name]; cached != nil && time.Since(cached.loadedAt) < typesenseMetaTTL {
		t.mu.Unlock()
		return cached, nil
	}
	t.mu.Unlock()

	raw, err := t.doRaw(ctx, http.MethodGet, typesenseCollectionPath(name, ""), nil)
	if err != nil {
		if typesenseStatus(err, http.StatusNotFound) {
			return nil, localizedDatabaseRuntimeError("db.backend.error.typesense_collection_not_found", map[string]any{"collection": name})
		}
		return nil, err
	}
	var info typesenseCollectionInfo
	if err := decodeJSONWithUseNumber(raw, &info); err != nil {
		return nil, err
	}
	meta := &typesenseCollectionMeta{
		name: info.Name, documents: info.NumDocuments, defaultSort: info.DefaultSortingField,
		schema: map[string]typesenseField{}, extras: map[string]bool{}, raw: json.RawMessage(bytes.TrimSpace(raw)),
	}
	meta.fields = append(meta.fields, "id")
	for _, field := range info.Fields {
		if field.isPattern() || field.Name == "id" {
			continue
		}
		meta.schema[field.Name] = field
		meta.fields = append(meta.fields, field.Name)
	}
	// 只存储、不在 schema 里的字段也会出现在文档中：从前几个文档里补上，标为 any。
	if sample, err := t.searchDocuments(ctx, meta.name, typesenseSearch{perPage: typesenseSampleSize, page: 1}); err == nil {
		extras := make([]string, 0)
		for _, document := range sample.documents {
			for key := range document {
				if _, ok := meta.field(key); !ok && !meta.extras[key] {
					meta.extras[key] = true
					extras = append(extras, key)
				}
			}
		}
		sort.Strings(extras)
		meta.fields = append(meta.fields, extras...)
	}

	t.mu.Lock()
	if t.metaCache == nil {
		t.metaCache = map[string]*typesenseCollectionMeta{}
	}
	meta.loadedAt = time.Now()
	t.metaCache[name] = meta
	t.mu.Unlock()
	return meta, nil
}

// GetDatabases 返回唯一的 default 库：Typesense 没有库的概念。
func (t *TypesenseDB) GetDatabases() ([]string, error) {
	if t.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	return []string{typesenseDatabaseName}, nil
}

// GetTables 返回全部集合。
func (t *TypesenseDB) GetTables(string) ([]string, error) {
	ctx, cancel := newTypesenseMetadataContext()
	defer cancel()
	var collections []typesenseCollectionInfo
	if err := t.doJSON(ctx, http.MethodGet, "/collections", nil, &collections); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(collections))
	for _, collection := range collections {
		names = append(names, collection.Name)
	}
	sort.Strings(names)
	return names, nil
}

// GetCreateStatement 给出能在控制台重建集合的 REST 脚本：建集合（完整 schema），再写入同义词与人工排序规则。
func (t *TypesenseDB) GetCreateStatement(_ string, tableName string) (string, error) {
	ctx, cancel := newTypesenseMetadataContext()
	defer cancel()
	meta, err := t.collectionMeta(ctx, tableName)
	if err != nil {
		return "", err
	}
	schema, err := typesenseCreateSchema(meta.raw)
	if err != nil {
		return "", err
	}
	parts := []string{"POST /collections\n" + schema}
	for _, kind := range []string{"synonyms", "overrides"} {
		parts = append(parts, t.collectionRules(ctx, meta.name, kind)...)
	}
	return strings.Join(parts, "\n\n"), nil
}

// typesenseCreateSchema 去掉 schema 里的运行时字段（文档数、创建时间、分片数），name 与 fields 放在最前。
func typesenseCreateSchema(raw json.RawMessage) (string, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return "", err
	}
	for _, key := range []string{"created_at", "num_documents", "num_memory_shards"} {
		delete(object, key)
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		if key != "name" && key != "fields" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var b bytes.Buffer
	b.WriteString("{")
	for i, key := range append([]string{"name", "fields"}, keys...) {
		value, ok := object[key]
		if !ok {
			continue
		}
		if i > 0 && b.Len() > 1 {
			b.WriteString(",")
		}
		name, _ := json.Marshal(key)
		b.Write(name)
		b.WriteString(":")
		b.Write(value)
	}
	b.WriteString("}")
	var indented bytes.Buffer
	if err := json.Indent(&indented, b.Bytes(), "", "  "); err != nil {
		return "", err
	}
	return indented.String(), nil
}

// collectionRules 把集合的同义词或人工排序规则写成 PUT 请求；读取失败（权限不足等）时省略。
func (t *TypesenseDB) collectionRules(ctx context.Context, collection, kind string) []string {
	raw, err := t.doRaw(ctx, http.MethodGet, typesenseCollectionPath(collection, "/"+kind), nil)
	if err != nil {
		return nil
	}
	var payload map[string][]map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	requests := make([]string, 0, len(payload[kind]))
	for _, rule := range payload[kind] {
		var id string
		if json.Unmarshal(rule["id"], &id) != nil || id == "" {
			continue
		}
		delete(rule, "id")
		body, _ := json.MarshalIndent(rule, "", "  ")
		requests = append(requests, fmt.Sprintf("PUT %s\n%s", typesenseCollectionPath(collection, "/"+kind+"/"+url.PathEscape(id)), body))
	}
	return requests
}

// GetColumns 返回集合字段：id 为主键，注释列出 facet / sort / optional / 未建索引等属性。
func (t *TypesenseDB) GetColumns(_ string, tableName string) ([]connection.ColumnDefinition, error) {
	ctx, cancel := newTypesenseMetadataContext()
	defer cancel()
	meta, err := t.collectionMeta(ctx, tableName)
	if err != nil {
		return nil, err
	}
	return typesenseColumns(meta), nil
}

func typesenseColumns(meta *typesenseCollectionMeta) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(meta.fields))
	for _, name := range meta.fields {
		column := connection.ColumnDefinition{Name: name, Type: meta.fieldType(name), Nullable: "YES"}
		roles := make([]string, 0, 4)
		field, inSchema := meta.field(name)
		switch {
		case name == "id":
			column.Key, column.Nullable = "PRI", "NO"
		case !inSchema:
			roles = append(roles, "stored only")
		default:
			if !field.Optional {
				column.Nullable = "NO"
			}
			if field.Facet {
				roles = append(roles, "facet")
			}
			if field.sortable() {
				roles = append(roles, "sort")
			}
			if !field.indexed() {
				roles = append(roles, "index: false")
			}
			if name == meta.defaultSort {
				roles = append(roles, "default_sorting_field")
			}
		}
		column.Comment = strings.Join(roles, ", ")
		columns = append(columns, column)
	}
	return columns
}

// GetAllColumns 返回全部集合的字段（补全用）；单个集合读取失败时跳过。
func (t *TypesenseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := t.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := newTypesenseMetadataContext()
	defer cancel()
	result := make([]connection.ColumnDefinitionWithTable, 0)
	for _, table := range tables {
		meta, err := t.collectionMeta(ctx, table)
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				break
			}
			continue
		}
		for _, column := range typesenseColumns(meta) {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: column.Name, Type: column.Type})
		}
	}
	return result, nil
}

// GetIndexes 把 id 主键、facet 字段、可排序字段与默认排序字段映射为索引，供表概览与结构页展示。
func (t *TypesenseDB) GetIndexes(_ string, tableName string) ([]connection.IndexDefinition, error) {
	ctx, cancel := newTypesenseMetadataContext()
	defer cancel()
	meta, err := t.collectionMeta(ctx, tableName)
	if err != nil {
		return nil, err
	}
	indexes := []connection.IndexDefinition{{Name: "PRIMARY", ColumnName: "id", SeqInIndex: 1, IndexType: "PRIMARY"}}
	appendGroup := func(name, indexType string, match func(typesenseField) bool) {
		seq := 0
		for _, fieldName := range meta.fields {
			field, ok := meta.schema[fieldName]
			if ok && match(field) {
				seq++
				indexes = append(indexes, connection.IndexDefinition{Name: name, ColumnName: fieldName, NonUnique: 1, SeqInIndex: seq, IndexType: indexType})
			}
		}
	}
	appendGroup("facet", "FACET", func(field typesenseField) bool { return field.Facet })
	appendGroup("sort", "SORT", typesenseField.sortable)
	if meta.defaultSort != "" {
		indexes = append(indexes, connection.IndexDefinition{Name: "default_sorting_field", ColumnName: meta.defaultSort, NonUnique: 1, SeqInIndex: 1, IndexType: "DEFAULT SORT"})
	}
	return indexes, nil
}

// GetForeignKeys 返回空列表：Typesense 的引用字段（reference）不作为外键展示。
func (t *TypesenseDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

// GetTriggers 返回空列表：Typesense 没有触发器。
func (t *TypesenseDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
