package db

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type chromaParsedSQL struct {
	Collection        string
	Limit             int
	Offset            int
	Where             interface{}
	Count             bool
	IncludeEmbeddings bool
	WhereError        error
}

func parseChromaSQL(sqlText string) (chromaParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return chromaParsedSQL{}, false
	}
	table := parseSQLFromName(text)
	if table == "" {
		return chromaParsedSQL{}, false
	}
	parsed := chromaParsedSQL{Collection: table, Limit: 200}
	lower := strings.ToLower(text)
	parsed.Count = sqlContainsFunctionCall(sqlSelectProjection(text), "COUNT")
	parsed.IncludeEmbeddings = strings.Contains(lower, "embedding")
	whereExpr, _, whereErr := parseVectorSQLWhere(text)
	parsed.WhereError = whereErr
	if whereErr == nil && whereExpr != nil {
		parsed.Where = chromaWhereFromExpr(whereExpr)
	}
	if limit, ok := parseSQLLimitClause(text); ok {
		parsed.Limit = limit
	}
	if offset, ok := parseSQLUnsignedOffset(text); ok {
		parsed.Offset = offset
	}
	return parsed, true
}

func chromaGetResponseRows(resp chromaGetResponse) ([]map[string]interface{}, []string) {
	rows := make([]map[string]interface{}, 0, len(resp.IDs))
	for index, id := range resp.IDs {
		row := map[string]interface{}{"id": id}
		if value := sliceValue(resp.Documents, index); value != nil {
			row["document"] = value
		}
		if meta := sliceValueMap(resp.Metadatas, index); meta != nil {
			row["metadata"] = meta
			for k, v := range meta {
				row["metadata."+k] = v
			}
		}
		if value := sliceValue(resp.Embeddings, index); value != nil {
			row["embedding"] = normalizeJSONLikeValue(value)
		}
		rows = append(rows, row)
	}
	return rows, collectColumns(rows)
}

func chromaQueryResponseRows(raw map[string]interface{}) []map[string]interface{} {
	idGroups := nestedAnySlice(raw["ids"])
	docGroups := nestedAnySlice(raw["documents"])
	metaGroups := nestedAnySlice(raw["metadatas"])
	distanceGroups := nestedAnySlice(raw["distances"])
	var rows []map[string]interface{}
	for groupIndex, group := range idGroups {
		for itemIndex, id := range group {
			row := map[string]interface{}{
				"query_index": groupIndex,
				"id":          fmt.Sprintf("%v", id),
			}
			if doc := nestedValue(docGroups, groupIndex, itemIndex); doc != nil {
				row["document"] = doc
			}
			if dist := nestedValue(distanceGroups, groupIndex, itemIndex); dist != nil {
				row["distance"] = dist
			}
			if meta, ok := nestedValue(metaGroups, groupIndex, itemIndex).(map[string]interface{}); ok {
				row["metadata"] = meta
				for k, v := range meta {
					row["metadata."+k] = v
				}
			}
			rows = append(rows, row)
		}
	}
	return rows
}

func collectColumns(rows []map[string]interface{}) []string {
	set := make(map[string]struct{})
	for _, row := range rows {
		for key := range row {
			set[key] = struct{}{}
		}
	}
	cols := make([]string, 0, len(set))
	for key := range set {
		cols = append(cols, key)
	}
	sort.Strings(cols)
	for _, priority := range []string{"id", "query_index", "document", "distance", "metadata", "embedding"} {
		for i, col := range cols {
			if col == priority && i > 0 {
				cols = append(cols[:i], cols[i+1:]...)
				cols = append([]string{priority}, cols...)
				break
			}
		}
	}
	return cols
}

func tableNameOrDB(dbName, tableName string) string {
	if name := strings.TrimSpace(tableName); name != "" {
		return name
	}
	return strings.TrimSpace(dbName)
}

func chromaStructRow(col chromaCollection) map[string]interface{} {
	row := map[string]interface{}{
		"id":       col.ID,
		"name":     col.Name,
		"tenant":   col.Tenant,
		"database": col.Database,
	}
	if col.Dimension > 0 {
		row["dimension"] = col.Dimension
	}
	if len(col.Metadata) > 0 {
		row["metadata"] = col.Metadata
	}
	return row
}

