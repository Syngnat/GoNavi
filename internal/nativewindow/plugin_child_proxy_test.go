package nativewindow

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 模拟宿主 asset 服务：/ → 307 到 /plugin-assets/frontend/index.html，
// 其余 /plugin-assets/ 返回包内文件（与真实宿主路由一致）。
func fakeHostAssetServer(t *testing.T, pkgRoot string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/":
			http.Redirect(w, r, pluginAssetPrefix+"frontend/index.html", http.StatusTemporaryRedirect)
		case strings.HasPrefix(r.URL.Path, pluginAssetPrefix):
			rel := strings.TrimPrefix(r.URL.Path, pluginAssetPrefix)
			data, err := os.ReadFile(filepath.Join(pkgRoot, filepath.FromSlash(rel)))
			if err != nil {
				http.NotFound(w, r)
				return
			}
			switch strings.ToLower(filepath.Ext(rel)) {
			case ".html":
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
			case ".js":
				w.Header().Set("Content-Type", "text/javascript")
			case ".css":
				w.Header().Set("Content-Type", "text/css")
			}
			_, _ = w.Write(data)
		default:
			http.NotFound(w, r)
		}
	}))
}

// 子进程代理全链路：跟随 307、注入 host prefs、放行 assets 请求。
func TestPluginChildProxyServesPackageFixture(t *testing.T) {
	pkgRoot := t.TempDir()
	before := `<!doctype html><!-- <head>fake</head> 界🙂 --><html><head data-note=">">`
	assets := map[string]string{
		"frontend/index.html":     before + `<script src="assets/app.js"></script><link rel="stylesheet" href="assets/app.css"></head><body>fixture</body></html>`,
		"frontend/assets/app.js":  "window.fixtureLoaded=true;",
		"frontend/assets/app.css": "body{color:red}",
	}
	for name, body := range assets {
		path := filepath.Join(pkgRoot, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	upstream := fakeHostAssetServer(t, pkgRoot)
	defer upstream.Close()

	cfg := pluginChildOptions{
		endpoint: upstream.URL, token: strings.Repeat("a", 43), id: strings.Repeat("b", 43),
		profile: "gonavi-plugin-window-test", parentPID: 1, title: "t", width: 800, height: 600,
		locale: "zh-CN", theme: "dark",
	}
	handler := newPluginChildProxy(cfg, http.DefaultTransport)

	// 1) "/" 会被上游 307；客户端跟随到 entry HTML。
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("/ must redirect, got %d", rec.Code)
	}
	location := rec.Header().Get("Location")
	if location != pluginAssetPrefix+"frontend/index.html" {
		t.Fatalf("redirect location %q", location)
	}

	// 2) 请求 entry HTML：应注入 gonaviHostPrefs 且可解析。
	req = httptest.NewRequest(http.MethodGet, location, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("entry html status %d body %q", rec.Code, rec.Body.String())
	}
	body, _ := io.ReadAll(rec.Body)
	if !strings.HasPrefix(string(body), before+"<script>if(!window.gonaviHostPrefs)window.gonaviHostPrefs=") {
		t.Fatalf("entry html injection at wrong byte position: %q", body)
	}
	if rec.Header().Get("Transfer-Encoding") != "" {
		t.Fatal("proxy set a transfer encoding")
	}
	var injected map[string]string
	idx := strings.Index(string(body), "window.gonaviHostPrefs=")
	if idx < 0 {
		t.Fatal("injection marker not found")
	}
	jsonEnd := strings.Index(string(body)[idx:], ";")
	jsonText := strings.TrimPrefix(string(body)[idx:idx+jsonEnd], "window.gonaviHostPrefs=")
	if err := json.Unmarshal([]byte(jsonText), &injected); err != nil {
		t.Fatalf("injected prefs not valid JSON: %v (%q)", err, jsonText)
	}
	if injected["theme"] != "dark" || injected["locale"] != "zh-CN" {
		t.Fatalf("injected prefs wrong: %v", injected)
	}

	// 3) 夹具中的 JS/CSS 必须原样通过代理，不允许缺失资产静默跳过。
	for _, name := range []string{"frontend/assets/app.js", "frontend/assets/app.css"} {
		req = httptest.NewRequest(http.MethodGet, pluginAssetPrefix+name, nil)
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || rec.Body.String() != assets[name] {
			t.Fatalf("asset %s status=%d body=%q", name, rec.Code, rec.Body.String())
		}
	}

	// 4) 未授权路径被本地 404。
	req = httptest.NewRequest(http.MethodGet, "/etc/passwd", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unauthorized path must 404, got %d", rec.Code)
	}
}
