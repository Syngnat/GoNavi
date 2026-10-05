package app

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestCloudBackupRestoreLegacyPayloadPreservesSidebarLayout(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	wantLayout := seedCloudBackupLayoutTestState(t, application)
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	wantLayoutBytes, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read original sidebar layout: %v", err)
	}

	configureCloudBackupRestoreTestPayload(t, application, cloudBackupPayload{
		Connections: connectionPackagePayload{Connections: []connectionPackageItem{
			cloudBackupLayoutTestConnection("shared-layout-host", "Restored layout host", "restored-layout.example.test"),
		}},
	})
	if err := restoreCloudBackupTestPayload(t, application, CloudBackupCategoryConnections); err != nil {
		t.Fatalf("restore legacy cloud backup payload: %v", err)
	}

	gotLayoutBytes, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read sidebar layout after legacy restore: %v", err)
	}
	if !bytes.Equal(gotLayoutBytes, wantLayoutBytes) {
		t.Fatalf("legacy cloud backup changed sidebar layout bytes:\n got: %s\nwant: %s", gotLayoutBytes, wantLayoutBytes)
	}
	gotLayout, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("load sidebar layout after legacy restore: %v", err)
	}
	if !reflect.DeepEqual(gotLayout, wantLayout) {
		t.Fatalf("legacy cloud backup changed sidebar layout: got %#v, want %#v", gotLayout, wantLayout)
	}
	connections, err := application.GetSavedConnections()
	if err != nil {
		t.Fatalf("load connections after legacy restore: %v", err)
	}
	if len(connections) != 1 || connections[0].Config.Host != "restored-layout.example.test" {
		t.Fatalf("legacy cloud backup did not restore its connection: %#v", connections)
	}
}

func TestCloudBackupRestoreExplicitEmptySidebarLayoutClearsGroupsWithLocalRevision(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	localLayout := seedCloudBackupLayoutTestState(t, application)
	remoteRevision := uint64(999)
	configureCloudBackupRestoreTestPayload(t, application, cloudBackupPayload{
		Connections: connectionPackagePayload{Connections: []connectionPackageItem{
			cloudBackupLayoutTestConnection("shared-layout-host", "Restored layout host", "restored-layout.example.test"),
		}},
		ConnectionSidebarLayout: &connection.ConnectionSidebarLayout{
			Initialized:      true,
			Revision:         remoteRevision,
			ConnectionTags:   []connection.ConnectionTag{},
			SidebarRootOrder: []string{},
		},
	})
	if err := restoreCloudBackupTestPayload(t, application, CloudBackupCategoryConnections); err != nil {
		t.Fatalf("restore explicit empty sidebar layout: %v", err)
	}

	got, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("load restored sidebar layout: %v", err)
	}
	if !got.Initialized || got.Revision != localLayout.Revision+1 || got.Revision == remoteRevision {
		t.Fatalf("restored sidebar layout revision = %#v, want local revision %d", got, localLayout.Revision+1)
	}
	if len(got.ConnectionTags) != 0 {
		t.Fatalf("explicit empty sidebar layout did not clear local groups: %#v", got.ConnectionTags)
	}
	if !slices.Contains(got.SidebarRootOrder, "connection:shared-layout-host") {
		t.Fatalf("restored sidebar layout did not normalize the ungrouped host: %#v", got.SidebarRootOrder)
	}
	for _, token := range got.SidebarRootOrder {
		if strings.HasPrefix(token, "tag:") {
			t.Fatalf("restored empty sidebar layout retained a local group token: %#v", got.SidebarRootOrder)
		}
	}
}

func TestCloudBackupRestoreExplicitEmptySidebarLayoutWithoutRemoteConnections(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	localLayout := seedCloudBackupLayoutTestState(t, application)
	configureCloudBackupRestoreTestPayload(t, application, cloudBackupPayload{
		Connections: connectionPackagePayload{Connections: []connectionPackageItem{}},
		ConnectionSidebarLayout: &connection.ConnectionSidebarLayout{
			Initialized:      true,
			Revision:         999,
			ConnectionTags:   []connection.ConnectionTag{},
			SidebarRootOrder: []string{},
		},
	})
	if err := restoreCloudBackupTestPayload(t, application, CloudBackupCategoryConnections); err != nil {
		t.Fatalf("restore empty sidebar layout without remote connections: %v", err)
	}

	got, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("load restored sidebar layout: %v", err)
	}
	if !got.Initialized || got.Revision != localLayout.Revision+1 {
		t.Fatalf("restored sidebar layout revision = %#v, want local revision %d", got, localLayout.Revision+1)
	}
	if len(got.ConnectionTags) != 0 {
		t.Fatalf("empty sidebar layout without remote connections retained local groups: %#v", got.ConnectionTags)
	}
	if !slices.Contains(got.SidebarRootOrder, "connection:shared-layout-host") {
		t.Fatalf("restored sidebar layout did not retain the local-only host as ungrouped: %#v", got.SidebarRootOrder)
	}
}

