//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"encoding/json"
	"strconv"
	"strings"
)

// 把 registry_where.go 解析出的网格筛选条件按集合 schema 的数据类型
// 翻译成 Weaviate 的 where 过滤器：IN 拆成 Or 等值、BETWEEN 拆成区间（旧版本没有 ContainsAny / Not），
// NOT LIKE 等只能用 Not 表达的条件交给服务端判断是否支持。

type gqlEnum string

type gqlField struct {
	key   string
	value interface{}
}

// gqlObject 是保持字段顺序的 GraphQL 输入对象，渲染结果稳定、便于测试。
type gqlObject []gqlField

func renderGraphQLValue(b *strings.Builder, value interface{}) {
	switch typed := value.(type) {
	case gqlEnum:
		b.WriteString(string(typed))
	case gqlObject:
		b.WriteByte('{')
		for index, field := range typed {
			if index > 0 {
				b.WriteString(", ")
			}
			b.WriteString(field.key)
			b.WriteString(": ")
			renderGraphQLValue(b, field.value)
		}
		b.WriteByte('}')
	case []gqlObject:
		items := make([]interface{}, len(typed))
		for index, item := range typed {
			items[index] = item
		}
		renderGraphQLValue(b, items)
	case []string:
		items := make([]interface{}, len(typed))
		for index, item := range typed {
			items[index] = item
		}
		renderGraphQLValue(b, items)
	case []interface{}:
		b.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				b.WriteString(", ")
			}
			renderGraphQLValue(b, item)
		}
		b.WriteByte(']')
	case string:
		encoded, _ := json.Marshal(typed)
		b.Write(encoded)
	case bool:
		b.WriteString(strconv.FormatBool(typed))
	case int:
		b.WriteString(strconv.Itoa(typed))
	case int64:
		b.WriteString(strconv.FormatInt(typed, 10))
	case float64:
		b.WriteString(strconv.FormatFloat(typed, 'g', -1, 64))
	case json.Number:
		b.WriteString(typed.String())
	default:
		encoded, _ := json.Marshal(typed)
		b.Write(encoded)
	}
}

// weaviateFilterField 是过滤条件左侧解析出的路径与值类型。
type weaviateFilterField struct {
	path     string
	property string
	dataType string // text、string、int、number、boolean、date、uuid、id、timestamp
}

func (w *WeaviateDB) resolveFilterField(class weaviateClass, name string) (weaviateFilterField, error) {
	switch strings.ToLower(name) {
	case weaviateIDColumn, "id":
		return weaviateFilterField{path: "id", property: weaviateIDColumn, dataType: "id"}, nil
	case strings.ToLower(weaviateCreatedColumn):
		return weaviateFilterField{path: weaviateCreatedColumn, property: weaviateCreatedColumn, dataType: "timestamp"}, nil
	case strings.ToLower(weaviateUpdatedColumn):
		return weaviateFilterField{path: weaviateUpdatedColumn, property: weaviateUpdatedColumn, dataType: "timestamp"}, nil
	}
	property, ok := class.property(name)
	if !ok {
		return weaviateFilterField{}, localizedDatabaseRuntimeError("db.backend.error.weaviate_property_not_found", map[string]any{"class": class.Class, "property": name})
	}
	switch base := property.baseType(); base {
	case "text", "string", "int", "number", "boolean", "date", "uuid":
		return weaviateFilterField{path: property.Name, property: property.Name, dataType: base}, nil
	default:
		return weaviateFilterField{}, localizedDatabaseRuntimeError("db.backend.error.weaviate_filter_unsupported", map[string]any{"property": property.Name, "dataType": property.typeLabel()})
	}
}

// valueKey 返回过滤值字段名：1.19 起 text / string 合并为 valueText，旧版本 string 属性与 id 用 valueString。
func (w *WeaviateDB) valueKey(dataType string) string {
	switch dataType {
	case "int":
		return "valueInt"
	case "number":
		return "valueNumber"
	case "boolean":
		return "valueBoolean"
	case "date":
		return "valueDate"
	case "string":
		return "valueString"
	case "id":
		if !w.usesValueText() {
			return "valueString"
		}
	}
	return "valueText"
}

func weaviateFilterValue(field weaviateFilterField, literal registryWhereLiteral) (interface{}, error) {
	invalid := func() error {
		return localizedDatabaseRuntimeError("db.backend.error.weaviate_filter_value_invalid", map[string]any{"property": field.property, "dataType": field.dataType, "value": literal.text})
	}
	text := strings.TrimSpace(literal.text)
	switch field.dataType {
	case "int":
		value, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			if float, floatErr := strconv.ParseFloat(text, 64); floatErr == nil && float == float64(int64(float)) {
				return int64(float), nil
			}
			return nil, invalid()
		}
		return value, nil
	case "number":
		value, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil, invalid()
		}
		return value, nil
	case "boolean":
		switch strings.ToLower(text) {
		case "true", "t", "1", "yes", "y":
			return true, nil
		case "false", "f", "0", "no", "n":
			return false, nil
		}
		return nil, invalid()
	case "date":
		value, ok := normalizeRegistryDate(text)
		if !ok {
			return nil, invalid()
		}
		return value, nil
	default:
		return literal.text, nil
	}
}

