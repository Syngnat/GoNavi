package dbuser

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
)

// Fingerprint 对脱敏后的计划与影响语句生成的探测结果计算摘要。
//
// Preview 与 Apply 各自独立探测并生成计划；两者指纹一致才允许执行，
// 从而保证用户确认过的语句就是实际执行的语句（口令本身不参与计算）。
func Fingerprint(profile ServerProfile, plan Plan) string {
	var builder strings.Builder
	builder.WriteString(string(profile.Family))
	builder.WriteByte('|')
	builder.WriteString(profile.Flavor)
	builder.WriteByte('|')
	builder.WriteString(profile.Version.Raw)
	builder.WriteByte('|')
	builder.WriteString(strconv.FormatBool(plan.Transactional))
	dialectKeys := make([]string, 0, len(profile.Dialect))
	for key := range profile.Dialect {
		dialectKeys = append(dialectKeys, key)
	}
	sort.Strings(dialectKeys)
	for _, key := range dialectKeys {
		builder.WriteString("|d:")
		builder.WriteString(key)
		builder.WriteByte('=')
		builder.WriteString(profile.Dialect[key])
	}
	for _, statement := range plan.Statements {
		builder.WriteString("\n")
		builder.WriteString(statement.Database)
		builder.WriteByte('\x1f')
		builder.WriteString(strconv.FormatBool(statement.EachNode))
		builder.WriteByte('\x1f')
		builder.WriteString(statement.Display)
	}
	sum := sha256.Sum256([]byte(builder.String()))
	return hex.EncodeToString(sum[:])
}
