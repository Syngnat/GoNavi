package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCaptureImportSourceIdentityDetectsSameSizeReplacement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rows.csv")
	original := []byte("id,name\n1,alice\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	identity, err := captureImportSourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Size != int64(len(original)) || identity.Token == "" {
		t.Fatalf("unexpected identity: %+v", identity)
	}

	replacement := []byte("id,name\n2,bobby\n")
	if len(replacement) != len(original) {
		t.Fatalf("test fixture must preserve file size: %d != %d", len(replacement), len(original))
	}
	if err := os.WriteFile(path, replacement, 0o600); err != nil {
		t.Fatal(err)
	}
	modifiedAt := time.Unix(0, identity.ModifiedUnixNano)
	if err := os.Chtimes(path, modifiedAt, modifiedAt); err != nil {
		t.Fatal(err)
	}

	if err := validateImportSourceIdentity(path, identity); err == nil {
		t.Fatal("same-size replacement with restored timestamp must be rejected")
	}
}

func TestValidateImportSourceIdentityAcceptsUnchangedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.json")
	if err := os.WriteFile(path, []byte(`[{"id":1}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := captureImportSourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateImportSourceIdentity(path, identity); err != nil {
		t.Fatalf("unchanged source should validate: %v", err)
	}
}