func chromaCountValue(raw interface{}) int64 {
	switch v := raw.(type) {
	case json.Number:
		n, _ := v.Int64()
		return n
	case float64:
		return int64(v)
	case int:
		return int64(v)
	case int64:
		return v
	case map[string]interface{}:
		return chromaCountValue(firstExisting(v, "count", "total", "value"))
	default:
		return 0
	}
}

func chromaRowID(row map[string]interface{}) string {
	raw := firstExisting(row, "id", "_id")
	if raw == nil {
		return ""
	}
	text := strings.TrimSpace(fmt.Sprintf("%v", raw))
	if text == "" || text == "<nil>" {
		return ""
	}
	return text
}

func isChromaReservedRowField(key string) bool {
	switch key {
	case "id", "_id", "document", "_document", "documents", "metadata", "embedding", "_embedding", "embeddings":
		return true
	default:
		return false
	}
}

func normalizeChromaEmbedding(value interface{}) interface{} {
	if text, ok := value.(string); ok {
		var parsed interface{}
		if err := decodeJSONWithUseNumber([]byte(text), &parsed); err == nil {
			return parsed
		}
	}
	return value
}

func inferChromaValueType(value interface{}) string {
	switch value.(type) {
	case bool:
		return "bool"
	case json.Number, float64, float32, int, int64:
		return "number"
	case map[string]interface{}:
		return "json"
	case []interface{}:
		return "array"
	default:
		return "string"
	}
}

func firstStringValue(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := m[key]; ok {
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

func firstExisting(m map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value, ok := m[key]; ok {
			return value
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if text := strings.TrimSpace(value); text != "" {
			return text
		}
	}
	return ""
}

func hasAnyKey(m map[string]interface{}, keys ...string) bool {
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}

func getOrBool(m map[string]interface{}, keys ...string) bool {
	for _, key := range keys {
		switch v := m[key].(type) {
		case bool:
			return v
		case string:
			return strings.EqualFold(strings.TrimSpace(v), "true")
		}
	}
	return false
}

func intFromAny(value interface{}, fallback int) int {
	switch v := value.(type) {
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return int(n)
		}
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err == nil {
			return n
		}
	}
	return fallback
}

func mapString(m map[string]interface{}, key string) string {
	return strings.TrimSpace(fmt.Sprintf("%v", m[key]))
}

func stringSliceFromAny(value interface{}, fallback []string) []string {
	if value == nil {
		return fallback
	}
	switch v := value.(type) {
	case []string:
		return v
	case []interface{}:
		result := make([]string, 0, len(v))
		for _, item := range v {
			if text := strings.TrimSpace(fmt.Sprintf("%v", item)); text != "" {
				result = append(result, text)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return fallback
}

func anySlice(value interface{}) []interface{} {
	switch v := value.(type) {
	case []interface{}:
		return v
	case []string:
		result := make([]interface{}, len(v))
		for i, item := range v {
			result[i] = item
		}
		return result
	default:
		return nil
	}
}

func nestedAnySlice(value interface{}) [][]interface{} {
	switch v := value.(type) {
	case []interface{}:
		result := make([][]interface{}, 0, len(v))
		for _, group := range v {
			result = append(result, anySlice(group))
		}
		return result
	default:
		return nil
	}
}

func nestedValue(groups [][]interface{}, groupIndex, itemIndex int) interface{} {
	if groupIndex < 0 || groupIndex >= len(groups) {
		return nil
	}
	group := groups[groupIndex]
	if itemIndex < 0 || itemIndex >= len(group) {
		return nil
	}
	return group[itemIndex]
}

func sliceValue(items []interface{}, index int) interface{} {
	if index < 0 || index >= len(items) {
		return nil
	}
	return normalizeJSONLikeValue(items[index])
}

func sliceValueMap(items []map[string]interface{}, index int) map[string]interface{} {
	if index < 0 || index >= len(items) {
		return nil
	}
	return items[index]
}

func normalizeJSONLikeValue(value interface{}) interface{} {
	switch value.(type) {
	case map[string]interface{}, []interface{}:
		payload, err := json.Marshal(value)
		if err == nil {
			return string(payload)
		}
	}
	return value
}
