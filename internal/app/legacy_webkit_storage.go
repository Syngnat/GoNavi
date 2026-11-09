package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	_ "modernc.org/sqlite"
)

const legacyPersistKey = "lite-db-storage"

var legacyWebKitBundleIDs = []string{
	"com.wails.GoNavi",
	"com.wails.GoNavi-Wails",
}

type legacyWebKitVisibleConfig struct {
	Connections []connection.LegacySavedConnection
	GlobalProxy *connection.LegacyGlobalProxyInput
}

func currentBuildType(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	buildType := ctx.Value("buildtype")
	if value, ok := buildType.(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func shouldAttemptLegacyWebKitStorageMigration(buildType string) bool {
	return runtimeGOOS() == "darwin" && strings.EqualFold(strings.TrimSpace(buildType), "dev")
}

func migrateLegacyWebKitStorageIfNeeded(a *App) error {
	return migrateLegacyWebKitStorageIfNeededWithHome(a, currentBuildType(a.ctx), os.UserHomeDir)
}

func migrateLegacyWebKitStorageIfNeededWithHome(a *App, buildType string, resolveHomeDir func() (string, error)) error {
	if a == nil || !shouldAttemptLegacyWebKitStorageMigration(buildType) {
		return nil
	}

	repo := a.savedConnectionRepository()
	if _, err := os.Stat(repo.connectionsPath()); err == nil {
		return nil
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}

	homeDir, err := resolveHomeDir()
	if err != nil {
		return err
	}

	legacy, sourcePath, err := findLegacyWebKitVisibleConfig(homeDir)
	if err != nil {
		return err
	}
	if len(legacy.Connections) == 0 && legacy.GlobalProxy == nil {
		return nil
	}

	if len(legacy.Connections) > 0 {
		if _, err := a.ImportLegacyConnections(legacy.Connections); err != nil {
			return err
		}
	}

	if legacy.GlobalProxy != nil {
		if _, err := os.Stat(globalProxyMetadataPath(a.configDir)); os.IsNotExist(err) {
			if _, err := a.ImportLegacyGlobalProxy(*legacy.GlobalProxy); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}

	logger.Infof("已从旧 WebKit 本地存储迁移 %d 条连接（source=%s）", len(legacy.Connections), sourcePath)
	return nil
}

// legacyLocalStorageSkipPrefixes lists regenerable caches that must not slow
// down the first-boot migration or consume the destination localStorage quota.
var legacyLocalStorageSkipPrefixes = []string{
	"gonavi.plugin-market.catalog.v1:",
}

// findLegacyWebKitLocalStorage returns the richest legacy WebKit localStorage
// database. Unlike findLegacyWebKitVisibleConfig it keeps every localStorage
// key so the frontend can restore theme, layout, tabs and AI sessions too.
func findLegacyWebKitLocalStorage(homeDir string) (map[string]string, string, bool) {
	best := map[string]string{}
	bestPath := ""
	bestScore := -1

	for _, bundleID := range legacyWebKitBundleIDs {
		pattern := filepath.Join(homeDir, "Library", "WebKit", bundleID, "WebsiteData", "Default", "*", "*", "LocalStorage", "localstorage.sqlite3")
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, dbPath := range matches {
			items, err := readLegacyWebKitLocalStorage(dbPath)
			if err != nil {
				continue
			}
			score := legacyLocalStorageScore(items)
			if score > bestScore {
				best = items
				bestPath = dbPath
				bestScore = score
			}
		}
	}

	if bestScore < 0 {
		return map[string]string{}, "", false
	}
	return best, bestPath, true
}

func legacyLocalStorageScore(items map[string]string) int {
	if len(items) == 0 {
		return -1
	}
	score := len(items)
	if _, ok := items[legacyPersistKey]; ok {
		score += 1000
	}
	if _, ok := items["gonavi-background-image-v1"]; ok {
		score += 10
	}
	return score
}

func readLegacyWebKitLocalStorage(dbPath string) (map[string]string, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT key, CAST(value AS BLOB) FROM ItemTable`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make(map[string]string)
	for rows.Next() {
		var key string
		var raw []byte
		if err := rows.Scan(&key, &raw); err != nil {
			return nil, err
		}
		key = strings.TrimSpace(key)
		if key == "" || skipLegacyLocalStorageKey(key) {
			continue
		}
		value := decodeLegacyWebKitJSON(raw)
		if value == "" {
			continue
		}
		items[key] = value
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func skipLegacyLocalStorageKey(key string) bool {
	for _, prefix := range legacyLocalStorageSkipPrefixes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func findLegacyWebKitVisibleConfig(homeDir string) (legacyWebKitVisibleConfig, string, error) {
	var best legacyWebKitVisibleConfig
	var bestPath string
	bestScore := -1

	for _, bundleID := range legacyWebKitBundleIDs {
		pattern := filepath.Join(homeDir, "Library", "WebKit", bundleID, "WebsiteData", "Default", "*", "*", "LocalStorage", "localstorage.sqlite3")
		matches, err := filepath.Glob(pattern)
		if err != nil {
			return legacyWebKitVisibleConfig{}, "", err
		}
		for _, dbPath := range matches {
			current, err := readLegacyWebKitVisibleConfig(dbPath)
			if err != nil {
				continue
			}
			score := len(current.Connections) * 10
			if current.GlobalProxy != nil {
				score++
			}
			if score > bestScore {
				best = current
				bestPath = dbPath
				bestScore = score
			}
		}
	}

	if bestScore < 0 {
		return legacyWebKitVisibleConfig{}, "", nil
	}
	return best, bestPath, nil
}

func readLegacyWebKitVisibleConfig(dbPath string) (legacyWebKitVisibleConfig, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return legacyWebKitVisibleConfig{}, err
	}
	defer db.Close()

	var raw []byte
	if err := db.QueryRow(`SELECT CAST(value AS BLOB) FROM ItemTable WHERE key = ?`, legacyPersistKey).Scan(&raw); err != nil {
		if err == sql.ErrNoRows {
			return legacyWebKitVisibleConfig{}, nil
		}
		return legacyWebKitVisibleConfig{}, err
	}

	payload := decodeLegacyWebKitJSON(raw)
	if strings.TrimSpace(payload) == "" {
		return legacyWebKitVisibleConfig{}, nil
	}

	var envelope struct {
		State legacyWebKitVisibleConfig `json:"state"`
	}
	if err := json.Unmarshal([]byte(payload), &envelope); err != nil {
		return legacyWebKitVisibleConfig{}, fmt.Errorf("parse legacy webkit storage %s: %w", dbPath, err)
	}
	return envelope.State, nil
}

func decodeLegacyWebKitJSON(raw []byte) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return ""
	}
	if utf8.Valid(trimmed) && !bytes.Contains(trimmed, []byte{0x00}) {
		return string(trimmed)
	}
	if len(trimmed)%2 == 0 {
		u16 := make([]uint16, 0, len(trimmed)/2)
		for i := 0; i < len(trimmed); i += 2 {
			u16 = append(u16, binary.LittleEndian.Uint16(trimmed[i:i+2]))
		}
		decoded := strings.TrimRight(string(utf16.Decode(u16)), "\x00")
		if utf8.ValidString(decoded) {
			return strings.TrimSpace(decoded)
		}
	}
	return strings.TrimSpace(string(trimmed))
}
