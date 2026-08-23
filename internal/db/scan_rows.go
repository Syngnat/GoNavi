package db

import (
	"database/sql"
	"fmt"
	"runtime"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
)

// streamRowsPeriodicGCInterval 控制 streamRowsForDialect 每处理多少行主动触发一次 runtime.GC。
//
// 背景：大结果集（88W+ 行）流式扫描时，每行 scanner 会分配 []interface{} 和 map[string]interface{}，
// Go 默认 GOGC=100 下堆翻倍才触发 GC，瞬时峰值可达数据总量 5-8 倍。
// 这里周期性主动 GC，让内存在扫描过程中及时回收，避免 RSS 单调爬升。
//
// 取值 50000：每 5W 行触发一次 GC，对 88W 行导出场景约触发 18 次，CPU 开销可忽略；
// 同时保证单次 GC 之间累积的临时对象不超过几百 MB，避免 GC 间隙堆膨胀。
const streamRowsPeriodicGCInterval = 50000

// interactiveOracleLargeObjectPreviewBytes bounds Oracle large objects before
// they cross the Wails bridge. The streaming export path stays unbounded.
const interactiveOracleLargeObjectPreviewBytes = 4 * 1024

func scanRows(rows *sql.Rows) ([]map[string]interface{}, []string, error) {
	return scanRowsForDialect(rows, "")
}

func streamRows(rows *sql.Rows, consumer QueryStreamConsumer) error {
	return streamRowsForDialect(rows, "", consumer)
}

type queryRowScanner struct {
	columns     []string
	dbTypeNames []string
	dialect     string
	values      []interface{}
	normalized  []interface{}
	valuePtrs   []interface{}
}

type queryRowsScanner interface {
	scanCurrentPreviewRow(*sql.Rows) (map[string]interface{}, error)
	scanCurrentRow(*sql.Rows) (map[string]interface{}, error)
	scanCurrentRowValues(*sql.Rows) ([]interface{}, error)
}

func scanRowsForDialect(rows *sql.Rows, dialect string) ([]map[string]interface{}, []string, error) {
	return scanRowsForDialectWithPreview(rows, dialect, true)
}

func scanRowsUnboundedForDialect(rows *sql.Rows, dialect string) ([]map[string]interface{}, []string, error) {
	return scanRowsForDialectWithPreview(rows, dialect, false)
}

func scanRowsForDialectWithPreview(rows *sql.Rows, dialect string, boundOracleLargeObjects bool) ([]map[string]interface{}, []string, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}
	columns = ensureUniqueQueryColumnNames(columns)

	colTypes, err := rows.ColumnTypes()
	if err != nil || len(colTypes) != len(columns) {
		colTypes = nil
	}

	scanner := newQueryRowScanner(columns, colTypes, dialect)
	return scanRowsWithScanner(rows, columns, scanner, boundOracleLargeObjects)
}

func scanRowsWithScanner(rows *sql.Rows, columns []string, scanner queryRowsScanner, boundOracleLargeObjects bool) ([]map[string]interface{}, []string, error) {
	resultData := make([]map[string]interface{}, 0)

	var rowNumber int64
	for rows.Next() {
		rowNumber++
		var (
			entry map[string]interface{}
			err   error
		)
		if boundOracleLargeObjects {
			entry, err = scanner.scanCurrentPreviewRow(rows)
		} else {
			entry, err = scanner.scanCurrentRow(rows)
		}
		if err != nil {
			return resultData, columns, newQueryRowScanError(rowNumber, columns, err)
		}
		resultData = append(resultData, entry)
	}

	if err := rows.Err(); err != nil {
		return resultData, columns, err
	}
	return resultData, columns, nil
}

func streamRowsForDialect(rows *sql.Rows, dialect string, consumer QueryStreamConsumer) error {
	if consumer == nil {
		return fmt.Errorf("query stream consumer required")
	}

	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	columns = ensureUniqueQueryColumnNames(columns)

	colTypes, err := rows.ColumnTypes()
	if err != nil || len(colTypes) != len(columns) {
		colTypes = nil
	}

	scanner := newQueryRowScanner(columns, colTypes, dialect)
	return streamRowsWithScanner(rows, columns, consumer, scanner)
}

