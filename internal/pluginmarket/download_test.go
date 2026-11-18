package pluginmarket

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureArchive(t *testing.T, format string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	manifest := []byte(`{"schemaVersion":1,"apiVersion":1,"id":"publisher.plugin","name":"Example","version":"1.0.0","permissions":[]}`)
	if format == "zip" {
		writer := zip.NewWriter(&buffer)
		file, err := writer.Create("gonavi.plugin.json")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write(manifest); err != nil {
			t.Fatal(err)
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
	} else {
		compressor := gzip.NewWriter(&buffer)
		writer := tar.NewWriter(compressor)
		if err := writer.WriteHeader(&tar.Header{Name: "gonavi.plugin.json", Mode: 0600, Size: int64(len(manifest))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(manifest); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err := compressor.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return buffer.Bytes()
}

func archiveDigest(payload []byte) string {
	hash := sha256.Sum256(payload)
	return hex.EncodeToString(hash[:])
}

func artifactServer(t *testing.T, payload []byte, modify func(*Artifact), download http.HandlerFunc) (*httptest.Server, string, *atomic.Int32) {
	t.Helper()
	digest := archiveDigest(payload)
	hits := &atomic.Int32{}
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("public artifact request carried credential")
		}
		if strings.HasSuffix(r.URL.Path, "/artifact") {
			if r.URL.Query().Get("platform") == "" {
				t.Error("platform query omitted")
			}
			descriptor := Artifact{URL: base + "/api/v1/artifacts/" + digest, SHA256: digest, SizeBytes: int64(len(payload)), Platform: "any", Version: "1.0.0"}
			if modify != nil {
				modify(&descriptor)
			}
			writeTestJSON(t, w, 200, descriptor)
			return
		}
		hits.Add(1)
		if r.Header.Get("Accept-Encoding") != "identity" {
			t.Error("archive transport allowed decompression")
		}
		if download != nil {
			download(w, r)
			return
		}
		if _, err := w.Write(payload); err != nil {
			t.Errorf("write archive: %v", err)
		}
	}))
	base = server.URL
	return server, digest, hits
}

func TestVerifiedArchiveFormatsAndCleanup(t *testing.T) {
	for _, format := range []string{"zip", "tgz"} {
		t.Run(format, func(t *testing.T) {
			payload := fixtureArchive(t, format)
			server, digest, _ := artifactServer(t, payload, nil, nil)
			defer server.Close()
			service := newTestService(t, server.URL, false)
			path, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			if !strings.HasSuffix(path, "."+format) {
				t.Fatalf("runtime archive extension missing: %s", path)
			}
			downloaded, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(downloaded, payload) {
				t.Fatalf("archive bytes changed: %v", err)
			}
			cleanup()
			cleanup()
			if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("cleanup failed: %v", err)
			}
		})
	}
}

func TestDownloadRejectsUntrustedOrChangedArtifacts(t *testing.T) {
	payload := fixtureArchive(t, "zip")
	tests := []struct {
		name     string
		modify   func(*Artifact)
		download http.HandlerFunc
		want     error
		hits     int32
	}{
		{name: "descriptor digest", modify: func(a *Artifact) { a.SHA256 = strings.Repeat("0", 64) }, want: ErrDigestMismatch},
		{name: "different version", modify: func(a *Artifact) { a.Version = "2.0.0" }, want: ErrInvalidResponse},
		{name: "different platform", modify: func(a *Artifact) { a.Platform = "unsupported/cpu" }, want: ErrInvalidResponse},
		{name: "oversized descriptor", modify: func(a *Artifact) { a.SizeBytes = maxArchiveBytes + 1 }, want: ErrInvalidResponse},
		{name: "foreign origin", modify: func(a *Artifact) { a.URL = "https://different.example/archive.zip" }, want: ErrInvalidURL},
		{name: "credential URL", modify: func(a *Artifact) { a.URL = "https://user:secret@different.example/archive.zip" }, want: ErrInvalidURL},
		{name: "changed bytes", download: func(w http.ResponseWriter, r *http.Request) {
			changed := append([]byte(nil), payload...)
			changed[len(changed)-1] ^= 1
			if _, err := w.Write(changed); err != nil {
				t.Error(err)
			}
		}, want: ErrDigestMismatch, hits: 1},
		{name: "wrong length", download: func(w http.ResponseWriter, r *http.Request) {
			if _, err := w.Write(payload[:len(payload)-1]); err != nil {
				t.Error(err)
			}
		}, want: ErrInvalidResponse, hits: 1},
		{name: "chunked overflow", download: func(w http.ResponseWriter, r *http.Request) {
			w.(http.Flusher).Flush()
			if _, err := w.Write(append(append([]byte(nil), payload...), 0)); err != nil {
				t.Error(err)
			}
		}, want: ErrInvalidResponse, hits: 1},
		{name: "HTTP content encoding", download: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Encoding", "gzip")
			if _, err := w.Write(payload); err != nil {
				t.Error(err)
			}
		}, want: ErrInvalidResponse, hits: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, digest, hits := artifactServer(t, payload, test.modify, test.download)
			defer server.Close()
			service := newTestService(t, server.URL, false)
			path, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
			cleanup()
			assertErrorIs(t, err, test.want)
			if path != "" || hits.Load() != test.hits {
				t.Fatalf("path=%q hits=%d", path, hits.Load())
			}
			entries, readErr := os.ReadDir(filepath.Join(service.root, "downloads"))
			if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
				t.Fatal(readErr)
			}
			if len(entries) != 0 {
				t.Fatal("rejected archive left temporary bytes")
			}
		})
	}
}

