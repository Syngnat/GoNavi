package app

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/sqlaudit"
)

type fakeCopyTableDB struct {
	columns      []connection.ColumnDefinition
	columnsErr   error
	queryRows    []map[string]interface{}
	queryErr     error
	queryFunc    func(string) ([]map[string]interface{}, error)
	queryQueries []string
	sourceEngine *string
	pgSafetyRows []map[string]interface{}
	sequenceRows []map[string]interface{}
	execQueries  []string
	execFailures map[int]error
}

func (f *fakeCopyTableDB) Connect(connection.ConnectionConfig) error { return nil }
func (f *fakeCopyTableDB) Close() error                              { return nil }
func (f *fakeCopyTableDB) Ping() error                               { return nil }

func (f *fakeCopyTableDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryQueries = append(f.queryQueries, query)
	if strings.Contains(query, "information_schema.tables") && strings.Contains(query, "ENGINE AS engine") {
		engine := "InnoDB"
		if f.sourceEngine != nil {
			engine = *f.sourceEngine
		}
		return []map[string]interface{}{{"engine": engine}}, nil, nil
	}
	if strings.Contains(query, "c.relkind AS relation_kind") {
		if f.pgSafetyRows != nil {
			return f.pgSafetyRows, nil, nil
		}
		return []map[string]interface{}{{
			"relation_kind": "r",
			"persistence":   "p",
			"row_security":  false,
		}}, nil, nil
	}
	if strings.Contains(query, "FROM pg_catalog.pg_sequence") {
		if f.sequenceRows != nil {
			return f.sequenceRows, nil, nil
		}
		return []map[string]interface{}{{
			"data_type":    "bigint",
			"seqstart":     int64(1),
			"seqincrement": int64(1),
			"seqmin":       int64(1),
			"seqmax":       int64(9223372036854775807),
			"seqcache":     int64(1),
			"seqcycle":     false,
		}}, nil, nil
	}
	if f.queryFunc != nil {
		rows, err := f.queryFunc(query)
		return rows, nil, err
	}
	return f.queryRows, nil, f.queryErr
}
func (f *fakeCopyTableDB) Exec(query string) (int64, error) {
	f.execQueries = append(f.execQueries, query)
	if err := f.execFailures[len(f.execQueries)]; err != nil {
		return 0, err
	}
	return 0, nil
}
func (f *fakeCopyTableDB) GetDatabases() ([]string, error) { return nil, nil }
func (f *fakeCopyTableDB) GetTables(string) ([]string, error) {
	return nil, nil
}
func (f *fakeCopyTableDB) GetCreateStatement(string, string) (string, error) {
	return "", nil
}
func (f *fakeCopyTableDB) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return f.columns, f.columnsErr
}
func (f *fakeCopyTableDB) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeCopyTableDB) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *fakeCopyTableDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeCopyTableDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

var _ db.Database = (*fakeCopyTableDB)(nil)

func installCopyTableTestDatabase(t *testing.T, database db.Database) *App {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	return NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
}

func TestResolvePostgresCopyTableColumnTraitsFallsBackByServerCapability(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		wantCalls    int
		wantIdentity bool
	}{
		{
			name:         "PostgreSQL 10/11 keeps identity without attgenerated",
			wantCalls:    2,
			wantIdentity: true,
		},
		{
			name:      "PostgreSQL 9 falls back without generated or identity columns",
			wantCalls: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			database := &fakeCopyTableDB{
				queryFunc: func(query string) ([]map[string]interface{}, error) {
					calls++
					if strings.Contains(query, "a.attgenerated") {
						return nil, errors.New(`column "attgenerated" does not exist`)
					}
					if strings.Contains(query, "a.attidentity") {
						if tt.wantCalls == 3 {
							return nil, errors.New(`column "attidentity" does not exist`)
						}
						return []map[string]interface{}{{
							"column_name":    "id",
							"generated_kind": "",
							"identity_kind":  "a",
						}}, nil
					}
					return []map[string]interface{}{{
						"column_name":    "id",
						"generated_kind": "",
						"identity_kind":  "",
					}}, nil
				},
			}

			traits, err := resolvePostgresCopyTableColumnTraits(database, "postgres", "public", "users")
			if err != nil {
				t.Fatalf("resolvePostgresCopyTableColumnTraits() error: %v", err)
			}
			if calls != tt.wantCalls {
				t.Fatalf("query calls = %d, want %d; queries=%v", calls, tt.wantCalls, database.queryQueries)
			}
			if traits["id"].identity != tt.wantIdentity {
				t.Fatalf("identity trait = %v, want %v; traits=%+v", traits["id"].identity, tt.wantIdentity, traits)
			}
			for _, query := range database.queryQueries {
				if strings.Contains(query, "to_jsonb") {
					t.Fatalf("table copy metadata must not use to_jsonb: %s", query)
				}
			}
		})
	}
}

