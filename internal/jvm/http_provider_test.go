package jvm

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestHTTPProviderListResourcesBuildsRequestAndDecodesResponse(t *testing.T) {
	provider := NewHTTPProvider()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("expected GET request, got %s", r.Method)
		}
		if r.URL.Path != "/manage/jvm/resources" {
			t.Fatalf("expected path /manage/jvm/resources, got %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("parentPath"); got != "/cache/orders" {
			t.Fatalf("expected parentPath /cache/orders, got %q", got)
		}
		if got := r.Header.Get("X-API-Key"); got != "secret-token" {
			t.Fatalf("expected X-API-Key header to pass through, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]ResourceSummary{{
			ID:           "cache.orders",
			Kind:         "folder",
			Name:         "Orders",
			Path:         "/cache/orders",
			ProviderMode: ModeEndpoint,
			CanRead:      true,
			CanWrite:     true,
			HasChildren:  true,
		}})
	}))
	defer server.Close()

	items, err := provider.ListResources(context.Background(), newHTTPProviderTestConfig(server.URL+"/manage/jvm/", 3), "/cache/orders")
	if err != nil {
		t.Fatalf("ListResources returned error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 resource, got %#v", items)
	}
	if items[0].ProviderMode != ModeEndpoint || items[0].Path != "/cache/orders" {
		t.Fatalf("unexpected resource payload: %#v", items[0])
	}
}

func TestHTTPProviderGetValueDecodesResponse(t *testing.T) {
	provider := NewHTTPProvider()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("expected GET request, got %s", r.Method)
		}
		if r.URL.Path != "/runtime/value" {
			t.Fatalf("expected path /runtime/value, got %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("resourcePath"); got != "/cache/orders" {
			t.Fatalf("expected resourcePath /cache/orders, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ValueSnapshot{
			ResourceID: "/cache/orders",
			Kind:       "entry",
			Format:     "json",
			Version:    "v1",
			Value: map[string]any{
				"status": "ready",
			},
		})
	}))
	defer server.Close()

	value, err := provider.GetValue(context.Background(), newHTTPProviderTestConfig(server.URL+"/runtime", 3), "/cache/orders")
	if err != nil {
		t.Fatalf("GetValue returned error: %v", err)
	}
	if value.ResourceID != "/cache/orders" || value.Version != "v1" {
		t.Fatalf("unexpected value payload: %#v", value)
	}
}

func TestHTTPProviderGetMonitoringSnapshotDecodesResponse(t *testing.T) {
	provider := &HTTPProvider{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("expected GET request, got %s", r.Method)
		}
		if r.URL.Path != "/manage/jvm/metrics" {
			t.Fatalf("expected path /manage/jvm/metrics, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(JVMMonitoringSnapshot{
			Point: JVMMonitoringPoint{
				Timestamp:        1713945600000,
				ThreadCount:      18,
				HeapUsedBytes:    805306368,
				ProcessCpuLoad:   0.48,
				ProcessRssBytes:  1879048192,
				LoadedClassCount: 4096,
			},
			RecentGCEvents: []RecentGCEvent{{
				Timestamp:  1713945600000,
				Name:       "G1 Old Generation",
				DurationMs: 41,
			}},
			AvailableMetrics: []string{"thread.count", "heap.used", "cpu.process", "memory.rss", "class.loading"},
			MissingMetrics:   []string{"cpu.system"},
			ProviderWarnings: []string{"endpoint cpu metric unavailable"},
		})
	}))
	defer server.Close()

	snapshot, err := provider.GetMonitoringSnapshot(context.Background(), newHTTPProviderTestConfig(server.URL+"/manage/jvm", 3), nil)
	if err != nil {
		t.Fatalf("GetMonitoringSnapshot returned error: %v", err)
	}
	if snapshot.Point.ThreadCount != 18 || snapshot.Point.HeapUsedBytes != 805306368 || snapshot.Point.ProcessRssBytes != 1879048192 {
		t.Fatalf("unexpected monitoring snapshot: %#v", snapshot)
	}
	if len(snapshot.RecentGCEvents) != 1 || snapshot.RecentGCEvents[0].Name != "G1 Old Generation" {
		t.Fatalf("unexpected recent gc events: %#v", snapshot.RecentGCEvents)
	}
	if len(snapshot.MissingMetrics) != 1 || snapshot.MissingMetrics[0] != "cpu.system" {
		t.Fatalf("unexpected missing metrics: %#v", snapshot)
	}
}

