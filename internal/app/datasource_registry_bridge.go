package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// app 层对数据源描述表的读取入口。各处历史分支先判断旧类型，未命中时回落到这里，
// 新数据源因此只需在 internal/datasource/specs/<type>.json 声明一次。

// resolveExplainDBType 选择执行计划的方言解析器。有专属解析器的描述表类型按自身类型名分发
// （例如 TiDB 走 MySQL 协议但不支持 FORMAT=JSON）；没有专属解析器、借用方言的类型
// （例如 TimescaleDB 就是 PostgreSQL）沿用借用方言的 EXPLAIN。
func resolveExplainDBType(config connection.ConnectionConfig) string {
	if spec, ok := db.DataSourceSpec(config.Type); ok {
		if isRegistryExplainDialect(spec.Type) || spec.DDLDialect == "" {
			return spec.Type
		}
		return spec.DDLDialect
	}
	return resolveDDLDBType(config)
}

// registryDefaultPort 返回描述表类型的默认端口。
func registryDefaultPort(driverType string) (int, bool) {
	spec, ok := db.DataSourceSpec(driverType)
	if !ok {
		return 0, false
	}
	return spec.DefaultPort, true
}

// registryObjectKind 返回描述表类型在导航树里“表”节点的对象名词。
func registryObjectKind(driverType string) (string, bool) {
	spec, ok := db.DataSourceSpec(driverType)
	if !ok || spec.ObjectKind == "" {
		return "", false
	}
	return spec.ObjectKind, true
}

// registryIdentifiersCaseSensitive 返回描述表类型的对象标识符是否区分大小写。
func registryIdentifiersCaseSensitive(driverType string) (bool, bool) {
	spec, ok := db.DataSourceSpec(driverType)
	if !ok {
		return false, false
	}
	return spec.CaseSensitiveIdentifiers, true
}

// registryProtectionSupported 返回描述表类型是否接入只读/生产保护。
func registryProtectionSupported(driverType string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && spec.Protection
}

// registryDBNameSelectsDatabase 报告导航树选中的库名是否应写入连接配置的 Database。
func registryDBNameSelectsDatabase(driverType string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && !spec.SyntheticDatabase
}

// registryPrefersPlainReadQuery 报告描述表类型的只读查询是否走普通查询接口：只有复用 MySQL 驱动的类型
// （TiDB 等）提供多结果集接口；PostgreSQL 协议（CockroachDB、KWDB、QuestDB 等复用 PostgresDB）、HTTP 协议
// （Weaviate 等一次请求一个结果）与原生协议（ZooKeeper 等）的驱动都与 PostgreSQL 一样逐条查询。
func registryPrefersPlainReadQuery(driverType string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && spec.Wire != "mysql"
}

// registryUsesFlatObjectNames 报告描述表类型的对象名是否整体作为一个标识符（键路径等可能含点），不能按点拆分。
func registryUsesFlatObjectNames(driverType string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && spec.UI.FlatObjectNames
}

// registryUsesBareTableNames 报告描述表类型在 SQL 里是否只写表名：未借用方言的类型（QuestDB、Firebird、GBase 8s
// 与非 SQL 数据源）的库是连接级上下文（虚拟库或连接时选定的库），写成 库.表 会被当成别的对象。
func registryUsesBareTableNames(driverType string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && spec.DDLDialect == ""
}

// registryUsesDriverProxy 报告描述表类型是否由驱动自己处理连接代理（不在主进程改写为本地转发地址）。
func registryUsesDriverProxy(driverType string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && spec.UsesDriverProxy()
}

// registryHidesSchema 报告描述表是否把 schema 声明为扩展内部 schema（侧栏、对象列表与导出都跳过）。
func registryHidesSchema(driverType, schema string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && spec.UI.HidesSchema(schema)
}

// registryHidesExtensionRoutines 报告函数列表是否排除扩展带入的函数（TimescaleDB 在 public 下装了上百个）。
func registryHidesExtensionRoutines(driverType string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && spec.UI.HideExtensionRoutines
}

