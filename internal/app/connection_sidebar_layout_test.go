package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

func newConnectionSidebarLayoutTestApp(t *testing.T) *App {
	t.Helper()
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	application.configDir = t.TempDir()
	return application
}

func saveConnectionSidebarLayoutTestConnection(t *testing.T, application *App, id string) {
	t.Helper()
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID:     id,
		Name:   id,
		Config: connection.ConnectionConfig{ID: id, Type: "mysql", Host: "127.0.0.1", Port: 3306},
	}); err != nil {
		t.Fatalf("SaveConnection(%s): %v", id, err)
	}
}

func assertConnectionSidebarTagsWithCreatedAt(
	t *testing.T,
	got []connection.ConnectionTag,
	want []connection.ConnectionTag,
) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("tag count = %d, want %d: %#v", len(got), len(want), got)
	}
	comparable := append([]connection.ConnectionTag(nil), got...)
	for index := range comparable {
		if comparable[index].CreatedAt <= 0 {
			t.Fatalf("tag %q has invalid createdAt %d", comparable[index].ID, comparable[index].CreatedAt)
		}
		comparable[index].CreatedAt = 0
	}
	expected := append([]connection.ConnectionTag(nil), want...)
	for index := range expected {
		// Legacy layout candidates are normalized to explicit sort modes on read.
		if expected[index].SortMode == "" {
			expected[index].SortMode = "manual"
		}
		if expected[index].ConnectionSortMode == "" {
			expected[index].ConnectionSortMode = "createdAt"
		}
	}
	if !reflect.DeepEqual(comparable, expected) {
		t.Fatalf("connection tags = %#v, want %#v", comparable, expected)
	}
}

func TestBootstrapConnectionSidebarLayoutPersistsFirstNonEmptyCandidate(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-dev")
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-local")

	candidate := connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-dev",
			Name:          "开发",
			ConnectionIDs: []string{"conn-dev"},
			ChildOrder:    []string{"connection:conn-dev"},
		}},
		SidebarRootOrder: []string{"tag:tag-dev", "connection:conn-local"},
	}
	initialized, err := application.BootstrapConnectionSidebarLayout(candidate)
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout: %v", err)
	}
	if !initialized.Initialized || initialized.Revision != 1 {
		t.Fatalf("initialized state = %+v, want initialized revision 1", initialized)
	}
	assertConnectionSidebarTagsWithCreatedAt(t, initialized.ConnectionTags, candidate.ConnectionTags)
	if !reflect.DeepEqual(initialized.SidebarRootOrder, candidate.SidebarRootOrder) {
		t.Fatalf("root order = %#v, want %#v", initialized.SidebarRootOrder, candidate.SidebarRootOrder)
	}

	restarted := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	restarted.configDir = application.configDir
	loaded, err := restarted.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout after restart: %v", err)
	}
	if !reflect.DeepEqual(loaded, initialized) {
		t.Fatalf("reloaded layout = %+v, want %+v", loaded, initialized)
	}
	if _, err := filepath.Abs(filepath.Join(application.configDir, connectionSidebarLayoutFileName)); err != nil {
		t.Fatalf("layout path is invalid: %v", err)
	}
}

func TestBootstrapConnectionSidebarLayoutDoesNotPersistEmptyGroups(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-local")

	got, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		SidebarRootOrder: []string{"connection:conn-local"},
	})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout: %v", err)
	}
	if got.Initialized || got.Revision != 0 || len(got.ConnectionTags) != 0 || len(got.SidebarRootOrder) != 0 {
		t.Fatalf("empty-group bootstrap = %+v, want uninitialized empty state", got)
	}
	if _, err := os.Stat(filepath.Join(application.configDir, connectionSidebarLayoutFileName)); !os.IsNotExist(err) {
		t.Fatalf("empty-group bootstrap created the layout file: %v", err)
	}
}

func TestConnectionSidebarLayoutPersistsLegacyTagCreatedAtAndRootConnectionSortMode(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	legacy := []byte(`{"version":1,"revision":3,"connectionTags":[{"id":"legacy-tag","name":"Legacy","connectionIds":[]}],"sidebarRootOrder":["tag:legacy-tag"],"rootSortMode":"name"}`)
	if err := os.WriteFile(layoutPath, legacy, 0o644); err != nil {
		t.Fatalf("write legacy layout: %v", err)
	}

	loaded, err := application.LoadConnectionSidebarLayout()
	if err != nil {
		t.Fatalf("LoadConnectionSidebarLayout: %v", err)
	}
	if loaded.RootSortMode != "manual" || loaded.RootConnectionSortMode != "name" || len(loaded.ConnectionTags) != 1 || loaded.ConnectionTags[0].CreatedAt <= 0 {
		t.Fatalf("loaded legacy layout = %+v, want manual root sort, name connection sort and migrated timestamp", loaded)
	}

	persistedBytes, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read migrated layout: %v", err)
	}
	var persisted connectionSidebarLayoutDiskFile
	if err := json.Unmarshal(persistedBytes, &persisted); err != nil {
		t.Fatalf("decode migrated layout: %v", err)
	}
	if persisted.RootSortMode != "manual" || persisted.RootConnectionSortMode != "name" || len(persisted.ConnectionTags) != 1 || persisted.ConnectionTags[0].CreatedAt != loaded.ConnectionTags[0].CreatedAt {
		t.Fatalf("persisted migrated layout = %+v, want manual root sort, connection sort and timestamp", persisted)
	}

	bootstrapped, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout: %v", err)
	}
	if bootstrapped.RootSortMode != "manual" || bootstrapped.RootConnectionSortMode != "name" {
		t.Fatalf("bootstrap sort modes = root %q, connections %q; want manual/name", bootstrapped.RootSortMode, bootstrapped.RootConnectionSortMode)
	}
}

