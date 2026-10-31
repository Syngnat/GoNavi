package modelsdev

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultSource 是目录地址。
	DefaultSource = "https://models.dev/api.json"
	// DefaultTTL 是本地副本的有效期：目录只影响展示名与窗口提示，一天足够新。
	DefaultTTL = 24 * time.Hour
	// DefaultRefreshTimeout 是单次远程拉取的上限。
	DefaultRefreshTimeout = 20 * time.Second
	// maxCatalogBytes 是远程响应上限，防止异常响应把内存写爆。
	maxCatalogBytes = 32 << 20
	// cacheFileVersion 标记本地副本的封装格式，便于将来换格式时丢弃旧文件。
	cacheFileVersion = 1
)

// ErrUnavailable 表示内存、磁盘、远程三处都拿不到目录。
var ErrUnavailable = errors.New("models.dev catalog unavailable")

// Options 组装 Store。零值可用：默认走官方地址、默认 TTL，不落盘。
type Options struct {
	// Path 是本地副本路径；为空表示不落盘（每次 Load 都要联网）。
	Path string
	// Source 是目录地址；空值用 DefaultSource。
	Source string
	// TTL 是本地副本有效期；<=0 用 DefaultTTL。
	TTL time.Duration
	// Client 是 HTTP 客户端；为空时用带环境代理的默认客户端。
	Client *http.Client
	// Now 便于测试注入时钟。
	Now func() time.Time
	// RefreshTimeout 是单次远程拉取上限；<=0 用 DefaultRefreshTimeout。
	RefreshTimeout time.Duration
}

// Store 持有内存副本与磁盘副本，负责把目录的获取时机收敛在一处。
//
// 内存副本过期也不会阻塞调用方：磁盘副本仍在时先返回旧目录，再后台刷新；
// 三处都没有时才会同步联网，且受调用方 ctx 限制。
type Store struct {
	options Options

	mu         sync.Mutex
	current    *Catalog
	refreshing bool
}

