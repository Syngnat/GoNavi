package aiservice

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/secretstore"
)

type fakeMCPHTTPProcess struct {
	done    chan struct{}
	once    sync.Once
	stopErr error
	waitErr error
}

func newFakeMCPHTTPProcess() *fakeMCPHTTPProcess {
	return &fakeMCPHTTPProcess{done: make(chan struct{})}
}

func newFakeMCPHTTPProcessWithWaitErr(err error) *fakeMCPHTTPProcess {
	return &fakeMCPHTTPProcess{
		done:    make(chan struct{}),
		waitErr: err,
	}
}

func (p *fakeMCPHTTPProcess) Done() <-chan struct{} {
	return p.done
}

func (p *fakeMCPHTTPProcess) Stop(context.Context) error {
	p.once.Do(func() {
		close(p.done)
	})
	return p.stopErr
}

func (p *fakeMCPHTTPProcess) Wait() error {
	<-p.done
	return p.waitErr
}

func (p *fakeMCPHTTPProcess) finish() {
	p.once.Do(func() {
		close(p.done)
	})
}

func newMCPHTTPTestService(t *testing.T) *Service {
	t.Helper()
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	return newMCPHTTPTestServiceForActiveRoot(t)
}

func newMCPHTTPTestServiceForActiveRoot(t *testing.T) *Service {
	t.Helper()
	service := NewServiceWithSecretStore(secretstore.NewUnavailableStore("test"))
	InitializeLifecycle(service, context.Background())
	t.Cleanup(func() {
		service.Shutdown()
	})
	return service
}

func TestResolveMCPHTTPCommandUsesDedicatedServerForWailsDevelopmentBuild(t *testing.T) {
	repoRoot := t.TempDir()
	developmentExecutable := filepath.Join(repoRoot, "build", "bin", "GoNavi-dev.exe")
	if err := os.MkdirAll(filepath.Dir(developmentExecutable), 0o755); err != nil {
		t.Fatalf("MkdirAll development output directory returned error: %v", err)
	}
	if err := os.WriteFile(developmentExecutable, []byte("development executable"), 0o755); err != nil {
		t.Fatalf("WriteFile development executable returned error: %v", err)
	}
	developmentServer := filepath.Join(repoRoot, "build", "bin", "gonavi-mcp-server-dev.exe")
	if err := os.WriteFile(developmentServer, []byte("development MCP server"), 0o755); err != nil {
		t.Fatalf("WriteFile development MCP server returned error: %v", err)
	}

	command, args, err := resolveMCPHTTPCommand(developmentExecutable, mcpHTTPProcessStartOptions{
		Addr:       "127.0.0.1:9876",
		Path:       "/mcp",
		SchemaOnly: true,
	}, nil)
	if err != nil {
		t.Fatalf("resolveMCPHTTPCommand returned error: %v", err)
	}
	if command != developmentServer {
		t.Fatalf("command = %q, want %q", command, developmentServer)
	}
	wantArgs := []string{"http", "--addr", "127.0.0.1:9876", "--path", "/mcp", "--schema-only"}
	if strings.Join(args, "\u0000") != strings.Join(wantArgs, "\u0000") {
		t.Fatalf("args = %#v, want %#v", args, wantArgs)
	}
}

func TestResolveMCPHTTPCommandKeepsProductionMainBinary(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "GoNavi.exe")
	command, args, err := resolveMCPHTTPCommand(executable, mcpHTTPProcessStartOptions{
		Addr: "127.0.0.1:8765",
		Path: "/mcp",
	}, nil)
	if err != nil {
		t.Fatalf("resolveMCPHTTPCommand returned error: %v", err)
	}
	if command != executable {
		t.Fatalf("command = %q, want %q", command, executable)
	}
	wantArgs := []string{"mcp-server", "http", "--addr", "127.0.0.1:8765", "--path", "/mcp"}
	if strings.Join(args, "\u0000") != strings.Join(wantArgs, "\u0000") {
		t.Fatalf("args = %#v, want %#v", args, wantArgs)
	}
}