func TestLoadConnectionSidebarLayoutMissingIsReadOnly(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-local")
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)

	loaded, err := application.LoadConnectionSidebarLayout()
	if err != nil {
		t.Fatalf("LoadConnectionSidebarLayout: %v", err)
	}
	if loaded.Initialized || loaded.Revision != 0 || len(loaded.ConnectionTags) != 0 || len(loaded.SidebarRootOrder) != 0 {
		t.Fatalf("missing layout load = %+v, want uninitialized empty state", loaded)
	}
	if _, err := os.Stat(layoutPath); !os.IsNotExist(err) {
		t.Fatalf("read-only load created the layout file: %v", err)
	}
}

func TestLoadConnectionSidebarLayoutRefreshesAnotherInstanceAndPreservesCAS(t *testing.T) {
	configDir := t.TempDir()
	instanceA := NewAppWithSecretStore(secretstore.NewUnavailableStore("test-a"))
	instanceA.configDir = configDir
	instanceB := NewAppWithSecretStore(secretstore.NewUnavailableStore("test-b"))
	instanceB.configDir = configDir
	saveConnectionSidebarLayoutTestConnection(t, instanceA, "conn-shared")

	initial, err := instanceA.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-shared",
			Name:          "Initial",
			ConnectionIDs: []string{"conn-shared"},
		}},
	})
	if err != nil {
		t.Fatalf("instance A bootstrap: %v", err)
	}
	updated, err := instanceB.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: initial.Revision,
		Layout: connection.ConnectionSidebarLayoutInput{
			ConnectionTags: []connection.ConnectionTag{{
				ID:            "tag-shared",
				Name:          "Updated by B",
				ConnectionIDs: []string{"conn-shared"},
			}},
		},
	})
	if err != nil {
		t.Fatalf("instance B save: %v", err)
	}
	if updated.Conflict {
		t.Fatalf("instance B save unexpectedly conflicted: %+v", updated)
	}

	loaded, err := instanceA.LoadConnectionSidebarLayout()
	if err != nil {
		t.Fatalf("instance A refresh: %v", err)
	}
	if !reflect.DeepEqual(loaded, updated.Layout) {
		t.Fatalf("instance A refreshed layout = %+v, want instance B authority %+v", loaded, updated.Layout)
	}

	resaved, err := instanceA.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: loaded.Revision,
		Layout: connection.ConnectionSidebarLayoutInput{
			ConnectionTags:   loaded.ConnectionTags,
			SidebarRootOrder: loaded.SidebarRootOrder,
		},
	})
	if err != nil {
		t.Fatalf("instance A save after refresh: %v", err)
	}
	if resaved.Conflict || resaved.Layout.Revision != loaded.Revision+1 {
		t.Fatalf("instance A save after refresh = %+v, want successful next revision", resaved)
	}
}

func TestLoadConnectionSidebarLayoutNormalizesWithoutWriting(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-a")
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-b")
	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-b",
			Name:          "B",
			ConnectionIDs: []string{"conn-b"},
		}},
	})
	if err != nil {
		t.Fatalf("bootstrap initial layout: %v", err)
	}
	if err := application.DeleteConnection("conn-b"); err != nil {
		t.Fatalf("delete grouped connection: %v", err)
	}
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	before, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read layout before refresh: %v", err)
	}

	loaded, err := application.LoadConnectionSidebarLayout()
	if err != nil {
		t.Fatalf("load normalized layout: %v", err)
	}
	if loaded.Revision != initial.Revision {
		t.Fatalf("read-only normalization revision = %d, want %d", loaded.Revision, initial.Revision)
	}
	if len(loaded.ConnectionTags) != 1 || len(loaded.ConnectionTags[0].ConnectionIDs) != 0 {
		t.Fatalf("read-only normalization retained deleted host: %+v", loaded)
	}
	after, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read layout after refresh: %v", err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("read-only normalization changed layout bytes: before=%q after=%q", before, after)
	}

	saved, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: loaded.Revision,
		Layout: connection.ConnectionSidebarLayoutInput{
			ConnectionTags:   loaded.ConnectionTags,
			SidebarRootOrder: loaded.SidebarRootOrder,
		},
	})
	if err != nil {
		t.Fatalf("save normalized view: %v", err)
	}
	if saved.Conflict || saved.Layout.Revision != loaded.Revision+1 {
		t.Fatalf("save normalized view = %+v, want successful next revision", saved)
	}
}

