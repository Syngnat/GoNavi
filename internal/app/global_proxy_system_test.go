package app

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/net/http/httpproxy"
)

func TestDefaultHTTPProxyFuncPrefersEnvironmentProxy(t *testing.T) {
	environmentProxy, err := url.Parse("http://environment-proxy.example:8080")
	if err != nil {
		t.Fatalf("parse environment proxy: %v", err)
	}
	systemCalls := 0
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{HTTPSProxy: environmentProxy.String()},
		"",
		func(*url.URL) (*url.URL, error) {
			systemCalls++
			return url.Parse("socks5://system-proxy.example:1080")
		},
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if err != nil {
		t.Fatalf("resolve proxy: %v", err)
	}
	if got == nil || got.String() != environmentProxy.String() {
		t.Fatalf("expected environment proxy %q, got %v", environmentProxy, got)
	}
	if systemCalls != 0 {
		t.Fatalf("expected system proxy resolver not to run, got %d calls", systemCalls)
	}
}

func TestDefaultHTTPProxyFuncTreatsEnvironmentNoProxyAsFinal(t *testing.T) {
	systemCalls := 0
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{
			HTTPSProxy: "http://environment-proxy.example:8080",
			NoProxy:    "github.com",
		},
		"",
		func(*url.URL) (*url.URL, error) {
			systemCalls++
			return url.Parse("socks5://system-proxy.example:1080")
		},
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if err != nil {
		t.Fatalf("resolve proxy: %v", err)
	}
	if got != nil {
		t.Fatalf("expected NO_PROXY to select a direct connection, got %v", got)
	}
	if systemCalls != 0 {
		t.Fatalf("NO_PROXY must not fall through to the system proxy, got %d calls", systemCalls)
	}
}

func TestDefaultHTTPProxyFuncTreatsNoProxyOnlyMatchAsFinal(t *testing.T) {
	systemCalls := 0
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{NoProxy: "github.com"},
		"",
		func(*url.URL) (*url.URL, error) {
			systemCalls++
			return url.Parse("socks5://system-proxy.example:1080")
		},
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if err != nil {
		t.Fatalf("resolve proxy: %v", err)
	}
	if got != nil {
		t.Fatalf("expected NO_PROXY-only match to select a direct connection, got %v", got)
	}
	if systemCalls != 0 {
		t.Fatalf("NO_PROXY-only match must not fall through to the system proxy, got %d calls", systemCalls)
	}
}

func TestDefaultHTTPProxyFuncUsesSystemProxyWhenNoProxyOnlyDoesNotMatch(t *testing.T) {
	systemProxy, err := url.Parse("socks5://system-proxy.example:1080")
	if err != nil {
		t.Fatalf("parse system proxy: %v", err)
	}
	systemCalls := 0
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{NoProxy: "internal.example"},
		"",
		func(*url.URL) (*url.URL, error) {
			systemCalls++
			return systemProxy, nil
		},
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if err != nil {
		t.Fatalf("resolve proxy: %v", err)
	}
	if got == nil || got.String() != systemProxy.String() {
		t.Fatalf("expected non-matching NO_PROXY-only policy to use %q, got %v", systemProxy, got)
	}
	if systemCalls != 1 {
		t.Fatalf("expected one system proxy lookup, got %d", systemCalls)
	}
}

func TestDefaultHTTPProxyFuncTreatsEnvironmentProxySetAsCompletePolicy(t *testing.T) {
	systemCalls := 0
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{HTTPProxy: "http://http-only.example:8080"},
		"",
		func(*url.URL) (*url.URL, error) {
			systemCalls++
			return url.Parse("socks5://system-proxy.example:1080")
		},
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if err != nil {
		t.Fatalf("resolve proxy: %v", err)
	}
	if got != nil {
		t.Fatalf("expected HTTP_PROXY-only environment policy to leave HTTPS direct, got %v", got)
	}
	if systemCalls != 0 {
		t.Fatalf("environment proxy policy must not mix with the system proxy, got %d calls", systemCalls)
	}
}

func TestDefaultHTTPProxyFuncUsesSystemProxyWithoutEnvironmentPolicy(t *testing.T) {
	systemProxy, err := url.Parse("socks5://system-proxy.example:1080")
	if err != nil {
		t.Fatalf("parse system proxy: %v", err)
	}
	systemCalls := 0
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{},
		"",
		func(target *url.URL) (*url.URL, error) {
			systemCalls++
			if target.String() != "https://github.com/Syngnat/GoNavi" {
				t.Fatalf("unexpected system proxy target: %s", target)
			}
			return systemProxy, nil
		},
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if err != nil {
		t.Fatalf("resolve proxy: %v", err)
	}
	if got == nil || got.String() != systemProxy.String() {
		t.Fatalf("expected system proxy %q, got %v", systemProxy, got)
	}
	if systemCalls != 1 {
		t.Fatalf("expected one system proxy lookup, got %d", systemCalls)
	}
}

func TestDefaultHTTPProxyFuncPropagatesSystemProxyError(t *testing.T) {
	wantErr := errors.New("PAC is unsupported")
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{},
		"",
		func(*url.URL) (*url.URL, error) { return nil, wantErr },
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if got != nil {
		t.Fatalf("expected no proxy URL on error, got %v", got)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected error %v, got %v", wantErr, err)
	}
}