func TestHTTPProviderPreviewChangeAndApplySendJSONBody(t *testing.T) {
	provider := NewHTTPProvider()
	request := ChangeRequest{
		ProviderMode:    ModeEndpoint,
		ResourceID:      "/cache/orders",
		Action:          "put",
		Reason:          "refresh cache",
		ExpectedVersion: "v1",
		Payload: map[string]any{
			"status": "warm",
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("failed to read request body: %v", err)
		}
		defer r.Body.Close()
		if contentType := r.Header.Get("Content-Type"); !strings.Contains(contentType, "application/json") {
			t.Fatalf("expected JSON content type, got %q", contentType)
		}

		var got ChangeRequest
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("failed to decode request body: %v", err)
		}
		if got.ResourceID != request.ResourceID || got.Action != request.Action || got.ExpectedVersion != request.ExpectedVersion {
			t.Fatalf("unexpected request body: %#v", got)
		}

		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/manage/jvm/preview":
			if r.Method != http.MethodPost {
				t.Fatalf("expected POST /preview, got %s", r.Method)
			}
			_ = json.NewEncoder(w).Encode(ChangePreview{
				Allowed:   true,
				Summary:   "preview ready",
				RiskLevel: "low",
				Before: ValueSnapshot{
					ResourceID: request.ResourceID,
					Kind:       "entry",
					Format:     "json",
				},
				After: ValueSnapshot{
					ResourceID: request.ResourceID,
					Kind:       "entry",
					Format:     "json",
					Value: map[string]any{
						"status": "warm",
					},
				},
			})
		case "/manage/jvm/apply":
			if r.Method != http.MethodPost {
				t.Fatalf("expected POST /apply, got %s", r.Method)
			}
			_ = json.NewEncoder(w).Encode(ApplyResult{
				Status:  "applied",
				Message: "updated",
				UpdatedValue: ValueSnapshot{
					ResourceID: request.ResourceID,
					Kind:       "entry",
					Format:     "json",
					Value: map[string]any{
						"status": "warm",
					},
				},
			})
		default:
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	preview, err := provider.PreviewChange(context.Background(), newHTTPProviderTestConfig(server.URL+"/manage/jvm", 3), request)
	if err != nil {
		t.Fatalf("PreviewChange returned error: %v", err)
	}
	if !preview.Allowed || preview.Summary != "preview ready" {
		t.Fatalf("unexpected preview payload: %#v", preview)
	}

	result, err := provider.ApplyChange(context.Background(), newHTTPProviderTestConfig(server.URL+"/manage/jvm", 3), request)
	if err != nil {
		t.Fatalf("ApplyChange returned error: %v", err)
	}
	if result.Status != "applied" || result.UpdatedValue.ResourceID != request.ResourceID {
		t.Fatalf("unexpected apply payload: %#v", result)
	}
}

