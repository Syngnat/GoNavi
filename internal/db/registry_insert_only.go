package db

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

// insertOnlyDialect 描述只支持追加写入的库（QuestDB、GreptimeDB）怎样拼 INSERT：
// 这类库没有可定位单行的主键或不支持 UPDATE，表格编辑只开放新增（导入数据、跨库迁移都只追加行）。
type insertOnlyDialect struct {
	quoteTable func(tableName string) string
	quoteIdent func(name string) string
	// escapeBackslash 为 true 时字符串里的反斜杠按转义符处理（MySQL 协议的 GreptimeDB）。
	escapeBackslash bool
	// rowsPerStatement 是一条 INSERT 携带的最大行数；1 表示逐行写入。
	rowsPerStatement int
}

// applyInsertOnlyChanges 把新增行写成带类型字面量的 INSERT；有修改或删除时返回 rejectErr。
// 值按目标列类型输出：数值列的数字文本不加引号、布尔列输出 TRUE / FALSE，其余按字符串字面量交给库转换
// （时间列接受 ISO 文本）。没有写列名的行（全部为空）跳过。
func applyInsertOnlyChanges(
	ctx context.Context,
	exec func(context.Context, string) (int64, error),
	columns []connection.ColumnDefinition,
	tableName string,
	changes connection.ChangeSet,
	dialect insertOnlyDialect,
	rejectErr error,
) error {
	if len(changes.Updates) > 0 || len(changes.Deletes) > 0 {
		return rejectErr
	}
	if len(changes.Inserts) == 0 {
		return nil
	}
	types := make(map[string]string, len(columns))
	for _, column := range columns {
		types[strings.ToLower(strings.TrimSpace(column.Name))] = strings.ToLower(strings.TrimSpace(column.Type))
	}
	perStatement := dialect.rowsPerStatement
	if perStatement <= 0 {
		perStatement = 1
	}
	table := dialect.quoteTable(tableName)
	var pendingColumns string
	var pending []string
	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		statement := "INSERT INTO " + table + " (" + pendingColumns + ") VALUES " + strings.Join(pending, ", ")
		pending = pending[:0]
		if _, err := exec(ctx, statement); err != nil {
			return err
		}
		return nil
	}
	for _, row := range changes.Inserts {
		names := make([]string, 0, len(row))
		for name := range row {
			if strings.TrimSpace(name) != "" {
				names = append(names, name)
			}
		}
		if len(names) == 0 {
			continue
		}
		sort.Strings(names)
		quoted := make([]string, len(names))
		values := make([]string, len(names))
		for i, name := range names {
			quoted[i] = dialect.quoteIdent(name)
			values[i] = insertOnlyLiteral(row[name], types[strings.ToLower(strings.TrimSpace(name))], dialect.escapeBackslash)
		}
		columnList := strings.Join(quoted, ", ")
		if columnList != pendingColumns || len(pending) >= perStatement {
			if err := flush(); err != nil {
				return err
			}
			pendingColumns = columnList
		}
		pending = append(pending, "("+strings.Join(values, ", ")+")")
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	return flush()
}

// insertOnlyLiteral 按列类型把值写成 SQL 字面量。
func insertOnlyLiteral(value interface{}, columnType string, escapeBackslash bool) string {
	quote := func(text string) string {
		if escapeBackslash {
			text = strings.ReplaceAll(text, `\`, `\\`)
		}
		return "'" + strings.ReplaceAll(text, "'", "''") + "'"
	}
	switch v := value.(type) {
	case nil:
		return "NULL"
	case bool:
		if v {
			return "TRUE"
		}
		return "FALSE"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", v)
	case float32:
		return insertOnlyFloat(float64(v))
	case float64:
		return insertOnlyFloat(v)
	case json.Number:
		if _, err := strconv.ParseFloat(v.String(), 64); err == nil {
			return v.String()
		}
		return quote(v.String())
	case time.Time:
		return quote(v.UTC().Format("2006-01-02T15:04:05.000000Z"))
	case []byte:
		return quote(string(v))
	case string:
		text := strings.TrimSpace(v)
		switch {
		case insertOnlyNumericType(columnType):
			if _, err := strconv.ParseFloat(text, 64); err == nil && text != "" {
				return text
			}
		case strings.Contains(columnType, "bool"):
			switch strings.ToLower(text) {
			case "true", "t", "1", "yes", "y":
				return "TRUE"
			case "false", "f", "0", "no", "n":
				return "FALSE"
			}
		}
		return quote(v)
	default:
		return quote(fmt.Sprintf("%v", v))
	}
}

func insertOnlyFloat(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "NULL"
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// insertOnlyNumericType 识别 QuestDB（int / long / short / byte / double / float）与
// GreptimeDB（Int64、UInt32、Float64、Decimal…）的数值列类型。
func insertOnlyNumericType(columnType string) bool {
	for _, token := range []string{"int", "long", "short", "byte", "double", "float", "decimal", "numeric"} {
		if strings.Contains(columnType, token) {
			return !strings.Contains(columnType, "interval")
		}
	}
	return false
}
