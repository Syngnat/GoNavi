package modelsdev

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

const (
	freshPayload = `{"anthropic":{"models":{"claude-fable-5-1":{"name":"Claude Fable 5.1","limit":{"context":1000000}}}}}`
	stalePayload = `{"anthropic":{"models":{"claude-fable-5-1":{"name":"旧目录名称","limit":{"context":128000}}}}}`
)

type catalogServer struct {
	server   *httptest.Server
	requests atomic.Int32
	payload  atomic.Value
	status   atomic.Int32
}

func newCatalogServer(t *testing.T, payload string) *catalogServer {
	t.Helper()
	instance := &catalogServer{}
	instance.payload.Store(payload)
	instance.status.Store(int32(http.StatusOK))
	instance.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		instance.requests.Add(1)
		status := int(instance.status.Load())
		if status != http.StatusOK {
			writer.WriteHeader(status)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(instance.payload.Load().(string)))
	}))
	t.Cleanup(instance.server.Close)
	return instance
}

func (s *catalogServer) setPayload(payload string) { s.payload.Store(payload) }

func (s *catalogServer) failWith(status int) { s.status.Store(int32(status)) }

func writeDiskCache(t *testing.T, path string, fetchedAt time.Time, payload string) {
	t.Helper()
	raw, err := json.Marshal(diskEnvelope{Version: cacheFileVersion, Source: DefaultSource, FetchedAt: fetchedAt.UTC(), Payload: []byte(payload)})
	if err != nil {
		t.Fatalf("marshal disk envelope: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir cache dir: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write disk cache: %v", err)
	}
}

func TestStoreLoadsFromRemoteAndCachesToDisk(t *testing.T) {
	server := newCatalogServer(t, freshPayload)
	path := filepath.Join(t.TempDir(), "model-catalog", "models-dev.json")
	store := NewStore(Options{Path: path, Source: server.server.URL})

	catalog, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if entry, ok := catalog.Lookup("anthropic/claude-fable-5-1"); !ok || entry.ContextWindow != 1000000 {
		t.Fatalf("Lookup = %+v, %v", entry, ok)
	}
	if catalog.FetchedAt().IsZero() {
		t.Fatal("远程结果应带获取时间")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("本地副本未落盘: %v", err)
	}
	entries, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".models-dev-*.tmp"))
	if err != nil {
		t.Fatalf("glob temp files: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("临时文件未清理: %v", entries)
	}

	// 内存副本新鲜时不应再联网。
	server.failWith(http.StatusInternalServerError)
	if _, err := store.Load(context.Background()); err != nil {
		t.Fatalf("第二次 Load 不应联网，也不应报错: %v", err)
	}
	if got := server.requests.Load(); got != 1 {
		t.Fatalf("远程请求次数 = %d, want 1", got)
	}
}

func TestStoreFallsBackToDiskWhenRemoteFails(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	server := newCatalogServer(t, freshPayload)
	server.failWith(http.StatusBadGateway)
	path := filepath.Join(t.TempDir(), "models-dev.json")
	writeDiskCache(t, path, now.Add(-2*DefaultTTL), stalePayload)
	store := NewStore(Options{Path: path, Source: server.server.URL, Now: func() time.Time { return now }})

	catalog, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load 应返回旧副本而不是报错: %v", err)
	}
	if entry, _ := catalog.Lookup("claude-fable-5-1"); entry.Name != "旧目录名称" {
		t.Fatalf("应返回磁盘副本，得到 %+v", entry)
	}
	if !store.IsStale(catalog) {
		t.Fatal("过期副本应报告为过期")
	}
}

func TestStoreRefreshesStaleDiskCopyInBackground(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	server := newCatalogServer(t, freshPayload)
	path := filepath.Join(t.TempDir(), "models-dev.json")
	writeDiskCache(t, path, now.Add(-2*DefaultTTL), stalePayload)
	store := NewStore(Options{Path: path, Source: server.server.URL, Now: func() time.Time { return now }})

	catalog, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if entry, _ := catalog.Lookup("claude-fable-5-1"); entry.Name != "旧目录名称" {
		t.Fatalf("首帧应先用旧副本，得到 %+v", entry)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		entry, _ := store.snapshot().Lookup("claude-fable-5-1")
		if entry.Name == "Claude Fable 5.1" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("后台刷新未替换内存副本")
}

func TestStoreRefreshAlwaysHitsTheNetwork(t *testing.T) {
	server := newCatalogServer(t, freshPayload)
	store := NewStore(Options{Source: server.server.URL})

	if _, err := store.Load(context.Background()); err != nil {
		t.Fatalf("Load: %v", err)
	}
	server.setPayload(stalePayload)
	catalog, err := store.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if entry, _ := catalog.Lookup("claude-fable-5-1"); entry.Name != "旧目录名称" {
		t.Fatalf("Refresh 应拿到新内容，得到 %+v", entry)
	}
	if got := server.requests.Load(); got != 2 {
		t.Fatalf("远程请求次数 = %d, want 2", got)
	}
}

func TestStoreReportsUnavailableWhenNothingWorks(t *testing.T) {
	server := newCatalogServer(t, freshPayload)
	server.failWith(http.StatusInternalServerError)
	store := NewStore(Options{Path: filepath.Join(t.TempDir(), "models-dev.json"), Source: server.server.URL})

	catalog, err := store.Load(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if catalog != nil {
		t.Fatalf("catalog = %+v, want nil", catalog)
	}
}

func TestStoreIgnoresBrokenDiskCopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models-dev.json")
	if err := os.WriteFile(path, []byte("{truncated"), 0o600); err != nil {
		t.Fatalf("write broken cache: %v", err)
	}
	server := newCatalogServer(t, freshPayload)
	store := NewStore(Options{Path: path, Source: server.server.URL})

	catalog, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load 应改用远程: %v", err)
	}
	if entry, _ := catalog.Lookup("claude-fable-5-1"); entry.Name != "Claude Fable 5.1" {
		t.Fatalf("catalog = %+v", entry)
	}
}

func TestStoreWithoutPathKeepsEverythingInMemory(t *testing.T) {
	server := newCatalogServer(t, freshPayload)
	store := NewStore(Options{Source: server.server.URL, TTL: time.Minute, Now: func() time.Time { return time.Now() }})

	if _, err := store.Load(context.Background()); err != nil {
		t.Fatalf("Load: %v", err)
	}
	// 不落盘时内存副本仍按 TTL 生效：TTL 内第二次调用不联网。
	if _, err := store.Load(context.Background()); err != nil {
		t.Fatalf("第二次 Load: %v", err)
	}
	if got := server.requests.Load(); got != 1 {
		t.Fatalf("远程请求次数 = %d, want 1", got)
	}
}
