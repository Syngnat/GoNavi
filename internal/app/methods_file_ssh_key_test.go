package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSSHKeyFileDialogDoesNotFilterExtensionlessKeys(t *testing.T) {
	if filters := sshKeyFileDialogFilters(); len(filters) != 0 {
		t.Fatalf("SSH key dialog filters = %#v, want nil/all-files filter", filters)
	}
}

func TestResolveFileOpenDialogDirectoryHandlesExtensionlessSSHKeys(t *testing.T) {
	root := t.TempDir()
	sshDir := filepath.Join(root, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatalf("mkdir .ssh: %v", err)
	}

	keyPath := filepath.Join(sshDir, "id_ed25519")
	if err := os.WriteFile(keyPath, []byte("-----BEGIN OPENSSH PRIVATE KEY-----\n"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	got := resolveFileOpenDialogDirectory(keyPath, filepath.Join(root, "fallback"))
	want := absDialogPath(sshDir)
	if got != want {
		t.Fatalf("existing extensionless key: got %q, want %q", got, want)
	}

	missingKey := filepath.Join(sshDir, "custom_deploy_key")
	got = resolveFileOpenDialogDirectory(missingKey, filepath.Join(root, "fallback"))
	if got != want {
		t.Fatalf("missing extensionless key: got %q, want %q", got, want)
	}

	got = resolveFileOpenDialogDirectory("", sshDir)
	if got != want {
		t.Fatalf("empty current path falls back to .ssh: got %q, want %q", got, want)
	}

	got = resolveFileOpenDialogDirectory(sshDir, filepath.Join(root, "fallback"))
	if got != want {
		t.Fatalf("directory path kept as-is: got %q, want %q", got, want)
	}
}
