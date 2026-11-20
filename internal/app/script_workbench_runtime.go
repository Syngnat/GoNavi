package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/scriptlib"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/internal/webidentity"

	"github.com/google/uuid"
)

var (
	errScriptWorkbenchUnavailable = errors.New("script workbench is unavailable")
	errScriptWorkbenchRunNotFound = errors.New("script run not found or expired")
)

const (
	scriptWorkbenchRetainedRunTTL       = 15 * time.Minute
	scriptWorkbenchMaxRetainedRuns      = 15
	scriptWorkbenchMaxRetainedBytes     = 96 << 20
	scriptWorkbenchMaxUserRetainedBytes = 48 << 20
)

type scriptWorkbenchRuntime struct {
	mu           sync.Mutex
	store        *scriptlib.Store
	storeRoot    string
	runs         map[string]*scriptWorkbenchRun
	active       int
	activeByUser map[string]int
	closing      bool
	wg           sync.WaitGroup
	approvalMu   sync.Mutex
	approvals    map[string]scriptWorkbenchWriteApproval
}

type scriptWorkbenchRun struct {
	mu         sync.RWMutex
	finishOnce sync.Once

	id               string
	owner            string
	userKey          string
	scriptID         string
	title            string
	allowWrite       bool
	startedAt        int64
	finishedAt       int64
	status           string
	stage            string
	cancelled        bool
	timedOut         bool
	memoryExceeded   bool
	err              string
	errorKind        string
	dbCalls          int
	maxCalls         int
	maxOutputRows    int
	progress         map[string]any
	logs             []ScriptWorkbenchLogEntry
	logBytes         int
	logsTruncated    bool
	nextLogSequence  int64
	outputs          []*scriptWorkbenchOutput
	outputRows       int
	outputBytes      int
	outputsTruncated bool
	emitEnabled      bool

	ctx      context.Context
	cancel   context.CancelFunc
	eventCtx context.Context
	done     chan struct{}
	host     *scriptWorkbenchHost
}

func (a *App) scriptLibraryStore() *scriptlib.Store {
	if a == nil {
		return nil
	}
	runtime := &a.scriptWorkbench
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	root := strings.TrimSpace(a.configDir)
	if runtime.store == nil || runtime.storeRoot != root {
		runtime.store = scriptlib.NewStore(root)
		runtime.storeRoot = root
	}
	return runtime.store
}

func (a *App) scriptWorkbenchActor(ctx context.Context) (scriptlib.Actor, webScriptActor, error) {
	if a == nil {
		return scriptlib.Actor{}, webScriptActor{}, errScriptWorkbenchUnavailable
	}
	if !a.webRuntime {
		return scriptlib.Actor{
			Owner:           scriptlib.DesktopOwner(),
			CanManageShared: true,
		}, webScriptActor{username: "local", role: "admin"}, nil
	}
	actor, ok := webidentityActor(ctx)
	if !ok {
		return scriptlib.Actor{}, webScriptActor{}, errors.New("authenticated web user is required")
	}
	allowed := make(map[string]struct{}, len(actor.AllowedConnectionIDs))
	for _, id := range actor.AllowedConnectionIDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			allowed[trimmed] = struct{}{}
		}
	}
	readOnly := strings.EqualFold(string(actor.Role), "viewer")
	return scriptlib.Actor{
		Owner:           scriptlib.WebOwner(actor.Username),
		CanManageShared: strings.EqualFold(string(actor.Role), string(webidentity.RoleAdmin)),
		ReadOnly:        readOnly,
	}, webScriptActor{
		username:             actor.Username,
		role:                 string(actor.Role),
		allowedConnectionIDs: allowed,
	}, nil
}

