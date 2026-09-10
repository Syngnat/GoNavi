//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"database/sql"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestApplySQLiteAutoIncrement 锁住 AUTOINCREMENT 的识别规则：
// 只从建表 SQL 识别（PRAGMA table_info 不回显），且只对单列主键生效。
func TestApplySQLiteAutoIncrement(t *testing.T) {
	t.Parallel()

	single := []connection.ColumnDefinition{
		{Name: "id", Type: "INTEGER", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "TEXT", Nullable: "YES"},
	}
	applySQLiteAutoIncrement(single, "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)")
	if single[0].Extra != "auto_increment" {
		t.Fatalf("AUTOINCREMENT 主键未标记 auto_increment: %q", single[0].Extra)
	}
	if single[1].Extra != "" {
		t.Fatalf("非主键列被误标记自增: %q", single[1].Extra)
	}

	plain := []connection.ColumnDefinition{{Name: "id", Type: "INTEGER", Key: "PRI"}}
	applySQLiteAutoIncrement(plain, "CREATE TABLE t (id INTEGER PRIMARY KEY)")
	if plain[0].Extra != "" {
		t.Fatalf("无 AUTOINCREMENT 却标记了自增: %q", plain[0].Extra)
	}

	// 复合主键的 DDL 里不会出现 AUTOINCREMENT，按主键列数守卫兜底。
	composite := []connection.ColumnDefinition{
		{Name: "a", Type: "INTEGER", Key: "PRI"},
		{Name: "b", Type: "INTEGER", Key: "PRI"},
	}
	applySQLiteAutoIncrement(composite, "CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY(a, b))")
	for _, col := range composite {
		if col.Extra != "" {
			t.Fatalf("复合主键不应标记自增: %s=%q", col.Name, col.Extra)
		}
	}

	// 即便 DDL 文本碰巧匹配 AUTOINCREMENT，只要 PRI 列多于 1 列就不得打自增标记。
	guarded := []connection.ColumnDefinition{
		{Name: "a", Type: "INTEGER", Key: "PRI"},
		{Name: "b", Type: "INTEGER", Key: "PRI"},
	}
	applySQLiteAutoIncrement(guarded, "CREATE TABLE t (a INTEGER PRIMARY KEY AUTOINCREMENT, b INTEGER)")
	for _, col := range guarded {
		if col.Extra != "" {
			t.Fatalf("复合主键列数守卫失效: %s=%q", col.Name, col.Extra)
		}
	}

	noPK := []connection.ColumnDefinition{{Name: "id", Type: "INTEGER"}}
	applySQLiteAutoIncrement(noPK, "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)")
	if noPK[0].Extra != "" {
		t.Fatalf("无 PRI 列不应标记自增: %q", noPK[0].Extra)
	}

	// 空 DDL（虚拟表等拿不到建表 SQL 的场景）必须原样返回。
	untouched := []connection.ColumnDefinition{{Name: "id", Type: "INTEGER", Key: "PRI"}}
	applySQLiteAutoIncrement(untouched, "")
	if untouched[0].Extra != "" {
		t.Fatalf("空 DDL 不应改动元数据: %q", untouched[0].Extra)
	}
}

