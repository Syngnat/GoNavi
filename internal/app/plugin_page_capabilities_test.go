package app

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/plugin"
)

func newPluginPageDatabaseTestApp(t *testing.T) (*App, *fakeBatchWriteDB) {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &fakeBatchWriteDB{}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	return newPluginPageTestApp(t), database
}

func pluginPageTestConnection(t *testing.T, a *App, id string) {
	t.Helper()
	if _, err := a.SaveConnection(connection.SavedConnectionInput{
		ID:     id,
		Name:   "Page metadata",
		Config: connection.ConnectionConfig{ID: id, Type: "postgres", Host: "db.internal", Port: 5432, Database: "appdb"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPluginPageMetadataCapabilitiesGateway(t *testing.T) {
	a, _ := newPluginPageDatabaseTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.metadata.gateway", pluginPageFullPermissions()...)
	pluginPageTestConnection(t, a, "conn-meta")

	for _, test := range []struct {
		name   string
		method string
		args   string
		assert func(t *testing.T, value any)
	}{
		{
			name:   "databases",
			method: pluginPageMethodMetadataDatabases,
			args:   `{"connectionId":"conn-meta"}`,
			assert: func(t *testing.T, value any) {
				if names, ok := value.([]string); !ok || len(names) != 0 {
					t.Fatalf("databases = %T %#v", value, value)
				}
			},
		},
		{
			name:   "tables",
			method: pluginPageMethodMetadataTables,
			args:   `{"connectionId":"conn-meta","database":"appdb"}`,
			assert: func(t *testing.T, value any) {
				if tables, ok := value.([]pluginPageTableSummary); !ok || len(tables) != 0 {
					t.Fatalf("tables = %T %#v", value, value)
				}
			},
		},
		{
			name:   "columns",
			method: pluginPageMethodMetadataColumns,
			args:   `{"connectionId":"conn-meta","database":"appdb","table":"users"}`,
			assert: func(t *testing.T, value any) {
				if columns, ok := value.([]pluginPageColumnSummary); !ok || len(columns) != 0 {
					t.Fatalf("columns = %T %#v", value, value)
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := a.PluginPageCall(id, "overview", test.method, test.args)
			if !result.Success {
				t.Fatalf("metadata call failed: %+v", result)
			}
			test.assert(t, result.Data)
		})
	}

	for _, test := range []struct {
		name   string
		method string
		args   string
	}{
		{name: "databases rejects unknown field", method: pluginPageMethodMetadataDatabases, args: `{"connectionId":"conn-meta","extra":1}`},
		{name: "tables requires connection", method: pluginPageMethodMetadataTables, args: `{"database":"appdb"}`},
		{name: "columns requires table", method: pluginPageMethodMetadataColumns, args: `{"connectionId":"conn-meta","database":"appdb"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			requirePluginPageFailure(t, a.PluginPageCall(id, "overview", test.method, test.args), "page_invalid_arguments")
		})
	}
}

func TestPluginPageMetadataRequiresPermission(t *testing.T) {
	a, _ := newPluginPageDatabaseTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.metadata.denied", plugin.PagesPermission)
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", pluginPageMethodMetadataDatabases, `{"connectionId":"any"}`), "page_permission_denied")
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", pluginPageMethodMetadataTables, `{"connectionId":"any"}`), "page_permission_denied")
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", pluginPageMethodMetadataColumns, `{"connectionId":"any","table":"t"}`), "page_permission_denied")
}

func TestPluginPageNotifyGateway(t *testing.T) {
	a, _ := newPluginPageDatabaseTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.notify.gateway", plugin.PagesPermission)
	result := a.PluginPageCall(id, "overview", pluginPageMethodNotify, `{"message":"hello","type":"info"}`)
	if !result.Success || result.Data != nil {
		t.Fatalf("ui.notify = %+v", result)
	}
	for _, args := range []string{`{"message":""}`, `{"message":"hello","extra":true}`} {
		requirePluginPageFailure(t, a.PluginPageCall(id, "overview", pluginPageMethodNotify, args), "page_invalid_arguments")
	}
}

func TestPluginPageCallCancellationStopsBeforeDriver(t *testing.T) {
	a, database := newPluginPageDatabaseTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.cancel.gateway", pluginPageFullPermissions()...)
	pluginPageTestConnection(t, a, "conn-cancel")
	// Warm the plugin manager so the status lookup does not need the canceled
	// context and the cancellation reaches the capability dispatch instead.
	if result := a.PluginPageCall(id, "overview", "app.info", "{}"); !result.Success {
		t.Fatalf("warm-up failed: %+v", result)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	result := a.pluginPageCallContext(cancelled, id, "overview", pluginPageMethodQueryRead, `{"connectionId":"conn-cancel","sql":"SELECT 1","maxRows":10}`)
	requirePluginPageFailure(t, result, "page_internal")
	if database.queryCalls != 0 {
		t.Fatalf("canceled call reached the driver: %d queries", database.queryCalls)
	}
}

func TestPluginPageConnectionReadOnlyEffectiveSemantics(t *testing.T) {
	full := connection.ConnectionProtectionConfig{RestrictDataEdit: true, RestrictStructureEdit: true, RestrictScriptExecution: true, RestrictDataImport: true}
	for _, test := range []struct {
		name   string
		config connection.ConnectionConfig
		want   bool
	}{
		{name: "legacy read-only flag", config: connection.ConnectionConfig{Type: "postgres", ReadOnly: true}, want: true},
		{name: "full protection", config: connection.ConnectionConfig{Type: "postgres", Protection: full}, want: true},
		{name: "partial protection", config: connection.ConnectionConfig{Type: "postgres", Protection: connection.ConnectionProtectionConfig{RestrictDataEdit: true}}, want: false},
		{name: "unsupported driver flag", config: connection.ConnectionConfig{Type: "not-a-real-engine", ReadOnly: true}, want: false},
		{name: "plugin source defaults read-only", config: connection.ConnectionConfig{Type: "plugin:example.reader:source:mysql"}, want: true},
		{name: "plugin source writable", config: connection.ConnectionConfig{Type: "plugin:example.reader:source:mysql", PluginWritable: true}, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := pluginPageConnectionReadOnly(test.config); got != test.want {
				t.Fatalf("readOnly = %t, want %t", got, test.want)
			}
		})
	}
}
