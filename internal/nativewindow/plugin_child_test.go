package nativewindow

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestPluginChildOptionsAreHostOwnedAndLoopbackOnly(t *testing.T) {
	profile, err := os.MkdirTemp(t.TempDir(), "gonavi-plugin-window-")
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{"ENDPOINT": "http://127.0.0.1:4321", "TOKEN": strings.Repeat("a", 43), "ID": strings.Repeat("b", 43), "PROFILE": profile, "PARENT_PID": strconv.Itoa(os.Getpid()), "WIDTH": "960", "HEIGHT": "720"} {
		t.Setenv(pluginEnvPrefix+key, value)
	}
	if _, err := parsePluginChildOptions(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := parsePluginChildOptions([]string{"--token", "shared-token"}); err == nil {
		t.Fatal("CLI override accepted")
	}
	for _, endpoint := range []string{"http://example.com:4321", "https://127.0.0.1:4321", "http://127.0.0.1:4321/path", "http://user@127.0.0.1:4321", "http://127.0.0.1:4321?redirect=x", "http://localhost:4321"} {
		t.Setenv(pluginEnvPrefix+"ENDPOINT", endpoint)
		if _, err := parsePluginChildOptions(nil); err == nil {
			t.Fatalf("unsafe endpoint accepted: %s", endpoint)
		}
	}
}

func TestPluginChildProxyDoesNotForwardMainRoutesOrCredentials(t *testing.T) {
	requests := 0
	parent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get(pluginTokenHeader) != "child-token" || r.Header.Get(pluginWindowHeader) != "child-id" {
			t.Error("wrong capability")
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("forwarded unrelated credentials")
		}
		w.WriteHeader(204)
	}))
	defer parent.Close()
	proxy := newPluginChildProxy(pluginChildOptions{endpoint: parent.URL, token: "child-token", id: "child-id"}, http.DefaultTransport)
	for _, path := range []string{InvokePath, "/wails/ipc", "/frontend/index.html"} {
		request := httptest.NewRequest(http.MethodGet, "http://wails.local"+path, nil)
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, request)
		if response.Code != 404 {
			t.Fatal("main route allowed")
		}
	}
	if requests != 0 {
		t.Fatal("main RPC reached parent")
	}
	request := httptest.NewRequest(http.MethodPost, "http://wails.local"+pluginBridgePrefix+"heartbeat", strings.NewReader(`{"sequence":1}`))
	request.Header.Set(pluginTokenHeader, "attacker")
	request.Header.Set("Authorization", "main-secret")
	request.Header.Set("Cookie", "host-session=secret")
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != 204 || requests != 1 {
		t.Fatal("scoped proxy failed")
	}
}

func TestPluginChildClosingUsesOnlyHostState(t *testing.T) {
	parent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != pluginBridgePrefix+"state" {
			t.Error("child used heartbeat to fake JS health")
		}
		if _, err := io.WriteString(w, `{"closing":true}`); err != nil {
			t.Error(err)
		}
	}))
	defer parent.Close()
	closing, err := pluginChildClosing(t.Context(), parent.Client(), pluginChildOptions{endpoint: parent.URL})
	if err != nil || !closing {
		t.Fatalf("closing=%v err=%v", closing, err)
	}
}

func TestPluginPickerRejectsInvalidRequests(t *testing.T) {
	for _, route := range []string{"pick-file", "pick-folder"} {
		t.Run(route, func(t *testing.T) {
			tests := []struct {
				name, body, contentType string
				status                  int
				readError               bool
			}{
				{name: "empty", contentType: "application/json", status: 400},
				{name: "malformed", body: "{", contentType: "application/json", status: 400},
				{name: "unknown field", body: `{"other":true}`, contentType: "application/json", status: 400},
				{name: "multiple JSON", body: "{} {}", contentType: "application/json", status: 400},
				{name: "null", body: "null", contentType: "application/json", status: 400},
				{name: "array", body: "[]", contentType: "application/json", status: 400},
				{name: "wrong title type", body: `{"title":42}`, contentType: "application/json", status: 400},
				{name: "wrong content type", body: "{}", contentType: "text/plain", status: 400},
				{name: "read error", body: "{}", contentType: "application/json", status: 400, readError: true},
				{name: "oversized title", body: `{"title":"` + strings.Repeat("x", pluginMaxJSONBytes) + `"}`, contentType: "application/json", status: 413},
				{name: "oversized trailing whitespace", body: "{}" + strings.Repeat(" ", pluginMaxJSONBytes-1), contentType: "application/json", status: 400},
			}
			for _, test := range tests {
				t.Run(test.name, func(t *testing.T) {
					ctx := t.Context()
					var ready atomic.Pointer[context.Context]
					ready.Store(&ctx)
					calls := 0
					open := func(context.Context, wailsRuntime.OpenDialogOptions) (string, error) {
						calls++
						return "/selected", nil
					}
					handler := &pickPathHandler{wailsCtx: &ready, openFile: open, openFolder: open}
					var body io.Reader = strings.NewReader(test.body)
					if test.readError {
						body = io.MultiReader(body, pickerErrorReader{})
					}
					request := httptest.NewRequest(http.MethodPost, pluginBridgePrefix+route, body)
					request.Header.Set("Content-Type", test.contentType)
					response := httptest.NewRecorder()
					handler.ServeHTTP(response, request)
					if response.Code != test.status || calls != 0 {
						t.Fatalf("status=%d want=%d dialog calls=%d", response.Code, test.status, calls)
					}
				})
			}
		})
	}
}

type pickerErrorReader struct{}

func (pickerErrorReader) Read([]byte) (int, error) {
	return 0, errors.New("picker request read failed")
}