func streamRowsWithScanner(rows *sql.Rows, columns []string, consumer QueryStreamConsumer, scanner queryRowsScanner) error {
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}
	valueConsumer, useValueConsumer := consumer.(QueryStreamValueConsumer)

	// processedRows 用于周期性触发 GC，见 streamRowsPeriodicGCInterval 注释。
	// 注意：此路径同时被 driver-agent 进程（OceanBase 等 optional driver）和
	// 主进程的 in-process 流式查询调用，所以一处加 GC 即可覆盖两端。
	var processedRows int64

	var rowNumber int64
	for rows.Next() {
		rowNumber++
		if useValueConsumer {
			values, err := scanner.scanCurrentRowValues(rows)
			if err != nil {
				return newQueryRowScanError(rowNumber, columns, err)
			}
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
		} else {
			entry, err := scanner.scanCurrentRow(rows)
			if err != nil {
				return newQueryRowScanError(rowNumber, columns, err)
			}
			if err := consumer.ConsumeRow(entry); err != nil {
				return err
			}
		}

		processedRows++
		if processedRows%streamRowsPeriodicGCInterval == 0 {
			runtime.GC()
			// 自适应抬升 driver-agent 进程的内存 soft limit。
			// 主进程未启用 soft limit（未调 InitMemorySoftLimit），此调用是 no-op。
			MaybeGrowMemoryLimit()
		}
	}

	return rows.Err()
}

func newQueryRowScanError(rowNumber int64, columns []string, err error) error {
	return fmt.Errorf("scan query row %d (columns: %s): %w", rowNumber, strings.Join(columns, ", "), err)
}

func newQueryRowScanner(columns []string, colTypes []*sql.ColumnType, dialect string) *queryRowScanner {
	values := make([]interface{}, len(columns))
	valuePtrs := make([]interface{}, len(columns))
	for i := range columns {
		valuePtrs[i] = &values[i]
	}
	dbTypeNames := make([]string, len(columns))
	for i := range columns {
		if colTypes != nil && i < len(colTypes) && colTypes[i] != nil {
			dbTypeNames[i] = colTypes[i].DatabaseTypeName()
		}
	}
	return &queryRowScanner{
		columns:     columns,
		dbTypeNames: dbTypeNames,
		dialect:     dialect,
		values:      values,
		normalized:  make([]interface{}, len(columns)),
		valuePtrs:   valuePtrs,
	}
}

func (s *queryRowScanner) scanCurrentRowValues(rows *sql.Rows) ([]interface{}, error) {
	return s.scanCurrentRowValuesWithPreview(rows, false)
}

func (s *queryRowScanner) scanCurrentRowValuesWithPreview(rows *sql.Rows, boundOracleLargeObjects bool) ([]interface{}, error) {
	if err := rows.Scan(s.valuePtrs...); err != nil {
		return nil, err
	}
	for i := range s.columns {
		if boundOracleLargeObjects {
			s.normalized[i] = normalizeInteractiveQueryValue(s.values[i], s.dbTypeNames[i], s.dialect)
		} else {
			s.normalized[i] = normalizeQueryValueWithDBTypeAndDialect(s.values[i], s.dbTypeNames[i], s.dialect)
		}
	}
	return s.normalized, nil
}

func normalizeInteractiveQueryValue(value interface{}, databaseTypeName, dialect string) interface{} {
	switch typedValue := value.(type) {
	case []byte:
		if len(typedValue) > interactiveOracleLargeObjectPreviewBytes && isOracleBinaryLargeObjectType(databaseTypeName) {
			preview := normalizeQueryValueWithDBTypeAndDialect(
				typedValue[:interactiveOracleLargeObjectPreviewBytes],
				databaseTypeName,
				dialect,
			)
			previewText, ok := preview.(string)
			if !ok {
				previewText = fmt.Sprint(preview)
			}
			return fmt.Sprintf(
				"[BLOB preview: %d/%d bytes] %s",
				interactiveOracleLargeObjectPreviewBytes,
				len(typedValue),
				previewText,
			)
		}
	case string:
		if len(typedValue) > interactiveOracleLargeObjectPreviewBytes && isOracleTextLargeObjectType(databaseTypeName) {
			preview := truncateUTF8Prefix(typedValue, interactiveOracleLargeObjectPreviewBytes)
			return fmt.Sprintf(
				"[CLOB preview: %d/%d bytes] %s",
				len(preview),
				len(typedValue),
				preview,
			)
		}
	}

	return normalizeQueryValueWithDBTypeAndDialect(value, databaseTypeName, dialect)
}

