package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/importjob"

	"github.com/google/uuid"
)

var errImportTaskNotFound = errors.New("import task not found")

type importTaskRegistration struct {
	token            string
	kind             importjob.Kind
	cancel           context.CancelFunc
	lifecycle        *managedImportJob
	stopRequested    bool
	cancelDispatched bool
}

func (a *App) registerImportTask(jobID string, cancel context.CancelFunc, kinds ...importjob.Kind) (func(), bool) {
	kind := importjob.Kind("")
	if len(kinds) > 0 {
		kind = kinds[0]
	}
	a.importTaskMu.Lock()
	closing := a.importTasksClosing
	a.importTaskMu.Unlock()
	if closing {
		return func() {}, false
	}
	cleanupQuery, registered := a.registerExclusiveRunningQuery(jobID, cancel, true)
	if !registered {
		return func() {}, false
	}
	token := uuid.NewString()
	a.importTaskMu.Lock()
	if a.importTasksClosing {
		a.importTaskMu.Unlock()
		cleanupQuery()
		return func() {}, false
	}
	if a.importTasks == nil {
		a.importTasks = make(map[string]importTaskRegistration)
	}
	a.importTasks[jobID] = importTaskRegistration{token: token, kind: kind, cancel: cancel}
	a.importTasksWG.Add(1)
	a.importTaskMu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			cleanupQuery()
			a.importTaskMu.Lock()
			if current, exists := a.importTasks[jobID]; exists && current.token == token {
				delete(a.importTasks, jobID)
			}
			a.importTaskMu.Unlock()
			a.importTasksWG.Done()
		})
	}, true
}

// bindImportTaskLifecycle attaches durable state after task registration. A
// cancel request that arrives while the durable job is still being created is
// remembered and persisted as stopping immediately after the bind completes.
func (a *App) bindImportTaskLifecycle(jobID string, kind importjob.Kind, lifecycle *managedImportJob) (bool, error) {
	jobID = strings.TrimSpace(jobID)
	if lifecycle == nil {
		return false, errors.New("import job lifecycle is unavailable")
	}
	a.importTaskMu.Lock()
	task, exists := a.importTasks[jobID]
	if !exists {
		a.importTaskMu.Unlock()
		return false, nil
	}
	if task.kind != "" && kind != "" && task.kind != kind {
		a.importTaskMu.Unlock()
		return false, errors.New("import task kind does not match durable job kind")
	}
	if kind != "" {
		task.kind = kind
	}
	task.lifecycle = lifecycle
	stopRequested := task.stopRequested
	a.importTasks[jobID] = task
	a.importTaskMu.Unlock()

	if stopRequested {
		if err := lifecycle.requestStop(); err != nil {
			return true, err
		}
	}
	return true, nil
}

// requestImportTaskCancellation only resolves registrations owned by the
// import runtime. It intentionally never falls back to runningQueries, where
// ordinary query executions are tracked too.
func (a *App) requestImportTaskCancellation(jobID string, expectedKind importjob.Kind) error {
	jobID = strings.TrimSpace(jobID)
	a.importTaskMu.Lock()
	task, exists := a.importTasks[jobID]
	if !exists || (expectedKind != "" && task.kind != expectedKind) {
		a.importTaskMu.Unlock()
		return errImportTaskNotFound
	}
	task.stopRequested = true
	var cancel context.CancelFunc
	if !task.cancelDispatched {
		task.cancelDispatched = true
		cancel = task.cancel
	}
	lifecycle := task.lifecycle
	a.importTasks[jobID] = task
	a.importTaskMu.Unlock()

	var stopErr error
	if lifecycle != nil {
		stopErr = lifecycle.requestStop()
	}
	if cancel != nil {
		cancel()
	}
	return stopErr
}

func (a *App) cancelAndWaitImportTasks(timeout time.Duration) bool {
	a.importTaskMu.Lock()
	a.importTasksClosing = true
	jobIDs := make([]string, 0, len(a.importTasks))
	for jobID := range a.importTasks {
		jobIDs = append(jobIDs, jobID)
	}
	a.importTaskMu.Unlock()
	for _, jobID := range jobIDs {
		_ = a.requestImportTaskCancellation(jobID, "")
	}
	done := make(chan struct{})
	go func() {
		a.importTasksWG.Wait()
		close(done)
	}()
	if timeout <= 0 {
		<-done
		return true
	}
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}
