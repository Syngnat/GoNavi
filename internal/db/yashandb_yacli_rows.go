//go:build gonavi_full_drivers || gonavi_yashandb_driver

package db

import (
	"bytes"
	"database/sql/driver"
	"fmt"
	"io"
	"math"
	"runtime"
	"strings"
	"time"
	"unsafe"
)

const (
	// yacliLobChunkSize 是分段读写大对象的块大小（与官方驱动一致）。
	yacliLobChunkSize = 8192
	// yacliDefaultTextBuffer 是无法从列描述得知长度的列（向量、游标等）按文本绑定时的缓冲区大小。
	yacliDefaultTextBuffer = 32*1024 + 1
	// yacliMaxCharBytes 是 UTF-8 下单个字符的最大字节数，按字符计长的列按它放大缓冲区。
	yacliMaxCharBytes = 4
)

// yacliColumnDesc 对应 yacli 的 YapiColumnDesc（name 指针、size、type、精度 / 标度、可空）。
type yacliColumnDesc struct {
	name      uintptr
	size      uint32
	typ       uint8
	precision uint8
	scale     int8
	nullable  uint8
}

// yacliColumn 是结果集的一列：原始类型、绑定方式与绑定缓冲区（yacFetch 把一行数据写进这些缓冲区）。
type yacliColumn struct {
	name      string
	typ       int
	bindType  int
	size      uint32
	precision uint8
	scale     int8
	buffer    []byte
	lob       *uintptr
	indicator int32
}

// yacliRows 逐行 yacFetch。定长类型按原生值绑定；数值、字符、区间、ROWID 等由客户端转成文本；大对象绑定定位符后分段读取。
type yacliRows struct {
	stmt    *yacliStatement
	columns []*yacliColumn
}

var (
	_ driver.Rows                           = (*yacliRows)(nil)
	_ driver.RowsColumnTypeDatabaseTypeName = (*yacliRows)(nil)
)

func newYacliRows(stmt *yacliStatement) (*yacliRows, error) {
	api := stmt.conn.api
	var count int16
	if err := api.call(api.numResultCols, stmt.handle, yacliPtr(&count)); err != nil {
		return nil, err
	}
	rows := &yacliRows{stmt: stmt, columns: make([]*yacliColumn, count)}
	for i := range rows.columns {
		var desc yacliColumnDesc
		if err := api.call(api.describeCol2, stmt.handle, uintptr(i), yacliPtr(&desc)); err != nil {
			return nil, err
		}
		column := &yacliColumn{name: goCString(desc.name), typ: int(desc.typ), size: desc.size, precision: desc.precision, scale: desc.scale}
		if err := rows.bind(i, column); err != nil {
			return nil, err
		}
		rows.columns[i] = column
	}
	return rows, nil
}

// bind 按列类型选择绑定方式并分配缓冲区（缓冲区固定后才交给 yacli）。
func (r *yacliRows) bind(index int, column *yacliColumn) error {
	stmt := r.stmt
	api := stmt.conn.api
	column.bindType = column.typ
	switch column.typ {
	case yacTypeBool, yacTypeTinyint, yacTypeSmallint, yacTypeInteger, yacTypeBigint,
		yacTypeUTinyint, yacTypeUSmallint, yacTypeUInteger, yacTypeUBigint, yacTypeFloat, yacTypeDouble:
		column.buffer = make([]byte, max(column.size, 8))
	case yacTypeDate, yacTypeShortDate, yacTypeShortTime:
		column.buffer = make([]byte, 8)
	case yacTypeTimestamp, yacTypeTimestampLTZ, yacTypeTimestampTZ:
		column.buffer = make([]byte, 12)
	case yacTypeBinary:
		// 部分系统视图的 RAW 列实际内容比声明的长，按 RAW 上限分配。
		column.buffer = make([]byte, max(int(column.size), yacliDefaultTextBuffer))
	case yacTypeClob, yacTypeNClob, yacTypeBlob, yacTypeXML:
		column.lob = new(uintptr)
		stmt.pinner.Pin(column.lob)
		if err := api.call(api.lobDescAlloc, stmt.conn.dbc, uintptr(column.typ), yacliPtr(column.lob)); err != nil {
			return err
		}
		stmt.lobs = append(stmt.lobs, yacliLob{lobType: column.typ, holder: column.lob})
		stmt.pinner.Pin(&column.indicator)
		return api.call(api.bindColumn, stmt.handle, uintptr(index), uintptr(column.typ), yacliPtr(column.lob), yacliInt(-1), yacliPtr(&column.indicator))
	default:
		column.bindType = yacTypeVarchar
		column.buffer = make([]byte, yacliTextBufferSize(column))
	}
	stmt.pinner.Pin(&column.buffer[0])
	stmt.pinner.Pin(&column.indicator)
	return api.call(api.bindColumn, stmt.handle, uintptr(index), uintptr(column.bindType), yacliPtr(&column.buffer[0]),
		uintptr(len(column.buffer)), yacliPtr(&column.indicator))
}