func TestResolvePostgresCopyTableColumnTraitsDoesNotFallbackForConnectionErrors(t *testing.T) {
	t.Parallel()

	connectionErr := errors.New("connection reset by peer while executing SELECT a.attidentity")
	database := &fakeCopyTableDB{
		queryFunc: func(string) ([]map[string]interface{}, error) {
			return nil, connectionErr
		},
	}
	_, err := resolvePostgresCopyTableColumnTraits(database, "postgres", "public", "users")
	if !errors.Is(err, connectionErr) {
		t.Fatalf("expected connection error, got %v", err)
	}
	if len(database.queryQueries) != 1 {
		t.Fatalf("connection errors must not trigger compatibility fallback, queries=%v", database.queryQueries)
	}
}

func TestCopyTableMySQLChoosesNextSuffixAndCopiesWritableColumns(t *testing.T) {
	database := &fakeCopyTableDB{
		columns: []connection.ColumnDefinition{
			{Name: "id", Extra: "auto_increment"},
			{Name: "name"},
			{Name: "search_text", Extra: "STORED GENERATED"},
		},
		execFailures: map[int]error{1: errors.New("table already exists (Error 1050)")},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "mysql", Database: "app"}, "app", "app", "users")

	if !result.Success {
		t.Fatalf("CopyTable returned failure: %s", result.Message)
	}
	if result.Data != "users_copy2" {
		t.Fatalf("CopyTable target = %#v, want users_copy2", result.Data)
	}
	want := []string{
		"CREATE TABLE `app`.`users_copy1` LIKE `app`.`users`",
		"CREATE TABLE `app`.`users_copy2` LIKE `app`.`users`",
		"INSERT INTO `app`.`users_copy2` (`id`, `name`) SELECT `id`, `name` FROM `app`.`users`",
	}
	if len(database.execQueries) != len(want) {
		t.Fatalf("Exec count = %d, want %d: %#v", len(database.execQueries), len(want), database.execQueries)
	}
	for index := range want {
		if database.execQueries[index] != want[index] {
			t.Fatalf("Exec[%d] = %q, want %q", index, database.execQueries[index], want[index])
		}
	}
}

func TestCopyTableMySQLKeepsDotsInsideTableName(t *testing.T) {
	database := &fakeCopyTableDB{
		columns:      []connection.ColumnDefinition{{Name: "id"}},
		execFailures: map[int]error{1: errors.New("table already exists (Error 1050)")},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "mysql", Database: "app"}, "app", "app", "audit.logs")

	if !result.Success {
		t.Fatalf("CopyTable returned failure: %s", result.Message)
	}
	if result.Data != "audit.logs_copy2" {
		t.Fatalf("CopyTable target = %#v, want audit.logs_copy2", result.Data)
	}
	want := []string{
		"CREATE TABLE `app`.`audit.logs_copy1` LIKE `app`.`audit.logs`",
		"CREATE TABLE `app`.`audit.logs_copy2` LIKE `app`.`audit.logs`",
		"INSERT INTO `app`.`audit.logs_copy2` (`id`) SELECT `id` FROM `app`.`audit.logs`",
	}
	if len(database.execQueries) != len(want) {
		t.Fatalf("Exec count = %d, want %d: %#v", len(database.execQueries), len(want), database.execQueries)
	}
	for index := range want {
		if database.execQueries[index] != want[index] {
			t.Fatalf("Exec[%d] = %q, want %q", index, database.execQueries[index], want[index])
		}
	}
}

