package pluginmarket

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
)

// DownloadSourceID returns the original source bound to an active verified download receipt.
// The path must be the exact value returned by this Service's Download, before cleanup.
// It does not use current Settings or reverify bytes; the host must still verify approved content before installation.
func (s *Service) DownloadSourceID(path string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	receipt, exists := s.receipts[path]
	if !exists {
		return "", ErrInvalidRequest
	}
	return receipt.sourceID, nil
}

// RecordInstall persists provenance only for this service's verified download receipt after host installation succeeds.
// It records the original source even if configuration changed meanwhile; it never trusts a path supplied without a receipt.
func (s *Service) RecordInstall(ctx context.Context, id, path, contentDigest string) error {
	if !validID(id) || !digestPattern.MatchString(contentDigest) {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	receipt, exists := s.receipts[path]
	s.mu.Unlock()
	if !exists || receipt.id != id {
		return ErrInvalidRequest
	}
	if err := verifyReceipt(ctx, path, receipt); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, exists := s.receipts[path]
	if !exists || current != receipt {
		return ErrInvalidRequest
	}
	store := s
	if s.owner != nil {
		store = s.owner
		store.mu.Lock()
		defer store.mu.Unlock()
	}
	if previous, exists := store.state.Installs[id]; exists && previous.SourceID != receipt.sourceID {
		return ErrSourceMismatch
	}
	next := store.state
	next.Installs = maps.Clone(store.state.Installs)
	if len(next.Installs) >= 4096 {
		if _, exists := next.Installs[id]; !exists {
			return ErrInvalidRequest
		}
	}
	next.Installs[id] = installedSource{SourceID: receipt.sourceID, Version: receipt.version, TransportSHA256: receipt.digest, ContentDigest: contentDigest}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := atomicJSON(filepath.Join(store.root, "settings.json"), next, maxStateBytes); err != nil {
		return fmt.Errorf("record marketplace install provenance: %w", err)
	}
	store.state = next
	return nil
}

// VerifyInstallSource rejects updates to an existing runtime package unless its canonical digest and source match recorded provenance.
// The host must call this for every existing runtime record, including sideloaded and manually modified packages.
func (s *Service) VerifyInstallSource(ctx context.Context, id, contentDigest string) error {
	if !validID(id) || !digestPattern.MatchString(contentDigest) {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	store := s
	if s.owner != nil {
		store = s.owner
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if s.lease != nil && !s.lease.Load() {
		return ErrSourceChanged
	}
	record, exists := store.state.Installs[id]
	if !exists || record.ContentDigest != contentDigest || record.SourceID != sourceID(s.state.BaseURL) {
		return ErrSourceMismatch
	}
	return nil
}

// ForgetInstall removes source binding after the host removes a plugin or explicitly replaces it with a sideload.
func (s *Service) ForgetInstall(ctx context.Context, id string) error {
	if s.owner != nil {
		return s.owner.ForgetInstall(ctx, id)
	}
	if !validID(id) {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.state.Installs[id]; !exists {
		return nil
	}
	next := s.state
	next.Installs = maps.Clone(s.state.Installs)
	delete(next.Installs, id)
	if err := atomicJSON(filepath.Join(s.root, "settings.json"), next, maxStateBytes); err != nil {
		return fmt.Errorf("forget marketplace install provenance: %w", err)
	}
	s.state = next
	return nil
}

func verifyReceipt(ctx context.Context, path string, receipt downloadReceipt) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect marketplace receipt: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() != receipt.size {
		return ErrDigestMismatch
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open marketplace receipt: %w", err)
	}
	defer file.Close()
	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: file}
	size, err := io.Copy(hash, io.LimitReader(reader, receipt.size+1))
	if err != nil {
		return fmt.Errorf("verify marketplace receipt: %w", err)
	}
	if size != receipt.size || hex.EncodeToString(hash.Sum(nil)) != receipt.digest {
		return ErrDigestMismatch
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
