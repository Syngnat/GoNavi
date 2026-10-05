//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

func (w *WeaviateDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultWeaviateQueryTimeout)
	defer cancel()
	return w.QueryContext(ctx, query)
}

func (w *WeaviateDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if w.client == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	if graphQL, ok := weaviateGraphQLText(text); ok {
		return w.queryGraphQL(ctx, graphQL)
	}
	if request, ok := parseWeaviateRESTRequest(text); ok {
		switch {
		case request.method == http.MethodPost && request.path == "/v1/graphql":
			if graphQL, ok := weaviateGraphQLText(string(request.body)); ok {
				return w.queryGraphQL(ctx, graphQL)
			}
		case request.method == http.MethodGet || request.method == http.MethodHead:
			body, err := w.doRaw(ctx, request.method, request.path, nil)
			if err != nil {
				return nil, nil, err
			}
			rows, columns := weaviateRESTRows(body)
			return rows, columns, nil
		}
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.weaviate_query_unsupported", nil)
	}
	if strings.HasPrefix(strings.ToLower(text), "select") {
		return w.querySQL(ctx, text)
	}
	return nil, nil, localizedDatabaseRuntimeError("db.backend.error.weaviate_query_unsupported", nil)
}

// weaviateSelection 是 SELECT 投影解析后的输出列与需要的 GraphQL 字段。
type weaviateSelection struct {
	columns    []string
	properties []weaviateProperty
	timestamps bool
	vector     bool
}

// querySQL 把 SELECT 翻译成 GraphQL Get / Aggregate：WHERE、ORDER BY、LIMIT、OFFSET 按集合 schema 转换。
func (w *WeaviateDB) querySQL(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	className := parseSQLFromName(text)
	if className == "" {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.weaviate_query_unsupported", nil)
	}
	class, err := w.findClass(ctx, className)
	if err != nil {
		return nil, nil, err
	}
	tenant, err := w.tenantFor(class)
	if err != nil {
		return nil, nil, err
	}
	clauses := splitRegistrySelectClauses(text, weaviatePageSize)
	var filter gqlObject
	if clauses.where != "" {
		node, err := parseRegistryWhere(clauses.where)
		if err != nil {
			return nil, nil, err
		}
		if filter, err = w.renderFilter(class, node); err != nil {
			return nil, nil, err
		}
	}
	projection := sqlSelectProjection(text)
	if sqlContainsFunctionCall(projection, "COUNT") {
		total, err := w.aggregateCount(ctx, class, tenant, filter)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	selection, err := w.parseProjection(class, projection)
	if err != nil {
		return nil, nil, err
	}
	var args gqlObject
	if filter != nil {
		args = append(args, gqlField{"where", filter})
	}
	if clauses.orderBy != "" {
		sorts, err := w.parseWeaviateOrderBy(class, clauses.orderBy)
		if err != nil {
			return nil, nil, err
		}
		args = append(args, gqlField{"sort", sorts})
	}
	if tenant != "" {
		args = append(args, gqlField{"tenant", tenant})
	}
	limit := clauses.limit
	if !clauses.hasLimit {
		// 没写 LIMIT 时读取全部对象（导出、备份与迁移按全表读取；控制台的 SELECT 由编辑器自动补上 LIMIT）。
		limit = math.MaxInt32
	}
	// 没有条件、排序与偏移的整表读取用游标（after，1.18 起）分页，不受 offset + limit 的上限（默认 10000）约束。
	cursor := !clauses.hasLimit && filter == nil && clauses.orderBy == "" && clauses.offset == 0 && w.atLeast("1.18")
	objects, err := w.getObjects(ctx, class, args, w.selectionFields(class, selection), clauses.offset, limit, cursor)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]map[string]interface{}, 0, len(objects))
	for _, object := range objects {
		row := weaviateGraphQLObjectRow(object)
		projected := make(map[string]interface{}, len(selection.columns))
		for _, column := range selection.columns {
			projected[column] = row[column]
		}
		rows = append(rows, projected)
	}
	return rows, selection.columns, nil
}