func TestCopyTableStopsWhenColumnMetadataIsUnavailable(t *testing.T) {
	tests := []struct {
		name       string
		columns    []connection.ColumnDefinition
		columnsErr error
		wantDetail string
	}{
		{
			name:       "query failed",
			columnsErr: errors.New("column metadata unavailable"),
			wantDetail: "column metadata unavailable",
		},
		{
			name:    "empty metadata",
			columns: []connection.ColumnDefinition{},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database := &fakeCopyTableDB{
				columns:    test.columns,
				columnsErr: test.columnsErr,
			}
			app := installCopyTableTestDatabase(t, database)
			wantDetail := test.wantDetail
			if test.columnsErr == nil {
				wantDetail = app.appText("db.backend.error.table_columns_missing_for_ddl", nil)
			}

			result := app.CopyTable(connection.ConnectionConfig{Type: "mysql"}, "app", "app", "users")

			if result.Success {
				t.Fatal("CopyTable unexpectedly succeeded")
			}
			if wantDetail != "" && !strings.Contains(result.Message, wantDetail) {
				t.Fatalf("failure message = %q, want detail %q", result.Message, wantDetail)
			}
			if len(database.execQueries) != 0 {
				t.Fatalf("CopyTable executed SQL without column metadata: %#v", database.execQueries)
			}
		})
	}
}

func TestCopyTableRejectsTableWithoutWritableColumns(t *testing.T) {
	database := &fakeCopyTableDB{
		columns: []connection.ColumnDefinition{
			{Name: "computed_value", Extra: "VIRTUAL GENERATED"},
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "mysql"}, "app", "app", "computed_values")

	if result.Success {
		t.Fatal("CopyTable unexpectedly succeeded")
	}
	if len(database.execQueries) != 0 {
		t.Fatalf("CopyTable executed SQL without writable columns: %#v", database.execQueries)
	}
}

func TestCopyTableWritesOneObjectEditorAuditEvent(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	database := &fakeCopyTableDB{columns: []connection.ColumnDefinition{{Name: "id"}, {Name: "name"}}}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	app := newSQLAuditTestApp(t)

	result := app.CopyTable(connection.ConnectionConfig{Type: "mysql", Database: "app"}, "app", "app", "users")

	if !result.Success {
		t.Fatalf("CopyTable result = %#v, want audited success", result)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 1 {
		t.Fatalf("audit event count = %d, want 1: %#v", len(events), events)
	}
	event := events[0]
	if event.Source != "object_editor" || event.Status != "success" || event.StatementCount != 2 {
		t.Fatalf("unexpected CopyTable audit event: %#v", event)
	}
	if !strings.Contains(event.SQLText, "CREATE TABLE") || !strings.Contains(event.SQLText, "INSERT INTO") {
		t.Fatalf("CopyTable audit SQL missing executed statements: %#v", event)
	}
}

func TestCopyTableRejectsReferenceStorageEngines(t *testing.T) {
	engine := "FEDERATED"
	database := &fakeCopyTableDB{sourceEngine: &engine}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "mysql"}, "app", "app", "remote_users")

	if result.Success {
		t.Fatal("CopyTable unexpectedly succeeded for FEDERATED")
	}
	if !strings.Contains(result.Message, "ENGINE=FEDERATED") {
		t.Fatalf("failure message = %q, want engine detail", result.Message)
	}
	if len(database.execQueries) != 0 {
		t.Fatalf("unsafe engine executed SQL: %#v", database.execQueries)
	}
}

