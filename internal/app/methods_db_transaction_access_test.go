package app

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/webidentity"
)

func TestAuthorizeManagedSQLTransactionAccess(t *testing.T) {
	application := NewWebApp()
	tx := &managedSQLTransaction{
		id:    "tx-1",
		owner: "alice",
		config: connection.ConnectionConfig{
			ID:   "conn-a",
			Type: "postgres",
		},
	}
	actorContext := func(actor webidentity.Actor) context.Context {
		return webidentity.WithActor(context.Background(), actor)
	}

	if err := application.authorizeManagedSQLTransactionAccess(actorContext(webidentity.Actor{
		Username: "bob",
		Role:     webidentity.RoleAdmin,
	}), tx, "SELECT 1"); err == nil {
		t.Fatal("a different actor must not access the transaction")
	}
	if err := application.authorizeManagedSQLTransactionAccess(actorContext(webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	}), tx, "UPDATE users SET active = 1"); err != nil {
		t.Fatalf("owner transaction access failed: %v", err)
	}
	if err := application.authorizeManagedSQLTransactionAccess(actorContext(webidentity.Actor{
		Username:             "alice",
		Role:                 webidentity.RoleAdmin,
		AllowedConnectionIDs: []string{"conn-b"},
	}), tx, "SELECT 1"); err == nil {
		t.Fatal("a transaction outside the connection ACL must be rejected")
	}
	if err := application.authorizeManagedSQLTransactionAccess(actorContext(webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleViewer,
	}), tx, "DELETE FROM users"); err == nil {
		t.Fatal("viewer follow-up writes must be rejected")
	}
	if err := application.authorizeManagedSQLTransactionAccess(actorContext(webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleViewer,
	}), tx, "SELECT 1"); err != nil {
		t.Fatalf("viewer follow-up read failed: %v", err)
	}
}

func TestFinishManagedSQLTransactionRejectsNonOwnerWithoutDeleting(t *testing.T) {
	application := NewWebApp()
	application.sqlTransactions = map[string]*managedSQLTransaction{
		"tx-1": {
			id:     "tx-1",
			owner:  "alice",
			config: connection.ConnectionConfig{ID: "conn-a", Type: "postgres"},
		},
	}
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "bob",
		Role:     webidentity.RoleAdmin,
	})
	result := application.finishManagedSQLTransactionContext(ctx, "tx-1", false, "manual")
	if result.Success {
		t.Fatal("non-owner rollback unexpectedly succeeded")
	}
	if application.sqlTransactions["tx-1"] == nil {
		t.Fatal("non-owner rollback removed another user's transaction")
	}
}