// getObjects 分页执行 Get，读取 [offset, offset+limit) 的对象：cursor 为 true 时按对象 ID 用 after 翻页，
// 否则按 offset 翻页；一页装得下时只发一次请求。
func (w *WeaviateDB) getObjects(ctx context.Context, class weaviateClass, args gqlObject, fields string, offset, limit int, cursor bool) ([]map[string]interface{}, error) {
	objects := make([]map[string]interface{}, 0, min(limit, weaviatePageSize))
	after := ""
	for len(objects) < limit {
		size := min(limit-len(objects), weaviatePageSize)
		pageArgs := gqlObject{{"limit", size}}
		switch {
		case cursor && after != "":
			pageArgs = append(pageArgs, gqlField{"after", after})
		case !cursor && offset+len(objects) > 0:
			pageArgs = append(pageArgs, gqlField{"offset", offset + len(objects)})
		}
		pageArgs = append(pageArgs, args...)
		data, err := w.graphQL(ctx, buildWeaviateClassQuery("Get", class.Class, pageArgs, fields))
		if err != nil {
			return nil, err
		}
		page := weaviateClassResults(data, "Get", class.Class)
		objects = append(objects, page...)
		if len(page) < size {
			break
		}
		last, _ := weaviateGraphQLObjectRow(page[len(page)-1])[weaviateIDColumn].(string)
		if cursor && last == "" {
			break
		}
		after = last
	}
	return objects, nil
}

// parseProjection 解析 SELECT 列：* 展开为 _id、全部属性与时间戳；_vector / _vectors 只有显式选择时才返回。
func (w *WeaviateDB) parseProjection(class weaviateClass, projection string) (weaviateSelection, error) {
	selection := weaviateSelection{}
	seen := map[string]bool{}
	addColumn := func(name string) {
		if !seen[name] {
			seen[name] = true
			selection.columns = append(selection.columns, name)
		}
	}
	addProperty := func(property weaviateProperty) {
		if !seen[property.Name] {
			selection.properties = append(selection.properties, property)
			addColumn(property.Name)
		}
	}
	for _, item := range splitWeaviateProjection(projection) {
		name := item
		if index := findSQLKeyword(name, "AS", 0); index > 0 {
			name = strings.TrimSpace(name[:index])
		}
		name = strings.Trim(strings.TrimSpace(name), "\"`[]")
		switch strings.ToLower(name) {
		case "*":
			addColumn(weaviateIDColumn)
			for _, property := range class.Properties {
				addProperty(property)
			}
			selection.timestamps = true
			addColumn(weaviateCreatedColumn)
			addColumn(weaviateUpdatedColumn)
		case weaviateIDColumn, "id":
			addColumn(weaviateIDColumn)
		case strings.ToLower(weaviateCreatedColumn):
			selection.timestamps = true
			addColumn(weaviateCreatedColumn)
		case strings.ToLower(weaviateUpdatedColumn):
			selection.timestamps = true
			addColumn(weaviateUpdatedColumn)
		case weaviateVectorColumn, weaviateVectorsColumn:
			selection.vector = true
			if len(class.VectorConfig) > 0 && w.supportsNamedVectors() {
				addColumn(weaviateVectorsColumn)
			} else {
				addColumn(weaviateVectorColumn)
			}
		default:
			property, ok := class.property(name)
			if !ok {
				return selection, localizedDatabaseRuntimeError("db.backend.error.weaviate_property_not_found", map[string]any{"class": class.Class, "property": name})
			}
			addProperty(property)
		}
	}
	if len(selection.columns) == 0 {
		return selection, localizedDatabaseRuntimeError("db.backend.error.weaviate_query_unsupported", nil)
	}
	return selection, nil
}

// splitWeaviateProjection 按顶层逗号拆分投影列表（跳过引号与括号内的逗号）。
func splitWeaviateProjection(projection string) []string {
	items := make([]string, 0, 4)
	depth, start := 0, 0
	for i := 0; i < len(projection); i++ {
		if next, ok := skipSQLQuotedLiteral(projection, i); ok {
			i = next - 1
			continue
		}
		switch projection[i] {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				items = append(items, strings.TrimSpace(projection[start:i]))
				start = i + 1
			}
		}
	}
	if last := strings.TrimSpace(projection[start:]); last != "" {
		items = append(items, last)
	}
	return items
}

