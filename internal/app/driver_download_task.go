package app

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"github.com/google/uuid"
)

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
	if activeTask, ok := a.activeDriverDownloadTaskLocked(); ok {
		a.driverDownloadTaskMu.Unlock()
		return connection.QueryResult{Success: true, Data: map[string]interface{}{
			"task":           activeTask,
			"alreadyRunning": true,
		}}
	}

	task := DriverDownloadTaskStatus{
		TaskID:      uuid.NewString(),
		DriverType:  normalizedDriverType,
		Version:     strings.TrimSpace(version),
		DownloadURL: strings.TrimSpace(downloadURL),
		DownloadDir: strings.TrimSpace(downloadDir),
		Status:      "start",
		Percent:     0,
		Message:     a.appText("driver_manager.progress.agent_install_start", map[string]any{"name": a.driverStatusDisplayName(definition)}),
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
	a.driverDownloadActiveTaskID = task.TaskID
	runner := a.driverDownloadTaskRunner
	a.driverDownloadTaskMu.Unlock()

	if runner == nil {
		runner = a.DownloadDriverPackage
	}
	go a.runDriverPackageDownloadTask(task, runner)

	return connection.QueryResult{Success: true, Data: map[string]interface{}{
		"task":           task,
		"alreadyRunning": false,
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

func (a *App) runDriverPackageDownloadTask(task DriverDownloadTaskStatus, runner func(string, string, string, string) connection.QueryResult) {
	result := connection.QueryResult{Success: false, Message: "driver download did not run"}
	defer func() {
		if recovered := recover(); recovered != nil {
			result = connection.QueryResult{Success: false, Message: fmt.Sprintf("driver download panic: %v", recovered)}
		}
		a.finishDriverDownloadTask(task.TaskID, result)
	}()
	result = runner(task.DriverType, task.Version, task.DownloadURL, task.DownloadDir)
}

func (a *App) activeDriverDownloadTaskLocked() (DriverDownloadTaskStatus, bool) {
	taskID := strings.TrimSpace(a.driverDownloadActiveTaskID)
	if taskID == "" {
		return DriverDownloadTaskStatus{}, false
	}
	task, ok := a.driverDownloadTasks[taskID]
	if !ok || !task.Running {
		a.driverDownloadActiveTaskID = ""
		return DriverDownloadTaskStatus{}, false
	}
	return task, true
}

func (a *App) updateDriverDownloadTaskProgress(driverType string, status string, percent float64, message string) string {
	if a == nil {
		return ""
	}
	normalizedDriverType := normalizeDriverType(driverType)
	a.driverDownloadTaskMu.Lock()
	defer a.driverDownloadTaskMu.Unlock()
	task, ok := a.activeDriverDownloadTaskLocked()
	if !ok || task.DriverType != normalizedDriverType {
		return ""
	}
	if task.Status == "done" || task.Status == "error" {
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

func (a *App) finishDriverDownloadTask(taskID string, result connection.QueryResult) {
	if a == nil {
		return
	}
	a.driverDownloadTaskMu.Lock()
	task, ok := a.driverDownloadTasks[strings.TrimSpace(taskID)]
	if !ok {
		a.driverDownloadTaskMu.Unlock()
		return
	}
	terminalAlreadyEmitted := task.Status == "done" || task.Status == "error"
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
	if a.driverDownloadActiveTaskID == task.TaskID {
		a.driverDownloadActiveTaskID = ""
	}
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
	case "start", "downloading", "done", "error":
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
