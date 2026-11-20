package app

import (
	"context"
	"testing"
	"time"

	"GoNavi-Wails/internal/scriptlib"
	"GoNavi-Wails/internal/scriptlimits"
	"GoNavi-Wails/internal/webidentity"
)

func prepareScriptWorkbenchRunLimitsForTest(
	t *testing.T,
	web bool,
	libraryLimits *scriptlib.RunLimits,
	request ScriptWorkbenchRunRequest,
) *scriptWorkbenchPrepared {
	t.Helper()
	application := newScriptWorkbenchTestApp(t, web)
	ctx := context.Background()
	if web {
		ctx = webidentity.WithActor(ctx, webidentity.Actor{
			Username: "alice",
			Role:     webidentity.RoleAdmin,
		})
	}
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	if libraryLimits != nil {
		script, err := application.scriptLibraryStore().SaveScript(ctx, actor, scriptlib.SaveScriptInput{
			Name:      "limits",
			Code:      "1",
			RunLimits: *libraryLimits,
		})
		if err != nil {
			t.Fatalf("save library limits: %v", err)
		}
		request.ScriptID = script.ID
	}
	if request.ScriptID == "" && request.Script == "" {
		request.Script = "1"
	}
	prepared, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor)
	if err != nil {
		t.Fatalf("prepare run: %v", err)
	}
	return prepared
}