func TestSaveConnectionSidebarLayoutPersistsExplicitEmptyLayout(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-local")

	saved, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: 0,
		Layout:           connection.ConnectionSidebarLayoutInput{},
	})
	if err != nil {
		t.Fatalf("SaveConnectionSidebarLayout: %v", err)
	}
	if saved.Conflict {
		t.Fatalf("initial explicit save conflicted: %+v", saved)
	}
	if !saved.Layout.Initialized || saved.Layout.Revision != 1 {
		t.Fatalf("saved layout = %+v, want initialized revision 1", saved.Layout)
	}
	if len(saved.Layout.ConnectionTags) != 0 {
		t.Fatalf("saved explicit empty groups = %+v", saved.Layout)
	}
	if !reflect.DeepEqual(saved.Layout.SidebarRootOrder, []string{"connection:conn-local"}) {
		t.Fatalf("saved root order = %#v, want the ungrouped host", saved.Layout.SidebarRootOrder)
	}

	restarted := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	restarted.configDir = application.configDir
	loaded, err := restarted.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "legacy-tag",
			Name:          "旧分组",
			ConnectionIDs: []string{"conn-local"},
		}},
	})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout after explicit empty save: %v", err)
	}
	if !reflect.DeepEqual(loaded, saved.Layout) {
		t.Fatalf("bootstrap resurrected legacy groups: got %+v want %+v", loaded, saved.Layout)
	}
}

func TestSaveConnectionSidebarLayoutUsesRevisionCAS(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-a")
	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-a",
			Name:          "A",
			ConnectionIDs: []string{"conn-a"},
		}},
	})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout: %v", err)
	}

	updated, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: initial.Revision,
		Layout: connection.ConnectionSidebarLayoutInput{
			ConnectionTags: []connection.ConnectionTag{{
				ID:            "tag-a",
				Name:          "A renamed",
				ConnectionIDs: []string{"conn-a"},
			}},
		},
	})
	if err != nil {
		t.Fatalf("SaveConnectionSidebarLayout current revision: %v", err)
	}
	if updated.Conflict || updated.Layout.Revision != initial.Revision+1 {
		t.Fatalf("updated result = %+v, want non-conflict revision %d", updated, initial.Revision+1)
	}
	if got := updated.Layout.ConnectionTags[0].Name; got != "A renamed" {
		t.Fatalf("updated group name = %q, want A renamed", got)
	}

	stale, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: initial.Revision,
		Layout: connection.ConnectionSidebarLayoutInput{
			ConnectionTags: []connection.ConnectionTag{{ID: "stale", Name: "stale"}},
		},
	})
	if err != nil {
		t.Fatalf("SaveConnectionSidebarLayout stale revision: %v", err)
	}
	if !stale.Conflict {
		t.Fatalf("stale save unexpectedly succeeded: %+v", stale)
	}
	if !reflect.DeepEqual(stale.Layout, updated.Layout) {
		t.Fatalf("stale conflict layout = %+v, want current %+v", stale.Layout, updated.Layout)
	}

	loaded, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout after stale save: %v", err)
	}
	if !reflect.DeepEqual(loaded, updated.Layout) {
		t.Fatalf("stale save changed disk: got %+v want %+v", loaded, updated.Layout)
	}
}

func TestSaveConnectionSidebarLayoutMarksCloudBackupDirtyOnlyAfterSuccessfulWrite(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	if err := application.saveCloudBackupState(CloudBackupConfig{
		Enabled:          true,
		Provider:         CloudBackupProviderWebDAV,
		Schedule:         CloudBackupScheduleManual,
		BackupCategories: []string{CloudBackupCategoryConnections},
	}); err != nil {
		t.Fatalf("enable cloud backup state: %v", err)
	}
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-dirty")
	_, seedDirtyRevision := application.cloudBackupDirtyState()
	application.clearCloudBackupDirty(seedDirtyRevision)

	saved, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: 0,
		Layout: connection.ConnectionSidebarLayoutInput{
			ConnectionTags: []connection.ConnectionTag{{
				ID:            "tag-dirty",
				Name:          "Dirty",
				ConnectionIDs: []string{"conn-dirty"},
			}},
		},
	})
	if err != nil || saved.Conflict {
		t.Fatalf("successful layout save = %+v, err=%v", saved, err)
	}
	dirty, successfulRevision := application.cloudBackupDirtyState()
	if !dirty || successfulRevision != seedDirtyRevision+1 {
		t.Fatalf("successful layout save dirty state = (%v, %d), want (true, %d)", dirty, successfulRevision, seedDirtyRevision+1)
	}
	application.clearCloudBackupDirty(successfulRevision)

	conflict, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: 0,
		Layout:           connection.ConnectionSidebarLayoutInput{},
	})
	if err != nil || !conflict.Conflict {
		t.Fatalf("stale layout save = %+v, err=%v, want conflict", conflict, err)
	}
	if dirty, revision := application.cloudBackupDirtyState(); dirty || revision != successfulRevision {
		t.Fatalf("conflicted layout save dirty state = (%v, %d), want (false, %d)", dirty, revision, successfulRevision)
	}

	if err := os.WriteFile(
		filepath.Join(application.configDir, connectionSidebarLayoutFileName),
		[]byte("{broken"),
		0o644,
	); err != nil {
		t.Fatalf("corrupt layout file: %v", err)
	}
	if _, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: saved.Layout.Revision,
		Layout:           connection.ConnectionSidebarLayoutInput{},
	}); err == nil {
		t.Fatal("layout save unexpectedly accepted corrupt authoritative file")
	}
	if dirty, revision := application.cloudBackupDirtyState(); dirty || revision != successfulRevision {
		t.Fatalf("failed layout save dirty state = (%v, %d), want (false, %d)", dirty, revision, successfulRevision)
	}
}

