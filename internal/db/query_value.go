package db

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	mssql "github.com/microsoft/go-mssqldb"
)

const (
	jsMaxSafeInteger           int64  = 9007199254740991
	jsMinSafeInteger           int64  = -9007199254740991
	jsMaxSafeUint              uint64 = 9007199254740991
	oceanBaseOracleScanDialect        = "oceanbase-oracle"
)

var (
	jsMaxSafeBigInt = big.NewInt(jsMaxSafeInteger)
	jsMinSafeBigInt = big.NewInt(jsMinSafeInteger)
)

// normalizeQueryValue normalizes driver-returned values for UI/JSON transport.
// 当前主要处理 []byte：如果是可读文本则转为 string，否则转为十六进制字符串，避免前端出现“空白值”。
func normalizeQueryValue(v interface{}) interface{} {
	return normalizeQueryValueWithDBType(v, "")
}

func normalizeQueryValueWithDBType(v interface{}, databaseTypeName string) interface{} {
	return normalizeQueryValueWithDBTypeAndDialect(v, databaseTypeName, "")
}

func normalizeQueryValueWithDBTypeAndDialect(v interface{}, databaseTypeName, dialect string) interface{} {
	if tm, ok := v.(time.Time); ok {
		return normalizeTemporalValueForDisplay(tm, databaseTypeName, dialect)
	}
	if s, ok := v.(string); ok {
		if tm, normalizedType, ok := decodeOceanBaseOracleTemporalString(s, databaseTypeName, dialect); ok {
			return normalizeTemporalValueForDisplay(tm, normalizedType, dialect)
		}
	}
	if b, ok := v.([]byte); ok {
		if tm, normalizedType, ok := decodeOceanBaseOracleTemporalBytes(b, databaseTypeName, dialect); ok {
			return normalizeTemporalValueForDisplay(tm, normalizedType, dialect)
		}
		return bytesToDisplayValue(b, databaseTypeName)
	}
	return normalizeCompositeQueryValue(v)
}

func normalizeTemporalValueForDisplay(value time.Time, databaseTypeName, dialect string) interface{} {
	if value.IsZero() {
		if zeroValue, ok := zeroTemporalDisplayValue(databaseTypeName); ok {
			return zeroValue
		}
	}
	if shouldDisplayTemporalValueAsDateOnly(databaseTypeName, dialect) || shouldDisplayOceanBaseOracleDateAsDateOnly(value, databaseTypeName, dialect) {
		return value.Format("2006-01-02")
	}
	return value.Format(time.RFC3339Nano)
}

func isDateOnlyDatabaseTypeName(databaseTypeName string) bool {
	typeName := strings.ToUpper(strings.TrimSpace(databaseTypeName))
	return typeName == "DATE" || typeName == "NEWDATE"
}

func shouldDisplayTemporalValueAsDateOnly(databaseTypeName, dialect string) bool {
	if !isDateOnlyDatabaseTypeName(databaseTypeName) {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(dialect)) {
	case "mysql", "mariadb", "goldendb", "greatdb", "gdb", "diros", "doris", "starrocks", "sphinx":
		return true
	default:
		return false
	}
}

func shouldDisplayOceanBaseOracleDateAsDateOnly(value time.Time, databaseTypeName, dialect string) bool {
	if !isDateOnlyDatabaseTypeName(databaseTypeName) {
		return false
	}
	if strings.ToLower(strings.TrimSpace(dialect)) != oceanBaseOracleScanDialect {
		return false
	}
	return value.Hour() == 0 && value.Minute() == 0 && value.Second() == 0 && value.Nanosecond() == 0
}

func decodeOceanBaseOracleTemporalString(value string, databaseTypeName, dialect string) (time.Time, string, bool) {
	return decodeOceanBaseOracleTemporalBytes([]byte(value), databaseTypeName, dialect)
}

func decodeOceanBaseOracleTemporalBytes(value []byte, databaseTypeName, dialect string) (time.Time, string, bool) {
	if strings.ToLower(strings.TrimSpace(dialect)) != oceanBaseOracleScanDialect {
		return time.Time{}, "", false
	}
	if !shouldAttemptOceanBaseOracleTemporalDecode(databaseTypeName, value) {
		return time.Time{}, "", false
	}
	return parseOceanBaseOracleTemporal(value, databaseTypeName)
}

