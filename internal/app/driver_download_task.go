package app

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"github.com/google/uuid"
)

type driverDownloadTaskRunner func(
	context.Context,
	string,
	string,
	string,
	string,
) connection.QueryResult

type driverDownloadTaskControl struct {
	cancel context.CancelFunc
}

type driverDownloadTaskContextKey struct{}

func withDriverDownloadTaskID(ctx context.Context, taskID string) context.Context {
	return context.WithValue(ctx, driverDownloadTaskContextKey{}, strings.TrimSpace(taskID))
}

func driverDownloadTaskIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	taskID, _ := ctx.Value(driverDownloadTaskContextKey{}).(string)
	return strings.TrimSpace(taskID)
}

// DriverDownloadTaskStatus is the durable, in-process state for a driver
// package download. It intentionally survives a driver-manager modal close so
// the next modal instance can restore the actual task instead of inferring its
// state from whether the package has already been installed.
type DriverDownloadTaskStatus struct {
	TaskID      string  `json:"taskId"`
	DriverType  string  `json:"driverType"`
	Version     string  `json:"version,omitempty"`
	DownloadURL string  `json:"downloadUrl,omitempty"`
	DownloadDir string  `json:"downloadDir,omitempty"`
	Status      string  `json:"status"`
	Percent     float64 `json:"percent"`
	Message     string  `json:"message,omitempty"`
	Running     bool    `json:"running"`
	StartedAt   string  `json:"startedAt"`
	FinishedAt  string  `json:"finishedAt,omitempty"`
}

func (a *App) StartDriverPackageDownload(driverType string, version string, downloadURL string, downloadDir string) connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}

	normalizedDriverType := normalizeDriverType(driverType)
	definition, ok := resolveDriverDefinition(normalizedDriverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.unsupported_driver_type", nil)}
	}

	a.driverDownloadTaskMu.Lock()
	// 只对「同一驱动类型」去重：不同类型允许并行安装。
	if activeTask, ok := a.activeDriverDownloadTaskLocked(normalizedDriverType); ok {
		a.driverDownloadTaskMu.Unlock()
		return connection.QueryResult{Success: true, Data: map[string]interface{}{
			"task":           activeTask,
			"alreadyRunning": true,
		}}
	}

	startMessage := a.appText("driver_manager.progress.agent_install_start", map[string]any{"name": a.driverStatusDisplayName(definition)})
	if v := strings.TrimSpace(version); v != "" {
		startMessage = a.appText("driver_manager.progress.agent_install_start_with_version", map[string]any{"name": a.driverStatusDisplayName(definition), "version": v})
	}
	task := DriverDownloadTaskStatus{
		TaskID:      uuid.NewString(),
		DriverType:  normalizedDriverType,
		Version:     strings.TrimSpace(version),
		DownloadURL: strings.TrimSpace(downloadURL),
		DownloadDir: strings.TrimSpace(downloadDir),
		Status:      "start",
		Percent:     0,
		Message:     startMessage,
		Running:     true,
		StartedAt:   time.Now().Format(time.RFC3339),
	}
	if a.driverDownloadTasks == nil {
		a.driverDownloadTasks = make(map[string]DriverDownloadTaskStatus)
	}
	for taskID, existingTask := range a.driverDownloadTasks {
		if !existingTask.Running {
			delete(a.driverDownloadTasks, taskID)
		}
	}
	a.driverDownloadTasks[task.TaskID] = task
	if a.driverDownloadActiveTaskIDByType == nil {
		a.driverDownloadActiveTaskIDByType = make(map[string]string)
	}
	a.driverDownloadActiveTaskIDByType[normalizedDriverType] = task.TaskID
	runner := a.driverDownloadTaskRunner
	parentContext := a.ctx
	if parentContext == nil {
		parentContext = context.Background()
	}
	taskContext, cancel := context.WithCancel(parentContext)
	if a.driverDownloadTaskControls == nil {
		a.driverDownloadTaskControls = make(map[string]driverDownloadTaskControl)
	}
	a.driverDownloadTaskControls[task.TaskID] = driverDownloadTaskControl{cancel: cancel}
	a.driverDownloadTaskMu.Unlock()

	if runner == nil {
		runner = a.downloadDriverPackage
	}
	go a.runDriverPackageDownloadTask(withDriverDownloadTaskID(taskContext, task.TaskID), cancel, task, runner)

	return connection.QueryResult{Success: true, Data: map[string]interface{}{
		"task":           task,
		"alreadyRunning": false,
	}}
}

