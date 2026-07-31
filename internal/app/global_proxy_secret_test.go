package app

import (
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

func TestSaveGlobalProxyStripsPasswordFromView(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	view, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	})
	if err != nil {
		t.Fatalf("saveGlobalProxy returned error: %v", err)
	}
	if view.Password != "" {
		t.Fatal("global proxy view must not expose plaintext password")
	}
	if !view.HasPassword {
		t.Fatal("expected hasPassword=true")
	}

	snapshot := currentGlobalProxyConfig()
	if snapshot.Proxy.Password != "proxy-secret" {
		t.Fatalf("expected runtime proxy password to be preserved, got %q", snapshot.Proxy.Password)
	}
}

func TestGetGlobalProxyConfigReturnsSecretlessView(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	if _, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	}); err != nil {
		t.Fatalf("saveGlobalProxy returned error: %v", err)
	}

	result := app.GetGlobalProxyConfig()
	view, ok := result.Data.(connection.GlobalProxyView)
	if !ok {
		t.Fatalf("expected GlobalProxyView, got %T", result.Data)
	}
	if view.Password != "" {
		t.Fatal("GetGlobalProxyConfig must not expose plaintext password")
	}
	if !view.HasPassword {
		t.Fatal("expected hasPassword=true")
	}
}

func TestSaveGlobalProxyClearPasswordRemovesStoredSecret(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	if _, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	}); err != nil {
		t.Fatalf("saveGlobalProxy with password returned error: %v", err)
	}

	view, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:       true,
		Type:          "http",
		Host:          "127.0.0.1",
		Port:          8080,
		User:          "ops",
		ClearPassword: true,
	})
	if err != nil {
		t.Fatalf("saveGlobalProxy clear password returned error: %v", err)
	}
	if view.HasPassword {
		t.Fatal("expected global proxy password marker to be cleared")
	}
	if secret, ok, err := app.dailySecretStore().GetGlobalProxy(); err != nil {
		t.Fatalf("GetGlobalProxy returned error: %v", err)
	} else if ok || secret.Password != "" {
		t.Fatalf("expected global proxy secret to be deleted, got %#v ok=%v", secret, ok)
	}
	snapshot := currentGlobalProxyConfig()
	if snapshot.Proxy.Password != "" {
		t.Fatalf("expected runtime proxy password to be cleared, got %q", snapshot.Proxy.Password)
	}
}

func TestSaveGlobalProxyDisabledKeepsDraftAndStoredPassword(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	if _, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	}); err != nil {
		t.Fatalf("saveGlobalProxy with password returned error: %v", err)
	}

	view, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled: false,
		Type:    "http",
		Host:    "127.0.0.1",
		Port:    8080,
		User:    "ops",
	})
	if err != nil {
		t.Fatalf("saveGlobalProxy disabled draft returned error: %v", err)
	}
	if view.Enabled {
		t.Fatal("expected saved proxy view to stay disabled")
	}
	if view.Host != "127.0.0.1" || view.Port != 8080 || view.User != "ops" {
		t.Fatalf("expected disabled draft fields to be retained, got %#v", view)
	}
	if !view.HasPassword {
		t.Fatal("expected disabled draft to keep saved password marker")
	}
	if snapshot := currentGlobalProxyConfig(); snapshot.Enabled {
		t.Fatalf("expected runtime global proxy to be disabled, got %#v", snapshot)
	}
	if secret, ok, err := app.dailySecretStore().GetGlobalProxy(); err != nil {
		t.Fatalf("GetGlobalProxy returned error: %v", err)
	} else if !ok || secret.Password != "proxy-secret" {
		t.Fatalf("expected saved proxy password to be retained, got %#v ok=%v", secret, ok)
	}

	result := app.GetGlobalProxyConfig()
	stored, ok := result.Data.(connection.GlobalProxyView)
	if !ok {
		t.Fatalf("expected GlobalProxyView, got %T", result.Data)
	}
	if stored.Enabled || stored.Host != "127.0.0.1" || !stored.HasPassword {
		t.Fatalf("expected GetGlobalProxyConfig to return disabled persisted draft, got %#v", stored)
	}
}

