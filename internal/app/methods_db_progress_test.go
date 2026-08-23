package app

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/uievents"
)

type connectionProgressEventRecorder struct {
	events []connectionTestProgressEvent
}

func (r *connectionProgressEventRecorder) Emit(name string, args ...any) {
	if name != connectionTestProgressEventName || len(args) != 1 {
		return
	}
	if event, ok := args[0].(connectionTestProgressEvent); ok {
		r.events = append(r.events, event)
	}
}

func TestTestConnectionWithProgressEmitsCorrelatedFailure(t *testing.T) {
	recorder := &connectionProgressEventRecorder{}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.ctx = uievents.WithEmitter(context.Background(), recorder)

	result := application.TestConnectionWithProgress(connection.ConnectionConfig{
		UseSSH: true,
	}, "ssh-test-run-1")

	if result.Success {
		t.Fatal("expected invalid SSH connection input to fail")
	}
	if len(recorder.events) < 2 {
		t.Fatalf("expected start and failure progress events, got %#v", recorder.events)
	}
	if recorder.events[0].RunID != "ssh-test-run-1" || recorder.events[0].Stage != "preparing" {
		t.Fatalf("unexpected first progress event: %#v", recorder.events[0])
	}
	last := recorder.events[len(recorder.events)-1]
	if last.RunID != "ssh-test-run-1" || last.Stage != "failed" || last.Status != "error" {
		t.Fatalf("expected correlated failure progress event, got %#v", last)
	}
}