// CancelDriverPackageDownload requests cancellation for exactly one active
// driver task. The task is marked terminal before returning so late progress
// from the canceled worker cannot overwrite the canceled snapshot.
func (a *App) CancelDriverPackageDownload(taskID string) connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	normalizedTaskID := strings.TrimSpace(taskID)
	if normalizedTaskID == "" {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.download_task_not_found", nil)}
	}

	a.driverDownloadTaskMu.Lock()
	task, ok := a.driverDownloadTasks[normalizedTaskID]
	if !ok {
		a.driverDownloadTaskMu.Unlock()
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.download_task_not_found", nil)}
	}
	if !task.Running || task.Status == "done" || task.Status == "error" {
		// A worker that already emitted its terminal progress has finished the
		// real work (for example, the metadata is written); reporting it as
		// canceled would hide an installed driver from the user.
		a.driverDownloadTaskMu.Unlock()
		return connection.QueryResult{Success: true, Data: map[string]interface{}{
			"task":            task,
			"alreadyFinished": true,
		}}
	}

	control := a.driverDownloadTaskControls[normalizedTaskID]
	if control.cancel != nil {
		control.cancel()
	}
	task.Status = "canceled"
	task.Message = a.appText("driver_manager.progress.download_canceled", nil)
	task.Running = false
	task.FinishedAt = time.Now().Format(time.RFC3339)
	a.driverDownloadTasks[normalizedTaskID] = task
	delete(a.driverDownloadTaskControls, normalizedTaskID)
	a.clearActiveDriverDownloadTaskLocked(task.DriverType, normalizedTaskID)
	a.driverDownloadTaskMu.Unlock()

	a.emitDriverDownloadTaskSnapshot(task)
	return connection.QueryResult{Success: true, Data: map[string]interface{}{
		"task": task,
	}}
}

// ListDriverDownloadTasks returns task snapshots rather than relying on event
// replay. Events are transient while a modal is closed; this is the source of
// truth used to hydrate a newly opened driver manager.
func (a *App) ListDriverDownloadTasks() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	a.driverDownloadTaskMu.RLock()
	tasks := make([]DriverDownloadTaskStatus, 0, len(a.driverDownloadTasks))
	for _, task := range a.driverDownloadTasks {
		tasks = append(tasks, task)
	}
	a.driverDownloadTaskMu.RUnlock()

	sort.Slice(tasks, func(left int, right int) bool {
		return tasks[left].StartedAt > tasks[right].StartedAt
	})
	return connection.QueryResult{Success: true, Data: tasks}
}

func (a *App) runDriverPackageDownloadTask(ctx context.Context, cancel context.CancelFunc, task DriverDownloadTaskStatus, runner driverDownloadTaskRunner) {
	result := connection.QueryResult{Success: false, Message: "driver download did not run"}
	defer func() {
		if recovered := recover(); recovered != nil {
			result = connection.QueryResult{Success: false, Message: fmt.Sprintf("driver download panic: %v", recovered)}
		}
		// Read the context error before releasing it: a user cancellation must
		// be recorded as "canceled" rather than as a generic failure.
		a.finishDriverDownloadTask(task.TaskID, result, ctx.Err())
		cancel()
	}()
	result = runner(ctx, task.DriverType, task.Version, task.DownloadURL, task.DownloadDir)
}

func (a *App) activeDriverDownloadTaskLocked(driverType string) (DriverDownloadTaskStatus, bool) {
	normalizedDriverType := normalizeDriverType(driverType)
	if normalizedDriverType == "" || a.driverDownloadActiveTaskIDByType == nil {
		return DriverDownloadTaskStatus{}, false
	}
	taskID := strings.TrimSpace(a.driverDownloadActiveTaskIDByType[normalizedDriverType])
	if taskID == "" {
		return DriverDownloadTaskStatus{}, false
	}
	task, ok := a.driverDownloadTasks[taskID]
	if !ok || !task.Running {
		delete(a.driverDownloadActiveTaskIDByType, normalizedDriverType)
		return DriverDownloadTaskStatus{}, false
	}
	return task, true
}