// selectionFields 生成 GraphQL 选择集：对象 ID 总会取回，网格编辑据此定位对象。
func (w *WeaviateDB) selectionFields(class weaviateClass, selection weaviateSelection) string {
	parts := make([]string, 0, len(selection.properties)+1)
	for _, property := range selection.properties {
		if field := weaviatePropertySelection(property); field != "" {
			parts = append(parts, field)
		}
	}
	additional := []string{"id"}
	if selection.timestamps {
		additional = append(additional, "creationTimeUnix", "lastUpdateTimeUnix")
	}
	if selection.vector {
		if names := class.namedVectors(); len(names) > 0 && w.supportsNamedVectors() {
			additional = append(additional, "vectors { "+strings.Join(names, " ")+" }")
		} else {
			additional = append(additional, "vector")
		}
	}
	parts = append(parts, "_additional { "+strings.Join(additional, " ")+" }")
	return strings.Join(parts, " ")
}

// weaviatePropertySelection 返回属性的 GraphQL 字段：引用取目标对象 ID，嵌套对象、地理坐标与电话号码展开子字段。
func weaviatePropertySelection(property weaviateProperty) string {
	switch {
	case property.isReference():
		fragments := make([]string, 0, len(property.DataType))
		for _, target := range property.DataType {
			fragments = append(fragments, "... on "+target+" { _additional { id } }")
		}
		return property.Name + " { " + strings.Join(fragments, " ") + " }"
	case property.baseType() == "object":
		nested := make([]string, 0, len(property.NestedProperties))
		for _, child := range property.NestedProperties {
			if field := weaviatePropertySelection(child); field != "" {
				nested = append(nested, field)
			}
		}
		if len(nested) == 0 {
			return ""
		}
		return property.Name + " { " + strings.Join(nested, " ") + " }"
	case property.baseType() == "geoCoordinates":
		return property.Name + " { latitude longitude }"
	case property.baseType() == "phoneNumber":
		return property.Name + " { input internationalFormatted countryCode national nationalFormatted valid }"
	}
	return property.Name
}

func buildWeaviateClassQuery(operation, className string, args gqlObject, fields string) string {
	var b strings.Builder
	b.WriteString("{ ")
	b.WriteString(operation)
	b.WriteString(" { ")
	b.WriteString(className)
	if len(args) > 0 {
		b.WriteByte('(')
		for index, arg := range args {
			if index > 0 {
				b.WriteString(", ")
			}
			b.WriteString(arg.key)
			b.WriteString(": ")
			renderGraphQLValue(&b, arg.value)
		}
		b.WriteByte(')')
	}
	b.WriteString(" { ")
	b.WriteString(fields)
	b.WriteString(" } } }")
	return b.String()
}

func (w *WeaviateDB) aggregateCount(ctx context.Context, class weaviateClass, tenant string, filter gqlObject) (int64, error) {
	args := gqlObject{}
	if filter != nil {
		args = append(args, gqlField{"where", filter})
	}
	if tenant != "" {
		args = append(args, gqlField{"tenant", tenant})
	}
	data, err := w.graphQL(ctx, buildWeaviateClassQuery("Aggregate", class.Class, args, "meta { count }"))
	if err != nil {
		return 0, err
	}
	for _, group := range weaviateClassResults(data, "Aggregate", class.Class) {
		if meta, ok := group["meta"].(map[string]interface{}); ok {
			if count, ok := weaviateInt(meta["count"]); ok {
				return count, nil
			}
		}
	}
	return 0, nil
}

func weaviateClassResults(data map[string]interface{}, operation, className string) []map[string]interface{} {
	section, _ := data[operation].(map[string]interface{})
	items, _ := section[className].([]interface{})
	objects := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]interface{}); ok {
			objects = append(objects, object)
		}
	}
	return objects
}

