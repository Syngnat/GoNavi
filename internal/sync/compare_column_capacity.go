package sync

import (
	"regexp"
	"strings"
)

// TEXT 族内部的容量次序。降级（数值变小）不会让建表失败，但存量数据超过
// 新上限会被截断，所以要单独成一种差异，而不是混在「类型不同」里。
var textFamilyCapacity = map[string]int{
	"tinytext":   1,
	"text":       2,
	"mediumtext": 3,
	"longtext":   4,
}

// varcharCapacityPattern 提取 varchar(n)/char(n) 的长度上限，仅用于生成
// 「varchar(200) → varchar(50)」这类可读的方向描述；判定不走它，因为字符型
// 收窄属于类型变更而非容量降级。
var varcharCapacityPattern = regexp.MustCompile(`(?i)^(?:var)?char\s*\(\s*(\d+)\s*\)`)

// ColumnDiffCapacityDegraded 表示目标列容量小于源列。
const ColumnDiffCapacityDegraded = "capacity_degraded"

// textFamilyRank 返回列类型在 TEXT 族内的容量等级；不在族内返回 0。
func textFamilyRank(rawType string) int {
	base := strings.ToLower(strings.TrimSpace(rawType))
	// 去掉长度/字符集修饰，只留类型名。
	if index := strings.IndexAny(base, " ("); index >= 0 {
		base = strings.TrimSpace(base[:index])
	}
	return textFamilyCapacity[base]
}

// varcharCapacity 返回 varchar/char 的长度上限；非该类类型返回 0。
func varcharCapacity(rawType string) int {
	match := varcharCapacityPattern.FindStringSubmatch(strings.TrimSpace(rawType))
	if len(match) != 2 {
		return 0
	}
	total := 0
	for _, digit := range match[1] {
		total = total*10 + int(digit-'0')
	}
	return total
}

// isWithinFamilyCapacityShrink 判断是否为「TEXT 族内部的容量缩小」。
//
// 只有 TEXT 族内部才算容量降级：varchar(200) → varchar(50) 这类字符型收窄
// 会直接导致建表或写入失败，属于高风险的类型变更；varchar ↔ text 则是族
// 切换，截断语义完全不同，同样按类型变更处理。
func isWithinFamilyCapacityShrink(sourceType, targetType string) bool {
	sourceRank := textFamilyRank(sourceType)
	targetRank := textFamilyRank(targetType)
	return sourceRank > 0 && targetRank > 0 && targetRank < sourceRank
}

// isWithinFamilyCapacityGrowth 判断是否为 TEXT 族内部的扩容（低风险）。
func isWithinFamilyCapacityGrowth(sourceType, targetType string) bool {
	sourceRank := textFamilyRank(sourceType)
	targetRank := textFamilyRank(targetType)
	return sourceRank > 0 && targetRank > 0 && targetRank > sourceRank
}

// describeCapacityDirection 生成「longtext → mediumtext」这类方向描述。
func describeCapacityDirection(sourceType, targetType string) string {
	return strings.TrimSpace(sourceType) + " → " + strings.TrimSpace(targetType)
}
