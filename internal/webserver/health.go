package webserver

import (
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"

	"GoNavi-Wails/internal/appdata"
)

type readinessPayload struct {
	Status           string `json:"status"`
	DataRootWritable bool   `json:"dataRootWritable"`
	AuthConfigured   bool   `json:"authConfigured"`
}

// handleReadyz 检查服务真正依赖的运行条件，而不只是“进程还活着”。
// 健康检查用于重启判定：数据目录不可写时继续接流量只会让每次查询都失败。
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	payload := readinessPayload{Status: "ready", DataRootWritable: true}
	root := appdata.MustResolveActiveRoot()
	file, err := os.CreateTemp(root, ".gonavi-readyz-*")
	if err != nil {
		payload.Status = "not_ready"
		payload.DataRootWritable = false
	} else {
		name := file.Name()
		_ = file.Close()
		_ = os.Remove(name)
	}
	if s.auth != nil {
		payload.AuthConfigured = s.auth.Status("").Configured
	}
	status := http.StatusOK
	if payload.Status != "ready" {
		status = http.StatusServiceUnavailable
	}
	s.writeJSON(w, status, payload)
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	snapshot := s.metricsSnapshot()
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "prometheus" || (format == "" && strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/plain")) {
		writePrometheusMetrics(w, snapshot)
		return
	}
	s.writeJSON(w, http.StatusOK, snapshot)
}

func writePrometheusMetrics(w http.ResponseWriter, snapshot webMetricsSnapshot) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	lines := []string{
		"# HELP gonavi_web_requests_total HTTP requests handled",
		"# TYPE gonavi_web_requests_total counter",
		fmt.Sprintf("gonavi_web_requests_total %d", snapshot.Requests),
		"# TYPE gonavi_web_inflight gauge",
		fmt.Sprintf("gonavi_web_inflight %d", snapshot.Inflight),
		"# TYPE gonavi_web_invokes_total counter",
		fmt.Sprintf("gonavi_web_invokes_total %d", snapshot.Invokes),
		"# TYPE gonavi_web_invoke_errors_total counter",
		fmt.Sprintf("gonavi_web_invoke_errors_total %d", snapshot.InvokeErrors),
		"# TYPE gonavi_web_request_duration_ms_total counter",
		fmt.Sprintf("gonavi_web_request_duration_ms_total %d", snapshot.RequestDurationMs),
		"# TYPE gonavi_web_invoke_duration_ms_total counter",
		fmt.Sprintf("gonavi_web_invoke_duration_ms_total %d", snapshot.InvokeDurationMs),
		"# TYPE gonavi_web_sse_subscribers gauge",
		fmt.Sprintf("gonavi_web_sse_subscribers %d", snapshot.SSESubscribers),
		"# TYPE gonavi_web_audit_queue_pending gauge",
		fmt.Sprintf("gonavi_web_audit_queue_pending %d", snapshot.AuditQueuePending),
		"# TYPE gonavi_web_audit_events_written_total counter",
		fmt.Sprintf("gonavi_web_audit_events_written_total %d", snapshot.AuditEventsWritten),
		"# TYPE gonavi_web_audit_last_write_timestamp_ms gauge",
		fmt.Sprintf("gonavi_web_audit_last_write_timestamp_ms %d", snapshot.AuditLastWriteUnixMs),
		"# TYPE gonavi_web_db_pools gauge",
		fmt.Sprintf("gonavi_web_db_pools %d", snapshot.DBPools),
		"# TYPE gonavi_web_db_open_connections gauge",
		fmt.Sprintf("gonavi_web_db_open_connections %d", snapshot.DBOpenConnections),
		"# TYPE gonavi_web_db_in_use_connections gauge",
		fmt.Sprintf("gonavi_web_db_in_use_connections %d", snapshot.DBInUseConnections),
		"# TYPE gonavi_web_db_idle_connections gauge",
		fmt.Sprintf("gonavi_web_db_idle_connections %d", snapshot.DBIdleConnections),
		"# TYPE gonavi_web_db_wait_count_total counter",
		fmt.Sprintf("gonavi_web_db_wait_count_total %d", snapshot.DBWaitCount),
		"# TYPE gonavi_web_db_wait_duration_ms_total counter",
		fmt.Sprintf("gonavi_web_db_wait_duration_ms_total %d", snapshot.DBWaitDurationMs),
		"# TYPE gonavi_process_goroutines gauge",
		fmt.Sprintf("gonavi_process_goroutines %d", snapshot.Goroutines),
		"# TYPE gonavi_process_heap_alloc_bytes gauge",
		fmt.Sprintf("gonavi_process_heap_alloc_bytes %d", snapshot.HeapAllocBytes),
	}
	methods := make([]string, 0, len(snapshot.InvokeByMethod))
	for method := range snapshot.InvokeByMethod {
		methods = append(methods, method)
	}
	sort.Strings(methods)
	for _, method := range methods {
		label := strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(method)
		lines = append(lines, fmt.Sprintf(`gonavi_web_invoke_method_total{method="%s"} %d`, label, snapshot.InvokeByMethod[method]))
		lines = append(lines, fmt.Sprintf(`gonavi_web_invoke_method_errors_total{method="%s"} %d`, label, snapshot.InvokeErrorByMethod[method]))
	}
	for _, line := range lines {
		_, _ = fmt.Fprintln(w, line)
	}
}
