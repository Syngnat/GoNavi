package aiservice

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/logger"
)

// The policy file is written with an atomic rename, so a short polling loop is
// sufficient and keeps the desktop adapter independent of an OS-specific file
// notification dependency. The interval is intentionally separate from the
// Harness control poll interval: changing one must not make the other stale.
const defaultAgentRunPolicyWatchInterval = runharness.DefaultRunPolicyWatchInterval

// agentRunPolicyWatchInterval is a variable to make lifecycle tests fast while
// retaining a conservative production default.
var agentRunPolicyWatchInterval = defaultAgentRunPolicyWatchInterval

type agentRunPolicyWatcher struct {
	path         string
	lastRevision int64
	lastError    string
	interval     time.Duration
}

// startAgentRunPolicyWatcher starts at most one watcher for a Service. The
// lifecycle context owns the goroutine, so a Wails shutdown also stops it even
// when the shutdown callback does not provide a useful context.
func (s *Service) startAgentRunPolicyWatcher(ctx context.Context, path string, revision int64, configured ...time.Duration) {
	if s == nil || ctx == nil || strings.TrimSpace(path) == "" {
		return
	}

	watchCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	s.agentPolicyWatcherMu.Lock()
	if s.agentPolicyWatcherCancel != nil {
		s.agentPolicyWatcherMu.Unlock()
		cancel()
		return
	}
	s.agentPolicyWatcherCancel = cancel
	s.agentPolicyWatcherDone = done
	s.agentPolicyWatcherMu.Unlock()

	interval := agentRunPolicyWatchInterval
	if interval == defaultAgentRunPolicyWatchInterval && len(configured) > 0 {
		interval = configured[0]
	}
	if interval <= 0 {
		interval = defaultAgentRunPolicyWatchInterval
	}
	watcher := &agentRunPolicyWatcher{path: path, lastRevision: revision, interval: interval}
	go s.runAgentRunPolicyWatcher(watchCtx, watcher, done)
}

// stopAgentRunPolicyWatcher is idempotent and waits for the watcher to leave
// before the Harness or Ledger is detached. This prevents a final external
// policy update from racing shutdown and applying to a closing Harness.
func (s *Service) stopAgentRunPolicyWatcher() {
	if s == nil {
		return
	}
	s.agentPolicyWatcherMu.Lock()
	cancel := s.agentPolicyWatcherCancel
	done := s.agentPolicyWatcherDone
	s.agentPolicyWatcherMu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	if done != nil {
		<-done
	}
}

func (s *Service) runAgentRunPolicyWatcher(ctx context.Context, watcher *agentRunPolicyWatcher, done chan struct{}) {
	defer func() {
		close(done)
		s.agentPolicyWatcherMu.Lock()
		if s.agentPolicyWatcherDone == done {
			s.agentPolicyWatcherCancel = nil
			s.agentPolicyWatcherDone = nil
		}
		s.agentPolicyWatcherMu.Unlock()
	}()

	interval := watcher.interval
	if interval <= 0 {
		interval = defaultAgentRunPolicyWatchInterval
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			nextInterval := s.reloadAgentRunPolicy(watcher)
			if nextInterval > 0 {
				interval = nextInterval
			}
			if interval <= 0 {
				interval = defaultAgentRunPolicyWatchInterval
			}
			timer.Reset(interval)
		}
	}
}

// reloadAgentRunPolicy applies only a strictly newer, valid file revision. A
// malformed or partially-written file is ignored and retried on the next tick;
// the live Harness therefore keeps its last known-good configuration.
func (s *Service) reloadAgentRunPolicy(watcher *agentRunPolicyWatcher) time.Duration {
	if s == nil || watcher == nil {
		return 0
	}

	s.agentPolicyMu.Lock()
	snapshot, err := loadServiceRunPolicy(watcher.path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.reportAgentPolicyWatcherError(watcher, err)
		} else {
			watcher.lastError = ""
		}
		s.agentPolicyMu.Unlock()
		return 0
	}
	// Normalize before comparing revisions so a newly added/omitted field gets
	// the same default on both desktop and CLI readers.  The returned cadence is
	// applied even when the revision is unchanged, which lets a manually edited
	// file take effect without waiting for a second write.
	snapshot.Runtime = snapshot.Runtime.Normalize()
	nextInterval := snapshot.Runtime.PolicyWatchInterval
	if snapshot.Revision <= watcher.lastRevision {
		s.agentPolicyMu.Unlock()
		return nextInterval
	}

	s.agentMu.RLock()
	harness := s.agentHarness
	shutdown := s.agentHarnessShutdown
	s.agentMu.RUnlock()
	if shutdown || harness == nil {
		// Do not consume the revision while there is no live owner. A later
		// initialization can then apply the newest durable snapshot normally.
		s.agentPolicyMu.Unlock()
		return nextInterval
	}

	previousRuntime := harness.RuntimeConfig()
	previousPolicy := harness.DefaultPolicy()
	// AISaveRunPolicy updates the live Harness before the watcher observes its
	// newly-renamed file. Treat that as already applied so the save does not
	// trigger a duplicate setter call or cloud-backup notification.
	if snapshot.Runtime == previousRuntime && snapshot.Policy == previousPolicy {
		watcher.lastRevision = snapshot.Revision
		watcher.lastError = ""
		s.agentPolicyMu.Unlock()
		return nextInterval
	}
	if err := harness.SetRuntimeConfig(snapshot.Runtime); err != nil {
		s.reportAgentPolicyWatcherError(watcher, err)
		s.agentPolicyMu.Unlock()
		return nextInterval
	}
	if err := harness.SetDefaultPolicy(snapshot.Policy); err != nil {
		// Keep the live pair atomic from the adapter's point of view. The durable
		// file belongs to another writer, so leave it untouched and retry later.
		_ = harness.SetRuntimeConfig(previousRuntime)
		_ = harness.SetDefaultPolicy(previousPolicy)
		s.reportAgentPolicyWatcherError(watcher, err)
		s.agentPolicyMu.Unlock()
		return nextInterval
	}

	watcher.lastRevision = snapshot.Revision
	watcher.lastError = ""
	changed := s.configChanged
	s.agentPolicyMu.Unlock()
	if changed != nil {
		changed()
	}
	return nextInterval
}

func (s *Service) reportAgentPolicyWatcherError(watcher *agentRunPolicyWatcher, err error) {
	if watcher == nil || err == nil {
		return
	}
	message := strings.TrimSpace(err.Error())
	if message == "" || message == watcher.lastError {
		return
	}
	watcher.lastError = message
	logger.Warnf("热加载 AI Agent Run Policy 失败：%v", err)
}
