package app

import (
	"net/url"
	"strings"
	"testing"
)

func TestWindowsSystemProxyPrefersManualProxyWhenAutoDetectIsAlsoEnabled(t *testing.T) {
	target := mustSystemProxyURL(t, "https://github.com/Syngnat/GoNavi")
	got, err := resolveWindowsSystemProxySettings(target, windowsSystemProxySettings{
		AutoDetect:    true,
		AutoConfigURL: "http://wpad.example/proxy.pac",
		Proxy:         "http=127.0.0.1:17890;https=127.0.0.1:17891;socks=127.0.0.1:17892",
	})
	if err != nil {
		t.Fatalf("resolve Windows proxy: %v", err)
	}
	if got == nil || got.String() != "http://127.0.0.1:17891" {
		t.Fatalf("expected configured HTTPS endpoint, got %v", got)
	}
}

func TestWindowsSystemProxyUsesBypassAndSOCKSFallback(t *testing.T) {
	settings := windowsSystemProxySettings{
		Proxy:       "socks=127.0.0.1:24567",
		ProxyBypass: "<local>;*.corp.example;10.0.0.0/8",
	}
	for _, rawTarget := range []string{
		"https://intranet/resource",
		"https://api.corp.example/resource",
		"https://10.12.3.4/resource",
	} {
		got, err := resolveWindowsSystemProxySettings(mustSystemProxyURL(t, rawTarget), settings)
		if err != nil {
			t.Fatalf("resolve bypass for %s: %v", rawTarget, err)
		}
		if got != nil {
			t.Fatalf("expected %s to bypass the proxy, got %v", rawTarget, got)
		}
	}

	got, err := resolveWindowsSystemProxySettings(mustSystemProxyURL(t, "https://github.com/repo"), settings)
	if err != nil {
		t.Fatalf("resolve SOCKS fallback: %v", err)
	}
	if got == nil || got.String() != "socks5://127.0.0.1:24567" {
		t.Fatalf("expected SOCKS fallback, got %v", got)
	}
}

func TestWindowsSystemProxyFallsBackToDirectForAutomaticOnlyPolicy(t *testing.T) {
	got, err := resolveWindowsSystemProxySettings(
		mustSystemProxyURL(t, "https://github.com/repo"),
		windowsSystemProxySettings{AutoDetect: true},
	)
	if got != nil {
		t.Fatalf("expected no proxy URL, got %v", got)
	}
	if err != nil {
		t.Fatalf("automatic-only Windows settings should allow direct access, got %v", err)
	}
}

func TestWindowsSystemProxyRejectsExplicitPACWithoutManualProxy(t *testing.T) {
	got, err := resolveWindowsSystemProxySettings(
		mustSystemProxyURL(t, "https://github.com/repo"),
		windowsSystemProxySettings{AutoConfigURL: "https://proxy.example/config.pac"},
	)
	if got != nil {
		t.Fatalf("expected no proxy URL for unsupported PAC, got %v", got)
	}
	if err == nil || !strings.Contains(err.Error(), "PAC/WPAD") {
		t.Fatalf("expected explicit PAC/WPAD error, got %v", err)
	}
}

func TestGNOMESystemProxySelectsCurrentPortAndHonorsIgnoreHosts(t *testing.T) {
	settings := gnomeSystemProxySettings{
		Mode:        "manual",
		IgnoreHosts: []string{"localhost", "*.internal.example", "127.0.0.0/8"},
		HTTP:        "127.0.0.1:32101",
		HTTPS:       "127.0.0.1:32102",
		SOCKS:       "127.0.0.1:32103",
	}
	got, err := resolveGNOMESystemProxySettings(mustSystemProxyURL(t, "https://github.com/repo"), settings)
	if err != nil {
		t.Fatalf("resolve GNOME proxy: %v", err)
	}
	if got == nil || got.String() != "http://127.0.0.1:32102" {
		t.Fatalf("expected configured HTTPS endpoint, got %v", got)
	}

	got, err = resolveGNOMESystemProxySettings(mustSystemProxyURL(t, "https://api.internal.example/data"), settings)
	if err != nil {
		t.Fatalf("resolve GNOME bypass: %v", err)
	}
	if got != nil {
		t.Fatalf("expected ignored host to connect directly, got %v", got)
	}
}

func TestGNOMESystemProxyUsesSameProxyAndSOCKSFallback(t *testing.T) {
	got, err := resolveGNOMESystemProxySettings(
		mustSystemProxyURL(t, "https://github.com/repo"),
		gnomeSystemProxySettings{Mode: "manual", UseSameProxy: true, HTTP: "localhost:34211"},
	)
	if err != nil {
		t.Fatalf("resolve same GNOME proxy: %v", err)
	}
	if got == nil || got.String() != "http://localhost:34211" {
		t.Fatalf("expected the shared HTTP proxy, got %v", got)
	}

	got, err = resolveGNOMESystemProxySettings(
		mustSystemProxyURL(t, "https://github.com/repo"),
		gnomeSystemProxySettings{Mode: "manual", SOCKS: "localhost:34212"},
	)
	if err != nil {
		t.Fatalf("resolve GNOME SOCKS proxy: %v", err)
	}
	if got == nil || got.String() != "socks5://localhost:34212" {
		t.Fatalf("expected the SOCKS proxy, got %v", got)
	}
}

func TestGNOMESystemProxyRejectsPAC(t *testing.T) {
	got, err := resolveGNOMESystemProxySettings(
		mustSystemProxyURL(t, "https://github.com/repo"),
		gnomeSystemProxySettings{Mode: "auto", AutoConfigURL: "https://proxy.example/config.pac"},
	)
	if got != nil {
		t.Fatalf("expected no proxy URL, got %v", got)
	}
	if err == nil || !strings.Contains(err.Error(), "PAC") {
		t.Fatalf("expected explicit PAC error, got %v", err)
	}
}