func TestMCPHTTPServerLifecycleFromAIService(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})
	var capturedOptions mcpHTTPProcessStartOptions
	startMCPHTTPProcess = func(_ context.Context, options mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		capturedOptions = options
		return newFakeMCPHTTPProcess(), nil
	}
	waitMCPHTTPHealth = func(_ context.Context, _ string, _ mcpHTTPTextLookup) error {
		return nil
	}

	service := newMCPHTTPTestService(t)

	initial := service.AIGetMCPHTTPServerStatus()
	if initial.Running || initial.Enabled {
		t.Fatal("expected MCP HTTP server to be stopped initially")
	}

	started, err := service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{
		Addr: "127.0.0.1:0",
		Path: "mcp",
	})
	if err != nil {
		t.Fatalf("AIStartMCPHTTPServer returned error: %v", err)
	}
	if !started.Running {
		t.Fatalf("expected running status, got %#v", started)
	}
	if started.Path != "/mcp" {
		t.Fatalf("expected normalized path /mcp, got %q", started.Path)
	}
	if started.SchemaOnly {
		t.Fatal("expected in-app MCP HTTP server to default to execute_sql-enabled mode for limited data queries")
	}
	if capturedOptions.SchemaOnly || capturedOptions.Token != started.Token {
		t.Fatalf("expected process to receive schemaOnly=false and generated token, got %#v", capturedOptions)
	}
	if !strings.HasPrefix(started.Token, "gnv_") || started.AuthorizationHeader != "Bearer "+started.Token {
		t.Fatalf("expected generated bearer token in status, got token=%q header=%q", started.Token, started.AuthorizationHeader)
	}
	if !strings.Contains(started.URL, "/mcp") {
		t.Fatalf("expected MCP URL to include /mcp, got %q", started.URL)
	}

	stopped, err := service.AIStopMCPHTTPServer()
	if err != nil {
		t.Fatalf("AIStopMCPHTTPServer returned error: %v", err)
	}
	if stopped.Running {
		t.Fatalf("expected stopped status, got %#v", stopped)
	}
	if stopped.Enabled {
		t.Fatalf("expected explicit stop to disable persisted preference, got %#v", stopped)
	}
	if stopped.Token != started.Token || stopped.AuthorizationHeader != "Bearer "+started.Token {
		t.Fatalf("expected stopped status to keep token fields, got token=%q header=%q", stopped.Token, stopped.AuthorizationHeader)
	}
}

func TestMCPHTTPServerStopCancelsPendingStart(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})

	process := newFakeMCPHTTPProcess()
	healthStarted := make(chan struct{})
	releaseHealth := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseHealth)
		})
	}
	startMCPHTTPProcess = func(_ context.Context, _ mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		return process, nil
	}
	waitMCPHTTPHealth = func(ctx context.Context, _ string, _ mcpHTTPTextLookup) error {
		close(healthStarted)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-releaseHealth:
			return nil
		}
	}

	service := newMCPHTTPTestService(t)
	t.Cleanup(release)
	startDone := make(chan struct{})
	go func() {
		_, _ = service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{Token: "gnv_stop_pending_start"})
		close(startDone)
	}()

	select {
	case <-healthStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for MCP HTTP startup health check")
	}

	stopped, err := service.AIStopMCPHTTPServer()
	if err != nil {
		t.Fatalf("AIStopMCPHTTPServer returned error: %v", err)
	}
	if stopped.Enabled || stopped.Running {
		t.Fatalf("expected explicit stop to disable pending start, got %#v", stopped)
	}

	// 旧实现会在 Stop 返回后继续发布这个启动过程；释放 health gate 可稳定复现该竞态。
	release()
	select {
	case <-startDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for canceled MCP HTTP startup")
	}

	status := service.AIGetMCPHTTPServerStatus()
	if status.Enabled || status.Running {
		t.Fatalf("expected canceled start to stay disabled and stopped, got %#v", status)
	}
	select {
	case <-process.done:
	default:
		t.Fatal("expected pending MCP HTTP process to be stopped")
	}
}