func TestConnectionSidebarLayoutReplaceUnlockedClearsGroupsAndAdvancesLocalRevision(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-restore")
	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-local",
			Name:          "Local",
			ConnectionIDs: []string{"conn-restore"},
		}},
	})
	if err != nil {
		t.Fatalf("bootstrap local layout: %v", err)
	}

	var replaced connection.ConnectionSidebarLayout
	savedConnections := application.savedConnectionRepository()
	err = savedConnections.withWriteLock(func() error {
		var replaceErr error
		replaced, replaceErr = application.connectionSidebarLayoutRepository().replaceUnlocked(
			connection.ConnectionSidebarLayoutInput{},
		)
		return replaceErr
	})
	if err != nil {
		t.Fatalf("replace layout under saved-connection write lock: %v", err)
	}
	if replaced.Revision != initial.Revision+1 {
		t.Fatalf("replacement revision = %d, want local revision %d", replaced.Revision, initial.Revision+1)
	}
	if len(replaced.ConnectionTags) != 0 {
		t.Fatalf("replacement retained local groups: %#v", replaced.ConnectionTags)
	}
	if !reflect.DeepEqual(replaced.SidebarRootOrder, []string{"connection:conn-restore"}) {
		t.Fatalf("replacement root order = %#v, want ungrouped restored host", replaced.SidebarRootOrder)
	}
}

func TestConnectionSidebarLayoutSnapshotRollbackRestoresExactFileBytes(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-snapshot")
	if _, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-snapshot",
			Name:          "Snapshot",
			ConnectionIDs: []string{"conn-snapshot"},
		}},
	}); err != nil {
		t.Fatalf("bootstrap layout: %v", err)
	}
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	before, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read layout before snapshot: %v", err)
	}

	layoutRepository := application.connectionSidebarLayoutRepository()
	savedConnections := application.savedConnectionRepository()
	err = savedConnections.withWriteLock(func() error {
		snapshot, snapshotErr := captureConnectionSidebarLayoutSnapshotUnlocked(layoutRepository)
		if snapshotErr != nil {
			return snapshotErr
		}
		if _, replaceErr := layoutRepository.replaceUnlocked(connection.ConnectionSidebarLayoutInput{}); replaceErr != nil {
			return replaceErr
		}
		return snapshot.restoreUnlocked(layoutRepository)
	})
	if err != nil {
		t.Fatalf("replace and rollback layout: %v", err)
	}
	after, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read layout after rollback: %v", err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("rollback changed authoritative layout bytes:\nbefore=%s\nafter=%s", before, after)
	}
}

func TestConnectionSidebarLayoutSnapshotRollbackRestoresMissingFileState(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-missing-snapshot")
	layoutRepository := application.connectionSidebarLayoutRepository()
	savedConnections := application.savedConnectionRepository()
	err := savedConnections.withWriteLock(func() error {
		snapshot, snapshotErr := captureConnectionSidebarLayoutSnapshotUnlocked(layoutRepository)
		if snapshotErr != nil {
			return snapshotErr
		}
		if _, replaceErr := layoutRepository.replaceUnlocked(connection.ConnectionSidebarLayoutInput{}); replaceErr != nil {
			return replaceErr
		}
		return snapshot.restoreUnlocked(layoutRepository)
	})
	if err != nil {
		t.Fatalf("create and rollback layout: %v", err)
	}
	if _, err := os.Stat(layoutRepository.layoutPath()); !os.IsNotExist(err) {
		t.Fatalf("rollback did not restore missing layout state: %v", err)
	}
}

func TestBootstrapConnectionSidebarLayoutNormalizesAgainstSavedConnections(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-a")
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-b")

	got, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{
			{
				ID:            "tag-a",
				Name:          "A",
				ConnectionIDs: []string{"conn-a", "missing", "conn-a"},
				ChildOrder: []string{
					"connection:missing",
					"connection:conn-a",
					"invalid-token",
				},
			},
			{
				ID:            "tag-b",
				Name:          "B",
				ConnectionIDs: []string{"conn-a", "conn-b"},
			},
		},
		SidebarRootOrder: []string{
			"tag:tag-a",
			"connection:missing",
			"tag:missing",
			"connection:conn-b",
		},
	})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout: %v", err)
	}

	wantTags := []connection.ConnectionTag{
		{
			ID:            "tag-a",
			Name:          "A",
			ConnectionIDs: []string{"conn-a"},
			ChildOrder:    []string{"connection:conn-a"},
		},
		{
			ID:            "tag-b",
			Name:          "B",
			ConnectionIDs: []string{"conn-b"},
			ChildOrder:    []string{"connection:conn-b"},
		},
	}
	assertConnectionSidebarTagsWithCreatedAt(t, got.ConnectionTags, wantTags)
	wantRootOrder := []string{"tag:tag-a", "tag:tag-b"}
	if !reflect.DeepEqual(got.SidebarRootOrder, wantRootOrder) {
		t.Fatalf("normalized root order = %#v, want %#v", got.SidebarRootOrder, wantRootOrder)
	}
}

