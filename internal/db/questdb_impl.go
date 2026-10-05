//go:build gonavi_full_drivers || gonavi_questdb_driver

package db

import (
	"context"
	"regexp"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

const (
	defaultQuestDBPort     = 8812
	defaultQuestDBDatabase = "qdb"
)

var questDBBuildVersionPattern = regexp.MustCompile(`(?i)QuestDB\s+v?(\d+(?:\.\d+)*)`)

// QuestDB 通过 PostgreSQL 协议接入 QuestDB。QuestDB 没有 schema、外键、触发器与存储过程，
// PostgreSQL 系统表也只实现了一部分，元数据改用 SHOW TABLES / SHOW COLUMNS / tables() 等原生语句。
type QuestDB struct {
	PostgresDB
	driverVariantState
}

var (
	_ Database              = (*QuestDB)(nil)
	_ DriverVariantReporter = (*QuestDB)(nil)
)

func (q *QuestDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&q.PostgresDB, ctx)
}

func (q *QuestDB) clearMetadataContext() {
	ClearMetadataContext(&q.PostgresDB)
}

// Connect 复用 PostgreSQL 连接链路（SSL、SSH、代理），默认端口 8812、库 qdb，并按 build() 识别版本确定档位。
func (q *QuestDB) Connect(config connection.ConnectionConfig) error {
	runConfig := withQuestDBDefaults(rewriteURIScheme(config, "postgresql", "questdb"))
	if err := q.PostgresDB.Connect(runConfig); err != nil {
		return err
	}
	version := ""
	if rows, _, err := q.PostgresDB.Query("SELECT build() AS version"); err == nil {
		version = parseQuestDBVersion(FirstQueryRowValue(rows))
	} else {
		logger.Warnf("QuestDB 版本识别失败：%v", err)
	}
	if err := q.resolve("questdb", config, version); err != nil {
		_ = q.PostgresDB.Close()
		return err
	}
	return nil
}

// withQuestDBDefaults 补齐端口与库名，并在用户没有指定时写入 search_path=public：
// QuestDB 不支持 PostgresDB 拼装 search_path 时用到的 LIKE ... ESCAPE，显式给出后会跳过那一步。
func withQuestDBDefaults(config connection.ConnectionConfig) connection.ConnectionConfig {
	if config.Port <= 0 {
		config.Port = defaultQuestDBPort
	}
	if strings.TrimSpace(config.Database) == "" {
		config.Database = defaultQuestDBDatabase
	}
	return withDefaultSearchPath(config, "public")
}

// parseQuestDBVersion 从 "Build Information: QuestDB 8.3.3, JDK 17.0.11, ..." 里取版本号。
// version() 只返回 PostgreSQL 兼容串，不含 QuestDB 版本，所以必须用 build()。
func parseQuestDBVersion(banner string) string {
	match := questDBBuildVersionPattern.FindStringSubmatch(banner)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

// GetDatabases 返回 pg_database 里的库（QuestDB 只有一个，默认 qdb）。
func (q *QuestDB) GetDatabases() ([]string, error) {
	rows, _, err := q.PostgresDB.Query("SELECT datname FROM pg_database")
	if err != nil || len(rows) == 0 {
		return []string{defaultQuestDBDatabase}, nil
	}
	databases := make([]string, 0, len(rows))
	for _, row := range rows {
		if name := rowText(row, "datname"); name != "" {
			databases = append(databases, name)
		}
	}
	return databases, nil
}

// GetTables 返回普通表；视图与物化视图（SHOW TABLES 也会列出）由前端视图分组展示。
func (q *QuestDB) GetTables(string) ([]string, error) {
	rows, _, err := q.PostgresDB.Query("SHOW TABLES")
	if err != nil {
		return nil, err
	}
	views := q.viewNames()
	tables := make([]string, 0, len(rows))
	for _, row := range rows {
		name := rowText(row, "table_name", "table")
		if name == "" {
			continue
		}
		if _, isView := views[strings.ToLower(name)]; isView {
			continue
		}
		tables = append(tables, name)
	}
	sort.Strings(tables)
	return tables, nil
}

// questDBObjectKind 区分普通表、视图（10.x 起）与物化视图（8.3 起），DDL 语句不同。
type questDBObjectKind int

const (
	questDBTable questDBObjectKind = iota
	questDBView
	questDBMaterializedView
)

func (q *QuestDB) viewNames() map[string]questDBObjectKind {
	names := map[string]questDBObjectKind{}
	if q.atLeast("10.0") {
		q.collectViewNames(names, "SELECT view_name FROM views()", questDBView)
	}
	if q.atLeast("8.3") {
		q.collectViewNames(names, "SELECT view_name FROM materialized_views()", questDBMaterializedView)
	}
	return names
}

func (q *QuestDB) collectViewNames(names map[string]questDBObjectKind, query string, kind questDBObjectKind) {
	rows, _, err := q.PostgresDB.Query(query)
	if err != nil {
		logger.Warnf("QuestDB 视图列表不可用：%v", err)
		return
	}
	for _, row := range rows {
		if name := rowText(row, "view_name"); name != "" {
			names[strings.ToLower(name)] = kind
		}
	}
}

func (q *QuestDB) objectKind(name string) questDBObjectKind {
	return q.viewNames()[strings.ToLower(strings.TrimSpace(name))]
}

// GetForeignKeys QuestDB 没有外键。
func (q *QuestDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

// GetTriggers QuestDB 没有触发器。
func (q *QuestDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

// GetTableComment QuestDB 没有表注释。
func (q *QuestDB) GetTableComment(string, string) (string, error) {
	return "", nil
}

// ApplyChangesContext 只接受新增（导入数据、跨库迁移）：QuestDB 没有主键也不支持 DELETE，按行改写无法
// 定位到唯一一行，修改与删除请在 SQL 编辑器里写 UPDATE。新增逐行 INSERT（旧版本不支持多行 VALUES）。
func (q *QuestDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	reject := localizedDatabaseRuntimeError("db.backend.error.questdb_row_edit_unsupported", nil)
	if len(changes.Updates) > 0 || len(changes.Deletes) > 0 {
		return reject
	}
	columns, _ := q.GetColumns("", tableName)
	return applyInsertOnlyChanges(ctx, q.PostgresDB.ExecContext, columns, tableName, changes, insertOnlyDialect{
		quoteTable:       quoteQuestDBIdentifier,
		quoteIdent:       quoteQuestDBIdentifier,
		rowsPerStatement: 1,
	}, reject)
}

// ApplyChanges 与 ApplyChangesContext 保持一致。
func (q *QuestDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return q.ApplyChangesContext(context.Background(), tableName, changes)
}

// quoteQuestDBIdentifier 用双引号引用表名/列名（QuestDB 标识符不区分大小写）。
func quoteQuestDBIdentifier(name string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(name), `"`, `""`) + `"`
}

func quoteQuestDBLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
