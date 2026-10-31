package nativewindow

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginAssetsUseManagerResolverAndInjectStandaloneRuntime(t *testing.T) {
	c, runtime := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	response := servePluginTest(c, entry, http.MethodGet, pluginAssetPrefix+"index.html", "")
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	html := response.Body.String()
	if !strings.Contains(html, pluginBridgePrefix+"runtime.js") || strings.Contains(html, "window.go.") || strings.Contains(html, entry.token) {
		t.Fatal("unsafe runtime injection")
	}
	if !strings.Contains(response.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
		t.Fatal("missing CSP")
	}
	runtime.mu.Lock()
	assets := append([]string(nil), runtime.assets...)
	runtime.mu.Unlock()
	if len(assets) < 2 || assets[len(assets)-1] != "test.one:index.html" {
		t.Fatal("asset bypassed manager resolver")
	}
}

func TestPluginAssetsRejectTraversalAndExecutable(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	cases := []struct {
		path   string
		status int
	}{
		{pluginAssetPrefix + "../secret.html", 400}, {pluginAssetPrefix + "%2e%2e/secret.html", 400},
		{pluginAssetPrefix + "C:/secret.html", 400}, {pluginAssetPrefix + "bin.exe", 403},
		{pluginAssetPrefix + "missing.html", 404},
	}
	for _, test := range cases {
		t.Run(test.path, func(t *testing.T) {
			response := servePluginTest(c, entry, http.MethodGet, test.path, "")
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d", response.Code, test.status)
			}
		})
	}
}

func TestPluginRuntimeInjectionPrecedesPluginScripts(t *testing.T) {
	for _, html := range []string{
		"<!doctype html><html><head data-x='y'><script>plugin()</script></head></html>",
		"<HEAD><script>plugin()</script></HEAD>", "<script>plugin()</script>",
		`<!doctype html><!-- <head> --><head data-value="a>b"><script>plugin()</script></head>`,
		"<!doctype html><html><script>plugin()</script><head></head></html>",
	} {
		result := string(injectPluginRuntime([]byte(html)))
		if strings.Index(result, "runtime.js") > strings.Index(result, "plugin()") {
			t.Fatal("plugin executes before heartbeat bootstrap")
		}
	}
}

func TestPluginAssetNamesAndLimits(t *testing.T) {
	for _, name := range []string{"../a", "/a", "a\\b", "a:b", "a%2fb", ".", "a/../b", "a?b"} {
		if validPluginAssetName(name) {
			t.Fatalf("unsafe name accepted: %q", name)
		}
	}
	for _, name := range []string{"index.html", "ui/main.mjs", "assets/font.woff2"} {
		if !validPluginAssetName(name) {
			t.Fatalf("valid name rejected: %q", name)
		}
	}
	if _, err := readPluginBytes(strings.NewReader("12345"), 4); err == nil {
		t.Fatal("payload limit ignored")
	}
	if got, err := readPluginBytes(strings.NewReader("1234"), 4); err != nil || string(got) != "1234" {
		t.Fatal("exact payload limit rejected")
	}
}

func TestPluginAssetsHaveNoFixedMegabyteCap(t *testing.T) {
	c, runtime := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	payload := bytes.Repeat([]byte("x"), (9<<20)+17)
	if err := os.WriteFile(filepath.Join(runtime.root, "large.js"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	response := servePluginTest(c, entry, http.MethodGet, pluginAssetPrefix+"large.js", "")
	if response.Code != http.StatusOK || response.Body.Len() != len(payload) {
		t.Fatalf("large asset status=%d bytes=%d want=%d", response.Code, response.Body.Len(), len(payload))
	}
}
