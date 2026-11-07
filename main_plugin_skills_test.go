//go:build !bindings && !wails3

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/plugin"
)

func TestDesktopSkillCatalogColdActivation(t *testing.T) {
	t.Setenv("GONAVI_DISABLE_PLUGINS", "")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	installColdSkill(t, ctx, root)
	application, err := app.NewHeadlessApp(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { application.Shutdown() })
	service, err := aiservice.NewMCPService(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { aiservice.ShutdownWithContext(service, context.Background()) })
	if err := app.InitializePluginExecution(ctx, application); err != nil {
		t.Fatal(err)
	}
	catalog, err := newDesktopAgentToolCatalog(application, service)
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the real desktop composition immediately after asynchronous Start.
	descriptors, err := catalog.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	name := ""
	for _, descriptor := range descriptors {
		if strings.HasPrefix(descriptor.Name, "skill__") {
			name = descriptor.Name
		}
	}
	if name == "" {
		t.Fatal("cold desktop catalog omitted its file-only skill")
	}
	_, executor, err := catalog.Resolve(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	value, err := executor.Execute(ctx, runharness.ToolExecutionRequest{ToolName: name, Effect: runharness.ToolEffectReadOnly, Arguments: json.RawMessage("{}")})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value.Value)
	if err != nil || !strings.Contains(string(encoded), "STATIC_PACKAGE_BODY") || !strings.Contains(string(encoded), `"authority":"untrusted"`) {
		t.Fatalf("wrong skill resource: %s %v", encoded, err)
	}
}

func installColdSkill(t *testing.T, ctx context.Context, root string) {
	t.Helper()
	packagePath := t.TempDir()
	manifest := plugin.Manifest{SchemaVersion: 1, APIVersion: 1, ID: "test.cold-skills", Name: "Cold Skills", Version: "1.0.0", Permissions: []string{"ai.skills"}, Contributes: plugin.Contributions{Skills: []plugin.Skill{{ID: "inspect", Name: "Inspect", Description: "Read supplied facts", Entry: "SKILL.md"}}}}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string][]byte{"gonavi.plugin.json": raw, "SKILL.md": []byte("# STATIC_PACKAGE_BODY\nRead supplied facts only.\n")} {
		if err := os.WriteFile(filepath.Join(packagePath, name), value, 0600); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := plugin.NewManager(plugin.Options{Root: filepath.Join(root, "plugins")})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close(ctx)
	inspection, err := manager.Inspect(ctx, packagePath)
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.Install(ctx, plugin.InstallRequest{Path: packagePath, Digest: inspection.Digest, Trusted: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(ctx, status.Manifest.ID, true); err != nil {
		t.Fatal(err)
	}
	// No Manager.Start, no ready polling and no skill body read occurs here.
}