func isOracleBinaryLargeObjectType(databaseTypeName string) bool {
	typeName := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(databaseTypeName), " ", ""))
	switch typeName {
	case "OCIBLOBLOCATOR", "LONGRAW", "LONGVARRAW":
		return true
	default:
		return false
	}
}

func isOracleTextLargeObjectType(databaseTypeName string) bool {
	typeName := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(databaseTypeName), " ", ""))
	switch typeName {
	case "OCICLOBLOCATOR", "LONG", "LONGVARCHAR":
		return true
	default:
		return false
	}
}

func truncateUTF8Prefix(value string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}

	end := maxBytes
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end]
}

func (s *queryRowScanner) scanCurrentPreviewRow(rows *sql.Rows) (map[string]interface{}, error) {
	normalized, err := s.scanCurrentRowValuesWithPreview(rows, true)
	if err != nil {
		return nil, err
	}
	entry := make(map[string]interface{}, len(s.columns))
	for i, col := range s.columns {
		entry[col] = normalized[i]
	}
	return entry, nil
}

func (s *queryRowScanner) scanCurrentRow(rows *sql.Rows) (map[string]interface{}, error) {
	normalized, err := s.scanCurrentRowValues(rows)
	if err != nil {
		return nil, err
	}
	entry := make(map[string]interface{}, len(s.columns))
	for i, col := range s.columns {
		entry[col] = normalized[i]
	}
	return entry, nil
}

func ensureUniqueQueryColumnNames(columns []string) []string {
	if len(columns) == 0 {
		return columns
	}

	uniqueColumns := make([]string, len(columns))
	taken := make(map[string]struct{}, len(columns))
	nextSuffix := make(map[string]int, len(columns))

	for idx, column := range columns {
		base := column
		if base == "" {
			base = fmt.Sprintf("column_%d", idx+1)
		}

		candidate := base
		if _, exists := taken[candidate]; exists {
			suffix := nextSuffix[base]
			if suffix < 2 {
				suffix = 2
			}
			for {
				candidate = fmt.Sprintf("%s_%d", base, suffix)
				if _, exists := taken[candidate]; !exists {
					break
				}
				suffix++
			}
			nextSuffix[base] = suffix + 1
		} else {
			nextSuffix[base] = 2
		}

		uniqueColumns[idx] = candidate
		taken[candidate] = struct{}{}
	}

	return uniqueColumns
}

// scanMultiRows 遍历 sql.Rows 中的所有结果集，将每个结果集作为 ResultSetData 返回。
// 利用 rows.NextResultSet() 支持一次 query 返回多个结果集的场景。
func scanMultiRows(rows *sql.Rows) ([]connection.ResultSetData, error) {
	return scanMultiRowsForDialect(rows, "")
}

func scanMultiRowsForDialect(rows *sql.Rows, dialect string) ([]connection.ResultSetData, error) {
	var results []connection.ResultSetData
	for {
		data, cols, err := scanRowsForDialect(rows, dialect)
		if err != nil {
			return results, err
		}
		if data == nil {
			data = make([]map[string]interface{}, 0)
		}
		if cols == nil {
			cols = []string{}
		}
		results = append(results, connection.ResultSetData{
			Rows:    data,
			Columns: cols,
		})
		if !rows.NextResultSet() {
			break
		}
	}
	if len(results) == 0 {
		results = []connection.ResultSetData{{
			Rows:    make([]map[string]interface{}, 0),
			Columns: []string{},
		}}
	}
	if err := rows.Err(); err != nil {
		return results, err
	}
	return results, nil
}
