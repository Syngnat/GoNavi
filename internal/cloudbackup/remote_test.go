package cloudbackup

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
)

func TestWebDAVRemoteUsesPathSegmentsAndBasicAuth(t *testing.T) {
	var gotPath, gotUser, gotPassword string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotUser, gotPassword, _ = r.BasicAuth()
		body, _ := io.ReadAll(r.Body)
		if r.Method == http.MethodPut && string(body) != "payload" {
			t.Fatalf("unexpected PUT body: %q", body)
		}
		w.Header().Set("ETag", `"etag"`)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	remote, err := NewRemote(RemoteConfig{Provider: ProviderWebDAV, Endpoint: server.URL, ObjectKey: "gonavi/backup.gonavi"}, Credentials{Username: "user", Password: "pass"}, server.Client())
	if err != nil {
		t.Fatalf("NewRemote returned error: %v", err)
	}
	metadata, err := remote.Put(context.Background(), []byte("payload"))
	if err != nil {
		t.Fatalf("Put returned error: %v", err)
	}
	if metadata.ETag != "etag" || gotPath != "/gonavi/backup.gonavi" || gotUser != "user" || gotPassword != "pass" {
		t.Fatalf("unexpected request path/auth/metadata: path=%q user=%q password=%q metadata=%#v", gotPath, gotUser, gotPassword, metadata)
	}
}

func TestWebDAVRemoteCreatesMissingCollectionsBeforeRetryingPut(t *testing.T) {
	collectionExists := false
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.EscapedPath())
		switch {
		case r.Method == http.MethodPut && !collectionExists:
			w.WriteHeader(http.StatusConflict)
		case r.Method == "MKCOL" && r.URL.EscapedPath() == "/dav/gonavi":
			collectionExists = true
			w.WriteHeader(http.StatusCreated)
		case r.Method == http.MethodPut && collectionExists:
			body, _ := io.ReadAll(r.Body)
			if string(body) != "payload" {
				t.Fatalf("unexpected PUT body: %q", body)
			}
			w.WriteHeader(http.StatusCreated)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	remote, err := NewRemote(RemoteConfig{Provider: ProviderWebDAV, Endpoint: server.URL + "/dav", ObjectKey: "gonavi/backup.gonavi"}, Credentials{Username: "user", Password: "pass"}, server.Client())
	if err != nil {
		t.Fatalf("NewRemote returned error: %v", err)
	}
	if _, err := remote.Put(context.Background(), []byte("payload")); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}
	want := []string{"PUT /dav/gonavi/backup.gonavi", "MKCOL /dav/gonavi", "PUT /dav/gonavi/backup.gonavi"}
	if !slices.Equal(requests, want) {
		t.Fatalf("unexpected WebDAV request sequence: got %v want %v", requests, want)
	}
}

func TestNewRemoteRejectsInsecureNonLoopbackEndpoint(t *testing.T) {
	_, err := NewRemote(RemoteConfig{Provider: ProviderWebDAV, Endpoint: "http://backup.example.test", ObjectKey: "backup"}, Credentials{Username: "user", Password: "pass"}, nil)
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected HTTPS validation error, got %v", err)
	}
}

func TestNewRemoteUsesProviderSpecificRequiredFieldErrors(t *testing.T) {
	webdav, err := NewRemote(RemoteConfig{Provider: ProviderWebDAV, Endpoint: "https://dav.example.test"}, Credentials{Username: "user", Password: "pass"}, nil)
	if err == nil || !strings.Contains(err.Error(), "WebDAV backup file path") {
		t.Fatalf("expected WebDAV path validation error, got remote=%v err=%v", webdav, err)
	}
	s3, err := NewRemote(RemoteConfig{Provider: ProviderS3, Endpoint: "https://s3.example.test", Bucket: "bucket", Region: "us-east-1"}, Credentials{AccessKey: "access", SecretKey: "secret"}, nil)
	if err == nil || !strings.Contains(err.Error(), "S3 object key") {
		t.Fatalf("expected S3 object key validation error, got remote=%v err=%v", s3, err)
	}
}

func TestRemoteEscapesSpecialObjectKeyCharactersOnce(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	remote, err := NewRemote(RemoteConfig{Provider: ProviderWebDAV, Endpoint: server.URL + "/dav", ObjectKey: "folder/a b%2Fc"}, Credentials{Username: "user", Password: "pass"}, server.Client())
	if err != nil {
		t.Fatalf("NewRemote returned error: %v", err)
	}
	if _, err := remote.Put(context.Background(), []byte("payload")); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}
	if gotPath != "/dav/folder/a%20b%252Fc" {
		t.Fatalf("unexpected escaped path: %q", gotPath)
	}
}

func TestS3RemoteKeepsCanonicalEscapedPathInSyncWithRequestURL(t *testing.T) {
	remote, err := NewRemote(RemoteConfig{
		Provider: ProviderS3, Endpoint: "https://s3.example.test/prefix", Bucket: "bucket name", Region: "us-east-1", ObjectKey: "folder/a b%2Fc",
	}, Credentials{AccessKey: "access", SecretKey: "secret"}, nil)
	if err != nil {
		t.Fatalf("NewRemote returned error: %v", err)
	}
	s3, ok := remote.(*s3Remote)
	if !ok {
		t.Fatalf("expected *s3Remote, got %T", remote)
	}
	requestURL, canonicalPath, err := s3.objectURL()
	if err != nil {
		t.Fatalf("objectURL returned error: %v", err)
	}
	parsed, err := url.Parse(requestURL)
	if err != nil {
		t.Fatalf("request URL is invalid: %v", err)
	}
	if parsed.EscapedPath() != canonicalPath || canonicalPath != "/prefix/bucket%20name/folder/a%20b%252Fc" {
		t.Fatalf("request path and canonical path diverged: url=%q canonical=%q", parsed.EscapedPath(), canonicalPath)
	}
}