// NewStore 组装 Store；Options.Path 的父目录不存在时由写入时补建。
func NewStore(options Options) *Store {
	if strings.TrimSpace(options.Source) == "" {
		options.Source = DefaultSource
	}
	if options.TTL <= 0 {
		options.TTL = DefaultTTL
	}
	if options.RefreshTimeout <= 0 {
		options.RefreshTimeout = DefaultRefreshTimeout
	}
	if options.Client == nil {
		options.Client = defaultClient()
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Store{options: options}
}

// IsStale 判断一份目录是否已过期；nil 与没有远程时间戳的目录都算过期。
func (s *Store) IsStale(catalog *Catalog) bool {
	if catalog == nil || catalog.FetchedAt().IsZero() {
		return true
	}
	return s.options.Now().Sub(catalog.FetchedAt()) >= s.options.TTL
}

// Load 返回当前可用的目录：
//
//  1. 内存副本仍新鲜 → 直接返回，不碰磁盘也不联网；
//  2. 磁盘副本存在 → 立即返回它，过期时顺带在后台刷新；
//  3. 都没有 → 同步拉一次远程，受 ctx 限制，失败返回 ErrUnavailable。
//
// 远程失败不会丢掉还能用的旧副本：只要磁盘上有，就返回它并用 IsStale 说明新鲜度。
func (s *Store) Load(ctx context.Context) (*Catalog, error) {
	current := s.snapshot()
	if current != nil && !s.IsStale(current) {
		return current, nil
	}

	if disk, ok := s.loadFromDisk(); ok {
		if current == nil || disk.FetchedAt().After(current.FetchedAt()) {
			s.setCurrent(disk)
		}
		if s.IsStale(disk) {
			s.refreshInBackground()
		}
		return disk, nil
	}

	catalog, err := s.fetch(ctx)
	if err != nil {
		if current != nil {
			return current, nil
		}
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	s.setCurrent(catalog)
	s.endRefresh()
	return catalog, nil
}

// Refresh 强制联网取一次；成功后替换内存与磁盘副本。
func (s *Store) Refresh(ctx context.Context) (*Catalog, error) {
	catalog, err := s.fetch(ctx)
	if err != nil {
		return nil, fmt.Errorf("refresh models.dev catalog: %w", err)
	}
	s.setCurrent(catalog)
	s.endRefresh()
	return catalog, nil
}

func (s *Store) snapshot() *Catalog {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

func (s *Store) setCurrent(catalog *Catalog) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = catalog
}

func (s *Store) endRefresh() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshing = false
}

// refreshInBackground 起一次不阻塞调用方的刷新；同一时刻只会有一个在跑。
func (s *Store) refreshInBackground() {
	s.mu.Lock()
	if s.refreshing {
		s.mu.Unlock()
		return
	}
	s.refreshing = true
	s.mu.Unlock()

	// 进程级后台任务：与用户请求无关，所以用 Background，并自带超时兜底。
	// 刷新失败不打扰调用方——旧副本仍在，下一次 Load 还会再试。
	ctx, cancel := context.WithTimeout(context.Background(), s.options.RefreshTimeout)
	go func() {
		defer cancel()
		if _, err := s.Refresh(ctx); err != nil {
			s.endRefresh()
		}
	}()
}

func (s *Store) loadFromDisk() (*Catalog, bool) {
	if s.options.Path == "" {
		return nil, false
	}
	raw, err := os.ReadFile(s.options.Path)
	if err != nil {
		return nil, false
	}
	var envelope diskEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, false
	}
	if envelope.Version != cacheFileVersion || len(envelope.Payload) == 0 || envelope.FetchedAt.IsZero() {
		return nil, false
	}
	catalog, err := Parse(envelope.Payload)
	if err != nil {
		return nil, false
	}
	catalog.fetchedAt = envelope.FetchedAt
	return catalog, true
}

func (s *Store) fetch(ctx context.Context) (*Catalog, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.options.Source, nil)
	if err != nil {
		return nil, fmt.Errorf("build catalog request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	response, err := s.options.Client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch catalog: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch catalog: unexpected status %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxCatalogBytes))
	if err != nil {
		return nil, fmt.Errorf("read catalog: %w", err)
	}
	catalog, err := Parse(payload)
	if err != nil {
		return nil, err
	}
	catalog.fetchedAt = s.options.Now()
	s.writeToDisk(payload, catalog.fetchedAt)
	return catalog, nil
}

// writeToDisk 原子写本地副本：先写同目录临时文件再改名，失败不留半个文件，
// 也不影响已经拿到的目录。
func (s *Store) writeToDisk(payload []byte, fetchedAt time.Time) {
	if s.options.Path == "" {
		return
	}
	directory := filepath.Dir(s.options.Path)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return
	}
	encoded, err := json.Marshal(diskEnvelope{
		Version:   cacheFileVersion,
		Source:    s.options.Source,
		FetchedAt: fetchedAt.UTC(),
		Payload:   payload,
	})
	if err != nil {
		return
	}
	temporary, err := os.CreateTemp(directory, ".models-dev-*.tmp")
	if err != nil {
		return
	}
	name := temporary.Name()
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		_ = os.Remove(name)
		return
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(name)
		return
	}
	if err := os.Rename(name, s.options.Path); err != nil {
		_ = os.Remove(name)
	}
}

type diskEnvelope struct {
	Version   int             `json:"version"`
	Source    string          `json:"source"`
	FetchedAt time.Time       `json:"fetchedAt"`
	Payload   json.RawMessage `json:"payload"`
}

func defaultClient() *http.Client {
	return &http.Client{
		Timeout: DefaultRefreshTimeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			ForceAttemptHTTP2:   true,
			MaxIdleConns:        4,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 15 * time.Second,
		},
	}
}
