package app

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	_ "modernc.org/sqlite"
)

func TestMigrateLegacyWebKitStorageIfNeededImportsConnectionsForDevBuild(t *testing.T) {
	withTestGOOS(t, "darwin")

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	homeDir := t.TempDir()

	writeLegacyWebKitStorage(t, homeDir, "com.wails.GoNavi", legacyWebKitStoragePayload{
		Connections: []connection.LegacySavedConnection{
			{
				ID:   "legacy-1",
				Name: "Legacy One",
				Config: connection.ConnectionConfig{
					ID:       "legacy-1",
					Type:     "postgres",
					Host:     "db.local",
					Port:     5432,
					User:     "postgres",
					Password: "secret-1",
				},
			},
		},
		GlobalProxy: &connection.LegacyGlobalProxyInput{
			Enabled:  true,
			Type:     "http",
			Host:     "127.0.0.1",
			Port:     8080,
			User:     "ops",
			Password: "proxy-secret",
		},
	})

	if err := migrateLegacyWebKitStorageIfNeededWithHome(app, "dev", func() (string, error) {
		return homeDir, nil
	}); err != nil {
		t.Fatalf("migrateLegacyWebKitStorageIfNeededWithHome returned error: %v", err)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected 1 saved connection, got %d", len(saved))
	}
	if saved[0].Name != "Legacy One" {
		t.Fatalf("expected imported connection name to be preserved, got %q", saved[0].Name)
	}

	resolved, err := app.resolveConnectionSecrets(saved[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "secret-1" {
		t.Fatalf("expected imported primary password, got %q", resolved.Password)
	}

	view := app.GetGlobalProxyConfig()
	if !view.Success {
		t.Fatalf("expected GetGlobalProxyConfig success, got %#v", view)
	}
	proxy, ok := view.Data.(connection.GlobalProxyView)
	if !ok {
		t.Fatalf("expected GlobalProxyView payload, got %#v", view.Data)
	}
	if proxy.Host != "127.0.0.1" || !proxy.HasPassword {
		t.Fatalf("expected imported global proxy to be restored, got %#v", proxy)
	}
}

func TestMigrateLegacyWebKitStorageIfNeededSkipsWhenConnectionsFileAlreadyExists(t *testing.T) {
	withTestGOOS(t, "darwin")

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	homeDir := t.TempDir()

	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "current-1",
		Name: "Current",
		Config: connection.ConnectionConfig{
			ID:   "current-1",
			Type: "postgres",
			Host: "current.local",
			Port: 5432,
			User: "postgres",
		},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	writeLegacyWebKitStorage(t, homeDir, "com.wails.GoNavi", legacyWebKitStoragePayload{
		Connections: []connection.LegacySavedConnection{
			{
				ID:   "legacy-1",
				Name: "Legacy One",
				Config: connection.ConnectionConfig{
					ID:   "legacy-1",
					Type: "postgres",
					Host: "legacy.local",
					Port: 5432,
					User: "postgres",
				},
			},
		},
	})

	if err := migrateLegacyWebKitStorageIfNeededWithHome(app, "dev", func() (string, error) {
		return homeDir, nil
	}); err != nil {
		t.Fatalf("migrateLegacyWebKitStorageIfNeededWithHome returned error: %v", err)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected existing connections to remain unchanged, got %d", len(saved))
	}
	if saved[0].Name != "Current" {
		t.Fatalf("expected migration to skip existing repository, got %q", saved[0].Name)
	}
}

type legacyWebKitStoragePayload struct {
	Connections []connection.LegacySavedConnection `json:"connections"`
	GlobalProxy *connection.LegacyGlobalProxyInput `json:"globalProxy,omitempty"`
}

func writeLegacyWebKitStorage(t *testing.T, homeDir string, bundleID string, payload legacyWebKitStoragePayload) {
	t.Helper()

	dbPath := filepath.Join(
		homeDir,
		"Library",
		"WebKit",
		bundleID,
		"WebsiteData",
		"Default",
		"test-origin",
		"test-origin",
		"LocalStorage",
		"localstorage.sqlite3",
	)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open returned error: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("CREATE TABLE returned error: %v", err)
	}

	raw, err := json.Marshal(map[string]any{
		"state": map[string]any{
			"connections": payload.Connections,
			"globalProxy": payload.GlobalProxy,
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO ItemTable(key, value) VALUES(?, ?)`, "lite-db-storage", string(raw)); err != nil {
		t.Fatalf("INSERT returned error: %v", err)
	}
}

func TestLegacyLocalStorageHandlerReturnsLegacySettings(t *testing.T) {
	withTestGOOS(t, "darwin")
	homeDir := t.TempDir()
	writeLegacyWebKitLocalStorage(t, homeDir, "com.wails.GoNavi", map[string]string{
		"lite-db-storage":                     `{"state":{"themePreference":"dark"}}`,
		"gonavi-background-image-v1":          `{"version":1}`,
		"gonavi.plugin-market.catalog.v1:key": "cached",
	})

	request := httptest.NewRequest(http.MethodGet, legacyLocalStorageEndpoint, nil)
	request.Header.Set("Referer", "wails://localhost/")
	recorder := httptest.NewRecorder()
	legacyLocalStorageHandlerWithHome(nil, func() (string, error) {
		return homeDir, nil
	}).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	var response legacyLocalStorageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}
	if !response.Found {
		t.Fatalf("expected found legacy storage")
	}
	if response.Items[legacyPersistKey] == "" {
		t.Fatalf("expected lite-db-storage to be returned")
	}
	if response.Items["gonavi-background-image-v1"] == "" {
		t.Fatalf("expected background image settings to be returned")
	}
	if _, ok := response.Items["gonavi.plugin-market.catalog.v1:key"]; ok {
		t.Fatalf("expected regenerable catalog cache to be omitted")
	}
}

func TestLegacyLocalStorageHandlerReportsSavedConnections(t *testing.T) {
	withTestGOOS(t, "darwin")

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID:     "current-1",
		Name:   "Current",
		Config: connection.ConnectionConfig{ID: "current-1", Type: "postgres", Host: "current.local", Port: 5432, User: "postgres"},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	homeDir := t.TempDir()
	writeLegacyWebKitLocalStorage(t, homeDir, "com.wails.GoNavi", map[string]string{
		"lite-db-storage": `{"state":{"themePreference":"dark"}}`,
	})
	request := httptest.NewRequest(http.MethodGet, legacyLocalStorageEndpoint, nil)
	request.Header.Set("Referer", "wails://localhost/")
	recorder := httptest.NewRecorder()
	legacyLocalStorageHandlerWithHome(application, func() (string, error) {
		return homeDir, nil
	}).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	var response legacyLocalStorageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}
	if !response.HasSavedConnections {
		t.Fatalf("expected the response to report existing saved connections")
	}
}

func TestLegacyLocalStorageHandlerRejectsPluginPageReferer(t *testing.T) {
	withTestGOOS(t, "darwin")
	request := httptest.NewRequest(http.MethodGet, legacyLocalStorageEndpoint, nil)
	request.Header.Set("Referer", "wails://localhost/plugin-pages/example/index.html")
	recorder := httptest.NewRecorder()
	legacyLocalStorageHandlerWithHome(nil, func() (string, error) {
		return t.TempDir(), nil
	}).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected plugin page requests to be rejected, got %d", recorder.Code)
	}
}

func TestLegacyLocalStorageHandlerReturnsEmptyOutsideDarwin(t *testing.T) {
	withTestGOOS(t, "windows")
	request := httptest.NewRequest(http.MethodGet, legacyLocalStorageEndpoint, nil)
	request.Header.Set("Referer", "http://wails.localhost/")
	recorder := httptest.NewRecorder()
	legacyLocalStorageHandlerWithHome(nil, func() (string, error) {
		return t.TempDir(), nil
	}).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	var response legacyLocalStorageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}
	if response.Found || len(response.Items) != 0 {
		t.Fatalf("expected empty response outside darwin, got %#v", response)
	}
}

func writeLegacyWebKitLocalStorage(t *testing.T, homeDir string, bundleID string, items map[string]string) {
	t.Helper()

	dbPath := filepath.Join(
		homeDir,
		"Library",
		"WebKit",
		bundleID,
		"WebsiteData",
		"Default",
		"test-origin",
		"test-origin",
		"LocalStorage",
		"localstorage.sqlite3",
	)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open returned error: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("CREATE TABLE returned error: %v", err)
	}
	for key, value := range items {
		if _, err := db.Exec(`INSERT INTO ItemTable(key, value) VALUES(?, ?)`, key, value); err != nil {
			t.Fatalf("INSERT returned error: %v", err)
		}
	}
}

func TestFindLegacyLinuxLocalStoragePicksRichestProfile(t *testing.T) {
	dataHome := t.TempDir()
	writeLegacyLocalStorageFile(t, filepath.Join(dataHome, "GoNavi", "localstorage", "wails_wails_0.localstorage"), map[string]string{
		legacyPersistKey:             `{"state":{"sidebarWidth":460,"themePreference":"dark"}}`,
		"gonavi-background-image-v1": `{"version":1}`,
	})
	writeLegacyLocalStorageFile(t, filepath.Join(dataHome, "GoNavi", "localstorage", "wails_localhost_0.localstorage"), map[string]string{
		legacyPersistKey: `{"state":{"sidebarWidth":330,"themePreference":"light"}}`,
	})

	items, source, found := findLegacyLinuxLocalStorage(t.TempDir(), dataHome, "GoNavi")
	if !found {
		t.Fatalf("expected Linux legacy storage to be found")
	}
	if !strings.Contains(source, "wails_wails_0.localstorage") {
		t.Fatalf("expected the richer v2 origin to win, got %q", source)
	}
	if !strings.Contains(items[legacyPersistKey], "460") {
		t.Fatalf("expected the v2 payload, got %q", items[legacyPersistKey])
	}
}

func TestFindLegacyLinuxLocalStoragePrefersV2OriginWhenV3ProfileIsRicher(t *testing.T) {
	dataHome := t.TempDir()
	v2Path := filepath.Join(dataHome, "GoNavi", "localstorage", "wails_wails_0.localstorage")
	writeLegacyLocalStorageFile(t, v2Path, map[string]string{
		legacyPersistKey: `{"state":{"sidebarWidth":460}}`,
	})
	v3Path := filepath.Join(dataHome, "GoNavi", "localstorage", "wails_localhost_0.localstorage")
	writeLegacyLocalStorageFile(t, v3Path, map[string]string{
		legacyPersistKey:             `{"state":{"sidebarWidth":330,"tabs":[` + strings.Repeat(`{"id":"tab"},`, 200) + `{"id":"last"}]}}`,
		"gonavi-background-image-v1": `{"version":1}`,
	})

	items, source, found := findLegacyLinuxLocalStorage(t.TempDir(), dataHome, "GoNavi")
	if !found {
		t.Fatalf("expected Linux legacy storage to be found")
	}
	if source != v2Path {
		t.Fatalf("expected the v2 origin to win over the richer v3 profile, got %q", source)
	}
	if !strings.Contains(items[legacyPersistKey], "460") {
		t.Fatalf("expected the v2 payload, got %q", items[legacyPersistKey])
	}
}

func TestFindLegacyWebKitLocalStoragePrefersV2OriginWhenV3ProfileIsRicher(t *testing.T) {
	homeDir := t.TempDir()
	v2Path := filepath.Join(homeDir, "Library", "WebKit", "com.wails.GoNavi", "WebsiteData", "Default", "v2hash", "v2hash", "LocalStorage", "localstorage.sqlite3")
	writeLegacyLocalStorageFile(t, v2Path, map[string]string{
		legacyPersistKey: `{"state":{"sidebarWidth":460}}`,
	})
	if err := os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(v2Path)), "origin"), []byte("wails wails"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	v3Path := filepath.Join(homeDir, "Library", "WebKit", "com.wails.GoNavi", "WebsiteData", "Default", "v3hash", "v3hash", "LocalStorage", "localstorage.sqlite3")
	writeLegacyLocalStorageFile(t, v3Path, map[string]string{
		legacyPersistKey:             `{"state":{"sidebarWidth":330,"tabs":[` + strings.Repeat(`{"id":"tab"},`, 200) + `{"id":"last"}]}}`,
		"gonavi-background-image-v1": `{"version":1}`,
	})
	if err := os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(v3Path)), "origin"), []byte("wails localhost"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	items, source, found := findLegacyWebKitLocalStorage(homeDir)
	if !found {
		t.Fatalf("expected macOS legacy storage to be found")
	}
	if source != v2Path {
		t.Fatalf("expected the v2 origin to win over the richer v3 profile, got %q", source)
	}
	if !strings.Contains(items[legacyPersistKey], "460") {
		t.Fatalf("expected the v2 payload, got %q", items[legacyPersistKey])
	}
}

func TestFindLegacyLinuxLocalStorageReadsNewWebKitLayout(t *testing.T) {
	dataHome := t.TempDir()
	dbPath := filepath.Join(dataHome, "GoNavi", "WebsiteData", "Default", "ab", "cd", "LocalStorage", "localstorage.sqlite3")
	writeLegacyLocalStorageFile(t, dbPath, map[string]string{
		legacyPersistKey: `{"state":{"sidebarWidth":420}}`,
	})

	items, source, found := findLegacyLinuxLocalStorage(t.TempDir(), dataHome, "GoNavi")
	if !found || source != dbPath {
		t.Fatalf("expected the new WebKitGTK layout at %s, got found=%v source=%q", dbPath, found, source)
	}
	if !strings.Contains(items[legacyPersistKey], "420") {
		t.Fatalf("expected the persisted payload, got %q", items[legacyPersistKey])
	}
}

func TestFindLegacyLinuxLocalStorageReadsSharedWailsRoot(t *testing.T) {
	dataHome := t.TempDir()
	dbPath := filepath.Join(dataHome, "wails", "Default", "ab", "cd", "LocalStorage", "localstorage.sqlite3")
	writeLegacyLocalStorageFile(t, dbPath, map[string]string{
		legacyPersistKey: `{"state":{"sidebarWidth":410}}`,
	})

	items, source, found := findLegacyLinuxLocalStorage(t.TempDir(), dataHome, "GoNavi")
	if !found || source != dbPath {
		t.Fatalf("expected the shared wails layout at %s, got found=%v source=%q", dbPath, found, source)
	}
	if !strings.Contains(items[legacyPersistKey], "410") {
		t.Fatalf("expected the persisted payload, got %q", items[legacyPersistKey])
	}
}

func TestLegacyLocalStorageIsV2Origin(t *testing.T) {
	root := t.TempDir()
	writeStore := func(name, fileName string, origin []byte) string {
		t.Helper()
		dir := filepath.Join(root, name, name, "LocalStorage")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create store dir: %v", err)
		}
		if origin != nil {
			if err := os.WriteFile(filepath.Join(root, name, name, "origin"), origin, 0o600); err != nil {
				t.Fatalf("write origin: %v", err)
			}
		}
		dbPath := filepath.Join(dir, fileName)
		if err := os.WriteFile(dbPath, nil, 0o600); err != nil {
			t.Fatalf("write store: %v", err)
		}
		return dbPath
	}

	v2Origin := []byte{5, 0, 0, 0, 1, 'w', 'a', 'i', 'l', 's', 5, 0, 0, 0, 1, 'w', 'a', 'i', 'l', 's', 0}
	v3Origin := []byte{5, 0, 0, 0, 1, 'w', 'a', 'i', 'l', 's', 9, 0, 0, 0, 1, 'l', 'o', 'c', 'a', 'l', 'h', 'o', 's', 't', 0}
	if !legacyLocalStorageIsV2Origin(writeStore("v2", "localstorage.sqlite3", v2Origin)) {
		t.Fatal("expected the wails://wails origin to be detected as v2")
	}
	if legacyLocalStorageIsV2Origin(writeStore("v3", "localstorage.sqlite3", v3Origin)) {
		t.Fatal("expected the wails://localhost origin to be rejected")
	}
	if legacyLocalStorageIsV2Origin(writeStore("v3-name", "wails_localhost_0.localstorage", nil)) {
		t.Fatal("expected a localhost file name to be rejected")
	}
	if !legacyLocalStorageIsV2Origin(writeStore("v2-name", "wails_wails_0.localstorage", nil)) {
		t.Fatal("expected a wails file name to be accepted as v2")
	}
}

func TestLegacyLocalStorageFingerprintChangesWithPayload(t *testing.T) {
	first := legacyLocalStorageFingerprint(map[string]string{
		legacyPersistKey:             `{"state":{"themePreference":"dark"}}`,
		"gonavi-background-image-v1": `{"version":1}`,
	})
	second := legacyLocalStorageFingerprint(map[string]string{
		legacyPersistKey:             `{"state":{"themePreference":"light"}}`,
		"gonavi-background-image-v1": `{"version":1}`,
	})
	if len(first) != 64 {
		t.Fatalf("expected a sha256 fingerprint, got %q", first)
	}
	if first == second {
		t.Fatalf("expected a changed payload to change the fingerprint")
	}
}

func TestLegacyLocalStorageHandlerReturnsLinuxSettings(t *testing.T) {
	withTestGOOS(t, "linux")
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	writeLegacyLocalStorageFile(t, filepath.Join(dataHome, "GoNavi", "localstorage", "wails_wails_0.localstorage"), map[string]string{
		legacyPersistKey:                          `{"state":{"themePreference":"dark"}}`,
		"gonavi-background-image-v1":              `{"version":1}`,
		"gonavi.plugin-market.catalog.v1:key":     "cached",
		"gonavi-legacy-local-storage-migrated-v1": `{"version":2}`,
	})

	request := httptest.NewRequest(http.MethodGet, legacyLocalStorageEndpoint, nil)
	request.Header.Set("Referer", "wails://localhost/")
	recorder := httptest.NewRecorder()
	legacyLocalStorageHandlerWithHome(nil, func() (string, error) {
		return t.TempDir(), nil
	}).ServeHTTP(recorder, request)

	var response legacyLocalStorageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}
	if !response.Found {
		t.Fatalf("expected found legacy storage on Linux")
	}
	if response.Fingerprint == "" {
		t.Fatalf("expected a source fingerprint")
	}
	if response.Items[legacyPersistKey] == "" {
		t.Fatalf("expected lite-db-storage to be returned")
	}
	if _, ok := response.Items["gonavi.plugin-market.catalog.v1:key"]; ok {
		t.Fatalf("expected regenerable catalog cache to be omitted")
	}
	if _, ok := response.Items["gonavi-legacy-local-storage-migrated-v1"]; ok {
		t.Fatalf("expected the migration marker itself to be omitted from the source payload")
	}
}

func writeLegacyLocalStorageFile(t *testing.T, dbPath string, items map[string]string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open returned error: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("CREATE TABLE returned error: %v", err)
	}
	for key, value := range items {
		if _, err := db.Exec(`INSERT INTO ItemTable(key, value) VALUES(?, ?)`, key, value); err != nil {
			t.Fatalf("INSERT returned error: %v", err)
		}
	}
}
