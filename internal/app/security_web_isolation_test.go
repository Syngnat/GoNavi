package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sqlaudit"
	"GoNavi-Wails/internal/webidentity"
)

func newSecurityIsolationWebApp(t *testing.T) *App {
	t.Helper()
	application := NewWebApp()
	application.configDir = t.TempDir()
	application.activateSQLAudit()
	t.Cleanup(func() { application.closeSQLAuditStore() })
	return application
}

func appendSecurityAuditEvent(t *testing.T, application *App, event sqlaudit.Event) {
	t.Helper()
	event.EventType = "query"
	event.Status = "success"
	event.Source = "query_editor"
	err := application.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		return store.Append(event)
	})
	if err != nil {
		t.Fatalf("append audit event: %v", err)
	}
}

func TestSQLAuditContextFiltersByActorAndConnectionACL(t *testing.T) {
	application := newSecurityIsolationWebApp(t)
	appendSecurityAuditEvent(t, application, sqlaudit.Event{
		ConnectionID:  "conn-a",
		QueryID:       "alice-a",
		TransactionID: "tx-alice-a",
		RunID:         "run-alice-a",
		UserName:      "alice",
		SQLText:       "SELECT 1",
	})
	appendSecurityAuditEvent(t, application, sqlaudit.Event{
		ConnectionID:  "conn-b",
		QueryID:       "alice-b",
		TransactionID: "tx-alice-b",
		UserName:      "alice",
		SQLText:       "SELECT 2",
	})
	appendSecurityAuditEvent(t, application, sqlaudit.Event{
		ConnectionID:  "conn-a",
		QueryID:       "bob-a",
		TransactionID: "tx-bob-a",
		UserName:      "bob",
		SQLText:       "SELECT 3",
	})

	viewerCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username:             "alice",
		Role:                 webidentity.RoleViewer,
		AllowedConnectionIDs: []string{"conn-a"},
	})
	result := application.getSQLAuditEventsContext(viewerCtx, sqlaudit.Filter{})
	if !result.Success {
		t.Fatalf("viewer audit query failed: %s", result.Message)
	}
	page := result.Data.(sqlaudit.Page)
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("viewer audit page = %+v", page)
	}
	if page.Items[0].QueryID != "alice-a" || page.Items[0].TransactionID != "tx-alice-a" {
		t.Fatalf("viewer saw unexpected audit event: %+v", page.Items[0])
	}

	adminCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "bob",
		Role:     webidentity.RoleAdmin,
	})
	adminResult := application.getSQLAuditEventsContext(adminCtx, sqlaudit.Filter{})
	if !adminResult.Success {
		t.Fatalf("admin audit query failed: %s", adminResult.Message)
	}
	if adminPage := adminResult.Data.(sqlaudit.Page); adminPage.Total != 3 {
		t.Fatalf("admin audit total = %d, want 3", adminPage.Total)
	}

	export := application.buildSQLAuditExportResult(viewerCtx, sqlaudit.Filter{}, "json")
	if !export.Success {
		t.Fatalf("viewer audit export failed: %s", export.Message)
	}
	payload := export.Data.(sqlAuditExportPayload)
	var events []sqlaudit.Event
	if err := json.Unmarshal([]byte(payload.Content), &events); err != nil {
		t.Fatalf("decode audit export: %v", err)
	}
	if len(events) != 1 || events[0].QueryID != "alice-a" {
		t.Fatalf("viewer audit export leaked events: %+v", events)
	}
}

func TestGetSavedConnectionsContextFiltersByACL(t *testing.T) {
	application := newSecurityIsolationWebApp(t)
	save := func(name string) connection.SavedConnectionView {
		view, err := application.SaveConnection(connection.SavedConnectionInput{
			Name:            name,
			EnvironmentType: "test",
			Config: connection.ConnectionConfig{
				Type:     "postgres",
				Host:     "127.0.0.1",
				Port:     5432,
				User:     "tester",
				Database: "main",
			},
		})
		if err != nil {
			t.Fatalf("save connection %s: %v", name, err)
		}
		return view
	}
	first := save("first")
	save("second")

	viewerCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username:             "alice",
		Role:                 webidentity.RoleViewer,
		AllowedConnectionIDs: []string{first.ID},
	})
	items, err := application.GetSavedConnectionsContext(viewerCtx)
	if err != nil {
		t.Fatalf("viewer saved connections: %v", err)
	}
	if len(items) != 1 || items[0].ID != first.ID {
		t.Fatalf("viewer saved connections = %+v", items)
	}

	adminCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "admin",
		Role:     webidentity.RoleAdmin,
	})
	items, err = application.GetSavedConnectionsContext(adminCtx)
	if err != nil {
		t.Fatalf("admin saved connections: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("admin saved connection count = %d, want 2", len(items))
	}
}
