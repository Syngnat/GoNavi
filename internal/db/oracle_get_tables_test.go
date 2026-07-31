package db

import (
	"database/sql/driver"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestOracleGetTablesPrefixesOwnerForAllTablesQuery(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SELECT owner AS "OWNER", table_name AS "TABLE_NAME" FROM all_tables WHERE owner = 'MYCIMLED' ORDER BY table_name`] = oracleRecordingQueryResult{
		columns: []string{"OWNER", "TABLE_NAME"},
		rows: [][]driver.Value{
			{"MYCIMLED", "T_ADS"},
			{"MYCIMLED", "T_USERS"},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	tables, err := oracleDB.GetTables("MYCIMLED")
	if err != nil {
		t.Fatalf("GetTables 返回错误: %v", err)
	}

	want := []string{"MYCIMLED.T_ADS", "MYCIMLED.T_USERS"}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("期望返回带 OWNER 前缀的表名 %v，实际 %v", want, tables)
	}
	queries := state.snapshotQueries()
	if len(queries) != 1 || strings.Contains(strings.ToLower(queries[0]), "all_synonyms") {
		t.Fatalf("GetTables 应保持只返回物理表，实际查询: %v", queries)
	}
}

func TestOracleGetTablesPrefixesCurrentUserForUserTablesQuery(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SELECT USER AS "OWNER", table_name AS "TABLE_NAME" FROM user_tables ORDER BY table_name`] = oracleRecordingQueryResult{
		columns: []string{"OWNER", "TABLE_NAME"},
		rows: [][]driver.Value{
			{"LOGIN_USER", "T_ADS"},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	tables, err := oracleDB.GetTables("")
	if err != nil {
		t.Fatalf("GetTables 返回错误: %v", err)
	}

	want := []string{"LOGIN_USER.T_ADS"}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("空 dbName 也应带 OWNER 前缀，期望 %v，实际 %v", want, tables)
	}
}

func TestOracleGetTablesSkipsRowsWithNullTableName(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SELECT owner AS "OWNER", table_name AS "TABLE_NAME" FROM all_tables WHERE owner = 'MYCIMLED' ORDER BY table_name`] = oracleRecordingQueryResult{
		columns: []string{"OWNER", "TABLE_NAME"},
		rows: [][]driver.Value{
			{"MYCIMLED", nil},
			{"MYCIMLED", "T_ADS"},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	tables, err := oracleDB.GetTables("MYCIMLED")
	if err != nil {
		t.Fatalf("GetTables 返回错误: %v", err)
	}

	want := []string{"MYCIMLED.T_ADS"}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("NULL TABLE_NAME 应被跳过，期望 %v，实际 %v", want, tables)
	}
}

func TestOracleGetColumnsIncludesColumnComments(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oracleDB := &OracleDB{conn: dbConn}
	columns, err := oracleDB.GetColumns("MYCIMLED", "EDC_LOG")
	if err != nil {
		t.Fatalf("GetColumns 返回错误: %v", err)
	}
	if len(columns) == 0 {
		t.Fatalf("expected columns")
	}
	if columns[0].Name != "UPDATED_AT" || columns[0].Comment != "更新时间" {
		t.Fatalf("expected first column comment from Oracle metadata, got %#v", columns[0])
	}

	queries := state.snapshotQueries()
	if len(queries) == 0 || !strings.Contains(queries[0], "all_col_comments") {
		t.Fatalf("expected GetColumns to join all_col_comments, queries=%v", queries)
	}
	for _, want := range []string{`AS "COLUMN_NAME"`, `AS "DATA_TYPE"`, `AS "DATA_LENGTH"`, `AS "CHAR_LENGTH"`, `AS "DATA_PRECISION"`, `AS "DATA_SCALE"`, `AS "COMMENT"`} {
		if !strings.Contains(queries[0], want) {
			t.Fatalf("expected GetColumns query to contain stable alias %q, got %s", want, queries[0])
		}
	}
}

func TestOracleGetColumnsResolvesSynonymTargetComments(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.disableDefaultTabColumns = true
	state.queryResults[buildOracleSynonymLookupQuery("SBDEV", "PERSON_INFO")] = oracleRecordingQueryResult{
		columns: []string{"TABLE_OWNER", "TABLE_NAME"},
		rows: [][]driver.Value{
			{"DEV", "PERSON_INFO"},
		},
	}
	state.queryResults[buildOracleColumnsQuery("DEV", "PERSON_INFO")] = oracleRecordingQueryResult{
		columns: []string{"COLUMN_NAME", "DATA_TYPE", "NULLABLE", "DATA_DEFAULT", "COLUMN_KEY", "COMMENT"},
		rows: [][]driver.Value{
			{"PID", "CHAR", "NO", nil, "PRI", "个人标识"},
			{"XM", "VARCHAR2", "YES", nil, "", "姓名"},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	columns, err := oracleDB.GetColumns("SBDEV", "PERSON_INFO")
	if err != nil {
		t.Fatalf("GetColumns 返回错误: %v", err)
	}
	if len(columns) != 2 {
		t.Fatalf("expected synonym target columns, got %#v", columns)
	}
	if columns[0].Name != "PID" || columns[0].Comment != "个人标识" || columns[0].Key != "PRI" {
		t.Fatalf("expected first synonym column metadata from DEV.PERSON_INFO, got %#v", columns[0])
	}
	if columns[1].Name != "XM" || columns[1].Comment != "姓名" {
		t.Fatalf("expected second synonym column comment from DEV.PERSON_INFO, got %#v", columns[1])
	}

	queries := state.snapshotQueries()
	if len(queries) < 3 {
		t.Fatalf("expected direct metadata probe + synonym lookup + target metadata probe, got %v", queries)
	}
	if queries[0] != buildOracleColumnsQuery("SBDEV", "PERSON_INFO") {
		t.Fatalf("expected first metadata probe to use synonym owner, got %v", queries)
	}
	if !slices.Contains(queries, buildOracleSynonymLookupQuery("SBDEV", "PERSON_INFO")) {
		t.Fatalf("expected synonym lookup against all_synonyms, got %v", queries)
	}
	if !slices.Contains(queries, buildOracleColumnsQuery("DEV", "PERSON_INFO")) {
		t.Fatalf("expected metadata probe against resolved target table, got %v", queries)
	}
	if slices.Contains(queries, `SELECT * FROM "SBDEV"."PERSON_INFO" WHERE 1 = 0`) {
		t.Fatalf("expected synonym metadata to resolve before falling back to empty-select inference, got %v", queries)
	}
}

func TestOracleColumnsQueryFiltersPrimaryKeyLookupByTargetTable(t *testing.T) {
	t.Parallel()

	query := buildOracleColumnsQuery("MYCIMLED", "EDC_LOG")
	for _, want := range []string{
		`AND cons.owner = 'MYCIMLED'`,
		`AND cons.table_name = 'EDC_LOG'`,
		`AND cols.owner = 'MYCIMLED'`,
		`AND cols.table_name = 'EDC_LOG'`,
		`WHERE c.owner = 'MYCIMLED' AND c.table_name = 'EDC_LOG'`,
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("expected Oracle columns query to contain %q, got: %s", want, query)
		}
	}
}

func TestOracleForeignKeysQueryPreFiltersLocalColumnsByTargetTable(t *testing.T) {
	t.Parallel()

	query := buildOracleForeignKeysQuery("MYCIMLED", "EDC_LOG")
	for _, want := range []string{
		`FROM (`,
		`FROM all_cons_columns`,
		`WHERE owner = 'MYCIMLED' AND table_name = 'EDC_LOG'`,
		`WHERE c.constraint_type = 'R' AND c.owner = 'MYCIMLED' AND c.table_name = 'EDC_LOG'`,
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("expected Oracle foreign-key query to contain %q, got: %s", want, query)
		}
	}
}

func TestOracleGetColumnsPreservesMetadataNameCaseBeforeUppercaseFallback(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oracleDB := &OracleDB{conn: dbConn}
	if _, err := oracleDB.GetColumns("SYS", "test"); err != nil {
		t.Fatalf("GetColumns 返回错误: %v", err)
	}

	queries := state.snapshotQueries()
	if len(queries) == 0 {
		t.Fatalf("expected metadata query")
	}
	if !strings.Contains(queries[0], `WHERE c.owner = 'SYS' AND c.table_name = 'test'`) {
		t.Fatalf("expected first metadata query to preserve table case, got: %s", queries[0])
	}
}

func TestOracleGetColumnsFallsBackToSelectMetadataWhenDictionaryIsEmpty(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.disableDefaultTabColumns = true
	state.queryResults[`SELECT * FROM "SYS"."test" WHERE 1 = 0`] = oracleRecordingQueryResult{
		columns:     []string{"id", "new_col_1"},
		columnTypes: []string{"NUMBER", "VARCHAR2"},
		nullable:    []bool{false, true},
		rows:        [][]driver.Value{},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	columns, err := oracleDB.GetColumns("SYS", "test")
	if err != nil {
		t.Fatalf("GetColumns 返回错误: %v", err)
	}
	if len(columns) != 2 {
		t.Fatalf("expected fallback columns, got %#v", columns)
	}
	if columns[0].Name != "id" || columns[0].Type != "NUMBER" || columns[0].Nullable != "NO" {
		t.Fatalf("unexpected first fallback column: %#v", columns[0])
	}
	if columns[1].Name != "new_col_1" || columns[1].Type != "VARCHAR2" || columns[1].Nullable != "YES" {
		t.Fatalf("unexpected second fallback column: %#v", columns[1])
	}

	queries := state.snapshotQueries()
	if !slices.Contains(queries, `SELECT * FROM "SYS"."test" WHERE 1 = 0`) {
		t.Fatalf("expected SELECT metadata fallback query, got: %v", queries)
	}
}

func TestFormatOracleColumnTypeIncludesLengthAndPrecision(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		row  map[string]interface{}
		want string
	}{
		{
			name: "varchar2 char length",
			row: map[string]interface{}{
				"DATA_TYPE":   "VARCHAR2",
				"DATA_LENGTH": 256,
				"CHAR_LENGTH": 128,
			},
			want: "VARCHAR2(128)",
		},
		{
			name: "number precision scale",
			row: map[string]interface{}{
				"DATA_TYPE":      "NUMBER",
				"DATA_PRECISION": 10,
				"DATA_SCALE":     2,
			},
			want: "NUMBER(10,2)",
		},
		{
			name: "date remains plain",
			row: map[string]interface{}{
				"DATA_TYPE": "DATE",
			},
			want: "DATE",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := formatOracleColumnType(tc.row); got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestOracleGetCreateStatementPreservesMetadataNameCase(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SELECT DBMS_METADATA.GET_DDL('TABLE', 'test', 'SYS') as ddl FROM DUAL`] = oracleRecordingQueryResult{
		columns: []string{"DDL"},
		rows: [][]driver.Value{
			{`CREATE TABLE "SYS"."test" ("ID" NUMBER)`},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	ddl, err := oracleDB.GetCreateStatement("SYS", "test")
	if err != nil {
		t.Fatalf("GetCreateStatement 返回错误: %v", err)
	}
	if !strings.Contains(ddl, `CREATE TABLE "SYS"."test"`) {
		t.Fatalf("expected lowercase metadata DDL, got: %s", ddl)
	}

	queries := state.snapshotQueries()
	if len(queries) == 0 || queries[0] != `SELECT DBMS_METADATA.GET_DDL('TABLE', 'test', 'SYS') as ddl FROM DUAL` {
		t.Fatalf("expected first DDL query to preserve case, got: %v", queries)
	}
}

func TestOracleGetCreateStatementDoesNotTruncateCLOB(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	fullDDL := `CREATE TABLE "SYS"."BIG_TABLE" ("PAYLOAD" VARCHAR2(4000)) ` +
		strings.Repeat("TABLESPACE USERS ", 400)
	state.mu.Lock()
	state.queryResults[`SELECT DBMS_METADATA.GET_DDL('TABLE', 'BIG_TABLE', 'SYS') as ddl FROM DUAL`] = oracleRecordingQueryResult{
		columns:     []string{"DDL"},
		columnTypes: []string{"OCICLOBLOCATOR"},
		rows: [][]driver.Value{
			{fullDDL},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	ddl, err := oracleDB.GetCreateStatement("SYS", "BIG_TABLE")
	if err != nil {
		t.Fatalf("GetCreateStatement 返回错误: %v", err)
	}
	if !strings.HasPrefix(ddl, strings.TrimSpace(fullDDL)) {
		t.Fatalf("expected complete Oracle CLOB DDL, want source length=%d got length=%d prefix=%q", len(fullDDL), len(ddl), ddl[:min(len(ddl), 80)])
	}
	if strings.Contains(ddl, "[CLOB preview:") {
		t.Fatalf("Oracle table DDL must not contain an interactive CLOB preview marker: %q", ddl[:80])
	}
}

func TestOracleGetCreateStatementFallsBackToUppercaseMetadataName(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SELECT DBMS_METADATA.GET_DDL('TABLE', 'TEST', 'SYS') as ddl FROM DUAL`] = oracleRecordingQueryResult{
		columns: []string{"DDL"},
		rows: [][]driver.Value{
			{`CREATE TABLE "SYS"."TEST" ("ID" NUMBER)`},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	ddl, err := oracleDB.GetCreateStatement("SYS", "test")
	if err != nil {
		t.Fatalf("GetCreateStatement 返回错误: %v", err)
	}
	if !strings.Contains(ddl, `CREATE TABLE "SYS"."TEST"`) {
		t.Fatalf("expected uppercase fallback DDL, got: %s", ddl)
	}

	queries := state.snapshotQueries()
	if len(queries) < 2 {
		t.Fatalf("expected original-case query followed by uppercase fallback, got: %v", queries)
	}
	if queries[0] != `SELECT DBMS_METADATA.GET_DDL('TABLE', 'test', 'SYS') as ddl FROM DUAL` ||
		queries[1] != `SELECT DBMS_METADATA.GET_DDL('TABLE', 'TEST', 'SYS') as ddl FROM DUAL` {
		t.Fatalf("unexpected DDL fallback query order: %v", queries)
	}
}

func TestOracleGetCreateStatementAppendsTableAndColumnComments(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SELECT DBMS_METADATA.GET_DDL('TABLE', 'EDC_LOG', 'MYCIMLED') as ddl FROM DUAL`] = oracleRecordingQueryResult{
		columns: []string{"DDL"},
		rows: [][]driver.Value{
			{`CREATE TABLE "MYCIMLED"."EDC_LOG" (
  "ID" NUMBER NOT NULL
)`},
		},
	}
	state.queryResults[`SELECT comments AS "COMMENT" FROM all_tab_comments WHERE owner = 'MYCIMLED' AND table_name = 'EDC_LOG' AND comments IS NOT NULL`] = oracleRecordingQueryResult{
		columns: []string{"COMMENT"},
		rows: [][]driver.Value{
			{"日志表"},
		},
	}
	state.queryResults[`SELECT c.column_name AS "COLUMN_NAME", cc.comments AS "COMMENT"
FROM all_tab_columns c
JOIN all_col_comments cc
  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
WHERE c.owner = 'MYCIMLED' AND c.table_name = 'EDC_LOG' AND cc.comments IS NOT NULL
ORDER BY c.column_id`] = oracleRecordingQueryResult{
		columns: []string{"COLUMN_NAME", "COMMENT"},
		rows: [][]driver.Value{
			{"ID", "主键's"},
		},
	}
	state.mu.Unlock()

	oracleDB := &OracleDB{conn: dbConn}
	ddl, err := oracleDB.GetCreateStatement("MYCIMLED", "EDC_LOG")
	if err != nil {
		t.Fatalf("GetCreateStatement 返回错误: %v", err)
	}
	for _, want := range []string{
		`CREATE TABLE "MYCIMLED"."EDC_LOG"`,
		`COMMENT ON TABLE "MYCIMLED"."EDC_LOG" IS '日志表';`,
		`COMMENT ON COLUMN "MYCIMLED"."EDC_LOG"."ID" IS '主键''s';`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("expected DDL to contain %q, got: %s", want, ddl)
		}
	}
	if !strings.Contains(ddl, ");\n\nCOMMENT ON TABLE") {
		t.Fatalf("expected Oracle DDL comments to be separated by a statement terminator and blank line, got: %s", ddl)
	}
}
