package jvm

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
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

func TestAgentProviderListResourcesBuildsRequestAndDecodesResponse(t *testing.T) {
	provider := NewAgentProvider()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("expected GET request, got %s", r.Method)
		}
		if r.URL.Path != "/gonavi/agent/jvm/resources" {
			t.Fatalf("expected path /gonavi/agent/jvm/resources, got %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("parentPath"); got != "/runtime/cache" {
			t.Fatalf("expected parentPath /runtime/cache, got %q", got)
		}
		if got := r.Header.Get("X-API-Key"); got != "secret-token" {
			t.Fatalf("expected X-API-Key header to pass through, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]ResourceSummary{{
			ID:           "agent.cache",
			Kind:         "folder",
			Name:         "Agent Cache",
			Path:         "/runtime/cache",
			ProviderMode: ModeAgent,
			CanRead:      true,
			CanWrite:     true,
			HasChildren:  true,
		}})
	}))
	defer server.Close()

	items, err := provider.ListResources(context.Background(), newAgentProviderTestConfig(server.URL+"/gonavi/agent/jvm", 3), "/runtime/cache")
	if err != nil {
		t.Fatalf("ListResources returned error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 resource, got %#v", items)
	}
	if items[0].ProviderMode != ModeAgent || items[0].Path != "/runtime/cache" {
		t.Fatalf("unexpected resource payload: %#v", items[0])
	}
}

func TestAgentProviderGetMonitoringSnapshotDecodesResponse(t *testing.T) {
	provider := &AgentProvider{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("expected GET request, got %s", r.Method)
		}
		if r.URL.Path != "/gonavi/agent/jvm/metrics" {
			t.Fatalf("expected path /gonavi/agent/jvm/metrics, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(JVMMonitoringSnapshot{
			Point: JVMMonitoringPoint{
				Timestamp:                  1713945600000,
				ThreadCount:                27,
				HeapUsedBytes:              402653184,
				GCCollectionCount:          128,
				GCDeltaCount:               2,
				ProcessCpuLoad:             0.29,
				CommittedVirtualMemoryBytes: 2147483648,
			},
			RecentGCEvents: []RecentGCEvent{{
				Timestamp:  1713945600000,
				Name:       "ConcurrentMarkSweep",
				DurationMs: 12,
			}},
			AvailableMetrics: []string{"thread.count", "heap.used", "gc.count", "cpu.process", "memory.virtual"},
		})
	}))
	defer server.Close()

	snapshot, err := provider.GetMonitoringSnapshot(context.Background(), newAgentProviderTestConfig(server.URL+"/gonavi/agent/jvm", 3), nil)
	if err != nil {
		t.Fatalf("GetMonitoringSnapshot returned error: %v", err)
	}
	if snapshot.Point.ThreadCount != 27 || snapshot.Point.GCDeltaCount != 2 || snapshot.Point.ProcessCpuLoad != 0.29 {
		t.Fatalf("unexpected monitoring snapshot: %#v", snapshot)
	}
	if len(snapshot.RecentGCEvents) != 1 || snapshot.RecentGCEvents[0].Name != "ConcurrentMarkSweep" {
		t.Fatalf("unexpected recent gc events: %#v", snapshot.RecentGCEvents)
	}
	if len(snapshot.AvailableMetrics) != 5 {
		t.Fatalf("unexpected available metrics: %#v", snapshot)
	}
}

func TestAgentProviderRealAgentRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("java"); err != nil {
		t.Skipf("java 不可用，跳过真实 Agent 集成测试: %v", err)
	}
	if _, err := exec.LookPath("javac"); err != nil {
		t.Skipf("javac 不可用，跳过真实 Agent 集成测试: %v", err)
	}
	if _, err := exec.LookPath("jar"); err != nil {
		t.Skipf("jar 不可用，跳过真实 Agent 集成测试: %v", err)
	}

	provider := NewAgentProvider()
	fixture := startAgentFixture(t)
	cfg := newAgentProviderTestConfig(fixture.baseURL+"/gonavi/agent/jvm", 5)

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

	root, err := provider.ListResources(context.Background(), cfg, "")
	if err != nil {
		t.Fatalf("ListResources(root) returned error: %v", err)
	}
	if len(root) != 1 || root[0].Name != "Agent Cache" {
		t.Fatalf("unexpected root resources: %#v", root)
	}

	children, err := provider.ListResources(context.Background(), cfg, root[0].Path)
	if err != nil {
		t.Fatalf("ListResources(cache) returned error: %v", err)
	}
	if len(children) != 1 || children[0].Name != "user:1001" {
		t.Fatalf("unexpected child resources: %#v", children)
	}
	entry := children[0]

	before, err := provider.GetValue(context.Background(), cfg, entry.Path)
	if err != nil {
		t.Fatalf("GetValue(before) returned error: %v", err)
	}
	valueMap, ok := before.Value.(map[string]any)
	if !ok {
		t.Fatalf("expected JSON object snapshot, got %#v", before.Value)
	}
	if valueMap["status"] != "cold" {
		t.Fatalf("expected initial status cold, got %#v", before.Value)
	}

	preview, err := provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode:    ModeAgent,
		ResourceID:      entry.Path,
		Action:          "put",
		Reason:          "预热用户缓存",
		ExpectedVersion: before.Version,
		Payload: map[string]any{
			"status": "warm",
			"score":  99,
		},
	})
	if err != nil {
		t.Fatalf("PreviewChange returned error: %v", err)
	}
	if !preview.Allowed || preview.After.ResourceID != entry.Path {
		t.Fatalf("unexpected preview payload: %#v", preview)
	}

	result, err := provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode:    ModeAgent,
		ResourceID:      entry.Path,
		Action:          "put",
		Reason:          "预热用户缓存",
		ExpectedVersion: before.Version,
		Payload: map[string]any{
			"status": "warm",
			"score":  99,
		},
	})
	if err != nil {
		t.Fatalf("ApplyChange returned error: %v", err)
	}
	if result.Status != "applied" {
		t.Fatalf("unexpected apply payload: %#v", result)
	}

	after, err := provider.GetValue(context.Background(), cfg, entry.Path)
	if err != nil {
		t.Fatalf("GetValue(after) returned error: %v", err)
	}
	afterMap, ok := after.Value.(map[string]any)
	if !ok {
		t.Fatalf("expected JSON object snapshot after apply, got %#v", after.Value)
	}
	if afterMap["status"] != "warm" {
		t.Fatalf("expected status warm after apply, got %#v", after.Value)
	}
}

