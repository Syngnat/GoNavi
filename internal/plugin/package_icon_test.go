package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAIProviderIconMustBePackagedFile(t *testing.T) {
	m := aiProviderManifest()
	m.Contributes.AIProviders[0].Icon = "icons/provider.png"
	dir := t.TempDir()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, manifestName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "plugin"), []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(dir, "icons"), 0o700); err != nil {
		t.Fatal(err)
	}
	icon := filepath.Join(dir, "icons", "provider.png")
	if err = os.WriteFile(icon, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err = InspectPackage(context.Background(), dir); err != nil {
		t.Fatalf("packaged icon rejected: %v", err)
	}
	if err = os.WriteFile(icon, make([]byte, maxPackageIconBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err = InspectPackage(context.Background(), dir); err == nil {
		t.Fatal("oversized declared provider icon accepted")
	}
	if err = os.WriteFile(icon, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(icon); err != nil {
		t.Fatal(err)
	}
	if _, err = InspectPackage(context.Background(), dir); err == nil {
		t.Fatal("missing declared provider icon accepted")
	}
}
