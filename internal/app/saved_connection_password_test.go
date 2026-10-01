package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestUpdatePrimaryPasswordReplacesOnlyThePrimarySecret(t *testing.T) {
	app := newSQLAuditTestApp(t)
	repo := app.savedConnectionRepository()
	saved, err := repo.Save(connection.SavedConnectionInput{
		ID:   "conn-1",
		Name: "Local",
		Config: connection.ConnectionConfig{
			Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root", Password: "old-secret",
			UseSSH: true, SSH: connection.SSHConfig{Host: "jump", Port: 22, User: "ops", Password: "ssh-secret"},
		},
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := repo.UpdatePrimaryPassword(saved.ID, "new-secret"); err != nil {
		t.Fatalf("update: %v", err)
	}
	view, bundle, err := repo.loadConnectionSnapshot(saved.ID)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if bundle.Password != "new-secret" || bundle.SSHPassword != "ssh-secret" {
		t.Fatalf("unexpected bundle: password=%q ssh=%q", bundle.Password, bundle.SSHPassword)
	}
	if view.Config.Password != "" || view.Config.Host != "127.0.0.1" || !view.HasPrimaryPassword {
		t.Fatalf("view must stay stripped and intact: %+v", view.Config)
	}
}

func TestUserMgmtSyncConnectionPasswordRejectsMissingConnection(t *testing.T) {
	app := newSQLAuditTestApp(t)
	if result := app.UserMgmtSyncConnectionPassword("missing", "x"); result.Success {
		t.Fatal("missing connection must fail")
	}
	if result := app.UserMgmtSyncConnectionPassword("", "x"); result.Success {
		t.Fatal("empty id must fail")
	}
}