func shouldAttemptOceanBaseOracleTemporalDecode(databaseTypeName string, value []byte) bool {
	if isOceanBaseOracleTemporalDatabaseTypeName(databaseTypeName) {
		return true
	}
	if !hasOceanBaseOracleTemporalEncodedLength(value) {
		return false
	}
	typeName := strings.ToUpper(strings.TrimSpace(databaseTypeName))
	if typeName == "" {
		return true
	}
	if isLikelyOceanBaseOracleTemporalCarrierType(typeName) {
		return true
	}
	return false
}

func hasOceanBaseOracleTemporalEncodedLength(value []byte) bool {
	switch len(value) {
	case 5, 7, 8, 11, 12, 13:
		return true
	default:
		return false
	}
}

func isLikelyOceanBaseOracleTemporalCarrierType(typeName string) bool {
	if typeName == "" {
		return false
	}
	switch {
	case strings.Contains(typeName, "CHAR"),
		strings.Contains(typeName, "TEXT"),
		strings.Contains(typeName, "STRING"),
		strings.Contains(typeName, "BINARY"),
		strings.Contains(typeName, "VARBINARY"),
		strings.Contains(typeName, "RAW"),
		strings.Contains(typeName, "BLOB"),
		strings.Contains(typeName, "LOB"):
		return true
	default:
		return false
	}
}

func isOceanBaseOracleTemporalDatabaseTypeName(databaseTypeName string) bool {
	typeName := strings.ToUpper(strings.TrimSpace(databaseTypeName))
	if typeName == "DATE" || typeName == "TYPE_CA" {
		return true
	}
	return strings.HasPrefix(typeName, "TIMESTAMP")
}

func parseOceanBaseOracleTemporal(value []byte, databaseTypeName string) (time.Time, string, bool) {
	if tm, normalizedType, ok := parseOracleBinaryTemporal(value, databaseTypeName); ok {
		return tm, normalizedType, true
	}
	if tm, normalizedType, ok := parseOceanBaseOracleTypeCATemporal(value, databaseTypeName); ok {
		return tm, normalizedType, true
	}
	return parseMySQLLengthEncodedTemporal(value, databaseTypeName)
}

func parseOceanBaseOracleTypeCATemporal(value []byte, databaseTypeName string) (time.Time, string, bool) {
	if len(value) != 12 {
		return time.Time{}, "", false
	}

	yearHigh := int(value[0])
	yearLow := int(value[1])
	month := int(value[2])
	day := int(value[3])
	hour := int(value[4])
	minute := int(value[5])
	second := int(value[6])
	nsec := int(binary.LittleEndian.Uint32(value[7:11]))
	scale := int(value[11])

	if yearHigh < 0 || yearHigh > 99 || yearLow < 0 || yearLow > 99 {
		return time.Time{}, "", false
	}
	if month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 {
		return time.Time{}, "", false
	}
	if scale < 0 || scale > 9 || nsec < 0 || nsec >= 1_000_000_000 {
		return time.Time{}, "", false
	}
	if !matchesTemporalScale(nsec, scale) {
		return time.Time{}, "", false
	}

	year := yearHigh*100 + yearLow
	parsed := time.Date(year, time.Month(month), day, hour, minute, second, nsec, time.UTC)
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day ||
		parsed.Hour() != hour || parsed.Minute() != minute || parsed.Second() != second || parsed.Nanosecond() != nsec {
		return time.Time{}, "", false
	}
	return parsed, normalizeOracleTemporalDatabaseTypeName(databaseTypeName), true
}

func matchesTemporalScale(nsec, scale int) bool {
	if scale >= 9 {
		return true
	}
	step := 1
	for i := 0; i < 9-scale; i++ {
		step *= 10
	}
	return nsec%step == 0
}

func parseOracleBinaryTemporal(value []byte, databaseTypeName string) (time.Time, string, bool) {
	switch len(value) {
	case 7:
		tm, ok := parseOracleBinaryDateTime(value[:7])
		return tm, "DATE", ok
	case 11:
		tm, ok := parseOracleBinaryTimestamp(value)
		return tm, normalizeOracleTemporalDatabaseTypeName(databaseTypeName), ok
	case 13:
		tm, ok := parseOracleBinaryTimestampWithTimezone(value)
		return tm, normalizeOracleTemporalDatabaseTypeName(databaseTypeName), ok
	default:
		return time.Time{}, "", false
	}
}

