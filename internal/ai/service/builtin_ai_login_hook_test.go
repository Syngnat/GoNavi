package aiservice

import "testing"

// The desktop registers the "Return to GoNavi" link when a browser sign-in begins, so the hook
// must run before the Gateway is asked for a device code, and must not depend on the answer.
func TestTheLoginStartHookRunsBeforeTheDeviceCodeIsRequested(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "http://127.0.0.1:1") // nothing listens there
	calls := 0
	SetBuiltinAILoginStartHook(func() { calls++ })
	t.Cleanup(func() { SetBuiltinAILoginStartHook(nil) })

	s, _ := newInitializedAgentHarnessService(t)
	if _, err := s.AIStartBuiltinAILogin(); err == nil {
		t.Fatal("expected the unreachable Gateway to fail the request")
	}
	if calls != 1 {
		t.Fatalf("hook ran %d times, want 1", calls)
	}
	SetBuiltinAILoginStartHook(nil)
	_, _ = s.AIStartBuiltinAILogin() // no hook set: nothing to run, nothing to break
}
