package sync

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"time"
)

func validateWatermarkCursor(cursor WatermarkCursor, plan watermarkRuntimePlan) error {
	if cursor.Version != WatermarkCursorVersion {
		return fmt.Errorf("不支持的 watermark cursor 版本 %d", cursor.Version)
	}
	if !strings.EqualFold(strings.TrimSpace(cursor.SourceTable), strings.TrimSpace(plan.sourceQueryTable)) {
		return fmt.Errorf("watermark cursor 属于表 %s，当前表为 %s", cursor.SourceTable, plan.sourceQueryTable)
	}
	if !strings.EqualFold(strings.TrimSpace(cursor.WatermarkColumn), plan.watermarkColumn) {
		return fmt.Errorf("watermark cursor 字段 %s 与当前字段 %s 不一致", cursor.WatermarkColumn, plan.watermarkColumn)
	}
	if len(cursor.TieBreakerColumns) != len(plan.tieColumns) || len(cursor.TieBreakers) != len(plan.tieColumns) {
		return errors.New("watermark cursor tie-breaker 数量与当前配置不一致")
	}
	for index, column := range plan.tieColumns {
		if !strings.EqualFold(strings.TrimSpace(cursor.TieBreakerColumns[index]), column) {
			return fmt.Errorf("watermark cursor tie-breaker[%d] 与当前配置不一致", index)
		}
	}
	if _, err := watermarkCursorSQLLiteral(plan.sourceType, cursor.Watermark); err != nil {
		return fmt.Errorf("watermark cursor 水位值无效: %w", err)
	}
	for index, value := range cursor.TieBreakers {
		if _, err := watermarkCursorSQLLiteral(plan.sourceType, value); err != nil {
			return fmt.Errorf("watermark cursor tie-breaker[%d] 无效: %w", index, err)
		}
	}
	return nil
}

func compareWatermarkCursorPositions(left, right WatermarkCursor) (int, bool, error) {
	leftValues := watermarkPositionValues(left)
	rightValues := watermarkPositionValues(right)
	if len(leftValues) != len(rightValues) {
		return 0, false, errors.New("watermark cursor 复合位置长度不一致")
	}
	for index := range leftValues {
		comparison, comparable, err := compareWatermarkCursorValue(leftValues[index], rightValues[index])
		if err != nil {
			return 0, false, err
		}
		if !comparable {
			return 0, false, nil
		}
		if comparison != 0 {
			return comparison, true, nil
		}
	}
	return 0, true, nil
}

func compareWatermarkCursorValue(left, right WatermarkCursorValue) (int, bool, error) {
	leftType := strings.ToLower(strings.TrimSpace(left.Type))
	rightType := strings.ToLower(strings.TrimSpace(right.Type))
	if watermarkCursorNumericType(leftType) && watermarkCursorNumericType(rightType) {
		leftNumber, _, err := big.ParseFloat(left.Value, 10, 256, big.ToNearestEven)
		if err != nil {
			return 0, false, err
		}
		rightNumber, _, err := big.ParseFloat(right.Value, 10, 256, big.ToNearestEven)
		if err != nil {
			return 0, false, err
		}
		return leftNumber.Cmp(rightNumber), true, nil
	}
	if leftType == "timestamp" && rightType == "timestamp" {
		leftTime, err := time.Parse(time.RFC3339Nano, left.Value)
		if err != nil {
			return 0, false, err
		}
		rightTime, err := time.Parse(time.RFC3339Nano, right.Value)
		if err != nil {
			return 0, false, err
		}
		switch {
		case leftTime.Before(rightTime):
			return -1, true, nil
		case leftTime.After(rightTime):
			return 1, true, nil
		default:
			return 0, true, nil
		}
	}
	if leftType == "date" && rightType == "date" {
		leftTime, err := time.Parse("2006-01-02", left.Value)
		if err != nil {
			return 0, false, err
		}
		rightTime, err := time.Parse("2006-01-02", right.Value)
		if err != nil {
			return 0, false, err
		}
		switch {
		case leftTime.Before(rightTime):
			return -1, true, nil
		case leftTime.After(rightTime):
			return 1, true, nil
		default:
			return 0, true, nil
		}
	}
	if leftType == "bool" && rightType == "bool" {
		leftBool, err := strconv.ParseBool(left.Value)
		if err != nil {
			return 0, false, err
		}
		rightBool, err := strconv.ParseBool(right.Value)
		if err != nil {
			return 0, false, err
		}
		switch {
		case leftBool == rightBool:
			return 0, true, nil
		case !leftBool:
			return -1, true, nil
		default:
			return 1, true, nil
		}
	}
	// Text ordering is collation-dependent. Equality is safe to decide in Go;
	// unequal values fall back to one bounded SQL page instead of risking skips.
	if (leftType == "string" || leftType == "bytes") && (rightType == "string" || rightType == "bytes") {
		leftText, err := watermarkCursorText(left)
		if err != nil {
			return 0, false, err
		}
		rightText, err := watermarkCursorText(right)
		if err != nil {
			return 0, false, err
		}
		if leftText == rightText {
			return 0, true, nil
		}
		return 0, false, nil
	}
	return 0, false, nil
}

