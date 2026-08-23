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
