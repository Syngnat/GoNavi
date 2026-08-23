package app

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const importSourceIdentitySampleBytes int64 = 64 * 1024

// ImportSourceIdentity binds a preview and any later checkpoint to the exact
// local source selected by the user without forcing a multi-gigabyte preview
// to hash the whole file.
type ImportSourceIdentity struct {
	Size             int64  `json:"size"`
	ModifiedUnixNano int64  `json:"modifiedUnixNano"`
	QuickSHA256      string `json:"quickSha256"`
	Token            string `json:"token"`
}

func captureImportSourceIdentity(filePath string) (ImportSourceIdentity, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return ImportSourceIdentity{}, err
	}
	absPath = filepath.Clean(absPath)
	f, err := os.Open(absPath)
	if err != nil {
		return ImportSourceIdentity{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ImportSourceIdentity{}, err
	}
	if !info.Mode().IsRegular() {
		return ImportSourceIdentity{}, fmt.Errorf("import source is not a regular file")
	}

	quickHash, err := hashImportSourceSamples(f, info.Size())
	if err != nil {
		return ImportSourceIdentity{}, err
	}
	modified := info.ModTime().UnixNano()
	tokenHasher := sha256.New()
	_, _ = fmt.Fprintf(tokenHasher, "%s\x00%d\x00%d\x00%s", absPath, info.Size(), modified, quickHash)
	return ImportSourceIdentity{
		Size:             info.Size(),
		ModifiedUnixNano: modified,
		QuickSHA256:      quickHash,
		Token:            hex.EncodeToString(tokenHasher.Sum(nil)),
	}, nil
}

func hashImportSourceSamples(f *os.File, size int64) (string, error) {
	hasher := sha256.New()
	if size <= importSourceIdentitySampleBytes*2 {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
		if _, err := io.Copy(hasher, io.LimitReader(f, size)); err != nil {
			return "", err
		}
		return hex.EncodeToString(hasher.Sum(nil)), nil
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if _, err := io.Copy(hasher, io.LimitReader(f, importSourceIdentitySampleBytes)); err != nil {
		return "", err
	}
	if _, err := f.Seek(size-importSourceIdentitySampleBytes, io.SeekStart); err != nil {
		return "", err
	}
	if _, err := io.Copy(hasher, io.LimitReader(f, importSourceIdentitySampleBytes)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func validateImportSourceIdentity(filePath string, expected ImportSourceIdentity) error {
	if expected.Token == "" {
		return nil
	}
	actual, err := captureImportSourceIdentity(filePath)
	if err != nil {
		return err
	}
	if actual.Token != expected.Token {
		return fmt.Errorf("import source changed after preview")
	}
	return nil
}