func TestProvidersProbeCapabilitiesUseReadOnlyReasonKey(t *testing.T) {
	readOnly := true
	cases := []struct {
		name     string
		provider Provider
		cfg      connection.ConnectionConfig
	}{
		{
			name:     "jmx",
			provider: NewJMXProvider(),
			cfg:      newJMXProviderTestConfig(),
		},
		{
			name:     "endpoint",
			provider: NewHTTPProvider(),
			cfg:      newHTTPProviderTestConfig("https://orders.internal/manage/jvm", 3),
		},
		{
			name:     "agent",
			provider: NewAgentProvider(),
			cfg:      newAgentProviderTestConfig("https://orders.internal/agent", 3),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := tc.cfg
			cfg.JVM.ReadOnly = &readOnly

			caps, err := tc.provider.ProbeCapabilities(context.Background(), cfg)
			if err != nil {
				t.Fatalf("ProbeCapabilities returned error: %v", err)
			}
			if len(caps) != 1 {
				t.Fatalf("expected one capability, got %#v", caps)
			}
			if caps[0].CanWrite {
				t.Fatalf("expected capability to be readonly, got %#v", caps[0])
			}
			if caps[0].Reason != changeBlockedReadOnlyKey {
				t.Fatalf("expected readonly reason key %q, got %#v", changeBlockedReadOnlyKey, caps[0])
			}
		})
	}
}

func TestHTTPProviderProbeCapabilitiesReturnsConfigValidationError(t *testing.T) {
	provider := NewHTTPProvider()

	_, err := provider.ProbeCapabilities(context.Background(), connection.ConnectionConfig{
		Type: "jvm",
		JVM: connection.JVMConfig{
			Endpoint: connection.JVMEndpointConfig{
				BaseURL: "",
			},
		},
	})
	if err == nil {
		t.Fatal("expected endpoint config validation error")
	}
	if !strings.Contains(err.Error(), "endpoint baseURL is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHTTPProviderReturnsReadableStatusErrors(t *testing.T) {
	provider := NewHTTPProvider()

	tests := []struct {
		name string
		path string
		code int
		body string
		call func(context.Context, Provider, connection.ConnectionConfig) error
		want []string
	}{
		{
			name: "list resources unauthorized",
			path: "/resources",
			code: http.StatusUnauthorized,
			body: "missing api key",
			call: func(ctx context.Context, provider Provider, cfg connection.ConnectionConfig) error {
				_, err := provider.ListResources(ctx, cfg, "/cache/orders")
				return err
			},
			want: []string{"list resources", "401 Unauthorized", "missing api key"},
		},
		{
			name: "get value forbidden",
			path: "/value",
			code: http.StatusForbidden,
			body: "access denied",
			call: func(ctx context.Context, provider Provider, cfg connection.ConnectionConfig) error {
				_, err := provider.GetValue(ctx, cfg, "/cache/orders")
				return err
			},
			want: []string{"get value", "403 Forbidden", "access denied"},
		},
		{
			name: "preview change server error",
			path: "/preview",
			code: http.StatusInternalServerError,
			body: "preview backend exploded",
			call: func(ctx context.Context, provider Provider, cfg connection.ConnectionConfig) error {
				_, err := provider.PreviewChange(ctx, cfg, ChangeRequest{
					ProviderMode: ModeEndpoint,
					ResourceID:   "/cache/orders",
					Action:       "put",
					Reason:       "refresh cache",
				})
				return err
			},
			want: []string{"preview change", "500 Internal Server Error", "preview backend exploded"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/manage/jvm"+tc.path {
					t.Fatalf("expected path %s, got %s", "/manage/jvm"+tc.path, r.URL.Path)
				}
				http.Error(w, tc.body, tc.code)
			}))
			defer server.Close()

			err := tc.call(context.Background(), provider, newHTTPProviderTestConfig(server.URL+"/manage/jvm", 3))
			if err == nil {
				t.Fatal("expected request error")
			}
			for _, fragment := range tc.want {
				if !strings.Contains(err.Error(), fragment) {
					t.Fatalf("expected error %q to contain %q", err.Error(), fragment)
				}
			}
		})
	}
}

