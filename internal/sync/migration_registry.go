package sync

import "GoNavi-Wails/internal/datasource"

// registryMigrationDBType 把描述表类型映射到同步内核认识的方言：
// 声明了兼容 DDL 方言（如 TiDB → mysql）的类型完全复用该方言的读写与类型映射，
// 与 GoldenDB 归一为 mysql 的做法一致；其余类型保持自身类型名。
func registryMigrationDBType(normalized string) string {
	spec, ok := datasource.Lookup(normalized)
	if !ok {
		return normalized
	}
	if spec.Sync != nil && spec.DDLDialect != "" {
		return spec.DDLDialect
	}
	return spec.Type
}

// registryMigrationEndpoint 报告描述表类型能否作为同步源 / 目标（仅对未映射到兼容方言的类型生效）。
func registryMigrationEndpoint(dbType string, target bool) bool {
	spec, ok := datasource.Lookup(dbType)
	if !ok || spec.Sync == nil {
		return false
	}
	if target {
		return spec.Sync.Target
	}
	return spec.Sync.Source
}