func TestDownloadRedirectCancellationAndUnknownFormat(t *testing.T) {
	payload := fixtureArchive(t, "zip")
	t.Run("redirect", func(t *testing.T) {
		var hits atomic.Int32
		destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
		defer destination.Close()
		server, digest, _ := artifactServer(t, payload, nil, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) })
		defer server.Close()
		service := newTestService(t, server.URL, false)
		_, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
		cleanup()
		assertErrorIs(t, err, ErrRedirect)
		if hits.Load() != 0 {
			t.Fatal("archive redirect followed")
		}
	})
	t.Run("cancellation", func(t *testing.T) {
		server, digest, _ := artifactServer(t, payload, nil, func(w http.ResponseWriter, r *http.Request) { w.(http.Flusher).Flush(); <-r.Context().Done() })
		defer server.Close()
		service := newTestService(t, server.URL, false)
		ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
		defer cancel()
		_, cleanup, err := service.Download(ctx, "publisher.plugin", "1.0.0", digest)
		cleanup()
		assertErrorIs(t, err, context.DeadlineExceeded)
	})
	t.Run("unknown archive", func(t *testing.T) {
		server, digest, _ := artifactServer(t, []byte("not an archive"), nil, nil)
		defer server.Close()
		service := newTestService(t, server.URL, false)
		_, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
		cleanup()
		assertErrorIs(t, err, ErrInvalidResponse)
	})
}

func TestInstallProvenanceUsesSourceAndCanonicalDigest(t *testing.T) {
	server, digest, _ := artifactServer(t, fixtureArchive(t, "zip"), nil, nil)
	defer server.Close()
	service := newTestService(t, server.URL, false)
	canonical := archiveDigest([]byte("canonical file content digest"))
	// A package installed outside the marketplace has no provenance record; that is not a
	// hijack risk, so it may be updated online once a fresh inspection is approved.
	if err := service.VerifyInstallSource(t.Context(), "publisher.plugin", canonical); err != nil {
		t.Fatalf("sideloaded package must be updatable from the market: %v", err)
	}
	assertErrorIs(t, service.RecordInstall(t.Context(), "publisher.plugin", "arbitrary-path", canonical), ErrInvalidRequest)
	path, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if err = service.RecordInstall(t.Context(), "publisher.plugin", path, canonical); err != nil {
		t.Fatal(err)
	}
	if err = service.VerifyInstallSource(t.Context(), "publisher.plugin", canonical); err != nil {
		t.Fatal(err)
	}
	assertErrorIs(t, service.VerifyInstallSource(t.Context(), "publisher.plugin", digest), ErrSourceMismatch)
	restarted, err := NewService(Options{Root: service.root})
	if err != nil {
		t.Fatal(err)
	}
	if err = restarted.VerifyInstallSource(t.Context(), "publisher.plugin", canonical); err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.Configure(t.Context(), "https://other.example"); err != nil {
		t.Fatal(err)
	}
	assertErrorIs(t, restarted.VerifyInstallSource(t.Context(), "publisher.plugin", canonical), ErrSourceMismatch)
	_, discard, err := restarted.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
	discard()
	assertErrorIs(t, err, ErrSourceMismatch)
	if err = restarted.ForgetInstall(t.Context(), "publisher.plugin"); err != nil {
		t.Fatal(err)
	}
	// Forgetting the binding returns the package to the sideloaded state, which is updatable.
	if err = restarted.VerifyInstallSource(t.Context(), "publisher.plugin", canonical); err != nil {
		t.Fatalf("forgotten provenance must allow a fresh market update: %v", err)
	}
	cleanup()
	assertErrorIs(t, service.RecordInstall(t.Context(), "publisher.plugin", path, canonical), ErrInvalidRequest)
}

func TestProvenanceRejectsMutatedDownloadAndSurfacesPersistenceError(t *testing.T) {
	server, digest, _ := artifactServer(t, fixtureArchive(t, "zip"), nil, nil)
	defer server.Close()
	service := newTestService(t, server.URL, false)
	canonical := strings.Repeat("a", 64)
	path, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	changed := append([]byte(nil), original...)
	changed[len(changed)-1] ^= 1
	if err = os.WriteFile(path, changed, 0600); err != nil {
		t.Fatal(err)
	}
	assertErrorIs(t, service.RecordInstall(t.Context(), "publisher.plugin", path, canonical), ErrDigestMismatch)
	if err = os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(service.root, "settings.json")
	if err = os.Remove(settingsPath); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(settingsPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err = service.RecordInstall(t.Context(), "publisher.plugin", path, canonical); err == nil {
		t.Fatal("provenance persistence failure hidden")
	}
	// The failed record leaves no binding behind, which is indistinguishable from a sideloaded
	// package; that state is updatable. The source guard still protects every package that does
	// carry a record — see TestInstallProvenanceUsesSourceAndCanonicalDigest.
	if err = service.VerifyInstallSource(t.Context(), "publisher.plugin", canonical); err != nil {
		t.Fatalf("unrecorded install was treated as a source conflict: %v", err)
	}
}
