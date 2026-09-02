package provider

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestCodeBuddyNVMExecutesResolvedPathAndEnvNode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("NVM and env-node launcher are Unix-only")
	}
	nvmDir := writeNvmNodeFixture(t, "v24.14.0", "codebuddy")
	bin := filepath.Join(nvmDir, "versions", "node", "v24.14.0", "bin")
	// Both hops are disposable scripts; this test never calls a real model.
	writeExecutable(t, filepath.Join(bin, "codebuddy"), "#!/usr/bin/env node\n")
	writeExecutable(t, filepath.Join(bin, "node"), "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"fixture-ok\"}'\n")
	t.Setenv("NVM_DIR", nvmDir)
	// Empty PATH guarantees neither the CLI nor a host Node can satisfy it.
	t.Setenv("PATH", t.TempDir())
	originalLookup, originalCommand := codebuddyLookPath, codebuddyCommandContext
	codebuddyLookPath, codebuddyCommandContext = lookupLocalCLICommand, exec.CommandContext
	t.Cleanup(func() { codebuddyLookPath, codebuddyCommandContext = originalLookup, originalCommand })
	p, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatal("NVM CLI must be discoverable without a PATH entry:", err)
	}
	response, err := p.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "fixture"}}})
	if err != nil || response == nil || response.Content != "fixture-ok" {
		t.Fatalf("resolved CLI and env-node must both execute: response=%v err=%v", response, err)
	}
}

func TestCLINVMEnrichmentPreservesSelectedNodeAndShimName(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shim behavior")
	}
	nvmDir := writeNvmNodeFixture(t, "v24.14.0", "node")
	bin := filepath.Join(nvmDir, "versions", "node", "v24.14.0", "bin")
	writeExecutable(t, filepath.Join(bin, "node"), "#!/bin/sh\nexit 9\n")
	preferredBin := t.TempDir()
	// A symlinked user shim depends on its invocation name ($0).
	shim := filepath.Join(preferredBin, "_shim")
	writeExecutable(t, shim, "#!/bin/sh\nprintf '%s' \"${0##*/}\"\n")
	if err := os.Symlink(shim, filepath.Join(preferredBin, "node")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NVM_DIR", nvmDir)
	t.Setenv("PATH", preferredBin)
	launcher := filepath.Join(bin, "codebuddy")
	writeExecutable(t, launcher, "#!/usr/bin/env node\n")
	cmd := exec.Command(launcher)
	cmd.Env = EnrichCLICommandPATH(os.Environ(), launcher)
	output, err := cmd.Output()
	if err != nil || string(output) != "node" {
		t.Fatalf("selected Node and shim invocation must survive NVM fallback: %q %v", output, err)
	}
}

func TestCodeBuddyResolverKeepsAbsoluteAliasPath(t *testing.T) {
	want := filepath.Join(t.TempDir(), "cbc")
	got, err := resolveCodeBuddyCLICommand(func(name string) (string, error) {
		if name == "cbc" {
			return want, nil
		}
		return "", exec.ErrNotFound
	})
	if err != nil || got != want {
		t.Fatalf("alternate name must retain its resolved path: %q %v", got, err)
	}
}
