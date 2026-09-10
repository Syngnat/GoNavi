//go:build gonavi_full_drivers || gonavi_iris_driver || gonavi_cache_driver

package db

import (
	"database/sql/driver"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestIrisDSNUsesNamespaceDefaultPortAndConnectionParams(t *testing.T) {
	iris := &IrisDB{}

	dsn := iris.getDSN(connection.ConnectionConfig{
		Host:             "db.example.com",
		User:             "_SYSTEM",
		Password:         "p@ss",
		ConnectionParams: "timeout=30&ssl=1",
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	if parsed.Scheme != "iris" {
		t.Fatalf("scheme = %q", parsed.Scheme)
	}
	if parsed.Host != "db.example.com:1972" {
		t.Fatalf("host = %q", parsed.Host)
	}
	if parsed.Path != "/USER" {
		t.Fatalf("namespace path = %q", parsed.Path)
	}
	if parsed.User.Username() != "_SYSTEM" {
		t.Fatalf("user = %q", parsed.User.Username())
	}
	password, _ := parsed.User.Password()
	if password != "p@ss" {
		t.Fatalf("password = %q", password)
	}
	if got := parsed.Query().Get("timeout"); got != "30" {
		t.Fatalf("timeout param = %q", got)
	}
	if got := parsed.Query().Get("ssl"); got != "1" {
		t.Fatalf("ssl param = %q", got)
	}
}

func TestApplyIRISURIExtractsConnectionFields(t *testing.T) {
	config := applyIRISURI(connection.ConnectionConfig{
		URI:      "iris://user:secret@iris.local:1973/APP?timeout=30",
		Database: "SHOULD_BE_REPLACED",
	})

	if config.Host != "iris.local" || config.Port != 1973 || config.User != "user" || config.Password != "secret" {
		t.Fatalf("unexpected parsed config: %#v", config)
	}
	if config.Database != "APP" {
		t.Fatalf("database namespace = %q", config.Database)
	}
}

func TestCacheDBKeepsIndependentProductIdentityAndURI(t *testing.T) {
	cache := &CacheDB{}
	if got := cache.productType(); got != "cache" {
		t.Fatalf("cache product type = %q, want cache", got)
	}
	if got := cache.productName(); got != "InterSystems Caché" {
		t.Fatalf("cache product name = %q", got)
	}
	config := applyIRISURI(connection.ConnectionConfig{
		URI: "cache://user:secret@cache.local:1972/APP?timeout=30",
	})
	if config.Host != "cache.local" || config.Port != 1972 || config.User != "user" || config.Password != "secret" || config.Database != "APP" {
		t.Fatalf("unexpected cache URI config: %#v", config)
	}
	dsn := cache.getDSN(config)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse cache DSN: %v", err)
	}
	if parsed.Scheme != "iris" || parsed.Host != "cache.local:1972" || parsed.Path != "/APP" {
		t.Fatalf("unexpected wire-compatible cache DSN: %s", dsn)
	}
}

func TestIRISTableRefAndIdentifierQuoting(t *testing.T) {
	ref, err := parseIRISTableRef("Sample", `"Person.Table"`)
	if err != nil {
		t.Fatalf("parse table ref: %v", err)
	}
	if ref.Schema != "Sample" || ref.Table != "Person.Table" {
		t.Fatalf("unexpected ref: %#v", ref)
	}

	ref, err = parseIRISTableRef("", `"Sample"."Person""Archive"`)
	if err != nil {
		t.Fatalf("parse qualified table ref: %v", err)
	}
	if ref.Schema != "Sample" || ref.Table != `Person"Archive` {
		t.Fatalf("unexpected qualified ref: %#v", ref)
	}
	if got := irisQuoteTable(`"Sample"."Person""Archive"`); got != `"Sample"."Person""Archive"` {
		t.Fatalf("quoted table = %s", got)
	}
}

func TestIRISColumnKeyMapPrefersPrimaryThenUnique(t *testing.T) {
	keys := irisColumnKeyMap([]connection.IndexDefinition{
		{Name: "idx_id", ColumnName: "id", NonUnique: 0},
		{Name: "IDKEY", ColumnName: "id", NonUnique: 0},
		{Name: "idx_email", ColumnName: "email", NonUnique: 0},
		{Name: "idx_name", ColumnName: "name", NonUnique: 1},
	})

	if keys["id"] != "PRI" {
		t.Fatalf("id key = %q", keys["id"])
	}
	if keys["email"] != "UNI" {
		t.Fatalf("email key = %q", keys["email"])
	}
	if keys["name"] != "" {
		t.Fatalf("name key = %q", keys["name"])
	}
}

func TestBuildIRISCreateTableDDLIncludesPrimaryAndIndexes(t *testing.T) {
	defaultValue := "CURRENT_TIMESTAMP"
	ddl := buildIRISCreateTableDDL(
		irisTableRef{Schema: "Sample", Table: "Person"},
		[]connection.ColumnDefinition{
			{Name: "id", Type: "INTEGER", Nullable: "NO"},
			{Name: "name", Type: "VARCHAR(80)", Nullable: "NO"},
			{Name: "created_at", Type: "TIMESTAMP", Nullable: "YES", Default: &defaultValue},
		},
		[]connection.IndexDefinition{
			{Name: "app_person_pk", ColumnName: "id", NonUnique: 0, SeqInIndex: 1, IndexType: "PRIMARY"},
			{Name: "idx_person_name", ColumnName: "name", NonUnique: 0, SeqInIndex: 1},
			{Name: "idx_person_created_at", ColumnName: "created_at", NonUnique: 1, SeqInIndex: 1},
		},
	)

	for _, want := range []string{
		`CREATE TABLE "Sample"."Person"`,
		`"id" INTEGER NOT NULL`,
		`"name" VARCHAR(80) NOT NULL`,
		`"created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
		`PRIMARY KEY ("id")`,
		`CREATE UNIQUE INDEX "idx_person_name" ON "Sample"."Person" ("name");`,
		`CREATE INDEX "idx_person_created_at" ON "Sample"."Person" ("created_at");`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("ddl missing %q:\n%s", want, ddl)
		}
	}
	if strings.Contains(ddl, `CREATE UNIQUE INDEX "app_person_pk"`) {
		t.Fatalf("primary key index should not be emitted as a standalone index:\n%s", ddl)
	}
}

func TestBuildIRISCreateTableDDLFallsBackToColumnPrimaryKey(t *testing.T) {
	ddl := buildIRISCreateTableDDL(
		irisTableRef{Schema: "Sample", Table: "Person"},
		[]connection.ColumnDefinition{
			{Name: "id", Type: "INTEGER", Nullable: "NO", Key: "PRI"},
			{Name: "name", Type: "VARCHAR(80)", Nullable: "YES"},
		},
		nil,
	)

	if !strings.Contains(ddl, `PRIMARY KEY ("id")`) {
		t.Fatalf("ddl missing primary key from column metadata:\n%s", ddl)
	}
}

func TestIrisMetadataMapsColumnsAndIndexes(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	iris := &IrisDB{conn: dbConn}

	columnsQuery := buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.COLUMNS", irisTableRef{Schema: "Sample", Table: "Person"})
	indexesQuery := buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.INDEXES", irisTableRef{Schema: "Sample", Table: "Person"})

	state.mu.Lock()
	state.queryResults[columnsQuery] = oracleRecordingQueryResult{
		columns: []string{"TABLE_SCHEMA", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "CHARACTER_MAXIMUM_LENGTH", "IS_NULLABLE", "COLUMN_DEFAULT", "ORDINAL_POSITION", "DESCRIPTION", "PRIMARY_KEY", "UNIQUE_COLUMN"},
		rows: [][]driver.Value{
			{"Sample", "Person", "id", "INTEGER", nil, "NO", nil, int64(1), "identifier", true, false},
			{"Sample", "Person", "name", "VARCHAR", int64(80), "YES", "'anonymous'", int64(2), "display name", false, true},
		},
	}
	state.queryResults[indexesQuery] = oracleRecordingQueryResult{
		columns: []string{"INDEX_NAME", "COLUMN_NAME", "NON_UNIQUE", "ORDINAL_POSITION", "INDEX_TYPE", "PRIMARY_KEY"},
		rows: [][]driver.Value{
			{"app_person_pk", "id", int64(1), int64(1), "bitmap", true},
			{"idx_person_name", "name", int64(0), int64(1), "", false},
		},
	}
	state.mu.Unlock()

	columns, err := iris.GetColumns("Sample", "Person")
	if err != nil {
		t.Fatalf("GetColumns returned error: %v", err)
	}
	if len(columns) != 2 {
		t.Fatalf("columns len = %d", len(columns))
	}
	if columns[0].Name != "id" || columns[0].Key != "PRI" || columns[0].Nullable != "NO" {
		t.Fatalf("unexpected id column: %#v", columns[0])
	}
	if columns[1].Type != "VARCHAR(80)" || columns[1].Key != "UNI" {
		t.Fatalf("unexpected name column: %#v", columns[1])
	}

	indexes, err := iris.GetIndexes("Sample", "Person")
	if err != nil {
		t.Fatalf("GetIndexes returned error: %v", err)
	}
	if len(indexes) != 2 || indexes[0].Name != "app_person_pk" || indexes[0].IndexType != "PRIMARY" || indexes[0].NonUnique != 0 {
		t.Fatalf("unexpected indexes: %#v", indexes)
	}
}

func TestIrisGetTablesReadsCompactInfoSchemaColumnNames(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SELECT * FROM INFORMATION_SCHEMA.TABLES`] = oracleRecordingQueryResult{
		columns: []string{"TABLECATALOG", "TABLESCHEMA", "TABLENAME", "TABLETYPE"},
		rows: [][]driver.Value{
			{"USER", "Sample", "Person", "TABLE"},
			{"USER", "UserApp", "AuditLog", "BASE TABLE"},
			{"USER", "Sample", "PersonView", "VIEW"},
			{"USER", "%Library", "ClassDefinition", "TABLE"},
		},
	}
	state.mu.Unlock()

	iris := &IrisDB{conn: dbConn, namespace: "USER"}
	tables, err := iris.GetTables("USER")
	if err != nil {
		t.Fatalf("GetTables 返回错误: %v", err)
	}

	want := []string{"Sample.Person", "UserApp.AuditLog"}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("期望读取 IRIS 紧凑列名并过滤系统对象，want=%v got=%v", want, tables)
	}
}

func TestIrisMetadataMapsCompactColumnsAndIndexes(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	iris := &IrisDB{conn: dbConn}

	columnsQuery := buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.COLUMNS", irisTableRef{Schema: "Sample", Table: "Person"})
	indexesQuery := buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.INDEXES", irisTableRef{Schema: "Sample", Table: "Person"})

	state.mu.Lock()
	state.queryResults[columnsQuery] = oracleRecordingQueryResult{
		columns: []string{"TABLESCHEMA", "TABLENAME", "COLUMNNAME", "DATATYPE", "CHARACTERMAXIMUMLENGTH", "ISNULLABLE", "COLUMNDEFAULT", "ORDINALPOSITION", "DESCRIPTION", "PRIMARYKEY", "UNIQUECOLUMN"},
		rows: [][]driver.Value{
			{"Sample", "Person", "id", "INTEGER", nil, "NO", nil, int64(1), "identifier", true, false},
			{"Sample", "Person", "name", "VARCHAR", int64(80), "YES", "'anonymous'", int64(2), "display name", false, true},
		},
	}
	state.queryResults[indexesQuery] = oracleRecordingQueryResult{
		columns: []string{"INDEXNAME", "COLUMNNAME", "NONUNIQUE", "ORDINALPOSITION", "INDEXTYPE", "PRIMARYKEY"},
		rows: [][]driver.Value{
			{"app_person_pk", "id", int64(0), int64(1), "bitmap", true},
			{"idx_person_name", "name", int64(0), int64(1), "", false},
		},
	}
	state.mu.Unlock()

	columns, err := iris.GetColumns("Sample", "Person")
	if err != nil {
		t.Fatalf("GetColumns 返回错误: %v", err)
	}
	if len(columns) != 2 {
		t.Fatalf("columns len = %d", len(columns))
	}
	if columns[0].Name != "id" || columns[0].Key != "PRI" || columns[0].Nullable != "NO" {
		t.Fatalf("unexpected compact id column: %#v", columns[0])
	}
	if columns[1].Type != "VARCHAR(80)" || columns[1].Key != "UNI" {
		t.Fatalf("unexpected compact name column: %#v", columns[1])
	}

	indexes, err := iris.GetIndexes("Sample", "Person")
	if err != nil {
		t.Fatalf("GetIndexes 返回错误: %v", err)
	}
	if len(indexes) != 2 || indexes[0].Name != "app_person_pk" || indexes[0].IndexType != "PRIMARY" || indexes[0].NonUnique != 0 {
		t.Fatalf("unexpected compact indexes: %#v", indexes)
	}
}

func TestBuildIRISApplyChangesSQL(t *testing.T) {
	deleteSQL, deleteArgs, ok := buildIRISDeleteSQL("Sample.Person", map[string]interface{}{"id": 1})
	if !ok {
		t.Fatal("expected delete SQL")
	}
	if deleteSQL != `DELETE FROM "Sample"."Person" WHERE "id" = ?` || !reflect.DeepEqual(deleteArgs, []interface{}{1}) {
		t.Fatalf("unexpected delete SQL/args: %s %#v", deleteSQL, deleteArgs)
	}

	updateSQL, updateArgs, ok, err := buildIRISUpdateSQL("Sample.Person", connection.UpdateRow{
		Keys:   map[string]interface{}{"id": 1},
		Values: map[string]interface{}{"name": "Alice", "updated_at": "2026-05-16"},
	})
	if err != nil || !ok {
		t.Fatalf("expected update SQL, ok=%v err=%v", ok, err)
	}
	if updateSQL != `UPDATE "Sample"."Person" SET "name" = ?, "updated_at" = ? WHERE "id" = ?` {
		t.Fatalf("unexpected update SQL: %s", updateSQL)
	}
	if !reflect.DeepEqual(updateArgs, []interface{}{"Alice", "2026-05-16", 1}) {
		t.Fatalf("unexpected update args: %#v", updateArgs)
	}

	insertSQL, insertArgs, ok := buildIRISInsertSQL("Sample.Person", map[string]interface{}{"name": "Alice", "id": 1})
	if !ok {
		t.Fatal("expected insert SQL")
	}
	if insertSQL != `INSERT INTO "Sample"."Person" ("id", "name") VALUES (?, ?)` {
		t.Fatalf("unexpected insert SQL: %s", insertSQL)
	}
	if !reflect.DeepEqual(insertArgs, []interface{}{1, "Alice"}) {
		t.Fatalf("unexpected insert args: %#v", insertArgs)
	}
}

func TestIrisApplyChangesExecutesInDeleteUpdateInsertOrder(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	iris := &IrisDB{conn: dbConn}

	err := iris.ApplyChanges("Sample.Person", connection.ChangeSet{
		Deletes: []map[string]interface{}{
			{"id": 3},
		},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"id": 2}, Values: map[string]interface{}{"name": "Bob"}},
		},
		Inserts: []map[string]interface{}{
			{"id": 1, "name": "Alice"},
		},
	})
	if err != nil {
		t.Fatalf("ApplyChanges returned error: %v", err)
	}

	got := state.snapshotExecQueries()
	want := []string{
		`DELETE FROM "Sample"."Person" WHERE "id" = ?`,
		`UPDATE "Sample"."Person" SET "name" = ? WHERE "id" = ?`,
		`INSERT INTO "Sample"."Person" ("id", "name") VALUES (?, ?)`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected exec queries:\nwant=%#v\ngot=%#v", want, got)
	}
}

func TestBuildIRISUpdateSQLRequiresLocatorKeys(t *testing.T) {
	_, _, ok, err := buildIRISUpdateSQL("Person", connection.UpdateRow{
		Values: map[string]interface{}{"name": "Alice"},
	})
	if err == nil || ok {
		t.Fatalf("expected missing keys to be rejected, ok=%v err=%v", ok, err)
	}
}