func TestBootstrapConnectionSidebarLayoutRepairsHierarchyAndCompletesOrders(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	for _, id := range []string{"conn-parent", "conn-child", "conn-ungrouped"} {
		saveConnectionSidebarLayoutTestConnection(t, application, id)
	}

	got, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{
			{ID: "parent", Name: "Parent", ConnectionIDs: []string{"conn-parent"}},
			{ID: "child", Name: "Child", ParentTagID: "parent", ConnectionIDs: []string{"conn-child"}},
			{ID: "missing-parent", Name: "Missing", ParentTagID: "does-not-exist"},
			{ID: "self-parent", Name: "Self", ParentTagID: "self-parent"},
			{ID: "cycle-a", Name: "Cycle A", ParentTagID: "cycle-b"},
			{ID: "cycle-b", Name: "Cycle B", ParentTagID: "cycle-a"},
		},
		SidebarRootOrder: []string{"tag:parent"},
	})
	if err != nil {
		t.Fatalf("BootstrapConnectionSidebarLayout: %v", err)
	}

	wantTags := []connection.ConnectionTag{
		{
			ID:            "parent",
			Name:          "Parent",
			ConnectionIDs: []string{"conn-parent"},
			ChildOrder:    []string{"connection:conn-parent", "tag:child"},
		},
		{
			ID:            "child",
			Name:          "Child",
			ParentTagID:   "parent",
			ConnectionIDs: []string{"conn-child"},
			ChildOrder:    []string{"connection:conn-child"},
		},
		{ID: "missing-parent", Name: "Missing", ConnectionIDs: []string{}, ChildOrder: []string{}},
		{ID: "self-parent", Name: "Self", ConnectionIDs: []string{}, ChildOrder: []string{}},
		{ID: "cycle-a", Name: "Cycle A", ConnectionIDs: []string{}, ChildOrder: []string{}},
		{ID: "cycle-b", Name: "Cycle B", ConnectionIDs: []string{}, ChildOrder: []string{}},
	}
	assertConnectionSidebarTagsWithCreatedAt(t, got.ConnectionTags, wantTags)
	wantRootOrder := []string{
		"tag:parent",
		"tag:missing-parent",
		"tag:self-parent",
		"tag:cycle-a",
		"tag:cycle-b",
		"connection:conn-ungrouped",
	}
	if !reflect.DeepEqual(got.SidebarRootOrder, wantRootOrder) {
		t.Fatalf("completed root order = %#v, want %#v", got.SidebarRootOrder, wantRootOrder)
	}
}

func TestConnectionSidebarLayoutCorruptJSONReturnsErrorWithoutOverwrite(t *testing.T) {
	operations := []struct {
		name string
		run  func(*App) error
	}{
		{
			name: "bootstrap",
			run: func(application *App) error {
				_, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
					ConnectionTags: []connection.ConnectionTag{{ID: "candidate", Name: "Candidate"}},
				})
				return err
			},
		},
		{
			name: "save",
			run: func(application *App) error {
				_, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
					ExpectedRevision: 0,
					Layout:           connection.ConnectionSidebarLayoutInput{},
				})
				return err
			},
		},
	}

	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			application := newConnectionSidebarLayoutTestApp(t)
			layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
			corrupt := []byte("{not valid json")
			if err := os.WriteFile(layoutPath, corrupt, 0o644); err != nil {
				t.Fatalf("write corrupt layout: %v", err)
			}
			if err := operation.run(application); err == nil {
				t.Fatal("operation unexpectedly accepted corrupt layout JSON")
			}
			after, err := os.ReadFile(layoutPath)
			if err != nil {
				t.Fatalf("read corrupt layout after rejected operation: %v", err)
			}
			if !bytes.Equal(after, corrupt) {
				t.Fatalf("rejected operation overwrote corrupt layout: before=%q after=%q", corrupt, after)
			}
		})
	}
}

func TestConnectionSidebarLayoutFutureVersionReturnsErrorWithoutOverwrite(t *testing.T) {
	operations := []struct {
		name string
		run  func(*App) error
	}{
		{
			name: "bootstrap",
			run: func(application *App) error {
				_, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
					ConnectionTags: []connection.ConnectionTag{{ID: "candidate", Name: "Candidate"}},
				})
				return err
			},
		},
		{
			name: "save",
			run: func(application *App) error {
				_, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
					ExpectedRevision: 1,
					Layout:           connection.ConnectionSidebarLayoutInput{},
				})
				return err
			},
		},
	}

	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			application := newConnectionSidebarLayoutTestApp(t)
			layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
			future := []byte(fmt.Sprintf(`{"version":%d,"revision":1,"connectionTags":[],"sidebarRootOrder":[]}`, connectionSidebarLayoutFormatVersion+1))
			if err := os.WriteFile(layoutPath, future, 0o644); err != nil {
				t.Fatalf("write future layout: %v", err)
			}
			if err := operation.run(application); err == nil {
				t.Fatal("operation unexpectedly accepted future layout version")
			}
			after, err := os.ReadFile(layoutPath)
			if err != nil {
				t.Fatalf("read future layout after rejected operation: %v", err)
			}
			if !bytes.Equal(after, future) {
				t.Fatalf("rejected operation overwrote future layout: before=%q after=%q", future, after)
			}
		})
	}
}

