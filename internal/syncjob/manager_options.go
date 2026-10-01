package syncjob

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

type ManagerOptions struct {
	// Passive leaves scheduling and execution to a separate worker process.
	Passive bool
	// SchedulerDisabled keeps dispatching and executing queued runs but never scans
	// for due jobs on its own, so the caller decides what gets enqueued
	// (the one-shot run-sync-job process enqueues exactly one job via EnqueueDueJobRun).
	SchedulerDisabled  bool
	SchedulerInterval  time.Duration
	LeaseTTL           time.Duration
	HeartbeatInterval  time.Duration
	RecoveryStaleAfter time.Duration
	RecoveryInterval   time.Duration
	MaxConcurrentRuns  int
	LeaseOwner         string
	Hooks              ManagerHooks
	Now                func() time.Time
}

func normalizeManagerOptions(options ManagerOptions) ManagerOptions {
	if options.SchedulerInterval <= 0 {
		options.SchedulerInterval = time.Second
	}
	if options.LeaseTTL <= 0 {
		options.LeaseTTL = 10 * time.Second
	}
	if options.HeartbeatInterval <= 0 {
		options.HeartbeatInterval = 5 * time.Second
	}
	if options.RecoveryStaleAfter <= 0 {
		options.RecoveryStaleAfter = 3 * options.HeartbeatInterval
	}
	if options.RecoveryInterval <= 0 {
		options.RecoveryInterval = options.RecoveryStaleAfter
	}
	if options.MaxConcurrentRuns <= 0 {
		options.MaxConcurrentRuns = 4
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if strings.TrimSpace(options.LeaseOwner) == "" {
		options.LeaseOwner = "sync-scheduler-" + uuid.NewString()
	}
	return options
}
