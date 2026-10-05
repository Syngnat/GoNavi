package sync

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func watermarkPositionColumns(plan watermarkRuntimePlan) []string {
	columns := make([]string, 0, len(plan.tieColumns)+1)
	columns = append(columns, plan.watermarkColumn)
	columns = append(columns, plan.tieColumns...)
	return columns
}

func watermarkPositionValues(cursor WatermarkCursor) []WatermarkCursorValue {
	values := make([]WatermarkCursorValue, 0, len(cursor.TieBreakers)+1)
	values = append(values, cursor.Watermark)
	values = append(values, cursor.TieBreakers...)
	return values
}

func buildWatermarkUpperBoundQuery(plan watermarkRuntimePlan) string {
	columns := watermarkPositionColumns(plan)
	selectList := make([]string, 0, len(columns))
	nonNull := make([]string, 0, len(columns))
	orderBy := make([]string, 0, len(columns))
	for _, column := range columns {
		quoted := quoteIdentByType(plan.sourceType, column)
		selectList = append(selectList, quoted)
		nonNull = append(nonNull, quoted+" IS NOT NULL")
		orderBy = append(orderBy, quoted+" DESC")
	}
	if normalizeMigrationDBType(plan.sourceType) == "sqlserver" {
		return fmt.Sprintf("SELECT TOP (1) %s FROM %s WHERE %s ORDER BY %s",
			strings.Join(selectList, ", "),
			quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
			strings.Join(nonNull, " AND "),
			strings.Join(orderBy, ", "))
	}
	return fmt.Sprintf("SELECT %s FROM %s WHERE %s ORDER BY %s LIMIT 1",
		strings.Join(selectList, ", "),
		quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
		strings.Join(nonNull, " AND "),
		strings.Join(orderBy, ", "))
}

func buildWatermarkPageQuery(plan watermarkRuntimePlan, lower *WatermarkCursor, upper WatermarkCursor) (string, error) {
	positionColumns := watermarkPositionColumns(plan)
	conditions := make([]string, 0, 3)
	for _, column := range positionColumns {
		conditions = append(conditions, quoteIdentByType(plan.sourceType, column)+" IS NOT NULL")
	}
	if lower != nil {
		predicate, err := buildWatermarkLexicographicPredicate(plan.sourceType, positionColumns, watermarkPositionValues(*lower), ">", false)
		if err != nil {
			return "", fmt.Errorf("构建 watermark 下界失败: %w", err)
		}
		conditions = append(conditions, predicate)
	}
	upperPredicate, err := buildWatermarkLexicographicPredicate(plan.sourceType, positionColumns, watermarkPositionValues(upper), "<", true)
	if err != nil {
		return "", fmt.Errorf("构建 watermark 上界失败: %w", err)
	}
	conditions = append(conditions, upperPredicate)

	selectList := buildColumnSelectListForSync(plan.sourceType, plan.sourceColumns)
	if strings.TrimSpace(selectList) == "" {
		return "", errors.New("watermark 源表没有可读取字段")
	}
	orderBy := make([]string, 0, len(positionColumns))
	for _, column := range positionColumns {
		orderBy = append(orderBy, quoteIdentByType(plan.sourceType, column)+" ASC")
	}
	if normalizeMigrationDBType(plan.sourceType) == "sqlserver" {
		return fmt.Sprintf("SELECT TOP (%d) %s FROM %s WHERE %s ORDER BY %s",
			plan.batchSize,
			selectList,
			quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
			strings.Join(conditions, " AND "),
			strings.Join(orderBy, ", ")), nil
	}
	return fmt.Sprintf("SELECT %s FROM %s WHERE %s ORDER BY %s LIMIT %d",
		selectList,
		quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
		strings.Join(conditions, " AND "),
		strings.Join(orderBy, ", "),
		plan.batchSize), nil
}

