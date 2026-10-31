//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"errors"
	"fmt"
)

type hiveRecovery struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	err    error
}

// Only the cached editor/catalog facades reconnect. A pinned import/session
// retains its failed identity and must never resume on an unrelated session.
func (h *HiveDB) sessionContext(ctx context.Context, metadata bool) (*hiveSession, error) {
	if ctx == nil {
		return nil, fmt.Errorf("Hive request context is nil")
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		h.mu.Lock()
		current, recovery := h.main, h.mainRecovery
		if metadata {
			current, recovery = h.metadata, h.metadataRecovery
		}
		if current == nil {
			h.mu.Unlock()
			return nil, fmt.Errorf("HiveServer2 connection is closed")
		}
		if current.lifetime.Err() == nil {
			h.mu.Unlock()
			return current, nil
		}
		if recovery != nil {
			h.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-recovery.done:
				if recovery.err != nil {
					return nil, recovery.err
				}
				continue
			}
		}
		cfg, server := h.config, h.serverName
		connectCtx, cancel := context.WithTimeout(ctx, getConnectTimeout(cfg.ConnectionConfig))
		recovery = &hiveRecovery{ctx: connectCtx, cancel: cancel, done: make(chan struct{})}
		if metadata {
			h.metadataRecovery = recovery
		} else {
			h.mainRecovery = recovery
		}
		h.mu.Unlock()
		fresh, err := h.recoverHiveSession(recovery, current, cfg, server, metadata)
		h.finishHiveRecovery(recovery, current, fresh, metadata, err)
		if recovery.err != nil {
			return nil, recovery.err
		}
	}
}
func (h *HiveDB) recoverHiveSession(recovery *hiveRecovery, old *hiveSession, cfg hiveConfig, server string, metadata bool) (*hiveSession, error) {
	select {
	case <-recovery.ctx.Done():
		return nil, recovery.ctx.Err()
	case <-old.done:
	}
	fresh, err := newHiveSession(recovery.ctx, cfg, server)
	if err != nil {
		return nil, err
	}
	if !metadata {
		if err = h.attachHiveSourceMetadata(recovery.ctx, fresh); err != nil {
			return nil, errors.Join(err, fresh.Close())
		}
	}
	return fresh, nil
}
func (h *HiveDB) finishHiveRecovery(recovery *hiveRecovery, old, fresh *hiveSession, metadata bool, resultErr error) {
	h.mu.Lock()
	current := h.main
	if metadata {
		current = h.metadata
	}
	accepted := current == old && h.sessions != nil && resultErr == nil
	if accepted {
		delete(h.sessions, old)
		h.sessions[fresh] = struct{}{}
		if metadata {
			h.metadata = fresh
		} else {
			h.main = fresh
		}
	}
	if current != old || h.sessions == nil {
		resultErr = errors.Join(resultErr, fmt.Errorf("HiveServer2 connection closed during session recovery"))
	}
	if metadata {
		if h.metadataRecovery == recovery {
			h.metadataRecovery = nil
		}
	} else if h.mainRecovery == recovery {
		h.mainRecovery = nil
	}
	recovery.err = resultErr
	close(recovery.done)
	h.mu.Unlock()
	recovery.cancel()
	if fresh != nil && !accepted {
		fresh.Close()
	}
}
