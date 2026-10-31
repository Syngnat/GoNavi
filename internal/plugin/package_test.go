package plugin

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writePackage(t *testing.T, m Manifest) string {
	t.Helper()
	dir := t.TempDir()
	content, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, manifestName), content, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "asset.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}
func archivePackage(t *testing.T, source, format string) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), "package."+format)
	f, err := os.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		t.Fatal(err)
	}
	if format == "zip" {
		writer := zip.NewWriter(f)
		for _, entry := range entries {
			content, err := os.ReadFile(filepath.Join(source, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			file, err := writer.Create(entry.Name())
			if err != nil {
				t.Fatal(err)
			}
			if _, err = file.Write(content); err != nil {
				t.Fatal(err)
			}
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
	} else {
		gz := gzip.NewWriter(f)
		writer := tar.NewWriter(gz)
		for _, entry := range entries {
			content, err := os.ReadFile(filepath.Join(source, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			if err = writer.WriteHeader(&tar.Header{Name: entry.Name(), Mode: 0600, Size: int64(len(content))}); err != nil {
				t.Fatal(err)
			}
			if _, err = writer.Write(content); err != nil {
				t.Fatal(err)
			}
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err = gz.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	return target
}
func TestPackageDigestIsTransportIndependent(t *testing.T) {
	source := writePackage(t, basicManifest("test.package"))
	ctx := context.Background()
	directory, err := InspectPackage(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"zip", "tgz"} {
		t.Run(format, func(t *testing.T) {
			inspection, err := InspectPackage(ctx, archivePackage(t, source, format))
			if err != nil {
				t.Fatal(err)
			}
			if inspection.Digest != directory.Digest || inspection.SizeBytes != directory.SizeBytes {
				t.Fatal("transport changed canonical digest")
			}
		})
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = InspectPackage(canceled, source); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
func TestInstallTrustDigestAndIsolation(t *testing.T) {
	m := testManager(t)
	ctx := context.Background()
	source := writePackage(t, basicManifest("test.package"))
	inspection, err := m.Inspect(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Install(ctx, InstallRequest{Path: source, Digest: inspection.Digest}); err == nil {
		t.Fatal("untrusted install accepted")
	}
	if err = os.WriteFile(filepath.Join(source, "asset.txt"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Install(ctx, InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true}); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("changed package: %v", err)
	}
	inspection, err = m.Inspect(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	status, err := m.Install(ctx, InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true})
	if err != nil {
		t.Fatal(err)
	}
	if status.DesiredEnabled || status.State != StateDisabled {
		t.Fatal("install activated code")
	}
	if _, err = m.AssetPath(status.Manifest.ID, "asset.txt"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled assets: %v", err)
	}
	if err = os.WriteFile(filepath.Join(source, "asset.txt"), []byte("source changed again"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetEnabled(ctx, status.Manifest.ID, true); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, status.Manifest.ID, StateRunning)
	path, err := m.AssetPath(status.Manifest.ID, "asset.txt")
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "changed" {
		t.Fatal("installed content followed mutable source")
	}
	if _, err = m.AssetPath(status.Manifest.ID, "../state.json"); err == nil {
		t.Fatal("asset escaped immutable root")
	}
}
func TestMaliciousArchives(t *testing.T) {
	for _, name := range []string{"../escape", "C:/escape", "CON", "a\\b", "/absolute"} {
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "bad.zip")
			f, err := os.Create(file)
			if err != nil {
				t.Fatal(err)
			}
			writer := zip.NewWriter(f)
			entry, err := writer.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			entry.Write([]byte("x"))
			writer.Close()
			f.Close()
			if _, err = InspectPackage(context.Background(), file); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
	t.Run("zip symlink", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "bad.zip")
		f, err := os.Create(file)
		if err != nil {
			t.Fatal(err)
		}
		writer := zip.NewWriter(f)
		header := &zip.FileHeader{Name: "link"}
		header.SetMode(os.ModeSymlink | 0777)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		entry.Write([]byte("outside"))
		writer.Close()
		f.Close()
		if _, err = InspectPackage(context.Background(), file); err == nil {
			t.Fatal("symlink accepted")
		}
	})
	t.Run("tar link", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "bad.tgz")
		f, err := os.Create(file)
		if err != nil {
			t.Fatal(err)
		}
		gz := gzip.NewWriter(f)
		writer := tar.NewWriter(gz)
		writer.WriteHeader(&tar.Header{Name: "link", Typeflag: tar.TypeLink, Linkname: "outside"})
		writer.Close()
		gz.Close()
		f.Close()
		if _, err = InspectPackage(context.Background(), file); err == nil {
			t.Fatal("tar link accepted")
		}
	})
	t.Run("case collision", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "bad.zip")
		f, err := os.Create(file)
		if err != nil {
			t.Fatal(err)
		}
		writer := zip.NewWriter(f)
		for _, name := range []string{"Asset", "asset"} {
			entry, err := writer.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			entry.Write([]byte("x"))
		}
		writer.Close()
		f.Close()
		if _, err = InspectPackage(context.Background(), file); err == nil {
			t.Fatal("case collision accepted")
		}
	})
}
