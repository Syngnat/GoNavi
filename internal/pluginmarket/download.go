package pluginmarket

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

type downloadReceipt struct {
	id       string
	version  string
	digest   string
	sourceID string
	size     int64
}

// Download verifies the user-selected transport SHA, size, origin and platform before returning a private ZIP/TGZ file.
// The host must separately Inspect these bytes, confirm plugin identity/version, then Install using the canonical digest.
// Always call cleanup after installation or preview; RecordInstall must precede cleanup after a successful installation.
func (s *Service) Download(ctx context.Context, id, version, digest string) (string, func(), error) {
	noop := func() {}
	if !validID(id) || !validVersion(version) || !digestPattern.MatchString(digest) {
		return "", noop, ErrInvalidRequest
	}
	source, err := s.snapshot()
	if err != nil {
		return "", noop, err
	}
	if err = s.reserveDownload(source, id); err != nil {
		return "", noop, err
	}
	defer s.releaseDownload()
	var artifact Artifact
	query := url.Values{"platform": {runtime.GOOS + "/" + runtime.GOARCH}}
	route := "/plugins/" + id + "/versions/" + version + "/artifact"
	if err = s.requestJSON(ctx, source, http.MethodGet, route, query, nil, &artifact); err != nil {
		return "", noop, err
	}
	if err = validateArtifact(artifact, version); err != nil {
		return "", noop, err
	}
	if artifact.Platform != "any" && artifact.Platform != runtime.GOOS+"/"+runtime.GOARCH {
		return "", noop, ErrInvalidResponse
	}
	if artifact.SHA256 != digest {
		return "", noop, ErrDigestMismatch
	}
	target, err := sameOrigin(source.base, artifact.URL)
	if err != nil || artifact.URL == "" {
		return "", noop, ErrInvalidURL
	}
	path, err := s.fetchArchive(ctx, target, artifact)
	if err != nil {
		return "", noop, err
	}
	s.mu.Lock()
	err = s.reserveReceiptLocked(source, id, path, downloadReceipt{id: id, version: version, digest: digest, sourceID: source.id, size: artifact.SizeBytes})
	s.mu.Unlock()
	if err != nil {
		removeTemporary(path)
		return "", noop, err
	}
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			s.mu.Lock()
			s.releaseReceiptLocked(path)
			s.mu.Unlock()
			removeTemporary(path)
		})
	}
	return path, cleanup, nil
}

func validateArtifact(artifact Artifact, version string) error {
	if !digestPattern.MatchString(artifact.SHA256) || artifact.Version != version || artifact.SizeBytes <= 0 ||
		artifact.SizeBytes > maxArchiveBytes || len(artifact.Platform) == 0 || len(artifact.Platform) > 64 {
		return ErrInvalidResponse
	}
	return nil
}

func (s *Service) fetchArchive(ctx context.Context, target string, artifact Artifact) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", &requestError{cause: err}
	}
	// Archive digest identifies transfer bytes, not transparently decompressed HTTP content.
	request.Header.Set("Accept-Encoding", "identity")
	response, err := s.downloadClient.Do(request)
	if err != nil {
		return "", &requestError{cause: err}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		data, readErr := readBounded(response.Body, maxJSONBytes)
		if readErr != nil {
			return "", &requestError{cause: readErr}
		}
		return "", responseError(response.StatusCode, data)
	}
	if response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" {
		return "", ErrInvalidResponse
	}
	if response.ContentLength >= 0 && response.ContentLength != artifact.SizeBytes {
		return "", ErrInvalidResponse
	}
	directory := filepath.Join(s.root, "downloads")
	if err = os.MkdirAll(directory, 0700); err != nil {
		return "", fmt.Errorf("create marketplace download directory: %w", err)
	}
	file, err := os.CreateTemp(directory, "archive-*.download")
	if err != nil {
		return "", fmt.Errorf("create marketplace download: %w", err)
	}
	path := file.Name()
	keep := false
	defer func() {
		if !keep {
			removeTemporary(path)
		}
	}()
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, artifact.SizeBytes+1))
	if err != nil {
		return "", &requestError{cause: err}
	}
	if size != artifact.SizeBytes {
		return "", ErrInvalidResponse
	}
	if hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return "", ErrDigestMismatch
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	suffix, err := archiveSuffix(file)
	if err != nil {
		return "", err
	}
	if err = file.Sync(); err != nil {
		return "", fmt.Errorf("sync marketplace download: %w", err)
	}
	if err = file.Close(); err != nil {
		return "", fmt.Errorf("close marketplace download: %w", err)
	}
	renamed := path + suffix
	if err = os.Rename(path, renamed); err != nil {
		return "", fmt.Errorf("name marketplace archive: %w", err)
	}
	keep = true
	return renamed, nil
}

func archiveSuffix(file *os.File) (string, error) {
	var magic [4]byte
	if _, err := file.ReadAt(magic[:], 0); err != nil {
		return "", ErrInvalidResponse
	}
	if magic[0] == 0x1f && magic[1] == 0x8b {
		return ".tgz", nil
	}
	if magic[0] == 'P' && magic[1] == 'K' && ((magic[2] == 3 && magic[3] == 4) || (magic[2] == 5 && magic[3] == 6)) {
		return ".zip", nil
	}
	return "", ErrInvalidResponse
}

func (s *Service) reserveDownload(source sourceSnapshot, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkInstallSourceLocked(source, id); err != nil {
		return err
	}
	owner := s.downloadOwner()
	if owner != s {
		owner.mu.Lock()
		defer owner.mu.Unlock()
	}
	if owner.downloadsInFlight >= 4 || len(s.receipts) >= 32 || owner.totalReceipts >= 32 {
		return ErrBusy
	}
	owner.downloadsInFlight++
	return nil
}

func (s *Service) releaseDownload() {
	owner := s.downloadOwner()
	owner.mu.Lock()
	owner.downloadsInFlight--
	owner.mu.Unlock()
}

func (s *Service) checkInstallSourceLocked(source sourceSnapshot, id string) error {
	if err := s.checkSourceLocked(source); err != nil {
		return err
	}
	owner := s.downloadOwner()
	if owner != s {
		owner.mu.Lock()
		defer owner.mu.Unlock()
	}
	if installed, exists := owner.state.Installs[id]; exists && installed.SourceID != source.id {
		return ErrSourceMismatch
	}
	return nil
}
