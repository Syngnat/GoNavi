package app

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/sqlaudit"
)

func TestPluginPageCallRequiresRunningPluginAndDeclaredPage(t *testing.T) {
	a := newPluginPageTestApp(t)
	id := installPluginPageTestPackage(t, a, pluginPageTestManifest("test.pages", pluginPageFullPermissions()...))
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "app.info", "{}"), "page_not_running")

	enablePluginPageTestPackage(t, a, id)
	result := a.PluginPageCall(id, "overview", "app.info", "{}")
	if !result.Success {
		t.Fatalf("app.info failed: %+v", result)
	}
	info, ok := result.Data.(pluginPageAppInfoResult)
	if !ok {
		t.Fatalf("app.info data = %T", result.Data)
	}
	if info.PluginID != id || info.PluginVersion != "1.2.3" || info.Runtime != "desktop" || info.Locale == "" || info.HostVersion == "" {
		t.Fatalf("unexpected app.info: %#v", info)
	}
	requirePluginPageFailure(t, a.PluginPageCall(id, "missing", "app.info", "{}"), "page_not_declared")
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "unknown.method", "{}"), "page_unknown_method")
}

func TestPluginPageCallRequiresCapabilityPermission(t *testing.T) {
	a := newPluginPageTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.readonly", plugin.PagesPermission)
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "connections.list", "{}"), "page_permission_denied")
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "query.read", `{"connectionId":"any","sql":"SELECT 1"}`), "page_permission_denied")
}

func TestPluginPageConnectionsListRedactsCredentials(t *testing.T) {
	a := newPluginPageTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.connections", pluginPageFullPermissions()...)
	if _, err := a.SaveConnection(connection.SavedConnectionInput{
		ID:              "conn-secret",
		Name:            "Production",
		EnvironmentType: "production",
		Config: connection.ConnectionConfig{
			ID:       "conn-secret",
			Type:     "postgres",
			Host:     "db.internal",
			Port:     5432,
			User:     "alice-secret",
			Password: "top-secret-password",
			DSN:      "postgres://alice-secret:top-secret-password@db.internal/app",
			Database: "appdb",
			ReadOnly: true,
		},
	}); err != nil {
		t.Fatal(err)
	}
	result := a.PluginPageCall(id, "overview", "connections.list", "{}")
	if !result.Success {
		t.Fatalf("connections.list failed: %+v", result)
	}
	items, ok := result.Data.([]pluginPageConnectionSummary)
	if !ok || len(items) != 1 {
		t.Fatalf("connections = %T %#v", result.Data, result.Data)
	}
	item := items[0]
	if item.ID != "conn-secret" || item.Type != "postgres" || item.Host != "db.internal" || item.Port != 5432 || item.Database != "appdb" || !item.ReadOnly || item.EnvironmentType != "production" {
		t.Fatalf("unexpected summary: %#v", item)
	}
	encoded, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"alice-secret", "top-secret-password", "DSN"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatalf("connection list leaked %q: %s", secret, encoded)
		}
	}
}

func TestPluginPageConnectionConfigResolvesSecretsOnHost(t *testing.T) {
	a := newPluginPageTestApp(t)
	if _, err := a.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-resolve",
		Name: "Resolve",
		Config: connection.ConnectionConfig{
			ID:       "conn-resolve",
			Type:     "postgres",
			Host:     "db.internal",
			Port:     5432,
			User:     "host-only-user",
			Password: "host-only-password",
			Database: "appdb",
		},
	}); err != nil {
		t.Fatal(err)
	}
	config, code := a.pluginPageConnectionConfig("conn-resolve")
	if code != "" {
		t.Fatalf("resolve failed: %s", code)
	}
	if config.Password != "host-only-password" || config.User != "host-only-user" || config.ID != "conn-resolve" {
		t.Fatalf("secrets were not resolved on the host: %#v", config)
	}
	if _, code = a.pluginPageConnectionConfig("missing"); code != "invalid_arguments" {
		t.Fatalf("unknown connection code = %q", code)
	}
}

