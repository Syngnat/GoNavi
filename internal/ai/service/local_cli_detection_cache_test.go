package aiservice

import (
	"sync"
	"testing"
	"time"
)

// 命令存在性探测在未命中缓存时要起 login shell，单次可达 1s；设置页一次探测 7 个客户端。
// 本用例用调用计数而不是墙钟时间来锁住缓存行为，避免在 CI 上因机器快慢而抖动。
func TestDetectLocalCLICommandUsesCache(t *testing.T) {
	resetLocalCLICommandCache()
	t.Cleanup(resetLocalCLICommandCache)

	var mu sync.Mutex
	calls := 0
	original := localCLICommandPathFunc
	localCLICommandPathFunc = func(name string) (string, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		return "/usr/local/bin/" + name, nil
	}
	t.Cleanup(func() { localCLICommandPathFunc = original })

	for i := 0; i < 5; i++ {
		found, path := detectLocalCLICommand("codex")
		if !found || path != "/usr/local/bin/codex" {
			t.Fatalf("第 %d 次探测结果不符：found=%v path=%q", i+1, found, path)
		}
	}

	mu.Lock()
	got := calls
	mu.Unlock()
	if got != 1 {
		t.Fatalf("同一命令在 TTL 内应只探测一次，实际 %d 次", got)
	}
}

// TTL 到期后必须重新探测，否则卸载/安装 CLI 后状态会永远停在旧值。
func TestDetectLocalCLICommandCacheExpires(t *testing.T) {
	resetLocalCLICommandCache()
	t.Cleanup(resetLocalCLICommandCache)

	originalTTL := localCLICommandDetectionTTL
	localCLICommandDetectionTTL = time.Millisecond
	t.Cleanup(func() { localCLICommandDetectionTTL = originalTTL })

	calls := 0
	original := localCLICommandPathFunc
	localCLICommandPathFunc = func(name string) (string, error) {
		calls++
		return "/usr/local/bin/" + name, nil
	}
	t.Cleanup(func() { localCLICommandPathFunc = original })

	detectLocalCLICommand("grok")
	time.Sleep(5 * time.Millisecond)
	detectLocalCLICommand("grok")

	if calls != 2 {
		t.Fatalf("TTL 到期后应重新探测，实际调用 %d 次", calls)
	}
}

// 并发调用不得撕裂缓存，也不得返回空结果。
func TestDetectLocalCLICommandConcurrentSafe(t *testing.T) {
	resetLocalCLICommandCache()
	t.Cleanup(resetLocalCLICommandCache)

	original := localCLICommandPathFunc
	localCLICommandPathFunc = func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}
	t.Cleanup(func() { localCLICommandPathFunc = original })

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if found, path := detectLocalCLICommand("claude"); !found || path == "" {
				t.Errorf("并发探测返回空结果：found=%v path=%q", found, path)
			}
		}()
	}
	wg.Wait()
}
