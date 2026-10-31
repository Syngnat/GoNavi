package plugin

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Install copies exact inspected contents into a new immutable store entry, initially disabled.
// Updates require disable first and renew explicit trust; no prior enabled state is inherited.
func (m *Manager) Install(ctx context.Context, request InstallRequest) (Status, error) {
	if err := m.checkOpen(); err != nil {
		return Status{}, err
	}
	if !request.Trusted {
		return Status{}, fmt.Errorf("explicit trust is required for plugin installation")
	}
	if !validDigest(request.Digest) {
		return Status{}, ErrDigestMismatch
	}
	staging, err := os.MkdirTemp(filepath.Join(m.root, "staging"), "install-")
	if err != nil {
		return Status{}, err
	}
	defer os.RemoveAll(staging)
	inspection, err := scanPackage(ctx, request.Path, staging)
	if err != nil {
		return Status{}, err
	}
	if inspection.Digest != request.Digest {
		return Status{}, ErrDigestMismatch
	}
	verify, err := InspectPackage(ctx, staging)
	if err != nil {
		return Status{}, err
	}
	if verify.Digest != request.Digest {
		return Status{}, ErrDigestMismatch
	}
	target := filepath.Join(m.root, "store", inspection.Digest)
	replaceCorrupt := false
	if info, statErr := os.Lstat(target); statErr == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return Status{}, fmt.Errorf("invalid immutable package location")
		}
		existing, checkErr := InspectPackage(ctx, target)
		// A store entry can be damaged after publication (antivirus quarantine, power loss).
		// Refusing to reinstall the same digest would strand the user with no repair path, so
		// treat an unreadable or mismatched entry as corrupt and republish it from staging.
		if checkErr != nil || existing.Digest != inspection.Digest {
			replaceCorrupt = true
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Status{}, statErr
	}
	if err = sealPackage(staging, inspection.Manifest); err != nil {
		return Status{}, err
	}
	result := Status{Manifest: inspection.Manifest, Digest: inspection.Digest, State: StateDisabled, InstalledAt: time.Now().UTC().Format(time.RFC3339Nano)}
	// Slow inspection/copy is outside both state and runtime locks. Only publication is serialized.
	_, err = m.mutate(ctx, func(state *diskState) (bool, error) {
		previous, exists := state.Records[result.Manifest.ID]
		if exists && previous.Removing {
			return false, ErrBusy
		}
		if exists && previous.ActiveGeneration != 0 {
			return false, ErrBusy
		}
		if exists && previous.DesiredEnabled {
			return false, fmt.Errorf("disable plugin before replacing its package")
		}
		if !exists && len(state.Records) >= maxInstalled {
			return false, fmt.Errorf("installed plugin limit reached")
		}
		result.Generation = state.Generation
		target := filepath.Join(m.root, "store", inspection.Digest)
		if info, statErr := os.Lstat(target); statErr == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return false, fmt.Errorf("invalid immutable package location")
			}
			if replaceCorrupt {
				quarantine := target + ".corrupt-" + time.Now().UTC().Format("20060102T150405.000000000")
				if renameErr := os.Rename(target, quarantine); renameErr != nil {
					return false, fmt.Errorf("quarantine corrupt package: %w", renameErr)
				}
				if renameErr := os.Rename(staging, target); renameErr != nil {
					return false, renameErr
				}
			}
		} else if errors.Is(statErr, os.ErrNotExist) {
			if renameErr := os.Rename(staging, target); renameErr != nil {
				return false, renameErr
			}
		} else {
			return false, statErr
		}
		state.Records[result.Manifest.ID] = record{Status: result}
		return true, nil
	})
	if err != nil {
		return Status{}, err
	}
	m.notify()
	return result, nil
}
func sealPackage(root string, m Manifest) error {
	executables := make(map[string]bool)
	if m.Backend != nil {
		if m.Backend.Default != nil {
			e := m.Backend.Default
			if e.Runtime == "" || e.Runtime == "native" {
				executables[e.Executable] = true
			}
		}
		for _, e := range m.Backend.Platforms {
			if e.Runtime == "" || e.Runtime == "native" {
				executables[e.Executable] = true
			}
		}
	}
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		mode := fs.FileMode(0400)
		if executables[filepath.ToSlash(relative)] {
			mode = 0500
		}
		return os.Chmod(path, mode)
	})
}

// Remove forgets a disabled package. Purge additionally removes mutable plugin data.
// Content-addressed package files are retained for in-flight readers and safe rollback.
func (m *Manager) Remove(ctx context.Context, id string, purge bool) error {
	if err := m.checkOpen(); err != nil {
		return err
	}
	var generation uint64
	_, err := m.mutate(ctx, func(state *diskState) (bool, error) {
		r, ok := state.Records[id]
		if !ok {
			return false, ErrNotFound
		}
		if r.DesiredEnabled {
			return false, ErrEnabled
		}
		if r.ActiveGeneration != 0 || (!purge && r.Removing) {
			return false, ErrBusy
		}
		if !purge {
			delete(state.Records, id)
			return true, nil
		}
		// Keep a durable tombstone until data deletion succeeds: concurrent reinstall cannot lose new data.
		r.Removing = true
		r.Generation = state.Generation
		r.LastError = "plugin data purge pending"
		generation = r.Generation
		state.Records[id] = r
		return true, nil
	})
	if err != nil {
		return err
	}
	m.notify()
	if !purge {
		return nil
	}
	if err = os.RemoveAll(filepath.Join(m.root, "data", id)); err != nil {
		return fmt.Errorf("purge plugin data: %w", err)
	}
	_, err = m.mutate(ctx, func(state *diskState) (bool, error) {
		r, ok := state.Records[id]
		if !ok {
			return false, nil
		}
		if !r.Removing || r.Generation != generation {
			return false, ErrBusy
		}
		delete(state.Records, id)
		return true, nil
	})
	return err
}