func TestPluginPageQueryReadUsesAuditedReadOnlyPath(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			"SELECT id FROM users": {{"id": 1}, {"id": 2}},
		},
		fieldMap: map[string][]string{"SELECT id FROM users": {"id"}},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return &pluginPageReadOnlyDatabase{database}, nil }

	a := newPluginPageTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.query", pluginPageFullPermissions()...)
	if _, err := a.SaveConnection(connection.SavedConnectionInput{
		ID:     "conn-query",
		Name:   "Query",
		Config: connection.ConnectionConfig{ID: "conn-query", Type: "postgres", Host: "db.internal", Port: 5432, Database: "appdb"},
	}); err != nil {
		t.Fatal(err)
	}

	result := a.PluginPageCall(id, "overview", "query.read", `{"connectionId":"conn-query","sql":"SELECT id FROM users","maxRows":1}`)
	if !result.Success {
		t.Fatalf("query.read failed: %+v", result)
	}
	shaped, ok := result.Data.(pluginPageQueryResult)
	if !ok {
		t.Fatalf("query.read data = %T", result.Data)
	}
	if len(shaped.Columns) != 1 || shaped.Columns[0].Name != "id" || len(shaped.Rows) != 1 || !shaped.Truncated {
		t.Fatalf("unexpected result shape: %#v", shaped)
	}
	if shaped.ElapsedMS < 0 {
		t.Fatalf("elapsed = %d", shaped.ElapsedMS)
	}

	events := loadSQLAuditEvents(t, a, sqlaudit.Filter{})
	var audited *sqlaudit.Event
	for index := range events {
		if events[index].Source == "plugin_page" {
			audited = &events[index]
		}
	}
	if audited == nil || audited.Status != "success" || audited.SQLText == "" {
		t.Fatalf("query.read was not audited: %#v", events)
	}

	queryCalls := database.queryCalls
	for _, call := range []struct {
		name string
		args string
	}{
		{name: "write statement", args: `{"connectionId":"conn-query","sql":"DELETE FROM users"}`},
		{name: "lock clause", args: `{"connectionId":"conn-query","sql":"SELECT * FROM users FOR UPDATE"}`},
		{name: "high risk function", args: `{"connectionId":"conn-query","sql":"SELECT nextval('users_id_seq')"}`},
		{name: "multiple statements", args: `{"connectionId":"conn-query","sql":"SELECT 1; SELECT 2"}`},
		{name: "unknown field", args: `{"connectionId":"conn-query","sql":"SELECT 1","database":"other"}`},
		{name: "maxRows below range", args: `{"connectionId":"conn-query","sql":"SELECT 1","maxRows":-1}`},
		{name: "maxRows above range", args: `{"connectionId":"conn-query","sql":"SELECT 1","maxRows":1001}`},
		{name: "unknown connection", args: `{"connectionId":"missing","sql":"SELECT 1"}`},
	} {
		t.Run(call.name, func(t *testing.T) {
			requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "query.read", call.args), "page_invalid_arguments")
		})
	}
	if database.queryCalls != queryCalls {
		t.Fatalf("rejected reads reached the driver: %d -> %d", queryCalls, database.queryCalls)
	}
}

func TestPluginPageReadOnlyStatement(t *testing.T) {
	for _, test := range []struct {
		name    string
		dbType  string
		query   string
		allowed bool
	}{
		{name: "select", dbType: "postgres", query: "SELECT 1", allowed: true},
		{name: "cte", dbType: "postgres", query: "WITH x AS (SELECT 1) SELECT * FROM x", allowed: true},
		{name: "show", dbType: "mysql", query: "SHOW TABLES", allowed: true},
		{name: "describe", dbType: "mysql", query: "DESCRIBE users", allowed: true},
		{name: "explain", dbType: "postgres", query: "EXPLAIN SELECT 1", allowed: true},
		{name: "trailing comment", dbType: "postgres", query: "SELECT 1 -- note", allowed: true},
		{name: "delete", dbType: "postgres", query: "DELETE FROM users", allowed: false},
		{name: "multiple statements", dbType: "postgres", query: "SELECT 1; DROP TABLE users", allowed: false},
		{name: "cte write", dbType: "postgres", query: "WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x", allowed: false},
		{name: "explain analyze write", dbType: "postgres", query: "EXPLAIN ANALYZE DELETE FROM users", allowed: false},
		{name: "executable comment", dbType: "mysql", query: "SELECT 1 /*!50000 UNION SELECT 2*/", allowed: false},
		{name: "for update", dbType: "postgres", query: "SELECT * FROM users FOR UPDATE", allowed: false},
		{name: "for no key update", dbType: "postgres", query: "SELECT * FROM users FOR NO KEY UPDATE", allowed: false},
		{name: "for share", dbType: "postgres", query: "SELECT * FROM users FOR SHARE", allowed: false},
		{name: "for key share", dbType: "postgres", query: "SELECT * FROM users FOR KEY SHARE", allowed: false},
		{name: "lock in share mode", dbType: "mysql", query: "SELECT * FROM users LOCK IN SHARE MODE", allowed: false},
		{name: "updlock hint", dbType: "sqlserver", query: "SELECT * FROM users WITH (UPDLOCK)", allowed: false},
		{name: "holdlock hint", dbType: "sqlserver", query: "SELECT * FROM users WITH (HOLDLOCK)", allowed: false},
		{name: "nextval", dbType: "postgres", query: "SELECT nextval('users_id_seq')", allowed: false},
		{name: "qualified nextval", dbType: "postgres", query: "SELECT pg_catalog.nextval('users_id_seq')", allowed: false},
		{name: "setval", dbType: "postgres", query: "SELECT setval('users_id_seq', 1)", allowed: false},
		{name: "terminate backend", dbType: "postgres", query: "SELECT pg_terminate_backend(123)", allowed: false},
		{name: "read file", dbType: "postgres", query: "SELECT pg_read_file('/etc/passwd')", allowed: false},
		{name: "lock words in literal", dbType: "postgres", query: "SELECT 'for update' AS note", allowed: true},
		{name: "lock words in comment", dbType: "postgres", query: "SELECT 1 -- for update", allowed: true},
		{name: "function in block comment", dbType: "postgres", query: "/* nextval( */ SELECT 1", allowed: true},
		{name: "empty", dbType: "postgres", query: "   ", allowed: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, allowed := pluginPageReadOnlyStatement(test.dbType, test.query)
			if allowed != test.allowed {
				t.Fatalf("allowed = %t, want %t", allowed, test.allowed)
			}
		})
	}
}

