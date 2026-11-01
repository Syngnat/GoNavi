package plugin

import (
	"context"
	"fmt"
	"time"
)

// replaceSettleBudget bounds how long a replacement waits for the previous generation to stop.
const replaceSettleBudget = 5 * time.Second

func (m *Manager) waitGenerationSettled(ctx context.Context, id string) error {
	deadline := time.NewTimer(replaceSettleBudget)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, err := m.loadState()
		if err != nil {
			return err
		}
		if record, ok := state.Records[id]; !ok || record.ActiveGeneration == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return ErrBusy
		case <-ticker.C:
		}
	}
}

// ReplacePackage swaps an installed plugin for the exact inspected package and keeps the
// previous enable intent, so a running plugin does not have to be disabled by hand. The
// prior package is untouched when installation fails, so restoring intent is safe.
func (m *Manager) ReplacePackage(ctx context.Context, request InstallRequest) (Status, error) {
	if err := m.checkOpen(); err != nil {
		return Status{}, err
	}
	if !request.Trusted {
		return Status{}, fmt.Errorf("explicit trust is required for plugin installation")
	}
	if !validDigest(request.Digest) {
		return Status{}, ErrDigestMismatch
	}
	inspection, err := m.Inspect(ctx, request.Path)
	if err != nil {
		return Status{}, err
	}
	if inspection.Digest != request.Digest {
		return Status{}, ErrDigestMismatch
	}
	id := inspection.Manifest.ID
	state, err := m.loadState()
	if err != nil {
		return Status{}, err
	}
	previous, exists := state.Records[id]
	if !exists {
		return Status{}, ErrNotFound
	}
	if previous.Removing {
		return Status{}, ErrBusy
	}
	if previous.Digest == request.Digest {
		return previous.Status, nil
	}
	wasEnabled := previous.DesiredEnabled
	if wasEnabled && m.opts.Disabled {
		// Safe mode refuses enable, so replacing an enabled plugin would silently leave it disabled.
		return Status{}, fmt.Errorf("%w: safe mode cannot replace an enabled plugin; disable it first", ErrDisabled)
	}
	if wasEnabled {
		if _, err = m.SetEnabled(ctx, id, false); err != nil {
			return Status{}, err
		}
		// Installation rejects a plugin whose previous generation is still running, and the
		// runtime owner stops that.instance asynchronously.
		if err = m.waitGenerationSettled(ctx, id); err != nil {
			_, _ = m.reenableAfterReplace(ctx, id)
			return Status{}, err
		}
	}
	status, installErr := m.Install(ctx, request)
	if installErr != nil {
		if wasEnabled {
			_, _ = m.reenableAfterReplace(ctx, id)
		}
		return Status{}, installErr
	}
	if !wasEnabled {
		return status, nil
	}
	enabled, enableErr := m.reenableAfterReplace(ctx, id)
	if enableErr != nil {
		return status, fmt.Errorf("plugin installed but could not be re-enabled: %w", enableErr)
	}
	return enabled, nil
}

// reenableAfterReplace runs outside the caller's cancellation: the package change already
// happened, so a cancelled request must not leave the plugin disabled as a side effect.
func (m *Manager) reenableAfterReplace(ctx context.Context, id string) (Status, error) {
	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	return m.SetEnabled(detached, id, true)
}