func (r *scriptWorkbenchRuntime) begin(
	a *App,
	prepared *scriptWorkbenchPrepared,
	eventCtx context.Context,
) (*scriptWorkbenchRun, error) {
	if a == nil || prepared == nil {
		return nil, errScriptWorkbenchUnavailable
	}
	if err := prepared.ensureWorkerScript(); err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closing {
		return nil, errors.New("application is shutting down")
	}
	if r.runs == nil {
		r.runs = make(map[string]*scriptWorkbenchRun)
	}
	r.pruneRunsLocked(time.Now(), "")
	if r.activeByUser == nil {
		r.activeByUser = make(map[string]int)
	}
	userKey := strings.TrimSpace(prepared.webActor.username)
	if userKey == "" {
		userKey = prepared.actor.Owner
	}
	if a.webRuntime {
		if r.active >= scriptWorkbenchWebConcurrency {
			return nil, fmt.Errorf("script concurrency limit reached (%d)", scriptWorkbenchWebConcurrency)
		}
		if r.activeByUser[userKey] >= scriptWorkbenchWebUserConcurrency {
			return nil, errors.New("another script is already running for this user")
		}
	} else if r.active >= scriptWorkbenchDesktopConcurrency {
		return nil, errors.New("another script is already running")
	}

	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	timeout := prepared.timeout
	if timeout <= 0 {
		if a.webRuntime {
			timeout = scriptWorkbenchWebTimeout
		} else {
			timeout = scriptWorkbenchDesktopTimeout
		}
	}
	maxCalls := prepared.maxDBCalls
	if maxCalls <= 0 {
		maxCalls = scriptWorkbenchDefaultDBCalls
	}
	maxOutputRows := prepared.maxOutputRows
	if maxOutputRows <= 0 {
		maxOutputRows = scriptWorkbenchDefaultOutputRows
	}
	runCtx, cancel := context.WithTimeout(parent, timeout)
	runID := "script-run-" + uuid.NewString()
	runCtx = scriptWorkbenchContextWithRun(runCtx, runID)
	if a.webRuntime {
		role := webidentity.NormalizeRole(prepared.webActor.role)
		allowed := make([]string, 0, len(prepared.webActor.allowedConnectionIDs))
		for id := range prepared.webActor.allowedConnectionIDs {
			allowed = append(allowed, id)
		}
		runCtx = webidentity.WithActor(runCtx, webidentity.Actor{
			Username:             prepared.webActor.username,
			Role:                 role,
			AllowedConnectionIDs: allowed,
		})
	}
	// Desktop runs outlive the initiating call, so their fallback emitter must
	// use the App lifecycle context. Web runs poll the run APIs and must not
	// broadcast to the global event hub; emitEnabled stays false for them.
	eventCtx = a.ctx
	if eventCtx == nil {
		eventCtx = parent
	}
	run := &scriptWorkbenchRun{
		id:            runID,
		owner:         prepared.actor.Owner,
		userKey:       userKey,
		scriptID:      prepared.scriptID,
		title:         prepared.title,
		allowWrite:    prepared.allowWrite,
		startedAt:     time.Now().UnixMilli(),
		status:        scriptWorkbenchStatusQueued,
		stage:         "queued",
		maxCalls:      maxCalls,
		maxOutputRows: maxOutputRows,
		ctx:           runCtx,
		cancel:        cancel,
		eventCtx:      eventCtx,
		emitEnabled:   !a.webRuntime,
		done:          make(chan struct{}),
	}
	run.ctx = scriptWorkbenchContextWithRunHandle(runCtx, run)
	r.runs[runID] = run
	r.active++
	r.activeByUser[userKey]++
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer r.release(userKey)
		defer func() {
			if recovered := recover(); recovered != nil {
				r.finish(run, scriptWorkbenchStatusFailed, fmt.Errorf("script worker panic: %v", recovered))
			}
		}()
		a.executeScriptWorkbenchRun(run, prepared)
	}()
	return run, nil
}

func (r *scriptWorkbenchRuntime) release(userKey string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active > 0 {
		r.active--
	}
	if r.activeByUser[userKey] > 0 {
		r.activeByUser[userKey]--
	}
}

func (r *scriptWorkbenchRuntime) get(runID string) *scriptWorkbenchRun {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	id := strings.TrimSpace(runID)
	r.pruneRunsLocked(time.Now(), id)
	return r.runs[id]
}

