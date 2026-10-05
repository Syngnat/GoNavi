//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"GoNavi-Wails/internal/connection"
)

type weaviateClass struct {
	Class              string                         `json:"class"`
	Description        string                         `json:"description"`
	Vectorizer         string                         `json:"vectorizer"`
	VectorIndexType    string                         `json:"vectorIndexType"`
	VectorIndexConfig  map[string]interface{}         `json:"vectorIndexConfig"`
	VectorConfig       map[string]weaviateNamedVector `json:"vectorConfig"`
	MultiTenancyConfig struct {
		Enabled bool `json:"enabled"`
	} `json:"multiTenancyConfig"`
	Properties []weaviateProperty `json:"properties"`
	raw        json.RawMessage
}

type weaviateNamedVector struct {
	VectorIndexType   string                 `json:"vectorIndexType"`
	VectorIndexConfig map[string]interface{} `json:"vectorIndexConfig"`
}

type weaviateProperty struct {
	Name              string             `json:"name"`
	DataType          []string           `json:"dataType"`
	Description       string             `json:"description"`
	Tokenization      string             `json:"tokenization"`
	IndexFilterable   *bool              `json:"indexFilterable"`
	IndexSearchable   *bool              `json:"indexSearchable"`
	IndexRangeFilters *bool              `json:"indexRangeFilters"`
	IndexInverted     *bool              `json:"indexInverted"`
	NestedProperties  []weaviateProperty `json:"nestedProperties"`
}

func (c weaviateClass) multiTenant() bool { return c.MultiTenancyConfig.Enabled }

func (c weaviateClass) property(name string) (weaviateProperty, bool) {
	for _, property := range c.Properties {
		if property.Name == name {
			return property, true
		}
	}
	for _, property := range c.Properties {
		if strings.EqualFold(property.Name, name) {
			return property, true
		}
	}
	return weaviateProperty{}, false
}

// namedVectors 返回命名向量名（1.24 起的 vectorConfig），按名称排序；旧式单向量返回空。
func (c weaviateClass) namedVectors() []string {
	names := make([]string, 0, len(c.VectorConfig))
	for name := range c.VectorConfig {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// baseType 返回数据类型去掉数组后缀后的名称；交叉引用返回目标集合名。
func (p weaviateProperty) baseType() string {
	if len(p.DataType) == 0 {
		return ""
	}
	return strings.TrimSuffix(p.DataType[0], "[]")
}

func (p weaviateProperty) isArray() bool {
	return len(p.DataType) == 1 && strings.HasSuffix(p.DataType[0], "[]")
}

// isReference 报告属性是否为交叉引用：引用的数据类型是集合名，集合名首字母必为大写。
func (p weaviateProperty) isReference() bool {
	for _, value := range p.DataType {
		for _, r := range value {
			return unicode.IsUpper(r)
		}
	}
	return false
}

func (p weaviateProperty) typeLabel() string {
	if p.isReference() {
		return "ref:" + strings.Join(p.DataType, "|")
	}
	return strings.Join(p.DataType, "|")
}

func (w *WeaviateDB) invalidateSchema() {
	w.schemaMu.Lock()
	defer w.schemaMu.Unlock()
	w.schemaCache = nil
	w.tenantCache = nil
}

// loadSchema 读取全部集合定义；短时缓存，避免数据网格每翻一页都重新拉取 schema。
func (w *WeaviateDB) loadSchema(ctx context.Context) ([]weaviateClass, error) {
	w.schemaMu.Lock()
	if w.schemaCache != nil && time.Since(w.schemaLoadedAt) < weaviateSchemaCacheTTL {
		classes := w.schemaCache
		w.schemaMu.Unlock()
		return classes, nil
	}
	w.schemaMu.Unlock()

	var payload struct {
		Classes []json.RawMessage `json:"classes"`
	}
	if err := w.doJSON(ctx, http.MethodGet, "/v1/schema", nil, &payload); err != nil {
		return nil, err
	}
	classes := make([]weaviateClass, 0, len(payload.Classes))
	for _, raw := range payload.Classes {
		var class weaviateClass
		if err := decodeJSONWithUseNumber(raw, &class); err != nil {
			return nil, err
		}
		class.raw = append(json.RawMessage(nil), raw...)
		classes = append(classes, class)
	}
	sort.Slice(classes, func(i, j int) bool { return classes[i].Class < classes[j].Class })

	w.schemaMu.Lock()
	w.schemaCache = classes
	w.schemaLoadedAt = time.Now()
	w.tenantCache = make(map[string][]string)
	w.schemaMu.Unlock()
	return classes, nil
}

// findClass 按名称查集合，先精确匹配再忽略大小写；缓存里没有时刷新一次 schema 再找。
func (w *WeaviateDB) findClass(ctx context.Context, name string) (weaviateClass, error) {
	name = strings.TrimSpace(name)
	for attempt := 0; attempt < 2; attempt++ {
		classes, err := w.loadSchema(ctx)
		if err != nil {
			return weaviateClass{}, err
		}
		for _, class := range classes {
			if class.Class == name {
				return class, nil
			}
		}
		for _, class := range classes {
			if strings.EqualFold(class.Class, name) {
				return class, nil
			}
		}
		w.invalidateSchema()
	}
	return weaviateClass{}, localizedDatabaseRuntimeError("db.backend.error.weaviate_class_not_found", map[string]any{"class": name})
}

// listTenants 返回多租户集合的租户名（按名称排序），随 schema 一起缓存。
func (w *WeaviateDB) listTenants(ctx context.Context, class string) ([]string, error) {
	w.schemaMu.Lock()
	if cached, ok := w.tenantCache[class]; ok {
		w.schemaMu.Unlock()
		return cached, nil
	}
	w.schemaMu.Unlock()

	var tenants []struct {
		Name string `json:"name"`
	}
	if err := w.doJSON(ctx, http.MethodGet, "/v1/schema/"+weaviateEscapePath(class)+"/tenants", nil, &tenants); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(tenants))
	for _, tenant := range tenants {
		if name := strings.TrimSpace(tenant.Name); name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)

	w.schemaMu.Lock()
	if w.tenantCache != nil {
		w.tenantCache[class] = names
	}
	w.schemaMu.Unlock()
	return names, nil
}

// tenantFor 返回访问该集合时使用的租户：多租户集合必须有当前租户，普通集合不带租户。
func (w *WeaviateDB) tenantFor(class weaviateClass) (string, error) {
	if !class.multiTenant() {
		return "", nil
	}
	if w.tenant == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.weaviate_tenant_required", map[string]any{"class": class.Class})
	}
	return w.tenant, nil
}

func newWeaviateMetadataContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), defaultWeaviateQueryTimeout)
}

// GetDatabases 返回 default 与多租户集合的租户（并集，最多 weaviateMaxNamespaces 个）。
func (w *WeaviateDB) GetDatabases() ([]string, error) {
	ctx, cancel := newWeaviateMetadataContext()
	defer cancel()
	classes, err := w.loadSchema(ctx)
	if err != nil {
		return nil, err
	}
	names := []string{weaviateDefaultNamespace}
	if !w.supportsTenants() {
		return names, nil
	}
	seen := map[string]bool{weaviateDefaultNamespace: true}
	for _, class := range classes {
		if !class.multiTenant() {
			continue
		}
		tenants, err := w.listTenants(ctx, class.Class)
		if err != nil {
			return nil, err
		}
		for _, tenant := range tenants {
			if !seen[tenant] && len(names) < weaviateMaxNamespaces {
				seen[tenant] = true
				names = append(names, tenant)
			}
		}
	}
	sort.Strings(names[1:])
	return names, nil
}

// GetTables 列出命名空间下的集合：default 下是普通集合，租户下是含该租户的多租户集合。
func (w *WeaviateDB) GetTables(dbName string) ([]string, error) {
	ctx, cancel := newWeaviateMetadataContext()
	defer cancel()
	classes, err := w.loadSchema(ctx)
	if err != nil {
		return nil, err
	}
	namespace := strings.TrimSpace(dbName)
	if namespace == "" {
		namespace = weaviateDefaultNamespace
	}
	tables := make([]string, 0, len(classes))
	for _, class := range classes {
		if !class.multiTenant() {
			if namespace == weaviateDefaultNamespace {
				tables = append(tables, class.Class)
			}
			continue
		}
		if !w.supportsTenants() {
			continue
		}
		tenants, err := w.listTenants(ctx, class.Class)
		if err != nil {
			return nil, err
		}
		if index := sort.SearchStrings(tenants, namespace); index < len(tenants) && tenants[index] == namespace {
			tables = append(tables, class.Class)
		}
	}
	return tables, nil
}

// GetCreateStatement 返回集合定义的 JSON（Weaviate 没有 DDL，集合由 POST /v1/schema 创建）。
func (w *WeaviateDB) GetCreateStatement(_ string, tableName string) (string, error) {
	ctx, cancel := newWeaviateMetadataContext()
	defer cancel()
	class, err := w.findClass(ctx, tableName)
	if err != nil {
		return "", err
	}
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, class.raw, "", "  "); err != nil {
		return string(class.raw), nil
	}
	return formatted.String(), nil
}

// GetColumns 返回 _id、各属性、时间戳与向量列；_id 是主键，数据网格据此提交编辑。
func (w *WeaviateDB) GetColumns(_ string, tableName string) ([]connection.ColumnDefinition, error) {
	ctx, cancel := newWeaviateMetadataContext()
	defer cancel()
	class, err := w.findClass(ctx, tableName)
	if err != nil {
		return nil, err
	}
	return weaviateClassColumns(class), nil
}