// queryGraphQL 执行控制台里的 GraphQL：Get 的对象逐行展开（多个集合时加 _class 列），Aggregate 的分组按点号路径拍平。
func (w *WeaviateDB) queryGraphQL(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	data, err := w.graphQL(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]map[string]interface{}, 0)
	for _, operation := range []string{"Get", "Aggregate"} {
		section, ok := data[operation].(map[string]interface{})
		if !ok {
			continue
		}
		classes := make([]string, 0, len(section))
		for className := range section {
			classes = append(classes, className)
		}
		sort.Strings(classes)
		for _, className := range classes {
			for _, object := range weaviateClassResults(data, operation, className) {
				var row map[string]interface{}
				if operation == "Get" {
					row = weaviateGraphQLObjectRow(object)
				} else {
					row = map[string]interface{}{}
					flattenWeaviateValue(row, "", object)
				}
				if len(classes) > 1 {
					row["_class"] = className
				}
				rows = append(rows, row)
			}
		}
	}
	if explore, ok := data["Explore"].([]interface{}); ok {
		for _, item := range explore {
			if object, ok := item.(map[string]interface{}); ok {
				rows = append(rows, normalizeWeaviateRow(object))
			}
		}
	}
	columns := weaviateRowColumns(rows)
	fillWeaviateRows(rows, columns)
	return rows, columns, nil
}

// weaviateGraphQLObjectRow 把 Get 结果对象转成一行：_additional 字段改名为 _id、_creationTimeUnix 等合成列。
func weaviateGraphQLObjectRow(object map[string]interface{}) map[string]interface{} {
	row := make(map[string]interface{}, len(object)+3)
	for key, value := range object {
		if key != "_additional" {
			row[key] = weaviateResultValue(value)
			continue
		}
		additional, _ := value.(map[string]interface{})
		for name, item := range additional {
			switch name {
			case "id":
				row[weaviateIDColumn] = item
			case "creationTimeUnix", "lastUpdateTimeUnix":
				if number, ok := weaviateInt(item); ok {
					row["_"+name] = number
				} else {
					row["_"+name] = item
				}
			default:
				row["_"+name] = weaviateResultValue(item)
			}
		}
	}
	return row
}

// weaviateResultValue 把引用属性的 [{_additional: {id}}] 简化为目标对象 ID 列表，数值转成整数或浮点数。
func weaviateResultValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case json.Number:
		return weaviateNumber(typed)
	case []interface{}:
		ids := make([]interface{}, 0, len(typed))
		for _, item := range typed {
			object, ok := item.(map[string]interface{})
			if !ok || len(object) != 1 {
				return typed
			}
			additional, ok := object["_additional"].(map[string]interface{})
			if !ok {
				return typed
			}
			id, ok := additional["id"]
			if !ok {
				return typed
			}
			ids = append(ids, id)
		}
		if len(ids) > 0 {
			return ids
		}
	}
	return value
}

func weaviateNumber(number json.Number) interface{} {
	if integer, err := number.Int64(); err == nil {
		return integer
	}
	if float, err := number.Float64(); err == nil {
		return float
	}
	return number.String()
}

func weaviateInt(value interface{}) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		integer, err := typed.Int64()
		return integer, err == nil
	case string:
		integer, err := strconv.ParseInt(typed, 10, 64)
		return integer, err == nil
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	}
	return 0, false
}

func flattenWeaviateValue(row map[string]interface{}, prefix string, value interface{}) {
	object, ok := value.(map[string]interface{})
	if !ok {
		row[prefix] = weaviateResultValue(value)
		return
	}
	for key, item := range object {
		name := key
		if prefix != "" {
			name = prefix + "." + key
		}
		flattenWeaviateValue(row, name, item)
	}
}

func normalizeWeaviateRow(object map[string]interface{}) map[string]interface{} {
	row := make(map[string]interface{}, len(object))
	for key, value := range object {
		row[key] = weaviateResultValue(value)
	}
	return row
}

