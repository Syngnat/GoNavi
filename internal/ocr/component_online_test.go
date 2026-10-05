//go:build ocrnet

package ocr

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

// TestRealComponentInstallsFromTheNetwork downloads the real component (about 13 MB)
// from the real sources and checks it against the pinned hashes. It needs network
// access, so it only runs on request:
//
//	go test ./internal/ocr -tags ocrnet -run TestRealComponent -v
//
// Run it after changing component.go, or when an installation reports a checksum
// mismatch, to see whether the pins or a source moved.
func TestRealComponentInstallsFromTheNetwork(t *testing.T) {
	manager := NewManager(filepath.Join(t.TempDir(), "ocr"), DefaultComponent(), &http.Client{})
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	last := time.Now()
	err := manager.Install(ctx, func(p Progress) {
		if time.Since(last) > 2*time.Second || p.Phase == PhaseDone {
			last = time.Now()
			t.Logf("%s %s %d/%d", p.Phase, p.File, p.Downloaded, p.Total)
		}
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !manager.Status().Installed {
		t.Fatal("installed files do not match the manifest")
	}
	base, err := manager.Serve()
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	response, err := http.Get(base + "/core/tesseract-core-simd-lstm.wasm.js")
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("serving the engine: %v %v", err, response)
	}
	_ = response.Body.Close()
}