func TestCloudBackupRestoreRollsBackSidebarLayoutBytesWhenSavedQueryRestoreFails(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	wantLayout := seedCloudBackupLayoutTestState(t, application)
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	connectionsPath := application.savedConnectionRepository().connectionsPath()
	wantLayoutBytes, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read original sidebar layout: %v", err)
	}
	wantConnectionBytes, err := os.ReadFile(connectionsPath)
	if err != nil {
		t.Fatalf("read original connections: %v", err)
	}
	if err := os.Mkdir(filepath.Join(application.configDir, savedQueriesFileName), 0o755); err != nil {
		t.Fatalf("create saved query failure fixture: %v", err)
	}

	configureCloudBackupRestoreTestPayload(t, application, cloudBackupPayload{
		Connections: connectionPackagePayload{Connections: []connectionPackageItem{
			cloudBackupLayoutTestConnection("shared-layout-host", "Restored layout host", "restored-layout.example.test"),
		}},
		ConnectionSidebarLayout: &connection.ConnectionSidebarLayout{
			Initialized: true,
			Revision:    200,
			ConnectionTags: []connection.ConnectionTag{{
				ID: "remote-layout-group", Name: "Remote layout group",
				ConnectionIDs: []string{"shared-layout-host"},
				ChildOrder:    []string{"connection:shared-layout-host"},
			}},
			SidebarRootOrder: []string{"tag:remote-layout-group"},
		},
		Files: []cloudBackupFile{{
			Path: savedQueriesFileName,
			Data: []byte(`{"version":3,"queries":[{"id":"remote-query","name":"Remote query","sql":"select 1","connectionId":"shared-layout-host","dbName":"layout_test","createdAt":1}]}`),
		}},
	})
	restoreErr := restoreCloudBackupTestPayload(
		t,
		application,
		CloudBackupCategoryConnections,
		CloudBackupCategorySavedQueries,
	)
	if restoreErr == nil {
		t.Fatal("saved query restore fixture should fail after mutating connections and sidebar layout")
	}

	gotLayoutBytes, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read sidebar layout after rollback: %v", err)
	}
	if !bytes.Equal(gotLayoutBytes, wantLayoutBytes) {
		t.Fatalf("sidebar layout rollback did not restore original bytes:\n got: %s\nwant: %s", gotLayoutBytes, wantLayoutBytes)
	}
	gotConnectionBytes, err := os.ReadFile(connectionsPath)
	if err != nil {
		t.Fatalf("read connections after rollback: %v", err)
	}
	if !bytes.Equal(gotConnectionBytes, wantConnectionBytes) {
		t.Fatalf("connection rollback did not restore original bytes:\n got: %s\nwant: %s", gotConnectionBytes, wantConnectionBytes)
	}
	gotLayout, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("load sidebar layout after rollback: %v", err)
	}
	if !reflect.DeepEqual(gotLayout, wantLayout) {
		t.Fatalf("sidebar layout rollback changed local revision or groups: got %#v, want %#v", gotLayout, wantLayout)
	}
}

func TestCloudBackupRestoreRollbackRemovesSidebarLayoutThatWasOriginallyMissing(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "shared-layout-host", Name: "Local layout host",
		Config: connection.ConnectionConfig{
			ID: "shared-layout-host", Type: "mysql", Host: "local-layout.example.test", Port: 3306,
		},
	}); err != nil {
		t.Fatalf("seed local connection without a layout: %v", err)
	}
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	if _, err := os.Stat(layoutPath); !os.IsNotExist(err) {
		t.Fatalf("sidebar layout unexpectedly existed before restore: %v", err)
	}
	if err := os.Mkdir(filepath.Join(application.configDir, savedQueriesFileName), 0o755); err != nil {
		t.Fatalf("create saved query failure fixture: %v", err)
	}

	configureCloudBackupRestoreTestPayload(t, application, cloudBackupPayload{
		Connections: connectionPackagePayload{Connections: []connectionPackageItem{
			cloudBackupLayoutTestConnection("shared-layout-host", "Restored layout host", "restored-layout.example.test"),
		}},
		ConnectionSidebarLayout: &connection.ConnectionSidebarLayout{
			Initialized: true,
			Revision:    200,
			ConnectionTags: []connection.ConnectionTag{{
				ID: "remote-layout-group", Name: "Remote layout group",
				ConnectionIDs: []string{"shared-layout-host"},
				ChildOrder:    []string{"connection:shared-layout-host"},
			}},
			SidebarRootOrder: []string{"tag:remote-layout-group"},
		},
		Files: []cloudBackupFile{{
			Path: savedQueriesFileName,
			Data: []byte(`{"version":3,"queries":[{"id":"remote-query","name":"Remote query","sql":"select 1","connectionId":"shared-layout-host","dbName":"layout_test","createdAt":1}]}`),
		}},
	})
	restoreErr := restoreCloudBackupTestPayload(
		t,
		application,
		CloudBackupCategoryConnections,
		CloudBackupCategorySavedQueries,
	)
	if restoreErr == nil {
		t.Fatal("saved query restore fixture should fail after creating the sidebar layout")
	}
	if _, err := os.Stat(layoutPath); !os.IsNotExist(err) {
		t.Fatalf("rollback retained a sidebar layout that did not originally exist: %v", err)
	}
	got, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("bootstrap sidebar layout after rollback: %v", err)
	}
	if got.Initialized || got.Revision != 0 {
		t.Fatalf("rollback changed an uninitialized sidebar layout: %#v", got)
	}
}