type pluginPageBudgetDatabase struct {
	*fakeBatchWriteDB
	available    int
	materialized int
}

func (f *pluginPageBudgetDatabase) queryRowsWithBudget(ctx context.Context) ([]map[string]interface{}, []string, error) {
	budget := db.RowBudgetFromContext(ctx)
	rows := make([]map[string]interface{}, 0, 16)
	for index := 0; index < f.available; index++ {
		if budget != nil && !budget.CanMaterializeRow(len(rows)) {
			break
		}
		if budget != nil && !budget.ConsumeRow(8) {
			break
		}
		rows = append(rows, map[string]interface{}{"n": index})
		f.materialized++
	}
	return rows, []string{"n"}, nil
}

func (f *pluginPageBudgetDatabase) QueryContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	return f.queryRowsWithBudget(ctx)
}

func (f *pluginPageBudgetDatabase) QueryContextWithMessages(ctx context.Context, _ string) ([]map[string]interface{}, []string, []string, error) {
	rows, fields, err := f.queryRowsWithBudget(ctx)
	return rows, fields, nil, err
}

func pluginPageBudgetTestApp(t *testing.T, database *pluginPageBudgetDatabase) (*App, string) {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	a := newPluginPageTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.budget", pluginPageFullPermissions()...)
	if _, err := a.SaveConnection(connection.SavedConnectionInput{
		ID:     "conn-budget",
		Name:   "Budget",
		Config: connection.ConnectionConfig{ID: "conn-budget", Type: "postgres", Host: "db.internal", Port: 5432, Database: "appdb"},
	}); err != nil {
		t.Fatal(err)
	}
	return a, id
}

func TestPluginPageQueryReadStopsScanAtRowBudget(t *testing.T) {
	database := &pluginPageBudgetDatabase{fakeBatchWriteDB: &fakeBatchWriteDB{}, available: 5000}
	a, id := pluginPageBudgetTestApp(t, database)
	result := a.PluginPageCall(id, "overview", "query.read", `{"connectionId":"conn-budget","sql":"SELECT n FROM big","maxRows":10}`)
	if !result.Success {
		t.Fatalf("query.read failed: %+v", result)
	}
	shaped, ok := result.Data.(pluginPageQueryResult)
	if !ok {
		t.Fatalf("query.read data = %T", result.Data)
	}
	if len(shaped.Rows) != 10 || !shaped.Truncated {
		t.Fatalf("unexpected result shape: %#v", shaped)
	}
	// The budget is maxRows+1: the driver may probe one extra row to prove
	// truncation, but it must never scan the 5000 available rows.
	if database.materialized != 11 {
		t.Fatalf("materialized %d rows, want budget stop at 11", database.materialized)
	}
}

