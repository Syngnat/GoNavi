package db

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type milvusParsedSQL struct {
	Collection   string
	Filter       string
	OutputFields []string
	Limit        int
	Offset       int
	Count        bool
}

var (
	milvusSQLFromRE   = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))`)
	milvusSQLSelectRE = regexp.MustCompile(`(?is)^\s*SELECT\s+(.+?)\s+FROM\s+`)
	milvusSQLLimitRE  = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	milvusSQLOffsetRE = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	milvusSQLWhereRE  = regexp.MustCompile(`(?is)\bWHERE\s+(.+?)(?:\s+\bLIMIT\b|\s+\bOFFSET\b|\s*;?\s*$)`)
)

func parseMilvusSQL(sqlText string) (milvusParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return milvusParsedSQL{}, false
	}
	matches := milvusSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return milvusParsedSQL{}, false
	}
	collection := firstNonEmpty(matches[1], matches[2], matches[3])
	if collection == "" {
		return milvusParsedSQL{}, false
	}
	parsed := milvusParsedSQL{Collection: collection, Limit: 200, OutputFields: []string{"*"}}
	if fieldsMatch := milvusSQLSelectRE.FindStringSubmatch(text); len(fieldsMatch) > 1 {
		parsed.OutputFields = milvusOutputFields(fieldsMatch[1])
		parsed.Count = strings.Contains(strings.ToLower(fieldsMatch[1]), "count(")
	}
	if match := milvusSQLLimitRE.FindStringSubmatch(text); len(match) > 1 {
		parsed.Limit, _ = strconv.Atoi(match[1])
	}
	if match := milvusSQLOffsetRE.FindStringSubmatch(text); len(match) > 1 {
		parsed.Offset, _ = strconv.Atoi(match[1])
	}
	if match := milvusSQLWhereRE.FindStringSubmatch(text); len(match) > 1 {
		parsed.Filter = strings.TrimSpace(match[1])
	}
	return parsed, true
}

func milvusOutputFields(raw string) []string {
	text := strings.TrimSpace(raw)
	if text == "" || text == "*" || strings.Contains(strings.ToLower(text), "count(") {
		return []string{"*"}
	}
	parts := strings.Split(text, ",")
	fields := make([]string, 0, len(parts))
	for _, part := range parts {
		field := strings.Trim(strings.TrimSpace(part), "`\"")
		if field == "" {
			continue
		}
		if aliasIndex := strings.Index(strings.ToLower(field), " as "); aliasIndex >= 0 {
			field = strings.TrimSpace(field[:aliasIndex])
		}
		fields = append(fields, field)
	}
	if len(fields) == 0 {
		return []string{"*"}
	}
	return fields
}

func milvusNamesFromValue(value interface{}, keys ...string) []string {
	if values := anySlice(value); len(values) > 0 {
		return milvusSortedUniqueNames(values)
	}
	if item, ok := value.(map[string]interface{}); ok {
		for _, key := range keys {
			if names := milvusNamesFromValue(item[key]); len(names) > 0 {
				return names
			}
		}
	}
	return []string{}
}

func milvusSortedUniqueNames(values []interface{}) []string {
	seen := make(map[string]struct{}, len(values))
	names := make([]string, 0, len(values))
	for _, value := range values {
		name := strings.TrimSpace(fmt.Sprintf("%v", value))
		if item, ok := value.(map[string]interface{}); ok {
			name = firstStringValue(item, "name", "collectionName", "dbName")
		}
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func milvusMapSlice(value interface{}) []map[string]interface{} {
	items := anySlice(value)
	result := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		if row, ok := item.(map[string]interface{}); ok {
			result = append(result, row)
		}
	}
	return result
}

func milvusRowsFromValue(value interface{}) []map[string]interface{} {
	if rows := milvusMapSlice(value); len(rows) > 0 {
		return rows
	}
	if item, ok := value.(map[string]interface{}); ok {
		for _, key := range []string{"data", "results", "entities"} {
			if rows := milvusRowsFromValue(item[key]); len(rows) > 0 {
				return rows
			}
		}
		if len(item) > 0 {
			return []map[string]interface{}{item}
		}
	}
	return []map[string]interface{}{}
}

func milvusCommandRows(cmd map[string]interface{}) []map[string]interface{} {
	return milvusMapSlice(firstExisting(cmd, "data", "rows", "entities"))
}

func milvusSearchData(cmd map[string]interface{}) []interface{} {
	if data := anySlice(firstExisting(cmd, "data")); len(data) > 0 {
		return data
	}
	vector := firstExisting(cmd, "vector", "query_vector", "queryVector", "embedding")
	if vector == nil {
		return nil
	}
	values := anySlice(vector)
	if len(values) == 0 {
		return nil
	}
	if _, nested := values[0].([]interface{}); nested {
		return values
	}
	return []interface{}{values}
}

func milvusCountValue(value interface{}) int64 {
	switch typed := value.(type) {
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			return parsed
		}
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil {
			return parsed
		}
	}
	return 0
}

func milvusBoolValue(value interface{}, fallback bool) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
		if err == nil {
			return parsed
		}
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil {
			return parsed != 0
		}
	case float64:
		return typed != 0
	case int:
		return typed != 0
	}
	return fallback
}

func milvusRowIDs(rows []map[string]interface{}, primaryField string) []interface{} {
	ids := make([]interface{}, 0, len(rows))
	for _, row := range rows {
		if id, ok := milvusRowID(row, primaryField); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

func milvusRowID(row map[string]interface{}, primaryField string) (interface{}, bool) {
	value := firstExisting(row, primaryField)
	if value == nil && primaryField != "id" {
		value = firstExisting(row, "id", "_id")
	}
	if value == nil || strings.TrimSpace(fmt.Sprintf("%v", value)) == "" {
		return nil, false
	}
	return value, true
}

func milvusIDFilterWithType(primaryField, primaryType string, ids []interface{}) (string, error) {
	literals := make([]string, 0, len(ids))
	for _, id := range ids {
		literal, err := milvusFilterLiteralWithType(id, primaryType)
		if err != nil {
			return "", fmt.Errorf("Milvus primary key %q value %v is invalid for %s: %w", primaryField, id, primaryType, err)
		}
		literals = append(literals, literal)
	}
	return fmt.Sprintf("%s in [%s]", strings.TrimSpace(primaryField), strings.Join(literals, ", ")), nil
}

func milvusFilterLiteral(value interface{}) string {
	switch typed := value.(type) {
	case json.Number:
		return typed.String()
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", typed)
	case bool:
		return strconv.FormatBool(typed)
	default:
		encoded, err := json.Marshal(fmt.Sprintf("%v", value))
		if err != nil {
			return "\"\""
		}
		return string(encoded)
	}
}

func milvusFilterLiteralWithType(value interface{}, fieldType string) (string, error) {
	if !isMilvusInt64Type(fieldType) {
		return milvusFilterLiteral(value), nil
	}

	text := strings.TrimSpace(fmt.Sprintf("%v", value))
	if text == "" || text == "<nil>" {
		return "", fmt.Errorf("expected a non-empty Int64 value")
	}
	parsed, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return "", fmt.Errorf("expected a decimal Int64 value, got %q", text)
	}
	return strconv.FormatInt(parsed, 10), nil
}

func isMilvusInt64Type(fieldType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(fieldType))
	return normalized == "int64" || normalized == "datatype.int64" || normalized == "5"
}