func TestHTTPProviderReturnsInvalidJSONError(t *testing.T) {
	provider := NewHTTPProvider()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"resourceId":`))
	}))
	defer server.Close()

	_, err := provider.GetValue(context.Background(), newHTTPProviderTestConfig(server.URL, 3), "/cache/orders")
	if err == nil {
		t.Fatal("expected invalid JSON error")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "invalid json") {
		t.Fatalf("expected invalid JSON error, got %v", err)
	}
}

func TestHTTPProviderReturnsTimeoutError(t *testing.T) {
	provider := NewHTTPProvider()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1200 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]ResourceSummary{})
	}))
	defer server.Close()

	_, err := provider.ListResources(context.Background(), newHTTPProviderTestConfig(server.URL, 1), "/cache/orders")
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "timed out after 1s") {
		t.Fatalf("expected timeout error, got %v", err)
	}
}

func TestHTTPProviderRealEndpointRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("java"); err != nil {
		t.Skipf("java 不可用，跳过真实 Endpoint 集成测试: %v", err)
	}
	if _, err := exec.LookPath("javac"); err != nil {
		t.Skipf("javac 不可用，跳过真实 Endpoint 集成测试: %v", err)
	}

	provider := NewHTTPProvider()
	fixture := startEndpointFixture(t)
	cfg := newHTTPProviderTestConfig(fixture.baseURL+"/manage/jvm", 5)

	waitForTest(t, 10*time.Second, func() error {
		return provider.TestConnection(context.Background(), cfg)
	})

	caps, err := provider.ProbeCapabilities(context.Background(), cfg)
	if err != nil {
		t.Fatalf("ProbeCapabilities returned error: %v", err)
	}
	if len(caps) != 1 || !caps[0].CanBrowse || !caps[0].CanWrite || !caps[0].CanPreview {
		t.Fatalf("unexpected capabilities: %#v", caps)
	}

	rootItems, err := provider.ListResources(context.Background(), cfg, "")
	if err != nil {
		t.Fatalf("ListResources(root) returned error: %v", err)
	}
	if len(rootItems) != 1 || rootItems[0].Name != "Orders" || !rootItems[0].HasChildren {
		t.Fatalf("unexpected root resources: %#v", rootItems)
	}

	children, err := provider.ListResources(context.Background(), cfg, rootItems[0].Path)
	if err != nil {
		t.Fatalf("ListResources(child) returned error: %v", err)
	}
	stateResource := findResourceByName(t, children, "State")

	before, err := provider.GetValue(context.Background(), cfg, stateResource.Path)
	if err != nil {
		t.Fatalf("GetValue(before) returned error: %v", err)
	}
	beforeMap, ok := before.Value.(map[string]any)
	if !ok || beforeMap["status"] != "warm" || strings.TrimSpace(before.Version) == "" {
		t.Fatalf("unexpected initial value snapshot: %#v", before)
	}

	preview, err := provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode:    ModeEndpoint,
		ResourceID:      stateResource.Path,
		Action:          "put",
		Reason:          "更新订单缓存状态",
		ExpectedVersion: before.Version,
		Payload: map[string]any{
			"status":      "hot",
			"lastUpdated": "preview-check",
		},
	})
	if err != nil {
		t.Fatalf("PreviewChange returned error: %v", err)
	}
	previewAfter, ok := preview.After.Value.(map[string]any)
	if !preview.Allowed || !ok || previewAfter["status"] != "hot" {
		t.Fatalf("unexpected preview payload: %#v", preview)
	}

	result, err := provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode:    ModeEndpoint,
		ResourceID:      stateResource.Path,
		Action:          "put",
		Reason:          "更新订单缓存状态",
		ExpectedVersion: before.Version,
		Payload: map[string]any{
			"status":      "hot",
			"lastUpdated": "manual-check",
		},
	})
	if err != nil {
		t.Fatalf("ApplyChange returned error: %v", err)
	}
	updatedMap, ok := result.UpdatedValue.Value.(map[string]any)
	if result.Status != "applied" || !ok || updatedMap["status"] != "hot" || updatedMap["lastUpdated"] != "manual-check" {
		t.Fatalf("unexpected apply result: %#v", result)
	}

	after, err := provider.GetValue(context.Background(), cfg, stateResource.Path)
	if err != nil {
		t.Fatalf("GetValue(after) returned error: %v", err)
	}
	afterMap, ok := after.Value.(map[string]any)
	if !ok || afterMap["status"] != "hot" || after.Version == before.Version {
		t.Fatalf("unexpected updated value snapshot: %#v", after)
	}
}

type endpointFixtureProcess struct {
	port    int
	baseURL string
	cmd     *exec.Cmd
}

func startEndpointFixture(t *testing.T) endpointFixtureProcess {
	t.Helper()

	javaBin, err := exec.LookPath("java")
	if err != nil {
		t.Fatalf("look up java failed: %v", err)
	}
	javacBin, err := exec.LookPath("javac")
	if err != nil {
		t.Fatalf("look up javac failed: %v", err)
	}

	classesDir := filepath.Join(t.TempDir(), "endpoint-fixture-classes")
	if err := os.MkdirAll(classesDir, 0o755); err != nil {
		t.Fatalf("create endpoint fixture classes directory failed: %v", err)
	}
	sourceRoot := filepath.Join(testRepoRoot(t), "internal", "jvm", "testdata", "endpointfixture", "src")
	javaFiles, err := filepath.Glob(filepath.Join(sourceRoot, "com", "gonavi", "fixture", "*.java"))
	if err != nil {
		t.Fatalf("glob endpoint fixture sources failed: %v", err)
	}
	if len(javaFiles) == 0 {
		t.Fatalf("expected endpoint fixture java files under %s", sourceRoot)
	}

	compileArgs := append([]string{"-encoding", "UTF-8", "-d", classesDir}, javaFiles...)
	compileCmd := exec.Command(javacBin, compileArgs...)
	output, err := compileCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("compile endpoint fixture failed: %v\n%s", err, strings.TrimSpace(string(output)))
	}

	port := reserveTCPPort(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	cmd := exec.CommandContext(ctx, javaBin, "-cp", classesDir, "com.gonavi.fixture.EndpointTestServer", fmt.Sprintf("%d", port))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("endpoint fixture stdout pipe failed: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start endpoint fixture failed: %v", err)
	}
	t.Cleanup(func() {
		cancel()
		_ = cmd.Wait()
	})

	ready := make(chan error, 1)
	go func() {
		line, readErr := bufio.NewReader(stdout).ReadString('\n')
		if readErr != nil {
			ready <- fmt.Errorf("endpoint fixture readiness read failed: %w", readErr)
			return
		}
		if strings.TrimSpace(line) != "READY" {
			ready <- fmt.Errorf("unexpected endpoint fixture readiness line: %q", strings.TrimSpace(line))
			return
		}
		ready <- nil
	}()

	select {
	case err := <-ready:
		if err != nil {
			t.Fatalf("wait endpoint fixture ready failed: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("endpoint fixture did not become ready within 20s")
	}

	waitForTest(t, 10*time.Second, func() error {
		conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
		if dialErr != nil {
			return dialErr
		}
		_ = conn.Close()
		return nil
	})

	return endpointFixtureProcess{
		port:    port,
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		cmd:     cmd,
	}
}

func newHTTPProviderTestConfig(baseURL string, timeoutSeconds int) connection.ConnectionConfig {
	readOnly := false
	return connection.ConnectionConfig{
		Type:    "jvm",
		Timeout: timeoutSeconds,
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			AllowedModes:  []string{ModeEndpoint},
			PreferredMode: ModeEndpoint,
			Endpoint: connection.JVMEndpointConfig{
				BaseURL:        baseURL,
				APIKey:         "secret-token",
				TimeoutSeconds: timeoutSeconds,
			},
		},
	}
}
