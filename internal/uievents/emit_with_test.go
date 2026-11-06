package uievents

import (
	"context"
	"testing"
)

type emitWithRecordingEmitter struct {
	names []string
}

func (e *emitWithRecordingEmitter) Emit(name string, _ ...any) {
	e.names = append(e.names, name)
}

func TestEmitWithPrefersRequestEmitter(t *testing.T) {
	global := &emitWithRecordingEmitter{}
	scoped := &emitWithRecordingEmitter{}
	fallback := WithEmitter(context.Background(), global)
	request := WithEmitter(context.Background(), scoped)

	EmitWith(request, fallback, "query:progress")
	if len(scoped.names) != 1 || scoped.names[0] != "query:progress" {
		t.Fatalf("scoped emitter = %v, want one query:progress", scoped.names)
	}
	if len(global.names) != 0 {
		t.Fatalf("global emitter must not receive scoped event: %v", global.names)
	}
}

func TestEmitWithFallsBackWhenRequestHasNoEmitter(t *testing.T) {
	global := &emitWithRecordingEmitter{}
	fallback := WithEmitter(context.Background(), global)

	EmitWith(context.Background(), fallback, "connections:changed")
	if len(global.names) != 1 || global.names[0] != "connections:changed" {
		t.Fatalf("fallback emitter = %v, want one connections:changed", global.names)
	}
}
