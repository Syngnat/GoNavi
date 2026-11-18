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
	// The migration marker is written into the same localStorage database it
	// describes. Including it in the source payload would change the fingerprint
	// on every launch, so the "already imported" check could never match.
	"gonavi-legacy-local-storage-migrated-",
}

// findLegacyWebKitLocalStorage returns the legacy WebKit localStorage
// database used for the v2 -> v3 migration. Unlike
// findLegacyWebKitVisibleConfig it keeps every localStorage key so the frontend
// can restore theme, layout, tabs and AI sessions too.
func findLegacyWebKitLocalStorage(homeDir string) (map[string]string, string, bool) {
	var bestV2, bestAny map[string]string
	var bestV2Path, bestAnyPath string
	bestV2Score, bestAnyScore := -1, -1

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
			if score > bestAnyScore {
				bestAny = items
				bestAnyPath = dbPath
				bestAnyScore = score
			}
			if legacyLocalStorageIsV2Origin(dbPath) && score > bestV2Score {
				bestV2 = items
				bestV2Path = dbPath
				bestV2Score = score
			}
		}
	}

	if bestV2Score >= 0 {
		return bestV2, bestV2Path, true
	}
	if bestAnyScore >= 0 {
		return bestAny, bestAnyPath, true
	}
	return map[string]string{}, "", false
}

// legacyLocalStorageIsV2Origin reports whether the database belongs to the
// wails://wails origin used by Wails v2 and, deliberately, by current v3
// builds. Wails v3's default wails://localhost store can still exist from a
// preview build; it is rejected so a richer v3 profile cannot become the
// migration source and a v3 settings reset cannot re-import old settings.
func legacyLocalStorageIsV2Origin(dbPath string) bool {
	originPath := filepath.Join(filepath.Dir(filepath.Dir(dbPath)), "origin")
	if data, err := os.ReadFile(originPath); err == nil && len(data) > 0 {
		// WKWebView stores the origin as a small binary payload that still
		// contains the ASCII host. v2 used wails://wails; current v3 pins that
		// origin, while preview builds used wails://localhost.
		if strings.Contains(string(data), "localhost") {
			return false
		}
		return strings.Contains(string(data), "wails")
	}
	name := strings.ToLower(filepath.Base(dbPath))
	if strings.Contains(name, "localhost") {
		return false
	}
	return strings.Contains(name, "wails_wails") || strings.Contains(name, "wails")
}

func legacyLocalStorageScore(items map[string]string) int {
	if len(items) == 0 {
		return -1
	}
	score := len(items)
	if value, ok := items[legacyPersistKey]; ok {
		score += 1000
		// Default profiles and real profiles can expose the same number of keys.
		// The persisted UI payload size is the reliable signal that separates a
		// freshly written default store from the user's previous settings.
		score += len(value) / 64
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