func (r *scriptWorkbenchRuntime) pruneRunsLocked(now time.Time, exemptID string) {
	if r == nil || len(r.runs) == 0 {
		return
	}
	type candidate struct {
		id       string
		finished int64
		userKey  string
		bytes    int64
	}
	candidates := make([]candidate, 0, len(r.runs))
	expireBefore := now.Add(-scriptWorkbenchRetainedRunTTL).UnixMilli()
	for id, run := range r.runs {
		if run == nil || !run.isDone() {
			continue
		}
		run.mu.RLock()
		finishedAt := run.finishedAt
		userKey := strings.TrimSpace(run.userKey)
		if userKey == "" {
			userKey = strings.TrimSpace(run.owner)
		}
		retainedBytes := int64(run.outputBytes) + int64(run.logBytes)
		run.mu.RUnlock()
		if finishedAt > 0 && finishedAt <= expireBefore {
			delete(r.runs, id)
			continue
		}
		candidates = append(candidates, candidate{
			id:       id,
			finished: finishedAt,
			userKey:  userKey,
			bytes:    retainedBytes,
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].finished == candidates[j].finished {
			return candidates[i].id < candidates[j].id
		}
		return candidates[i].finished < candidates[j].finished
	})
	userBytes := make(map[string]int64)
	var totalBytes int64
	for _, item := range candidates {
		totalBytes += item.bytes
		userBytes[item.userKey] += item.bytes
	}
	retainedCount := len(candidates)
	for _, item := range candidates {
		if retainedCount <= scriptWorkbenchMaxRetainedRuns &&
			totalBytes <= scriptWorkbenchMaxRetainedBytes &&
			userBytes[item.userKey] <= scriptWorkbenchMaxUserRetainedBytes {
			break
		}
		if item.id == exemptID {
			continue
		}
		delete(r.runs, item.id)
		retainedCount--
		totalBytes -= item.bytes
		userBytes[item.userKey] -= item.bytes
	}
}

func (r *scriptWorkbenchRuntime) cancel(runID string) bool {
	run := r.get(runID)
	if run == nil {
		return false
	}
	run.requestCancel()
	return true
}