// weaviateRESTRows 把 REST 响应转成表格：/v1/objects 按对象逐行，/v1/schema 按集合逐行，
// 只有一个对象数组字段的响应展开该数组，其余对象作为单行。
func weaviateRESTRows(body []byte) ([]map[string]interface{}, []string) {
	var payload interface{}
	if len(bytes.TrimSpace(body)) == 0 || decodeJSONWithUseNumber(body, &payload) != nil {
		row := map[string]interface{}{"response": string(body)}
		return []map[string]interface{}{row}, []string{"response"}
	}
	rows := make([]map[string]interface{}, 0)
	appendItems := func(items []interface{}) {
		for _, item := range items {
			if object, ok := item.(map[string]interface{}); ok {
				rows = append(rows, weaviateRESTObjectRow(object))
			} else {
				rows = append(rows, map[string]interface{}{"value": weaviateResultValue(item)})
			}
		}
	}
	switch typed := payload.(type) {
	case []interface{}:
		appendItems(typed)
	case map[string]interface{}:
		if items, ok := weaviateSingleArrayField(typed); ok {
			appendItems(items)
		} else {
			rows = append(rows, weaviateRESTObjectRow(typed))
		}
	default:
		rows = append(rows, map[string]interface{}{"value": weaviateResultValue(typed)})
	}
	columns := weaviateRowColumns(rows)
	fillWeaviateRows(rows, columns)
	return rows, columns
}

// fillWeaviateRows 让每行都含全部列：响应里缺失的字段补 nil，结果表格显示 NULL 而不是 undefined。
func fillWeaviateRows(rows []map[string]interface{}, columns []string) {
	for _, row := range rows {
		for _, column := range columns {
			if _, ok := row[column]; !ok {
				row[column] = nil
			}
		}
	}
}

// weaviateSingleArrayField 返回 objects / classes 等列表字段；有多个数组字段时不猜测。
func weaviateSingleArrayField(object map[string]interface{}) ([]interface{}, bool) {
	for _, key := range []string{"objects", "classes"} {
		if items, ok := object[key].([]interface{}); ok {
			return items, true
		}
	}
	var found []interface{}
	count := 0
	for _, value := range object {
		if items, ok := value.([]interface{}); ok {
			found = items
			count++
		}
	}
	return found, count == 1 && len(object) <= 2
}

// weaviateRESTObjectRow 展开 REST 对象：id → _id、class → _class、properties 并入行，其余元数据加下划线前缀。
func weaviateRESTObjectRow(object map[string]interface{}) map[string]interface{} {
	properties, isObject := object["properties"].(map[string]interface{})
	if _, hasID := object["id"]; !isObject || !hasID {
		return normalizeWeaviateRow(object)
	}
	row := make(map[string]interface{}, len(properties)+len(object))
	for key, value := range properties {
		row[key] = weaviateResultValue(value)
	}
	for key, value := range object {
		switch key {
		case "properties":
		case "id":
			row[weaviateIDColumn] = value
		default:
			row["_"+key] = weaviateResultValue(value)
		}
	}
	return row
}

var weaviateLeadingColumns = []string{"_class", weaviateIDColumn}

var weaviateTrailingColumns = []string{
	weaviateCreatedColumn, weaviateUpdatedColumn, "_tenant", "_distance", "_certainty", "_score", "_explainScore",
	weaviateVectorColumn, weaviateVectorsColumn, "_vectorWeights", "_deprecations",
}

// weaviateRowColumns 汇总各行的列：_class、_id 在前，属性按名称排序，时间戳、相似度与向量等元数据在后。
func weaviateRowColumns(rows []map[string]interface{}) []string {
	seen := map[string]bool{}
	for _, row := range rows {
		for key := range row {
			seen[key] = true
		}
	}
	columns := make([]string, 0, len(seen))
	fixed := map[string]bool{}
	for _, name := range append(append([]string{}, weaviateLeadingColumns...), weaviateTrailingColumns...) {
		fixed[name] = true
	}
	for _, name := range weaviateLeadingColumns {
		if seen[name] {
			columns = append(columns, name)
		}
	}
	middle := make([]string, 0, len(seen))
	for name := range seen {
		if !fixed[name] {
			middle = append(middle, name)
		}
	}
	sort.Strings(middle)
	columns = append(columns, middle...)
	for _, name := range weaviateTrailingColumns {
		if seen[name] {
			columns = append(columns, name)
		}
	}
	return columns
}