func TestCloudBackupRestoreSelectionAndConfirmationToken(t *testing.T) {
	payload := cloudBackupPayload{
		SchemaVersion: cloudBackupPayloadSchemaVersion,
		CreatedAt:     "2026-07-27T03:22:04Z",
		Connections: connectionPackagePayload{Connections: []connectionPackageItem{{
			ID: "connection-1", Name: "Connection 1",
		}}},
		Files: []cloudBackupFile{
			{Path: "ai_config.json", Data: []byte(`{"provider":"remote"}`)},
			{Path: "global_proxy.json", Data: []byte(`{"host":"remote"}`)},
			{Path: "saved_queries/query.sql", Data: []byte("select 1")},
		},
	}
	restoreConnections, files, selected, err := selectCloudBackupRestorePayload(payload, []string{
		CloudBackupCategoryAISettings,
		CloudBackupCategorySavedQueries,
	})
	if err != nil {
		t.Fatalf("selectCloudBackupRestorePayload returned error: %v", err)
	}
	if restoreConnections || len(files) != 2 {
		t.Fatalf("unexpected selective restore payload: connections=%v files=%#v", restoreConnections, files)
	}
	preview, err := buildCloudBackupRestorePreview(payload, selected)
	if err != nil || preview.ConnectionCount != 0 || preview.FileCount != 2 || len(preview.Categories) != 2 {
		t.Fatalf("unexpected selective restore preview: preview=%#v err=%v", preview, err)
	}

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	token, err := application.issueCloudBackupRestoreConfirmationToken(payload)
	if err != nil {
		t.Fatalf("issue confirmation token: %v", err)
	}
	if err := application.consumeCloudBackupRestoreConfirmationToken(token, payload); err != nil {
		t.Fatalf("consume confirmation token: %v", err)
	}
	if err := application.consumeCloudBackupRestoreConfirmationToken(token, payload); err == nil {
		t.Fatal("replayed confirmation token should fail")
	}

	changedPayload := payload
	changedPayload.CreatedAt = "2026-07-27T03:23:04Z"
	changedToken, err := application.issueCloudBackupRestoreConfirmationToken(payload)
	if err != nil {
		t.Fatalf("issue confirmation token for changed payload test: %v", err)
	}
	if err := application.consumeCloudBackupRestoreConfirmationToken(changedToken, changedPayload); err == nil {
		t.Fatal("confirmation token should reject a changed remote payload")
	}
}

func TestCloudBackupRestorePreviewOffersSidebarLayoutWithoutConnections(t *testing.T) {
	payload := cloudBackupPayload{
		SchemaVersion: cloudBackupPayloadSchemaVersion,
		CreatedAt:     "2026-08-25T00:00:00Z",
		Connections:   connectionPackagePayload{Connections: []connectionPackageItem{}},
		ConnectionSidebarLayout: &connection.ConnectionSidebarLayout{
			Initialized:      true,
			Revision:         1,
			ConnectionTags:   []connection.ConnectionTag{},
			SidebarRootOrder: []string{},
		},
	}

	preview, err := buildCloudBackupRestorePreview(payload, nil)
	if err != nil {
		t.Fatalf("build restore preview: %v", err)
	}
	if len(preview.Categories) != 1 || preview.Categories[0].ID != CloudBackupCategoryConnections || preview.Categories[0].ItemCount != 0 {
		t.Fatalf("restore preview omitted the sidebar-only connections category: %#v", preview)
	}
	restoreConnections, files, selected, err := selectCloudBackupRestorePayload(
		payload,
		[]string{CloudBackupCategoryConnections},
	)
	if err != nil {
		t.Fatalf("select sidebar-only connections category: %v", err)
	}
	if !restoreConnections || len(files) != 0 {
		t.Fatalf("unexpected sidebar-only restore selection: restoreConnections=%v files=%#v", restoreConnections, files)
	}
	if _, ok := selected[CloudBackupCategoryConnections]; !ok {
		t.Fatalf("sidebar-only connections category was not selected: %#v", selected)
	}
}
