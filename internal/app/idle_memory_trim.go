package app

import (
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/logger"
)

const (
	// 窗口隐藏/最小化后先等这么久再回收，避免短暂切换窗口就触发 GC 抖动。
	idleMemoryTrimDelay = 30 * time.Second
	// 隐藏期间两次回收之间的最小间隔。
	idleMemoryTrimInterval = 2 * time.Minute
	// 检查窗口隐藏时长的节奏。
	idleMemoryTrimCheckInterval = 15 * time.Second
)

type idleMemoryTrimState struct {
	once     sync.Once
	hidden   atomic.Bool
	hiddenAt atomic.Int64
	lastAt   atomic.Int64
}

var idleMemoryTrimFn = func() {
	runtime.GC()
	debug.FreeOSMemory()
}

// SetWindowHiddenForMemoryTrim 由桌面入口在窗口隐藏/最小化/恢复时调用。
// 隐藏一段时间且没有查询/导出任务时，周期性把空闲堆归还系统；恢复显示后
// 停止回收。大结果集回收由查询结束钩子单独负责，两者互不替代。
func (a *App) SetWindowHiddenForMemoryTrim(hidden bool) {
	if a == nil {
		return
	}
	if !hidden {
		a.idleMemoryTrim.hidden.Store(false)
		a.idleMemoryTrim.hiddenAt.Store(0)
		return
	}
	if !a.idleMemoryTrim.hidden.Swap(true) {
		a.idleMemoryTrim.hiddenAt.Store(time.Now().UnixNano())
	}
	a.idleMemoryTrim.once.Do(func() { go a.idleMemoryTrimLoop() })
}

func (a *App) idleMemoryTrimLoop() {
	ticker := time.NewTicker(idleMemoryTrimCheckInterval)
	defer ticker.Stop()
	for range ticker.C {
		if !a.shouldTrimIdleMemory(time.Now()) {
			continue
		}
		a.idleMemoryTrim.lastAt.Store(time.Now().UnixNano())
		logger.Infof("[idle-trim] 窗口已隐藏且无运行任务，回收空闲堆内存")
		idleMemoryTrimFn()
	}
}

func (a *App) shouldTrimIdleMemory(now time.Time) bool {
	if a == nil || !a.idleMemoryTrim.hidden.Load() {
		return false
	}
	hiddenAt := a.idleMemoryTrim.hiddenAt.Load()
	if hiddenAt <= 0 || now.Sub(time.Unix(0, hiddenAt)) < idleMemoryTrimDelay {
		return false
	}
	lastAt := a.idleMemoryTrim.lastAt.Load()
	if lastAt > 0 && now.Sub(time.Unix(0, lastAt)) < idleMemoryTrimInterval {
		return false
	}
	return a.noActiveQueryOrExportTasks()
}

// noActiveQueryOrExportTasks 表示当前没有在跑的查询、导入或导出。窗口隐藏
// 期间后台任务仍可能运行，此时不能插入 GC 停顿。
func (a *App) noActiveQueryOrExportTasks() bool {
	a.queryMu.RLock()
	queries := len(a.runningQueries)
	a.queryMu.RUnlock()
	a.exportTaskMu.Lock()
	exports := len(a.exportTasks)
	a.exportTaskMu.Unlock()
	return queries == 0 && exports == 0
}