func TestPluginPickerSingleFlightAcrossRoutes(t *testing.T) {
	for _, firstRoute := range []string{"pick-file", "pick-folder"} {
		for _, phase := range []string{"request body", "dialog"} {
			t.Run(firstRoute+"/"+phase, func(t *testing.T) {
				ctx := t.Context()
				var ready atomic.Pointer[context.Context]
				ready.Store(&ctx)
				entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
				var releaseOnce sync.Once
				unblock := func() { releaseOnce.Do(func() { close(release) }) }
				defer unblock()
				var calls atomic.Int32
				open := func(path string) func(context.Context, wailsRuntime.OpenDialogOptions) (string, error) {
					return func(context.Context, wailsRuntime.OpenDialogOptions) (string, error) {
						call := calls.Add(1)
						if phase == "dialog" && call == 1 {
							close(entered)
							<-release
						}
						return path, nil
					}
				}
				handler := &pickPathHandler{wailsCtx: &ready, openFile: open("/file"), openFolder: open("/folder")}
				var body io.Reader = strings.NewReader("{}")
				if phase == "request body" {
					body = &pickerGatedReader{Reader: body, entered: entered, release: release}
				}
				request := httptest.NewRequest(http.MethodPost, pluginBridgePrefix+firstRoute, body)
				request.Header.Set("Content-Type", "application/json")
				requestCtx, cancel := context.WithCancel(request.Context())
				defer cancel()
				first := httptest.NewRecorder()
				go func() { handler.ServeHTTP(first, request.WithContext(requestCtx)); close(returned) }()
				defer func() {
					unblock()
					select {
					case <-returned:
					case <-time.After(time.Second):
						t.Error("first picker did not finish")
					}
				}()
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("picker never entered blocking phase")
				}
				cancel()
				before := calls.Load()
				for _, route := range []string{"pick-file", "pick-folder"} {
					response := servePickerTest(handler, route, "{}")
					if response.Code != http.StatusConflict || calls.Load() != before {
						t.Errorf("busy %s: status=%d calls=%d want=%d", route, response.Code, calls.Load(), before)
					}
				}
				unblock()
				<-returned
				want := `{"path":"/file"}`
				if firstRoute == "pick-folder" {
					want = `{"path":"/folder"}`
				}
				if first.Code != http.StatusOK || strings.TrimSpace(first.Body.String()) != want {
					t.Fatalf("first status=%d body=%q want=%q", first.Code, first.Body.String(), want)
				}
				for _, route := range []string{"pick-file", "pick-folder"} {
					if response := servePickerTest(handler, route, "{}"); response.Code != http.StatusOK {
						t.Fatalf("picker remained busy: %d", response.Code)
					}
				}
			})
		}
	}
}

type pickerGatedReader struct {
	io.Reader
	entered chan struct{}
	release <-chan struct{}
	gated   bool
}

func (r *pickerGatedReader) Read(p []byte) (int, error) {
	if !r.gated {
		r.gated = true
		close(r.entered)
		<-r.release
	}
	return r.Reader.Read(p)
}

func servePickerTest(handler http.Handler, route, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, pluginBridgePrefix+route, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestPluginPickerResponsesAndReadiness(t *testing.T) {
	for _, route := range []string{"pick-file", "pick-folder"} {
		t.Run(route, func(t *testing.T) {
			ctx := t.Context()
			var ready atomic.Pointer[context.Context]
			calls := 0
			var title, path string
			var dialogErr error
			open := func(gotCtx context.Context, opts wailsRuntime.OpenDialogOptions) (string, error) {
				calls++
				if gotCtx != ctx || opts.Title != title {
					t.Errorf("wrong dialog context or title: %q want=%q", opts.Title, title)
				}
				return path, dialogErr
			}
			handler := &pickPathHandler{wailsCtx: &ready, openFile: open, openFolder: open,
				next: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })}
			for _, state := range []string{"not started", "nil context"} {
				if state == "nil context" {
					var unset context.Context
					ready.Store(&unset)
				}
				if response := servePickerTest(handler, route, "{}"); response.Code != 503 || calls != 0 {
					t.Fatalf("%s status=%d dialog calls=%d", state, response.Code, calls)
				}
			}
			request := httptest.NewRequest(http.MethodGet, pluginBridgePrefix+route, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 405 || calls != 0 {
				t.Fatalf("wrong method status=%d dialog calls=%d", response.Code, calls)
			}
			ready.Store(&ctx)
			for _, test := range []struct {
				name, body, title, path string
				status                  int
				err                     error
			}{
				{name: "success", body: `{"title":"选择 > файл"}`, title: "选择 > файл", path: `C:\tmp\file`, status: 200},
				{name: "cancel", body: "{}", status: 200},
				{name: "at JSON limit", body: `{"title":"` + strings.Repeat("x", pluginMaxJSONBytes-12) + `"}`, title: strings.Repeat("x", pluginMaxJSONBytes-12), path: "/file", status: 200},
				{name: "dialog error", body: "{}", status: 500, err: errors.New("dialog failed")},
				{name: "released after error", body: "{}", path: "/next", status: 200},
			} {
				t.Run(test.name, func(t *testing.T) {
					title, path, dialogErr = test.title, test.path, test.err
					before := calls
					response := servePickerTest(handler, route, test.body)
					if response.Code != test.status || calls != before+1 {
						t.Fatalf("status=%d want=%d dialog calls=%d", response.Code, test.status, calls)
					}
					if test.status == 200 {
						var result struct {
							Path string `json:"path"`
						}
						if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Path != test.path {
							t.Fatalf("picker result=%q err=%v", result.Path, err)
						}
					}
				})
			}
			if response := servePickerTest(handler, "bootstrap", "{}"); response.Code != 204 {
				t.Fatalf("non-picker request not forwarded: %d", response.Code)
			}
		})
	}
}