// yacliTextBufferSize 是按文本绑定的列的缓冲区大小：字符列按最大字符宽度放大，数值按精度预留符号、小数点与指数。
func yacliTextBufferSize(column *yacliColumn) int {
	switch column.typ {
	case yacTypeChar, yacTypeNChar, yacTypeVarchar, yacTypeNVarchar:
		return int(column.size)*yacliMaxCharBytes + 1
	case yacTypeNumber, yacTypeNumberFloat:
		return 160
	case yacTypeYMInterval, yacTypeDSInterval, yacTypeRowID:
		return 96
	case yacTypeBit:
		return 72
	case yacTypeJSON:
		return max(int(column.size)*yacliMaxCharBytes+1, yacliDefaultTextBuffer)
	default:
		return max(int(column.size)*yacliMaxCharBytes+1, yacliDefaultTextBuffer)
	}
}

func (r *yacliRows) Columns() []string {
	names := make([]string, len(r.columns))
	for i, column := range r.columns {
		names[i] = column.name
	}
	return names
}

func (r *yacliRows) Close() error {
	r.stmt.close()
	return nil
}

func (r *yacliRows) Next(dest []driver.Value) error {
	api := r.stmt.conn.api
	var fetched uint32
	if err := api.call(api.fetch, r.stmt.handle, yacliPtr(&fetched)); err != nil {
		return err
	}
	if fetched == 0 {
		return io.EOF
	}
	for i, column := range r.columns {
		if column.indicator == yacNullData {
			dest[i] = nil
			continue
		}
		value, err := r.value(column)
		if err != nil {
			return err
		}
		dest[i] = value
	}
	return nil
}

func (r *yacliRows) value(column *yacliColumn) (driver.Value, error) {
	data := unsafe.Pointer(nil)
	if len(column.buffer) > 0 {
		data = unsafe.Pointer(&column.buffer[0])
	}
	switch column.bindType {
	case yacTypeBool:
		return column.buffer[0] != 0, nil
	case yacTypeTinyint:
		return int64(*(*int8)(data)), nil
	case yacTypeSmallint:
		return int64(*(*int16)(data)), nil
	case yacTypeInteger:
		return int64(*(*int32)(data)), nil
	case yacTypeBigint:
		return *(*int64)(data), nil
	case yacTypeUTinyint:
		return int64(column.buffer[0]), nil
	case yacTypeUSmallint:
		return int64(*(*uint16)(data)), nil
	case yacTypeUInteger:
		return int64(*(*uint32)(data)), nil
	case yacTypeUBigint:
		if value := *(*uint64)(data); value > math.MaxInt64 {
			return fmt.Sprint(value), nil
		} else {
			return int64(value), nil
		}
	case yacTypeFloat:
		return float64(*(*float32)(data)), nil
	case yacTypeDouble:
		return *(*float64)(data), nil
	case yacTypeDate, yacTypeShortDate:
		return time.UnixMicro(*(*int64)(data)).UTC(), nil
	case yacTypeShortTime:
		return strings.TrimSuffix(strings.TrimRight(time.UnixMicro(*(*int64)(data)).UTC().Format("15:04:05.000000"), "0"), "."), nil
	case yacTypeTimestamp, yacTypeTimestampLTZ:
		return time.UnixMicro(*(*int64)(data)).UTC(), nil
	case yacTypeTimestampTZ:
		bias := int(*(*int16)(unsafe.Add(data, 8)))
		wall := time.UnixMicro(*(*int64)(data)).UTC()
		zone := time.FixedZone(yashanZoneName(bias), bias*60)
		return time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), wall.Second(), wall.Nanosecond(), zone), nil
	case yacTypeBinary:
		return append([]byte(nil), column.buffer[:min(int(column.indicator), len(column.buffer))]...), nil
	case yacTypeClob, yacTypeNClob, yacTypeXML:
		content, err := r.readLob(column)
		return string(content), err
	case yacTypeBlob:
		return r.readLob(column)
	default:
		// 文本按 C 字符串返回：长度以指示器为准，遇到 NUL 截断（部分系统输出在 NUL 之后残留上一行的内容）。
		text := column.buffer[:min(max(int(column.indicator), 0), len(column.buffer)-1)]
		if end := bytes.IndexByte(text, 0); end >= 0 {
			text = text[:end]
		}
		return string(text), nil
	}
}

