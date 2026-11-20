package app

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	"GoNavi-Wails/internal/scriptlib"
	"GoNavi-Wails/internal/uievents"
)

type scriptWorkbenchRuntimeEventRecorder struct {
	names []string
}

func (e *scriptWorkbenchRuntimeEventRecorder) Emit(name string, _ ...any) {
	e.names = append(e.names, name)
}

func finishedScriptWorkbenchRun(id, userKey string, finished time.Time, bytes int) *scriptWorkbenchRun {
	done := make(chan struct{})
	close(done)
	return &scriptWorkbenchRun{
		id:          id,
		userKey:     userKey,
		status:      scriptWorkbenchStatusSucceeded,
		finishedAt:  finished.UnixMilli(),
		outputBytes: bytes,
		done:        done,
	}
}

func TestScriptWorkbenchRunOutputPageClampsLargePages(t *testing.T) {
	run := &scriptWorkbenchRun{
		outputs: []*scriptWorkbenchOutput{{
			name: "rows",
			rows: []map[string]any{{"id": 1}, {"id": 2}, {"id": 3}},
		}},
	}

	page, err := run.outputPage(0, math.MaxInt, 2)
	if err != nil {
		t.Fatalf("output page: %v", err)
	}
	if page.Page != 2 || len(page.Rows) != 1 || page.Rows[0]["id"] != 3 {
		t.Fatalf("page = %+v", page)
	}

	page, err = run.outputPage(0, math.MinInt, math.MaxInt)
	if err != nil {
		t.Fatalf("negative page: %v", err)
	}
	if page.Page != 1 || page.PageSize != 500 || len(page.Rows) != 3 {
		t.Fatalf("negative page result = %+v", page)
	}
}

func TestScriptWorkbenchRunCapsDistinctOutputs(t *testing.T) {
	run := &scriptWorkbenchRun{}
	for index := 0; index < scriptWorkbenchMaxOutputs+1; index++ {
		run.appendOutput(fmt.Sprintf("output-%02d", index), []map[string]any{{"id": index}})
	}
	run.mu.RLock()
	defer run.mu.RUnlock()
	if len(run.outputs) != scriptWorkbenchMaxOutputs {
		t.Fatalf("outputs = %d, want %d", len(run.outputs), scriptWorkbenchMaxOutputs)
	}
	if !run.outputsTruncated {
		t.Fatal("output cap must be reported separately from stream truncation")
	}
}

func TestScriptWorkbenchPruneRunsHonorsTTLAndBudgets(t *testing.T) {
	now := time.Now()

	t.Run("ttl", func(t *testing.T) {
		runtime := &scriptWorkbenchRuntime{runs: map[string]*scriptWorkbenchRun{
			"expired": finishedScriptWorkbenchRun("expired", "alice", now.Add(-scriptWorkbenchRetainedRunTTL-time.Second), 1),
			"fresh":   finishedScriptWorkbenchRun("fresh", "alice", now.Add(-time.Minute), 1),
		}}
		runtime.pruneRunsLocked(now, "")
		if runtime.runs["expired"] != nil {
			t.Fatal("expired run was not pruned")
		}
		if runtime.runs["fresh"] == nil {
			t.Fatal("fresh run was pruned")
		}
	})

	t.Run("per user", func(t *testing.T) {
		runtime := &scriptWorkbenchRuntime{runs: map[string]*scriptWorkbenchRun{
			"oldest": finishedScriptWorkbenchRun("oldest", "alice", now.Add(-3*time.Minute), 20<<20),
			"middle": finishedScriptWorkbenchRun("middle", "alice", now.Add(-2*time.Minute), 20<<20),
			"newest": finishedScriptWorkbenchRun("newest", "alice", now.Add(-time.Minute), 20<<20),
		}}
		runtime.pruneRunsLocked(now, "")
		if runtime.runs["oldest"] != nil || runtime.runs["middle"] == nil || runtime.runs["newest"] == nil {
			t.Fatalf("per-user budget pruned wrong runs: %+v", runtime.runs)
		}
	})

	t.Run("global", func(t *testing.T) {
		runtime := &scriptWorkbenchRuntime{runs: make(map[string]*scriptWorkbenchRun)}
		users := []string{"alice", "bob", "carol", "dave", "erin"}
		for index, user := range users {
			id := user
			runtime.runs[id] = finishedScriptWorkbenchRun(
				id,
				user,
				now.Add(time.Duration(index-len(users))*time.Minute),
				20<<20,
			)
		}
		runtime.pruneRunsLocked(now, "")
		if len(runtime.runs) != 4 || runtime.runs["alice"] != nil {
			t.Fatalf("global budget kept %d runs: %+v", len(runtime.runs), runtime.runs)
		}
	})

	t.Run("count", func(t *testing.T) {
		runtime := &scriptWorkbenchRuntime{runs: make(map[string]*scriptWorkbenchRun)}
		for index := 0; index < scriptWorkbenchMaxRetainedRuns+1; index++ {
			id := fmt.Sprintf("run-%02d", index)
			runtime.runs[id] = finishedScriptWorkbenchRun(
				id,
				"user-"+id,
				now.Add(-time.Duration(index+1)*time.Second),
				1,
			)
		}
		runtime.pruneRunsLocked(now, "")
		if len(runtime.runs) != scriptWorkbenchMaxRetainedRuns {
			t.Fatalf("retained runs = %d", len(runtime.runs))
		}
	})
}

