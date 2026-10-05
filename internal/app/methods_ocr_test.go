package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/ocr"
	"GoNavi-Wails/internal/uievents"
)

var ocrTestFiles = map[string]string{
	"worker.min.js":           strings.Repeat("worker;", 100),
	"core/engine.wasm.js":     strings.Repeat("engine;", 100),
	"lang/eng.traineddata.gz": strings.Repeat("english;", 100),
}

// useOCRSource points the installer at a local server for the duration of a test.
func useOCRSource(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	component := ocr.Component{Version: "test", Languages: []string{"eng"}}
	for _, path := range []string{"worker.min.js", "core/engine.wasm.js", "lang/eng.traineddata.gz"} {
		sum := sha256.Sum256([]byte(ocrTestFiles[path]))
		component.Files = append(component.Files, ocr.File{
			Path: path, Size: int64(len(ocrTestFiles[path])), SHA256: hex.EncodeToString(sum[:]), URLs: []string{server.URL + "/" + path},
		})
	}
	previousSource, previousClient := ocrComponentSource, ocrHTTPClient
	ocrComponentSource = func() ocr.Component { return component }
	ocrHTTPClient = func() *http.Client { return &http.Client{} }
	ocrManagers.Lock()
	ocrManagers.byRoot = map[string]*ocr.Manager{}
	ocrManagers.Unlock()
	t.Cleanup(func() {
		ocrManagers.Lock()
		for _, manager := range ocrManagers.byRoot {
			manager.Close()
		}
		ocrManagers.byRoot = map[string]*ocr.Manager{}
		ocrManagers.Unlock()
		ocrComponentSource, ocrHTTPClient = previousSource, previousClient
	})
	return server
}

func serveOCRFiles(w http.ResponseWriter, r *http.Request) {
	if body, ok := ocrTestFiles[strings.TrimPrefix(r.URL.Path, "/")]; ok {
		_, _ = w.Write([]byte(body))
		return
	}
	http.NotFound(w, r)
}

func newOCRTestApp(t *testing.T) *App {
	t.Helper()
	return &App{configDir: t.TempDir()}
}

func ocrData(t *testing.T, data any) ocrStatusData {
	t.Helper()
	status, ok := data.(ocrStatusData)
	if !ok {
		t.Fatalf("data = %#v", data)
	}
	return status
}

type recordingEmitter struct {
	mu     sync.Mutex
	events []ocrInstallProgressPayload
}

func (r *recordingEmitter) Emit(name string, args ...any) {
	if name != ocrInstallProgressEvent || len(args) != 1 {
		return
	}
	if payload, ok := args[0].(ocrInstallProgressPayload); ok {
		r.mu.Lock()
		r.events = append(r.events, payload)
		r.mu.Unlock()
	}
}

func TestOCRComponentLifecycleThroughTheBindings(t *testing.T) {
	useOCRSource(t, serveOCRFiles)
	app := newOCRTestApp(t)
	recorder := &recordingEmitter{}
	app.ctx = uievents.WithEmitter(context.Background(), recorder)

	status := app.OCRGetStatus()
	if !status.Success || ocrData(t, status.Data).Installed || ocrData(t, status.Data).Version != "test" {
		t.Fatalf("status before install = %+v", status)
	}
	if want := filepath.Join(ConfigDirForIntegration(app), "ocr", "current"); ocrData(t, status.Data).Path != want {
		t.Fatalf("path = %q, want %q", ocrData(t, status.Data).Path, want)
	}
	if result := app.OCRServe(); result.Success || strings.HasPrefix(result.Message, "ocr_component.") || result.Message == "" {
		t.Fatalf("serving before install must fail with a localized message: %+v", result)
	}

	installed := app.OCRInstall()
	if !installed.Success || !ocrData(t, installed.Data).Installed || strings.HasPrefix(installed.Message, "ocr_component.") {
		t.Fatalf("install = %+v", installed)
	}
	recorder.mu.Lock()
	events := append([]ocrInstallProgressPayload(nil), recorder.events...)
	recorder.mu.Unlock()
	if len(events) == 0 || events[len(events)-1].Phase != ocr.PhaseDone || events[len(events)-1].Percent != 100 {
		t.Fatalf("progress events = %+v", events)
	}

	served := app.OCRServe()
	data, ok := served.Data.(map[string]any)
	if !served.Success || !ok || !strings.HasPrefix(data["baseUrl"].(string), "http://127.0.0.1:") || data["languages"].([]string)[0] != "eng" {
		t.Fatalf("serve = %+v", served)
	}
	response, err := http.Get(data["baseUrl"].(string) + "/worker.min.js")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if string(body) != ocrTestFiles["worker.min.js"] {
		t.Fatalf("served %d bytes", len(body))
	}

	removed := app.OCRRemove()
	if !removed.Success || ocrData(t, removed.Data).Installed {
		t.Fatalf("remove = %+v", removed)
	}
	if _, err := os.Stat(filepath.Join(ConfigDirForIntegration(app), "ocr", "current")); !os.IsNotExist(err) {
		t.Fatal("the files must be gone")
	}
	if result := app.OCRServe(); result.Success {
		t.Fatal("nothing to serve after removal")
	}
}

