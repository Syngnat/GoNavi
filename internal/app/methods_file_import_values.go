package app

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func normalizeColumnName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func buildImportColumnTypeMap(defs []connection.ColumnDefinition) map[string]string {
	result := make(map[string]string, len(defs))
	for _, def := range defs {
		key := normalizeColumnName(def.Name)
		if key == "" {
			continue
		}
		result[key] = strings.TrimSpace(def.Type)
	}
	return result
}

func isTimezoneAwareColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	return strings.Contains(typ, "with time zone") ||
		strings.Contains(typ, "with timezone") ||
		strings.Contains(typ, "datetimeoffset") ||
		strings.Contains(typ, "timestamptz")
}

func isDateTimeColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	return strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") || strings.Contains(typ, "timestamptz")
}

func isTimeOnlyColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	if strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") {
		return false
	}
	return strings.Contains(typ, "time") || strings.Contains(typ, "timetz")
}

func isDateOnlyColumnType(dbType, columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	if strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") || strings.Contains(typ, "time") {
		return false
	}
	if !strings.Contains(typ, "date") {
		return false
	}
	db := strings.ToLower(strings.TrimSpace(dbType))
	// Oracle/Dameng 的 DATE 带时间语义，不能按纯日期裁剪。
	return db != "oracle" && db != "dameng"
}

func isTemporalColumnType(dbType, columnType string) bool {
	return isDateTimeColumnType(columnType) || isTimeOnlyColumnType(columnType) || isDateOnlyColumnType(dbType, columnType)
}

func parseTemporalString(raw string) (time.Time, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return time.Time{}, false
	}

	layoutsWithZone := []string{
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05.999999999 -0700",
		"2006-01-02 15:04:05 -0700",
		time.RFC3339Nano,
		time.RFC3339,
	}

	for _, layout := range layoutsWithZone {
		parsed, err := time.Parse(layout, text)
		if err == nil {
			return parsed, true
		}
	}

	layoutsWithoutZone := []string{
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"15:04:05.999999999",
		"15:04:05",
	}

	for _, layout := range layoutsWithoutZone {
		parsed, err := time.ParseInLocation(layout, text, time.Local)
		if err == nil {
			return parsed, true
		}
	}

	return time.Time{}, false
}

func looksLikeTemporalText(raw string) bool {
	text := strings.TrimSpace(raw)
	if text == "" {
		return false
	}

	if len(text) >= 10 &&
		isDigit(text[0]) &&
		isDigit(text[1]) &&
		isDigit(text[2]) &&
		isDigit(text[3]) &&
		text[4] == '-' &&
		isDigit(text[5]) &&
		isDigit(text[6]) &&
		text[7] == '-' &&
		isDigit(text[8]) &&
		isDigit(text[9]) {
		return true
	}

	if len(text) >= 8 &&
		isDigit(text[0]) &&
		isDigit(text[1]) &&
		text[2] == ':' &&
		isDigit(text[3]) &&
		isDigit(text[4]) &&
		text[5] == ':' &&
		isDigit(text[6]) &&
		isDigit(text[7]) {
		return true
	}

	return false
}

func isDigit(ch byte) bool {
	return ch >= '0' && ch <= '9'
}

func normalizeExportTemporalText(text string) string {
	if !looksLikeTemporalText(text) {
		return text
	}
	if parsed, ok := parseTemporalString(text); ok {
		return parsed.Format("2006-01-02 15:04:05")
	}
	return text
}

func importTemporalFractionDigits(raw string) int {
	text := strings.TrimSpace(raw)
	for index := 0; index+8 < len(text); index++ {
		if !isDigit(text[index]) || !isDigit(text[index+1]) || text[index+2] != ':' ||
			!isDigit(text[index+3]) || !isDigit(text[index+4]) || text[index+5] != ':' ||
			!isDigit(text[index+6]) || !isDigit(text[index+7]) || text[index+8] != '.' {
			continue
		}
		digits := 0
		for cursor := index + 9; cursor < len(text) && isDigit(text[cursor]) && digits < 9; cursor++ {
			digits++
		}
		return digits
	}
	return 0
}

func importTemporalLayout(base string, fractionDigits int) string {
	if fractionDigits <= 0 {
		return base
	}
	return base + "." + strings.Repeat("0", fractionDigits)
}