func weaviateClassColumns(class weaviateClass) []connection.ColumnDefinition {
	columns := []connection.ColumnDefinition{{Name: weaviateIDColumn, Type: "uuid", Nullable: "NO", Key: "PRI"}}
	for _, property := range class.Properties {
		columns = append(columns, connection.ColumnDefinition{
			Name:     property.Name,
			Type:     property.typeLabel(),
			Nullable: "YES",
			Comment:  property.Description,
		})
	}
	columns = append(columns,
		connection.ColumnDefinition{Name: weaviateCreatedColumn, Type: "int", Nullable: "NO"},
		connection.ColumnDefinition{Name: weaviateUpdatedColumn, Type: "int", Nullable: "NO"},
	)
	if len(class.VectorConfig) > 0 {
		columns = append(columns, connection.ColumnDefinition{Name: weaviateVectorsColumn, Type: "object", Nullable: "YES"})
	} else {
		columns = append(columns, connection.ColumnDefinition{Name: weaviateVectorColumn, Type: "number[]", Nullable: "YES"})
	}
	return columns
}

func (w *WeaviateDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := w.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := newWeaviateMetadataContext()
	defer cancel()
	result := make([]connection.ColumnDefinitionWithTable, 0)
	for _, table := range tables {
		class, err := w.findClass(ctx, table)
		if err != nil {
			return nil, err
		}
		for _, column := range weaviateClassColumns(class) {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: column.Name, Type: column.Type, Comment: column.Comment})
		}
	}
	return result, nil
}

// GetIndexes 返回主键、向量索引与倒排索引（可过滤 / BM25 可检索 / 范围过滤）。
func (w *WeaviateDB) GetIndexes(_ string, tableName string) ([]connection.IndexDefinition, error) {
	ctx, cancel := newWeaviateMetadataContext()
	defer cancel()
	class, err := w.findClass(ctx, tableName)
	if err != nil {
		return nil, err
	}
	return weaviateClassIndexes(class), nil
}

func weaviateClassIndexes(class weaviateClass) []connection.IndexDefinition {
	indexes := []connection.IndexDefinition{{Name: "PRIMARY", ColumnName: weaviateIDColumn, SeqInIndex: 1, IndexType: "UUID"}}
	if names := class.namedVectors(); len(names) > 0 {
		for _, name := range names {
			config := class.VectorConfig[name]
			indexes = append(indexes, connection.IndexDefinition{
				Name: "vector:" + name, ColumnName: weaviateVectorsColumn + "." + name, NonUnique: 1, SeqInIndex: 1,
				IndexType: weaviateVectorIndexLabel(config.VectorIndexType, config.VectorIndexConfig),
			})
		}
	} else if class.VectorIndexType != "" {
		indexes = append(indexes, connection.IndexDefinition{
			Name: "vector", ColumnName: weaviateVectorColumn, NonUnique: 1, SeqInIndex: 1,
			IndexType: weaviateVectorIndexLabel(class.VectorIndexType, class.VectorIndexConfig),
		})
	}
	for _, property := range class.Properties {
		if property.isReference() {
			continue
		}
		if weaviateFlag(property.IndexFilterable, weaviateFlag(property.IndexInverted, true)) {
			indexes = append(indexes, connection.IndexDefinition{Name: "filterable:" + property.Name, ColumnName: property.Name, NonUnique: 1, SeqInIndex: 1, IndexType: "FILTERABLE"})
		}
		textual := property.baseType() == "text" || property.baseType() == "string"
		if textual && weaviateFlag(property.IndexSearchable, weaviateFlag(property.IndexInverted, true)) {
			label := "SEARCHABLE (BM25)"
			if property.Tokenization != "" {
				label = fmt.Sprintf("SEARCHABLE (BM25, %s)", property.Tokenization)
			}
			indexes = append(indexes, connection.IndexDefinition{Name: "searchable:" + property.Name, ColumnName: property.Name, NonUnique: 1, SeqInIndex: 1, IndexType: label})
		}
		if weaviateFlag(property.IndexRangeFilters, false) {
			indexes = append(indexes, connection.IndexDefinition{Name: "range:" + property.Name, ColumnName: property.Name, NonUnique: 1, SeqInIndex: 1, IndexType: "RANGE"})
		}
	}
	return indexes
}

func weaviateVectorIndexLabel(indexType string, config map[string]interface{}) string {
	label := strings.ToUpper(strings.TrimSpace(indexType))
	if label == "" {
		label = "HNSW"
	}
	if distance, ok := config["distance"].(string); ok && distance != "" {
		label += " " + distance
	}
	return label
}

func weaviateFlag(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

// GetForeignKeys 把交叉引用属性映射为指向目标集合 _id 的外键。
func (w *WeaviateDB) GetForeignKeys(_ string, tableName string) ([]connection.ForeignKeyDefinition, error) {
	ctx, cancel := newWeaviateMetadataContext()
	defer cancel()
	class, err := w.findClass(ctx, tableName)
	if err != nil {
		return nil, err
	}
	keys := make([]connection.ForeignKeyDefinition, 0)
	for _, property := range class.Properties {
		if !property.isReference() {
			continue
		}
		for _, target := range property.DataType {
			name := "ref:" + property.Name + ":" + target
			keys = append(keys, connection.ForeignKeyDefinition{Name: name, ConstraintName: name, ColumnName: property.Name, RefTableName: target, RefColumnName: weaviateIDColumn})
		}
	}
	return keys, nil
}

func (w *WeaviateDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
