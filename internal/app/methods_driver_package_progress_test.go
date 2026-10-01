package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/uievents"
)

// driverPackageExportEventRecorder 只收集驱动包导出进度事件，忽略其它事件。
type driverPackageExportEventRecorder struct {
	mu     sync.Mutex
	events []driverPackageExportProgressPayload
}

func (r *driverPackageExportEventRecorder) Emit(name string, args ...any) {
	if name != driverPackageExportProgressEvent || len(args) != 1 {
		return
	}
	payload, ok := args[0].(driverPackageExportProgressPayload)
	if !ok {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, payload)
}

func (r *driverPackageExportEventRecorder) snapshot() []driverPackageExportProgressPayload {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]driverPackageExportProgressPayload(nil), r.events...)
}

// swellFakeDriverBinary 把假驱动二进制撑到 size 字节。进度按字节上报并按 8 MiB
// 节流，几十字节的假二进制永远跨不过阈值，也就观测不到 running 事件。
func swellFakeDriverBinary(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.WriteFile(path, make([]byte, size), 0o755); err != nil {
		t.Fatalf("撑大假驱动二进制失败: %v", err)
	}
}

// waitForExportTaskRegistration 等待 jobID 完成取消任务登记。调用方先占住
// 全类型排他锁，导出线程登记完 ctx 后必然阻塞在该锁上，因此轮询一定会命中。
func waitForExportTaskRegistration(t *testing.T, app *App, jobID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		app.exportTaskMu.Lock()
		_, registered := app.exportTasks[jobID]
		app.exportTaskMu.Unlock()
		if registered {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("导出任务 %s 未在超时内登记", jobID)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func newExportRecordingApp(target string, recorder *driverPackageExportEventRecorder) *App {
	app := NewApp()
	app.ctx = uievents.WithEmitter(context.Background(), recorder)
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return target, nil
	}
	return app
}

// TestExportDriverPackageReportsMonotonicProgress 断言导出进度事件的状态序列与
// 字节单调性。刻意断言状态序列而非时序，避免依赖节流的时间窗口。
func TestExportDriverPackageReportsMonotonicProgress(t *testing.T) {
	root := t.TempDir()
	mariadbBinary := installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")
	swellFakeDriverBinary(t, mariadbBinary, 9<<20)
	installFakeDriverPackage(t, root, "duckdb", "2.5.6", "src-64700b9b23a5dbd4")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	recorder := &driverPackageExportEventRecorder{}
	app := newExportRecordingApp(target, recorder)

	result := app.ExportDriverPackage(root, "job-progress")
	if !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	events := recorder.snapshot()
	if len(events) < 3 {
		t.Fatalf("导出应产生 start/running/done 事件，实际: %#v", events)
	}
	if events[0].Status != "start" {
		t.Fatalf("首个事件应为 start，实际: %#v", events[0])
	}
	if last := events[len(events)-1]; last.Status != "done" {
		t.Fatalf("末个事件应为 done，实际: %#v", last)
	}

	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("导出结果缺少 Data: %#v", result.Data)
	}
	totalBytes, _ := data["totalBytes"].(int64)
	if totalBytes <= 0 {
		t.Fatalf("totalBytes 应为正数，实际: %#v", data["totalBytes"])
	}

	var sawRunning bool
	previous := int64(-1)
	for _, event := range events {
		if event.JobID != "job-progress" {
			t.Fatalf("进度事件必须带回本次 jobID，实际: %#v", event)
		}
		if event.Total != totalBytes {
			t.Fatalf("进度事件分母应等于 totalBytes，want=%d got=%d", totalBytes, event.Total)
		}
		if event.Written < previous {
			t.Fatalf("已写字节必须单调不减，实际: %#v", events)
		}
		previous = event.Written
		if event.Status == "running" {
			sawRunning = true
		}
	}
	if !sawRunning {
		t.Fatalf("9MiB 驱动应跨过 8MiB 节流阈值并产生 running 事件，实际: %#v", events)
	}
	if previous != totalBytes {
		t.Fatalf("done 的已写字节应归一为总量，want=%d got=%d", totalBytes, previous)
	}
}

