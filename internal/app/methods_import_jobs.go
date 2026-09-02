package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/logger"
)

func (a *App) ensureImportJobStore() (*importjob.Store, error) {
	a.importJobMu.Lock()
	defer a.importJobMu.Unlock()
	if a.importJobStore != nil {
		return a.importJobStore, nil
	}
	configDir := strings.TrimSpace(a.configDir)
	if configDir == "" {
		configDir = resolveAppConfigDir()
	}
	store, err := importjob.Open(filepath.Join(configDir, "import-jobs"))
	if err != nil {
		return nil, err
	}
	a.importJobStore = store
	return store, nil
}

func (a *App) recoverImportJobsOnStartup() error {
	store, err := a.ensureImportJobStore()
	if err != nil {
		return err
	}
	_, err = store.RecoverInterrupted()
	var warning *importjob.CorruptJobFilesWarning
	if errors.As(err, &warning) {
		logger.Warnf("已跳过损坏的导入任务元数据文件：数量=%d", warning.Count)
		return nil
	}
	return err
}

func (a *App) ListImportJobs() connection.QueryResult {
	store, err := a.ensureImportJobStore()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	jobs, err := store.List()
	if err != nil {
		var warning *importjob.CorruptJobFilesWarning
		if errors.As(err, &warning) {
			logger.Warnf("已跳过损坏的导入任务元数据文件：数量=%d", warning.Count)
			return connection.QueryResult{Success: true, Message: warning.Error(), Data: a.webImportJobViews(jobs)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: a.webImportJobViews(jobs)}
}

func (a *App) GetImportJob(jobID string) connection.QueryResult {
	store, err := a.ensureImportJobStore()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	job, err := store.Get(jobID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: a.webImportJobView(job)}
}

func (a *App) webImportJobViews(jobs []importjob.Job) []importjob.Job {
	if a == nil || !a.webRuntime {
		return jobs
	}
	views := make([]importjob.Job, len(jobs))
	for index := range jobs {
		views[index] = a.webImportJobView(jobs[index])
	}
	return views
}

func (a *App) webImportJobView(job importjob.Job) importjob.Job {
	if a == nil || !a.webRuntime {
		return job
	}
	sourcePath := strings.TrimSpace(job.SourcePath)
	job.SourcePath = ""
	if sourcePath != "" && job.Message != "" {
		job.Message = strings.ReplaceAll(job.Message, sourcePath, filepath.Base(sourcePath))
	}
	return job
}

// CancelImportJob requests cancellation for a table or SQL import task. The
// registration remains owned by the running task until it has fully unwound,
// so repeated requests are idempotent during shutdown.
func (a *App) CancelImportJob(jobID string) connection.QueryResult {
	return a.cancelImportTaskByKind(jobID, "")
}

func (a *App) cancelImportTaskByKind(jobID string, kind importjob.Kind) connection.QueryResult {
	if err := a.requestImportTaskCancellation(jobID, kind); err != nil {
		if errors.Is(err, errImportTaskNotFound) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.task_not_found", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.cancel_requested", nil)}
}

func (a *App) DeleteImportJob(jobID string) connection.QueryResult {
	store, err := a.ensureImportJobStore()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	job, err := store.Get(jobID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	switch job.Status {
	case importjob.StatusPreparing, importjob.StatusRunning, importjob.StatusStopping:
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_running", nil)}
	}
	if err := store.Delete(jobID); err != nil {
		if errors.Is(err, importjob.ErrNotFound) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_not_found", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if artifactID := strings.TrimSpace(job.ErrorArtifactID); artifactID != "" {
		artifactStore, err := a.ensureImportErrorArtifactStore()
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		if err := artifactStore.Delete(artifactID); err != nil && !errors.Is(err, os.ErrNotExist) {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	return connection.QueryResult{Success: true}
}