func TestCopyTableRejectsPostgresPartitionedAndRLSSources(t *testing.T) {
	tests := []struct {
		name string
		row  map[string]interface{}
	}{
		{name: "partitioned", row: map[string]interface{}{"relation_kind": "p", "persistence": "p", "row_security": false}},
		{name: "row security", row: map[string]interface{}{"relation_kind": "r", "persistence": "p", "row_security": true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database := &fakeCopyTableDB{pgSafetyRows: []map[string]interface{}{test.row}}
			app := installCopyTableTestDatabase(t, database)

			result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "app", "public", "orders")

			if result.Success {
				t.Fatal("CopyTable unexpectedly succeeded")
			}
			if len(database.execQueries) != 0 {
				t.Fatalf("unsafe PostgreSQL source executed SQL: %#v", database.execQueries)
			}
		})
	}
}

func TestBuildCopyTablePlanUsesNativeDialectSyntax(t *testing.T) {
	tests := []struct {
		name       string
		dbType     string
		schema     string
		source     string
		target     string
		columns    []string
		wantCreate string
		wantInsert string
	}{
		{
			name:       "postgres",
			dbType:     "postgres",
			schema:     "sales",
			source:     "orders",
			target:     "orders_copy1",
			columns:    []string{"id", "total"},
			wantCreate: `CREATE TABLE "sales"."orders_copy1" (LIKE "sales"."orders" INCLUDING ALL)`,
			wantInsert: `INSERT INTO "sales"."orders_copy1" ("id", "total") OVERRIDING SYSTEM VALUE SELECT "id", "total" FROM "sales"."orders"`,
		},
		{
			name:       "mysql",
			dbType:     "mysql",
			schema:     "warehouse",
			source:     "facts",
			target:     "facts_copy1",
			columns:    []string{"id", "value"},
			wantCreate: "CREATE TABLE `warehouse`.`facts_copy1` LIKE `warehouse`.`facts`",
			wantInsert: "INSERT INTO `warehouse`.`facts_copy1` (`id`, `value`) SELECT `id`, `value` FROM `warehouse`.`facts`",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan := buildCopyTablePlan(test.dbType, test.schema, test.source, test.target, copyTableColumnMetadata{
				writableColumns: test.columns,
			})
			if plan.createSQL != test.wantCreate {
				t.Fatalf("create SQL = %q, want %q", plan.createSQL, test.wantCreate)
			}
			if plan.insertSQL != test.wantInsert {
				t.Fatalf("insert SQL = %q, want %q", plan.insertSQL, test.wantInsert)
			}
		})
	}
}