func TestSaveConnectionSidebarLayoutRevisionOverflowPreservesFile(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	before := []byte(`{"version":1,"revision":18446744073709551615,"connectionTags":[],"sidebarRootOrder":[]}`)
	if err := os.WriteFile(layoutPath, before, 0o644); err != nil {
		t.Fatalf("write max-revision layout: %v", err)
	}

	if _, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: ^uint64(0),
		Layout:           connection.ConnectionSidebarLayoutInput{},
	}); err == nil {
		t.Fatal("SaveConnectionSidebarLayout unexpectedly advanced max revision")
	}
	after, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read max-revision layout after rejected save: %v", err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("overflowing save changed layout bytes: before=%q after=%q", before, after)
	}
}

func TestSaveConnectionSidebarLayoutConcurrentCASHasSingleWinner(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-cas")
	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-cas",
			Name:          "Initial",
			ConnectionIDs: []string{"conn-cas"},
		}},
	})
	if err != nil {
		t.Fatalf("bootstrap initial layout: %v", err)
	}

	const writers = 8
	results := make([]connection.SaveConnectionSidebarLayoutResult, writers)
	errs := make([]error, writers)
	start := make(chan struct{})
	var waitGroup sync.WaitGroup
	waitGroup.Add(writers)
	for index := 0; index < writers; index++ {
		go func(writer int) {
			defer waitGroup.Done()
			<-start
			results[writer], errs[writer] = application.SaveConnectionSidebarLayout(
				connection.SaveConnectionSidebarLayoutInput{
					ExpectedRevision: initial.Revision,
					Layout: connection.ConnectionSidebarLayoutInput{
						ConnectionTags: []connection.ConnectionTag{{
							ID:            "tag-cas",
							Name:          "Writer " + string(rune('A'+writer)),
							ConnectionIDs: []string{"conn-cas"},
						}},
					},
				},
			)
		}(index)
	}
	close(start)
	waitGroup.Wait()

	winners := 0
	conflicts := 0
	var authoritative connection.ConnectionSidebarLayout
	for index := range results {
		if errs[index] != nil {
			t.Fatalf("writer %d returned error: %v", index, errs[index])
		}
		if results[index].Conflict {
			conflicts++
			continue
		}
		winners++
		authoritative = results[index].Layout
	}
	if winners != 1 || conflicts != writers-1 {
		t.Fatalf("concurrent CAS results: winners=%d conflicts=%d, want 1/%d", winners, conflicts, writers-1)
	}
	if authoritative.Revision != initial.Revision+1 {
		t.Fatalf("winning revision = %d, want %d", authoritative.Revision, initial.Revision+1)
	}
	for index := range results {
		if results[index].Conflict && !reflect.DeepEqual(results[index].Layout, authoritative) {
			t.Fatalf("writer %d conflict layout = %+v, want authority %+v", index, results[index].Layout, authoritative)
		}
	}
}

func TestBootstrapConnectionSidebarLayoutSharesFirstNonEmptyCandidateAcrossAppInstances(t *testing.T) {
	configDir := t.TempDir()
	instanceA := NewAppWithSecretStore(secretstore.NewUnavailableStore("test-a"))
	instanceA.configDir = configDir
	instanceB := NewAppWithSecretStore(secretstore.NewUnavailableStore("test-b"))
	instanceB.configDir = configDir
	saveConnectionSidebarLayoutTestConnection(t, instanceA, "conn-shared")

	empty, err := instanceA.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		SidebarRootOrder: []string{"connection:conn-shared"},
	})
	if err != nil {
		t.Fatalf("instance A empty bootstrap: %v", err)
	}
	if empty.Initialized {
		t.Fatalf("instance A empty candidate initialized layout: %+v", empty)
	}
	if _, err := os.Stat(filepath.Join(configDir, connectionSidebarLayoutFileName)); !os.IsNotExist(err) {
		t.Fatalf("instance A empty candidate created layout file: %v", err)
	}

	legacyCandidate := connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-shared",
			Name:          "Shared",
			ConnectionIDs: []string{"conn-shared"},
		}},
	}
	shared, err := instanceB.BootstrapConnectionSidebarLayout(legacyCandidate)
	if err != nil {
		t.Fatalf("instance B non-empty bootstrap: %v", err)
	}
	if !shared.Initialized || shared.Revision != 1 {
		t.Fatalf("instance B initialized layout = %+v, want revision 1", shared)
	}
	assertConnectionSidebarTagsWithCreatedAt(t, shared.ConnectionTags, []connection.ConnectionTag{{
		ID:            "tag-shared",
		Name:          "Shared",
		ConnectionIDs: []string{"conn-shared"},
		ChildOrder:    []string{"connection:conn-shared"},
	}})

	reloaded, err := instanceA.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("instance A reload shared layout: %v", err)
	}
	if !reflect.DeepEqual(reloaded, shared) {
		t.Fatalf("instance A layout = %+v, want instance B authority %+v", reloaded, shared)
	}
}

