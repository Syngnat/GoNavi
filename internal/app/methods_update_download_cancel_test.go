package app

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	stdRuntime "runtime"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/uievents"
)

type updateDownloadProgressRecorder struct {
	mu     sync.Mutex
	events []updateDownloadProgressPayload
}

func (r *updateDownloadProgressRecorder) Emit(name string, args ...any) {
	if name != updateDownloadProgressEvent || len(args) != 1 {
		return
	}
	payload, ok := args[0].(updateDownloadProgressPayload)
	if !ok {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, payload)
}

func (r *updateDownloadProgressRecorder) snapshot() []updateDownloadProgressPayload {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]updateDownloadProgressPayload(nil), r.events...)
}

func waitForUpdateDownloadTaskToFinish(t *testing.T, app *App, taskID string, timeout time.Duration) *UpdateDownloadTaskStatus {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		snapshot := app.updateState.task
		if snapshot != nil && snapshot.TaskID == taskID && !snapshot.Running {
			return snapshot
		}
		if time.Now().After(deadline) {
			t.Fatalf("update task %s did not finish within %s: %#v", taskID, timeout, snapshot)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func startCancelableDevUpdateDownload(t *testing.T, blockUntilCanceled *bool, started chan struct{}) (*App, *UpdateDownloadTaskStatus, *updateDownloadProgressRecorder, chan struct{}) {
	t.Helper()
	app, installMode := newDevUpdateDownloadTestApp(t)
	recorder := &updateDownloadProgressRecorder{}
	app.ctx = uievents.WithEmitter(context.Background(), recorder)

	payload := []byte("cancelable dev update package")
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-cancel", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode: %v", err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	app.updateState.lastCheck = updateInfoFromReleaseForTest(
		t,
		devUpdateReleaseForTest(t, "dev-cancel", devUpdateDispatcherAssetURL("dev-cancel", assetName), payload, installMode),
		installMode,
	)

	var mu sync.Mutex
	var startOnce sync.Once
	var cancelOnce sync.Once
	workerCanceled := make(chan struct{})
	original := updateDownloadFileWithExpectedSize
	t.Cleanup(func() { updateDownloadFileWithExpectedSize = original })
	updateDownloadFileWithExpectedSize = func(ctx context.Context, _ string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		mu.Lock()
		blocking := *blockUntilCanceled
		mu.Unlock()
		if blocking {
			startOnce.Do(func() { close(started) })
			<-ctx.Done()
			cancelOnce.Do(func() { close(workerCanceled) })
			return "", ctx.Err()
		}
		if writeErr := os.WriteFile(assetPath, payload, 0o644); writeErr != nil {
			return "", writeErr
		}
		if onProgress != nil {
			onProgress(int64(len(payload)), expectedSize)
		}
		return hash, nil
	}

	result := app.StartUpdateDownload()
	if !result.Success {
		t.Fatalf("StartUpdateDownload failed: %#v", result)
	}
	task, ok := result.Data.(map[string]interface{})["task"].(*UpdateDownloadTaskStatus)
	if !ok || task == nil {
		t.Fatalf("StartUpdateDownload returned no task: %#v", result.Data)
	}
	return app, task, recorder, workerCanceled
}

func TestCancelUpdateDownloadInterruptsWorkerAndAllowsRestart(t *testing.T) {
	blocking := true
	started := make(chan struct{})
	app, task, recorder, workerCanceled := startCancelableDevUpdateDownload(t, &blocking, started)

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("update download worker did not start")
	}

	cancelResult := app.CancelUpdateDownload()
	if !cancelResult.Success {
		t.Fatalf("CancelUpdateDownload failed: %#v", cancelResult)
	}
	// The worker must observe the cancellation: marking the task canceled is not
	// enough if the in-flight request keeps streaming.
	select {
	case <-workerCanceled:
	case <-time.After(5 * time.Second):
		t.Fatal("canceled download worker never observed the cancellation")
	}

	finished := waitForUpdateDownloadTaskToFinish(t, app, task.TaskID, 5*time.Second)
	if finished.Status != "canceled" || finished.Running {
		t.Fatalf("canceled task = %#v, want status=canceled running=false", finished)
	}
	if app.updateState.downloading {
		t.Fatal("canceled download still holds the download lease")
	}
	if app.updateState.taskCancel != nil {
		t.Fatal("canceled download left its cancel function registered")
	}
	if app.updateState.staged != nil {
		t.Fatalf("canceled download staged a package: %#v", app.updateState.staged)
	}

	for _, event := range recorder.snapshot() {
		if event.TaskID != task.TaskID {
			continue
		}
		if event.Status == "done" || event.Status == "error" {
			t.Fatalf("canceled download published a terminal progress event: %#v", event)
		}
	}

	// A canceled task must not block a retry, and the retry must be able to stage.
	blocking = false
	retry := app.StartUpdateDownload()
	if !retry.Success {
		t.Fatalf("retry after cancel failed: %#v", retry)
	}
	retryData := retry.Data.(map[string]interface{})
	if retryData["alreadyRunning"] == true {
		t.Fatalf("canceled task still blocks a new download: %#v", retryData)
	}
	retryTask := retryData["task"].(*UpdateDownloadTaskStatus)
	if retryTask.TaskID == task.TaskID {
		t.Fatal("retry reused the canceled task id")
	}
	if done := waitForUpdateDownloadTaskToFinish(t, app, retryTask.TaskID, 5*time.Second); done.Status != "done" {
		t.Fatalf("retry task = %#v, want status=done", done)
	}
	if app.updateState.staged == nil {
		t.Fatal("retry did not stage the downloaded package")
	}
}

func TestCancelUpdateDownloadWithoutActiveTaskReportsFailure(t *testing.T) {
	app, _ := newDevUpdateDownloadTestApp(t)
	app.ctx = uievents.WithEmitter(context.Background(), &updateDownloadProgressRecorder{})

	result := app.CancelUpdateDownload()
	if result.Success {
		t.Fatalf("cancel without an active download succeeded: %#v", result)
	}
	if result.Message == "" {
		t.Fatal("cancel without an active download returned an empty message")
	}
}
