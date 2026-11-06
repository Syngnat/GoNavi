package app

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/uievents"
)

type scopeRecordingEmitter struct {
	names []string
}

func (e *scopeRecordingEmitter) Emit(name string, _ ...any) {
	e.names = append(e.names, name)
}

func TestEmitQueryExecutionProgressUsesRequestScopedEmitter(t *testing.T) {
	global := &scopeRecordingEmitter{}
	scoped := &scopeRecordingEmitter{}
	application := &App{ctx: uievents.WithEmitter(context.Background(), global)}
	requestCtx := uievents.WithEmitter(context.Background(), scoped)

	application.emitQueryExecutionProgressWithContext(requestCtx, queryExecutionProgressEvent{
		QueryID: "query-1",
		Status:  queryExecutionStatusRunning,
		Stage:   queryExecutionStageExecuting,
	})
	if len(scoped.names) != 1 || scoped.names[0] != queryProgressEventName {
		t.Fatalf("scoped emitter = %v, want one %s", scoped.names, queryProgressEventName)
	}
	if len(global.names) != 0 {
		t.Fatalf("global emitter must not receive request-scoped progress: %v", global.names)
	}
}
