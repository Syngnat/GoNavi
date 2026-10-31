package plugin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Manager controls durable intent independently of the optional runtime owner.
// NewManager and management methods never start code; only Start owns subprocesses.
type Manager struct {
	root        string
	opts        Options
	mu          sync.Mutex
	lifecycleMu sync.Mutex
	instances   map[string]*instance
	started     bool
	closed      bool
	cancel      context.CancelFunc
	done        chan struct{}
	wake        chan struct{}
	owner       *os.File
	// stateCache keeps the last validated state together with the file it came from.
	// reconcile and every Invoke call loadState; without it the whole JSON tree and every
	// manifest are decoded and validated again on each read.
	stateCacheMu   sync.Mutex
	stateCache     *diskState
	stateCacheInfo os.FileInfo
}

// Each instance owns a lifecycle context, never an API request context.
type instance struct {
	record    record
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	process   *rpcProcess
	ready     bool
	inflight  int
	aiTraffic aiProviderBudget
}

// NewManager opens private storage and validates persisted metadata without executing code.
func NewManager(options Options) (*Manager, error) {
	if options.Root == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		options.Root = filepath.Join(dir, "GoNavi", "plugins")
	}
	root, err := filepath.Abs(options.Root)
	if err != nil {
		return nil, err
	}
	if err = privateDirectory(root); err != nil {
		return nil, fmt.Errorf("prepare plugin storage: %w", err)
	}
	// Resolve user-chosen ancestors once, rejecting a link/reparse root itself before creating children.
	root, err = canonicalStorageRoot(root)
	if err != nil {
		return nil, fmt.Errorf("canonicalize plugin storage: %w", err)
	}
	for _, dir := range []string{filepath.Join(root, "store"), filepath.Join(root, "data"), filepath.Join(root, "staging")} {
		if err = privateDirectory(dir); err != nil {
			return nil, fmt.Errorf("prepare plugin storage: %w", err)
		}
	}
	options = defaultOptions(options)
	m := &Manager{root: root, opts: options, instances: make(map[string]*instance), wake: make(chan struct{}, 1)} // Coalesce reconcile notifications.
	if _, err = m.loadState(); err != nil {
		return nil, err
	}
	return m, nil
}
func defaultOptions(o Options) Options {
	if o.HandshakeTimeout <= 0 {
		o.HandshakeTimeout = 10 * time.Second
	}
	if o.HeartbeatInterval <= 0 {
		o.HeartbeatInterval = time.Second
	}
	if o.HeartbeatTimeout <= 0 {
		o.HeartbeatTimeout = time.Second
	}
	if o.MissedHeartbeats <= 0 {
		o.MissedHeartbeats = 3
	}
	if o.ShutdownTimeout <= 0 || o.ShutdownTimeout > 2*time.Second {
		o.ShutdownTimeout = 2 * time.Second
	}
	if o.InvocationTimeout <= 0 {
		o.InvocationTimeout = 30 * time.Second
	}
	if o.InvocationTimeout > 5*time.Minute {
		o.InvocationTimeout = 5 * time.Minute
	}
	if o.ReconcileInterval <= 0 || o.ReconcileInterval > 250*time.Millisecond {
		o.ReconcileInterval = 50 * time.Millisecond
	}
	if o.MaxConcurrentInvocations <= 0 || o.MaxConcurrentInvocations > 32 {
		o.MaxConcurrentInvocations = 16
	}
	return o
}