func TestMCPHTTPServerShutdownCancelsPendingStartWithoutDisablingPreference(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})

	process := newFakeMCPHTTPProcess()
	healthStarted := make(chan struct{})
	releaseHealth := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseHealth)
		})
	}
	startMCPHTTPProcess = func(_ context.Context, _ mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		return process, nil
	}
	waitMCPHTTPHealth = func(ctx context.Context, _ string, _ mcpHTTPTextLookup) error {
		close(healthStarted)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-releaseHealth:
			return nil
		}
	}

	service := newMCPHTTPTestService(t)
	t.Cleanup(release)
	startDone := make(chan struct{})
	go func() {
		_, _ = service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{Token: "gnv_shutdown_pending_start"})
		close(startDone)
	}()

	select {
	case <-healthStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for MCP HTTP startup health check")
	}

	service.Shutdown()
	// 旧实现的 Shutdown 在启动尚未发布时会直接返回，随后这里的释放会让进程重新出现。
	release()
	select {
	case <-startDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for canceled MCP HTTP startup")
	}

	status := service.AIGetMCPHTTPServerStatus()
	if !status.Enabled || status.Running {
		t.Fatalf("expected shutdown to preserve preference without publishing pending start, got %#v", status)
	}
	select {
	case <-process.done:
	default:
		t.Fatal("expected pending MCP HTTP process to be stopped during shutdown")
	}
}

func TestMCPHTTPServerStartUsesCustomAddrAndToken(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})

	var capturedOptions mcpHTTPProcessStartOptions
	startMCPHTTPProcess = func(_ context.Context, options mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		capturedOptions = options
		return newFakeMCPHTTPProcess(), nil
	}
	waitMCPHTTPHealth = func(_ context.Context, _ string, _ mcpHTTPTextLookup) error {
		return nil
	}

	service := newMCPHTTPTestService(t)

	started, err := service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{
		Addr:  "127.0.0.1:9123",
		Path:  "mcp",
		Token: "gnv_custom_token",
	})
	if err != nil {
		t.Fatalf("AIStartMCPHTTPServer returned error: %v", err)
	}

	if capturedOptions.Addr != "127.0.0.1:9123" || capturedOptions.Token != "gnv_custom_token" {
		t.Fatalf("expected custom addr/token, got %#v", capturedOptions)
	}
	if started.URL != "http://127.0.0.1:9123/mcp" {
		t.Fatalf("expected custom MCP URL, got %q", started.URL)
	}
	if started.Token != "gnv_custom_token" || started.AuthorizationHeader != "Bearer gnv_custom_token" {
		t.Fatalf("expected custom bearer token in status, got token=%q header=%q", started.Token, started.AuthorizationHeader)
	}
	if started.SchemaOnly || capturedOptions.SchemaOnly {
		t.Fatal("expected custom in-app MCP HTTP server to keep default execute_sql-enabled mode")
	}

	// 显式 schemaOnly=true 仍可关闭 execute_sql
	service.Shutdown()
	_, err = service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{
		Addr:       "127.0.0.1:9124",
		Path:       "mcp",
		Token:      "gnv_schema_only",
		SchemaOnly: true,
	})
	if err != nil {
		t.Fatalf("AIStartMCPHTTPServer schema-only returned error: %v", err)
	}
	if !capturedOptions.SchemaOnly {
		t.Fatalf("expected process to receive schemaOnly=true, got %#v", capturedOptions)
	}
}