func TestOCRInstallFailureIsReportedWithoutTheDownloadAddress(t *testing.T) {
	server := useOCRSource(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) })
	app := newOCRTestApp(t)
	result := app.OCRInstall()
	if result.Success || ocrData(t, result.Data).Installed {
		t.Fatalf("result = %+v", result)
	}
	if strings.Contains(result.Message, server.URL) || strings.HasPrefix(result.Message, "ocr_component.") || !strings.Contains(result.Message, "502") {
		t.Fatalf("message = %q", result.Message)
	}
}

func TestOCRCancelStopsARunningInstall(t *testing.T) {
	started := make(chan struct{}, 4)
	useOCRSource(t, func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		<-r.Context().Done()
	})
	app := newOCRTestApp(t)
	done := make(chan struct{})
	var result struct{ success, canceled bool }
	go func() {
		defer close(done)
		installed := app.OCRInstall()
		result.success = installed.Success
		if status, ok := installed.Data.(ocrStatusData); ok {
			result.canceled = status.Canceled
		}
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the download never started")
	}
	if second := app.OCRInstall(); second.Success || !ocrData(t, second.Data).Installing {
		t.Fatalf("a second install while one runs: %+v", second)
	}
	if !app.OCRCancelInstall().Success {
		t.Fatal("cancel must succeed")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not end the install")
	}
	if result.success || ocrData(t, app.OCRGetStatus().Data).Installed {
		t.Fatal("a canceled install installs nothing")
	}
	if !result.canceled {
		t.Fatal("a canceled install must say so, so it is not shown as a failure")
	}
}

func TestOCRIsRefusedWhereItCannotWork(t *testing.T) {
	useOCRSource(t, serveOCRFiles)
	dir := t.TempDir()
	web := &App{configDir: dir, webRuntime: true}
	noDir := &App{}
	for name, call := range map[string]func(*App) string{
		"status":  func(a *App) string { return a.OCRGetStatus().Message },
		"install": func(a *App) string { return a.OCRInstall().Message },
		"cancel":  func(a *App) string { return a.OCRCancelInstall().Message },
		"remove":  func(a *App) string { return a.OCRRemove().Message },
		"serve":   func(a *App) string { return a.OCRServe().Message },
	} {
		if message := call(web); message == "" || strings.HasPrefix(message, "ocr_component.") {
			t.Errorf("%s in the web runtime: %q", name, message)
		}
		if message := call(noDir); message == "" || strings.HasPrefix(message, "ocr_component.") {
			t.Errorf("%s without a data directory: %q", name, message)
		}
	}
	if web.OCRInstall().Success || noDir.OCRInstall().Success {
		t.Fatal("must not install")
	}
	if _, err := os.Stat(filepath.Join(dir, "ocr")); !os.IsNotExist(err) {
		t.Fatal("the web runtime must not touch the disk")
	}
}
