package provider

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCodexModelCatalog(t *testing.T) {
	now := time.Now()
	for _, test := range []struct {
		name, contents string
		age            time.Duration
		missing        bool
		wantError      bool
		wantStale      bool
		wantModels     []string
	}{
		{name: "visible identifiers only", contents: `{"models":[{"slug":"model-b","visibility":"list","instructions":"must never appear"},{"slug":"hidden-model","visibility":"hide"},{"slug":"model-a","visibility":"list"},{"slug":"model-b","visibility":"list"},{"slug":"","visibility":"list"},{"slug":"unlisted"},{"slug":"invalid model","visibility":"list"}]}`, wantModels: []string{"model-b", "model-a"}},
		{name: "empty", contents: `{"models":[]}`, wantModels: []string{}},
		{name: "stale", contents: `{"models":[{"slug":"old","visibility":"list"}]}`, age: 25 * time.Hour, wantStale: true, wantModels: []string{}},
		{name: "future timestamp", contents: `{}`, age: -time.Hour, wantStale: true, wantModels: []string{}},
		{name: "missing", missing: true, wantError: true},
		{name: "invalid JSON", contents: `{`, wantError: true},
		{name: "trailing JSON", contents: `{"models":[]} {}`, wantError: true},
		{name: "wrong model type", contents: `{"models":[{"slug":1}]}`, wantError: true},
		{name: "oversize", contents: strings.Repeat(" ", codexModelCatalogMaxBytes+1), wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			filePath := filepath.Join(t.TempDir(), "models_cache.json")
			if !test.missing {
				if err := os.WriteFile(filePath, []byte(test.contents), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(filePath, now.Add(-test.age), now.Add(-test.age)); err != nil {
					t.Fatal(err)
				}
			}
			catalog, err := readCodexModelCatalog(filePath, now)
			if (err != nil) != test.wantError || catalog.Source != "cache" || catalog.Stale != test.wantStale {
				t.Fatalf("unexpected catalog outcome: %+v %v", catalog, err)
			}
			if err == nil && !reflect.DeepEqual(catalog.Models, test.wantModels) {
				t.Fatalf("unexpected model identifiers: %v", catalog.Models)
			}
		})
	}
}

func TestCLIModelCatalogSources(t *testing.T) {
	original, originalLookPath := cliModelCommandOutput, cliModelLookPath
	t.Cleanup(func() { cliModelCommandOutput, cliModelLookPath = original, originalLookPath })
	cliModelCommandOutput = func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("unsupported catalogs must not invoke a CLI")
		return nil, nil
	}
	for _, apiFormat := range []string{"codebuddy-cli", "unregistered-cli"} {
		capability, _ := LookupCLICapability(apiFormat)
		catalog, err := capability.ModelCatalog(context.Background())
		if err != nil || catalog.Source != "none" || catalog.Stale || len(catalog.Models) != 0 {
			t.Fatalf("must not borrow another provider's catalog: %+v %v", catalog, err)
		}
	}
	capability, _ := LookupCLICapability("codex-cli")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := capability.ModelCatalog(ctx); err != context.Canceled {
		t.Fatalf("canceled catalog must not read local state: %v", err)
	}
	cliModelLookPath = func(string) (string, error) { return "fake-grok", nil }
	cliModelCommandOutput = func(_ context.Context, command string, args ...string) ([]byte, error) {
		if command != "fake-grok" || !reflect.DeepEqual(args, []string{"models"}) {
			t.Fatal("catalog must only run the model-list command")
		}
		return []byte(" * grok-candidate\n"), nil
	}
	grok, _ := LookupCLICapability("grok-cli")
	catalog, err := grok.ModelCatalog(context.Background())
	if err != nil || catalog.Source != "cli" || !reflect.DeepEqual(catalog.Models, []string{"grok-candidate"}) {
		t.Fatalf("unexpected CLI catalog: %+v %v", catalog, err)
	}
}

func TestClaudeModelAliases(t *testing.T) {
	original, originalLookPath := cliModelCommandOutput, cliModelLookPath
	t.Cleanup(func() { cliModelCommandOutput, cliModelLookPath = original, originalLookPath })
	cliModelLookPath = func(string) (string, error) {
		t.Fatal("documented aliases must not inspect the installed CLI")
		return "", nil
	}
	cliModelCommandOutput = func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("documented aliases must not launch a CLI or check the account")
		return nil, nil
	}
	capability, _ := LookupCLICapability("claude-cli")
	catalog, err := capability.ModelCatalog(context.Background())
	if err != nil || catalog.Source != "aliases" || catalog.Stale || !reflect.DeepEqual(catalog.Models, []string{"sonnet", "opus", "haiku"}) {
		t.Fatalf("Claude suggestions must be identified as aliases: %+v %v", catalog, err)
	}
	catalog.Models[0] = "caller-edited"
	next, err := capability.ModelCatalog(context.Background())
	if err != nil || next.Models[0] != "sonnet" {
		t.Fatalf("a caller must not mutate future suggestions: %+v %v", next, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := capability.ModelCatalog(ctx); err != context.Canceled {
		t.Fatalf("canceled requests must not return candidates: %v", err)
	}
}