func parseMySQLLengthEncodedTemporal(value []byte, databaseTypeName string) (time.Time, string, bool) {
	if len(value) == 0 {
		return time.Time{}, "", false
	}
	payloadLength := int(value[0])
	if payloadLength != len(value)-1 {
		return time.Time{}, "", false
	}

	switch payloadLength {
	case 4:
		tm, ok := parseMySQLBinaryDateTimePayload(value[1:], false)
		return tm, "DATE", ok
	case 7:
		tm, ok := parseMySQLBinaryDateTimePayload(value[1:], false)
		return tm, normalizeOracleTemporalDatabaseTypeName(databaseTypeName), ok
	case 11:
		tm, ok := parseMySQLBinaryDateTimePayload(value[1:], true)
		return tm, normalizeOracleTemporalDatabaseTypeName(databaseTypeName), ok
	default:
		return time.Time{}, "", false
	}
}

func parseMySQLBinaryDateTimePayload(value []byte, withFraction bool) (time.Time, bool) {
	expectedLength := 7
	if !withFraction {
		switch len(value) {
		case 4:
			year := int(binary.LittleEndian.Uint16(value[0:2]))
			month := int(value[2])
			day := int(value[3])
			if year < 0 || month < 1 || month > 12 || day < 1 || day > 31 {
				return time.Time{}, false
			}
			parsed := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
			if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day {
				return time.Time{}, false
			}
			return parsed, true
		case expectedLength:
		default:
			return time.Time{}, false
		}
	} else if len(value) != 11 {
		return time.Time{}, false
	}

	year := int(binary.LittleEndian.Uint16(value[0:2]))
	month := int(value[2])
	day := int(value[3])
	hour := int(value[4])
	minute := int(value[5])
	second := int(value[6])
	nsec := 0
	if withFraction {
		usec := binary.LittleEndian.Uint32(value[7:11])
		if usec >= 1_000_000 {
			return time.Time{}, false
		}
		nsec = int(usec) * 1000
	}

	if year < 0 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 {
		return time.Time{}, false
	}

	parsed := time.Date(year, time.Month(month), day, hour, minute, second, nsec, time.UTC)
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day ||
		parsed.Hour() != hour || parsed.Minute() != minute || parsed.Second() != second || parsed.Nanosecond() != nsec {
		return time.Time{}, false
	}
	return parsed, true
}

func normalizeOracleTemporalDatabaseTypeName(databaseTypeName string) string {
	typeName := strings.ToUpper(strings.TrimSpace(databaseTypeName))
	switch typeName {
	case "TYPE_CA":
		return "TIMESTAMP"
	default:
		if typeName == "" {
			return "TIMESTAMP"
		}
		return typeName
	}
}

func parseOracleBinaryTimestamp(value []byte) (time.Time, bool) {
	if len(value) != 11 {
		return time.Time{}, false
	}
	baseTime, ok := parseOracleBinaryDateTime(value[:7])
	if !ok {
		return time.Time{}, false
	}
	nsec := binary.BigEndian.Uint32(value[7:11])
	if nsec >= 1_000_000_000 {
		return time.Time{}, false
	}
	return time.Date(
		baseTime.Year(),
		baseTime.Month(),
		baseTime.Day(),
		baseTime.Hour(),
		baseTime.Minute(),
		baseTime.Second(),
		int(nsec),
		time.UTC,
	), true
}

func parseOracleBinaryTimestampWithTimezone(value []byte) (time.Time, bool) {
	if len(value) != 13 {
		return time.Time{}, false
	}
	baseTime, ok := parseOracleBinaryTimestamp(value[:11])
	if !ok {
		return time.Time{}, false
	}
	tzHour := int(value[11]) - 20
	tzMinute := int(value[12]) - 60
	if tzHour < -12 || tzHour > 14 || tzMinute < 0 || tzMinute >= 60 {
		return time.Time{}, false
	}
	location := time.FixedZone("", tzHour*3600+tzMinute*60)
	return time.Date(
		baseTime.Year(),
		baseTime.Month(),
		baseTime.Day(),
		baseTime.Hour(),
		baseTime.Minute(),
		baseTime.Second(),
		baseTime.Nanosecond(),
		location,
	), true
}