func TestBootstrapConnectionSidebarLayoutConcurrentCandidatesHaveSingleAuthority(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-a")
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-b")
	candidates := []connection.ConnectionSidebarLayoutInput{
		{ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-a",
			Name:          "A",
			ConnectionIDs: []string{"conn-a"},
		}}},
		{ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-b",
			Name:          "B",
			ConnectionIDs: []string{"conn-b"},
		}}},
	}

	results := make([]connection.ConnectionSidebarLayout, len(candidates))
	errs := make([]error, len(candidates))
	start := make(chan struct{})
	var waitGroup sync.WaitGroup
	waitGroup.Add(len(candidates))
	for index := range candidates {
		go func(candidateIndex int) {
			defer waitGroup.Done()
			<-start
			results[candidateIndex], errs[candidateIndex] = application.BootstrapConnectionSidebarLayout(
				candidates[candidateIndex],
			)
		}(index)
	}
	close(start)
	waitGroup.Wait()

	for index, err := range errs {
		if err != nil {
			t.Fatalf("bootstrap candidate %d returned error: %v", index, err)
		}
	}
	if !results[0].Initialized || results[0].Revision != 1 {
		t.Fatalf("first bootstrap result = %+v, want initialized revision 1", results[0])
	}
	if !reflect.DeepEqual(results[0], results[1]) {
		t.Fatalf("concurrent bootstraps disagree: first=%+v second=%+v", results[0], results[1])
	}
	if len(results[0].ConnectionTags) != 1 ||
		(results[0].ConnectionTags[0].ID != "tag-a" && results[0].ConnectionTags[0].ID != "tag-b") {
		t.Fatalf("authoritative layout did not preserve exactly one candidate: %+v", results[0])
	}
}

func TestConnectionSidebarLayoutWaitsForExternalLayoutFileLock(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-layout-lock")
	repository := application.connectionSidebarLayoutRepository()
	externalLock, err := appdata.AcquireFileLock(repository.layoutPath() + ".lock")
	if err != nil {
		t.Fatalf("acquire external layout lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		_, bootstrapErr := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
			ConnectionTags: []connection.ConnectionTag{{
				ID:            "tag-layout-lock",
				Name:          "Layout lock",
				ConnectionIDs: []string{"conn-layout-lock"},
			}},
		})
		finished <- bootstrapErr
	}()
	select {
	case err := <-finished:
		t.Fatalf("bootstrap acquired layout lock before external release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := externalLock.Close(); err != nil {
		t.Fatalf("release external layout lock: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("bootstrap after layout lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bootstrap did not acquire layout lock after external release")
	}
}

func TestConnectionSidebarLayoutWaitsForSharedStorageLock(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-shared-lock")
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(application.configDir))
	if err != nil {
		t.Fatalf("acquire shared storage lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		_, bootstrapErr := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
			ConnectionTags: []connection.ConnectionTag{{
				ID:            "tag-shared-lock",
				Name:          "Shared lock",
				ConnectionIDs: []string{"conn-shared-lock"},
			}},
		})
		finished <- bootstrapErr
	}()
	select {
	case err := <-finished:
		t.Fatalf("bootstrap acquired shared lock before external release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := sharedLock.Close(); err != nil {
		t.Fatalf("release shared storage lock: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("bootstrap after shared lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bootstrap did not acquire shared lock after external release")
	}
}

func TestLoadConnectionSidebarLayoutWaitsForSharedStorageLock(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	if _, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{ID: "tag-load-lock", Name: "Load lock"}},
	}); err != nil {
		t.Fatalf("bootstrap layout: %v", err)
	}
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(application.configDir))
	if err != nil {
		t.Fatalf("acquire shared storage lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		_, loadErr := application.LoadConnectionSidebarLayout()
		finished <- loadErr
	}()
	select {
	case err := <-finished:
		t.Fatalf("load acquired shared lock before external release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := sharedLock.Close(); err != nil {
		t.Fatalf("release shared storage lock: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("load after shared lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("load did not acquire shared lock after external release")
	}
}

func TestConnectionSidebarLayoutAtomicWritesLeaveNoTemporaryFiles(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-atomic")
	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-atomic",
			Name:          "Atomic",
			ConnectionIDs: []string{"conn-atomic"},
		}},
	})
	if err != nil {
		t.Fatalf("bootstrap layout: %v", err)
	}
	if _, err := application.SaveConnectionSidebarLayout(connection.SaveConnectionSidebarLayoutInput{
		ExpectedRevision: initial.Revision,
		Layout:           connection.ConnectionSidebarLayoutInput{},
	}); err != nil {
		t.Fatalf("save replacement layout: %v", err)
	}

	temporaryFiles, err := filepath.Glob(filepath.Join(application.configDir, ".connection_sidebar_layout_*.tmp"))
	if err != nil {
		t.Fatalf("glob layout temporary files: %v", err)
	}
	if len(temporaryFiles) != 0 {
		t.Fatalf("atomic layout writes left temporary files: %#v", temporaryFiles)
	}
}

