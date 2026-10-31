package nativewindow

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"GoNavi-Wails/internal/plugin"
)

type pluginRuntimeFake struct {
	mu          sync.Mutex
	statuses    []plugin.Status
	root        string
	assets      []string
	beforeAsset func()
	invoke      func(context.Context, string, uint64, string, json.RawMessage) (json.RawMessage, error)
}

func (f *pluginRuntimeFake) List() []plugin.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]plugin.Status(nil), f.statuses...)
}
func (f *pluginRuntimeFake) AssetPath(id, relative string) (string, error) {
	if f.beforeAsset != nil {
		f.beforeAsset()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.assets = append(f.assets, id+":"+relative)
	if !validPluginAssetName(relative) {
		return "", errors.New("invalid asset")
	}
	return filepath.Join(f.root, filepath.FromSlash(relative)), nil
}
func (f *pluginRuntimeFake) InvokeGeneration(ctx context.Context, id string, generation uint64, command string, args json.RawMessage) (json.RawMessage, error) {
	f.mu.Lock()
	invoke := f.invoke
	active := false
	for _, status := range f.statuses {
		if status.Manifest.ID == id && status.Generation == generation && status.DesiredEnabled {
			active = true
		}
	}
	f.mu.Unlock()
	if !active {
		return nil, errors.New("stale generation")
	}
	if invoke != nil {
		return invoke(ctx, id, generation, command, args)
	}
	return json.RawMessage(`{"ok":true}`), nil
}

type pluginProcessFake struct {
	done  chan struct{}
	once  sync.Once
	kills atomic.Int32
}

func newPluginProcessFake() *pluginProcessFake { return &pluginProcessFake{done: make(chan struct{})} }
func (*pluginProcessFake) PID() int            { return 12345 }
func (p *pluginProcessFake) Wait() error       { <-p.done; return nil }
func (p *pluginProcessFake) Kill() error {
	p.kills.Add(1)
	p.once.Do(func() { close(p.done) })
	return nil
}
func (p *pluginProcessFake) exit() { p.once.Do(func() { close(p.done) }) }

func newPluginTestController(t *testing.T) (*PluginController, *pluginRuntimeFake) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<!doctype html><html><head></head><body>fixture</body></html>"), 0600); err != nil {
		t.Fatal(err)
	}
	runtime := &pluginRuntimeFake{root: root, statuses: []plugin.Status{{Manifest: plugin.Manifest{ID: "test.one", Name: "Fixture", Window: &plugin.Window{Entry: "index.html"}}, State: "running", DesiredEnabled: true, Generation: 1}}}
	controller, err := newPluginController(runtime, PluginControllerOptions{Assets: fstest.MapFS{
		"runtime.js":   &fstest.MapFile{Data: []byte("window.fixture = true;")},
		"ui/index.js":  &fstest.MapFile{Data: []byte("export const fixture = true;")},
		"ui/style.css": &fstest.MapFile{Data: []byte(".gonavi-plugin-root{color:red}")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	controller.stopTimeout = 30 * time.Millisecond
	controller.checkInterval = 10 * time.Millisecond
	controller.startProcess = func(pluginProcessSpec) (pluginProcess, error) { return newPluginProcessFake(), nil }
	if err := controller.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := controller.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return controller, runtime
}

func openPluginTestWindow(t *testing.T, c *PluginController, id string) *pluginWindowEntry {
	t.Helper()
	_, err := c.Open(context.Background(), id, id, nil, "zh-CN", "dark")
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	entry := c.windows[id]
	c.mu.Unlock()
	return entry
}

func pluginTestRequest(c *PluginController, entry *pluginWindowEntry, method, path, body string) *http.Request {
	request := httptest.NewRequest(method, c.endpoint+path, strings.NewReader(body))
	request.Header.Set(pluginTokenHeader, entry.token)
	request.Header.Set(pluginWindowHeader, entry.info.ID)
	request.Header.Set("Content-Type", "application/json")
	return request
}

func servePluginTest(c *PluginController, entry *pluginWindowEntry, method, path, body string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	c.serveHTTP(response, pluginTestRequest(c, entry, method, path, body))
	return response
}

func awaitPluginDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("plugin process was not reaped")
	}
}
