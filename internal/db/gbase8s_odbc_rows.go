//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"database/sql/driver"
	"io"
	"runtime"
	"strconv"
	"strings"
)

// odbcColumn 是 SQLDescribeCol 描述的结果列。
type odbcColumn struct {
	name     string
	sqlType  int16
	size     uint64
	decimals int16
}

// odbcRows 逐行 SQLFetch，每列用 SQLGetData 分段读取（不绑定列，长文本与大对象不受缓冲区大小限制）。
type odbcRows struct {
	stmt    *odbcStatement
	columns []odbcColumn
	buffer  []byte
}

var (
	_ driver.Rows                           = (*odbcRows)(nil)
	_ driver.RowsColumnTypeDatabaseTypeName = (*odbcRows)(nil)
)

const odbcFetchBufferSize = 64 << 10

func newODBCRows(stmt *odbcStatement) (*odbcRows, error) {
	api := stmt.api
	var count int16
	if rc := odbcCall(api.numResultCols, stmt.handle, ptr(&count)); !odbcOK(rc) {
		return nil, api.diagError(sqlHandleStmt, stmt.handle, rc)
	}
	rows := &odbcRows{stmt: stmt, columns: make([]odbcColumn, count), buffer: make([]byte, odbcFetchBufferSize)}
	name := make([]byte, 512)
	for i := range rows.columns {
		var nameLen, sqlType, decimals, nullable int16
		var size uint64
		rc := odbcCall(api.describeCol, stmt.handle, uintptr(i+1), ptr(&name[0]), uintptr(len(name)), ptr(&nameLen),
			ptr(&sqlType), ptr(&size), ptr(&decimals), ptr(&nullable))
		if !odbcOK(rc) {
			return nil, api.diagError(sqlHandleStmt, stmt.handle, rc)
		}
		length := min(max(int(nameLen), 0), len(name)-1)
		rows.columns[i] = odbcColumn{name: string(name[:length]), sqlType: sqlType, size: size, decimals: decimals}
	}
	runtime.KeepAlive(name)
	return rows, nil
}

func (r *odbcRows) Columns() []string {
	names := make([]string, len(r.columns))
	for i, column := range r.columns {
		names[i] = column.name
	}
	return names
}

func (r *odbcRows) Close() error {
	r.stmt.close()
	return nil
}

func (r *odbcRows) Next(dest []driver.Value) error {
	api := r.stmt.api
	rc := odbcCall(api.fetch, r.stmt.handle)
	if rc == sqlNoData {
		return io.EOF
	}
	if !odbcOK(rc) {
		return api.diagError(sqlHandleStmt, r.stmt.handle, rc)
	}
	for i, column := range r.columns {
		value, err := r.value(i+1, column)
		if err != nil {
			return err
		}
		dest[i] = value
	}
	return nil
}

func (r *odbcRows) value(index int, column odbcColumn) (driver.Value, error) {
	if isODBCBinaryType(column.sqlType) {
		data, isNull, err := r.read(index, sqlCBinary)
		if err != nil || isNull {
			return nil, err
		}
		return data, nil
	}
	data, isNull, err := r.read(index, sqlCChar)
	if err != nil || isNull {
		return nil, err
	}
	text := string(data)
	switch column.sqlType {
	case sqlTypeInteger, sqlTypeSmallint, sqlTypeBigint, sqlTypeTinyint:
		if number, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64); err == nil {
			return number, nil
		}
	case sqlTypeReal, sqlTypeFloat, sqlTypeDouble:
		if number, err := strconv.ParseFloat(strings.TrimSpace(text), 64); err == nil {
			return number, nil
		}
	case sqlTypeBit:
		return text == "1" || strings.EqualFold(text, "t"), nil
	}
	return text, nil
}

// read 用 SQLGetData 分段读出一列；字符数据每段以 NUL 结尾，截断时驱动返回 SQL_SUCCESS_WITH_INFO 并在下次调用续读。
func (r *odbcRows) read(index int, cType int) ([]byte, bool, error) {
	api := r.stmt.api
	var result []byte
	for {
		var indicator int64
		rc := odbcCall(api.getData, r.stmt.handle, uintptr(index), sqlInt(cType), ptr(&r.buffer[0]), uintptr(len(r.buffer)), ptr(&indicator))
		runtime.KeepAlive(r.buffer)
		if rc == sqlNoData {
			return result, false, nil
		}
		if !odbcOK(rc) {
			return nil, false, api.diagError(sqlHandleStmt, r.stmt.handle, rc)
		}
		if indicator == sqlNullData {
			return nil, true, nil
		}
		capacity := len(r.buffer)
		if cType == sqlCChar {
			capacity--
		}
		chunk := capacity
		if indicator != sqlNoTotal && indicator >= 0 && indicator < int64(capacity) {
			chunk = int(indicator)
		}
		result = append(result, r.buffer[:chunk]...)
		if rc == sqlSuccess {
			if result == nil {
				result = []byte{}
			}
			return result, false, nil
		}
	}
}

func isODBCBinaryType(sqlType int16) bool {
	return sqlType == sqlTypeBinary || sqlType == sqlTypeVarBinary || sqlType == sqlTypeLongVarBinary
}

// ColumnTypeDatabaseTypeName 返回 ODBC 类型的通用名称，供结果表格的类型提示与值归一化使用。
func (r *odbcRows) ColumnTypeDatabaseTypeName(index int) string {
	switch r.columns[index].sqlType {
	case sqlTypeChar:
		return "CHAR"
	case sqlTypeVarchar:
		return "VARCHAR"
	case sqlTypeLongVarchar:
		return "TEXT"
	case sqlTypeNumeric, sqlTypeDecimal:
		return "DECIMAL"
	case sqlTypeInteger:
		return "INTEGER"
	case sqlTypeSmallint:
		return "SMALLINT"
	case sqlTypeBigint:
		return "BIGINT"
	case sqlTypeTinyint:
		return "TINYINT"
	case sqlTypeFloat, sqlTypeDouble:
		return "FLOAT"
	case sqlTypeReal:
		return "SMALLFLOAT"
	case sqlTypeBit:
		return "BOOLEAN"
	case 91:
		return "DATE"
	case 92:
		return "TIME"
	case 93:
		return "DATETIME"
	case sqlTypeBinary, sqlTypeVarBinary, sqlTypeLongVarBinary:
		return "BYTE"
	default:
		return ""
	}
}
