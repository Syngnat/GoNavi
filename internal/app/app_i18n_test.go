package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/shared/i18n"
)

func appFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("app.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func expectedLocalizedAppMessage(base string) string {
	path := strings.TrimSpace(logger.Path())
	if path == "" {
		return base
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() <= 0 {
		return base
	}
	return base + defaultAppText("driver_manager.backend.message.log_hint", map[string]any{"path": path})
}


func TestAppBackendCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"app.backend.error.reset_webview_zoom_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing app backend key %q", language, key)
			}
		}
	}
}

func TestWrapConnectError_UsesCurrentLanguageForTimeoutWrapper(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})

	config := connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		Database: "crm",
	}

	wrapped := wrapConnectError(config, context.DeadlineExceeded)
	text := wrapped.Error()
	expected := defaultAppText("db.backend.message.connect_timeout_detail", map[string]any{
		"dbType":   config.Type,
		"host":     config.Host,
		"port":     config.Port,
		"database": config.Database,
		"detail":   context.DeadlineExceeded.Error(),
	})
	expected = expectedLocalizedAppMessage(expected)
	if text != expected {
		t.Fatalf("expected localized timeout wrapper %q, got %q", expected, text)
	}
	if strings.Contains(text, "数据库连接超时") {
		t.Fatalf("expected no raw Chinese timeout wrapper, got %q", text)
	}
}

func TestCancelQuery_UsesCurrentLanguageForMessages(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})

	missing := app.CancelQuery("missing-query")
	if expected := app.appText("query_editor.message.cancel_no_running", nil); missing.Message != expected {
		t.Fatalf("expected missing query message %q, got %q", expected, missing.Message)
	}

	queryID := app.GenerateQueryID()
	_, cancel := context.WithCancel(context.Background())
	app.queryMu.Lock()
	app.runningQueries[queryID] = queryContext{
		cancel:  cancel,
		started: time.Now(),
	}
	app.queryMu.Unlock()

	cancelled := app.CancelQuery(queryID)
	if expected := app.appText("query_editor.message.cancel_success", nil); cancelled.Message != expected {
		t.Fatalf("expected cancel success message %q, got %q", expected, cancelled.Message)
	}
}

func TestGetDatabaseWithPing_UsesCurrentLanguageForFailureCooldown(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				return errors.New("dial tcp 10.1.131.86:5432: connect: connection refused")
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})
	app.startedAt = time.Now().Add(-startupConnectRetryWindow - time.Second)

	config := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, firstErr := app.getDatabaseWithPing(config, false)
	if firstErr == nil {
		t.Fatal("expected first connection attempt to fail")
	}

	key := getCacheKey(config)
	failure, remaining, ok := app.getCachedConnectFailureByKey(key)
	if !ok {
		t.Fatal("expected cached failure after first connect attempt")
	}

	_, secondErr := app.getDatabaseWithPing(config, false)
	if secondErr == nil {
		t.Fatal("expected second connection attempt to hit cooldown")
	}

	expected := app.appText("db.backend.message.connect_failure_cooldown", map[string]any{
		"remaining": formatConnectFailureCooldown(remaining),
		"detail":    normalizeErrorMessage(unwrapLogHintError(failure.err)),
	})
	expected = expectedLocalizedAppMessage(expected)
	if secondErr.Error() != expected {
		t.Fatalf("expected localized cooldown message %q, got %q", expected, secondErr.Error())
	}
	if strings.Contains(secondErr.Error(), "连接最近失败，正在冷却中") {
		t.Fatalf("expected no raw Chinese cooldown wrapper, got %q", secondErr.Error())
	}
}

func TestAppSetLanguageUpdatesDataSyncBackendLanguage(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	result := syncbackend.NewSyncEngine(syncbackend.Reporter{}).Analyze(syncbackend.SyncConfig{
		SourceQuery: "SELECT id FROM active_users",
		Content:     "schema",
		Tables:      []string{"users"},
	})
	if result.Success {
		t.Fatalf("expected source query analyze validation failure, got %+v", result)
	}

	localizer, err := i18n.NewLocalizer(i18n.LanguageEnUS)
	if err != nil {
		t.Fatalf("NewLocalizer(en-US) error = %v", err)
	}
	want := localizer.T("data_sync.backend.validation.query_mode_data_only", nil)
	if result.Message != want {
		t.Fatalf("expected App.SetLanguage to propagate English DataSync backend message %q, got %q", want, result.Message)
	}
	if strings.Contains(result.Message, "SQL 结果集同步当前仅支持") {
		t.Fatalf("expected no raw Chinese DataSync validation message, got %q", result.Message)
	}
}