func TestMCPHTTPServerLifecycleUsesEnglishStatusMessages(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})
	startMCPHTTPProcess = func(_ context.Context, options mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		return newFakeMCPHTTPProcess(), nil
	}
	waitMCPHTTPHealth = func(_ context.Context, _ string, _ mcpHTTPTextLookup) error {
		return nil
	}

	service := newMCPHTTPTestService(t)
	service.AISetLanguage("en-US")

	initial := service.AIGetMCPHTTPServerStatus()
	if initial.Message != "GoNavi MCP HTTP server is not running" {
		t.Fatalf("expected English not-running message, got %q", initial.Message)
	}

	started, err := service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{
		Addr: "127.0.0.1:0",
		Path: "mcp",
	})
	if err != nil {
		t.Fatalf("AIStartMCPHTTPServer returned error: %v", err)
	}
	if started.Message != "GoNavi MCP HTTP server started" {
		t.Fatalf("expected English started message, got %q", started.Message)
	}

	stopped, err := service.AIStopMCPHTTPServer()
	if err != nil {
		t.Fatalf("AIStopMCPHTTPServer returned error: %v", err)
	}
	if stopped.Message != "GoNavi MCP HTTP server stopped" {
		t.Fatalf("expected English stopped message, got %q", stopped.Message)
	}
}

func TestMCPHTTPServerStartFailureUsesEnglishError(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
	})
	startMCPHTTPProcess = func(_ context.Context, _ mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		return nil, fmt.Errorf("listen tcp 127.0.0.1:8765: bind: permission denied")
	}

	service := newMCPHTTPTestService(t)
	service.AISetLanguage("en-US")

	status, err := service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{
		Addr: "127.0.0.1:8765",
		Path: "/mcp",
	})
	if err == nil {
		t.Fatal("expected start failure")
	}

	const want = "Failed to start GoNavi MCP HTTP service: listen tcp 127.0.0.1:8765: bind: permission denied"
	if err.Error() != want {
		t.Fatalf("expected localized start failure %q, got %q", want, err.Error())
	}
	if status.Message != want {
		t.Fatalf("expected localized start failure status %q, got %q", want, status.Message)
	}
}

func TestMCPHTTPServerUnexpectedExitUsesEnglishStatusMessage(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})

	process := newFakeMCPHTTPProcessWithWaitErr(fmt.Errorf("exit status 1"))
	startMCPHTTPProcess = func(_ context.Context, _ mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		return process, nil
	}
	waitMCPHTTPHealth = func(_ context.Context, _ string, _ mcpHTTPTextLookup) error {
		return nil
	}

	service := newMCPHTTPTestService(t)
	service.AISetLanguage("en-US")

	if _, err := service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{
		Addr: "127.0.0.1:0",
		Path: "mcp",
	}); err != nil {
		t.Fatalf("AIStartMCPHTTPServer returned error: %v", err)
	}

	process.finish()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status := service.AIGetMCPHTTPServerStatus()
		if !status.Running && strings.Contains(status.Message, "GoNavi MCP HTTP service stopped unexpectedly") {
			if !status.Enabled {
				t.Fatalf("expected unexpected exit to preserve enabled preference, got %#v", status)
			}
			const want = "GoNavi MCP HTTP service stopped unexpectedly: exit status 1"
			if status.Message != want {
				t.Fatalf("expected localized unexpected-exit message %q, got %q", want, status.Message)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}

	t.Fatal("timed out waiting for unexpected-exit status")
}

func TestMCPHTTPServerRestoresEnabledPreferenceOnStartup(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})

	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)
	var capturedOptions []mcpHTTPProcessStartOptions
	startMCPHTTPProcess = func(_ context.Context, options mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		capturedOptions = append(capturedOptions, options)
		return newFakeMCPHTTPProcess(), nil
	}
	waitMCPHTTPHealth = func(_ context.Context, _ string, _ mcpHTTPTextLookup) error {
		return nil
	}

	first := newMCPHTTPTestServiceForActiveRoot(t)
	started, err := first.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{
		Addr:       "127.0.0.1:9123",
		Path:       "persisted-mcp",
		Token:      "gnv_persisted_token",
		SchemaOnly: true,
	})
	if err != nil {
		t.Fatalf("AIStartMCPHTTPServer returned error: %v", err)
	}
	first.Shutdown()

	second := newMCPHTTPTestServiceForActiveRoot(t)
	status := second.AIGetMCPHTTPServerStatus()
	if !status.Enabled || !status.Running {
		t.Fatalf("expected enabled MCP HTTP server to restore on startup, got %#v", status)
	}
	if status.Token != started.Token || status.Path != "/persisted-mcp" || !status.SchemaOnly {
		t.Fatalf("expected restored status to keep saved options, got %#v", status)
	}
	if len(capturedOptions) != 2 {
		t.Fatalf("expected initial start and startup restore, got %d starts", len(capturedOptions))
	}
	restored := capturedOptions[1]
	if restored.Addr != "127.0.0.1:9123" || restored.Path != "/persisted-mcp" || restored.Token != "gnv_persisted_token" || !restored.SchemaOnly {
		t.Fatalf("expected startup restore to reuse persisted options, got %#v", restored)
	}
}

