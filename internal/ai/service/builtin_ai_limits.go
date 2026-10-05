package aiservice

import (
	"time"

	"GoNavi-Wails/internal/ai"
)

// builtinAILimitsMaxAge is how long the limits learned from the Gateway are
// trusted before the next message re-checks them.
const builtinAILimitsMaxAge = 5 * time.Minute

// refreshBuiltinAILimits re-reads the Gateway's per-request limits when the ones
// held are stale, so a window the operator raised is used by the very next
// message. It is best effort: a failure keeps the last known limits, and the
// Gateway stays the authority on what it accepts.
func refreshBuiltinAILimits(config builtinAIConfig, accessToken string) {
	if _, learnedAt := ai.CurrentHostedModelLimits(); !learnedAt.IsZero() && time.Since(learnedAt) < builtinAILimitsMaxAge {
		return
	}
	_, _ = fetchBuiltinAIQuota(config, accessToken)
}