func TestPluginPageQueryReadKeepsExactBudgetResultComplete(t *testing.T) {
	database := &pluginPageBudgetDatabase{fakeBatchWriteDB: &fakeBatchWriteDB{}, available: 10}
	a, id := pluginPageBudgetTestApp(t, database)
	result := a.PluginPageCall(id, "overview", "query.read", `{"connectionId":"conn-budget","sql":"SELECT n FROM big","maxRows":10}`)
	if !result.Success {
		t.Fatalf("query.read failed: %+v", result)
	}
	shaped := result.Data.(pluginPageQueryResult)
	if len(shaped.Rows) != 10 || shaped.Truncated {
		t.Fatalf("exact budget result must stay complete: %#v", shaped)
	}
	if database.materialized != 10 {
		t.Fatalf("materialized %d rows, want 10", database.materialized)
	}
}

func TestPluginPageConnectionsListEffectiveReadOnlyAndMultiHost(t *testing.T) {
	a := newPluginPageTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.effective", pluginPageFullPermissions()...)
	for _, input := range []connection.SavedConnectionInput{
		{
			ID:   "conn-protected",
			Name: "Protected",
			Config: connection.ConnectionConfig{
				ID:         "conn-protected",
				Type:       "postgres",
				Hosts:      []string{"primary:5432", "replica:5432"},
				Database:   "appdb",
				Protection: connection.ConnectionProtectionConfig{RestrictDataEdit: true, RestrictStructureEdit: true, RestrictScriptExecution: true, RestrictDataImport: true},
			},
		},
		{
			ID:     "conn-plain",
			Name:   "Plain",
			Config: connection.ConnectionConfig{ID: "conn-plain", Type: "postgres", Host: "db.internal", Port: 5432, Database: "appdb"},
		},
	} {
		if _, err := a.SaveConnection(input); err != nil {
			t.Fatal(err)
		}
	}
	result := a.PluginPageCall(id, "overview", "connections.list", "{}")
	if !result.Success {
		t.Fatalf("connections.list failed: %+v", result)
	}
	items := map[string]pluginPageConnectionSummary{}
	for _, item := range result.Data.([]pluginPageConnectionSummary) {
		items[item.ID] = item
	}
	protected, ok := items["conn-protected"]
	if !ok || !protected.ReadOnly {
		t.Fatalf("full protection must report effective read-only: %#v", protected)
	}
	if protected.Host != "" || protected.Port != 0 {
		t.Fatalf("multi-host connection must keep host/port empty: %#v", protected)
	}
	if plain, ok := items["conn-plain"]; !ok || plain.ReadOnly {
		t.Fatalf("plain connection must not report read-only: %#v", plain)
	}
}

func TestPluginPageMetadataLimitsAndShapes(t *testing.T) {
	names, ok := pluginPageMetadataNames([]string{"a", "b", ""}, "Database", 1)
	if !ok || len(names) != 1 || names[0] != "a" {
		t.Fatalf("names = %#v ok=%t", names, ok)
	}
	if names, ok = pluginPageMetadataNames(nil, "Database", 10); !ok || len(names) != 0 {
		t.Fatalf("nil names = %#v ok=%t", names, ok)
	}
	if _, ok = pluginPageMetadataNames(7, "Database", 10); ok {
		t.Fatal("unsupported data shape accepted")
	}
	if columns, ok := pluginPageMetadataColumnsFromData(nil); !ok || len(columns) != 0 {
		t.Fatalf("nil columns = %#v ok=%t", columns, ok)
	}
	rows := make([]map[string]string, pluginPageMaxMetadataTables+5)
	for index := range rows {
		rows[index] = map[string]string{"Table": "t", "Type": "BASE TABLE"}
	}
	tables, ok := pluginPageMetadataTablesFromData(rows)
	if !ok || len(tables) != pluginPageMaxMetadataTables || tables[0].Type != "BASE TABLE" {
		t.Fatalf("tables = %d ok=%t", len(tables), ok)
	}
	columns, ok := pluginPageMetadataColumnsFromData([]connection.ColumnDefinition{
		{Name: "id", Type: "int", Nullable: "NO"},
		{Name: "note", Type: "text", Nullable: "YES"},
		{Name: "unknown", Type: "text"},
	})
	if !ok || len(columns) != 3 || columns[0].Nullable == nil || *columns[0].Nullable || columns[1].Nullable == nil || !*columns[1].Nullable || columns[2].Nullable != nil {
		t.Fatalf("columns = %#v ok=%t", columns, ok)
	}
}
