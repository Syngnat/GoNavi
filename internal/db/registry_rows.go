//go:build gonavi_full_drivers || gonavi_cockroachdb_driver || gonavi_kwdb_driver || gonavi_questdb_driver || gonavi_greptimedb_driver || gonavi_timescaledb_driver || gonavi_presto_driver

package db

import (
	"fmt"
	"strings"
)

// 描述表驱动读取原生元数据语句（SHOW COLUMNS、tables() 等）结果行时共用的小工具：
// 这些语句的列名大小写随服务端版本变化，布尔列可能是 bool 也可能是 "t"/"true" 文本。

// firstMapValueOf 按候选列名（不区分大小写）取第一处匹配的值。
func firstMapValueOf(row map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		for name, value := range row {
			if strings.EqualFold(name, key) {
				return value
			}
		}
	}
	return nil
}

// rowText 取列值的去空白文本，NULL 返回空串。
func rowText(row map[string]interface{}, keys ...string) string {
	value := firstMapValueOf(row, keys...)
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func isTruthy(value interface{}) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case nil:
		return false
	default:
		text := strings.ToLower(strings.TrimSpace(fmt.Sprint(typed)))
		return text == "true" || text == "t" || text == "yes" || text == "1"
	}
}

func yesNo(value bool) string {
	if value {
		return "YES"
	}
	return "NO"
}