func TestKDESystemProxyFixtureSelectsSchemeAndBypass(t *testing.T) {
	settings, found, err := parseKDEProxySettings([]byte(`[General]
Unrelated=true

[Proxy Settings]
ProxyType=1
httpProxy=http://127.0.0.1 35601
httpsProxy=http://127.0.0.1 35602
socksProxy=socks://127.0.0.1 35603
NoProxyFor=localhost,*.corp.example,10.0.0.0/8
ReversedException=false
`))
	if err != nil {
		t.Fatalf("parse KDE fixture: %v", err)
	}
	if !found {
		t.Fatal("expected KDE proxy settings section")
	}
	got, err := resolveKDESystemProxySettings(mustSystemProxyURL(t, "https://github.com/repo"), settings, nil)
	if err != nil {
		t.Fatalf("resolve KDE proxy: %v", err)
	}
	if got == nil || got.String() != "http://127.0.0.1:35602" {
		t.Fatalf("expected configured HTTPS endpoint, got %v", got)
	}

	got, err = resolveKDESystemProxySettings(mustSystemProxyURL(t, "https://service.corp.example/data"), settings, nil)
	if err != nil {
		t.Fatalf("resolve KDE bypass: %v", err)
	}
	if got != nil {
		t.Fatalf("expected KDE NoProxyFor match to connect directly, got %v", got)
	}
}

func TestKDESystemProxyHonorsReversedException(t *testing.T) {
	settings := kdeSystemProxySettings{Values: map[string]string{
		"proxytype":         "1",
		"httpsproxy":        "http://127.0.0.1 36781",
		"noproxyfor":        "*.proxy-only.example",
		"reversedexception": "true",
	}}
	got, err := resolveKDESystemProxySettings(mustSystemProxyURL(t, "https://api.proxy-only.example"), settings, nil)
	if err != nil {
		t.Fatalf("resolve reversed match: %v", err)
	}
	if got == nil || got.String() != "http://127.0.0.1:36781" {
		t.Fatalf("expected matched host to use proxy, got %v", got)
	}

	got, err = resolveKDESystemProxySettings(mustSystemProxyURL(t, "https://github.com"), settings, nil)
	if err != nil {
		t.Fatalf("resolve reversed non-match: %v", err)
	}
	if got != nil {
		t.Fatalf("expected non-matching host to connect directly, got %v", got)
	}
}

func TestKDESystemProxyReadsConfiguredEnvironmentVariableNames(t *testing.T) {
	settings := kdeSystemProxySettings{Values: map[string]string{
		"proxytype":  "4",
		"httpsproxy": "GONAVI_TEST_KDE_HTTPS_PROXY",
		"noproxyfor": "GONAVI_TEST_KDE_NO_PROXY",
	}}
	values := map[string]string{
		"GONAVI_TEST_KDE_HTTPS_PROXY": "http://127.0.0.1:37891",
		"GONAVI_TEST_KDE_NO_PROXY":    "localhost",
	}
	got, err := resolveKDESystemProxySettings(
		mustSystemProxyURL(t, "https://github.com"),
		settings,
		func(key string) string { return values[key] },
	)
	if err != nil {
		t.Fatalf("resolve KDE environment proxy: %v", err)
	}
	if got == nil || got.String() != "http://127.0.0.1:37891" {
		t.Fatalf("expected proxy from configured environment variable, got %v", got)
	}
}

func TestKDESystemProxyRejectsPACAndWPAD(t *testing.T) {
	for _, proxyType := range []string{"2", "3"} {
		got, err := resolveKDESystemProxySettings(
			mustSystemProxyURL(t, "https://github.com"),
			kdeSystemProxySettings{Values: map[string]string{"proxytype": proxyType}},
			nil,
		)
		if got != nil {
			t.Fatalf("type %s: expected no proxy URL, got %v", proxyType, got)
		}
		if err == nil || (!strings.Contains(err.Error(), "PAC") && !strings.Contains(err.Error(), "WPAD")) {
			t.Fatalf("type %s: expected explicit auto proxy error, got %v", proxyType, err)
		}
	}
}

func TestSystemProxyAddressRequiresConfiguredPort(t *testing.T) {
	if got, err := parseSystemProxyAddress("proxy.example", false); err == nil || got != nil {
		t.Fatalf("expected a missing-port error, got URL=%v error=%v", got, err)
	}
	got, err := parseSystemProxyAddress("https://proxy.example:38901", false)
	if err != nil {
		t.Fatalf("parse HTTP CONNECT proxy: %v", err)
	}
	if got.String() != "http://proxy.example:38901" {
		t.Fatalf("expected HTTPS target proxy to use HTTP CONNECT URL, got %s", got)
	}
}

func TestParseGSettingsValues(t *testing.T) {
	values, err := parseGSettingsStringArray("@as ['localhost', '*.corp.example', 'it\\'s.internal']")
	if err != nil {
		t.Fatalf("parse GSettings array: %v", err)
	}
	want := []string{"localhost", "*.corp.example", "it's.internal"}
	if len(values) != len(want) {
		t.Fatalf("expected %d values, got %#v", len(want), values)
	}
	for index := range want {
		if values[index] != want[index] {
			t.Fatalf("value %d: expected %q, got %q", index, want[index], values[index])
		}
	}
	if port, err := parseGSettingsPort("uint32 40123"); err != nil || port != 40123 {
		t.Fatalf("expected GSettings port 40123, got %d (%v)", port, err)
	}
}

func mustSystemProxyURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse URL %q: %v", raw, err)
	}
	return parsed
}
