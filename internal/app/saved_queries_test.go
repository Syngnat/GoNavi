package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

func TestSavedQueryRepositoryStoresSQLInIndependentFile(t *testing.T) {
	app := newSavedQueryTestApp(t)
	query := connection.SavedQuery{
		ID:           "saved-file-backed",
		Name:         "Orders / latest",
		SQL:          "\n  select * from orders;\n",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    100,
	}

	if _, err := app.SaveQuery(query); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	diskFile, payload := readSavedQueriesDiskFile(t, app)
	if bytes.Contains(payload, []byte(`"sql"`)) {
		t.Fatalf("saved query metadata still contains inline sql: %s", payload)
	}
	if diskFile.Version != savedQueriesFormatVersion || len(diskFile.Queries) != 1 {
		t.Fatalf("unexpected saved query metadata: %#v", diskFile)
	}
	record := diskFile.Queries[0]
	if record.FileName != "Orders _ latest.sql" {
		t.Fatalf("managed sql file name = %q, want %q", record.FileName, "Orders _ latest.sql")
	}
	if strings.ContainsAny(record.FileName, `/\`) {
		t.Fatalf("managed sql file name contains a path separator: %q", record.FileName)
	}
	content, err := os.ReadFile(savedQuerySQLPath(t, app, record.FileName))
	if err != nil {
		t.Fatalf("ReadFile saved query sql: %v", err)
	}
	if string(content) != query.SQL {
		t.Fatalf("saved query sql = %q, want %q", content, query.SQL)
	}
}

func TestSavedQueryRepositoryAllocatesReadableDuplicateFileNames(t *testing.T) {
	app := newSavedQueryTestApp(t)
	for index, id := range []string{"orders-1", "orders-2", "orders-3"} {
		if _, err := app.SaveQuery(connection.SavedQuery{
			ID: id, Name: "Orders", SQL: fmt.Sprintf("select %d", index+1), ConnectionID: "conn-1", DBName: "app", CreatedAt: int64(index + 1),
		}); err != nil {
			t.Fatalf("SaveQuery(%s) returned error: %v", id, err)
		}
	}

	diskFile, _ := readSavedQueriesDiskFile(t, app)
	got := make([]string, 0, len(diskFile.Queries))
	for _, record := range diskFile.Queries {
		got = append(got, record.FileName)
	}
	want := []string{"Orders.sql", "Orders (2).sql", "Orders (3).sql"}
	if !sameStringSlice(got, want) {
		t.Fatalf("managed sql file names = %#v, want %#v", got, want)
	}
}

func TestSavedQueryRepositoryAvoidsCaseInsensitiveExternalFileCollision(t *testing.T) {
	app := newSavedQueryTestApp(t)
	directory, err := app.savedQueryRepository().sqlDirectory()
	if err != nil {
		t.Fatalf("resolve sql directory: %v", err)
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("MkdirAll sql directory: %v", err)
	}
	externalPath := filepath.Join(directory, "orders.SQL")
	if err := os.WriteFile(externalPath, []byte("external sql"), 0o644); err != nil {
		t.Fatalf("WriteFile external sql: %v", err)
	}

	if _, err := app.SaveQuery(connection.SavedQuery{
		ID: "orders-managed", Name: "Orders", SQL: "select 1", ConnectionID: "conn-1", DBName: "app", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	diskFile, _ := readSavedQueriesDiskFile(t, app)
	if got := diskFile.Queries[0].FileName; got != "Orders (2).sql" {
		t.Fatalf("managed sql file name = %q, want %q", got, "Orders (2).sql")
	}
	content, err := os.ReadFile(externalPath)
	if err != nil || string(content) != "external sql" {
		t.Fatalf("external sql content = %q, %v", content, err)
	}
}

func TestRenameSavedQueryAllocatesNextReadableFileName(t *testing.T) {
	app := newSavedQueryTestApp(t)
	for _, query := range []connection.SavedQuery{
		{ID: "rename-source", Name: "Source", SQL: "select 1", ConnectionID: "conn-1", DBName: "app", CreatedAt: 1},
		{ID: "rename-target", Name: "Target", SQL: "select 2", ConnectionID: "conn-1", DBName: "app", CreatedAt: 2},
	} {
		if _, err := app.SaveQuery(query); err != nil {
			t.Fatalf("SaveQuery(%s) returned error: %v", query.ID, err)
		}
	}
	directory, err := app.savedQueryRepository().sqlDirectory()
	if err != nil {
		t.Fatalf("resolve sql directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "target (2).SQL"), []byte("external sql"), 0o644); err != nil {
		t.Fatalf("WriteFile external sql: %v", err)
	}
	beforeDisk, _ := readSavedQueriesDiskFile(t, app)
	oldPath := savedQuerySQLPath(t, app, beforeDisk.Queries[0].FileName)
	latestSQL := "select 3 -- edited outside GoNavi"
	if err := os.WriteFile(oldPath, []byte(latestSQL), 0o644); err != nil {
		t.Fatalf("WriteFile external edit: %v", err)
	}

	renamed, err := app.RenameSavedQuery("rename-source", "Target")
	if err != nil {
		t.Fatalf("RenameSavedQuery returned error: %v", err)
	}
	if renamed.SQL != latestSQL {
		t.Fatalf("renamed query sql = %q, want latest disk content %q", renamed.SQL, latestSQL)
	}
	afterDisk, _ := readSavedQueriesDiskFile(t, app)
	if got := afterDisk.Queries[0].FileName; got != "Target (3).sql" {
		t.Fatalf("renamed sql file name = %q, want %q", got, "Target (3).sql")
	}
	content, err := os.ReadFile(savedQuerySQLPath(t, app, afterDisk.Queries[0].FileName))
	if err != nil || string(content) != latestSQL {
		t.Fatalf("renamed sql content = %q, %v", content, err)
	}
}

func TestSavedQueryRepositoryMigratesVersionTwoHashedFileNames(t *testing.T) {
	app := newSavedQueryTestApp(t)
	directory, err := app.savedQueryRepository().sqlDirectory()
	if err != nil {
		t.Fatalf("resolve sql directory: %v", err)
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("MkdirAll sql directory: %v", err)
	}
	externalPath := filepath.Join(directory, "orders.SQL")
	if err := os.WriteFile(externalPath, []byte("external sql"), 0o644); err != nil {
		t.Fatalf("WriteFile external sql: %v", err)
	}
	oldFileNames := []string{
		"Orders--11111111111111111111111111111111.sql",
		"Orders--22222222222222222222222222222222.sql",
	}
	for index, fileName := range oldFileNames {
		if err := os.WriteFile(filepath.Join(directory, fileName), []byte(fmt.Sprintf("select %d", index+1)), 0o644); err != nil {
			t.Fatalf("WriteFile old managed sql: %v", err)
		}
	}
	diskFile := savedQueriesDiskFile{
		Version: 2,
		Queries: []savedQueryDiskRecord{
			{ID: "migrate-v2-1", Name: "Orders", FileName: oldFileNames[0], ConnectionID: "conn-1", DBName: "app", CreatedAt: 1},
			{ID: "migrate-v2-2", Name: "Orders", FileName: oldFileNames[1], ConnectionID: "conn-1", DBName: "app", CreatedAt: 2},
		},
	}
	payload, err := json.Marshal(diskFile)
	if err != nil {
		t.Fatalf("Marshal v2 metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(app.configDir, savedQueriesFileName), payload, 0o644); err != nil {
		t.Fatalf("WriteFile v2 metadata: %v", err)
	}

	queries, err := app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries returned error: %v", err)
	}
	if len(queries) != 2 || queries[0].SQL != "select 1" || queries[1].SQL != "select 2" {
		t.Fatalf("migrated queries = %#v", queries)
	}
	migratedDisk, _ := readSavedQueriesDiskFile(t, app)
	if migratedDisk.Version != savedQueriesFormatVersion {
		t.Fatalf("migrated metadata version = %d, want %d", migratedDisk.Version, savedQueriesFormatVersion)
	}
	wantFileNames := []string{"Orders (2).sql", "Orders (3).sql"}
	for index, record := range migratedDisk.Queries {
		if record.FileName != wantFileNames[index] {
			t.Fatalf("migrated file name %d = %q, want %q", index, record.FileName, wantFileNames[index])
		}
		content, readErr := os.ReadFile(savedQuerySQLPath(t, app, record.FileName))
		if readErr != nil || string(content) != fmt.Sprintf("select %d", index+1) {
			t.Fatalf("migrated sql %d = %q, %v", index, content, readErr)
		}
		if _, statErr := os.Stat(filepath.Join(directory, oldFileNames[index])); !os.IsNotExist(statErr) {
			t.Fatalf("old hashed sql file still exists: %s, err=%v", oldFileNames[index], statErr)
		}
	}
	content, err := os.ReadFile(externalPath)
	if err != nil || string(content) != "external sql" {
		t.Fatalf("external sql content = %q, %v", content, err)
	}
	path, found, err := app.savedQueryRepository().findSQLPath("migrate-v2-2")
	if err != nil || !found || filepath.Base(path) != "Orders (3).sql" {
		t.Fatalf("findSQLPath after migration = %q, %v, %v", path, found, err)
	}
}

func TestSavedQueryRepositoryVersionTwoMigrationRollsBackWhenMetadataWriteFails(t *testing.T) {
	app := newSavedQueryTestApp(t)
	directory, err := app.savedQueryRepository().sqlDirectory()
	if err != nil {
		t.Fatalf("resolve sql directory: %v", err)
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("MkdirAll sql directory: %v", err)
	}
	oldFileName := "Rollback--11111111111111111111111111111111.sql"
	oldPath := filepath.Join(directory, oldFileName)
	if err := os.WriteFile(oldPath, []byte("select 1"), 0o644); err != nil {
		t.Fatalf("WriteFile old managed sql: %v", err)
	}
	diskFile := savedQueriesDiskFile{
		Version: 2,
		Queries: []savedQueryDiskRecord{{
			ID: "migrate-rollback", Name: "Rollback", FileName: oldFileName, ConnectionID: "conn-1", DBName: "app", CreatedAt: 1,
		}},
	}
	payload, err := json.Marshal(diskFile)
	if err != nil {
		t.Fatalf("Marshal v2 metadata: %v", err)
	}
	metadataPath := filepath.Join(app.configDir, savedQueriesFileName)
	if err := os.WriteFile(metadataPath, payload, 0o644); err != nil {
		t.Fatalf("WriteFile v2 metadata: %v", err)
	}

	previousWrite := writeSavedQueriesMetadataAtomic
	writeSavedQueriesMetadataAtomic = func(string, []byte) error {
		return fmt.Errorf("forced metadata write failure")
	}
	t.Cleanup(func() {
		writeSavedQueriesMetadataAtomic = previousWrite
	})

	if _, err := app.GetSavedQueries(); err == nil {
		t.Fatal("expected migration to fail when metadata cannot be written")
	}
	afterMetadata, err := os.ReadFile(metadataPath)
	if err != nil || !bytes.Equal(afterMetadata, payload) {
		t.Fatalf("metadata after failed migration = %q, %v", afterMetadata, err)
	}
	oldContent, err := os.ReadFile(oldPath)
	if err != nil || string(oldContent) != "select 1" {
		t.Fatalf("old managed sql after failed migration = %q, %v", oldContent, err)
	}
	if _, err := os.Stat(filepath.Join(directory, "Rollback.sql")); !os.IsNotExist(err) {
		t.Fatalf("new readable sql should be rolled back, err=%v", err)
	}
}

func TestSavedQueryRepositoryFindSQLPathTracksManagedFileName(t *testing.T) {
	app := newSavedQueryTestApp(t)
	query := connection.SavedQuery{
		ID:           "saved-reveal-path",
		Name:         "Before reveal",
		SQL:          "select 1;",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    100,
	}
	if _, err := app.SaveQuery(query); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}

	repository := app.savedQueryRepository()
	beforePath, found, err := repository.findSQLPath(query.ID)
	if err != nil || !found {
		t.Fatalf("findSQLPath before rename = %q, %v, %v", beforePath, found, err)
	}
	if _, err := os.Stat(beforePath); err != nil {
		t.Fatalf("managed sql path before rename is unavailable: %v", err)
	}

	if _, err := app.RenameSavedQuery(query.ID, "After reveal"); err != nil {
		t.Fatalf("RenameSavedQuery returned error: %v", err)
	}
	afterPath, found, err := repository.findSQLPath(query.ID)
	if err != nil || !found {
		t.Fatalf("findSQLPath after rename = %q, %v, %v", afterPath, found, err)
	}
	if afterPath == beforePath {
		t.Fatalf("findSQLPath still returns the pre-rename path: %s", afterPath)
	}
	if _, err := os.Stat(afterPath); err != nil {
		t.Fatalf("managed sql path after rename is unavailable: %v", err)
	}
	if _, found, err := repository.findSQLPath("missing-query"); err != nil || found {
		t.Fatalf("findSQLPath for a missing query returned found=%v, err=%v", found, err)
	}
}

func TestSavedQueryRepositoryMigratesLegacyInlineSQLIdempotently(t *testing.T) {
	app := newSavedQueryTestApp(t)
	legacyPayload := []byte(`{
  "queries": [{
    "id": "saved-legacy-file",
    "name": "Legacy",
    "sql": "select 1;\n",
    "connectionId": "conn-1",
    "dbName": "app",
    "createdAt": 100
  }]
}`)
	if err := os.WriteFile(filepath.Join(app.configDir, savedQueriesFileName), legacyPayload, 0o644); err != nil {
		t.Fatalf("WriteFile legacy metadata: %v", err)
	}

	for attempt := 0; attempt < 2; attempt++ {
		queries, err := app.GetSavedQueries()
		if err != nil {
			t.Fatalf("GetSavedQueries attempt %d returned error: %v", attempt+1, err)
		}
		if len(queries) != 1 || queries[0].SQL != "select 1;\n" {
			t.Fatalf("unexpected migrated query on attempt %d: %#v", attempt+1, queries)
		}
	}
	diskFile, payload := readSavedQueriesDiskFile(t, app)
	if bytes.Contains(payload, []byte(`"sql"`)) {
		t.Fatalf("migrated metadata still contains inline sql: %s", payload)
	}
	if len(diskFile.Queries) != 1 {
		t.Fatalf("unexpected migrated metadata: %#v", diskFile)
	}
	content, err := os.ReadFile(savedQuerySQLPath(t, app, diskFile.Queries[0].FileName))
	if err != nil || string(content) != "select 1;\n" {
		t.Fatalf("migrated sql content = %q, %v", content, err)
	}
}

func TestSavedQueryRepositoryLegacyMigrationFailureLeavesJSONUntouched(t *testing.T) {
	app := newSavedQueryTestApp(t)
	legacyPayload := []byte(`{"queries":[{"id":"saved-blocked","name":"Blocked","sql":"select 1","connectionId":"conn-1","dbName":"app","createdAt":100}]}`)
	metadataPath := filepath.Join(app.configDir, savedQueriesFileName)
	if err := os.WriteFile(metadataPath, legacyPayload, 0o644); err != nil {
		t.Fatalf("WriteFile legacy metadata: %v", err)
	}
	directory, err := app.savedQueryRepository().sqlDirectory()
	if err != nil {
		t.Fatalf("resolve sql directory: %v", err)
	}
	if err := os.WriteFile(directory, []byte("blocks directory creation"), 0o644); err != nil {
		t.Fatalf("WriteFile blocking path: %v", err)
	}

	if _, err := app.GetSavedQueries(); err == nil {
		t.Fatal("expected legacy migration to fail when the sql directory is blocked")
	}
	after, err := os.ReadFile(metadataPath)
	if err != nil {
		t.Fatalf("ReadFile metadata after failure: %v", err)
	}
	if !bytes.Equal(after, legacyPayload) {
		t.Fatalf("legacy metadata changed after failed migration:\n%s", after)
	}
}

func TestSavedQueryRepositoryReloadsExternallyModifiedSQL(t *testing.T) {
	app := newSavedQueryTestApp(t)
	if _, err := app.SaveQuery(connection.SavedQuery{
		ID: "saved-external-edit", Name: "External", SQL: "select 1", ConnectionID: "conn-1", DBName: "app", CreatedAt: 100,
	}); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	diskFile, _ := readSavedQueriesDiskFile(t, app)
	path := savedQuerySQLPath(t, app, diskFile.Queries[0].FileName)
	if err := os.WriteFile(path, []byte("select 2 -- edited externally"), 0o644); err != nil {
		t.Fatalf("WriteFile external edit: %v", err)
	}

	queries, err := app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries returned error: %v", err)
	}
	if len(queries) != 1 || queries[0].SQL != "select 2 -- edited externally" {
		t.Fatalf("expected latest disk content, got %#v", queries)
	}
}

func TestRenameSavedQueryPreservesLatestDiskContent(t *testing.T) {
	app := newSavedQueryTestApp(t)
	if _, err := app.SaveQuery(connection.SavedQuery{
		ID: "saved-rename-file", Name: "Before", SQL: "select 1", ConnectionID: "conn-1", DBName: "app", CreatedAt: 100,
	}); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	beforeDisk, _ := readSavedQueriesDiskFile(t, app)
	oldPath := savedQuerySQLPath(t, app, beforeDisk.Queries[0].FileName)
	latestSQL := "select 2 -- edited outside GoNavi"
	if err := os.WriteFile(oldPath, []byte(latestSQL), 0o644); err != nil {
		t.Fatalf("WriteFile external edit: %v", err)
	}

	renamed, err := app.RenameSavedQuery("saved-rename-file", "After")
	if err != nil {
		t.Fatalf("RenameSavedQuery returned error: %v", err)
	}
	if renamed.Name != "After" || renamed.SQL != latestSQL {
		t.Fatalf("unexpected renamed query: %#v", renamed)
	}
	afterDisk, payload := readSavedQueriesDiskFile(t, app)
	if bytes.Contains(payload, []byte(`"sql"`)) {
		t.Fatalf("renamed metadata contains inline sql: %s", payload)
	}
	newPath := savedQuerySQLPath(t, app, afterDisk.Queries[0].FileName)
	if newPath == oldPath {
		t.Fatalf("expected query rename to rename the managed sql file: %s", newPath)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old sql path should be gone, got err=%v", err)
	}
	content, err := os.ReadFile(newPath)
	if err != nil || string(content) != latestSQL {
		t.Fatalf("renamed sql content = %q, %v", content, err)
	}
}

func TestDeleteSavedQueryRemovesSQLFileAndGroupMembership(t *testing.T) {
	app := newSavedQueryTestApp(t)
	if _, err := app.SaveQuery(connection.SavedQuery{
		ID: "saved-delete-file", Name: "Delete", SQL: "select 1", ConnectionID: "conn-1", DBName: "app", CreatedAt: 100,
	}); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID: "group-delete-file", Name: "Delete", QueryIDs: []string{"saved-delete-file"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup returned error: %v", err)
	}
	diskFile, _ := readSavedQueriesDiskFile(t, app)
	queryPath := savedQuerySQLPath(t, app, diskFile.Queries[0].FileName)

	if err := app.DeleteQuery("saved-delete-file"); err != nil {
		t.Fatalf("DeleteQuery returned error: %v", err)
	}
	if _, err := os.Stat(queryPath); !os.IsNotExist(err) {
		t.Fatalf("deleted query sql file still exists, err=%v", err)
	}
	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	group := findSavedQueryGroup(groups, "group-delete-file")
	if group == nil || len(group.QueryIDs) != 0 || len(group.ChildOrder) != 0 {
		t.Fatalf("deleted query still belongs to a group: %#v", group)
	}
}

func TestSavedQueryRepositorySaveUpdateAndDelete(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	query := connection.SavedQuery{
		ID:           "saved-1",
		Name:         "Orders",
		SQL:          "select * from orders",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    100,
	}
	if _, err := app.SaveQuery(query); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}

	saved, err := app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries returned error: %v", err)
	}
	if len(saved) != 1 || saved[0].Name != "Orders" {
		t.Fatalf("expected saved query to be persisted, got %#v", saved)
	}

	query.Name = "Orders Updated"
	query.SQL = "select id from orders"
	if _, err := app.SaveQuery(query); err != nil {
		t.Fatalf("SaveQuery update returned error: %v", err)
	}
	saved, err = app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries after update returned error: %v", err)
	}
	if len(saved) != 1 || saved[0].Name != "Orders Updated" || saved[0].SQL != "select id from orders" {
		t.Fatalf("expected saved query to be updated in place, got %#v", saved)
	}

	if err := app.DeleteQuery("saved-1"); err != nil {
		t.Fatalf("DeleteQuery returned error: %v", err)
	}
	saved, err = app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries after delete returned error: %v", err)
	}
	if len(saved) != 0 {
		t.Fatalf("expected saved query to be deleted, got %#v", saved)
	}
	if _, err := os.Stat(filepath.Join(app.configDir, savedQueriesFileName)); err != nil {
		t.Fatalf("expected saved query file to remain readable after delete: %v", err)
	}
}

func TestImportSavedQueriesUpsertsAndSkipsInvalidItems(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	if _, err := app.SaveQuery(connection.SavedQuery{
		ID:           "saved-1",
		Name:         "Old",
		SQL:          "select 1",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    100,
	}); err != nil {
		t.Fatalf("seed SaveQuery returned error: %v", err)
	}

	imported, err := app.ImportSavedQueries(connection.SavedQueryImportPayload{
		Queries: []connection.SavedQuery{
			{
				ID:           "saved-1",
				Name:         "New",
				SQL:          "select 2",
				ConnectionID: "conn-1",
				DBName:       "app",
				CreatedAt:    100,
			},
			{
				ID:           "saved-2",
				Name:         "Second",
				SQL:          "select 3",
				ConnectionID: "conn-2",
				DBName:       "analytics",
				CreatedAt:    200,
			},
			{
				ID:           "invalid",
				Name:         "Missing SQL",
				ConnectionID: "conn-3",
				DBName:       "app",
			},
		},
	})
	if err != nil {
		t.Fatalf("ImportSavedQueries returned error: %v", err)
	}
	if len(imported) != 2 {
		t.Fatalf("expected 2 valid saved queries after import, got %#v", imported)
	}
	if imported[0].Name != "New" || imported[0].SQL != "select 2" {
		t.Fatalf("expected import to upsert saved-1, got %#v", imported[0])
	}
	if imported[1].ID != "saved-2" {
		t.Fatalf("expected import to append saved-2, got %#v", imported[1])
	}
}

func TestSavedQueryRepositoryPreservesSQLWhitespace(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	query := connection.SavedQuery{
		ID:           "saved-whitespace",
		Name:         "Formatted",
		SQL:          "\n  select * from orders;\n",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    100,
	}
	persisted, err := app.SaveQuery(query)
	if err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	if persisted.SQL != query.SQL {
		t.Fatalf("expected saved SQL whitespace to be preserved, got %q", persisted.SQL)
	}
}

func TestSavedQueryRepositoryLocalizesGeneratedName(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")

	persisted, err := app.SaveQuery(connection.SavedQuery{
		ID:           "saved-generated-name",
		SQL:          "select 1",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    100,
	})
	if err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	if persisted.Name != "Query 1" {
		t.Fatalf("expected localized generated saved query name, got %q", persisted.Name)
	}
}


func TestSavedQueryRepositorySerializesConcurrentWrites(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	const count = 24
	var wg sync.WaitGroup
	errCh := make(chan error, count)
	for index := 0; index < count; index++ {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := app.SaveQuery(connection.SavedQuery{
				ID:           fmt.Sprintf("saved-%02d", index),
				Name:         fmt.Sprintf("Query %02d", index),
				SQL:          fmt.Sprintf("select %d", index),
				ConnectionID: "conn-1",
				DBName:       "app",
				CreatedAt:    int64(index + 1),
			})
			if err != nil {
				errCh <- err
			}
		}()
	}
	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Fatalf("SaveQuery returned error during concurrent write: %v", err)
	}

	saved, err := app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries returned error: %v", err)
	}
	if len(saved) != count {
		t.Fatalf("expected %d saved queries after concurrent writes, got %d: %#v", count, len(saved), saved)
	}
}

func TestImportSavedQueriesRebindsLegacyConnectionByUniqueFingerprint(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	current, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-current",
		Name: "Current",
		Config: connection.ConnectionConfig{
			ID:       "conn-current",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "app",
			Database: "app",
			Password: "new-secret",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	imported, err := app.ImportSavedQueries(connection.SavedQueryImportPayload{
		Queries: []connection.SavedQuery{
			{
				ID:           "saved-legacy",
				Name:         "Legacy",
				SQL:          "select 1",
				ConnectionID: "conn-old",
				DBName:       "app",
				CreatedAt:    100,
			},
		},
		LegacyConnections: []connection.SavedConnectionInput{
			{
				ID:   "conn-old",
				Name: "Old",
				Config: connection.ConnectionConfig{
					ID:       "conn-old",
					Type:     "postgres",
					Host:     "DB.LOCAL",
					Port:     5432,
					User:     "app",
					Database: "app",
					Password: "old-secret",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("ImportSavedQueries returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported query, got %#v", imported)
	}
	query := imported[0]
	if query.ConnectionID != current.ID {
		t.Fatalf("expected query to rebind to %s, got %#v", current.ID, query)
	}
	if query.OriginalConnectionID != "conn-old" {
		t.Fatalf("expected original connection id to be preserved, got %#v", query)
	}
	if query.BindingStatus != savedQueryBindingRebound {
		t.Fatalf("expected rebound binding status, got %#v", query)
	}
	if query.ConnectionFingerprint == "" || query.FingerprintVersion != savedQueryFingerprintVersion {
		t.Fatalf("expected fingerprint metadata, got %#v", query)
	}
}

func TestImportSavedQueriesDoesNotRebindAmbiguousFingerprint(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	for _, id := range []string{"conn-a", "conn-b"} {
		if _, err := app.SaveConnection(connection.SavedConnectionInput{
			ID:   id,
			Name: id,
			Config: connection.ConnectionConfig{
				ID:       id,
				Type:     "mysql",
				Host:     "db.local",
				Port:     3306,
				User:     "app",
				Database: "app",
			},
		}); err != nil {
			t.Fatalf("SaveConnection %s returned error: %v", id, err)
		}
	}

	imported, err := app.ImportSavedQueries(connection.SavedQueryImportPayload{
		Queries: []connection.SavedQuery{
			{
				ID:           "saved-ambiguous",
				Name:         "Ambiguous",
				SQL:          "select 1",
				ConnectionID: "conn-old",
				DBName:       "app",
				CreatedAt:    100,
			},
		},
		LegacyConnections: []connection.SavedConnectionInput{
			{
				ID:   "conn-old",
				Name: "Old",
				Config: connection.ConnectionConfig{
					ID:       "conn-old",
					Type:     "mysql",
					Host:     "db.local",
					Port:     3306,
					User:     "app",
					Database: "app",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("ImportSavedQueries returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported query, got %#v", imported)
	}
	query := imported[0]
	if query.ConnectionID != "conn-old" {
		t.Fatalf("expected ambiguous query to keep old connection id, got %#v", query)
	}
	if query.BindingStatus != savedQueryBindingOrphan {
		t.Fatalf("expected orphan binding status, got %#v", query)
	}
}

func TestGetSavedQueriesRebindsStoredFingerprint(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	current, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-current",
		Name: "Current",
		Config: connection.ConnectionConfig{
			ID:       "conn-current",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "app",
			Database: "app",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	fingerprint, ok := buildSavedConnectionFingerprint(current)
	if !ok {
		t.Fatal("expected current connection fingerprint to be available")
	}
	if err := app.savedQueryRepository().saveAll([]connection.SavedQuery{
		{
			ID:                    "saved-stored-fingerprint",
			Name:                  "Stored Fingerprint",
			SQL:                   "select 1",
			ConnectionID:          "conn-old",
			DBName:                "app",
			CreatedAt:             100,
			ConnectionFingerprint: fingerprint,
			FingerprintVersion:    savedQueryFingerprintVersion,
		},
	}); err != nil {
		t.Fatalf("saveAll returned error: %v", err)
	}

	queries, err := app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries returned error: %v", err)
	}
	if len(queries) != 1 {
		t.Fatalf("expected 1 query, got %#v", queries)
	}
	if queries[0].ConnectionID != current.ID {
		t.Fatalf("expected query to rebind to %s, got %#v", current.ID, queries[0])
	}
	if queries[0].OriginalConnectionID != "conn-old" {
		t.Fatalf("expected original connection id to be preserved, got %#v", queries[0])
	}
	if queries[0].BindingStatus != savedQueryBindingRebound {
		t.Fatalf("expected rebound binding status, got %#v", queries[0])
	}
}

func TestRebindSavedQueryUpdatesConnectionAndFingerprint(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	target, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-target",
		Name: "Target",
		Config: connection.ConnectionConfig{
			ID:       "conn-target",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "app",
			Database: "app",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	if _, err := app.SaveQuery(connection.SavedQuery{
		ID:           "saved-orphan",
		Name:         "Orphan",
		SQL:          "select 1",
		ConnectionID: "conn-old",
		DBName:       "app",
		CreatedAt:    100,
	}); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}

	rebound, err := app.RebindSavedQuery("saved-orphan", target.ID)
	if err != nil {
		t.Fatalf("RebindSavedQuery returned error: %v", err)
	}
	if rebound.ConnectionID != target.ID {
		t.Fatalf("expected query to bind to target connection, got %#v", rebound)
	}
	if rebound.OriginalConnectionID != "conn-old" {
		t.Fatalf("expected original connection id to be retained, got %#v", rebound)
	}
	if rebound.BindingStatus != savedQueryBindingActive {
		t.Fatalf("expected active binding status, got %#v", rebound)
	}
	if rebound.ConnectionFingerprint == "" {
		t.Fatalf("expected fingerprint to be stored, got %#v", rebound)
	}
}

func TestSavedQueryGroupsReadLegacyQueriesOnlyFile(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	legacyPayload := `{
  "queries": [
    {
      "id": "saved-legacy",
      "name": "Legacy",
      "sql": "select 1",
      "connectionId": "conn-1",
      "dbName": "app",
      "createdAt": 100
    }
  ]
}`
	if err := os.WriteFile(
		filepath.Join(app.configDir, savedQueriesFileName),
		[]byte(legacyPayload),
		0o644,
	); err != nil {
		t.Fatalf("WriteFile legacy saved queries: %v", err)
	}

	queries, err := app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries returned error: %v", err)
	}
	if len(queries) != 1 || queries[0].ID != "saved-legacy" {
		t.Fatalf("expected legacy query to load, got %#v", queries)
	}
	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	if len(groups) != 0 {
		t.Fatalf("expected legacy file without groups to load an empty group list, got %#v", groups)
	}
}

func TestSavedQueryGroupsEnforceSingleMembershipAndValidateHierarchy(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	seedSavedQueryGroupQueries(t, app, "saved-1", "saved-2", "saved-3")

	root, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:         "group-root",
		Name:       "Root",
		QueryIDs:   []string{"saved-1", "saved-2"},
		ChildOrder: []string{"query:saved-2", "query:saved-1"},
	})
	if err != nil {
		t.Fatalf("SaveSavedQueryGroup root: %v", err)
	}
	if got, want := root.QueryIDs, []string{"saved-2", "saved-1"}; !sameStringSlice(got, want) {
		t.Fatalf("expected child order to order direct query ids, got %#v want %#v", got, want)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:            "group-child",
		Name:          "Child",
		ParentGroupID: "group-root",
		QueryIDs:      []string{"saved-3"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup child: %v", err)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:       "group-latest",
		Name:     "Latest",
		QueryIDs: []string{"saved-2"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup latest: %v", err)
	}

	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	if group := findSavedQueryGroup(groups, "group-root"); group == nil || !sameStringSlice(group.QueryIDs, []string{"saved-1"}) {
		t.Fatalf("expected latest group assignment to remove saved-2 from root, got %#v", group)
	}
	if group := findSavedQueryGroup(groups, "group-latest"); group == nil || !sameStringSlice(group.QueryIDs, []string{"saved-2"}) {
		t.Fatalf("expected latest group to own saved-2, got %#v", group)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:         "group-latest",
		Name:       "Latest renamed",
		QueryIDs:   []string{},
		ChildOrder: []string{},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup full replacement: %v", err)
	}
	groups, err = app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups after replacement returned error: %v", err)
	}
	if group := findSavedQueryGroup(groups, "group-latest"); group == nil || group.Name != "Latest renamed" || len(group.QueryIDs) != 0 || len(group.ChildOrder) != 0 {
		t.Fatalf("expected empty queryIds and childOrder to fully replace the group, got %#v", group)
	}

	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:            "group-invalid-parent",
		Name:          "Invalid parent",
		ParentGroupID: "missing-group",
	}); err == nil {
		t.Fatal("expected missing parent to be rejected")
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:       "group-invalid-query",
		Name:     "Invalid query",
		QueryIDs: []string{"missing-query"},
	}); err == nil {
		t.Fatal("expected unknown query id to be rejected")
	}
	if err := app.MoveSavedQueryGroup("group-root", "group-child"); err == nil {
		t.Fatal("expected move below descendant to be rejected")
	}
	if err := app.MoveSavedQueryGroup("group-child", "group-child"); err == nil {
		t.Fatal("expected self-parenting move to be rejected")
	}
}

func TestImportSavedQueryGroupsLatestDuplicateMembershipWins(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	if _, err := app.ImportSavedQueries(connection.SavedQueryImportPayload{
		Queries: []connection.SavedQuery{
			{
				ID:           "saved-1",
				Name:         "One",
				SQL:          "select 1",
				ConnectionID: "conn-1",
				DBName:       "app",
				CreatedAt:    100,
			},
		},
		Groups: []connection.SavedQueryGroup{
			{ID: "group-first", Name: "First", QueryIDs: []string{"saved-1"}},
			{ID: "group-last", Name: "Last", QueryIDs: []string{"saved-1"}},
		},
	}); err != nil {
		t.Fatalf("ImportSavedQueries returned error: %v", err)
	}

	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	if group := findSavedQueryGroup(groups, "group-first"); group == nil || len(group.QueryIDs) != 0 {
		t.Fatalf("expected first imported group to release duplicate query, got %#v", group)
	}
	if group := findSavedQueryGroup(groups, "group-last"); group == nil || !sameStringSlice(group.QueryIDs, []string{"saved-1"}) {
		t.Fatalf("expected last imported group to own duplicate query, got %#v", group)
	}
}

func TestDeleteSavedQueryGroupPromotesDirectQueriesAndChildGroups(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	seedSavedQueryGroupQueries(t, app, "saved-1", "saved-2", "saved-3")

	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:       "group-parent",
		Name:     "Parent",
		QueryIDs: []string{"saved-1"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup parent: %v", err)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:            "group-child",
		Name:          "Child",
		ParentGroupID: "group-parent",
		QueryIDs:      []string{"saved-2"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup child: %v", err)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:            "group-grandchild",
		Name:          "Grandchild",
		ParentGroupID: "group-child",
		QueryIDs:      []string{"saved-3"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup grandchild: %v", err)
	}

	if err := app.DeleteSavedQueryGroup("group-child"); err != nil {
		t.Fatalf("DeleteSavedQueryGroup returned error: %v", err)
	}
	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	if findSavedQueryGroup(groups, "group-child") != nil {
		t.Fatalf("expected deleted group to be absent, got %#v", groups)
	}
	parent := findSavedQueryGroup(groups, "group-parent")
	if parent == nil || !sameStringSlice(parent.QueryIDs, []string{"saved-1", "saved-2"}) {
		t.Fatalf("expected parent to receive deleted group's direct queries, got %#v", parent)
	}
	if got, want := parent.ChildOrder, []string{"query:saved-1", "query:saved-2", "group:group-grandchild"}; !sameStringSlice(got, want) {
		t.Fatalf("expected promoted children to retain placement, got %#v want %#v", got, want)
	}
	grandchild := findSavedQueryGroup(groups, "group-grandchild")
	if grandchild == nil || grandchild.ParentGroupID != "group-parent" {
		t.Fatalf("expected grandchild to be promoted to parent, got %#v", grandchild)
	}
}

func TestDeleteRootSavedQueryGroupPromotesChildrenAndUngroupsDirectQueries(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	seedSavedQueryGroupQueries(t, app, "saved-1", "saved-2")
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:       "group-root",
		Name:     "Root",
		QueryIDs: []string{"saved-1"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup root: %v", err)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:            "group-child",
		Name:          "Child",
		ParentGroupID: "group-root",
		QueryIDs:      []string{"saved-2"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup child: %v", err)
	}

	if err := app.DeleteSavedQueryGroup("group-root"); err != nil {
		t.Fatalf("DeleteSavedQueryGroup root: %v", err)
	}
	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	if findSavedQueryGroup(groups, "group-root") != nil {
		t.Fatalf("expected root group to be deleted, got %#v", groups)
	}
	child := findSavedQueryGroup(groups, "group-child")
	if child == nil || child.ParentGroupID != "" || !sameStringSlice(child.QueryIDs, []string{"saved-2"}) {
		t.Fatalf("expected direct child to be promoted to root intact, got %#v", child)
	}
	for _, group := range groups {
		if containsString(group.QueryIDs, "saved-1") {
			t.Fatalf("expected deleted root's direct query to become ungrouped, got %#v", groups)
		}
	}
}

func TestMoveSavedQueryAndGroupUpdatesMembershipAndParent(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	seedSavedQueryGroupQueries(t, app, "saved-1")
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:       "group-root",
		Name:     "Root",
		QueryIDs: []string{"saved-1"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup root: %v", err)
	}
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:            "group-child",
		Name:          "Child",
		ParentGroupID: "group-root",
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup child: %v", err)
	}

	if err := app.MoveSavedQueryToGroup("saved-1", "group-child"); err != nil {
		t.Fatalf("MoveSavedQueryToGroup returned error: %v", err)
	}
	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	if group := findSavedQueryGroup(groups, "group-root"); group == nil || len(group.QueryIDs) != 0 {
		t.Fatalf("expected source group to release moved query, got %#v", group)
	}
	if group := findSavedQueryGroup(groups, "group-child"); group == nil || !sameStringSlice(group.QueryIDs, []string{"saved-1"}) {
		t.Fatalf("expected destination group to own moved query, got %#v", group)
	}

	if err := app.MoveSavedQueryToGroup("saved-1", ""); err != nil {
		t.Fatalf("MoveSavedQueryToGroup ungroup returned error: %v", err)
	}
	if err := app.MoveSavedQueryGroup("group-child", ""); err != nil {
		t.Fatalf("MoveSavedQueryGroup root returned error: %v", err)
	}
	groups, err = app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups after moves returned error: %v", err)
	}
	if group := findSavedQueryGroup(groups, "group-child"); group == nil || group.ParentGroupID != "" || len(group.QueryIDs) != 0 {
		t.Fatalf("expected child group and query to be moved to roots, got %#v", group)
	}
	if group := findSavedQueryGroup(groups, "group-root"); group == nil || containsString(group.ChildOrder, "group:group-child") {
		t.Fatalf("expected old parent order to remove moved group token, got %#v", group)
	}
}

func TestSavedQueryGroupsSurviveSaveImportAndRebindThenPruneOnDelete(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	seedSavedQueryGroupQueries(t, app, "saved-1")
	if _, err := app.SaveSavedQueryGroup(connection.SavedQueryGroup{
		ID:       "group-keep",
		Name:     "Keep",
		QueryIDs: []string{"saved-1"},
	}); err != nil {
		t.Fatalf("SaveSavedQueryGroup returned error: %v", err)
	}

	if _, err := app.SaveQuery(connection.SavedQuery{
		ID:           "saved-1",
		Name:         "Updated",
		SQL:          "select 11",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    101,
	}); err != nil {
		t.Fatalf("SaveQuery update returned error: %v", err)
	}
	if _, err := app.ImportSavedQueries(connection.SavedQueryImportPayload{
		Queries: []connection.SavedQuery{{
			ID:           "saved-2",
			Name:         "Imported",
			SQL:          "select 2",
			ConnectionID: "conn-1",
			DBName:       "app",
			CreatedAt:    102,
		}},
	}); err != nil {
		t.Fatalf("ImportSavedQueries returned error: %v", err)
	}

	target, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-target",
		Name: "Target",
		Config: connection.ConnectionConfig{
			ID:       "conn-target",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "app",
			Database: "app",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	if _, err := app.RebindSavedQuery("saved-1", target.ID); err != nil {
		t.Fatalf("RebindSavedQuery returned error: %v", err)
	}

	groups, err := app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups returned error: %v", err)
	}
	if group := findSavedQueryGroup(groups, "group-keep"); group == nil || !sameStringSlice(group.QueryIDs, []string{"saved-1"}) {
		t.Fatalf("expected group metadata to survive query save/import/rebind, got %#v", group)
	}

	if err := app.DeleteQuery("saved-1"); err != nil {
		t.Fatalf("DeleteQuery returned error: %v", err)
	}
	groups, err = app.GetSavedQueryGroups()
	if err != nil {
		t.Fatalf("GetSavedQueryGroups after delete returned error: %v", err)
	}
	if group := findSavedQueryGroup(groups, "group-keep"); group == nil || len(group.QueryIDs) != 0 || len(group.ChildOrder) != 0 {
		t.Fatalf("expected deleted query to be pruned from group, got %#v", group)
	}
}

func seedSavedQueryGroupQueries(t *testing.T, app *App, ids ...string) {
	t.Helper()
	for index, id := range ids {
		if _, err := app.SaveQuery(connection.SavedQuery{
			ID:           id,
			Name:         id,
			SQL:          fmt.Sprintf("select %d", index+1),
			ConnectionID: "conn-1",
			DBName:       "app",
			CreatedAt:    int64(index + 1),
		}); err != nil {
			t.Fatalf("SaveQuery %s returned error: %v", id, err)
		}
	}
}

func findSavedQueryGroup(groups []connection.SavedQueryGroup, id string) *connection.SavedQueryGroup {
	for index := range groups {
		if groups[index].ID == id {
			return &groups[index]
		}
	}
	return nil
}

func sameStringSlice(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func newSavedQueryTestApp(t *testing.T) *App {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	application.configDir = t.TempDir()
	return application
}

func readSavedQueriesDiskFile(t *testing.T, application *App) (savedQueriesDiskFile, []byte) {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join(application.configDir, savedQueriesFileName))
	if err != nil {
		t.Fatalf("ReadFile saved query metadata: %v", err)
	}
	var file savedQueriesDiskFile
	if err := json.Unmarshal(payload, &file); err != nil {
		t.Fatalf("Unmarshal saved query metadata: %v", err)
	}
	return file, payload
}

func savedQuerySQLPath(t *testing.T, application *App, fileName string) string {
	t.Helper()
	directory, err := application.savedQueryRepository().sqlDirectory()
	if err != nil {
		t.Fatalf("resolve saved query sql directory: %v", err)
	}
	return filepath.Join(directory, fileName)
}
