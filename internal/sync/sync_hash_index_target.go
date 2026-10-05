package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// targetNeedsHashOnlyIndexes 报告目标库是否只支持 HASH 普通索引（描述表 sync.hashIndexesOnly）。
func targetNeedsHashOnlyIndexes(target connection.ConnectionConfig) bool {
	spec, ok := db.DataSourceSpec(target.Type)
	return ok && spec.Sync != nil && spec.Sync.HashIndexesOnly
}

// withHashOnlyIndexTargetGuard 改写建索引语句以适配只支持 HASH 普通索引的目标库（如 GBase 8a）：
// 普通索引补上 USING HASH，唯一索引跳过并写进警告（目标库不支持唯一约束，数据照常迁移）。
func withHashOnlyIndexTargetGuard(config SyncConfig, plan SchemaMigrationPlan) SchemaMigrationPlan {
	if len(plan.PostDataSQL) == 0 || !targetNeedsHashOnlyIndexes(config.TargetConfig) {
		return plan
	}
	kept := make([]string, 0, len(plan.PostDataSQL))
	for _, statement := range plan.PostDataSQL {
		upper := strings.ToUpper(strings.Join(strings.Fields(statement), " "))
		switch {
		case strings.HasPrefix(upper, "CREATE UNIQUE INDEX"):
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标库不支持唯一索引，已跳过（数据照常迁移）：%s", statement))
			if plan.IndexesToCreate > 0 {
				plan.IndexesToCreate--
			}
			plan.IndexesSkipped++
		case strings.HasPrefix(upper, "CREATE INDEX") && !strings.Contains(upper, " USING "):
			kept = append(kept, strings.TrimRight(strings.TrimSpace(statement), ";")+" USING HASH")
		default:
			kept = append(kept, statement)
		}
	}
	plan.PostDataSQL = kept
	return plan
}