type agentFixtureProcess struct {
	port    int
	baseURL string
	cmd     *exec.Cmd
}

func startAgentFixture(t *testing.T) agentFixtureProcess {
	t.Helper()

	javaBin, err := exec.LookPath("java")
	if err != nil {
		t.Fatalf("look up java failed: %v", err)
	}
	javacBin, err := exec.LookPath("javac")
	if err != nil {
		t.Fatalf("look up javac failed: %v", err)
	}
	jarBin, err := exec.LookPath("jar")
	if err != nil {
		t.Fatalf("look up jar failed: %v", err)
	}

	classesDir := filepath.Join(t.TempDir(), "agent-fixture-classes")
	if err := os.MkdirAll(classesDir, 0o755); err != nil {
		t.Fatalf("create agent fixture classes directory failed: %v", err)
	}
	sourceRoot := filepath.Join(testRepoRoot(t), "internal", "jvm", "testdata", "agentfixture", "src")
	javaFiles, err := filepath.Glob(filepath.Join(sourceRoot, "com", "gonavi", "fixture", "*.java"))
	if err != nil {
		t.Fatalf("glob agent fixture sources failed: %v", err)
	}
	if len(javaFiles) == 0 {
		t.Fatalf("expected agent fixture java files under %s", sourceRoot)
	}

	compileArgs := append([]string{"-encoding", "UTF-8", "-d", classesDir}, javaFiles...)
	compileCmd := exec.Command(javacBin, compileArgs...)
	output, err := compileCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("compile agent fixture failed: %v\n%s", err, strings.TrimSpace(string(output)))
	}

	manifestPath := filepath.Join(t.TempDir(), "agent-manifest.mf")
	manifest := strings.Join([]string{
		"Premain-Class: com.gonavi.fixture.GoNaviTestAgent",
		"Agent-Class: com.gonavi.fixture.GoNaviTestAgent",
		"Can-Redefine-Classes: false",
		"Can-Retransform-Classes: false",
		"",
	}, "\n")
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o644); err != nil {
		t.Fatalf("write agent manifest failed: %v", err)
	}

	agentJarFile, err := os.CreateTemp("", "gonavi-test-agent-*.jar")
	if err != nil {
		t.Fatalf("create agent jar temp file failed: %v", err)
	}
	agentJar := agentJarFile.Name()
	if closeErr := agentJarFile.Close(); closeErr != nil {
		t.Fatalf("close agent jar temp file failed: %v", closeErr)
	}
	_ = os.Remove(agentJar)
	t.Cleanup(func() {
		_ = os.Remove(agentJar)
	})
	jarCmd := exec.Command(jarBin, "cmf", manifestPath, agentJar, "-C", classesDir, "com")
	output, err = jarCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("package agent jar failed: %v\n%s", err, strings.TrimSpace(string(output)))
	}

	port := reserveTCPPort(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	cmd := exec.CommandContext(
		ctx,
		javaBin,
		fmt.Sprintf("-javaagent:%s=port=%d,token=secret-token", agentJar, port),
		"-cp",
		classesDir,
		"com.gonavi.fixture.AgentHostApp",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("agent fixture stdout pipe failed: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start agent fixture failed: %v", err)
	}
	t.Cleanup(func() {
		cancel()
		_ = cmd.Wait()
	})

	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if strings.TrimSpace(scanner.Text()) == "AGENT_READY" {
				ready <- nil
				return
			}
		}
		if err := scanner.Err(); err != nil {
			ready <- fmt.Errorf("agent fixture readiness read failed: %w", err)
			return
		}
		ready <- fmt.Errorf("agent fixture terminated before readiness signal")
	}()

	select {
	case err := <-ready:
		if err != nil {
			t.Fatalf("wait agent fixture ready failed: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("agent fixture did not become ready within 20s")
	}

	waitForTest(t, 10*time.Second, func() error {
		conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
		if dialErr != nil {
			return dialErr
		}
		_ = conn.Close()
		return nil
	})

	return agentFixtureProcess{
		port:    port,
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		cmd:     cmd,
	}
}

func newAgentProviderTestConfig(baseURL string, timeoutSeconds int) connection.ConnectionConfig {
	readOnly := false
	return connection.ConnectionConfig{
		Type:    "jvm",
		Timeout: timeoutSeconds,
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			AllowedModes:  []string{ModeAgent},
			PreferredMode: ModeAgent,
			Agent: connection.JVMAgentConfig{
				BaseURL:        baseURL,
				APIKey:         "secret-token",
				TimeoutSeconds: timeoutSeconds,
			},
		},
	}
}
