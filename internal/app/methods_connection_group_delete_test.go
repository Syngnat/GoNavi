package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func seedConnectionGroupDeleteApp(t *testing.T) (*App, uint64) {
	t.Helper()
	application := newConnectionSidebarLayoutTestApp(t)
	for _, item := range []struct {
		id       string
		password string
	}{
		{id: "group-delete-child", password: "child-secret"},
		{id: "group-delete-keep", password: "keep-secret"},
	} {
		if _, err := application.SaveConnection(connection.SavedConnectionInput{
			ID:     item.id,
			Name:   item.id,
			Config: connection.ConnectionConfig{ID: item.id, Type: "mysql", Password: item.password},
		}); err != nil {
			t.Fatalf("SaveConnection(%s): %v", item.id, err)
		}
	}
	layout, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{
			{ID: "group-delete-root", Name: "Root", ConnectionIDs: nil, ChildOrder: []string{"tag:group-delete-child"}},
			{ID: "group-delete-child", Name: "Child", ParentTagID: "group-delete-root", ConnectionIDs: []string{"group-delete-child"}, ChildOrder: []string{"connection:group-delete-child"}},
		},
		SidebarRootOrder: []string{"tag:group-delete-root", "connection:group-delete-keep"},
	})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout: %v", err)
	}
	if layout.Revision == 0 {
		t.Fatalf("bootstrap returned zero revision: %+v", layout)
	}
	return application, layout.Revision
}

func TestDeleteConnectionGroupRemovesSubtreeConnectionsAndSecrets(t *testing.T) {
	application, revision := seedConnectionGroupDeleteApp(t)
	if err := application.DeleteConnectionGroup(connection.DeleteConnectionGroupInput{TagID: "group-delete-root", ExpectedRevision: revision}); err != nil {
		t.Fatalf("DeleteConnectionGroup: %v", err)
	}
	items, err := application.savedConnectionRepository().List()
	if err != nil {
		t.Fatalf("List after DeleteConnectionGroup: %v", err)
	}
	if len(items) != 1 || items[0].ID != "group-delete-keep" {
		t.Fatalf("connections after delete = %#v", items)
	}
	secrets, err := application.savedConnectionRepository().dailySecrets().Load()
	if err != nil {
		t.Fatalf("Load secrets after DeleteConnectionGroup: %v", err)
	}
	if _, exists := secrets.Connections["group-delete-child"]; exists {
		t.Fatal("deleted connection secret still exists")
	}
	layout, err := application.LoadConnectionSidebarLayout()
	if err != nil {
		t.Fatalf("Load layout after DeleteConnectionGroup: %v", err)
	}
	if len(layout.ConnectionTags) != 0 || len(layout.SidebarRootOrder) != 1 || layout.SidebarRootOrder[0] != "connection:group-delete-keep" {
		t.Fatalf("layout after delete = %+v", layout)
	}
}

func TestDeleteConnectionGroupRevisionConflictLeavesFilesUnchanged(t *testing.T) {
	application, revision := seedConnectionGroupDeleteApp(t)
	connectionsPath := filepath.Join(application.configDir, savedConnectionsFileName)
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	connectionsBefore, err := os.ReadFile(connectionsPath)
	if err != nil {
		t.Fatalf("read connections before: %v", err)
	}
	layoutBefore, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read layout before: %v", err)
	}
	if err := application.DeleteConnectionGroup(connection.DeleteConnectionGroupInput{TagID: "group-delete-root", ExpectedRevision: revision + 1}); err == nil || !strings.Contains(err.Error(), "revision conflict") {
		t.Fatalf("DeleteConnectionGroup conflict error = %v", err)
	}
	connectionsAfter, _ := os.ReadFile(connectionsPath)
	layoutAfter, _ := os.ReadFile(layoutPath)
	if string(connectionsAfter) != string(connectionsBefore) || string(layoutAfter) != string(layoutBefore) {
		t.Fatal("revision conflict changed persisted files")
	}
}

func TestDeleteConnectionGroupRollsBackAllFilesWhenLayoutWriteFails(t *testing.T) {
	application, revision := seedConnectionGroupDeleteApp(t)
	connectionsPath := filepath.Join(application.configDir, savedConnectionsFileName)
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	connectionsBefore, _ := os.ReadFile(connectionsPath)
	layoutBefore, _ := os.ReadFile(layoutPath)
	originalWriter := writeConnectionSidebarLayoutFileAtomicFunc
	t.Cleanup(func() { writeConnectionSidebarLayoutFileAtomicFunc = originalWriter })
	writeConnectionSidebarLayoutFileAtomicFunc = func(string, []byte) error { return errors.New("injected group layout write failure") }
	if err := application.DeleteConnectionGroup(connection.DeleteConnectionGroupInput{TagID: "group-delete-root", ExpectedRevision: revision}); err == nil || !strings.Contains(err.Error(), "injected group layout write failure") {
		t.Fatalf("DeleteConnectionGroup layout failure = %v", err)
	}
	connectionsAfter, _ := os.ReadFile(connectionsPath)
	layoutAfter, _ := os.ReadFile(layoutPath)
	if string(connectionsAfter) != string(connectionsBefore) || string(layoutAfter) != string(layoutBefore) {
		t.Fatalf("layout failure did not restore all files (connections equal=%v, layout equal=%v)\nbefore layout=%s\nafter layout=%s", string(connectionsAfter) == string(connectionsBefore), string(layoutAfter) == string(layoutBefore), layoutBefore, layoutAfter)
	}
	if _, err := application.savedConnectionRepository().Find("group-delete-child"); err != nil {
		t.Fatalf("deleted connection not restored: %v", err)
	}
}
