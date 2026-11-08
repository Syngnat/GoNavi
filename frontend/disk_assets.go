package frontend

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
)

const (
	assetCacheDirName   = "frontend-assets"
	assetCacheMarker    = ".complete"
	assetCacheTempGlob  = ".tmp-"
	assetCacheDirPrefix = "frontend-assets-"
)

// loadBundledAssets serves the frontend from a per-version directory inside the
// user cache directory. Keeping the decompressed bundle out of the Go heap
// saves roughly 37 MB of resident memory; browsers read the files back through
// the OS page cache. Any extraction problem falls back to the in-memory FS.
func loadBundledAssets(bundle []byte) fs.FS {
	cacheRoot, err := os.UserCacheDir()
	if err == nil && strings.TrimSpace(cacheRoot) != "" {
		if fsys, err := newDiskAssetFS(bundle, cacheRoot); err == nil {
			return fsys
		}
	}
	return newBundleAssetFS(bundle)
}

// newDiskAssetFS extracts the bundle into <cacheRoot>/GoNavi/frontend-assets-
// <content hash> and returns a filesystem rooted there. The content hash makes
// upgrades and multiple installs side-effect free: an existing directory is
// reused without touching the files.
func newDiskAssetFS(bundle []byte, cacheRoot string) (fs.FS, error) {
	sum := sha256.Sum256(bundle)
	version := hex.EncodeToString(sum[:8])
	base := filepath.Join(cacheRoot, "GoNavi")
	target := filepath.Join(base, assetCacheDirPrefix+version)

	if assetDirComplete(target) {
		go removeStaleAssetDirs(base, filepath.Base(target))
		return os.DirFS(target), nil
	}
	if err := extractBundleToDir(bundle, base, target); err != nil {
		return nil, err
	}
	go removeStaleAssetDirs(base, filepath.Base(target))
	return os.DirFS(target), nil
}

func assetDirComplete(dir string) bool {
	info, err := os.Lstat(filepath.Join(dir, assetCacheMarker))
	return err == nil && info.Mode().IsRegular()
}

func extractBundleToDir(bundle []byte, base, target string) error {
	if err := os.MkdirAll(base, 0o755); err != nil {
		return fmt.Errorf("create asset cache root: %w", err)
	}
	temp := filepath.Join(base, assetCacheTempGlob+fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()))
	if err := os.MkdirAll(temp, 0o755); err != nil {
		return fmt.Errorf("create asset cache temp dir: %w", err)
	}
	defer os.RemoveAll(temp)

	if err := writeBundleFiles(bundle, temp); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(temp, assetCacheMarker), nil, 0o644); err != nil {
		return fmt.Errorf("write asset cache marker: %w", err)
	}
	if err := os.Rename(temp, target); err != nil {
		// Another process may have extracted the same version concurrently.
		if assetDirComplete(target) {
			return nil
		}
		// A previous run may have crashed mid-extraction and left an
		// incomplete directory behind; replace it once.
		if removeErr := os.RemoveAll(target); removeErr == nil {
			if retryErr := os.Rename(temp, target); retryErr == nil {
				return nil
			}
		}
		return fmt.Errorf("publish asset cache: %w", err)
	}
	return nil
}

func writeBundleFiles(bundle []byte, dir string) error {
	reader := tar.NewReader(brotli.NewReader(bytes.NewReader(bundle)))
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read asset bundle: %w", err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		name := path.Clean(header.Name)
		if !fs.ValidPath(name) || name == "." {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		if !strings.HasPrefix(target, dir+string(filepath.Separator)) {
			return fmt.Errorf("asset path escapes cache dir: %q", header.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("create asset dir for %q: %w", name, err)
		}
		file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return fmt.Errorf("create asset file %q: %w", name, err)
		}
		_, copyErr := io.Copy(file, reader)
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("write asset file %q: %w", name, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close asset file %q: %w", name, closeErr)
		}
	}
}

// removeStaleAssetDirs drops cache directories from other bundle versions.
// Failures are expected when another running instance still serves from them
// and are simply retried on a later launch.
func removeStaleAssetDirs(base, current string) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || name == current || !strings.HasPrefix(name, assetCacheDirPrefix) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(base, name))
	}
}