func TestCopyTablePostgresOmitsGeneratedColumns(t *testing.T) {
	database := &fakeCopyTableDB{
		columns: []connection.ColumnDefinition{
			{Name: "id"},
			{Name: "subtotal"},
			{Name: "tax"},
			{Name: "Amount"},
			{Name: "amount"},
		},
		queryFunc: func(query string) ([]map[string]interface{}, error) {
			if strings.Contains(query, "generated_kind") {
				return []map[string]interface{}{{"column_name": "Amount", "generated_kind": "s"}}, nil
			}
			return nil, nil
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "shop", "sales", "orders")

	if !result.Success {
		t.Fatalf("CopyTable returned failure: %s", result.Message)
	}
	if len(database.execQueries) != 2 {
		t.Fatalf("Exec count = %d, want 2: %#v", len(database.execQueries), database.execQueries)
	}
	wantInsert := `INSERT INTO "sales"."orders_copy1" ("id", "subtotal", "tax", "amount") OVERRIDING SYSTEM VALUE SELECT "id", "subtotal", "tax", "amount" FROM "sales"."orders"`
	if database.execQueries[1] != wantInsert {
		t.Fatalf("insert SQL = %q, want %q", database.execQueries[1], wantInsert)
	}
}

func TestCopyTablePostgresRebuildsSerialAndAdvancesIdentitySequences(t *testing.T) {
	serialDefault := "nextval('sales.orders_id_seq'::regclass)"
	database := &fakeCopyTableDB{
		columns: []connection.ColumnDefinition{
			{Name: "id", Default: &serialDefault},
			{Name: "external_id"},
			{Name: "name"},
		},
		queryFunc: func(query string) ([]map[string]interface{}, error) {
			if strings.Contains(query, "identity_kind") {
				return []map[string]interface{}{{"column_name": "external_id", "identity_kind": "a"}}, nil
			}
			return nil, nil
		},
		sequenceRows: []map[string]interface{}{{
			"data_type":    "integer",
			"seqstart":     int64(100),
			"seqincrement": int64(-1),
			"seqmin":       int64(-2147483648),
			"seqmax":       int64(100),
			"seqcache":     int64(5),
			"seqcycle":     true,
		}},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "shop", "sales", "orders")

	if !result.Success {
		t.Fatalf("CopyTable returned failure: %s", result.Message)
	}
	if len(database.execQueries) != 7 {
		t.Fatalf("Exec count = %d, want 7: %#v", len(database.execQueries), database.execQueries)
	}
	sequenceName := buildPostgresCopyTableSequenceName("orders_copy1", "id")
	wantCreateSequence := `CREATE SEQUENCE "sales"."` + sequenceName + `" AS integer INCREMENT BY -1 MINVALUE -2147483648 MAXVALUE 100 START WITH 100 CACHE 5 CYCLE`
	if database.execQueries[2] != wantCreateSequence {
		t.Fatalf("serial sequence create SQL = %q", database.execQueries[2])
	}
	if !strings.Contains(database.execQueries[4], `SET DEFAULT pg_catalog.nextval($gonavi_copy_0$"sales"."`+sequenceName+`"$gonavi_copy_0$::regclass)`) {
		t.Fatalf("serial default was not rewired: %q", database.execQueries[4])
	}
	if !strings.Contains(database.execQueries[6], `pg_catalog.pg_get_serial_sequence($gonavi_copy_0$"sales"."orders_copy1"$gonavi_copy_0$, $gonavi_copy_0$external_id$gonavi_copy_0$)`) {
		t.Fatalf("identity sequence was not advanced: %q", database.execQueries[6])
	}
	if !strings.Contains(database.execQueries[5], `pg_catalog.min("id")`) || !strings.Contains(database.execQueries[6], `pg_catalog.min("external_id")`) {
		t.Fatalf("descending sequences were not calibrated with MIN: %#v", database.execQueries[5:])
	}
}

func TestCopyTableMetadataQueriesEncodeAdversarialIdentifiers(t *testing.T) {
	t.Run("mysql hex predicates", func(t *testing.T) {
		database := &fakeCopyTableDB{}
		schemaName := `app'; DROP TABLE audit_log; --`
		tableName := "users` WHERE 1=1; --"

		if err := ensureCopyTableSourceIsIndependent(database, "mysql", schemaName, tableName); err != nil {
			t.Fatalf("metadata query failed: %v", err)
		}
		if len(database.queryQueries) != 1 {
			t.Fatalf("query count = %d, want 1", len(database.queryQueries))
		}
		query := database.queryQueries[0]
		if strings.Contains(query, schemaName) || strings.Contains(query, tableName) {
			t.Fatalf("MySQL metadata query contains a raw identifier: %s", query)
		}
		for _, identifier := range []string{schemaName, tableName} {
			if encoded := mysqlCopyTableMetadataHex(identifier); !strings.Contains(query, "'"+encoded+"'") {
				t.Fatalf("MySQL metadata query does not contain HEX(%q): %s", identifier, query)
			}
		}
	})

	t.Run("postgres dollar quoted predicates", func(t *testing.T) {
		database := &fakeCopyTableDB{}
		schemaName := `sales$gonavi_copy_0$'; DROP SCHEMA public CASCADE; --`
		tableName := `orders'; DROP TABLE audit_log; --`

		if err := ensureCopyTableSourceIsIndependent(database, "postgres", schemaName, tableName); err != nil {
			t.Fatalf("metadata query failed: %v", err)
		}
		if len(database.queryQueries) != 1 {
			t.Fatalf("query count = %d, want 1", len(database.queryQueries))
		}
		query := database.queryQueries[0]
		for _, identifier := range []string{schemaName, tableName} {
			literal := postgresCopyTableSQLLiteral(identifier)
			if !strings.Contains(query, literal) {
				t.Fatalf("PostgreSQL metadata query does not contain protected literal %q: %s", literal, query)
			}
			tagEnd := strings.Index(literal[1:], "$") + 1
			if tagEnd <= 0 {
				t.Fatalf("invalid dollar-quoted literal: %q", literal)
			}
			tag := literal[:tagEnd+1]
			if strings.Count(literal, tag) != 2 {
				t.Fatalf("dollar quote tag %q can be closed by identifier %q", tag, identifier)
			}
		}
	})
}

func TestCopyTablePostgresStopsWhenColumnTraitsCannotBeVerified(t *testing.T) {
	database := &fakeCopyTableDB{
		columns: []connection.ColumnDefinition{{Name: "id"}},
		queryFunc: func(query string) ([]map[string]interface{}, error) {
			if strings.Contains(query, "identity_kind") {
				return nil, errors.New("catalog unavailable")
			}
			return nil, nil
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "shop", "sales", "orders")

	if result.Success {
		t.Fatal("CopyTable unexpectedly succeeded")
	}
	if !strings.Contains(result.Message, "catalog unavailable") {
		t.Fatalf("failure message = %q, want catalog error", result.Message)
	}
	if len(database.execQueries) != 0 {
		t.Fatalf("CopyTable executed SQL without verified traits: %#v", database.execQueries)
	}
}

func TestCopyTablePostgresCleansCreatedSequenceWhenFinalizationFails(t *testing.T) {
	serialDefault := "nextval('sales.orders_id_seq'::regclass)"
	database := &fakeCopyTableDB{
		columns: []connection.ColumnDefinition{{Name: "id", Default: &serialDefault}},
		execFailures: map[int]error{
			4: errors.New("sequence ownership failed"),
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "shop", "sales", "orders")

	if result.Success {
		t.Fatal("CopyTable unexpectedly succeeded")
	}
	if len(database.execQueries) != 6 {
		t.Fatalf("Exec count = %d, want 6: %#v", len(database.execQueries), database.execQueries)
	}
	if database.execQueries[4] != `DROP TABLE "sales"."orders_copy1"` {
		t.Fatalf("target table cleanup SQL = %q", database.execQueries[4])
	}
	if !strings.HasPrefix(database.execQueries[5], `DROP SEQUENCE IF EXISTS "sales".`) {
		t.Fatalf("orphan sequence cleanup SQL = %q", database.execQueries[5])
	}
}

func TestBuildCopyTableTargetNameReservesSuffixWithinIdentifierLimit(t *testing.T) {
	postgresSource := strings.Repeat("表", 21)
	postgresTarget := buildCopyTableTargetName("postgres", postgresSource, 1)
	if len(postgresTarget) > 63 || !utf8.ValidString(postgresTarget) || !strings.HasSuffix(postgresTarget, "_copy1") {
		t.Fatalf("invalid PostgreSQL copy name %q (%d bytes)", postgresTarget, len(postgresTarget))
	}

	mysqlSource := strings.Repeat("表", 64)
	mysqlTarget := buildCopyTableTargetName("mysql", mysqlSource, 1)
	if utf8.RuneCountInString(mysqlTarget) > 64 || !strings.HasSuffix(mysqlTarget, "_copy1") {
		t.Fatalf("invalid MySQL copy name %q (%d chars)", mysqlTarget, utf8.RuneCountInString(mysqlTarget))
	}

	longPostgresSource := strings.Repeat("x", 63)
	tenthTarget := buildCopyTableTargetName("postgres", longPostgresSource, 10)
	if len(tenthTarget) > 63 || !strings.HasSuffix(tenthTarget, "_copy10") {
		t.Fatalf("invalid two-digit PostgreSQL copy name %q", tenthTarget)
	}
}

func TestCopyTableAlreadyExistsErrorMatchesSupportedDrivers(t *testing.T) {
	tests := []struct {
		message string
		want    bool
	}{
		{message: `ERROR: relation "orders_copy1" already exists (SQLSTATE 42P07)`, want: true},
		{message: "Error 1050 (42S01): Table 'orders_copy1' already exists", want: true},
		{message: "Code: 57, table already exists", want: true},
		{message: "Code: 57, unrelated ClickHouse error", want: false},
		{message: "permission denied", want: false},
	}
	for _, test := range tests {
		if got := isCopyTableAlreadyExistsError(errors.New(test.message)); got != test.want {
			t.Fatalf("isCopyTableAlreadyExistsError(%q) = %v, want %v", test.message, got, test.want)
		}
	}
}

func TestCopyTableRetriesCreateTimeNameConflict(t *testing.T) {
	database := &fakeCopyTableDB{
		columns:      []connection.ColumnDefinition{{Name: "id"}},
		execFailures: map[int]error{1: errors.New("relation already exists (SQLSTATE 42P07)")},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "app", "public", "orders")

	if !result.Success {
		t.Fatalf("CopyTable returned failure: %s", result.Message)
	}
	if result.Data != "orders_copy2" {
		t.Fatalf("CopyTable target = %#v, want orders_copy2", result.Data)
	}
	if len(database.execQueries) != 3 {
		t.Fatalf("Exec count = %d, want 3: %#v", len(database.execQueries), database.execQueries)
	}
	if !strings.Contains(database.execQueries[1], `"orders_copy2"`) || !strings.Contains(database.execQueries[2], `"orders_copy2"`) {
		t.Fatalf("retry did not use orders_copy2: %#v", database.execQueries)
	}
}

func TestCopyTableRetriesConflictWhenPostgresSchemaContainsDot(t *testing.T) {
	database := &fakeCopyTableDB{
		columns:      []connection.ColumnDefinition{{Name: "id"}},
		execFailures: map[int]error{1: errors.New("relation already exists (SQLSTATE 42P07)")},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "app", "sales.region", "orders")

	if !result.Success {
		t.Fatalf("CopyTable returned failure: %s", result.Message)
	}
	if result.Data != "orders_copy2" {
		t.Fatalf("CopyTable target = %#v, want orders_copy2", result.Data)
	}
	if len(database.execQueries) != 3 {
		t.Fatalf("Exec count = %d, want 3: %#v", len(database.execQueries), database.execQueries)
	}
	if !strings.Contains(database.execQueries[1], `"sales.region"."orders_copy2"`) {
		t.Fatalf("retry did not advance inside dotted schema: %#v", database.execQueries)
	}
}

func TestCopyTableRetriesConflictWhenPostgresTableContainsDot(t *testing.T) {
	database := &fakeCopyTableDB{
		columns:      []connection.ColumnDefinition{{Name: "id"}},
		execFailures: map[int]error{1: errors.New("relation already exists (SQLSTATE 42P07)")},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "postgres"}, "app", "public", "orders.archive")

	if !result.Success {
		t.Fatalf("CopyTable returned failure: %s", result.Message)
	}
	if result.Data != "orders.archive_copy2" {
		t.Fatalf("CopyTable target = %#v, want orders.archive_copy2", result.Data)
	}
	if len(database.execQueries) != 3 {
		t.Fatalf("Exec count = %d, want 3: %#v", len(database.execQueries), database.execQueries)
	}
	if !strings.Contains(database.execQueries[1], `"public"."orders.archive_copy2"`) {
		t.Fatalf("retry did not advance dotted table as one identifier: %#v", database.execQueries)
	}
}

func TestNormalizeCopyTableSourceUsesExplicitPostgresSchema(t *testing.T) {
	tests := []struct {
		name       string
		schema     string
		source     string
		wantSource string
	}{
		{name: "dotted schema", schema: "sales.region", source: "sales.region.orders", wantSource: "orders"},
		{name: "qualified dotted table", schema: "public", source: "public.orders.archive", wantSource: "orders.archive"},
		{name: "unqualified dotted table", schema: "public", source: "orders.archive", wantSource: "orders.archive"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotSchema, gotSource := normalizeCopyTableSource("postgres", "app", test.schema, test.source)
			if gotSchema != test.schema || gotSource != test.wantSource {
				t.Fatalf("normalizeCopyTableSource = (%q, %q), want (%q, %q)", gotSchema, gotSource, test.schema, test.wantSource)
			}
		})
	}
}

func TestCopyTableDropsPartialTargetWhenInsertFails(t *testing.T) {
	database := &fakeCopyTableDB{
		columns:      []connection.ColumnDefinition{{Name: "id"}},
		execFailures: map[int]error{2: errors.New("copy rows failed")},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "mysql"}, "app", "app", "users")

	if result.Success {
		t.Fatal("CopyTable unexpectedly succeeded")
	}
	if !strings.Contains(result.Message, "copy rows failed") {
		t.Fatalf("failure message does not retain insert error: %q", result.Message)
	}
	if len(database.execQueries) != 3 || database.execQueries[2] != "DROP TABLE `app`.`users_copy1`" {
		t.Fatalf("partial target cleanup = %#v, want DROP TABLE users_copy1", database.execQueries)
	}
}