// TestExportDriverPackageDialogCancelEmitsNoProgress 覆盖「用户在保存对话框取消」
// 这条早退路径：还没进入写入阶段，不该有任何进度事件。
func TestExportDriverPackageDialogCancelEmitsNoProgress(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	recorder := &driverPackageExportEventRecorder{}
	app := newExportRecordingApp("", recorder)

	result := app.ExportDriverPackage(root, "job-dialog-cancel")
	if result.Success {
		t.Fatalf("用户取消对话框应返回失败，实际: %#v", result)
	}
	if events := recorder.snapshot(); len(events) != 0 {
		t.Fatalf("尚未进入写入阶段不应上报进度，实际: %#v", events)
	}
}

// TestExportDriverPackageCanceledByUserLeavesNoResidue 覆盖运行期取消：
// 占住安装锁让取消时序完全确定，然后断言结果标记、临时文件清理与收尾事件。
func TestExportDriverPackageCanceledByUserLeavesNoResidue(t *testing.T) {
	root := t.TempDir()
	binary := installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")
	swellFakeDriverBinary(t, binary, 1<<20)

	targetDir := t.TempDir()
	target := filepath.Join(targetDir, "drivers.zip")
	recorder := &driverPackageExportEventRecorder{}
	app := newExportRecordingApp(target, recorder)

	releaseExportGate := app.driverInstallLock.lockAll()
	results := make(chan connection.QueryResult, 1)
	go func() {
		results <- app.ExportDriverPackage(root, "job-cancel")
	}()
	waitForExportTaskRegistration(t, app, "job-cancel")

	canceled := app.CancelExportFile("job-cancel")
	releaseExportGate()
	if !canceled.Success {
		t.Fatalf("取消请求应被受理，实际: %#v", canceled)
	}

	var result connection.QueryResult
	select {
	case result = <-results:
	case <-time.After(10 * time.Second):
		t.Fatalf("导出未在超时内收尾")
	}
	if result.Success {
		t.Fatalf("取消后导出应返回失败，实际: %#v", result)
	}
	data, ok := result.Data.(map[string]interface{})
	if !ok || data["canceled"] != true {
		t.Fatalf("取消结果必须带结构化标记 data.canceled，实际: %#v", result.Data)
	}

	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("取消后目标位置不应留下文件: %v", err)
	}
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		t.Fatalf("读取目标目录失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gonavi-export-") {
			t.Fatalf("取消后应清理原子写入的临时文件，残留: %s", entry.Name())
		}
	}

	events := recorder.snapshot()
	if len(events) == 0 || events[len(events)-1].Status != "canceled" {
		t.Fatalf("取消应以 canceled 事件收尾，实际: %#v", events)
	}

	// 任务登记必须随导出结束清理，否则 jobID 会在 map 里长期驻留。
	app.exportTaskMu.Lock()
	_, leaked := app.exportTasks["job-cancel"]
	app.exportTaskMu.Unlock()
	if leaked {
		t.Fatalf("导出结束后不应残留任务登记")
	}
}

// TestCollectDriverPackageCandidatesSumsSourceSizes 断言进度分母就是待写入
// 二进制与支持文件的体积之和——分母错了，前端进度条永远到不了 100%。
func TestCollectDriverPackageCandidatesSumsSourceSizes(t *testing.T) {
	root := t.TempDir()
	binary := installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")
	swellFakeDriverBinary(t, binary, 1<<20)
	installFakeDriverPackage(t, root, "duckdb", "2.5.6", "src-64700b9b23a5dbd4")

	candidates, skipped, totalBytes := collectDriverPackageCandidates(root)
	if len(skipped) != 0 {
		t.Fatalf("不应有被跳过的驱动，实际: %#v", skipped)
	}
	if len(candidates) != 2 {
		t.Fatalf("应收集到两个候选，实际: %#v", candidates)
	}

	var want int64
	for _, candidate := range candidates {
		info, err := os.Stat(candidate.binaryPath)
		if err != nil {
			t.Fatalf("统计二进制失败: %v", err)
		}
		want += info.Size()
		for _, support := range candidate.supportFiles {
			supportInfo, err := os.Stat(support.path)
			if err != nil {
				t.Fatalf("统计支持文件失败: %v", err)
			}
			want += supportInfo.Size()
		}
	}
	if totalBytes != want {
		t.Fatalf("totalBytes 应为二进制与支持文件体积之和，want=%d got=%d", want, totalBytes)
	}
	if want <= 1<<20 {
		t.Fatalf("测试自身失效：撑大的二进制未计入分母，want=%d", want)
	}
}
