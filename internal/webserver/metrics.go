package webserver

import (
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/db"
)

// webMetrics 收集多客户端部署最需要的运行指标，避免为了一个 JSON 端点引入
// Prometheus 依赖。需要标准指标格式时可在反向代理层转换。
type webMetrics struct {
	requests     atomic.Int64
	inflight     atomic.Int64
	invokes      atomic.Int64
	invokeErrors atomic.Int64
	requestNanos atomic.Int64
	invokeNanos  atomic.Int64

	methodMu    sync.Mutex
	byMethod    map[string]int64
	methodError map[string]int64
}

func newWebMetrics() *webMetrics {
	return &webMetrics{
		byMethod:    make(map[string]int64),
		methodError: make(map[string]int64),
	}
}

func (m *webMetrics) middleware(next http.Handler) http.Handler {
	if m == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.requests.Add(1)
		m.inflight.Add(1)
		started := time.Now()
		defer func() {
			m.inflight.Add(-1)
			m.requestNanos.Add(time.Since(started).Nanoseconds())
		}()
		next.ServeHTTP(w, r)
	})
}

func (m *webMetrics) recordInvoke(method string, elapsed time.Duration, failed bool) {
	if m == nil {
		return
	}
	m.invokes.Add(1)
	m.invokeNanos.Add(elapsed.Nanoseconds())
	if failed {
		m.invokeErrors.Add(1)
	}
	m.methodMu.Lock()
	m.byMethod[method]++
	if failed {
		m.methodError[method]++
	}
	m.methodMu.Unlock()
}

type webMetricsSnapshot struct {
	Requests             int64            `json:"requests"`
	Inflight             int64            `json:"inflight"`
	Invokes              int64            `json:"invokes"`
	InvokeErrors         int64            `json:"invokeErrors"`
	InvokeByMethod       map[string]int64 `json:"invokeByMethod"`
	InvokeErrorByMethod  map[string]int64 `json:"invokeErrorByMethod"`
	RequestDurationMs    int64            `json:"requestDurationMs"`
	InvokeDurationMs     int64            `json:"invokeDurationMs"`
	AuditQueuePending    int64            `json:"auditQueuePending"`
	AuditEventsWritten   int64            `json:"auditEventsWritten"`
	AuditLastWriteUnixMs int64            `json:"auditLastWriteUnixMs"`
	DBPools              int              `json:"dbPools"`
	DBOpenConnections    int              `json:"dbOpenConnections"`
	DBInUseConnections   int              `json:"dbInUseConnections"`
	DBIdleConnections    int              `json:"dbIdleConnections"`
	DBWaitCount          int64            `json:"dbWaitCount"`
	DBWaitDurationMs     int64            `json:"dbWaitDurationMs"`
	SSESubscribers       int              `json:"sseSubscribers"`
	Goroutines           int              `json:"goroutines"`
	HeapAllocBytes       uint64           `json:"heapAllocBytes"`
	HeapSysBytes         uint64           `json:"heapSysBytes"`
	NumGC                uint32           `json:"numGC"`
}

func (s *Server) metricsSnapshot() webMetricsSnapshot {
	snapshot := webMetricsSnapshot{Goroutines: runtime.NumGoroutine()}
	if s != nil && s.metrics != nil {
		snapshot.Requests = s.metrics.requests.Load()
		snapshot.Inflight = s.metrics.inflight.Load()
		snapshot.Invokes = s.metrics.invokes.Load()
		snapshot.InvokeErrors = s.metrics.invokeErrors.Load()
		snapshot.RequestDurationMs = s.metrics.requestNanos.Load() / int64(time.Millisecond)
		snapshot.InvokeDurationMs = s.metrics.invokeNanos.Load() / int64(time.Millisecond)
		s.metrics.methodMu.Lock()
		snapshot.InvokeByMethod = cloneInt64Map(s.metrics.byMethod)
		snapshot.InvokeErrorByMethod = cloneInt64Map(s.metrics.methodError)
		s.metrics.methodMu.Unlock()
	}
	if s != nil && s.events != nil {
		snapshot.SSESubscribers = s.events.subscriberCount()
	}
	pools := db.SQLPoolStatsSnapshot()
	snapshot.DBPools = pools.Pools
	snapshot.DBOpenConnections = pools.Open
	snapshot.DBInUseConnections = pools.InUse
	snapshot.DBIdleConnections = pools.Idle
	snapshot.DBWaitCount = pools.WaitCount
	snapshot.DBWaitDurationMs = pools.WaitDurationMs
	if s != nil && s.app != nil {
		stats := appcore.SQLAuditAsyncStatsFor(s.app)
		snapshot.AuditQueuePending = stats.Pending
		snapshot.AuditEventsWritten = stats.Written
		snapshot.AuditLastWriteUnixMs = stats.LastWriteUnixMilli
	}
	var memstats runtime.MemStats
	runtime.ReadMemStats(&memstats)
	snapshot.HeapAllocBytes = memstats.HeapAlloc
	snapshot.HeapSysBytes = memstats.HeapSys
	snapshot.NumGC = memstats.NumGC
	return snapshot
}

func cloneInt64Map(source map[string]int64) map[string]int64 {
	if len(source) == 0 {
		return map[string]int64{}
	}
	cloned := make(map[string]int64, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}
