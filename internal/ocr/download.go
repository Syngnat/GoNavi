package ocr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// attemptTimeout bounds one download attempt of one file; a slow link still has
// minutes for a few megabytes, a stalled one does not hang the installation.
const attemptTimeout = 5 * time.Minute

// downloadFile fetches a file from the first source that delivers exactly the
// pinned bytes into dir. A source that answers with another status, a short or
// long body, or a different hash is skipped; cancellation stops the whole thing.
func downloadFile(ctx context.Context, client *http.Client, file File, dir string, onBytes func(int64)) error {
	if !validRelativePath(file.Path) {
		return fmt.Errorf("invalid component path %q", file.Path)
	}
	target := filepath.Join(dir, filepath.FromSlash(file.Path))
	var lastErr error
	for _, source := range file.URLs {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := fetchVerified(ctx, client, source, file, target, onBytes)
		if err == nil {
			return nil
		}
		lastErr = err
		_ = os.Remove(target)
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no download source")
	}
	return fmt.Errorf("download %s from %d source(s): %w", file.Path, len(file.URLs), lastErr)
}

// fetchVerified downloads one URL to target once the size and SHA-256 match. The
// bytes are reported to onBytes as they arrive; if the attempt then fails, what was
// reported is taken back, so the caller's count only ever includes good bytes. No
// error mentions the URL: errors are shown to people.
func fetchVerified(ctx context.Context, client *http.Client, source string, file File, target string, onBytes func(int64)) (err error) {
	ctx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", response.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	hash := sha256.New()
	counter := &countingWriter{onBytes: onBytes}
	defer func() {
		if err != nil {
			onBytes(-counter.n)
		}
	}()
	// One byte more than expected: a longer body is then seen as longer, not cut to fit.
	written, copyErr := io.Copy(io.MultiWriter(out, hash, counter), io.LimitReader(response.Body, file.Size+1))
	closeErr := out.Close()
	switch {
	case copyErr != nil:
		return fmt.Errorf("read body: %w", copyErr)
	case closeErr != nil:
		return fmt.Errorf("write file: %w", closeErr)
	case written != file.Size:
		return fmt.Errorf("size mismatch: got %d bytes, want %d", written, file.Size)
	case hex.EncodeToString(hash.Sum(nil)) != file.SHA256:
		return fmt.Errorf("checksum mismatch")
	}
	return nil
}

// countingWriter reports every chunk written through it.
type countingWriter struct {
	n       int64
	onBytes func(int64)
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.n += int64(len(p))
	w.onBytes(int64(len(p)))
	return len(p), nil
}
