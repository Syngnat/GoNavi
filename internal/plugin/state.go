package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const maxStateBytes = 32 << 20
const maxInstalled = 128

type record struct {
	Status
	Quarantined      bool   `json:"quarantined,omitempty"`
	ActiveGeneration uint64 `json:"activeGeneration,omitempty"`
	Removing         bool   `json:"removing,omitempty"`
}
type diskState struct {
	SchemaVersion int               `json:"schemaVersion"`
	Generation    uint64            `json:"generation"`
	Records       map[string]record `json:"records"`
}

func (m *Manager) loadState() (diskState, error) {
	state := diskState{SchemaVersion: 1, Records: make(map[string]record)}
	path := filepath.Join(m.root, "state.json")
	info, statErr := os.Stat(path)
	if errors.Is(statErr, os.ErrNotExist) {
		m.invalidateStateCache()
		return state, nil
	}
	if statErr != nil {
		return state, statErr
	}
	if cached := m.cachedState(info); cached != nil {
		return cloneDiskState(*cached), nil
	}
	f, err := openStateFile(path)
	if errors.Is(err, os.ErrNotExist) {
		m.invalidateStateCache()
		return state, nil
	}
	if err != nil {
		return state, err
	}
	defer f.Close()
	content, err := io.ReadAll(io.LimitReader(f, maxStateBytes+1))
	if err != nil {
		return state, err
	}
	if len(content) > maxStateBytes {
		return state, fmt.Errorf("plugin state exceeds size limit")
	}
	if err = json.Unmarshal(content, &state); err != nil {
		return state, fmt.Errorf("decode plugin state: %w", err)
	}
	if state.SchemaVersion != 1 || state.Records == nil || len(state.Records) > maxInstalled {
		return state, fmt.Errorf("unsupported or oversized plugin state")
	}
	for id, r := range state.Records {
		if r.Generation > state.Generation {
			state.Generation = r.Generation
		}
		switch r.State {
		case StateDisabled, StateStarting, StateRunning, StateStopping, StateFaulted, StateBlocked:
		default:
			return state, fmt.Errorf("invalid persisted lifecycle state")
		}
		if r.Generation == 0 || len(r.LastError) > 1024 {
			return state, fmt.Errorf("invalid persisted generation or diagnostics")
		}
		if id != r.Manifest.ID || !validDigest(r.Digest) {
			return state, fmt.Errorf("invalid plugin state identity")
		}
		if err = ValidateManifest(r.Manifest); err != nil {
			return state, fmt.Errorf("invalid persisted manifest: %w", err)
		}
	}
	m.storeStateCache(info, state)
	return cloneDiskState(state), nil
}

// cachedState returns a validated snapshot only when the file on disk is still the one that
// produced it. A renamed/in-place changed file has a different identity or mtime and misses.
func (m *Manager) cachedState(info os.FileInfo) *diskState {
	m.stateCacheMu.Lock()
	defer m.stateCacheMu.Unlock()
	if m.stateCache == nil || m.stateCacheInfo == nil {
		return nil
	}
	if !os.SameFile(m.stateCacheInfo, info) || m.stateCacheInfo.Size() != info.Size() || !m.stateCacheInfo.ModTime().Equal(info.ModTime()) {
		return nil
	}
	return m.stateCache
}

func (m *Manager) storeStateCache(info os.FileInfo, state diskState) {
	cached := cloneDiskState(state)
	m.stateCacheMu.Lock()
	m.stateCache = &cached
	m.stateCacheInfo = info
	m.stateCacheMu.Unlock()
}

func (m *Manager) invalidateStateCache() {
	m.stateCacheMu.Lock()
	m.stateCache = nil
	m.stateCacheInfo = nil
	m.stateCacheMu.Unlock()
}

func (m *Manager) mutate(ctx context.Context, change func(*diskState) (bool, error)) (diskState, error) {
	var empty diskState
	lock, err := acquireStateLock(ctx, filepath.Join(m.root, ".state.lock"))
	if err != nil {
		return empty, err
	}
	defer lock.Close()
	state, err := m.loadState()
	if err != nil {
		return empty, err
	}
	if state.Generation == ^uint64(0) {
		return state, fmt.Errorf("plugin generation space exhausted")
	}
	state.Generation++
	changed, err := change(&state)
	if err != nil {
		return state, err
	}
	if !changed {
		return state, nil
	}
	content, err := json.Marshal(state)
	if err != nil {
		return state, err
	}
	if len(content) > maxStateBytes {
		return state, fmt.Errorf("plugin state exceeds size limit")
	}
	if err = atomicStateWrite(m.root, content); err != nil {
		return state, fmt.Errorf("persist plugin state: %w", err)
	}
	m.invalidateStateCache()
	return state, nil
}
func acquireStateLock(ctx context.Context, path string) (*os.File, error) {
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		file, err := tryFileLock(path)
		if !errors.Is(err, ErrLocked) {
			return file, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, ErrLocked
		case <-retry.C:
		}
	}
}
func atomicStateWrite(root string, content []byte) error {
	f, err := os.CreateTemp(root, ".state-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(content)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return replaceStateFile(name, filepath.Join(root, "state.json"))
}
func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("plugin storage is not a regular directory")
	}
	return nil
}