func TestDefaultHTTPProxyFuncUsesAllProxyAsEnvironmentFallback(t *testing.T) {
	for _, proxyText := range []string{
		"http://127.0.0.1:21001",
		"https://127.0.0.1:21002",
		"socks5://127.0.0.1:21003",
		"socks5h://127.0.0.1:21004",
	} {
		t.Run(proxyText, func(t *testing.T) {
			systemCalls := 0
			proxyFunc := newDefaultHTTPProxyFunc(
				&httpproxy.Config{},
				proxyText,
				func(*url.URL) (*url.URL, error) {
					systemCalls++
					return url.Parse("http://system-proxy.example:8080")
				},
			)

			got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
			if err != nil {
				t.Fatalf("resolve ALL_PROXY: %v", err)
			}
			if got == nil || got.String() != proxyText {
				t.Fatalf("expected ALL_PROXY %q, got %v", proxyText, got)
			}
			if systemCalls != 0 {
				t.Fatalf("ALL_PROXY must take precedence over the system proxy, got %d system calls", systemCalls)
			}
		})
	}
}

func TestDefaultHTTPProxyFuncReadsUpperAndLowerAllProxyEnvironment(t *testing.T) {
	for _, environmentName := range []string{"ALL_PROXY", "all_proxy"} {
		t.Run(environmentName, func(t *testing.T) {
			for _, name := range []string{
				"HTTP_PROXY", "http_proxy",
				"HTTPS_PROXY", "https_proxy",
				"ALL_PROXY", "all_proxy",
				"NO_PROXY", "no_proxy",
			} {
				t.Setenv(name, "")
			}
			t.Setenv(environmentName, "socks5://127.0.0.1:22080")

			got, err := defaultHTTPProxyFunc()(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
			if err != nil {
				t.Fatalf("resolve %s: %v", environmentName, err)
			}
			if got == nil || got.String() != "socks5://127.0.0.1:22080" {
				t.Fatalf("expected %s endpoint, got %v", environmentName, got)
			}
		})
	}
}

func TestDefaultHTTPProxyFuncPrefersSchemeProxyAndHonorsNoProxyBeforeAllProxy(t *testing.T) {
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{
			HTTPSProxy: "http://https-proxy.example:8080",
			NoProxy:    "internal.example",
		},
		"socks5://all-proxy.example:1080",
		nil,
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if err != nil {
		t.Fatalf("resolve scheme proxy: %v", err)
	}
	if got == nil || got.String() != "http://https-proxy.example:8080" {
		t.Fatalf("expected HTTPS_PROXY to win over ALL_PROXY, got %v", got)
	}

	got, err = proxyFunc(mustProxyRequest(t, "http://driver-assets.example/archive.zip"))
	if err != nil {
		t.Fatalf("resolve ALL_PROXY fallback for HTTP: %v", err)
	}
	if got == nil || got.String() != "socks5://all-proxy.example:1080" {
		t.Fatalf("expected ALL_PROXY when the request has no scheme-specific proxy, got %v", got)
	}

	got, err = proxyFunc(mustProxyRequest(t, "https://api.internal.example/data"))
	if err != nil {
		t.Fatalf("resolve NO_PROXY: %v", err)
	}
	if got != nil {
		t.Fatalf("expected NO_PROXY to remain a final bypass, got %v", got)
	}
}

func TestDefaultHTTPProxyFuncRejectsUnsupportedAllProxySchemeWithoutSystemFallback(t *testing.T) {
	systemCalls := 0
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{},
		"socks4://127.0.0.1:1080",
		func(*url.URL) (*url.URL, error) {
			systemCalls++
			return url.Parse("http://system-proxy.example:8080")
		},
	)

	got, err := proxyFunc(mustProxyRequest(t, "https://github.com/Syngnat/GoNavi"))
	if got != nil {
		t.Fatalf("expected no proxy URL for unsupported ALL_PROXY, got %v", got)
	}
	if err == nil || !strings.Contains(err.Error(), "unsupported ALL_PROXY scheme") {
		t.Fatalf("expected unsupported scheme error, got %v", err)
	}
	if systemCalls != 0 {
		t.Fatalf("invalid ALL_PROXY must not silently fall back to the system proxy, got %d calls", systemCalls)
	}
}

func TestDefaultHTTPProxyFuncDoesNotUseAllProxyAfterCGIHTTPProxyRejection(t *testing.T) {
	proxyFunc := newDefaultHTTPProxyFunc(
		&httpproxy.Config{
			HTTPProxy: "http://untrusted-client.example:8080",
			CGI:       true,
		},
		"socks5://all-proxy.example:1080",
		nil,
	)

	got, err := proxyFunc(mustProxyRequest(t, "http://driver-assets.example/archive.zip"))
	if got != nil {
		t.Fatalf("expected no proxy after CGI HTTP_PROXY rejection, got %v", got)
	}
	if err == nil || !strings.Contains(err.Error(), "refusing to use HTTP_PROXY") {
		t.Fatalf("expected the httpproxy CGI safety error, got %v", err)
	}
}

func TestProxyEnvironmentValuePrefersUppercaseAndFallsBackToLowercase(t *testing.T) {
	t.Setenv("GONAVI_TEST_UPPER_PROXY", "socks5://upper.example:1080")
	t.Setenv("GONAVI_TEST_LOWER_PROXY", "socks5://lower.example:1080")
	if got := proxyEnvironmentValue("GONAVI_TEST_UPPER_PROXY", "GONAVI_TEST_LOWER_PROXY"); got != "socks5://upper.example:1080" {
		t.Fatalf("expected uppercase-style value first, got %q", got)
	}

	t.Setenv("GONAVI_TEST_UPPER_PROXY", "")
	if got := proxyEnvironmentValue("GONAVI_TEST_UPPER_PROXY", "GONAVI_TEST_LOWER_PROXY"); got != "socks5://lower.example:1080" {
		t.Fatalf("expected lowercase-style fallback, got %q", got)
	}
}

func mustProxyRequest(t *testing.T, rawURL string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	return req
}