// readLob 通过定位符分段读出大对象（yacLobRead 每次读一段，读到 0 字节结束）。
func (r *yacliRows) readLob(column *yacliColumn) ([]byte, error) {
	api, dbc := r.stmt.conn.api, r.stmt.conn.dbc
	locator := *column.lob
	var length uint64
	if err := api.call(api.lobGetLength, dbc, locator, yacliPtr(&length)); err != nil {
		return nil, err
	}
	content := make([]byte, 0, min(length, 64<<20))
	buffer := make([]byte, yacliLobChunkSize)
	for {
		read := uint64(len(buffer))
		err := api.call(api.lobRead, dbc, locator, yacliPtr(&read), yacliPtr(&buffer[0]), uintptr(len(buffer)))
		runtime.KeepAlive(buffer)
		if err != nil {
			return nil, err
		}
		if read == 0 {
			return content, nil
		}
		content = append(content, buffer[:min(read, uint64(len(buffer)))]...)
	}
}

func yashanZoneName(biasMinutes int) string {
	sign := "+"
	if biasMinutes < 0 {
		sign, biasMinutes = "-", -biasMinutes
	}
	return fmt.Sprintf("%s%02d:%02d", sign, biasMinutes/60, biasMinutes%60)
}

// yashanTypeNames 把 yacli 类型映射为崖山的类型名，供结果表格的类型提示与大对象预览判断使用。
var yashanTypeNames = map[int]string{
	yacTypeBool: "BOOLEAN", yacTypeTinyint: "TINYINT", yacTypeSmallint: "SMALLINT", yacTypeInteger: "INTEGER",
	yacTypeBigint: "BIGINT", yacTypeUTinyint: "UTINYINT", yacTypeUSmallint: "USMALLINT", yacTypeUInteger: "UINTEGER",
	yacTypeUBigint: "UBIGINT", yacTypeFloat: "FLOAT", yacTypeDouble: "DOUBLE", yacTypeNumber: "NUMBER",
	yacTypeDate: "DATE", yacTypeShortDate: "SHORTDATE", yacTypeShortTime: "TIME", yacTypeTimestamp: "TIMESTAMP",
	yacTypeTimestampLTZ: "TIMESTAMP WITH LOCAL TIME ZONE", yacTypeTimestampTZ: "TIMESTAMP WITH TIME ZONE",
	yacTypeYMInterval: "INTERVAL YEAR TO MONTH", yacTypeDSInterval: "INTERVAL DAY TO SECOND", yacTypeChar: "CHAR",
	yacTypeNChar: "NCHAR", yacTypeVarchar: "VARCHAR", yacTypeNVarchar: "NVARCHAR", yacTypeBinary: "RAW",
	yacTypeClob: "CLOB", yacTypeBlob: "BLOB", yacTypeBit: "BIT", yacTypeRowID: "ROWID", yacTypeNClob: "NCLOB",
	yacTypeCursor: "CURSOR", yacTypeJSON: "JSON", yacTypeXML: "XMLTYPE", yacTypeNumberFloat: "NUMBER",
	yacTypeVector: "VECTOR",
}

func (r *yacliRows) ColumnTypeDatabaseTypeName(index int) string {
	return yashanTypeNames[r.columns[index].typ]
}

// yashanParamText 把非原生绑定的参数转成文本，由服务端按目标列类型隐式转换。
func yashanParamText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}