func TestBootstrapConnectionSidebarLayoutPersistsNormalizationAndPreventsGroupRevival(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-a")
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-b")
	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID:            "tag-b",
			Name:          "B",
			ConnectionIDs: []string{"conn-b"},
		}},
	})
	if err != nil {
		t.Fatalf("bootstrap initial layout: %v", err)
	}
	if err := application.DeleteConnection("conn-b"); err != nil {
		t.Fatalf("delete grouped connection: %v", err)
	}

	cleaned, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("normalize layout after connection deletion: %v", err)
	}
	if cleaned.Revision != initial.Revision+1 {
		t.Fatalf("normalized revision = %d, want %d", cleaned.Revision, initial.Revision+1)
	}
	if len(cleaned.ConnectionTags) != 1 || len(cleaned.ConnectionTags[0].ConnectionIDs) != 0 {
		t.Fatalf("normalized layout retained deleted host: %+v", cleaned)
	}

	var persisted connectionSidebarLayoutDiskFile
	persistedBytes, err := os.ReadFile(filepath.Join(application.configDir, connectionSidebarLayoutFileName))
	if err != nil {
		t.Fatalf("read normalized layout file: %v", err)
	}
	if err := json.Unmarshal(persistedBytes, &persisted); err != nil {
		t.Fatalf("decode normalized layout file: %v", err)
	}
	if persisted.Revision != cleaned.Revision || len(persisted.ConnectionTags[0].ConnectionIDs) != 0 {
		t.Fatalf("normalized layout was not persisted: %+v", persisted)
	}

	saveConnectionSidebarLayoutTestConnection(t, application, "conn-b")
	restarted := NewAppWithSecretStore(secretstore.NewUnavailableStore("test-restart"))
	restarted.configDir = application.configDir
	reloaded, err := restarted.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("reload layout after same-id host recreation: %v", err)
	}
	if len(reloaded.ConnectionTags) != 1 || len(reloaded.ConnectionTags[0].ConnectionIDs) != 0 {
		t.Fatalf("same-id host recreation revived stale group ownership: %+v", reloaded)
	}
	if !reflect.DeepEqual(reloaded.SidebarRootOrder, []string{
		"tag:tag-b",
		"connection:conn-a",
		"connection:conn-b",
	}) {
		t.Fatalf("recreated host was not restored as ungrouped: %#v", reloaded.SidebarRootOrder)
	}
}

func TestBootstrapConnectionSidebarLayoutUnchangedEmptyChildrenDoNotAdvanceRevision(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{ID: "empty-tag", Name: "Empty"}},
	})
	if err != nil {
		t.Fatalf("bootstrap empty group: %v", err)
	}
	reloaded, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("reload unchanged empty group: %v", err)
	}
	if reloaded.Revision != initial.Revision {
		t.Fatalf("unchanged empty-child layout advanced revision from %d to %d", initial.Revision, reloaded.Revision)
	}
}

func TestBootstrapConnectionSidebarLayoutNormalizationOverflowPreservesFile(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	saveConnectionSidebarLayoutTestConnection(t, application, "conn-valid")
	layoutPath := filepath.Join(application.configDir, connectionSidebarLayoutFileName)
	before := []byte(`{"version":1,"revision":18446744073709551615,"connectionTags":[{"id":"stale-tag","name":"Stale","connectionIds":["missing"],"childOrder":["connection:missing"]}],"sidebarRootOrder":["tag:stale-tag"]}`)
	if err := os.WriteFile(layoutPath, before, 0o644); err != nil {
		t.Fatalf("write max-revision stale layout: %v", err)
	}

	if _, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{}); err == nil {
		t.Fatal("BootstrapConnectionSidebarLayout unexpectedly normalized max revision")
	}
	after, err := os.ReadFile(layoutPath)
	if err != nil {
		t.Fatalf("read max-revision layout after rejected normalization: %v", err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("overflowing normalization changed layout bytes: before=%q after=%q", before, after)
	}
}

func TestBootstrapConnectionSidebarLayoutMarksCloudBackupDirtyOnlyWhenMutated(t *testing.T) {
	application := newConnectionSidebarLayoutTestApp(t)
	if err := application.saveCloudBackupState(CloudBackupConfig{
		Enabled:          true,
		Provider:         CloudBackupProviderWebDAV,
		Schedule:         CloudBackupScheduleManual,
		BackupCategories: []string{CloudBackupCategoryConnections},
	}); err != nil {
		t.Fatalf("enable cloud backup state: %v", err)
	}

	initial, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{ID: "tag-bootstrap-dirty", Name: "Bootstrap dirty"}},
	})
	if err != nil {
		t.Fatalf("bootstrap initial layout: %v", err)
	}
	dirty, dirtyRevision := application.cloudBackupDirtyState()
	if !dirty || dirtyRevision != 1 {
		t.Fatalf("initial bootstrap dirty state = (%v, %d), want (true, 1)", dirty, dirtyRevision)
	}
	application.clearCloudBackupDirty(dirtyRevision)

	unchanged, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{})
	if err != nil {
		t.Fatalf("bootstrap unchanged layout: %v", err)
	}
	if unchanged.Revision != initial.Revision {
		t.Fatalf("unchanged bootstrap revision = %d, want %d", unchanged.Revision, initial.Revision)
	}
	if dirty, revision := application.cloudBackupDirtyState(); dirty || revision != dirtyRevision {
		t.Fatalf("unchanged bootstrap dirty state = (%v, %d), want (false, %d)", dirty, revision, dirtyRevision)
	}
}