func TestCopyTableReportsInsertAndCleanupFailures(t *testing.T) {
	database := &fakeCopyTableDB{
		columns: []connection.ColumnDefinition{{Name: "id"}},
		execFailures: map[int]error{
			2: errors.New("copy rows failed"),
			3: errors.New("cleanup failed"),
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyTable(connection.ConnectionConfig{Type: "mysql"}, "app", "app", "users")

	if result.Success {
		t.Fatal("CopyTable unexpectedly succeeded")
	}
	if !strings.Contains(result.Message, "copy rows failed") || !strings.Contains(result.Message, "cleanup failed") {
		t.Fatalf("failure message = %q, want both errors", result.Message)
	}
}

func TestCopyTableProtectionBlocksBeforeOpeningDatabase(t *testing.T) {
	tests := []struct {
		name       string
		protection connection.ConnectionProtectionConfig
	}{
		{name: "structure", protection: connection.ConnectionProtectionConfig{RestrictStructureEdit: true}},
		{name: "import", protection: connection.ConnectionProtectionConfig{RestrictDataImport: true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			opened := false
			originalNewDatabaseFunc := newDatabaseFunc
			t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
			newDatabaseFunc = func(string) (db.Database, error) {
				opened = true
				return &fakeCopyTableDB{}, nil
			}
			app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			result := app.CopyTable(connection.ConnectionConfig{Type: "mysql", Protection: test.protection}, "app", "app", "users")
			if result.Success {
				t.Fatal("CopyTable unexpectedly succeeded")
			}
			if opened {
				t.Fatal("CopyTable opened a database despite connection protection")
			}
		})
	}
}

func TestCopyTableRejectsUnsupportedDatabaseWithoutOpeningConnection(t *testing.T) {
	for _, dbType := range []string{"oracle", "clickhouse", "diros", "starrocks", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb"} {
		t.Run(dbType, func(t *testing.T) {
			opened := false
			originalNewDatabaseFunc := newDatabaseFunc
			t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
			newDatabaseFunc = func(string) (db.Database, error) {
				opened = true
				return &fakeCopyTableDB{}, nil
			}
			app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))

			result := app.CopyTable(connection.ConnectionConfig{Type: dbType}, "SYSTEM", "", "USERS")

			if result.Success {
				t.Fatal("CopyTable unexpectedly succeeded")
			}
			if opened {
				t.Fatal("CopyTable opened a database for an unsupported dialect")
			}
		})
	}

	t.Run("custom OceanBase Oracle", func(t *testing.T) {
		opened := false
		originalNewDatabaseFunc := newDatabaseFunc
		t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
		newDatabaseFunc = func(string) (db.Database, error) {
			opened = true
			return &fakeCopyTableDB{}, nil
		}
		app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
		result := app.CopyTable(connection.ConnectionConfig{
			Type:              "custom",
			Driver:            "oceanbase",
			OceanBaseProtocol: "oracle",
		}, "SYSTEM", "", "USERS")
		if result.Success || opened {
			t.Fatalf("custom OceanBase Oracle result=%#v opened=%v, want unsupported without connection", result, opened)
		}
	})
}
