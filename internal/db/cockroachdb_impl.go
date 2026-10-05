//go:build gonavi_full_drivers || gonavi_cockroachdb_driver || gonavi_kwdb_driver

package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

const defaultCockroachPort = 26257

// cockroachDefaultSearchPath 与 CockroachDB / KWDB 会话默认值一致。显式写入后 PostgresDB 不再把库里全部
// schema（含 crdb_internal / kwdb_internal）拼成 search_path，编辑器的默认 schema 保持为 public。
const cockroachDefaultSearchPath = "$user,public"

// cockroachFlavor 区分 CockroachDB 与基于其早期版本的 KWDB：内部 schema 名、
// URI scheme 与元数据语句的可用性不同。
type cockroachFlavor struct {
	registryType   string
	internalSchema string
	uriSchemes     []string
	// showMetadata 为 true 时列与索引改用 SHOW COLUMNS / SHOW INDEXES：
	// KWDB 不支持 PostgreSQL 驱动元数据查询里的 pg_attribute / pg_index 写法。
	showMetadata bool
}

var cockroachDBFlavor = cockroachFlavor{
	registryType:   "cockroachdb",
	internalSchema: "crdb_internal",
	uriSchemes:     []string{"cockroachdb", "cockroach", "crdb"},
}

// CockroachDB 通过 PostgreSQL 协议接入 CockroachDB，DDL 使用原生 SHOW CREATE TABLE，
// 并隐藏 crdb_internal 等内部 schema。
type CockroachDB struct {
	PostgresDB
	driverVariantState
	flavor *cockroachFlavor
}

var (
	_ Database              = (*CockroachDB)(nil)
	_ DriverVariantReporter = (*CockroachDB)(nil)
)

func (c *CockroachDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&c.PostgresDB, ctx)
}

func (c *CockroachDB) clearMetadataContext() {
	ClearMetadataContext(&c.PostgresDB)
}

func (c *CockroachDB) currentFlavor() cockroachFlavor {
	if c.flavor != nil {
		return *c.flavor
	}
	return cockroachDBFlavor
}

// Connect 复用 PostgreSQL 连接链路（SSL、SSH、代理），默认端口 26257，并识别服务端版本确定档位。
func (c *CockroachDB) Connect(config connection.ConnectionConfig) error {
	flavor := c.currentFlavor()
	runConfig := withCockroachSearchPath(rewriteURIScheme(config, "postgresql", flavor.uriSchemes...))
	if runConfig.Port <= 0 {
		runConfig.Port = defaultCockroachPort
	}
	if err := c.PostgresDB.Connect(runConfig); err != nil {
		return err
	}
	version := ""
	if rows, _, err := c.PostgresDB.Query("SELECT version() AS version"); err == nil {
		version = extractCockroachVersion(FirstQueryRowValue(rows))
	} else {
		logger.Warnf("%s 版本识别失败：%v", driverDisplayName(flavor.registryType), err)
	}
	if err := c.resolve(flavor.registryType, config, version); err != nil {
		_ = c.PostgresDB.Close()
		return err
	}
	return nil
}

// withCockroachSearchPath 在用户没有通过连接参数或 URI 指定 search_path 时写入会话默认值。
func withCockroachSearchPath(config connection.ConnectionConfig) connection.ConnectionConfig {
	return withDefaultSearchPath(config, cockroachDefaultSearchPath)
}

// extractCockroachVersion 从 "CockroachDB CCL v24.3.36 (x86_64-...)"、"KaiwuDB 3.2.2 (...)" 里取版本号。
func extractCockroachVersion(banner string) string {
	for _, field := range strings.Fields(banner) {
		candidate := strings.TrimPrefix(strings.TrimPrefix(field, "v"), "V")
		if candidate != "" && candidate[0] >= '0' && candidate[0] <= '9' {
			return strings.TrimRight(candidate, ",")
		}
	}
	return ""
}

func (c *CockroachDB) hiddenSchemas() string {
	return fmt.Sprintf("'information_schema', 'pg_catalog', 'pg_extension', '%s'", c.currentFlavor().internalSchema)
}

// GetTables 返回 schema.table 形式的普通表与时序表，内部 schema 不列出。
func (c *CockroachDB) GetTables(string) ([]string, error) {
	query := fmt.Sprintf(`SELECT table_schema AS schemaname, table_name AS tablename
FROM information_schema.tables
WHERE table_type IN ('BASE TABLE', 'TIME SERIES TABLE')
  AND table_schema NOT IN (%s)
ORDER BY 1, 2`, c.hiddenSchemas())
	rows, _, err := c.PostgresDB.Query(query)
	if err != nil {
		return nil, err
	}
	return parsePostgresTableNames(rows), nil
}

// GetAllColumns 复用 PostgreSQL 实现并剔除内部 schema 的列。
func (c *CockroachDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	columns, err := c.PostgresDB.GetAllColumns(dbName)
	if err != nil {
		return nil, err
	}
	prefix := c.currentFlavor().internalSchema + "."
	filtered := columns[:0]
	for _, column := range columns {
		if strings.HasPrefix(column.TableName, prefix) || strings.HasPrefix(column.TableName, "pg_extension.") {
			continue
		}
		filtered = append(filtered, column)
	}
	return filtered, nil
}

func quoteCockroachIdent(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

func (c *CockroachDB) qualifiedTable(schemaName, tableName string) (string, error) {
	schema, table := normalizePGLikeMetadataTable(schemaName, tableName)
	if table == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	if schema == "" {
		return quoteCockroachIdent(table), nil
	}
	return quoteCockroachIdent(schema) + "." + quoteCockroachIdent(table), nil
}

// GetCreateStatement 使用服务端 SHOW CREATE TABLE，保留列族、哈希分片索引、时序表 TAGS 等原生语法。
func (c *CockroachDB) GetCreateStatement(schemaName, tableName string) (string, error) {
	qualified, err := c.qualifiedTable(schemaName, tableName)
	if err != nil {
		return "", err
	}
	rows, _, err := c.PostgresDB.Query("SHOW CREATE TABLE " + qualified)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", fmt.Errorf("SHOW CREATE TABLE %s returned no rows", qualified)
	}
	return strings.TrimSpace(fmt.Sprint(firstMapValueOf(rows[0], "create_statement", "CreateStatement"))), nil
}

// GetTriggers CockroachDB 24.3 起才有触发器；更早的版本与不支持 information_schema.triggers 的
// 服务端（如 KWDB）返回空列表。
func (c *CockroachDB) GetTriggers(schemaName, tableName string) ([]connection.TriggerDefinition, error) {
	if c.currentFlavor().registryType == "cockroachdb" && !c.atLeast("24.3") {
		return []connection.TriggerDefinition{}, nil
	}
	triggers, err := c.PostgresDB.GetTriggers(schemaName, tableName)
	if err != nil {
		logger.Warnf("%s 触发器元数据不可用，按无触发器处理：%v", driverDisplayName(c.currentFlavor().registryType), err)
		return []connection.TriggerDefinition{}, nil
	}
	return triggers, nil
}
