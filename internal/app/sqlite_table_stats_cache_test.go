package app

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

type tableStatsTestDB struct {
	releaseRecordingDB
	tables       []string
	rowCounts    map[string]int64
	storageStats map[string]db.TableStorageStats
	rowCountErr  error
	storageErr   error
	rowCalls     int
	storageCalls int
}

func (database *tableStatsTestDB) GetTables(string) ([]string, error) {
	return append([]string(nil), database.tables...), nil
}

func (database *tableStatsTestDB) GetTableRowCounts(string, []string) (map[string]int64, error) {
	database.rowCalls++
	return database.rowCounts, database.rowCountErr
}

func (database *tableStatsTestDB) GetTableStorageStats(string, []string) (map[string]db.TableStorageStats, error) {
	database.storageCalls++
	return database.storageStats, database.storageErr
}

func newTableStatsTestApp(t *testing.T, configDir string, config connection.ConnectionConfig, database db.Database) *App {
	t.Helper()
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	application.configDir = configDir
	application.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:     database,
		lastPing: time.Now(),
		config:   normalizeCacheKeyConfig(config),
	}
	return application
}

func findTableStatRow(t *testing.T, result connection.QueryResult, tableName string) map[string]string {
	t.Helper()
	if !result.Success {
		t.Fatalf("table stats request failed: %s", result.Message)
	}
	rows, ok := result.Data.([]map[string]string)
	if !ok {
		t.Fatalf("table stats data type = %T, want []map[string]string", result.Data)
	}
	for _, row := range rows {
		if row["Table"] == tableName {
			return row
		}
	}
	t.Fatalf("table %q missing from result: %#v", tableName, rows)
	return nil
}

func TestDBGetTablesDoesNotQueryLiveSQLiteStats(t *testing.T) {
	tables := make([]string, 100)
	for index := range tables {
		tables[index] = fmt.Sprintf("table_%03d", index)
	}
	database := &tableStatsTestDB{tables: tables}
	config := connection.ConnectionConfig{ID: "sqlite-100", Type: "custom", Driver: "sqlite", DSN: "large.sqlite", Database: "large.sqlite"}
	config = config.WithResolvedSavedSnapshot()
	application := newTableStatsTestApp(t, t.TempDir(), config, database)

	result := application.DBGetTables(config, "main")
	if !result.Success {
		t.Fatalf("DBGetTables returned failure: %s", result.Message)
	}
	rows := result.Data.([]map[string]string)
	if len(rows) != len(tables) {
		t.Fatalf("DBGetTables returned %d tables, want %d", len(rows), len(tables))
	}
	if database.rowCalls != 0 || database.storageCalls != 0 {
		t.Fatalf("DBGetTables queried live SQLite stats: rows=%d storage=%d", database.rowCalls, database.storageCalls)
	}
}

func TestDBRefreshTableStatsPersistsAndDBGetTablesReadsCache(t *testing.T) {
	configDir := t.TempDir()
	config := connection.ConnectionConfig{ID: "sqlite-persisted", Type: "custom", Driver: "sqlite", Database: "app.sqlite"}
	config = config.WithResolvedSavedSnapshot()
	database := &tableStatsTestDB{
		tables:    []string{"orders"},
		rowCounts: map[string]int64{"orders": 42},
		storageStats: map[string]db.TableStorageStats{
			"orders": {DataLength: 4096, IndexLength: 1024},
		},
	}
	application := newTableStatsTestApp(t, configDir, config, database)

	refreshed := findTableStatRow(t, application.DBRefreshTableStats(config, "main", []string{"orders"}), "orders")
	if refreshed["Rows"] != "42" || refreshed["Data_length"] != "4096" || refreshed["Index_length"] != "1024" {
		t.Fatalf("unexpected refreshed stats: %#v", refreshed)
	}
	if _, err := os.Stat(filepath.Join(configDir, "cache", sqliteTableStatsCacheFileName)); err != nil {
		t.Fatalf("SQLite stats cache was not persisted: %v", err)
	}

	restartedDB := &tableStatsTestDB{tables: []string{"orders"}}
	restarted := newTableStatsTestApp(t, configDir, config, restartedDB)
	cached := findTableStatRow(t, restarted.DBGetTables(config, "main"), "orders")
	if cached["Rows"] != "42" || cached["Data_length"] != "4096" || cached["Index_length"] != "1024" {
		t.Fatalf("unexpected persisted stats after restart: %#v", cached)
	}
	if restartedDB.rowCalls != 0 || restartedDB.storageCalls != 0 {
		t.Fatalf("cached DBGetTables queried live stats: rows=%d storage=%d", restartedDB.rowCalls, restartedDB.storageCalls)
	}
}

func TestDBRefreshTableStatsFailurePreservesCachedValues(t *testing.T) {
	configDir := t.TempDir()
	config := connection.ConnectionConfig{ID: "sqlite-failure", Type: "custom", Driver: "sqlite", DSN: "app.sqlite", Database: "app.sqlite"}
	config = config.WithResolvedSavedSnapshot()
	seedDB := &tableStatsTestDB{
		tables:    []string{"orders"},
		rowCounts: map[string]int64{"orders": 7},
	}
	application := newTableStatsTestApp(t, configDir, config, seedDB)
	if result := application.DBRefreshTableStats(config, "main", []string{"orders"}); !result.Success {
		t.Fatalf("seed refresh failed: %s", result.Message)
	}

	failingDB := &tableStatsTestDB{
		tables:      []string{"orders"},
		rowCounts:   map[string]int64{"orders": 99},
		rowCountErr: errors.New("count failed"),
	}
	application.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:     failingDB,
		lastPing: time.Now(),
		config:   normalizeCacheKeyConfig(config),
	}
	if result := application.DBRefreshTableStats(config, "main", []string{"orders"}); result.Success {
		t.Fatal("refresh with a row count error should fail")
	}
	cached := findTableStatRow(t, application.DBGetTables(config, "main"), "orders")
	if cached["Rows"] != "7" {
		t.Fatalf("failed refresh overwrote cached row count: %#v", cached)
	}
}

func TestSQLiteTableStatsCacheIsExcludedFromCloudBackup(t *testing.T) {
	configDir := t.TempDir()
	config := connection.ConnectionConfig{ID: "sqlite-backup", Type: "custom", Driver: "sqlite", DSN: "app.sqlite", Database: "app.sqlite"}
	config = config.WithResolvedSavedSnapshot()
	application := newTableStatsTestApp(t, configDir, config, &tableStatsTestDB{})
	if err := application.mergeSQLiteTableStats(config, "main", []string{"orders"}, map[string]int64{"orders": 1}, nil); err != nil {
		t.Fatalf("write SQLite stats cache: %v", err)
	}
	payloadData, err := application.buildCloudBackupPayload(CloudBackupConfig{BackupCategories: defaultCloudBackupCategories()})
	if err != nil {
		t.Fatalf("build cloud backup payload: %v", err)
	}
	if string(payloadData) == "" {
		t.Fatal("cloud backup payload is empty")
	}
	if bytes.Contains(payloadData, []byte(sqliteTableStatsCacheFileName)) {
		t.Fatalf("cloud backup payload contains %s", sqliteTableStatsCacheFileName)
	}
}