func watermarkCursorNumericType(valueType string) bool {
	switch valueType {
	case "int64", "uint64", "decimal", "float64":
		return true
	default:
		return false
	}
}

func watermarkCursorText(value WatermarkCursorValue) (string, error) {
	if strings.EqualFold(value.Type, "string") {
		return value.Value, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(value.Value)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func cloneWatermarkCursor(cursor *WatermarkCursor) *WatermarkCursor {
	if cursor == nil {
		return nil
	}
	cloned := *cursor
	cloned.TieBreakerColumns = append([]string(nil), cursor.TieBreakerColumns...)
	cloned.TieBreakers = append([]WatermarkCursorValue(nil), cursor.TieBreakers...)
	return &cloned
}

func watermarkCursorValue(value interface{}) (WatermarkCursorValue, error) {
	if value == nil {
		return WatermarkCursorValue{}, errors.New("watermark 游标字段不能为 NULL")
	}
	switch typed := value.(type) {
	case string:
		return WatermarkCursorValue{Type: "string", Value: typed}, nil
	case []byte:
		return WatermarkCursorValue{Type: "bytes", Value: base64.StdEncoding.EncodeToString(typed)}, nil
	case time.Time:
		return WatermarkCursorValue{Type: "timestamp", Value: typed.Format(time.RFC3339Nano)}, nil
	case json.Number:
		if !projectionDecimalPattern.MatchString(strings.TrimSpace(typed.String())) {
			return WatermarkCursorValue{}, errors.New("watermark decimal 值无效")
		}
		return WatermarkCursorValue{Type: "decimal", Value: strings.TrimSpace(typed.String())}, nil
	case bool:
		return WatermarkCursorValue{Type: "bool", Value: strconv.FormatBool(typed)}, nil
	case float32:
		return finiteWatermarkFloat(float64(typed), 32)
	case float64:
		return finiteWatermarkFloat(typed, 64)
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return WatermarkCursorValue{Type: "int64", Value: strconv.FormatInt(rv.Int(), 10)}, nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return WatermarkCursorValue{Type: "uint64", Value: strconv.FormatUint(rv.Uint(), 10)}, nil
	default:
		return WatermarkCursorValue{}, fmt.Errorf("watermark 游标不支持值类型 %T", value)
	}
}

func finiteWatermarkFloat(value float64, bitSize int) (WatermarkCursorValue, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return WatermarkCursorValue{}, errors.New("watermark 浮点游标不能是 NaN 或无穷大")
	}
	return WatermarkCursorValue{Type: "float64", Value: strconv.FormatFloat(value, 'g', -1, bitSize)}, nil
}

func watermarkCursorSQLLiteral(dbType string, value WatermarkCursorValue) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value.Type)) {
	case "string":
		return quoteSyncSQLString(dbType, value.Value), nil
	case "bytes":
		decoded, err := base64.StdEncoding.DecodeString(value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 bytes 游标: %w", err)
		}
		hexValue := hex.EncodeToString(decoded)
		switch normalizeMigrationDBType(dbType) {
		case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
			return "decode('" + hexValue + "', 'hex')", nil
		case "sqlserver":
			return "0x" + hexValue, nil
		case "duckdb":
			return "from_hex('" + hexValue + "')", nil
		default:
			return "X'" + hexValue + "'", nil
		}
	case "date":
		parsed, err := time.Parse("2006-01-02", value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 date 游标: %w", err)
		}
		return quoteSyncSQLString(dbType, parsed.Format("2006-01-02")), nil
	case "timestamp":
		parsed, err := time.Parse(time.RFC3339Nano, value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 timestamp 游标: %w", err)
		}
		formatted := parsed.Format(time.RFC3339Nano)
		if normalized := normalizeMigrationDBType(dbType); normalized == "mysql" || normalized == "mariadb" {
			formatted = parsed.Format("2006-01-02 15:04:05.999999999")
		}
		return quoteSyncSQLString(dbType, formatted), nil
	case "int64":
		if _, err := strconv.ParseInt(value.Value, 10, 64); err != nil {
			return "", fmt.Errorf("无效 int64 游标: %w", err)
		}
		return value.Value, nil
	case "uint64":
		if _, err := strconv.ParseUint(value.Value, 10, 64); err != nil {
			return "", fmt.Errorf("无效 uint64 游标: %w", err)
		}
		return value.Value, nil
	case "decimal":
		if !projectionDecimalPattern.MatchString(value.Value) {
			return "", errors.New("无效 decimal 游标")
		}
		return value.Value, nil
	case "float64":
		parsed, err := strconv.ParseFloat(value.Value, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return "", errors.New("无效 float64 游标")
		}
		return value.Value, nil
	case "bool":
		parsed, err := strconv.ParseBool(value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 bool 游标: %w", err)
		}
		if normalizeMigrationDBType(dbType) == "sqlserver" {
			if parsed {
				return "1", nil
			}
			return "0", nil
		}
		if parsed {
			return "TRUE", nil
		}
		return "FALSE", nil
	default:
		return "", fmt.Errorf("不支持的 watermark 游标类型 %q", value.Type)
	}
}