// TestApplySQLiteAutoIncrementIgnoresLiteralsAndComments 锁住关键字匹配
// 必须只认真实约束序列：字符串字面量、行/块注释、引号标识符里出现
// AUTOINCREMENT 都不构成约束，不得把普通主键误标成自增。
func TestApplySQLiteAutoIncrementIgnoresLiteralsAndComments(t *testing.T) {
	t.Parallel()

	// applySQLiteAutoIncrement 会改写入参切片且不复位旧标记：断言若复用
	// 同一切片，前面的正向断言会把 Extra 留成 auto_increment，让后面的
	// 负向断言读到旧标记而误报、后面的正向断言恒真。每条断言都用新切片。
	newCols := func() []connection.ColumnDefinition {
		return []connection.ColumnDefinition{
			{Name: "id", Type: "INTEGER", Key: "PRI"},
			{Name: "note", Type: "TEXT"},
		}
	}

	// 字面量里的 AUTOINCREMENT：普通主键，不得标记。
	got := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'AUTOINCREMENT')")
	if got[0].Extra != "" {
		t.Fatalf("字面量中的关键字误触发自增标记: %+v", got[0])
	}

	// 行注释里的 AUTOINCREMENT：同样不得触发。
	gotComment := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY, -- AUTOINCREMENT legacy flag\n note TEXT)")
	if gotComment[0].Extra != "" {
		t.Fatalf("行注释中的关键字误触发自增标记: %+v", gotComment[0])
	}

	// 块注释里的 AUTOINCREMENT：不得触发。
	gotBlockComment := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY /* AUTOINCREMENT */, note TEXT)")
	if gotBlockComment[0].Extra != "" {
		t.Fatalf("块注释中的关键字误触发自增标记: %+v", gotBlockComment[0])
	}

	// 引号标识符（三种写法）命名为 AUTOINCREMENT 的普通列：不得触发。
	for label, ddl := range map[string]string{
		"双引号": `CREATE TABLE t (id INTEGER PRIMARY KEY, "AUTOINCREMENT" TEXT)`,
		"反引号": "CREATE TABLE t (id INTEGER PRIMARY KEY, `AUTOINCREMENT` TEXT)",
		"方括号": "CREATE TABLE t (id INTEGER PRIMARY KEY, [AUTOINCREMENT] TEXT)",
	} {
		gotIdent := applySQLiteAutoIncrement(newCols(), ddl)
		if gotIdent[0].Extra != "" {
			t.Fatalf("%s 标识符中的关键字误触发自增标记: %+v", label, gotIdent[0])
		}
	}

	// 未闭合引号按保守方式吞掉尾部：关键字不得触发。
	gotUnterminated := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'AUTOINCREMENT)")
	if gotUnterminated[0].Extra != "" {
		t.Fatalf("未闭合字面量中的关键字误触发自增标记: %+v", gotUnterminated[0])
	}

	// 真正的 AUTOINCREMENT 主键仍要标记。
	gotReal := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT DEFAULT 'x')")
	if gotReal[0].Extra != "auto_increment" {
		t.Fatalf("真实 AUTOINCREMENT 主键未被标记: %+v", gotReal[0])
	}

	// PRIMARY KEY DESC AUTOINCREMENT（合法形态：中间可隔 ASC/DESC）。
	gotDesc := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY DESC AUTOINCREMENT, note TEXT)")
	if gotDesc[0].Extra != "auto_increment" {
		t.Fatalf("PRIMARY KEY DESC AUTOINCREMENT 未被标记: %+v", gotDesc[0])
	}

	// PRIMARY KEY 带冲突子句再接 AUTOINCREMENT：SQLite 官方语法
	// PRIMARY KEY [ASC|DESC] [ON CONFLICT <动作>] AUTOINCREMENT 均合法，
	// 五种冲突动作都要识别，不得在 ON 处提前终止扫描。
	for _, action := range []string{"ROLLBACK", "ABORT", "FAIL", "IGNORE", "REPLACE"} {
		ddl := "CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT " + action + " AUTOINCREMENT, note TEXT)"
		gotConflict := applySQLiteAutoIncrement(newCols(), ddl)
		if gotConflict[0].Extra != "auto_increment" {
			t.Fatalf("PRIMARY KEY ON CONFLICT %s AUTOINCREMENT 未被标记: %+v", action, gotConflict[0])
		}
	}
	gotConflictAsc := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY ASC ON CONFLICT ABORT AUTOINCREMENT, note TEXT)")
	if gotConflictAsc[0].Extra != "auto_increment" {
		t.Fatalf("PRIMARY KEY ASC ON CONFLICT ABORT AUTOINCREMENT 未被标记: %+v", gotConflictAsc[0])
	}

	// 邻近干扰：真主键之前有引号列名 "primary" 和裸词列名 key（真实引擎
	// 验证过该 DDL 合法），词序列匹配不得被它们带偏。
	gotNoisyNeighborhood := applySQLiteAutoIncrement(newCols(),
		`CREATE TABLE t ("primary" TEXT, key TEXT, id INTEGER PRIMARY KEY AUTOINCREMENT)`)
	if gotNoisyNeighborhood[0].Extra != "auto_increment" {
		t.Fatalf("邻近干扰场景下的 AUTOINCREMENT 主键未被标记: %+v", gotNoisyNeighborhood[0])
	}

	// 只有冲突子句没有 AUTOINCREMENT 的主键：不得标记。
	gotConflictOnly := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, note TEXT)")
	if gotConflictOnly[0].Extra != "" {
		t.Fatalf("仅带冲突子句的主键被误标记自增: %+v", gotConflictOnly[0])
	}

	// 表级复合主键带冲突子句：括号列名不是合法修饰词序列，不得标记。
	gotComposite := applySQLiteAutoIncrement([]connection.ColumnDefinition{
		{Name: "a", Type: "INTEGER", Key: "PRI"},
		{Name: "b", Type: "INTEGER", Key: "PRI"},
	}, "CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY(a, b) ON CONFLICT ABORT)")
	if gotComposite[0].Extra != "" {
		t.Fatalf("表级复合主键被误标记自增: %+v", gotComposite[0])
	}

	// 尾部随行约束（PRIMARY KEY AUTOINCREMENT 后还有其他列）也能识别。
	gotTail := applySQLiteAutoIncrement(newCols(),
		"CREATE TABLE t (note TEXT, id INTEGER PRIMARY KEY AUTOINCREMENT)")
	if gotTail[0].Extra != "auto_increment" {
		t.Fatalf("末列 AUTOINCREMENT 主键未被标记: %+v", gotTail[0])
	}
}

