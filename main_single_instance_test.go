package main

import (
	"context"
	"testing"
)

func TestSingleInstanceActivationStateContextLifecycle(t *testing.T) {
	state := &singleInstanceActivationState{}
	// 未 start 前先记录一次冷启动激活。
	if ctx := state.request(); ctx != nil {
		t.Fatalf("request before startup should return nil, got %#v", ctx)
	}

	ctx := context.Background()
	if pending := state.start(ctx); !pending {
		t.Fatal("startup did not consume pending activation")
	}
	if got := state.request(); got != ctx {
		t.Fatalf("request after start = %#v, want %#v", got, ctx)
	}

	// stop 后 context 失效，且 start 不再生效。
	state.stop()
	if got := state.request(); got != nil {
		t.Fatalf("request after shutdown should return nil, got %#v", got)
	}
	if pending := state.start(ctx); pending {
		t.Fatal("stopped state accepted startup context")
	}
}
