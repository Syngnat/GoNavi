package db

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

type qdrantParsedSQL struct {
	Collection    string
	Limit         int
	Offset        interface{}
	Count         bool
	IncludeVector bool
	Filter        interface{}
	WhereError    error
}

func parseQdrantSQL(sqlText string) (qdrantParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return qdrantParsedSQL{}, false
	}
	collection := parseSQLFromName(text)
	if collection == "" {
		return qdrantParsedSQL{}, false
	}
	parsed := qdrantParsedSQL{Collection: collection, Limit: 200}
	lower := strings.ToLower(text)
	parsed.Count = sqlContainsFunctionCall(sqlSelectProjection(text), "COUNT")
	parsed.IncludeVector = strings.Contains(lower, "vector")
	whereExpr, _, whereErr := parseVectorSQLWhere(text)
	if whereErr == nil {
		whereErr = validateQdrantWhereExpr(whereExpr)
	}
	parsed.WhereError = whereErr
	if whereErr == nil && whereExpr != nil {
		parsed.Filter = qdrantFilterFromExpr(whereExpr)
	}
	if limit, ok := parseSQLLimitClause(text); ok {
		parsed.Limit = limit
	}
	if offset, ok := parseSQLOffsetToken(text); ok {
		parsed.Offset = qdrantNormalizePointID(offset)
	}
	return parsed, true
}

func qdrantPointRows(points []qdrantPoint) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(points))
	for _, point := range points {
		row := map[string]interface{}{"id": point.ID}
		if point.Score != nil {
			row["score"] = point.Score
		}
		if point.Version != nil {
			row["version"] = point.Version
		}
		if point.Vector != nil {
			row["vector"] = normalizeJSONLikeValue(point.Vector)
		}
		if point.Payload != nil {
			row["payload"] = point.Payload
			for key, value := range point.Payload {
				row["payload."+key] = value
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func qdrantRowID(row map[string]interface{}) (interface{}, bool) {
	raw := firstExisting(row, "id", "_id")
	if raw == nil {
		return nil, false
	}
	text := strings.TrimSpace(fmt.Sprintf("%v", raw))
	if text == "" || text == "<nil>" {
		return nil, false
	}
	return qdrantNormalizePointID(raw), true
}

func qdrantNormalizePointID(value interface{}) interface{} {
	switch v := value.(type) {
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return n
		}
	case float64:
		if v == float64(int64(v)) {
			return int64(v)
		}
	case float32:
		if v == float32(int64(v)) {
			return int64(v)
		}
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return v
	case string:
		text := strings.TrimSpace(v)
		if n, err := strconv.ParseInt(text, 10, 64); err == nil {
			return n
		}
		return text
	}
	return value
}

func qdrantPointIDSlice(value interface{}) []interface{} {
	items := anySlice(value)
	result := make([]interface{}, 0, len(items))
	for _, item := range items {
		result = append(result, qdrantNormalizePointID(item))
	}
	return result
}

func qdrantRowVector(row map[string]interface{}) (interface{}, bool) {
	vector := firstExisting(row, "vector", "_vector", "vectors", "embedding", "_embedding")
	if vector == nil {
		return nil, false
	}
	return normalizeQdrantVector(vector), true
}

func normalizeQdrantVector(value interface{}) interface{} {
	if text, ok := value.(string); ok {
		var parsed interface{}
		if err := decodeJSONWithUseNumber([]byte(text), &parsed); err == nil {
			return parsed
		}
	}
	return value
}

func qdrantPayloadFromRow(row map[string]interface{}) map[string]interface{} {
	payload := make(map[string]interface{})
	if raw, ok := row["payload"].(map[string]interface{}); ok {
		for key, value := range raw {
			payload[key] = value
		}
	}
	for key, value := range row {
		if isQdrantReservedRowField(key) {
			continue
		}
		if strings.HasPrefix(key, "payload.") {
			payload[strings.TrimPrefix(key, "payload.")] = value
			continue
		}
		payload[key] = value
	}
	return payload
}

func isQdrantReservedRowField(key string) bool {
	switch key {
	case "id", "_id", "vector", "_vector", "vectors", "embedding", "_embedding", "payload", "score", "version", "next_page_offset":
		return true
	default:
		return false
	}
}

func qdrantBoolValue(value interface{}, fallback bool) bool {
	if value == nil {
		return fallback
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		text := strings.TrimSpace(strings.ToLower(v))
		if text == "" {
			return fallback
		}
		return text == "1" || text == "true" || text == "yes" || text == "on"
	default:
		return fallback
	}
}

func qdrantVectorIndexes(info map[string]interface{}) []connection.IndexDefinition {
	vectors := nestedMapValue(info, "config", "params", "vectors")
	if len(vectors) == 0 {
		return nil
	}
	if _, ok := vectors["size"]; ok {
		return []connection.IndexDefinition{{Name: "VECTOR", ColumnName: "vector", NonUnique: 1, SeqInIndex: 1, IndexType: "VECTOR"}}
	}
	var indexes []connection.IndexDefinition
	names := make([]string, 0, len(vectors))
	for name := range vectors {
		names = append(names, name)
	}
	sort.Strings(names)
	for index, name := range names {
		indexes = append(indexes, connection.IndexDefinition{
			Name:       "VECTOR_" + name,
			ColumnName: "vector." + name,
			NonUnique:  1,
			SeqInIndex: index + 1,
			IndexType:  "VECTOR",
		})
	}
	return indexes
}

func qdrantPayloadIndexes(info map[string]interface{}) []connection.IndexDefinition {
	schema := nestedMapValue(info, "payload_schema")
	if len(schema) == 0 {
		schema = nestedMapValue(info, "payload_schema", "schema")
	}
	if len(schema) == 0 {
		return nil
	}
	names := make([]string, 0, len(schema))
	for name := range schema {
		names = append(names, name)
	}
	sort.Strings(names)
	indexes := make([]connection.IndexDefinition, 0, len(names))
	for index, name := range names {
		indexes = append(indexes, connection.IndexDefinition{
			Name:       "PAYLOAD_" + name,
			ColumnName: "payload." + name,
			NonUnique:  1,
			SeqInIndex: index + 1,
			IndexType:  "PAYLOAD",
		})
	}
	return indexes
}

func qdrantPayloadSchemaColumns(info map[string]interface{}) []connection.ColumnDefinition {
	schema := nestedMapValue(info, "payload_schema")
	if len(schema) == 0 {
		schema = nestedMapValue(info, "payload_schema", "schema")
	}
	if len(schema) == 0 {
		return nil
	}
	names := make([]string, 0, len(schema))
	for name := range schema {
		if strings.TrimSpace(name) != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	columns := make([]connection.ColumnDefinition, 0, len(names))
	for _, name := range names {
		fieldType := "json"
		if definition, ok := schema[name].(map[string]interface{}); ok {
			if dataType := strings.TrimSpace(mapString(definition, "data_type")); dataType != "" {
				fieldType = dataType
			}
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     "payload." + name,
			Type:     fieldType,
			Nullable: "YES",
			Comment:  "Payload schema field",
		})
	}
	return columns
}

func nestedMapValue(value interface{}, path ...string) map[string]interface{} {
	current := value
	for _, key := range path {
		m, ok := current.(map[string]interface{})
		if !ok {
			return nil
		}
		current = m[key]
	}
	if m, ok := current.(map[string]interface{}); ok {
		return m
	}
	return nil
}
