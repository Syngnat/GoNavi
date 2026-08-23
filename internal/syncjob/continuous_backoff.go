package syncjob

import (
	"context"
	"hash/fnv"
	"time"
)

const (
	continuousFailureBackoffInitial = 5 * time.Second
	continuousFailureBackoffMaximum = 5 * time.Minute
	continuousFailureHistoryLimit   = 32
)

func (m *Manager) continuousFailureNotBefore(ctx context.Context, definition JobDefinition) (int64, int, error) {
	if definition.Schedule.Kind != ScheduleContinuous {
		return 0, 0, nil
	}
	runs, err := m.store.ListRuns(ctx, definition.ID, continuousFailureHistoryLimit)
	if err != nil {
		return 0, 0, err
	}
	consecutiveFailures := 0
	var latestFailure RunRecord
	for _, run := range runs {
		switch run.Status {
		case RunStatusQueued, RunStatusRunning, RunStatusCancelling:
			continue
		case RunStatusFailed, RunStatusPartial, RunStatusInterrupted:
			if consecutiveFailures == 0 {
				latestFailure = run
			}
			consecutiveFailures++
		default:
			// A success or an operator-controlled terminal state ends the failure
			// streak. The next continuous launch returns to the normal poll cadence.
			goto counted
		}
	}

counted:
	if consecutiveFailures == 0 || latestFailure.FinishedAt <= 0 {
		return 0, consecutiveFailures, nil
	}
	backoff := continuousFailureBackoff(definition.ID, latestFailure.ID, consecutiveFailures)
	return time.UnixMilli(latestFailure.FinishedAt).Add(backoff).UnixMilli(), consecutiveFailures, nil
}

func continuousFailureBackoff(jobID, latestRunID string, consecutiveFailures int) time.Duration {
	if consecutiveFailures < 1 {
		return 0
	}
	base := continuousFailureBackoffInitial
	for attempt := 1; attempt < consecutiveFailures && base < continuousFailureBackoffMaximum; attempt++ {
		if base > continuousFailureBackoffMaximum/2 {
			base = continuousFailureBackoffMaximum
			break
		}
		base *= 2
	}
	if base >= continuousFailureBackoffMaximum {
		return continuousFailureBackoffMaximum
	}
	jitterRoom := base / 5
	if remaining := continuousFailureBackoffMaximum - base; jitterRoom > remaining {
		jitterRoom = remaining
	}
	if jitterRoom <= 0 {
		return base
	}
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte(jobID))
	_, _ = hasher.Write([]byte{0})
	_, _ = hasher.Write([]byte(latestRunID))
	_, _ = hasher.Write([]byte{0, byte(consecutiveFailures)})
	jitter := time.Duration(hasher.Sum64() % (uint64(jitterRoom) + 1))
	return base + jitter
}
