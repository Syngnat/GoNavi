package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const sqliteTableStatsCacheFileName = "sqlite_table_stats.json"

type sqliteCachedTableStat struct {
	Rows        *int64 `json:"rows,omitempty"`
	DataLength  *int64 `json:"dataLength,omitempty"`
	IndexLength *int64 `json:"indexLength,omitempty"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type sqliteTableStatsCache map[string]map[string]map[string]sqliteCachedTableStat

func isSQLiteConnection(config connection.ConnectionConfig) bool {
	return resolveDDLDBType(config) == "sqlite" || strings.EqualFold(strings.TrimSpace(config.Type), "sqlite3")
}

func sqliteTableStatsDatabaseName(dbName string) string {
	if normalized := strings.TrimSpace(dbName); normalized != "" {
		return normalized
	}
	return "main"
}

func (a *App) sqliteTableStatsCachePath() string {
	root := strings.TrimSpace(a.configDir)
	if root == "" {
		root = resolveAppConfigDir()
	}
	return filepath.Join(root, "cache", sqliteTableStatsCacheFileName)
}

func (a *App) readSQLiteTableStats(config connection.ConnectionConfig, dbName string) (map[string]sqliteCachedTableStat, error) {
	connectionID := strings.TrimSpace(config.ID)
	if connectionID == "" {
		return map[string]sqliteCachedTableStat{}, nil
	}

	a.sqliteTableStatsMu.Lock()
	defer a.sqliteTableStatsMu.Unlock()
	cache, err := a.loadSQLiteTableStatsCacheLocked()
	if err != nil {
		return nil, err
	}
	databaseStats := cache[connectionID][sqliteTableStatsDatabaseName(dbName)]
	result := make(map[string]sqliteCachedTableStat, len(databaseStats))
	for tableName, stat := range databaseStats {
		result[tableName] = stat
	}
	return result, nil
}

func (a *App) mergeSQLiteTableStats(
	config connection.ConnectionConfig,
	dbName string,
	tables []string,
	rowCounts map[string]int64,
	storageStats map[string]db.TableStorageStats,
) error {
	connectionID := strings.TrimSpace(config.ID)
	if connectionID == "" {
		return nil
	}

	a.sqliteTableStatsMu.Lock()
	defer a.sqliteTableStatsMu.Unlock()
	cache, err := a.loadSQLiteTableStatsCacheLocked()
	if err != nil {
		cache = sqliteTableStatsCache{}
	}
	if cache == nil {
		cache = sqliteTableStatsCache{}
	}
	if cache[connectionID] == nil {
		cache[connectionID] = map[string]map[string]sqliteCachedTableStat{}
	}
	databaseName := sqliteTableStatsDatabaseName(dbName)
	if cache[connectionID][databaseName] == nil {
		cache[connectionID][databaseName] = map[string]sqliteCachedTableStat{}
	}

	updatedAt := time.Now().Unix()
	for _, rawTableName := range tables {
		tableName := strings.TrimSpace(rawTableName)
		if tableName == "" {
			continue
		}
		stat := cache[connectionID][databaseName][tableName]
		updated := false
		if rowCount, ok := rowCounts[tableName]; ok {
			value := rowCount
			stat.Rows = &value
			updated = true
		}
		if storage, ok := storageStats[tableName]; ok {
			dataLength := storage.DataLength
			indexLength := storage.IndexLength
			stat.DataLength = &dataLength
			stat.IndexLength = &indexLength
			updated = true
		}
		if updated {
			stat.UpdatedAt = updatedAt
			cache[connectionID][databaseName][tableName] = stat
		}
	}
	return a.saveSQLiteTableStatsCacheLocked(cache)
}

func (a *App) loadSQLiteTableStatsCacheLocked() (sqliteTableStatsCache, error) {
	data, err := os.ReadFile(a.sqliteTableStatsCachePath())
	if err != nil {
		if os.IsNotExist(err) {
			return sqliteTableStatsCache{}, nil
		}
		return nil, err
	}
	cache := sqliteTableStatsCache{}
	if err := json.Unmarshal(data, &cache); err != nil {
		return nil, err
	}
	return cache, nil
}

func (a *App) saveSQLiteTableStatsCacheLocked(cache sqliteTableStatsCache) error {
	path := a.sqliteTableStatsCachePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".sqlite-table-stats-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return appdata.AtomicReplaceFile(temporaryPath, path)
}

func applySQLiteTableStats(item map[string]string, stat sqliteCachedTableStat) {
	if stat.Rows != nil {
		item["Rows"] = strconv.FormatInt(*stat.Rows, 10)
	}
	if stat.DataLength != nil {
		item["Data_length"] = strconv.FormatInt(*stat.DataLength, 10)
	}
	if stat.IndexLength != nil {
		item["Index_length"] = strconv.FormatInt(*stat.IndexLength, 10)
	}
}