func buildWatermarkLexicographicPredicate(dbType string, columns []string, values []WatermarkCursorValue, comparator string, inclusive bool) (string, error) {
	if len(columns) == 0 || len(columns) != len(values) {
		return "", errors.New("复合 watermark 字段和值数量不一致")
	}
	if comparator != ">" && comparator != "<" {
		return "", fmt.Errorf("不支持的 watermark 比较符 %q", comparator)
	}
	literals := make([]string, len(values))
	for index, value := range values {
		literal, err := watermarkCursorSQLLiteral(dbType, value)
		if err != nil {
			return "", err
		}
		literals[index] = literal
	}
	clauses := make([]string, 0, len(columns))
	for index := range columns {
		parts := make([]string, 0, index+1)
		for prefix := 0; prefix < index; prefix++ {
			parts = append(parts, fmt.Sprintf("%s = %s", quoteIdentByType(dbType, columns[prefix]), literals[prefix]))
		}
		operator := comparator
		if inclusive && index == len(columns)-1 {
			operator += "="
		}
		parts = append(parts, fmt.Sprintf("%s %s %s", quoteIdentByType(dbType, columns[index]), operator, literals[index]))
		clauses = append(clauses, "("+strings.Join(parts, " AND ")+")")
	}
	return "(" + strings.Join(clauses, " OR ") + ")", nil
}

func watermarkCursorFromRow(plan watermarkRuntimePlan, row map[string]interface{}) (WatermarkCursor, error) {
	_, watermarkDefinition, exists := canonicalWatermarkColumn(plan.sourceColumns, plan.watermarkColumn)
	if !exists {
		return WatermarkCursor{}, fmt.Errorf("watermark 元数据缺少字段 %s", plan.watermarkColumn)
	}
	watermarkValue, err := watermarkValueFromRow(row, plan.watermarkColumn, watermarkDefinition)
	if err != nil {
		return WatermarkCursor{}, err
	}
	cursor := WatermarkCursor{
		Version:           WatermarkCursorVersion,
		SourceTable:       plan.sourceQueryTable,
		WatermarkColumn:   plan.watermarkColumn,
		TieBreakerColumns: append([]string(nil), plan.tieColumns...),
		Watermark:         watermarkValue,
		TieBreakers:       make([]WatermarkCursorValue, 0, len(plan.tieColumns)),
	}
	for _, column := range plan.tieColumns {
		_, definition, exists := canonicalWatermarkColumn(plan.sourceColumns, column)
		if !exists {
			return WatermarkCursor{}, fmt.Errorf("watermark 元数据缺少字段 %s", column)
		}
		value, err := watermarkValueFromRow(row, column, definition)
		if err != nil {
			return WatermarkCursor{}, err
		}
		cursor.TieBreakers = append(cursor.TieBreakers, value)
	}
	return cursor, nil
}

func watermarkValueFromRow(row map[string]interface{}, column string, definition connection.ColumnDefinition) (WatermarkCursorValue, error) {
	value, exists, ambiguous := lookupProjectionSourceValue(row, column)
	if ambiguous {
		return WatermarkCursorValue{}, fmt.Errorf("watermark 行包含多个大小写不一致的字段 %s", column)
	}
	if !exists {
		return WatermarkCursorValue{}, fmt.Errorf("watermark 行缺少字段 %s", column)
	}
	typed, err := watermarkCursorValueForColumn(value, definition)
	if err != nil {
		return WatermarkCursorValue{}, fmt.Errorf("watermark 字段 %s: %w", column, err)
	}
	return typed, nil
}

