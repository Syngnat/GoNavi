package app

import (
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestStartDriverPackageDownloadRunsAfterStarterReturns(t *testing.T) {
	app := NewApp()
	started := make(chan struct{})
	release := make(chan struct{})
	app.driverDownloadTaskRunner = func(driverType string, _ string, _ string, _ string) connection.QueryResult {
		app.emitDriverDownloadProgress(driverType, "downloading", 45, 100, "downloading driver")
		close(started)
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

	duplicate := app.StartDriverPackageDownload("mongodb", "1.17.9", "builtin://activate/mongodb", t.TempDir())
	if !duplicate.Success {
		t.Fatalf("duplicate start should return the running task: %#v", duplicate)
	}
	duplicateData, ok := duplicate.Data.(map[string]interface{})
	if !ok || duplicateData["alreadyRunning"] != true {
		t.Fatalf("duplicate start did not report the existing task: %#v", duplicate.Data)
	}

	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		completed := app.ListDriverDownloadTasks()
		tasks, ok := completed.Data.([]DriverDownloadTaskStatus)
		if completed.Success && ok && len(tasks) == 1 && !tasks[0].Running && tasks[0].Status == "done" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("background task did not finish: %#v", app.ListDriverDownloadTasks())
}

func TestStartDriverPackageDownloadRecordsFailureWithoutProgressEvent(t *testing.T) {
	app := NewApp()
	app.driverDownloadTaskRunner = func(_ string, _ string, _ string, _ string) connection.QueryResult {
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
	app.driverDownloadTaskRunner = func(driverType string, _ string, _ string, _ string) connection.QueryResult {
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
	app.driverDownloadTaskRunner = func(driverType string, _ string, _ string, _ string) connection.QueryResult {
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
