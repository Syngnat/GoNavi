package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"GoNavi-Wails/internal/buildversion"
	"GoNavi-Wails/internal/logger"
)

func (m *Manager) prepareOwnerState(ctx context.Context) error {
	_, err := m.mutate(ctx, func(state *diskState) (bool, error) {
		changed := false
		for id, r := range state.Records {
			if r.ActiveGeneration != 0 {
				r.ActiveGeneration = 0
				changed = true
				if r.State == StateStopping {
					r.State = StateDisabled
					r.Generation = state.Generation
				}
			}
			if r.DesiredEnabled && !r.Quarantined && !r.Removing {
				r.Generation = state.Generation
				r.State = StateStarting
				if m.opts.Disabled {
					r.State = StateDisabled
				}
				r.LastError = ""
				changed = true
			}
			state.Records[id] = r
		}
		return changed, nil
	})
	return err
}

func (m *Manager) reconcile(ctx context.Context) {
	state, err := m.loadState()
	if err != nil {
		m.revokeAll()
		return
	}
	m.mu.Lock()
	for id, inst := range m.instances {
		current, ok := state.Records[id]
		if !ok || !current.DesiredEnabled || current.Generation != inst.record.Generation || current.Quarantined || m.opts.Disabled || dependencyReason(current, state.Records) != "" {
			inst.ready = false
			inst.cancel()
		}
	}
	m.mu.Unlock()
	if m.opts.Disabled {
		return
	}
	for id, r := range state.Records {
		if !r.DesiredEnabled || r.Quarantined || r.Removing {
			continue
		}
		reason := dependencyReason(r, state.Records)
		if r.Manifest.MinHostVersion != "" && !buildversion.SatisfiesMinimum(m.opts.HostVersion, r.Manifest.MinHostVersion) {
			reason = "plugin requires a newer compatible host version"
		}
		if reason != "" {
			if r.State != StateBlocked || r.LastError != reason {
				if err := m.updateRecord(ctx, id, r.Generation, func(value *record) { value.State = StateBlocked; value.LastError = reason; value.Generation++ }); err != nil && !errors.Is(err, ErrDisabled) {
					m.failClosed()
					return
				}
			}
			continue
		}
		m.mu.Lock()
		if m.closed || m.instances[id] != nil {
			m.mu.Unlock()
			continue
		}
		lifetime, cancel := context.WithCancel(ctx)
		inst := &instance{record: r, ctx: lifetime, cancel: cancel, done: make(chan struct{})}
		m.instances[id] = inst
		m.mu.Unlock()
		go m.runInstance(inst)
	}
}
func (m *Manager) revokeAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, inst := range m.instances {
		inst.ready = false
		inst.cancel()
	}
}
func dependencyReason(r record, records map[string]record) string {
	if dependencyCycle(r.Manifest.ID, records, make(map[string]bool), make(map[string]bool)) {
		return "plugin dependency cycle"
	}
	for _, d := range r.Manifest.Requires {
		dependency, ok := records[d.ID]
		if !ok && d.Optional {
			continue
		}
		if !ok {
			return "required plugin dependency is not installed"
		}
		if d.MinVersion != "" && !versionAtLeast(dependency.Manifest.Version, d.MinVersion) {
			return "plugin dependency version is incompatible"
		}
		if !dependency.DesiredEnabled || dependency.Quarantined || dependency.State != StateRunning {
			return "plugin dependency is not running"
		}
	}
	return ""
}
func dependencyCycle(id string, records map[string]record, visiting, visited map[string]bool) bool {
	if visiting[id] {
		return true
	}
	if visited[id] {
		return false
	}
	visiting[id] = true
	for _, d := range records[id].Manifest.Requires {
		if _, ok := records[d.ID]; ok && dependencyCycle(d.ID, records, visiting, visited) {
			return true
		}
	}
	visiting[id] = false
	visited[id] = true
	return false
}
func (m *Manager) runInstance(inst *instance) {
	err := m.activate(inst)
	m.mu.Lock()
	inst.ready = false
	m.mu.Unlock()
	if err != nil && inst.ctx.Err() == nil {
		m.quarantine(inst, err)
	}
	if inst.process != nil {
		inst.process.stop(m.opts.ShutdownTimeout)
	}
	m.recordStopped(inst)
	m.mu.Lock()
	if m.instances[inst.record.Manifest.ID] == inst {
		delete(m.instances, inst.record.Manifest.ID)
	}
	m.mu.Unlock()
	close(inst.done)
	m.notify()
}
func (m *Manager) activate(inst *instance) error {
	r := inst.record
	root := m.packageRoot(r)
	inspected, err := InspectPackage(inst.ctx, root)
	if err != nil {
		return fmt.Errorf("verify installed package: %w", err)
	}
	if inspected.Digest != r.Digest {
		return ErrDigestMismatch
	}
	if err = m.updateRecord(inst.ctx, r.Manifest.ID, r.Generation, func(value *record) {
		value.State = StateStarting
		value.LastError = ""
		value.ActiveGeneration = value.Generation
	}); err != nil {
		return err
	}
	if r.Manifest.Backend != nil {
		dataRoot := filepath.Join(m.root, "data", r.Manifest.ID)
		if err = privateDirectory(dataRoot); err != nil {
			return err
		}
		process, launchErr := launchProcess(r.Manifest, root, dataRoot, m.opts.ProxyEnvironment)
		if launchErr != nil {
			return launchErr
		}
		m.bindHostLog(inst, process)
		m.mu.Lock()
		inst.process = process
		m.mu.Unlock()
		ctx, cancel := context.WithTimeout(inst.ctx, m.opts.HandshakeTimeout)
		result, initializeErr := process.call(ctx, "plugin.initialize", map[string]any{"apiVersion": 1, "pluginId": r.Manifest.ID, "version": r.Manifest.Version, "generation": r.Generation, "config": map[string]any{}, "hostVersion": m.opts.HostVersion, "locale": m.opts.Locale, "permissions": r.Manifest.Permissions})
		cancel()
		if initializeErr != nil {
			return fmt.Errorf("initialize plugin: %w", initializeErr)
		}
		var handshake struct {
			APIVersion int `json:"apiVersion"`
		}
		if json.Unmarshal(result, &handshake) != nil || handshake.APIVersion != 1 {
			return fmt.Errorf("plugin rejected api handshake")
		}
	}
	if err = inst.ctx.Err(); err != nil {
		return err
	}
	// Readiness is published before the persisted running state becomes visible. List, replace and
	// the UI treat that state as an invitable generation, so any caller that observes it must
	// already pass the invocation fence instead of failing with ErrDisabled.
	m.mu.Lock()
	owned := m.instances[r.Manifest.ID] == inst && inst.ctx.Err() == nil
	process := inst.process
	if owned {
		inst.ready = true
	}
	m.mu.Unlock()
	if !owned {
		if ctxErr := inst.ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("plugin generation %d is no longer owned by this runtime", r.Generation)
	}
	if err = m.updateRecord(inst.ctx, r.Manifest.ID, r.Generation, func(value *record) { value.State = StateRunning; value.LastError = "" }); err != nil {
		m.mu.Lock()
		inst.ready = false
		m.mu.Unlock()
		return err
	}
	if process != nil {
		process.notify("plugin.lifecycle", map[string]any{"event": "running", "generation": r.Generation})
	}
	m.notify()
	return m.monitor(inst)
}
func (m *Manager) monitor(inst *instance) error {
	if inst.process == nil {
		<-inst.ctx.Done()
		return inst.ctx.Err()
	}
	ticker := time.NewTicker(m.opts.HeartbeatInterval)
	defer ticker.Stop()
	misses := 0
	var lastErr error
	for {
		select {
		case <-inst.ctx.Done():
			return inst.ctx.Err()
		case <-inst.process.failed:
			return inst.process.failure()
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(inst.ctx, m.opts.HeartbeatTimeout)
			_, err := inst.process.call(ctx, "plugin.ping", struct{}{})
			cancel()
			if err == nil {
				misses = 0
				lastErr = nil
				continue
			}
			misses++
			lastErr = err
			logger.Warnf("plugin %s: heartbeat miss %d/%d: %v", inst.record.Manifest.ID, misses, m.opts.MissedHeartbeats, err)
			if misses >= m.opts.MissedHeartbeats {
				// The last ping error is the only evidence of why the budget ran out: a
				// timeout, a saturated transport and a dying process all look identical
				// once only the counter survives. Keep it in the chain and in the log.
				logger.Warnf("plugin %s: heartbeat budget exhausted after %d misses: %v", inst.record.Manifest.ID, misses, lastErr)
				return fmt.Errorf("plugin heartbeat budget exhausted: %w", lastErr)
			}
		}
	}
}
func (m *Manager) quarantine(inst *instance, cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	message := cause.Error()
	if len(message) > 1024 {
		message = message[:1024]
	}
	// A quarantined record survives restarts and only the persisted message reaches the card,
	// so the log has to carry the same cause or the fault becomes unreproducible later.
	logger.Warnf("plugin %s: quarantined generation %d: %s", inst.record.Manifest.ID, inst.record.Generation, message)
	// Persist before cleanup: a crash during shutdown must not produce a boot loop. A dropped
	// quarantine is worse: the next reconcile restarts the plugin, the fault repeats, and the
	// unguarded stop path finally parks the record in a bogus disabled state. updateRecord
	// guards on the start generation, so when a concurrent write moved it, re-read and retry
	// with the fresh generation while the record still wants to run.
	for attempt := 0; attempt < 5; attempt++ {
		state, err := m.loadState()
		if err != nil {
			m.failClosed()
			return
		}
		current, ok := state.Records[inst.record.Manifest.ID]
		if !ok || current.Removing || !current.DesiredEnabled {
			return
		}
		err = m.updateRecord(ctx, inst.record.Manifest.ID, current.Generation, func(r *record) {
			r.Quarantined = true
			r.State = StateFaulted
			r.LastError = message
			r.Generation++
		})
		if err == nil {
			return
		}
		if !errors.Is(err, ErrDisabled) {
			m.failClosed()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
	m.failClosed()
}

func (m *Manager) failClosed() {
	m.revokeAll()
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
}

func (m *Manager) recordStopped(inst *instance) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := m.mutate(ctx, func(state *diskState) (bool, error) {
		id := inst.record.Manifest.ID
		r, ok := state.Records[id]
		if !ok || r.ActiveGeneration != inst.record.Generation {
			return false, nil
		}
		r.ActiveGeneration = 0
		if r.State == StateStopping || r.Generation == inst.record.Generation {
			r.State = StateDisabled
			r.Generation = state.Generation
		}
		state.Records[id] = r
		return true, nil
	})
	if err != nil {
		m.failClosed()
	}
}
