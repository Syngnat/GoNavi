package app

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityInvokeProcess(t *testing.T) {
	if len(os.Args) == 0 || os.Args[len(os.Args)-1] != "--capability-invoke-fixture" {
		return
	}
	decoder, encoder := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := decoder.Decode(&request); err != nil {
			os.Exit(0)
		}
		if len(request.ID) == 0 {
			continue
		}
		var result any = struct{}{}
		switch request.Method {
		case "plugin.initialize":
			result = map[string]int{"apiVersion": 1}
		case "plugin.invoke":
			if err := os.WriteFile(filepath.Join(os.Getenv("GONAVI_PLUGIN_DATA"), "received.json"), request.Params, 0600); err != nil {
				os.Exit(31)
			}
			var params struct {
				Arguments json.RawMessage `json:"arguments"`
			}
			if err := json.Unmarshal(request.Params, &params); err != nil {
				os.Exit(32)
			}
			result = params.Arguments
		}
		if err := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}); err != nil {
			os.Exit(33)
		}
		if request.Method == "plugin.shutdown" {
			os.Exit(0)
		}
	}
}

func TestPluginCapabilityInvokeRejectsStaleGenerationBeforeBackendReceivesCredentials(t *testing.T) {
	t.Setenv("GONAVI_DISABLE_PLUGINS", "")
	a := newPluginPageTestApp(t)
	manifest := pluginPageTestManifest("test.invoke.generation", plugin.PagesPermission, plugin.ConnectionsCredentialsPermission)
	executable := "backend"
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	manifest.Backend = &plugin.Backend{Default: &plugin.Entry{Executable: executable, Args: []string{"-test.run=^TestPluginCapabilityInvokeProcess$", "--", "--capability-invoke-fixture"}}}
	manifest.Contributes.Commands = []plugin.Command{{ID: "echo", Title: "Echo", InputSchema: json.RawMessage(`{"type":"object","properties":{"config":{"type":"object"}}}`)}}
	source := writePluginPageTestPackage(t, manifest)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.OpenFile(filepath.Join(source, executable), os.O_CREATE|os.O_WRONLY, 0700)
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	inputErr, outputErr := input.Close(), output.Close()
	if copyErr != nil || inputErr != nil || outputErr != nil {
		t.Fatalf("copy fixture: %v %v %v", copyErr, inputErr, outputErr)
	}
	manager, err := a.pluginManager(a.ctx)
	if err != nil {
		t.Fatal(err)
	}
	inspection, err := manager.Inspect(a.ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Install(a.ctx, plugin.InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("plugin statuses: %+v", manager.List())
		}
	})
	enablePluginPageTestPackage(t, a, manifest.ID)
	old, code := a.pluginCapabilityStatus(a.ctx, manifest.ID, 0)
	if code != "" {
		t.Fatal(code)
	}
	if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{ID: "invoke-secret", Name: "secret", Config: connection.ConnectionConfig{Type: "postgres", Host: "db.internal", Password: "old-generation-secret"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(a.ctx, manifest.ID, false); err != nil {
		t.Fatal(err)
	}
	enablePluginPageTestPackage(t, a, manifest.ID)
	current, code := a.pluginCapabilityStatus(a.ctx, manifest.ID, 0)
	if code != "" || current.Generation == old.Generation {
		t.Fatalf("generation did not advance: %+v %s", current, code)
	}
	raw, err := a.pluginCapabilityCall(a.ctx, old, pluginCapabilityChannelWindow, "plugin.invoke", json.RawMessage(`{"command":"echo","connectionId":"invoke-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := decodePluginCapabilityEnvelope(t, raw); ok {
		t.Errorf("stale invocation succeeded: %s", raw)
	}
	received := filepath.Join(a.configDir, "plugins", "data", manifest.ID, "received.json")
	if body, err := os.ReadFile(received); !os.IsNotExist(err) {
		t.Fatalf("stale invocation reached replacement runtime: body=%s err=%v", body, err)
	}
	raw, err = a.pluginCapabilityCall(a.ctx, current, pluginCapabilityChannelWindow, "plugin.invoke", json.RawMessage(`{"command":"echo","connectionId":"invoke-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code := decodePluginCapabilityEnvelope(t, raw); !ok || code != "" {
		t.Fatalf("current invocation failed: %s", raw)
	}
	body, err := os.ReadFile(received)
	if err != nil || !strings.Contains(string(body), "old-generation-secret") {
		t.Fatalf("fixture did not receive current credentials: %s %v", body, err)
	}
}

func TestPluginCapabilityInvokeRejectsUndeclaredCommands(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.invoke", plugin.PagesPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "plugin.invoke", json.RawMessage(`{"command":"missing"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("undeclared command envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.invoke", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "plugin.invoke", json.RawMessage(`{"command":"missing"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