// registryNotExtensionViewsQuery 列出不属于扩展的视图（GBase 8c 的 orafce 在 public 下建了 dual 等视图）。
const registryNotExtensionViewsQuery = `SELECT n.nspname AS schema_name, c.relname AS object_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') ORDER BY n.nspname, c.relname`

// registryListViewQueries 返回描述表要求排除扩展视图时的视图列表查询。
func registryListViewQueries(driverType string) ([]string, bool) {
	spec, ok := db.DataSourceSpec(driverType)
	if !ok || !spec.UI.HideExtensionViews {
		return nil, false
	}
	return []string{registryNotExtensionViewsQuery}, true
}

// filterRegistryHiddenObjects 去掉描述表声明的扩展内部 schema 下的对象（如 TimescaleDB 的信息视图与内部函数）。
func filterRegistryHiddenObjects(driverType string, objects []connection.DatabaseObject) []connection.DatabaseObject {
	spec, ok := db.DataSourceSpec(driverType)
	if !ok || len(spec.UI.HiddenSchemaPrefixes)+len(spec.UI.HiddenSchemas) == 0 {
		return objects
	}
	visible := make([]connection.DatabaseObject, 0, len(objects))
	for _, object := range objects {
		if !spec.UI.HidesSchema(object.Schema) {
			visible = append(visible, object)
		}
	}
	return visible
}

// registryDriverViewCreateStatement 先让描述表驱动给出视图 DDL（CockroachDB 的 SHOW CREATE、QuestDB / GreptimeDB 的
// SHOW CREATE VIEW、TimescaleDB 连续聚合的 CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)）；
// 驱动给不出 CREATE ... VIEW 语句时返回 false，由调用方回落到方言查询（如 pg_get_viewdef）。
func registryDriverViewCreateStatement(dbInst db.Database, driverType, schemaName, viewName string) (string, bool) {
	if _, ok := db.DataSourceSpec(driverType); !ok {
		return "", false
	}
	ddl, err := dbInst.GetCreateStatement(schemaName, viewName)
	if err != nil || !isCreateViewStatement(ddl) {
		return "", false
	}
	return strings.TrimSpace(ddl), true
}

// isCreateViewStatement 报告 DDL 是否在创建视图（含物化视图，以及 MySQL 的 ALGORITHM / DEFINER 前缀）。
func isCreateViewStatement(ddl string) bool {
	head := strings.ToUpper(strings.TrimSpace(ddl))
	if !strings.HasPrefix(head, "CREATE ") {
		return false
	}
	if end := strings.Index(head, " AS"); end > 0 {
		head = head[:end]
	}
	return strings.Contains(head+" ", " VIEW ")
}

// registryUsesBooleanKeywords 报告自有方言的描述表类型是否只接受 TRUE / FALSE 布尔字面量
// （QuestDB、GreptimeDB、Firebird 3+ 不会把 1 / 0 写进布尔列），SQL 导出与导入据此输出布尔值。
func registryUsesBooleanKeywords(dbType string) bool {
	spec, ok := db.DataSourceSpec(dbType)
	if !ok || spec.DDLDialect != "" {
		return false
	}
	switch spec.Type {
	case "questdb", "greptimedb", "firebird":
		return true
	default:
		return false
	}
}

// oracleObjectMissingSQLCode 是 Oracle 系“表或视图不存在”的 SQLCODE：Oracle 为 -942（ORA-00942），
// 借用 Oracle 方言的崖山为 2012（YAS-02012，崖山的 SQLCODE 是正数）。SQL 备份里的删除保护块据此忽略对象不存在的错误。
func oracleObjectMissingSQLCode(config connection.ConnectionConfig) int {
	if spec, ok := db.DataSourceSpec(config.Type); ok && spec.Type == "yashandb" {
		return 2012
	}
	return -942
}
