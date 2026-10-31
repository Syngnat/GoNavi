package app

import (
	"context"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/sqlaudit"
)

type pluginPageReadOnlyDatabase struct{ *fakeBatchWriteDB }

func (f *pluginPageReadOnlyDatabase) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return f.QueryContext(ctx, query)
}

func (f *pluginPageBudgetDatabase) QueryReadOnlyContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	return f.queryRowsWithBudget(ctx)
}

func TestPluginReadOnlyTransactionPolicy(t *testing.T) {
	for _, source := range []string{pluginPageQueryAuditSource, "application_api", "query_editor", "database_jobs", ""} {
		if got := pluginQueryRequiresReadOnlyTransaction(source); got != (source == pluginPageQueryAuditSource) {
			t.Errorf("source %q enforced=%t", source, got)
		}
	}
}

func TestPluginReadOnlyQueryHonorsCancellationBeforeDriver(t *testing.T) {
	database := &pluginReadOnlyQueryDatabase{fakeBatchWriteDB: &fakeBatchWriteDB{}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := executePluginReadOnlyQuery(ctx, database, "SELECT 1")
	if !errors.Is(err, context.Canceled) || database.readOnlyCalls != 0 {
		t.Fatalf("cancelled call reached driver: calls=%d err=%v", database.readOnlyCalls, err)
	}
}

type pluginReadOnlyQueryDatabase struct {
	*fakeBatchWriteDB
	readOnlyCalls int
	readOnlyErr   error
	budgetSeen    bool
}

func (f *pluginReadOnlyQueryDatabase) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.readOnlyCalls++
	f.budgetSeen = db.RowBudgetFromContext(ctx) != nil
	if f.readOnlyErr != nil {
		return nil, nil, f.readOnlyErr
	}
	return []map[string]interface{}{{"n": 1}}, []string{"n"}, nil
}

func pluginReadOnlyQueryTestApp(t *testing.T, database db.Database) (*App, string) {
	t.Helper()
	original := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = original })
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	a := newPluginPageTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.enforced-read", plugin.PagesPermission, plugin.QueryReadPermission)
	if _, err := a.SaveConnection(connection.SavedConnectionInput{
		ID: "enforced-read", Name: "Read", Config: connection.ConnectionConfig{
			ID: "enforced-read", Type: "postgres", Host: "fixture.invalid", Port: 5432, Database: "app",
		},
	}); err != nil {
		t.Fatal(err)
	}
	return a, id
}

func TestPluginReadOnlySourceNeverFallsBackToExec(t *testing.T) {
	database := &fakeBatchWriteDB{}
	a, _ := pluginReadOnlyQueryTestApp(t, database)
	result := a.dbQueryWithCancel(connection.ConnectionConfig{Type: "postgres", Host: "fixture.invalid", Database: "app"}, "app", "DELETE FROM users", "", dbQueryAuditOptions{source: pluginPageQueryAuditSource})
	if result.Success || database.execCalls != 0 || database.queryCalls != 0 {
		t.Fatalf("read-only source entered ordinary execution: success=%t query=%d exec=%d", result.Success, database.queryCalls, database.execCalls)
	}
}

func TestPluginPageReadRejectsPostgresDriverWithoutReadOnlyTransactions(t *testing.T) {
	database := &fakeBatchWriteDB{}
	a, id := pluginReadOnlyQueryTestApp(t, database)
	result := a.PluginPageCall(id, "overview", "query.read", `{"connectionId":"enforced-read","sql":"SELECT pg_catalog.lo_create(0)"}`)
	if result.Success || database.queryCalls != 0 || database.execCalls != 0 {
		t.Fatalf("unprotected read reached ordinary execution: success=%t query=%d exec=%d", result.Success, database.queryCalls, database.execCalls)
	}
}

func TestPluginPageReadUsesReadOnlyTransactionAndPreservesAudit(t *testing.T) {
	for _, test := range []struct {
		name, sql string
		failure   bool
	}{
		{name: "read", sql: "SELECT 1"},
		{name: "create large object", sql: "SELECT pg_catalog.lo_create(0)", failure: true},
		{name: "delete large object", sql: "SELECT pg_catalog.lo_unlink(42)", failure: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := &pluginReadOnlyQueryDatabase{fakeBatchWriteDB: &fakeBatchWriteDB{}}
			if test.failure {
				database.readOnlyErr = errors.New("cannot execute write in a read-only transaction")
			}
			a, id := pluginReadOnlyQueryTestApp(t, database)
			args := `{"connectionId":"enforced-read","sql":"` + test.sql + `"}`
			result := a.PluginPageCall(id, "overview", "query.read", args)
			if result.Success == test.failure || database.readOnlyCalls != 1 || database.queryCalls != 0 || !database.budgetSeen {
				t.Fatalf("read-only dispatch mismatch: success=%t readonly=%d ordinary=%d budget=%t", result.Success, database.readOnlyCalls, database.queryCalls, database.budgetSeen)
			}
			events := loadSQLAuditEvents(t, a, sqlaudit.Filter{})
			for _, event := range events {
				if event.Source == "plugin_page" {
					if (event.Status == "success") == test.failure {
						t.Fatalf("wrong audit status: %s", event.Status)
					}
					return
				}
			}
			t.Fatal("missing plugin read audit event")
		})
	}
}
