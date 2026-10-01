package app

import (
	"strings"
	"time"

	"GoNavi-Wails/internal/uievents"
)

// 驱动包导出的进度上报。
//
// 刻意不复用 driver:download-progress：emitDriverDownloadProgressContext 会调用
// updateDriverDownloadTaskProgressForTask，而导出没有 task id，该函数会回退到
// 「当前活动下载任务」，把导出进度写进正常的驱动下载状态里。导出走独立事件。
const driverPackageExportProgressEvent = "driver:package-export-progress"

// 节流：导出单次可能写入上 GB，逐块发事件会把 UI 淹掉。
// 与 methods_file.go 的 exportProgressReporter 同口径，取一个较大的字节步长
// （导出按文件流式写入，块远大于行导出的 1000 行）。
const driverPackageExportByteInterval int64 = 8 << 20 // 8 MiB
const driverPackageExportTimeInterval = 500 * time.Millisecond

// driverPackageExportProgressPayload 是导出进度事件负载。
type driverPackageExportProgressPayload struct {
	JobID         string `json:"jobId"`
	Status        string `json:"status"` // start | running | done | canceled | error
	Written       int64  `json:"written"`
	Total         int64  `json:"total"`
	CurrentDriver string `json:"currentDriver,omitempty"`
	Message       string `json:"message,omitempty"`
}

// driverPackageExportReporter 把写入字节数节流后推给前端。
// 它只读不写业务状态，因此无需加锁；调用方（导出流程）本身已持有全类型排他锁。
type driverPackageExportReporter struct {
	app           *App
	jobID         string
	total         int64
	lastWritten   int64
	lastEmittedAt time.Time
}

func newDriverPackageExportReporter(app *App, jobID string, total int64) *driverPackageExportReporter {
	return &driverPackageExportReporter{app: app, jobID: strings.TrimSpace(jobID), total: total}
}

// emit 上报一次进度。force 用于 start/done 等关键节点，绕过节流保证前端一定能看到。
func (r *driverPackageExportReporter) emit(status string, written int64, driverType string, force bool) {
	if r == nil || r.app == nil || r.app.ctx == nil {
		return
	}
	now := time.Now()
	if !force && status == "running" {
		// 字节与时间双阈值：任一满足即放行。两个都不到就丢弃。
		if written-r.lastWritten < driverPackageExportByteInterval &&
			!r.lastEmittedAt.IsZero() && now.Sub(r.lastEmittedAt) < driverPackageExportTimeInterval {
			return
		}
	}
	payload := driverPackageExportProgressPayload{
		JobID:         r.jobID,
		Status:        strings.TrimSpace(status),
		Written:       written,
		Total:         r.total,
		CurrentDriver: normalizeDriverType(driverType),
	}
	uievents.Emit(r.app.ctx, driverPackageExportProgressEvent, payload)
	r.lastWritten = written
	r.lastEmittedAt = now
}

// Start 标记导出开始（已通过对话框选定路径，进入写入阶段）。
func (r *driverPackageExportReporter) Start() {
	r.emit("start", 0, "", true)
}

// Progress 上报写入推进；由 progressWriter 在复制过程中高频调用，内部负责节流。
func (r *driverPackageExportReporter) Progress(written int64, driverType string) {
	r.emit("running", written, driverType, false)
}

// Done 标记写入完成，此时 written 归一为 total，避免前端进度条停在 99%。
func (r *driverPackageExportReporter) Done() {
	r.emit("done", r.total, "", true)
}

// Canceled 标记导出被用户取消。
func (r *driverPackageExportReporter) Canceled() {
	r.emit("canceled", r.lastWritten, "", true)
}

// Error 标记导出失败；message 已是本地化文案。
func (r *driverPackageExportReporter) Error(message string) {
	if r == nil || r.app == nil || r.app.ctx == nil {
		return
	}
	uievents.Emit(r.app.ctx, driverPackageExportProgressEvent, driverPackageExportProgressPayload{
		JobID:   r.jobID,
		Status:  "error",
		Written: r.lastWritten,
		Total:   r.total,
		Message: strings.TrimSpace(message),
	})
}