func TestMCPHTTPServerDoesNotRestoreAfterExplicitStop(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})

	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	starts := 0
	startMCPHTTPProcess = func(_ context.Context, _ mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		starts++
		return newFakeMCPHTTPProcess(), nil
	}
	waitMCPHTTPHealth = func(_ context.Context, _ string, _ mcpHTTPTextLookup) error {
		return nil
	}

	first := newMCPHTTPTestServiceForActiveRoot(t)
	if _, err := first.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{Token: "gnv_disabled_after_stop"}); err != nil {
		t.Fatalf("AIStartMCPHTTPServer returned error: %v", err)
	}
	if _, err := first.AIStopMCPHTTPServer(); err != nil {
		t.Fatalf("AIStopMCPHTTPServer returned error: %v", err)
	}
	first.Shutdown()

	second := newMCPHTTPTestServiceForActiveRoot(t)
	status := second.AIGetMCPHTTPServerStatus()
	if status.Enabled || status.Running {
		t.Fatalf("expected explicitly stopped MCP HTTP server to remain disabled, got %#v", status)
	}
	if starts != 1 {
		t.Fatalf("expected no startup restore after explicit stop, got %d starts", starts)
	}
}

func TestMCPHTTPServerStartupFailureKeepsEnabledPreference(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
	})

	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)
	configStore := NewProviderConfigStore(root, secretstore.NewUnavailableStore("test"))
	if err := configStore.Save(ProviderConfigStoreSnapshot{
		Providers:    []ai.ProviderConfig{},
		SafetyLevel:  ai.PermissionReadOnly,
		ContextLevel: ai.ContextSchemaOnly,
		MCPHTTPServer: ai.MCPHTTPServerConfig{
			Enabled:    true,
			Addr:       "127.0.0.1:9130",
			Path:       "/mcp",
			SchemaOnly: true,
			Token:      "gnv_restore_failure_token",
		},
	}); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	startMCPHTTPProcess = func(_ context.Context, _ mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		return nil, fmt.Errorf("listen tcp 127.0.0.1:9130: bind: address already in use")
	}

	service := newMCPHTTPTestServiceForActiveRoot(t)
	status := service.AIGetMCPHTTPServerStatus()
	if !status.Enabled || status.Running {
		t.Fatalf("expected failed startup to preserve enabled preference, got %#v", status)
	}
	if status.Token != "gnv_restore_failure_token" || !strings.Contains(status.Message, "bind: address already in use") {
		t.Fatalf("expected failed restore status to retain token and error, got %#v", status)
	}
}

func TestMCPHTTPCommandProcessStopTreatsRequestedCancelAsSuccess(t *testing.T) {
	cmdCtx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(cmdCtx, os.Args[0], "-test.run=TestMCPHTTPCommandProcessStopHelper")
	cmd.Env = append(os.Environ(), "GONAVI_MCP_HTTP_STOP_HELPER=1")
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("start helper process: %v", err)
	}

	process := &mcpHTTPCommandProcess{
		cancel: cancel,
		cmd:    cmd,
		done:   make(chan struct{}),
	}
	go process.wait()

	stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer stopCancel()
	if err := process.Stop(stopCtx); err != nil {
		t.Fatalf("expected requested stop to ignore process kill error, got %v", err)
	}
}

func TestMCPHTTPCommandProcessStopHelper(t *testing.T) {
	if os.Getenv("GONAVI_MCP_HTTP_STOP_HELPER") != "1" {
		return
	}
	select {}
}
