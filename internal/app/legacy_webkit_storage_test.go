package app

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