func TestScriptWorkbenchGetPrunesExpiredRun(t *testing.T) {
	now := time.Now()
	runtime := &scriptWorkbenchRuntime{runs: map[string]*scriptWorkbenchRun{
		"expired": finishedScriptWorkbenchRun("expired", "alice", now.Add(-scriptWorkbenchRetainedRunTTL-time.Second), 1),
	}}
	if run := runtime.get("expired"); run != nil {
		t.Fatalf("expired run = %+v", run)
	}
	if len(runtime.runs) != 0 {
		t.Fatalf("expired run remains in runtime: %+v", runtime.runs)
	}
}

func TestScriptWorkbenchWebRunDoesNotEmitGlobalEvents(t *testing.T) {
	recorder := &scriptWorkbenchRuntimeEventRecorder{}
	ctx := uievents.WithEmitter(context.Background(), recorder)
	run := &scriptWorkbenchRun{
		id:       "script-run-event-test",
		ctx:      ctx,
		eventCtx: ctx,
	}
	run.emit(scriptWorkbenchEventProgress, map[string]any{"stage": "running"})
	if len(recorder.names) != 0 {
		t.Fatalf("web run emitted global events: %v", recorder.names)
	}

	run.emitEnabled = true
	run.emit(scriptWorkbenchEventProgress, map[string]any{"stage": "running"})
	if len(recorder.names) != 1 || recorder.names[0] != "gonavi:script:"+scriptWorkbenchEventProgress {
		t.Fatalf("desktop run events = %v", recorder.names)
	}
}

func TestScriptWorkbenchBeginDisablesWebRunEvents(t *testing.T) {
	recorder := &scriptWorkbenchRuntimeEventRecorder{}
	ctx, cancel := context.WithCancel(uievents.WithEmitter(context.Background(), recorder))
	cancel()
	application := &App{webRuntime: true, ctx: ctx}
	prepared := &scriptWorkbenchPrepared{
		code:     "1 + 1",
		title:    "web events",
		actor:    scriptlib.Actor{Owner: scriptlib.WebOwner("alice")},
		webActor: webScriptActor{username: "alice", role: "admin"},
		timeout:  time.Second,
	}
	run, err := application.scriptWorkbench.begin(application, prepared, ctx)
	if err != nil {
		t.Fatalf("begin web run: %v", err)
	}
	select {
	case <-run.done:
	case <-time.After(5 * time.Second):
		t.Fatal("web run did not finish")
	}
	if len(recorder.names) != 0 {
		t.Fatalf("web run broadcast global events: %v", recorder.names)
	}
}

func TestScriptWorkbenchRunErrorKindSeparatesScriptAndBackendFailures(t *testing.T) {
	if kind := scriptWorkbenchErrorKind(
		scriptWorkbenchStatusFailed,
		false,
		fmt.Errorf("TypeError: ids is not iterable"),
	); kind != "script" {
		t.Fatalf("TypeError kind = %q", kind)
	}
	if kind := scriptWorkbenchErrorKind(
		scriptWorkbenchStatusFailed,
		false,
		fmt.Errorf("script worker exited unexpectedly"),
	); kind != "backend" {
		t.Fatalf("worker error kind = %q", kind)
	}
	if kind := scriptWorkbenchErrorKind(scriptWorkbenchStatusTimedOut, false, nil); kind != "timeout" {
		t.Fatalf("timeout kind = %q", kind)
	}
}
