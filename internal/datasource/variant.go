package datasource

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var serverVersionPattern = regexp.MustCompile(`\d+(?:\.\d+)*`)

// ParseServerVersion 从服务端版本串里取第一个数字段，如 "v24.3.36"、
// "CockroachDB CCL v24.3.36 (x86_64)" 都得到 [24 3 36]。取不到时返回 nil。
func ParseServerVersion(text string) []int {
	match := serverVersionPattern.FindString(text)
	if match == "" {
		return nil
	}
	parts := strings.Split(match, ".")
	numbers := make([]int, 0, len(parts))
	for _, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil {
			return nil
		}
		numbers = append(numbers, value)
	}
	return numbers
}

// CompareServerVersions 比较两个版本串，缺失的段按 0 处理。
// 任一侧解析失败时按字符串比较，保证结果确定。
func CompareServerVersions(left, right string) int {
	a, b := ParseServerVersion(left), ParseServerVersion(right)
	if a == nil || b == nil {
		return strings.Compare(left, right)
	}
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// Contains 报告服务端版本是否落在档位区间 [MinServer, MaxServer) 内。
func (v Variant) Contains(serverVersion string) bool {
	if v.MinServer != "" && CompareServerVersions(serverVersion, v.MinServer) < 0 {
		return false
	}
	if v.MaxServer != "" && CompareServerVersions(serverVersion, v.MaxServer) >= 0 {
		return false
	}
	return true
}

// RequestedVariant 归一用户在连接上选择的档位：空值表示使用数据源默认档位。
func (s Spec) RequestedVariant(requested string) string {
	value := normalizeName(requested)
	if value == "" {
		return s.Variants.Default
	}
	return value
}

// ResolveVariant 把连接上选择的档位与服务端自报版本解析为具体档位。
// 自动识别时版本落在区间外：低于最旧档位用最旧档位，其余用最新档位。
func (s Spec) ResolveVariant(requested, serverVersion string) (Variant, error) {
	selected := s.RequestedVariant(requested)
	if selected != VariantAuto {
		item, ok := s.Variants.Item(selected)
		if !ok {
			return Variant{}, fmt.Errorf("%s does not declare driver variant %q", s.DisplayName, requested)
		}
		return item, nil
	}
	if !s.Variants.Auto {
		return Variant{}, fmt.Errorf("%s does not support automatic driver variant selection", s.DisplayName)
	}
	if item, ok := s.MatchVariant(serverVersion); ok {
		return item, nil
	}
	return s.Variants.Items[len(s.Variants.Items)-1], nil
}

// MatchVariant 返回服务端版本适用的档位：按区间匹配，低于最旧档位取最旧档位，其余取最新档位。
// 版本为空或无法解析时返回 false。
func (s Spec) MatchVariant(serverVersion string) (Variant, bool) {
	items := s.Variants.Items
	if len(items) == 0 || strings.TrimSpace(serverVersion) == "" || ParseServerVersion(serverVersion) == nil {
		return Variant{}, false
	}
	for _, item := range items {
		if item.Contains(serverVersion) {
			return item, true
		}
	}
	if first := items[0]; first.MinServer != "" && CompareServerVersions(serverVersion, first.MinServer) < 0 {
		return first, true
	}
	return items[len(items)-1], true
}
