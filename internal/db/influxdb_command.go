package db

import (
	"regexp"
	"strings"
)

// 控制台命令识别不依赖驱动代理：app 层按它区分 InfluxDB 的 Flux 读写（InfluxQL 与 SQL 走通用 SQL 规则）。

var influxFluxWriteCall = regexp.MustCompile(`(?i)(^|[^A-Za-z0-9_])(to|wideTo)\s*\(`)

// IsInfluxFluxQuery 识别 Flux：以 import 或 from( 开头，或含管道符 |>（InfluxQL 与 SQL 都不会这样写）。
func IsInfluxFluxQuery(text string) bool {
	trimmed := strings.TrimSpace(text)
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "import ") || strings.HasPrefix(lower, "import\t") || strings.HasPrefix(lower, "import\"") {
		return true
	}
	if strings.HasPrefix(lower, "from(") || strings.HasPrefix(lower, "from (") {
		return true
	}
	return strings.Contains(trimmed, "|>")
}

// InfluxFluxQueryWrites 报告 Flux 是否写数据：to() / experimental.to() / wideTo() 会把结果写回 bucket 或外部库。
func InfluxFluxQueryWrites(text string) bool {
	return influxFluxWriteCall.MatchString(text)
}
