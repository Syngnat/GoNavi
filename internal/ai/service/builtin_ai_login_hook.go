package aiservice

import "sync"

var (
	builtinAILoginStartHookMu sync.RWMutex
	builtinAILoginStartHook   func()
)

// SetBuiltinAILoginStartHook sets what runs each time a browser sign-in to the built-in AI
// begins. The desktop uses it to make sure the "Return to GoNavi" link at the end of the
// sign-in opens this very GoNavi (see internal/deeplink). The hook must be quick and must not
// fail the sign-in: it runs before the Gateway is asked for a device code.
func SetBuiltinAILoginStartHook(hook func()) {
	builtinAILoginStartHookMu.Lock()
	builtinAILoginStartHook = hook
	builtinAILoginStartHookMu.Unlock()
}

func runBuiltinAILoginStartHook() {
	builtinAILoginStartHookMu.RLock()
	hook := builtinAILoginStartHook
	builtinAILoginStartHookMu.RUnlock()
	if hook != nil {
		hook()
	}
}