func (r *scriptWorkbenchRuntime) shutdown(timeout time.Duration) bool {
	if r == nil {
		return true
	}
	r.mu.Lock()
	r.closing = true
	runs := make([]*scriptWorkbenchRun, 0, len(r.runs))
	for _, run := range r.runs {
		runs = append(runs, run)
	}
	r.mu.Unlock()
	for _, run := range runs {
		if run != nil && !run.isDone() {
			run.requestCancel()
		}
	}
	done := make(chan struct{})
	go func() {
		r.wg.Wait()
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

func (r *scriptWorkbenchRuntime) finish(run *scriptWorkbenchRun, status string, runErr error) {
	if run == nil {
		return
	}
	run.finishOnce.Do(func() {
		run.mu.Lock()
		run.stage = "finalizing"
		if runErr != nil {
			run.err = runErr.Error()
			run.errorKind = scriptWorkbenchErrorKind(status, run.memoryExceeded, runErr)
		}
		if errors.Is(run.ctx.Err(), context.Canceled) {
			run.cancelled = true
		}
		if errors.Is(run.ctx.Err(), context.DeadlineExceeded) {
			run.timedOut = true
		}
		host := run.host
		run.mu.Unlock()
		if host != nil {
			host.Close()
		}
		run.mu.Lock()
		if runErr == nil && strings.TrimSpace(run.err) != "" {
			status = scriptWorkbenchStatusFailed
		}
		run.status = status
		run.stage = status
		run.finishedAt = time.Now().UnixMilli()
		snapshot := run.snapshotLocked()
		run.mu.Unlock()
		if run.cancel != nil {
			run.cancel()
		}
		close(run.done)
		r.emit(run, scriptWorkbenchEventDone, snapshot)
		r.mu.Lock()
		r.pruneRunsLocked(time.Now(), run.id)
		r.mu.Unlock()
	})
}

func (run *scriptWorkbenchRun) requestCancel() {
	if run == nil || run.cancel == nil {
		return
	}
	run.mu.Lock()
	if run.status == scriptWorkbenchStatusQueued || run.status == scriptWorkbenchStatusRunning {
		run.stage = "cancelling"
	}
	run.mu.Unlock()
	run.cancel()
}

func (run *scriptWorkbenchRun) isDone() bool {
	if run == nil {
		return true
	}
	select {
	case <-run.done:
		return true
	default:
		return false
	}
}

func (run *scriptWorkbenchRun) setRunning(stage string) {
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.status == scriptWorkbenchStatusQueued {
		run.status = scriptWorkbenchStatusRunning
	}
	if strings.TrimSpace(stage) != "" {
		run.stage = stage
	}
}

func (run *scriptWorkbenchRun) setProgress(payload map[string]any) {
	run.mu.Lock()
	defer run.mu.Unlock()
	run.progress = cloneStringAnyMap(payload)
}

func (run *scriptWorkbenchRun) appendLog(level, message string) {
	level = normalizeScriptLogLevel(level)
	message = strings.TrimSpace(message)
	if message == "" {
		return
	}
	message = truncateUTF8Bytes(message, 8<<10)
	entry := ScriptWorkbenchLogEntry{
		Timestamp: time.Now().UnixMilli(),
		Level:     level,
		Message:   message,
	}
	size := len(message)
	run.mu.Lock()
	defer run.mu.Unlock()
	run.nextLogSequence++
	entry.Sequence = run.nextLogSequence
	run.logs = append(run.logs, entry)
	run.logBytes += size
	for len(run.logs) > scriptWorkbenchMaxLogs || run.logBytes > scriptWorkbenchMaxLogBytes {
		if len(run.logs) == 0 {
			break
		}
		run.logBytes -= len(run.logs[0].Message)
		run.logs = run.logs[1:]
		run.logsTruncated = true
	}
}

func (run *scriptWorkbenchRun) appendOutput(name string, rows []map[string]any) {
	if len(rows) == 0 {
		return
	}
	encoded, err := json.Marshal(rows)
	if err != nil {
		return
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "output"
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	outputRowLimit := run.maxOutputRows
	if outputRowLimit <= 0 {
		outputRowLimit = scriptWorkbenchDefaultOutputRows
	}
	if run.outputRows >= outputRowLimit ||
		run.outputBytes+len(encoded) > scriptWorkbenchMaxOutputBytes {
		if output := run.findOutputLocked(name); output != nil {
			output.truncated = true
		} else {
			run.outputsTruncated = true
		}
		return
	}
	output := run.findOutputLocked(name)
	if output == nil {
		if len(run.outputs) >= scriptWorkbenchMaxOutputs {
			run.outputsTruncated = true
			return
		}
		output = &scriptWorkbenchOutput{name: name, columns: columnsFromScriptRows(rows)}
		run.outputs = append(run.outputs, output)
	}
	if len(output.columns) == 0 {
		output.columns = columnsFromScriptRows(rows)
	}
	remainingRows := outputRowLimit - run.outputRows
	remainingBytes := scriptWorkbenchMaxOutputBytes - run.outputBytes
	accepted := 0
	for _, row := range rows {
		if remainingRows <= 0 {
			output.truncated = true
			break
		}
		rowPayload, rowErr := json.Marshal(row)
		if rowErr != nil {
			output.truncated = true
			break
		}
		if len(rowPayload) > remainingBytes {
			output.truncated = true
			break
		}
		output.rows = append(output.rows, row)
		run.outputRows++
		run.outputBytes += len(rowPayload)
		remainingRows--
		remainingBytes -= len(rowPayload)
		accepted++
	}
	if accepted < len(rows) {
		output.truncated = true
	}
}

func (run *scriptWorkbenchRun) findOutputLocked(name string) *scriptWorkbenchOutput {
	for index := len(run.outputs) - 1; index >= 0; index-- {
		if run.outputs[index].name == name {
			return run.outputs[index]
		}
	}
	return nil
}

func (run *scriptWorkbenchRun) addDBCall() error {
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.dbCalls >= run.maxCalls {
		return fmt.Errorf("script database call limit reached (%d)", run.maxCalls)
	}
	run.dbCalls++
	return nil
}

func (run *scriptWorkbenchRun) snapshot() ScriptWorkbenchRunSnapshot {
	if run == nil {
		return ScriptWorkbenchRunSnapshot{Logs: []ScriptWorkbenchLogEntry{}, Outputs: []ScriptWorkbenchOutputInfo{}}
	}
	run.mu.RLock()
	defer run.mu.RUnlock()
	return run.snapshotLocked()
}

func (run *scriptWorkbenchRun) snapshotLocked() ScriptWorkbenchRunSnapshot {
	snapshot := ScriptWorkbenchRunSnapshot{
		RunID:            run.id,
		ScriptID:         run.scriptID,
		Title:            run.title,
		Status:           run.status,
		Stage:            run.stage,
		StartedAt:        run.startedAt,
		FinishedAt:       run.finishedAt,
		AllowWrite:       run.allowWrite,
		Cancelled:        run.cancelled,
		TimedOut:         run.timedOut,
		MemoryExceeded:   run.memoryExceeded,
		Error:            run.err,
		ErrorKind:        run.errorKind,
		DBCalls:          run.dbCalls,
		MaxDBCalls:       run.maxCalls,
		Logs:             append([]ScriptWorkbenchLogEntry(nil), run.logs...),
		LogsTruncated:    run.logsTruncated,
		Outputs:          make([]ScriptWorkbenchOutputInfo, 0, len(run.outputs)),
		OutputsTruncated: run.outputsTruncated,
	}
	if len(run.progress) > 0 {
		snapshot.Progress = cloneStringAnyMap(run.progress)
	}
	for index, output := range run.outputs {
		snapshot.Outputs = append(snapshot.Outputs, ScriptWorkbenchOutputInfo{
			Index:     index,
			Name:      output.name,
			Columns:   append([]string(nil), output.columns...),
			RowCount:  len(output.rows),
			Truncated: output.truncated,
		})
	}
	return snapshot
}

func (run *scriptWorkbenchRun) outputPage(index, page, pageSize int) (ScriptWorkbenchOutputPage, error) {
	if run == nil {
		return ScriptWorkbenchOutputPage{}, errScriptWorkbenchRunNotFound
	}
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 100
	}
	if pageSize > 500 {
		pageSize = 500
	}
	run.mu.RLock()
	defer run.mu.RUnlock()
	if index < 0 || index >= len(run.outputs) {
		return ScriptWorkbenchOutputPage{}, errors.New("script output not found")
	}
	output := run.outputs[index]
	total := len(output.rows)
	maxPage := (total + pageSize - 1) / pageSize
	if maxPage < 1 {
		maxPage = 1
	}
	if page > maxPage {
		page = maxPage
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}
	rows := make([]map[string]any, end-start)
	copy(rows, output.rows[start:end])
	return ScriptWorkbenchOutputPage{
		OutputIndex: index,
		Name:        output.name,
		Columns:     append([]string(nil), output.columns...),
		Rows:        rows,
		Total:       total,
		Page:        page,
		PageSize:    pageSize,
		Truncated:   output.truncated,
	}, nil
}

func (run *scriptWorkbenchRun) emit(eventType string, payload any) {
	if run == nil || !run.emitEnabled {
		return
	}
	uievents.EmitWith(run.eventCtx, run.ctx, "gonavi:script:"+eventType, map[string]any{
		"runId": run.id,
		"event": payload,
	})
}

func (r *scriptWorkbenchRuntime) emit(run *scriptWorkbenchRun, eventType string, payload any) {
	if run == nil {
		return
	}
	run.emit(eventType, payload)
}

func normalizeScriptLogLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug", "info", "warn", "error":
		return strings.ToLower(strings.TrimSpace(level))
	default:
		return "info"
	}
}