// TestSQLiteAutoIncrementAgainstRealDDL 用真实 SQLite 引擎做端到端冒烟：
// 建含干扰场景的表，取 sqlite_master 的真实 DDL 走判定函数，确保分词器
// 处理的是引擎实际存储的 DDL 形态而不是臆想的文本。
func TestSQLiteAutoIncrementAgainstRealDDL(t *testing.T) {
	if testing.Short() {
		t.Skip("需要真实 sqlite 驱动")
	}
	t.Parallel()

	conn, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Skipf("无 sqlite 驱动: %v", err)
	}
	defer conn.Close()

	// 干扰场景：默认值字面量与普通 AUTOINCREMENT 列名。
	if _, err := conn.Exec("CREATE TABLE noise (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'AUTOINCREMENT', \"AUTOINCREMENT\" TEXT)"); err != nil {
		t.Skipf("建表失败: %v", err)
	}
	// 真实自增主键。
	if _, err := conn.Exec("CREATE TABLE real_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)"); err != nil {
		t.Skipf("建表失败: %v", err)
	}
	// 带冲突子句的自增主键：合法形态，且自增行为真实生效。
	if _, err := conn.Exec("CREATE TABLE conflict_auto (id INTEGER PRIMARY KEY ON CONFLICT ABORT AUTOINCREMENT, note TEXT)"); err != nil {
		t.Skipf("建表失败: %v", err)
	}
	if _, err := conn.Exec("INSERT INTO conflict_auto (note) VALUES ('a')"); err != nil {
		t.Fatalf("带冲突子句的自增主键应能自动生成 ID: %v", err)
	}
	var generatedID int64
	if err := conn.QueryRow("SELECT id FROM conflict_auto LIMIT 1").Scan(&generatedID); err != nil || generatedID != 1 {
		t.Fatalf("自增未生效: id=%d err=%v", generatedID, err)
	}

	fetchDDL := func(table string) string {
		var ddl string
		if err := conn.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&ddl); err != nil {
			t.Fatalf("读取 %s 的 DDL 失败: %v", table, err)
		}
		return ddl
	}

	if sqliteDDLPrimaryKeyUsesAutoIncrement(fetchDDL("noise")) {
		t.Fatalf("干扰场景（字面量+引号列名）被误判为自增主键")
	}
	if !sqliteDDLPrimaryKeyUsesAutoIncrement(fetchDDL("real_auto")) {
		t.Fatalf("真实 AUTOINCREMENT 主键未被识别")
	}
	if !sqliteDDLPrimaryKeyUsesAutoIncrement(fetchDDL("conflict_auto")) {
		t.Fatalf("ON CONFLICT 冲突子句形态的自增主键未被识别: %q", fetchDDL("conflict_auto"))
	}
}
