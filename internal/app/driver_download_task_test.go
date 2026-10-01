package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestStartDriverPackageDownloadRunsAfterStarterReturns(t *testing.T) {
	app := NewApp()
	started := make(chan struct{})
	var startedOnce sync.Once
	release := make(chan struct{})
	app.driverDownloadTaskRunner = func(_ context.Context, driverType string, _ string, _ string, _ string) connection.QueryResult {
		app.emitDriverDownloadProgress(driverType, "downloading", 45, 100, "downloading driver")
		// 不同类型可并行后 runner 会被多次调用，只关一次。
		startedOnce.Do(func() { close(started) })
		<-release
		app.emitDriverDownloadProgress(driverType, "done", 100, 100, "driver installed")
		return connection.QueryResult{Success: true, Message: "driver installed"}
	}

	startedResult := app.StartDriverPackageDownload("duckdb", "2.5.6", "builtin://activate/duckdb", t.TempDir())
	if !startedResult.Success {
		t.Fatalf("start background driver download failed: %#v", startedResult)
	}

	data, ok := startedResult.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected starter data: %#v", startedResult.Data)
	}
	startedTask, ok := data["task"].(DriverDownloadTaskStatus)
	if !ok || startedTask.TaskID == "" || !startedTask.Running {
		t.Fatalf("starter did not return a running task: %#v", data["task"])
	}

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background driver download did not start")
	}

	listed := app.ListDriverDownloadTasks()
	if !listed.Success {
		t.Fatalf("list background driver downloads failed: %#v", listed)
	}
	tasks, ok := listed.Data.([]DriverDownloadTaskStatus)
	if !ok || len(tasks) != 1 {
		t.Fatalf("unexpected running task list: %#v", listed.Data)
	}
	if task := tasks[0]; !task.Running || task.Status != "downloading" || task.Percent != 45 {
		t.Fatalf("running task snapshot = %#v, want active 45%% download", task)
	}

	// 去重按驱动类型：同类型重复启动应复用既有任务。
	duplicate := app.StartDriverPackageDownload("duckdb", "2.5.6", "builtin://activate/duckdb", t.TempDir())
	if !duplicate.Success {
		t.Fatalf("duplicate start should return the running task: %#v", duplicate)
	}
	duplicateData, ok := duplicate.Data.(map[string]interface{})
	if !ok || duplicateData["alreadyRunning"] != true {
		t.Fatalf("duplicate start did not report the existing task: %#v", duplicate.Data)
	}
	if duplicateTask, ok := duplicateData["task"].(DriverDownloadTaskStatus); !ok || duplicateTask.TaskID != startedTask.TaskID {
		t.Fatalf("duplicate start did not reuse the running task: %#v", duplicateData["task"])
	}
	// 不同类型必须能并行启动：这是驱动并行安装的前提。
	concurrent := app.StartDriverPackageDownload("mongodb", "1.17.9", "builtin://activate/mongodb", t.TempDir())
	if !concurrent.Success {
		t.Fatalf("different driver type should start concurrently: %#v", concurrent)
	}
	concurrentData, ok := concurrent.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected concurrent data: %#v", concurrent.Data)
	}
	if concurrentData["alreadyRunning"] == true {
		t.Fatalf("different driver type was blocked by a global task gate: %#v", concurrentData)
	}
	if concurrentTask, ok := concurrentData["task"].(DriverDownloadTaskStatus); !ok || concurrentTask.TaskID == startedTask.TaskID {
		t.Fatalf("concurrent start reused the other type's task: %#v", concurrentData["task"])
	}

	close(release)
	// 两个任务（duckdb + mongodb）都要跑到终态。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		completed := app.ListDriverDownloadTasks()
		tasks, ok := completed.Data.([]DriverDownloadTaskStatus)
		if completed.Success && ok && len(tasks) == 2 {
			allFinished := true
			for _, task := range tasks {
				if task.Running {
					allFinished = false
					break
				}
			}
			if allFinished {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("background task did not finish: %#v", app.ListDriverDownloadTasks())
}

func TestStartDriverPackageDownloadRecordsFailureWithoutProgressEvent(t *testing.T) {
	app := NewApp()
	app.driverDownloadTaskRunner = func(_ context.Context, _ string, _ string, _ string, _ string) connection.QueryResult {
		return connection.QueryResult{Success: false, Message: "selected driver version is invalid"}
	}

	started := app.StartDriverPackageDownload("duckdb", "invalid", "builtin://activate/duckdb", t.TempDir())
	if !started.Success {
		t.Fatalf("start background driver download failed: %#v", started)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		listed := app.ListDriverDownloadTasks()
		tasks, ok := listed.Data.([]DriverDownloadTaskStatus)
		if listed.Success && ok && len(tasks) == 1 && !tasks[0].Running {
			if tasks[0].Status != "error" {
				t.Fatalf("terminal task status = %q, want error", tasks[0].Status)
			}
			if tasks[0].Message != "selected driver version is invalid" {
				t.Fatalf("terminal task message = %q", tasks[0].Message)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("background failure was not recorded: %#v", app.ListDriverDownloadTasks())
}

func TestStartDriverPackageDownloadPreservesProgressOnEmittedFailure(t *testing.T) {
	app := NewApp()
	app.driverDownloadTaskRunner = func(_ context.Context, driverType string, _ string, _ string, _ string) connection.QueryResult {
		app.emitDriverDownloadProgress(driverType, "downloading", 92, 100, "building local fallback")
		app.emitDriverDownloadProgress(driverType, "error", 0, 0, "driver download failed")
		return connection.QueryResult{Success: false, Message: "driver download failed"}
	}

	started := app.StartDriverPackageDownload("sqlserver", "1.9.6", "builtin://activate/sqlserver", t.TempDir())
	if !started.Success {
		t.Fatalf("start background driver download failed: %#v", started)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		listed := app.ListDriverDownloadTasks()
		tasks, ok := listed.Data.([]DriverDownloadTaskStatus)
		if listed.Success && ok && len(tasks) == 1 && !tasks[0].Running {
			task := tasks[0]
			if task.Status != "error" || task.Percent != 92 {
				t.Fatalf("terminal task = %#v, want status=error running=false percent=92", task)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("background failure was not recorded: %#v", app.ListDriverDownloadTasks())
}

func TestStartDriverPackageDownloadKeepsEmittedFailureTerminal(t *testing.T) {
	app := NewApp()
	staleProgressEmitted := make(chan struct{})
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	app.driverDownloadTaskRunner = func(_ context.Context, driverType string, _ string, _ string, _ string) connection.QueryResult {
		app.emitDriverDownloadProgress(driverType, "downloading", 92, 100, "building local fallback")
		app.emitDriverDownloadProgress(driverType, "error", 0, 0, "driver download failed")
		app.emitDriverDownloadProgress(driverType, "downloading", 95, 100, "stale download progress")
		close(staleProgressEmitted)
		<-release
		return connection.QueryResult{Success: false, Message: "driver download failed"}
	}

	started := app.StartDriverPackageDownload("sqlserver", "1.9.6", "builtin://activate/sqlserver", t.TempDir())
	if !started.Success {
		t.Fatalf("start background driver download failed: %#v", started)
	}

	select {
	case <-staleProgressEmitted:
	case <-time.After(time.Second):
		t.Fatal("background driver download did not emit stale progress")
	}

	listed := app.ListDriverDownloadTasks()
	tasks, ok := listed.Data.([]DriverDownloadTaskStatus)
	if !listed.Success || !ok || len(tasks) != 1 {
		t.Fatalf("unexpected running task list: %#v", listed.Data)
	}
	task := tasks[0]
	if !task.Running || task.Status != "error" || task.Percent != 92 {
		t.Fatalf("task after stale progress = %#v, want status=error running=true percent=92", task)
	}

	close(release)
}

func TestCancelDriverPackageDownloadCancelsRunnerAndPreservesCanceledState(t *testing.T) {
	app := NewApp()
	started := make(chan struct{})
	runnerReturned := make(chan struct{})
	app.driverDownloadTaskRunner = func(ctx context.Context, driverType string, _ string, _ string, _ string) connection.QueryResult {
		close(started)
		<-ctx.Done()
		app.emitDriverDownloadProgress(driverType, "downloading", 99, 100, "late progress")
		close(runnerReturned)
		return connection.QueryResult{Success: false, Message: "context canceled"}
	}

	startedResult := app.StartDriverPackageDownload("duckdb", "2.5.6", "builtin://activate/duckdb", t.TempDir())
	if !startedResult.Success {
		t.Fatalf("start background driver download failed: %#v", startedResult)
	}
	startedTask := startedResult.Data.(map[string]interface{})["task"].(DriverDownloadTaskStatus)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background driver download did not start")
	}

	cancelResult := app.CancelDriverPackageDownload(startedTask.TaskID)
	if !cancelResult.Success {
		t.Fatalf("cancel driver download failed: %#v", cancelResult)
	}
	select {
	case <-runnerReturned:
	case <-time.After(time.Second):
		t.Fatal("runner did not observe cancellation")
	}

	listed := app.ListDriverDownloadTasks()
	tasks := listed.Data.([]DriverDownloadTaskStatus)
	if len(tasks) != 1 {
		t.Fatalf("unexpected task list: %#v", listed.Data)
	}
	task := tasks[0]
	if task.Status != "canceled" || task.Running {
		t.Fatalf("canceled task = %#v, want status=canceled running=false", task)
	}

	repeat := app.CancelDriverPackageDownload(startedTask.TaskID)
	if !repeat.Success {
		t.Fatalf("repeated cancellation should be idempotent: %#v", repeat)
	}
	unknown := app.CancelDriverPackageDownload("not-the-active-task")
	if unknown.Success {
		t.Fatalf("unknown task cancellation unexpectedly succeeded: %#v", unknown)
	}
}
