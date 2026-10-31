package webserver

import (
	"encoding/json"
	"net/http"
	"runtime"
	"runtime/debug"
)

// debugMemstatsPayload 是 /__gonavi/debug/memstats 的响应体。只保留内存诊断
// 需要的最小字段集，字节字段命名与 runtime.MemStats 一致（小驼峰），便于
// 对照官方文档解读；RSS 本身不在 MemStats 里，用 docker stats 观察。
type debugMemstatsPayload struct {
	HeapAlloc      uint64 `json:"heapAlloc"`
	HeapSys        uint64 `json:"heapSys"`
	HeapInuse      uint64 `json:"heapInuse"`
	HeapIdle       uint64 `json:"heapIdle"`
	HeapReleased   uint64 `json:"heapReleased"`
	HeapObjects    uint64 `json:"heapObjects"`
	StackInuse     uint64 `json:"stackInuse"`
	StackSys       uint64 `json:"stackSys"`
	BuckHashSys    uint64 `json:"buckHashSys"`
	GCSys          uint64 `json:"gcSys"`
	OtherSys       uint64 `json:"otherSys"`
	Sys            uint64 `json:"sys"`
	NumGC          uint32 `json:"numGC"`
	GCPauseTotalNs uint64 `json:"gcPauseTotalNs"`
	NumGoroutine   int    `json:"numGoroutine"`
	GOGCPercent    int    `json:"gogcPercent"`
	GoMemLimit     int64  `json:"goMemLimit"`
}

// handleDebugMemstats 输出进程内存画像，供 Docker 部署的内存占用排查使用。
// ReadMemStats 会短暂 STW，定位是人工诊断入口，不要让前端常态化轮询。
// 路由挂在 requireWebAuth 之后（SharedRuntime 挂在调用方的进程级令牌之后）。
func (s *Server) handleDebugMemstats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var memstats runtime.MemStats
	runtime.ReadMemStats(&memstats)
	payload := debugMemstatsPayload{
		HeapAlloc:      memstats.HeapAlloc,
		HeapSys:        memstats.HeapSys,
		HeapInuse:      memstats.HeapInuse,
		HeapIdle:       memstats.HeapIdle,
		HeapReleased:   memstats.HeapReleased,
		HeapObjects:    memstats.HeapObjects,
		StackInuse:     memstats.StackInuse,
		StackSys:       memstats.StackSys,
		BuckHashSys:    memstats.BuckHashSys,
		GCSys:          memstats.GCSys,
		OtherSys:       memstats.OtherSys,
		Sys:            memstats.Sys,
		NumGC:          memstats.NumGC,
		GCPauseTotalNs: memstats.PauseTotalNs,
		NumGoroutine:   runtime.NumGoroutine(),
		GOGCPercent:    currentGOGCPercent(),
		GoMemLimit:     debug.SetMemoryLimit(-1),
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(payload)
}

// currentGOGCPercent 读取当前 GOGC 百分比。debug.SetGCPercent 没有只读
// getter，负值会关闭 GC，因此用 -1 读出旧值后立刻恢复；窗口期只有微秒级，
// 对人工诊断入口可接受。
func currentGOGCPercent() int {
	previous := debug.SetGCPercent(-1)
	debug.SetGCPercent(previous)
	return previous
}