func requireScriptWorkbenchPreparedLimits(
	t *testing.T,
	prepared *scriptWorkbenchPrepared,
	timeout time.Duration,
	maxDBCalls int,
	maxOutputRows int,
	memoryLimitBytes int64,
) {
	t.Helper()
	if prepared.timeout != timeout ||
		prepared.maxDBCalls != maxDBCalls ||
		prepared.maxOutputRows != maxOutputRows ||
		prepared.defaultQueryRows != minInt(maxOutputRows, scriptlimits.DefaultQueryRows) ||
		prepared.maxQueryRows != maxOutputRows ||
		prepared.memoryLimitBytes != memoryLimitBytes {
		t.Fatalf(
			"prepared limits = timeout=%s db=%d rows=%d query=%d/%d memory=%d",
			prepared.timeout,
			prepared.maxDBCalls,
			prepared.maxOutputRows,
			prepared.defaultQueryRows,
			prepared.maxQueryRows,
			prepared.memoryLimitBytes,
		)
	}
	limits := prepared.workerRequest.Limits
	if limits.Timeout != timeout ||
		limits.TimeoutMs != timeout.Milliseconds() ||
		limits.MaxDBCalls != maxDBCalls ||
		limits.MaxOutputRows != maxOutputRows ||
		limits.DefaultQueryRows != minInt(maxOutputRows, scriptlimits.DefaultQueryRows) ||
		limits.MaxQueryRows != maxOutputRows ||
		limits.MemoryLimitBytes != memoryLimitBytes {
		t.Fatalf("worker limits = %+v", limits)
	}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func TestScriptWorkbenchHostQueryRowLimitUsesPreparedLimits(t *testing.T) {
	host := &scriptWorkbenchHost{
		prepared: &scriptWorkbenchPrepared{
			defaultQueryRows: 10_000,
			maxQueryRows:     120_000,
		},
	}
	if rows, maxRows := host.queryRowLimit(0); rows != 10_000 || maxRows != 120_000 {
		t.Fatalf("default query limit = %d/%d", rows, maxRows)
	}
	if rows, _ := host.queryRowLimit(80_000); rows != 80_000 {
		t.Fatalf("custom query limit = %d", rows)
	}
	if rows, _ := host.queryRowLimit(999_999); rows != 120_000 {
		t.Fatalf("clamped query limit = %d", rows)
	}

	host.prepared.defaultQueryRows = 50_000
	host.prepared.maxQueryRows = 5_000
	if rows, maxRows := host.queryRowLimit(0); rows != 5_000 || maxRows != 5_000 {
		t.Fatalf("default above max query limit = %d/%d", rows, maxRows)
	}
}

func TestScriptWorkbenchRunLimitsPrecedence(t *testing.T) {
	libraryLimits := scriptlib.RunLimits{
		TimeoutMs:        4 * 60 * 1_000,
		MaxDBCalls:       20_000,
		MaxOutputRows:    60_000,
		MemoryLimitBytes: 768 << 20,
	}

	t.Run("request overrides library", func(t *testing.T) {
		prepared := prepareScriptWorkbenchRunLimitsForTest(t, false, &libraryLimits, ScriptWorkbenchRunRequest{
			TimeoutMs:        9 * 60 * 1_000,
			MaxDBCalls:       30_000,
			MaxOutputRows:    80_000,
			MemoryLimitBytes: 900 << 20,
		})
		requireScriptWorkbenchPreparedLimits(
			t,
			prepared,
			9*time.Minute,
			30_000,
			80_000,
			900<<20,
		)
	})

	t.Run("library fills request zeros", func(t *testing.T) {
		prepared := prepareScriptWorkbenchRunLimitsForTest(t, false, &libraryLimits, ScriptWorkbenchRunRequest{})
		requireScriptWorkbenchPreparedLimits(
			t,
			prepared,
			4*time.Minute,
			libraryLimits.MaxDBCalls,
			libraryLimits.MaxOutputRows,
			libraryLimits.MemoryLimitBytes,
		)
	})
}

func TestScriptWorkbenchRunLimitDefaultsDependOnRuntime(t *testing.T) {
	tests := []struct {
		name             string
		web              bool
		timeout          time.Duration
		maxDBCalls       int
		maxOutputRows    int
		memoryLimitBytes int64
	}{
		{
			name:             "desktop",
			timeout:          30 * time.Minute,
			maxDBCalls:       scriptlimits.DefaultMaxDBCalls,
			maxOutputRows:    scriptlimits.DefaultMaxOutputRows,
			memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
		{
			name:             "web",
			web:              true,
			timeout:          10 * time.Minute,
			maxDBCalls:       scriptlimits.DefaultMaxDBCalls,
			maxOutputRows:    scriptlimits.DefaultMaxOutputRows,
			memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			prepared := prepareScriptWorkbenchRunLimitsForTest(
				t,
				testCase.web,
				nil,
				ScriptWorkbenchRunRequest{},
			)
			requireScriptWorkbenchPreparedLimits(
				t,
				prepared,
				testCase.timeout,
				testCase.maxDBCalls,
				testCase.maxOutputRows,
				testCase.memoryLimitBytes,
			)
		})
	}
}

func TestScriptWorkbenchRunLimitClampsToRuntimeBounds(t *testing.T) {
	tests := []struct {
		name             string
		web              bool
		request          ScriptWorkbenchRunRequest
		timeout          time.Duration
		maxDBCalls       int
		maxOutputRows    int
		memoryLimitBytes int64
	}{
		{
			name:    "desktop timeout low",
			request: ScriptWorkbenchRunRequest{TimeoutMs: 1},
			timeout: time.Minute, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
		{
			name:    "desktop timeout high",
			request: ScriptWorkbenchRunRequest{TimeoutMs: (3 * time.Hour).Milliseconds()},
			timeout: 2 * time.Hour, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
		{
			name:    "web timeout high",
			web:     true,
			request: ScriptWorkbenchRunRequest{TimeoutMs: (3 * time.Hour).Milliseconds()},
			timeout: 30 * time.Minute, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
		{
			name:    "desktop memory low",
			request: ScriptWorkbenchRunRequest{MemoryLimitBytes: 1},
			timeout: 30 * time.Minute, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.MinMemoryLimitBytes,
		},
		{
			name:    "desktop memory high",
			request: ScriptWorkbenchRunRequest{MemoryLimitBytes: 3 << 30},
			timeout: 30 * time.Minute, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.MaxDesktopMemoryLimitBytes,
		},
		{
			name:    "web memory high",
			web:     true,
			request: ScriptWorkbenchRunRequest{MemoryLimitBytes: 2 << 30},
			timeout: 10 * time.Minute, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.MaxWebMemoryLimitBytes,
		},
		{
			name:    "database calls low",
			request: ScriptWorkbenchRunRequest{MaxDBCalls: -1},
			timeout: 30 * time.Minute, maxDBCalls: 1,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
		{
			name:    "database calls high",
			request: ScriptWorkbenchRunRequest{MaxDBCalls: scriptlimits.MaxDBCalls + 1},
			timeout: 30 * time.Minute, maxDBCalls: scriptlimits.MaxDBCalls,
			maxOutputRows: scriptlimits.DefaultMaxOutputRows, memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
		{
			name:    "output rows low",
			request: ScriptWorkbenchRunRequest{MaxOutputRows: -1},
			timeout: 30 * time.Minute, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: 1, memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
		{
			name:    "output rows high",
			request: ScriptWorkbenchRunRequest{MaxOutputRows: scriptlimits.MaxOutputRows + 1},
			timeout: 30 * time.Minute, maxDBCalls: scriptlimits.DefaultMaxDBCalls,
			maxOutputRows: scriptlimits.MaxOutputRows, memoryLimitBytes: scriptlimits.DefaultMemoryLimitBytes,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			prepared := prepareScriptWorkbenchRunLimitsForTest(t, testCase.web, nil, testCase.request)
			requireScriptWorkbenchPreparedLimits(
				t,
				prepared,
				testCase.timeout,
				testCase.maxDBCalls,
				testCase.maxOutputRows,
				testCase.memoryLimitBytes,
			)
		})
	}
}

func TestScriptWorkbenchWebReclampsStoredLimits(t *testing.T) {
	prepared := prepareScriptWorkbenchRunLimitsForTest(t, true, &scriptlib.RunLimits{
		TimeoutMs:        scriptlimits.MaxDesktopTimeoutMs,
		MemoryLimitBytes: scriptlimits.MaxDesktopMemoryLimitBytes,
	}, ScriptWorkbenchRunRequest{})
	requireScriptWorkbenchPreparedLimits(
		t,
		prepared,
		time.Duration(scriptlimits.MaxWebTimeoutMs)*time.Millisecond,
		scriptlimits.DefaultMaxDBCalls,
		scriptlimits.DefaultMaxOutputRows,
		scriptlimits.MaxWebMemoryLimitBytes,
	)
}

func TestScriptWorkbenchAppendOutputUsesConfiguredLimit(t *testing.T) {
	run := &scriptWorkbenchRun{maxOutputRows: 2}
	run.appendOutput("rows", []map[string]any{
		{"id": 1},
		{"id": 2},
		{"id": 3},
	})
	run.mu.RLock()
	defer run.mu.RUnlock()
	if len(run.outputs) != 1 || len(run.outputs[0].rows) != 2 || !run.outputs[0].truncated {
		t.Fatalf("outputs = %+v", run.outputs)
	}
	if run.outputRows != 2 {
		t.Fatalf("stored rows = %d, want 2", run.outputRows)
	}
}

func TestScriptWorkbenchAppendOutputZeroLimitUsesDefault(t *testing.T) {
	run := &scriptWorkbenchRun{outputRows: scriptWorkbenchDefaultOutputRows - 1}
	run.appendOutput("rows", []map[string]any{{"id": 1}, {"id": 2}})
	run.mu.RLock()
	defer run.mu.RUnlock()
	if len(run.outputs) != 1 || len(run.outputs[0].rows) != 1 || !run.outputs[0].truncated {
		t.Fatalf("default output limit was not applied: %+v", run.outputs)
	}
}