func (w *WeaviateDB) renderFilter(class weaviateClass, node interface{}) (gqlObject, error) {
	switch typed := node.(type) {
	case registryWhereLogical:
		operands := make([]gqlObject, 0, len(typed.operands))
		for _, operand := range typed.operands {
			rendered, err := w.renderFilter(class, operand)
			if err != nil {
				return nil, err
			}
			operands = append(operands, rendered)
		}
		return gqlObject{{"operator", gqlEnum(typed.op)}, {"operands", operands}}, nil
	case registryWhereCondition:
		return w.renderCondition(class, typed)
	}
	return nil, registryWhereError("")
}

func (w *WeaviateDB) renderCondition(class weaviateClass, condition registryWhereCondition) (gqlObject, error) {
	field, err := w.resolveFilterField(class, condition.field)
	if err != nil {
		return nil, err
	}
	leaf := func(operator string, literal registryWhereLiteral) (gqlObject, error) {
		value, err := weaviateFilterValue(field, literal)
		if err != nil {
			return nil, err
		}
		return gqlObject{{"path", []string{field.path}}, {"operator", gqlEnum(operator)}, {w.valueKey(field.dataType), value}}, nil
	}
	combine := func(op string, operator string, literals []registryWhereLiteral) (gqlObject, error) {
		operands := make([]gqlObject, 0, len(literals))
		for _, literal := range literals {
			rendered, err := leaf(operator, literal)
			if err != nil {
				return nil, err
			}
			operands = append(operands, rendered)
		}
		if len(operands) == 1 {
			return operands[0], nil
		}
		return gqlObject{{"operator", gqlEnum(op)}, {"operands", operands}}, nil
	}
	comparisons := map[string]string{"=": "Equal", "!=": "NotEqual", ">": "GreaterThan", ">=": "GreaterThanEqual", "<": "LessThan", "<=": "LessThanEqual"}
	switch condition.op {
	case "IS NULL", "IS NOT NULL":
		return gqlObject{{"path", []string{field.path}}, {"operator", gqlEnum("IsNull")}, {"valueBoolean", condition.op == "IS NULL"}}, nil
	case "LIKE", "NOT LIKE":
		pattern := strings.NewReplacer("%", "*", "_", "?").Replace(condition.values[0].text)
		like := gqlObject{{"path", []string{field.path}}, {"operator", gqlEnum("Like")}, {w.valueKey(field.dataType), pattern}}
		if condition.op == "LIKE" {
			return like, nil
		}
		return gqlObject{{"operator", gqlEnum("Not")}, {"operands", []gqlObject{like}}}, nil
	case "IN":
		return combine("Or", "Equal", condition.values)
	case "NOT IN":
		return combine("And", "NotEqual", condition.values)
	case "BETWEEN", "NOT BETWEEN":
		lowOp, highOp, joiner := "GreaterThanEqual", "LessThanEqual", "And"
		if condition.op == "NOT BETWEEN" {
			lowOp, highOp, joiner = "LessThan", "GreaterThan", "Or"
		}
		low, err := leaf(lowOp, condition.values[0])
		if err != nil {
			return nil, err
		}
		high, err := leaf(highOp, condition.values[1])
		if err != nil {
			return nil, err
		}
		return gqlObject{{"operator", gqlEnum(joiner)}, {"operands", []gqlObject{low, high}}}, nil
	}
	if operator, ok := comparisons[condition.op]; ok {
		return leaf(operator, condition.values[0])
	}
	return nil, registryWhereError(condition.op)
}

// parseWeaviateOrderBy 解析 ORDER BY 列表为 Weaviate sort 参数。
func (w *WeaviateDB) parseWeaviateOrderBy(class weaviateClass, text string) ([]gqlObject, error) {
	tokens, err := tokenizeRegistryWhere(text)
	if err != nil {
		return nil, err
	}
	sorts := make([]gqlObject, 0, 2)
	for i := 0; i < len(tokens); {
		token := tokens[i]
		if token.kind != registryWhereTokWord && token.kind != registryWhereTokQuotedIdent {
			return nil, registryWhereError(token.text)
		}
		field, err := w.resolveFilterField(class, token.text)
		if err != nil {
			return nil, err
		}
		order := "asc"
		i++
		if i < len(tokens) && tokens[i].kind == registryWhereTokWord {
			switch strings.ToUpper(tokens[i].text) {
			case "ASC":
				i++
			case "DESC":
				order = "desc"
				i++
			}
		}
		sorts = append(sorts, gqlObject{{"path", []string{field.path}}, {"order", gqlEnum(order)}})
		if i < len(tokens) {
			if tokens[i].kind != registryWhereTokComma {
				return nil, registryWhereError(tokens[i].text)
			}
			i++
		}
	}
	return sorts, nil
}
