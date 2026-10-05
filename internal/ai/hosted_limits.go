package ai

import (
	"sync"
	"time"
)

// The GoNavi-hosted SQL model has a small context window that the operator can
// change on the Gateway. The desktop learns the current values from the Gateway
// (see /v1/quota) instead of baking them in, so a change needs no client release.
const (
	DefaultHostedContextWindow   = 4_096
	DefaultHostedMaxOutputTokens = 1_024
	minHostedContextWindow       = 512
	maxHostedContextWindow       = 131_072
	minHostedMaxOutputTokens     = 16
)

// HostedModelLimits is what the Gateway currently accepts for one request.
type HostedModelLimits struct {
	ContextWindow   int
	MaxOutputTokens int
}

var hostedLimits = struct {
	sync.RWMutex
	limits    HostedModelLimits
	learnedAt time.Time
}{limits: HostedModelLimits{ContextWindow: DefaultHostedContextWindow, MaxOutputTokens: DefaultHostedMaxOutputTokens}}

// SetHostedModelLimits records limits reported by the Gateway. A value that is
// not plausible (zero, absurd, or an output cap that leaves no room for a
// prompt) is ignored, so a misbehaving server cannot break the client.
func SetHostedModelLimits(contextWindow, maxOutputTokens int) bool {
	if contextWindow < minHostedContextWindow || contextWindow > maxHostedContextWindow ||
		maxOutputTokens < minHostedMaxOutputTokens || maxOutputTokens >= contextWindow {
		return false
	}
	hostedLimits.Lock()
	hostedLimits.limits = HostedModelLimits{ContextWindow: contextWindow, MaxOutputTokens: maxOutputTokens}
	hostedLimits.learnedAt = time.Now()
	hostedLimits.Unlock()
	return true
}

// CurrentHostedModelLimits returns the limits in force and when they were last
// confirmed by the Gateway (zero before the first confirmation).
func CurrentHostedModelLimits() (HostedModelLimits, time.Time) {
	hostedLimits.RLock()
	defer hostedLimits.RUnlock()
	return hostedLimits.limits, hostedLimits.learnedAt
}

// ResetHostedModelLimits returns to the defaults (used when signing out, and by tests).
func ResetHostedModelLimits() {
	hostedLimits.Lock()
	hostedLimits.limits = HostedModelLimits{ContextWindow: DefaultHostedContextWindow, MaxOutputTokens: DefaultHostedMaxOutputTokens}
	hostedLimits.learnedAt = time.Time{}
	hostedLimits.Unlock()
}
