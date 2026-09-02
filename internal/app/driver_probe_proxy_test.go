package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestResolveDriverProbeDialAddressPrefersExplicitGlobalProxy(t *testing.T) {
	restoreGlobalProxyAfterTest(t)
	if _, err := setGlobalProxyConfig(true, connection.ProxyConfig{
		Type: "socks5",
		Host: "127.0.0.1",
		Port: 19080,
	}); err != nil {
		t.Fatalf("configure explicit global proxy: %v", err)
	}
	setHTTPProxyEnvironmentForTest(t, "", "http://127.0.0.1:19081", "")

	got, err := resolveDriverProbeDialAddress("https://github.com/Syngnat/GoNavi")
	if err != nil {
		t.Fatalf("resolve driver probe address: %v", err)
	}
	if got != "127.0.0.1:19080" {
		t.Fatalf("expected explicit GoNavi proxy endpoint, got %q", got)
	}
}

func TestResolveDriverProbeDialAddressUsesEnvironmentProxy(t *testing.T) {
	restoreGlobalProxyAfterTest(t)
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("disable explicit global proxy: %v", err)
	}
	setHTTPProxyEnvironmentForTest(t, "", "http://127.0.0.1:19081", "")

	got, err := resolveDriverProbeDialAddress("https://github.com/Syngnat/GoNavi")
	if err != nil {
		t.Fatalf("resolve driver probe address: %v", err)
	}
	if got != "127.0.0.1:19081" {
		t.Fatalf("expected environment proxy endpoint, got %q", got)
	}
}

func TestResolveDriverProbeDialAddressHonorsEnvironmentNoProxy(t *testing.T) {
	restoreGlobalProxyAfterTest(t)
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("disable explicit global proxy: %v", err)
	}
	setHTTPProxyEnvironmentForTest(t, "", "http://127.0.0.1:19081", "github.com")

	got, err := resolveDriverProbeDialAddress("https://github.com/Syngnat/GoNavi")
	if err != nil {
		t.Fatalf("resolve driver probe address: %v", err)
	}
	if got != "github.com:443" {
		t.Fatalf("expected NO_PROXY to keep the target endpoint, got %q", got)
	}
}

func TestResolveDriverProbeDialAddressHonorsNoProxyOnly(t *testing.T) {
	restoreGlobalProxyAfterTest(t)
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("disable explicit global proxy: %v", err)
	}
	setHTTPProxyEnvironmentForTest(t, "", "", "github.com")

	got, err := resolveDriverProbeDialAddress("https://github.com/Syngnat/GoNavi")
	if err != nil {
		t.Fatalf("resolve driver probe address: %v", err)
	}
	if got != "github.com:443" {
		t.Fatalf("expected NO_PROXY-only policy to keep the target endpoint, got %q", got)
	}
}

func TestResolveDriverProbeDialAddressDoesNotMixHTTPEnvWithHTTPSSystemProxy(t *testing.T) {
	restoreGlobalProxyAfterTest(t)
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("disable explicit global proxy: %v", err)
	}
	setHTTPProxyEnvironmentForTest(t, "http://127.0.0.1:19081", "", "")

	got, err := resolveDriverProbeDialAddress("https://github.com/Syngnat/GoNavi")
	if err != nil {
		t.Fatalf("resolve driver probe address: %v", err)
	}
	if got != "github.com:443" {
		t.Fatalf("expected HTTP_PROXY-only policy to leave HTTPS direct, got %q", got)
	}
}

func restoreGlobalProxyAfterTest(t *testing.T) {
	t.Helper()
	previous := currentGlobalProxyConfig()
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(previous.Enabled, previous.Proxy)
	})
}

func setHTTPProxyEnvironmentForTest(t *testing.T, httpProxy string, httpsProxy string, noProxy string) {
	t.Helper()
	for _, name := range []string{
		"HTTP_PROXY", "http_proxy",
		"HTTPS_PROXY", "https_proxy",
		"ALL_PROXY", "all_proxy",
		"NO_PROXY", "no_proxy",
	} {
		t.Setenv(name, "")
	}
	t.Setenv("HTTP_PROXY", httpProxy)
	t.Setenv("HTTPS_PROXY", httpsProxy)
	t.Setenv("NO_PROXY", noProxy)
}
