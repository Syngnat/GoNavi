package app

import (
	"strings"
	"time"
)

// formatOracleTemporalSQLValue 把 Oracle 方言（Oracle、OceanBase Oracle 模式、崖山）DATE / TIMESTAMP 列的值写成
// TO_DATE / TO_TIMESTAMP：隐式转换依赖会话的 NLS 格式（Oracle 默认 DD-MON-RR，崖山 DATE 默认 YYYY-MM-DD），
// 备份在别的会话里恢复时会报“literal does not match format string”。带时区的 TIMESTAMP 保持原样。
func formatOracleTemporalSQLValue(dbType, columnType string, value interface{}) (string, bool) {
	if strings.ToLower(strings.TrimSpace(dbType)) != "oracle" {
		return "", false
	}
	typ := strings.ToLower(strings.TrimSpace(columnType))
	isDate := typ == "date"
	isTimestamp := strings.HasPrefix(typ, "timestamp") && !strings.Contains(typ, "zone")
	if !isDate && !isTimestamp {
		return "", false
	}
	var parsed time.Time
	switch v := value.(type) {
	case time.Time:
		parsed = v
	case string:
		t, ok := parseTemporalString(v)
		if !ok {
			return "", false
		}
		parsed = t
	default:
		return "", false
	}
	if isDate {
		return "TO_DATE('" + parsed.Format("2006-01-02 15:04:05") + "', 'YYYY-MM-DD HH24:MI:SS')", true
	}
	if parsed.Nanosecond() == 0 {
		return "TO_TIMESTAMP('" + parsed.Format("2006-01-02 15:04:05") + "', 'YYYY-MM-DD HH24:MI:SS')", true
	}
	return "TO_TIMESTAMP('" + parsed.Format("2006-01-02 15:04:05.000000") + "', 'YYYY-MM-DD HH24:MI:SS.FF6')", true
}
