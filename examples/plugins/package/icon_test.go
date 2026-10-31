package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	plugin "github.com/Syngnat/GoNavi/sdk/go"
)

func TestCopyDeclaredAIProviderIcons(t *testing.T) {
	root := t.TempDir()
	manifestDir := filepath.Join(root, "source")
	output := filepath.Join(root, "output")
	if err := os.MkdirAll(filepath.Join(manifestDir, "icons"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(output, 0700); err != nil {
		t.Fatal(err)
	}
	payload := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	if err := os.WriteFile(filepath.Join(manifestDir, "icons", "provider.png"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := plugin.Manifest{Contributes: &plugin.Contributions{AIProviders: []plugin.AIProvider{{Icon: "icons/provider.png"}}}}
	if err := copyDeclaredAIProviderIcons(manifest, manifestDir, output); err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(filepath.Join(output, "icons", "provider.png"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(copied, payload) {
		t.Fatalf("icon bytes changed: %x", copied)
	}

	manifest.Contributes.AIProviders[0].Icon = "../escape.png"
	if err := copyDeclaredAIProviderIcons(manifest, manifestDir, output); err == nil {
		t.Fatal("path traversal icon was copied")
	}
	manifest.Contributes.AIProviders[0].Icon = "icons/missing.png"
	if err := copyDeclaredAIProviderIcons(manifest, manifestDir, output); err == nil {
		t.Fatal("missing icon was accepted")
	}
	manifest.Contributes.AIProviders[0].Icon = ""
	if err := copyDeclaredAIProviderIcons(manifest, manifestDir, output); err != nil {
		t.Fatalf("empty icon should be ignored: %v", err)
	}
}