func watermarkCursorValueForColumn(value interface{}, definition connection.ColumnDefinition) (WatermarkCursorValue, error) {
	typeName := strings.ToLower(strings.TrimSpace(definition.Type))
	baseType := typeName
	if index := strings.IndexAny(baseType, "( "); index >= 0 {
		baseType = baseType[:index]
	}
	switch {
	case baseType == "date":
		parsed, err := projectionTime(value, SyncValueTransform{Type: "date"}, true)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "date", Value: parsed.Format("2006-01-02")}, nil
	case strings.Contains(baseType, "timestamp") || strings.Contains(baseType, "datetime"):
		parsed, err := watermarkTimestampValue(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "timestamp", Value: parsed.Format(time.RFC3339Nano)}, nil
	case watermarkIntegerColumnType(baseType):
		decimal, err := projectionDecimal(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		text := decimal.String()
		if strings.Contains(typeName, "unsigned") || strings.HasPrefix(baseType, "uint") {
			if _, err := strconv.ParseUint(text, 10, 64); err != nil {
				return WatermarkCursorValue{}, err
			}
			return WatermarkCursorValue{Type: "uint64", Value: text}, nil
		}
		if _, err := strconv.ParseInt(text, 10, 64); err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "int64", Value: text}, nil
	case watermarkDecimalColumnType(baseType):
		decimal, err := projectionDecimal(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "decimal", Value: decimal.String()}, nil
	case watermarkFloatColumnType(baseType):
		decimal, err := projectionDecimal(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		parsed, err := strconv.ParseFloat(decimal.String(), 64)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return finiteWatermarkFloat(parsed, 64)
	case baseType == "bool" || baseType == "boolean" || strings.HasPrefix(typeName, "bit(1") || strings.HasPrefix(typeName, "tinyint(1"):
		parsed, err := projectionBool(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "bool", Value: strconv.FormatBool(parsed)}, nil
	case watermarkBinaryColumnType(baseType):
		return watermarkBinaryCursorValue(value)
	default:
		return watermarkCursorValue(value)
	}
}

func watermarkTimestampValue(value interface{}) (time.Time, error) {
	switch typed := value.(type) {
	case time.Time:
		return typed, nil
	case []byte:
		return watermarkTimestampValue(string(typed))
	case string:
		text := strings.TrimSpace(typed)
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if parsed, err := time.Parse(layout, text); err == nil {
				return parsed, nil
			}
		}
		return parseProjectionTimeText(text, time.UTC)
	default:
		return time.Time{}, fmt.Errorf("无法把 %T 转为 timestamp watermark", value)
	}
}

func watermarkIntegerColumnType(baseType string) bool {
	switch baseType {
	case "int", "integer", "tinyint", "smallint", "mediumint", "bigint", "int2", "int4", "int8",
		"uint", "uint8", "uint16", "uint32", "uint64", "serial", "smallserial", "bigserial":
		return true
	default:
		return false
	}
}

func watermarkDecimalColumnType(baseType string) bool {
	switch baseType {
	case "decimal", "numeric", "number", "dec", "fixed", "money", "smallmoney":
		return true
	default:
		return false
	}
}

func watermarkFloatColumnType(baseType string) bool {
	switch baseType {
	case "float", "float4", "float8", "double", "real":
		return true
	default:
		return false
	}
}

func watermarkBinaryColumnType(baseType string) bool {
	switch baseType {
	case "binary", "varbinary", "blob", "bytea", "raw":
		return true
	default:
		return false
	}
}

func watermarkBinaryCursorValue(value interface{}) (WatermarkCursorValue, error) {
	var raw []byte
	switch typed := value.(type) {
	case []byte:
		raw = append([]byte(nil), typed...)
	case string:
		if strings.HasPrefix(strings.ToLower(typed), "0x") {
			decoded, err := hex.DecodeString(typed[2:])
			if err != nil {
				return WatermarkCursorValue{}, fmt.Errorf("无效二进制 watermark: %w", err)
			}
			raw = decoded
		} else {
			raw = []byte(typed)
		}
	default:
		return WatermarkCursorValue{}, fmt.Errorf("无法把 %T 转为二进制 watermark", value)
	}
	return WatermarkCursorValue{Type: "bytes", Value: base64.StdEncoding.EncodeToString(raw)}, nil
}