// clearActiveDriverDownloadTaskLocked 清理某个类型或某个 taskID 的活动登记。
func (a *App) clearActiveDriverDownloadTaskLocked(driverType string, taskID string) {
	if a.driverDownloadActiveTaskIDByType == nil {
		return
	}
	if driverType != "" {
		if a.driverDownloadActiveTaskIDByType[driverType] == taskID {
			delete(a.driverDownloadActiveTaskIDByType, driverType)
		}
		return
	}
	for registeredType, registeredTaskID := range a.driverDownloadActiveTaskIDByType {
		if registeredTaskID == taskID {
			delete(a.driverDownloadActiveTaskIDByType, registeredType)
		}
	}
}

func (a *App) updateDriverDownloadTaskProgress(driverType string, status string, percent float64, message string) string {
	return a.updateDriverDownloadTaskProgressForTask("", driverType, status, percent, message)
}

func (a *App) updateDriverDownloadTaskProgressForTask(taskID string, driverType string, status string, percent float64, message string) string {
	if a == nil {
		return ""
	}
	normalizedDriverType := normalizeDriverType(driverType)
	normalizedTaskID := strings.TrimSpace(taskID)
	a.driverDownloadTaskMu.Lock()
	defer a.driverDownloadTaskMu.Unlock()
	var task DriverDownloadTaskStatus
	var ok bool
	if normalizedTaskID != "" {
		task, ok = a.driverDownloadTasks[normalizedTaskID]
		if !ok || !task.Running || task.DriverType != normalizedDriverType {
			return ""
		}
	} else {
		// 无 taskID 的进度（本地安装 / 删除）按驱动类型定位归属任务。
		task, ok = a.activeDriverDownloadTaskLocked(normalizedDriverType)
	}
	if !ok || task.DriverType != normalizedDriverType {
		return ""
	}
	if task.Status == "done" || task.Status == "error" || task.Status == "canceled" {
		return task.TaskID
	}
	nextStatus := normalizeDriverDownloadTaskStatus(status)
	nextPercent := clampDriverDownloadTaskPercent(percent)
	if nextStatus == "start" {
		nextPercent = 0
	}
	if nextStatus == "done" {
		nextPercent = 100
	}
	if nextStatus == "error" && task.Percent > nextPercent {
		nextPercent = task.Percent
	}
	task.Status = nextStatus
	task.Percent = nextPercent
	if trimmedMessage := strings.TrimSpace(message); trimmedMessage != "" {
		task.Message = trimmedMessage
	}
	a.driverDownloadTasks[task.TaskID] = task
	return task.TaskID
}

func (a *App) finishDriverDownloadTask(taskID string, result connection.QueryResult, contextErr error) {
	if a == nil {
		return
	}
	a.driverDownloadTaskMu.Lock()
	task, ok := a.driverDownloadTasks[strings.TrimSpace(taskID)]
	if !ok {
		a.driverDownloadTaskMu.Unlock()
		return
	}
	if task.Running && errors.Is(contextErr, context.Canceled) {
		task.Status = "canceled"
		task.Message = a.appText("driver_manager.progress.download_canceled", nil)
	}
	terminalAlreadyEmitted := task.Status == "done" || task.Status == "error" || task.Status == "canceled"
	if !terminalAlreadyEmitted {
		if result.Success {
			task.Status = "done"
			task.Percent = 100
		} else {
			task.Status = "error"
		}
		if message := strings.TrimSpace(result.Message); message != "" {
			task.Message = message
		}
	}
	task.Running = false
	task.FinishedAt = time.Now().Format(time.RFC3339)
	a.driverDownloadTasks[task.TaskID] = task
	delete(a.driverDownloadTaskControls, task.TaskID)
	a.clearActiveDriverDownloadTaskLocked(task.DriverType, task.TaskID)
	a.driverDownloadTaskMu.Unlock()

	// DownloadDriverPackage normally emits its own terminal progress event. If
	// it fails before reaching that path (for example, during argument
	// validation), emit the final snapshot here so an already-open manager does
	// not remain stuck at "starting".
	if !terminalAlreadyEmitted {
		a.emitDriverDownloadTaskSnapshot(task)
	}
}

func normalizeDriverDownloadTaskStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "start", "downloading", "done", "error", "canceled":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "downloading"
	}
}

func clampDriverDownloadTaskPercent(percent float64) float64 {
	if percent < 0 {
		return 0
	}
	if percent > 100 {
		return 100
	}
	return percent
}