func normalizeImportTemporalValue(dbType, columnType, raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return text
	}

	parsed, ok := parseTemporalString(text)
	if !ok {
		if isDateTimeColumnType(columnType) {
			candidate := strings.ReplaceAll(text, "T", " ")
			if len(candidate) >= 19 {
				prefix := candidate[:19]
				if _, err := time.Parse("2006-01-02 15:04:05", prefix); err == nil {
					return prefix
				}
			}
		}
		return text
	}

	fractionDigits := importTemporalFractionDigits(text)
	if isTimeOnlyColumnType(columnType) {
		return parsed.Format(importTemporalLayout("15:04:05", fractionDigits))
	}
	if isDateOnlyColumnType(dbType, columnType) {
		return parsed.Format("2006-01-02")
	}
	if isTimezoneAwareColumnType(columnType) {
		return parsed.Format(importTemporalLayout("2006-01-02 15:04:05", fractionDigits) + "-07:00")
	}
	return parsed.Format(importTemporalLayout("2006-01-02 15:04:05", fractionDigits))
}

func isPgLikeBooleanDBType(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "postgres", "postgresql", "pg", "pq", "pgx", "kingbase", "kingbase8", "kingbasees", "kingbasev8", "highgo", "vastbase", "opengauss", "open_gauss", "open-gauss", "gaussdb", "gauss_db", "gauss-db":
		return true
	default:
		return registryUsesBooleanKeywords(dbType)
	}
}

func isBooleanColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	typ = strings.ReplaceAll(typ, `"`, "")
	if idx := strings.IndexAny(typ, " ("); idx >= 0 {
		typ = typ[:idx]
	}
	typ = strings.TrimPrefix(typ, "pg_catalog.")
	return typ == "bool" || typ == "boolean"
}

func booleanSQLLiteral(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func formatSignedBooleanSQLValue(v int64) (string, bool) {
	switch v {
	case 0:
		return "false", true
	case 1:
		return "true", true
	default:
		return "", false
	}
}

func formatUnsignedBooleanSQLValue(v uint64) (string, bool) {
	switch v {
	case 0:
		return "false", true
	case 1:
		return "true", true
	default:
		return "", false
	}
}

func formatFloatBooleanSQLValue(v float64) (string, bool) {
	if v == 0 {
		return "false", true
	}
	if v == 1 {
		return "true", true
	}
	return "", false
}

func formatBooleanStringSQLValue(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "t", "1", "yes", "y", "on":
		return "true", true
	case "false", "f", "0", "no", "n", "off":
		return "false", true
	default:
		return "", false
	}
}

func formatPostgresBooleanSQLValue(value interface{}) (string, bool) {
	switch val := value.(type) {
	case bool:
		return booleanSQLLiteral(val), true
	case int:
		return formatSignedBooleanSQLValue(int64(val))
	case int8:
		return formatSignedBooleanSQLValue(int64(val))
	case int16:
		return formatSignedBooleanSQLValue(int64(val))
	case int32:
		return formatSignedBooleanSQLValue(int64(val))
	case int64:
		return formatSignedBooleanSQLValue(val)
	case uint:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint8:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint16:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint32:
		return formatUnsignedBooleanSQLValue(uint64(val))
	case uint64:
		return formatUnsignedBooleanSQLValue(val)
	case float32:
		return formatFloatBooleanSQLValue(float64(val))
	case float64:
		return formatFloatBooleanSQLValue(val)
	case []byte:
		if len(val) == 1 && (val[0] == 0 || val[0] == 1) {
			return booleanSQLLiteral(val[0] == 1), true
		}
		return formatBooleanStringSQLValue(string(val))
	case string:
		return formatBooleanStringSQLValue(val)
	default:
		return "", false
	}
}

func formatImportSQLValue(dbType, columnType string, value interface{}) string {
	if value == nil {
		return "NULL"
	}
	if literal, ok := formatImportCompositeJSONSQLValue(dbType, value); ok {
		return literal
	}
	if literal, ok := formatOracleTemporalSQLValue(dbType, columnType, value); ok {
		return literal
	}

	if isPgLikeBooleanDBType(dbType) && isBooleanColumnType(columnType) {
		if literal, ok := formatPostgresBooleanSQLValue(value); ok {
			return literal
		}
	}

	if isTemporalColumnType(dbType, columnType) {
		normalized := normalizeImportTemporalValue(dbType, columnType, fmt.Sprintf("%v", value))
		return "'" + escapeSQLStringLiteralBody(dbType, normalized) + "'"
	}
	if text, ok := value.(string); ok {
		return "'" + escapeSQLStringLiteralBody(dbType, text) + "'"
	}

	return formatSQLValue(dbType, value)
}

func formatImportCompositeJSONSQLValue(dbType string, value interface{}) (string, bool) {
	if _, rawBytes := value.([]byte); rawBytes {
		return "", false
	}
	valueType := reflect.TypeOf(value)
	if valueType == nil {
		return "", false
	}
	switch valueType.Kind() {
	case reflect.Map, reflect.Slice, reflect.Array:
		encoded, err := json.Marshal(value)
		if err != nil {
			return "NULL", true
		}
		return "'" + escapeSQLStringLiteralBody(dbType, string(encoded)) + "'", true
	default:
		return "", false
	}
}