func scriptWorkbenchErrorKind(status string, memoryExceeded bool, err error) string {
	switch {
	case status == scriptWorkbenchStatusTimedOut:
		return "timeout"
	case status == scriptWorkbenchStatusCancelled:
		return "cancelled"
	case memoryExceeded:
		return "memory"
	case err == nil:
		return ""
	}
	message := strings.ToLower(err.Error())
	backendMarkers := []string{
		"script worker",
		"script frame",
		"script host",
		"script workbench is unavailable",
		"application is shutting down",
		"script database call limit",
		"script input",
		"script output payload",
		"script progress payload",
		"script writes are disabled",
		"script transaction",
		"script concurrency",
		"managed transaction",
		"db.query accepts",
		"db.execute requires",
		"does not support managed transactions",
		"script failed",
	}
	for _, marker := range backendMarkers {
		if strings.Contains(message, marker) {
			return "backend"
		}
	}
	if isScriptRuntimeError(message) {
		return "script"
	}
	return "backend"
}

func isScriptRuntimeError(message string) bool {
	message = strings.TrimSpace(strings.ToLower(message))
	for _, prefix := range []string{
		"typeerror:",
		"referenceerror:",
		"syntaxerror:",
		"rangeerror:",
		"evalerror:",
		"urierror:",
		"aggregateerror:",
		"goerror:",
	} {
		if strings.HasPrefix(message, prefix) {
			return true
		}
	}
	return strings.HasPrefix(message, "error:") && strings.Contains(message, " at ")
}

func columnsFromScriptRows(rows []map[string]any) []string {
	if len(rows) == 0 {
		return nil
	}
	columns := make([]string, 0, len(rows[0]))
	for key := range rows[0] {
		columns = append(columns, key)
	}
	sort.Strings(columns)
	return columns
}

func cloneStringAnyMap(value map[string]any) map[string]any {
	if len(value) == 0 {
		return nil
	}
	result := make(map[string]any, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}