func TestTestGlobalProxyConnectionUsesDraftHTTPProxy(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	proxyCalled := false
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyCalled = true
		if !r.URL.IsAbs() {
			t.Fatalf("expected proxy request URL to be absolute, got %q", r.URL.String())
		}
		if r.URL.String() != "http://example.com/probe" {
			t.Fatalf("unexpected target URL through proxy: %s", r.URL.String())
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer proxyServer.Close()

	host, port := parseTestServerHostPort(t, proxyServer.URL)
	result := app.TestGlobalProxyConnection(connection.TestGlobalProxyInput{
		Proxy: connection.SaveGlobalProxyInput{
			Enabled: true,
			Type:    "http",
			Host:    host,
			Port:    port,
		},
		URL:            "http://example.com/probe",
		TimeoutSeconds: 2,
	})
	if !result.Success {
		t.Fatalf("expected proxy test success, got %#v", result)
	}
	if !proxyCalled {
		t.Fatal("expected draft proxy to receive the test request")
	}
	data, ok := result.Data.(connection.GlobalProxyTestResult)
	if !ok {
		t.Fatalf("expected GlobalProxyTestResult, got %T", result.Data)
	}
	if data.StatusCode != http.StatusNoContent || !data.ViaProxy {
		t.Fatalf("unexpected proxy test data: %#v", data)
	}
}

func TestTestGlobalProxyConnectionReusesSavedPasswordWhenDraftPasswordBlank(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	if _, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	}); err != nil {
		t.Fatalf("saveGlobalProxy returned error: %v", err)
	}

	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops:proxy-secret"))
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Proxy-Authorization"); got != wantAuth {
			t.Fatalf("expected saved proxy password auth %q, got %q", wantAuth, got)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer proxyServer.Close()

	host, port := parseTestServerHostPort(t, proxyServer.URL)
	result := app.TestGlobalProxyConnection(connection.TestGlobalProxyInput{
		Proxy: connection.SaveGlobalProxyInput{
			Enabled: true,
			Type:    "http",
			Host:    host,
			Port:    port,
			User:    "ops",
		},
		URL:            "http://example.com/probe",
		TimeoutSeconds: 2,
	})
	if !result.Success {
		t.Fatalf("expected proxy test to reuse saved password, got %#v", result)
	}
}

func parseTestServerHostPort(t *testing.T, rawURL string) (string, int) {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("url.Parse returned error: %v", err)
	}
	host, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("SplitHostPort returned error: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("Atoi returned error: %v", err)
	}
	return host, port
}

func TestLoadPersistedGlobalProxyOnDarwinUsesInlinePassword(t *testing.T) {
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("setGlobalProxyConfig returned error: %v", err)
	}

	app := NewAppWithSecretStore(failOnUseSecretStore{})
	app.configDir = t.TempDir()

	if _, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	}); err != nil {
		t.Fatalf("saveGlobalProxy returned error: %v", err)
	}

	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("setGlobalProxyConfig reset returned error: %v", err)
	}

	app.loadPersistedGlobalProxy()
	snapshot := currentGlobalProxyConfig()
	if !snapshot.Enabled {
		t.Fatal("expected persisted global proxy to be restored")
	}
	if snapshot.Proxy.Password != "proxy-secret" {
		t.Fatalf("expected daily-stored global proxy password to be restored, got %q", snapshot.Proxy.Password)
	}
}

func TestSaveGlobalProxyUsesCurrentLanguageForValidationErrors(t *testing.T) {
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("setGlobalProxyConfig reset returned error: %v", err)
	}

	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
		_, _ = setGlobalProxyConfig(false, connection.ProxyConfig{})
	})

	_, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled: true,
		Type:    "Shadowsocks",
		Host:    "127.0.0.1",
		Port:    1080,
	})
	if err == nil {
		t.Fatal("expected saveGlobalProxy to reject unsupported proxy type")
	}

	want := app.appText("proxy.backend.error.unsupported_type", map[string]any{"type": "Shadowsocks"})
	if err.Error() != want {
		t.Fatalf("expected localized saveGlobalProxy error %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "不支持的代理类型") {
		t.Fatalf("expected no raw Chinese proxy validation error, got %q", err.Error())
	}
}

func TestConfigureGlobalProxyUsesCurrentLanguageForSuccessMessage(t *testing.T) {
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("setGlobalProxyConfig reset returned error: %v", err)
	}

	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
		_, _ = setGlobalProxyConfig(false, connection.ProxyConfig{})
	})

	result := app.ConfigureGlobalProxy(true, connection.ProxyConfig{
		Type: "http",
		Host: "127.0.0.1",
		Port: 8080,
	})
	if !result.Success {
		t.Fatalf("expected ConfigureGlobalProxy success, got %+v", result)
	}

	want := app.appText("app.proxy.message.config_applied", nil)
	if result.Message != want {
		t.Fatalf("expected localized ConfigureGlobalProxy success message %q, got %q", want, result.Message)
	}
	if strings.Contains(result.Message, "全局代理配置已生效") {
		t.Fatalf("expected no raw Chinese global proxy success message, got %q", result.Message)
	}
}