// Start acquires the sole runtime lease and asynchronously starts desired packages.
func (m *Manager) Start(ctx context.Context) error {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	m.mu.Lock()
	closed, started := m.closed, m.started
	m.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if started {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	owner, err := tryFileLock(filepath.Join(m.root, ".runtime.lock"))
	if err != nil {
		return err
	}
	if err = m.prepareOwnerState(ctx); err != nil {
		owner.Close()
		return err
	}
	lifetime, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.started = true
	m.cancel = cancel
	m.owner = owner
	m.done = make(chan struct{})
	done := m.done
	m.mu.Unlock()
	go m.run(lifetime, owner, done)
	return nil
}

// Close revokes work immediately, then waits only up to the caller's context.
// Cleanup remains owned by the supervisor if that deadline expires.
func (m *Manager) Close(ctx context.Context) error {
	m.lifecycleMu.Lock()
	m.mu.Lock()
	m.closed = true
	for _, inst := range m.instances {
		inst.ready = false
		inst.cancel()
	}
	cancel, done := m.cancel, m.done
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	m.lifecycleMu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// List returns a fresh deep snapshot, including mutations from other processes.
func (m *Manager) List() []Status {
	state, err := m.loadState()
	if err != nil {
		return []Status{}
	}
	result := make([]Status, 0, len(state.Records))
	for _, r := range state.Records {
		status := r.Status
		if m.opts.Disabled {
			status.State = StateDisabled
			status.LastError = "plugin runtime disabled by safe mode"
		}
		result = append(result, status)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Manifest.ID < result[j].Manifest.ID })
	return result
}

// Inspect is a bounded, no-execution inspection of a local package.
func (m *Manager) Inspect(ctx context.Context, path string) (Inspection, error) {
	return InspectPackage(ctx, path)
}
func (m *Manager) checkOpen() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	return nil
}
func (m *Manager) notify() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}
func (m *Manager) packageRoot(r record) string { return filepath.Join(m.root, "store", r.Digest) }

// SetEnabled persists user intent and fences current requests without waiting on a plugin.
func (m *Manager) SetEnabled(ctx context.Context, id string, enabled bool) (Status, error) {
	if err := m.checkOpen(); err != nil {
		return Status{}, err
	}
	if enabled && m.opts.Disabled {
		return Status{}, ErrDisabled
	}
	if !enabled {
		m.mu.Lock()
		if inst := m.instances[id]; inst != nil {
			inst.ready = false
			inst.cancel()
		}
		m.mu.Unlock()
	}
	var result Status
	_, err := m.mutate(ctx, func(state *diskState) (bool, error) {
		r, ok := state.Records[id]
		if !ok {
			return false, ErrNotFound
		}
		if r.Removing {
			if enabled {
				return false, ErrBusy
			}
			result = r.Status
			return false, nil
		}
		if r.DesiredEnabled == enabled && !r.Quarantined && (r.State == StateRunning || r.State == StateStarting || r.State == StateDisabled) {
			result = r.Status
			return false, nil
		}
		r.DesiredEnabled = enabled
		r.Generation = state.Generation
		r.LastError = ""
		r.Quarantined = false
		r.State = StateDisabled
		if r.ActiveGeneration != 0 {
			r.State = StateStopping
		}
		if enabled {
			r.State = StateStarting
		}
		state.Records[id] = r
		result = r.Status
		return true, nil
	})
	if err != nil {
		if !enabled {
			m.failClosed()
		}
		return Status{}, err
	}
	m.mu.Lock()
	if inst := m.instances[id]; inst != nil && (!enabled || inst.record.Generation != result.Generation) {
		inst.ready = false
		inst.cancel()
	}
	m.mu.Unlock()
	m.notify()
	return result, nil
}
func (m *Manager) updateRecord(ctx context.Context, id string, generation uint64, change func(*record)) error {
	_, err := m.mutate(ctx, func(state *diskState) (bool, error) {
		r, ok := state.Records[id]
		if !ok || r.Generation != generation {
			return false, ErrDisabled
		}
		previous := r.Generation
		change(&r)
		if r.Generation != previous {
			r.Generation = state.Generation
		}
		state.Records[id] = r
		return true, nil
	})
	return err
}

// OwnsRuntime reports local execution authority without disk IO or starting processes.
func (m *Manager) OwnsRuntime() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.started && !m.closed && m.owner != nil && !m.opts.Disabled
}

func (m *Manager) releaseOwner(owner *os.File) {
	owner.Close()
	m.mu.Lock()
	if m.owner == owner {
		m.owner = nil
		m.started = false
	}
	m.mu.Unlock()
}

func (m *Manager) run(ctx context.Context, owner *os.File, done chan struct{}) {
	defer close(done)
	defer m.releaseOwner(owner)
	ticker := time.NewTicker(m.opts.ReconcileInterval)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			break
		}
		m.reconcile(ctx)
		select {
		case <-ctx.Done():
		case <-m.wake:
		case <-ticker.C:
		}
	}
	m.mu.Lock()
	pending := make([]*instance, 0, len(m.instances))
	for _, inst := range m.instances {
		inst.ready = false
		inst.cancel()
		pending = append(pending, inst)
	}
	m.mu.Unlock()
	for _, inst := range pending {
		<-inst.done
	}
}
