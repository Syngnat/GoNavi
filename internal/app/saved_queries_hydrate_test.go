package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestHydrateDiskFileSkipsOrphanMissingSQLFile verifies that a legacy disk
// record whose referenced .sql file is missing does not fail the whole
// saved-queries load. A hard failure here blocked the application quit /
// update flow with "检查未保存 SQL 失败，已取消退出" when the user switched
// update channels and the new build ran the v2 -> v3 migration on disk data
// that referenced a deleted file (e.g. 新建查询.sql).
func TestHydrateDiskFileSkipsOrphanMissingSQLFile(t *testing.T) {
	root := t.TempDir()
	repo := newSavedQueryRepository(root)
	directory := filepath.Join(root, "saved_queries")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", directory, err)
	}
	healthySQL := "select 1;"
	if err := os.WriteFile(filepath.Join(directory, "normal.sql"), []byte(healthySQL), 0o644); err != nil {
		t.Fatalf("write normal.sql: %v", err)
	}

	diskFile := savedQueriesDiskFile{
		Version: 2, // legacy format forces the migration path
		Queries: []savedQueryDiskRecord{
			{
				ID:           "orphan-1",
				Name:         "新建查询",
				FileName:     "新建查询.sql", // never created on disk
				ConnectionID: "conn-1",
				DBName:       "app",
				CreatedAt:    100,
			},
			{
				ID:           "normal-1",
				Name:         "正常查询",
				FileName:     "normal.sql",
				ConnectionID: "conn-1",
				DBName:       "app",
				CreatedAt:    200,
			},
		},
	}

	file, err := repo.hydrateDiskFile(diskFile)
	if err != nil {
		t.Fatalf("hydrateDiskFile returned error for missing orphan SQL file: %v", err)
	}
	if len(file.Queries) != 1 {
		t.Fatalf("expected 1 query after skipping the orphan, got %d: %#v", len(file.Queries), file.Queries)
	}
	query := file.Queries[0]
	if query.ID != "normal-1" {
		t.Fatalf("surviving query id = %q, want %q", query.ID, "normal-1")
	}
	if query.SQL != healthySQL {
		t.Fatalf("surviving query sql = %q, want %q", query.SQL, healthySQL)
	}

	// The migration must persist the pruned record set so the orphan does
	// not fail every subsequent load.
	payload, err := os.ReadFile(repo.queriesPath())
	if err != nil {
		t.Fatalf("read rewritten saved_queries.json: %v", err)
	}
	var rewritten savedQueriesDiskFile
	if err := json.Unmarshal(payload, &rewritten); err != nil {
		t.Fatalf("unmarshal rewritten saved_queries.json: %v", err)
	}
	if len(rewritten.Queries) != 1 || rewritten.Queries[0].ID != "normal-1" {
		t.Fatalf("orphan record not pruned from rewritten disk file: %#v", rewritten.Queries)
	}
}
