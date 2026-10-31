package aiservice

import (
	"context"
	"os/exec"
	"path/filepath"
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
		// 探测结果会过 filepath.Clean，Windows 上是反斜杠，期望值同样归一化。
		if want := filepath.Clean("/usr/local/bin/codex"); !found || path != want {
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

// 后台预热会并发探测外部客户端命令；探测进行中测试替换钩子（mock）时，
// 旧钩子算出的结果必须继续记在旧键下，否则新钩子键上会出现假阴性，
// 表现为「客户端已安装却报未检测到」。
func TestDetectLocalCLICommandKeepsKeyCapturedAtProbeStart(t *testing.T) {
	resetLocalCLICommandCache()
	t.Cleanup(resetLocalCLICommandCache)

	originalPathFunc := localCLICommandPathFunc
	originalCandidatesFunc := localCLICommandShellCandidatesFunc
	originalShellOutputFunc := localCLICommandShellOutputFunc
	t.Cleanup(func() {
		localCLICommandPathFunc = originalPathFunc
		localCLICommandShellCandidatesFunc = originalCandidatesFunc
		localCLICommandShellOutputFunc = originalShellOutputFunc
	})

	localCLICommandShellCandidatesFunc = func() []string { return nil }
	localCLICommandShellOutputFunc = func(context.Context, string, string) ([]byte, error) {
		return nil, exec.ErrNotFound
	}

	probeStarted := make(chan struct{})
	releaseProbe := make(chan struct{})
	localCLICommandPathFunc = func(string) (string, error) {
		close(probeStarted)
		<-releaseProbe
		return "", exec.ErrNotFound
	}

	probeDone := make(chan bool, 1)
	go func() {
		detected, _ := detectLocalCLICommand("zcode")
		probeDone <- detected
	}()
	<-probeStarted

	// 模拟另一个用例或后台预热在探测进行中换上了能命中命令的钩子。
	localCLICommandPathFunc = func(string) (string, error) { return "/stub/zcode", nil }
	close(releaseProbe)
	if detected := <-probeDone; detected {
		t.Fatal("探测在旧钩子下未命中，却报告已检测到")
	}

	if detected, path := detectLocalCLICommand("zcode"); !detected || path != filepath.Clean("/stub/zcode") {
		t.Fatalf("旧探测结果污染了新钩子键：found=%v path=%q", detected, path)
	}
}
