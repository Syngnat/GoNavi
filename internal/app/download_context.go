package app

import (
	"context"
	"io"
	"net/http"
	"time"
)

// contextBoundTransport ties every request issued through an *http.Client to a
// caller-owned context. The download stack below it (dispatcher resolution,
// range probes, parallel workers, sequential fallback) still creates its own
// per-request contexts, so binding the cancellation at the transport layer is
// what lets one task cancellation interrupt the whole chain, including body
// reads that are already streaming.
type contextBoundTransport struct {
	ctx  context.Context
	base http.RoundTripper
}

func newContextBoundTransport(ctx context.Context, base http.RoundTripper) *contextBoundTransport {
	if ctx == nil {
		ctx = context.Background()
	}
	if base == nil {
		base = http.DefaultTransport
	}
	return &contextBoundTransport{ctx: ctx, base: base}
}

func (t *contextBoundTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	requestCtx, cancel := context.WithCancel(req.Context())
	stop := context.AfterFunc(t.ctx, cancel)
	release := func() {
		stop()
		cancel()
	}
	resp, err := t.base.RoundTrip(req.WithContext(requestCtx))
	if err != nil {
		release()
		return nil, err
	}
	if resp.Body == nil || resp.Body == http.NoBody {
		release()
		return resp, nil
	}
	resp.Body = &releaseOnCloseBody{ReadCloser: resp.Body, release: release}
	return resp, nil
}

type releaseOnCloseBody struct {
	io.ReadCloser
	release func()
}

func (b *releaseOnCloseBody) Close() error {
	err := b.ReadCloser.Close()
	if b.release != nil {
		b.release()
		b.release = nil
	}
	return err
}

// cloneTransportWithResponseHeaderTimeout returns a copy of transport with the
// given ResponseHeaderTimeout, preserving a context binding when present. It
// returns nil when the transport type is unknown so callers keep the original.
func cloneTransportWithResponseHeaderTimeout(transport http.RoundTripper, timeout time.Duration) http.RoundTripper {
	switch typed := transport.(type) {
	case *http.Transport:
		if typed == nil {
			return nil
		}
		cloned := typed.Clone()
		cloned.ResponseHeaderTimeout = timeout
		return cloned
	case *contextBoundTransport:
		if typed == nil {
			return nil
		}
		base := cloneTransportWithResponseHeaderTimeout(typed.base, timeout)
		if base == nil {
			return nil
		}
		return newContextBoundTransport(typed.ctx, base)
	default:
		return nil
	}
}

// newStrictDownloadHTTPClientWithContext builds the strict HTTPS download
// client used by driver installs and binds it to ctx so the task cancellation
// reaches in-flight requests and streaming bodies.
func newStrictDownloadHTTPClientWithContext(ctx context.Context, timeout time.Duration) *http.Client {
	client := newStrictHTTPClientWithGlobalProxy(timeout)
	client.Transport = newContextBoundTransport(ctx, client.Transport)
	return client
}

// downloadFileWithHashWithExpectedSizeContext mirrors
// downloadFileWithHashWithExpectedSize but binds the whole request chain to ctx,
// so an update download that the user cancels stops streaming immediately
// instead of running to completion in the background.
func downloadFileWithHashWithExpectedSizeContext(ctx context.Context, url, filePath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
	return downloadFileWithHashWithExpectedSizeContextPreferred(ctx, url, filePath, onProgress, expectedSize, DownloadSourceCst)
}

// downloadFileWithHashWithExpectedSizeContextPreferred is the canceled-aware
// variant used when the update task has a preferred download source.
func downloadFileWithHashWithExpectedSizeContextPreferred(ctx context.Context, url, filePath string, onProgress func(downloaded, total int64), expectedSize int64, preferred DownloadSource) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	client := newStrictDownloadHTTPClientWithContext(ctx, 10*time.Minute)
	hash, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClientPreferred(client, url, filePath, onProgress, expectedSize, preferred)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			// The transport-level failure is a consequence of the cancellation.
			// Surface the context error so callers can classify it reliably.
			return "", ctxErr
		}
		return "", err
	}
	return hash, nil
}

// downloadFileWithHashPreferredForAppContext mirrors
// downloadFileWithHashPreferredForApp but lets the caller cancel the download.
func downloadFileWithHashPreferredForAppContext(ctx context.Context, a *App, url, filePath string, onProgress func(downloaded, total int64)) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	preferred := DownloadSourceCst
	if a != nil {
		preferred = a.preferredDownloadSource()
	}
	client := newStrictDownloadHTTPClientWithContext(ctx, 10*time.Minute)
	hash, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClientPreferred(client, url, filePath, onProgress, 0, preferred)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			// The transport-level failure is a consequence of the cancellation.
			// Surface the context error so callers can classify it reliably.
			return "", ctxErr
		}
		return "", err
	}
	return hash, nil
}