func parseOracleBinaryDateTime(value []byte) (time.Time, bool) {
	if len(value) != 7 {
		return time.Time{}, false
	}
	year := (int(value[0]) - 100) * 100
	year += int(value[1]) - 100
	month := int(value[2])
	day := int(value[3])
	hour := int(value[4]) - 1
	minute := int(value[5]) - 1
	second := int(value[6]) - 1
	if year < 0 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 {
		return time.Time{}, false
	}
	parsed := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day ||
		parsed.Hour() != hour || parsed.Minute() != minute || parsed.Second() != second {
		return time.Time{}, false
	}
	return parsed, true
}

func zeroTemporalDisplayValue(databaseTypeName string) (string, bool) {
	typeName := strings.ToUpper(strings.TrimSpace(databaseTypeName))
	if typeName == "" {
		return "0000-00-00 00:00:00", true
	}

	switch {
	case strings.Contains(typeName, "TIMESTAMP") || strings.Contains(typeName, "DATETIME"):
		return "0000-00-00 00:00:00", true
	case typeName == "DATE" || typeName == "NEWDATE":
		return "0000-00-00", true
	case strings.Contains(typeName, "TIME"):
		return "00:00:00", true
	case strings.Contains(typeName, "YEAR"):
		return "0000", true
	default:
		return "", false
	}
}

func normalizeCompositeQueryValue(v interface{}) interface{} {
	if v == nil {
		return nil
	}

	switch typed := v.(type) {
	case []interface{}:
		items := make([]interface{}, len(typed))
		for i, item := range typed {
			items[i] = normalizeQueryValue(item)
		}
		return items
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, value := range typed {
			out[key] = normalizeQueryValue(value)
		}
		return out
	case json.Number:
		return normalizeJSONNumberForJS(typed)
	}

	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer:
		if rv.IsNil() {
			return nil
		}
		return normalizeQueryValue(rv.Elem().Interface())
	case reflect.Map:
		if rv.IsNil() {
			return nil
		}
		out := make(map[string]interface{}, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			out[mapKeyToString(iter.Key().Interface())] = normalizeQueryValue(iter.Value().Interface())
		}
		return out
	case reflect.Slice, reflect.Array:
		// 无类型的 []byte 在上层已单独处理，这里还会收到**具名**字节切片
		// （如 clickhouse-go 对 IPv4/IPv6 列返回的 net.IP —— 具名类型不匹配上层的 case []byte）。
		// 这类值必须先尝试它自己的 String()，否则会被展开成 [192,168,0,1] 这样的字节数组，
		// 前端与 CSV/JSON 导出都拿不到可读值也无法回灌。
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			return nil
		}
		if rv.Type().Elem().Kind() == reflect.Uint8 {
			if stringer, ok := v.(fmt.Stringer); ok {
				return stringer.String()
			}
			if rv.Kind() == reflect.Slice && rv.CanInterface() {
				return bytesToDisplayValue(rv.Bytes(), "")
			}
		}
		size := rv.Len()
		items := make([]interface{}, size)
		for i := 0; i < size; i++ {
			items[i] = normalizeQueryValue(rv.Index(i).Interface())
		}
		return items
	case reflect.Struct:
		// 部分驱动（如 Kingbase）会返回复杂结构体值，直接透传会导致前端渲染和比较开销激增。
		// 统一降级为可读字符串，避免对象深层序列化触发 UI 卡顿。
		if tm, ok := v.(time.Time); ok {
			return normalizeTemporalValueForDisplay(tm, "", "")
		}
		if stringer, ok := v.(fmt.Stringer); ok {
			return stringer.String()
		}
		// 再试一次「指针接收者」的 Stringer：big.Int 的 String() 定义在 *big.Int 上，
		// 因此 clickhouse-go 对 Int128/UInt128/Int256/UInt256 列返回的 big.Int **值**
		// 不满足上面的值接收者断言，会落到 fmt.Sprintf("%v") 变成
		// `{false [18446744073709551615 9223372036854775807]}` 这样的内部结构体转储，原始数值完全丢失。
		if rv.CanInterface() {
			addressable := reflect.New(rv.Type())
			addressable.Elem().Set(rv)
			if stringer, ok := addressable.Interface().(fmt.Stringer); ok {
				return stringer.String()
			}
		}
		return fmt.Sprintf("%v", v)
	default:
		return normalizeUnsafeIntegerForJS(rv, v)
	}
}

