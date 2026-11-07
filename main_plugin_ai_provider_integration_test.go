//go:build !bindings && !wails3

package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/plugin"
)

func TestDesktopPluginAIProviderColdSubmitRealHTTP(t *testing.T) {
	t.Setenv("GONAVI_DISABLE_PLUGINS", "")
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"desktop native\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(upstream.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	root := t.TempDir()
	examples, err := filepath.Abs("examples/plugins")
	if err != nil {
		t.Fatal(err)
	}
	installNativeAIProviderFixture(t, ctx, root, examples)
	application, err := app.NewHeadlessApp(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Shutdown)
	service, err := aiservice.NewMCPService(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { aiservice.ShutdownWithContext(service, context.Background()) })
	if err := configureDesktopPluginAIProvider(application, service); err != nil {
		t.Fatal(err)
	}
	config := ai.ProviderConfig{ID: "desktop-native", Type: "plugin:sdk.examples.aiprovider:http", Name: "Local fixture", BaseURL: upstream.URL + "/v1", APIKey: "desktop-test-key", Model: "gpt-4o-mini"}
	if err := service.AISaveProvider(config); err != nil {
		t.Fatal(err)
	}
	if err := app.InitializePluginExecution(ctx, application); err != nil {
		t.Fatal(err)
	}
	// No fixture wait: actual submit must bind the already-starting local owner.
	receipt, err := service.AISubmitAgentInput(runharness.AgentInputRequest{RequestID: "desktop-native-cold", Provider: config.ID, Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		read, err := service.AIReadAgentRun(runharness.RunReadRequest{RunID: receipt.RunID})
		if err != nil {
			t.Fatal(err)
		}
		if read.Run.State.Terminal() {
			if read.Run.State != runharness.RunStateCompleted || calls.Load() != 1 {
				t.Fatalf("desktop run=%s calls=%d reason=%s", read.Run.State, calls.Load(), read.Run.TerminalReason)
			}
			return
		}
		select {
		case <-tick.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func installNativeAIProviderFixture(t *testing.T, ctx context.Context, root, examples string) {
	t.Helper()
	output := filepath.Join(t.TempDir(), "package")
	command := exec.CommandContext(ctx, "go", "-C", examples, "run", "./package", "-source", "./ai-provider", "-manifest", "./ai-provider/gonavi.plugin.json", "-output", output)
	command.Env = append(os.Environ(), "GOPROXY=off", "GOSUMDB=off", "GOTOOLCHAIN=local")
	if result, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native example build: %v\n%s", err, result)
	}
	manager, err := plugin.NewManager(plugin.Options{Root: filepath.Join(root, "plugins")})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close(ctx)
	inspection, err := manager.Inspect(ctx, output)
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.Install(ctx, plugin.InstallRequest{Path: output, Digest: inspection.Digest, Trusted: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(ctx, status.Manifest.ID, true); err != nil {
		t.Fatal(err)
	}
}
