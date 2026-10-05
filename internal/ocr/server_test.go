package ocr

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func installedManager(t *testing.T) (*Manager, string) {
	t.Helper()
	var requests atomic.Int64
	source := serveBytes(t, fakeFiles, &requests, nil)
	root := filepath.Join(t.TempDir(), "ocr")
	manager := NewManager(root, componentFor("v1", fakeFiles, source.URL), nil)
	if err := manager.Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)
	return manager, root
}

func get(t *testing.T, method, target string, header map[string]string) (*http.Response, string) {
	t.Helper()
	request, err := http.NewRequest(method, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range header {
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response, string(body)
}

func TestTheServerHandsOutTheComponentsFilesToTheWebView(t *testing.T) {
	manager, _ := installedManager(t)
	base, err := manager.Serve()
	if err != nil {
		t.Fatal(err)
	}
	again, _ := manager.Serve()
	if again != base {
		t.Fatalf("serving twice must not start a second server: %s vs %s", base, again)
	}
	if !strings.HasPrefix(base, "http://127.0.0.1:") {
		t.Fatalf("only the loopback interface may be used: %s", base)
	}

	response, body := get(t, http.MethodGet, base+"/core/engine.wasm.js", nil)
	if response.StatusCode != http.StatusOK || body != fakeFiles["core/engine.wasm.js"] {
		t.Fatalf("status %d, body %d bytes", response.StatusCode, len(body))
	}
	if response.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("headers = %v", response.Header)
	}
	// Language data is gzip the worker unpacks itself: it must not be marked or decoded as anything else.
	response, body = get(t, http.MethodGet, base+"/lang/eng.traineddata.gz", nil)
	if response.Header.Get("Content-Type") != "application/octet-stream" || response.Header.Get("Content-Encoding") != "" || body != fakeFiles["lang/eng.traineddata.gz"] {
		t.Fatalf("language data headers = %v", response.Header)
	}
	if response, body = get(t, http.MethodHead, base+"/worker.min.js", nil); response.StatusCode != http.StatusOK || body != "" || response.ContentLength != int64(len(fakeFiles["worker.min.js"])) {
		t.Fatalf("HEAD: status %d body %q length %d", response.StatusCode, body, response.ContentLength)
	}
	if response, body = get(t, http.MethodGet, base+"/worker.min.js", map[string]string{"Range": "bytes=0-5"}); response.StatusCode != http.StatusPartialContent || body != "worker" {
		t.Fatalf("range: status %d body %q", response.StatusCode, body)
	}
	if response, _ = get(t, http.MethodOptions, base+"/worker.min.js", nil); response.StatusCode != http.StatusNoContent || response.Header.Get("Access-Control-Allow-Methods") == "" {
		t.Fatalf("preflight: %d %v", response.StatusCode, response.Header)
	}
}

func TestTheServerRefusesAnythingElse(t *testing.T) {
	manager, root := installedManager(t)
	base, _ := manager.Serve()
	parsed, _ := url.Parse(base)
	token := strings.TrimPrefix(parsed.Path, "/")
	origin := "http://" + parsed.Host

	for name, tc := range map[string]struct {
		method, target string
		want           int
	}{
		"no token":                   {http.MethodGet, origin + "/worker.min.js", http.StatusNotFound},
		"wrong token":                {http.MethodGet, origin + "/" + strings.Repeat("0", len(token)) + "/worker.min.js", http.StatusNotFound},
		"unknown file":               {http.MethodGet, base + "/lang/other.traineddata.gz", http.StatusNotFound},
		"the manifest is not served": {http.MethodGet, base + "/component.json", http.StatusNotFound},
		"directory":                  {http.MethodGet, base + "/core/", http.StatusNotFound},
		"root":                       {http.MethodGet, base + "/", http.StatusNotFound},
		"post":                       {http.MethodPost, base + "/worker.min.js", http.StatusMethodNotAllowed},
		"delete":                     {http.MethodDelete, base + "/worker.min.js", http.StatusMethodNotAllowed},
	} {
		if response, _ := get(t, tc.method, tc.target, nil); response.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d", name, response.StatusCode, tc.want)
		}
	}

	// A path that climbs out of the component never reaches the file system.
	request, _ := http.NewRequest(http.MethodGet, base+"/worker.min.js", nil)
	for _, climb := range []string{"/../current/component.json", "/%2e%2e/component.json", "/core/../../ocr/current/component.json"} {
		request.URL.Path = "/" + token + climb
		request.URL.RawPath = ""
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status %d", climb, response.StatusCode)
		}
	}

	// Another host name (DNS rebinding) is refused even with the right token.
	request, _ = http.NewRequest(http.MethodGet, base+"/worker.min.js", nil)
	request.Host = "attacker.example"
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign host: status %d", response.StatusCode)
	}

	// A file that no longer matches what was installed is not served.
	if err := os.WriteFile(filepath.Join(root, currentDir, "worker.min.js"), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if response, _ := get(t, http.MethodGet, base+"/worker.min.js", nil); response.StatusCode != http.StatusNotFound {
		t.Fatalf("tampered file: status %d", response.StatusCode)
	}
}

func TestServingNeedsTheInstalledComponentAndStopsOnClose(t *testing.T) {
	var requests atomic.Int64
	source := serveBytes(t, fakeFiles, &requests, nil)
	manager := NewManager(filepath.Join(t.TempDir(), "ocr"), componentFor("v1", fakeFiles, source.URL), nil)
	if _, err := manager.Serve(); err == nil {
		t.Fatal("nothing to serve before the install")
	}
	if err := manager.Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	base, err := manager.Serve()
	if err != nil {
		t.Fatal(err)
	}
	manager.Close()
	if _, err := http.Get(base + "/worker.min.js"); err == nil {
		t.Fatal("the server must be gone after Close")
	}
	// Closing leaves the files, and serving again works (on a new address).
	if !manager.Status().Installed {
		t.Fatal("close must not uninstall")
	}
	if _, err := manager.Serve(); err != nil {
		t.Fatalf("serve again: %v", err)
	}
	manager.Close()
}

func TestReinstallingWhileServedReplacesFilesTheServerHadOpen(t *testing.T) {
	var requests atomic.Int64
	next := map[string]string{}
	for path, body := range fakeFiles {
		next[path] = body + "-next"
	}
	v1 := serveBytes(t, fakeFiles, &requests, nil)
	v2 := serveBytes(t, next, &requests, nil)
	root := filepath.Join(t.TempDir(), "ocr")
	first := NewManager(root, componentFor("v1", fakeFiles, v1.URL), nil)
	if err := first.Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	base, _ := first.Serve()
	if response, _ := get(t, http.MethodGet, base+"/worker.min.js", nil); response.StatusCode != http.StatusOK {
		t.Fatal("serving before the upgrade failed")
	}
	// The same manager upgrades itself: it must let go of the directory it serves before swapping it.
	first.component = componentFor("v2", next, v2.URL)
	if err := first.Install(context.Background(), nil); err != nil {
		t.Fatalf("upgrade while serving: %v", err)
	}
	newBase, err := first.Serve()
	if err != nil {
		t.Fatal(err)
	}
	if _, body := get(t, http.MethodGet, newBase+"/worker.min.js", nil); body != next["worker.min.js"] {
		t.Fatal("the new files are not what is served")
	}
	first.Close()
}
