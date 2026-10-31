package aiservice

import (
	"context"
	"os/exec"
	"sync"
	"testing"
	"time"
)

// 预热 goroutine 读的是包级探测钩子，而本包用例大量替换这些钩子。
// 门闩必须两个方向都锁住：生产要照旧预热，测试形态要一个都不起，
// 否则就退回「上一个用例的预热用新钩子探测」那个随机失败。
//
// 断言落在真实探测钩子上而不是只看 localCLIPrewarmSpawn：绕过入口直接
// `go prewarmLocalCLICommandCache()` 也要被抓到，那正是这次要根治的写法。
func TestStartLocalCLICachePrewarmHonorsTestGate(t *testing.T) {
	resetLocalCLICommandCache()
	originalSpawn := localCLIPrewarmSpawn
	originalDisabled := localCLICachePrewarmDisabled.Load()
	originalPathFunc := localCLICommandPathFunc
	originalCandidatesFunc := localCLICommandShellCandidatesFunc
	originalShellOutputFunc := localCLICommandShellOutputFunc
	t.Cleanup(func() {
		localCLIPrewarmSpawn = originalSpawn
		localCLICachePrewarmDisabled.Store(originalDisabled)
		localCLICommandPathFunc = originalPathFunc
		localCLICommandShellCandidatesFunc = originalCandidatesFunc
		localCLICommandShellOutputFunc = originalShellOutputFunc
		resetLocalCLICommandCache()
	})

	var mu sync.Mutex
	spawns := 0
	probed := 0
	counts := func() (int, int) {
		mu.Lock()
		defer mu.Unlock()
		return spawns, probed
	}
	// 替换成空实现：方向一不该真起 goroutine，方向二本来就不该起。
	localCLIPrewarmSpawn = func(func()) {
		mu.Lock()
		spawns++
		mu.Unlock()
	}
	localCLICommandShellCandidatesFunc = func() []string { return nil }
	localCLICommandShellOutputFunc = func(context.Context, string, string) ([]byte, error) {
		return nil, exec.ErrNotFound
	}
	localCLICommandPathFunc = func(string) (string, error) {
		mu.Lock()
		probed++
		mu.Unlock()
		return "", exec.ErrNotFound
	}

	localCLICachePrewarmDisabled.Store(false)
	startLocalCLICachePrewarm()
	if got, probedNow := counts(); got != 1 || probedNow != 0 {
		t.Fatalf("门闩打开时应启动一次预热：spawn=%d probed=%d", got, probedNow)
	}

	localCLICachePrewarmDisabled.Store(true)
	startLocalCLICachePrewarm()
	// 构造服务必须走同一个入口，否则以后有人直接 go 预热就又漏过去了。
	NewServiceWithSecretStore(nil)
	time.Sleep(200 * time.Millisecond)
	if got, probedNow := counts(); got != 1 || probedNow != 0 {
		t.Fatalf("测试形态下不应启动预热或探测：spawn=%d probed=%d", got, probedNow)
	}
}

// 关掉门闩不等于砍掉预热实现：真跑预热时仍要覆盖每一个外部客户端。
func TestPrewarmLocalCLICommandCacheProbesEveryClient(t *testing.T) {
	resetLocalCLICommandCache()
	originalPathFunc := localCLICommandPathFunc
	originalCandidatesFunc := localCLICommandShellCandidatesFunc
	originalShellOutputFunc := localCLICommandShellOutputFunc
	t.Cleanup(func() {
		localCLICommandPathFunc = originalPathFunc
		localCLICommandShellCandidatesFunc = originalCandidatesFunc
		localCLICommandShellOutputFunc = originalShellOutputFunc
		resetLocalCLICommandCache()
	})

	// 未命中的命令本来要逐个起 login shell（冷路径约 1.2s）；空候选表把它降到纯内存。
	localCLICommandShellCandidatesFunc = func() []string { return nil }
	localCLICommandShellOutputFunc = func(context.Context, string, string) ([]byte, error) {
		return nil, exec.ErrNotFound
	}

	var mu sync.Mutex
	probed := make(map[string]struct{}, len(localCLICachePrewarmCommands))
	localCLICommandPathFunc = func(name string) (string, error) {
		mu.Lock()
		probed[name] = struct{}{}
		mu.Unlock()
		return "", exec.ErrNotFound
	}

	prewarmLocalCLICommandCache()

	mu.Lock()
	defer mu.Unlock()
	for _, name := range localCLICachePrewarmCommands {
		if _, ok := probed[name]; !ok {
			t.Fatalf("预热漏掉外部客户端 %q，实际探测 %v", name, probed)
		}
	}
}
