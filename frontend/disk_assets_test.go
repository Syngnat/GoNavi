package frontend

import (
	"archive/tar"
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/andybalholm/brotli"
)

func buildTestBundle(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var tarBuf bytes.Buffer
	writer := tar.NewWriter(&tarBuf)
	for name, content := range files {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatalf("write tar header: %v", err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatalf("write tar body: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close tar writer: %v", err)
	}
	var bundle bytes.Buffer
	brotliWriter := brotli.NewWriter(&bundle)
	if _, err := brotliWriter.Write(tarBuf.Bytes()); err != nil {
		t.Fatalf("compress bundle: %v", err)
	}
	if err := brotliWriter.Close(); err != nil {
		t.Fatalf("close brotli writer: %v", err)
	}
	return bundle.Bytes()
}

func TestDiskAssetFSExtractsAndReusesCache(t *testing.T) {
	cacheRoot := t.TempDir()
	bundle := buildTestBundle(t, map[string]string{
		"index.html":         "<!doctype html>",
		"assets/main-abc.js": "console.log(1)",
		"assets/deep/x.css":  "body{}",
	})

	fsys, err := newDiskAssetFS(bundle, cacheRoot)
	if err != nil {
		t.Fatalf("newDiskAssetFS: %v", err)
	}
	data, err := fs.ReadFile(fsys, "assets/main-abc.js")
	if err != nil {
		t.Fatalf("read extracted asset: %v", err)
	}
	if string(data) != "console.log(1)" {
		t.Fatalf("asset content = %q", data)
	}
	if _, err := fs.Stat(fsys, "assets/deep/x.css"); err != nil {
		t.Fatalf("nested asset missing: %v", err)
	}

	// A second call must reuse the completed directory instead of extracting again.
	entries, err := os.ReadDir(filepath.Join(cacheRoot, "GoNavi"))
	if err != nil {
		t.Fatalf("read cache root: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("cache dirs = %d, want 1", len(entries))
	}
	if _, err := newDiskAssetFS(bundle, cacheRoot); err != nil {
		t.Fatalf("reuse cache: %v", err)
	}
}

func TestDiskAssetFSRejectsTraversalEntries(t *testing.T) {
	cacheRoot := t.TempDir()
	bundle := buildTestBundle(t, map[string]string{
		"../escape.txt": "nope",
		"ok.txt":        "ok",
	})
	fsys, err := newDiskAssetFS(bundle, cacheRoot)
	if err != nil {
		t.Fatalf("newDiskAssetFS: %v", err)
	}
	if _, err := fs.ReadFile(fsys, "ok.txt"); err != nil {
		t.Fatalf("expected valid file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cacheRoot, "escape.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("traversal entry escaped the cache dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cacheRoot, "..", "escape.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("traversal entry escaped the cache root: %v", err)
	}
}

func TestDiskAssetFSReportsCorruptBundle(t *testing.T) {
	_, err := newDiskAssetFS([]byte("not brotli"), t.TempDir())
	if err == nil {
		t.Fatal("expected an error for a corrupt bundle")
	}
}