func normalizeJSONNumberForJS(n json.Number) interface{} {
	text := strings.TrimSpace(n.String())
	if text == "" {
		return ""
	}

	if integer, ok := parseJSONInteger(text); ok {
		if integer.Cmp(jsMaxSafeBigInt) > 0 || integer.Cmp(jsMinSafeBigInt) < 0 {
			return text
		}
		return integer.Int64()
	}

	if f, err := n.Float64(); err == nil {
		return f
	}
	return text
}

func parseJSONInteger(text string) (*big.Int, bool) {
	if text == "" {
		return nil, false
	}
	start := 0
	if text[0] == '+' || text[0] == '-' {
		if len(text) == 1 {
			return nil, false
		}
		start = 1
	}
	for i := start; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return nil, false
		}
	}
	value, ok := new(big.Int).SetString(text, 10)
	if !ok {
		return nil, false
	}
	return value, true
}

func mapKeyToString(key interface{}) string {
	if key == nil {
		return "null"
	}
	if s, ok := key.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", key)
}

func bytesToDisplayValue(b []byte, databaseTypeName string) interface{} {
	if b == nil {
		return nil
	}
	if len(b) == 0 {
		return ""
	}

	dbType := strings.ToUpper(strings.TrimSpace(databaseTypeName))
	if isSQLServerUniqueIdentifierType(dbType) {
		var guid mssql.UniqueIdentifier
		if err := guid.Scan(b); err == nil {
			return guid.String()
		}
	}
	if isBitLikeDBType(dbType) {
		if u, ok := bytesToUint64(b); ok {
			// JS number precision is limited; keep large bitmasks as string.
			if u <= jsMaxSafeUint {
				return int64(u)
			}
			return fmt.Sprintf("%d", u)
		}
	}

	if utf8.Valid(b) {
		s := string(b)
		if isMostlyPrintable(s) {
			return s
		}
	}

	// Fallback: some drivers return BIT(1) as []byte{0} / []byte{1} without type info.
	if dbType == "" && len(b) == 1 && (b[0] == 0 || b[0] == 1) {
		return int64(b[0])
	}

	return bytesToReadableString(b)
}

func bytesToReadableString(b []byte) interface{} {
	if b == nil {
		return nil
	}
	if len(b) == 0 {
		return ""
	}
	return "0x" + hex.EncodeToString(b)
}

func isSQLServerUniqueIdentifierType(typeName string) bool {
	return typeName == "UNIQUEIDENTIFIER"
}

func isBitLikeDBType(typeName string) bool {
	if typeName == "" {
		return false
	}
	switch typeName {
	case "BIT", "VARBIT":
		return true
	default:
	}
	return strings.HasPrefix(typeName, "BIT")
}

func bytesToUint64(b []byte) (uint64, bool) {
	if len(b) == 0 || len(b) > 8 {
		return 0, false
	}
	var u uint64
	for _, v := range b {
		u = (u << 8) | uint64(v)
	}
	return u, true
}

func normalizeUnsafeIntegerForJS(rv reflect.Value, original interface{}) interface{} {
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n := rv.Int()
		if n > jsMaxSafeInteger || n < jsMinSafeInteger {
			return strconv.FormatInt(n, 10)
		}
		return original
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		u := rv.Uint()
		if u > jsMaxSafeUint {
			return strconv.FormatUint(u, 10)
		}
		return original
	default:
		return original
	}
}

func isMostlyPrintable(s string) bool {
	if s == "" {
		return true
	}

	total := 0
	printable := 0
	for _, r := range s {
		total++
		switch r {
		case '\n', '\r', '\t':
			printable++
			continue
		default:
		}
		if unicode.IsPrint(r) {
			printable++
		}
	}

	// 允许少量不可见字符，避免把正常文本误判为二进制。
	return printable*100 >= total*90
}
