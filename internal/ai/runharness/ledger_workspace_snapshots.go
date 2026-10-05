package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// PutWorkspaceSnapshot accepts only strictly newer revisions for a source
// instance. Replaying the same revision is idempotent when its content hash
// matches; conflicting content is rejected.
func (l *Ledger) PutWorkspaceSnapshot(ctx context.Context, snapshot WorkspaceSnapshot) (WorkspaceSnapshot, error) {
	return l.PutWorkspaceSnapshotWithLeaseDuration(ctx, snapshot, 0)
}

// PutWorkspaceSnapshotWithLeaseDuration is the Harness-facing variant that
// allows the owner to freeze a lease policy for a run. A zero duration uses
// the Ledger's configured default. Repeated publication of the same revision
// and hash renews the existing row without creating another snapshot.
func (l *Ledger) PutWorkspaceSnapshotWithLeaseDuration(ctx context.Context, snapshot WorkspaceSnapshot, leaseDuration time.Duration) (WorkspaceSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	if leaseDuration < 0 {
		return WorkspaceSnapshot{}, ErrSnapshotLeaseConfig
	}
	if leaseDuration == 0 {
		leaseDuration = l.workspaceSnapshotLeaseTTL
		if leaseDuration <= 0 {
			leaseDuration = DefaultWorkspaceSnapshotLeaseDuration
		}
	}
	now := nowUTC()
	leaseExpiresAt := toNano(now.Add(leaseDuration))
	if err := snapshot.Normalize(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	defer tx.Rollback()
	var latestRevision int64
	var latestHash string
	err = tx.QueryRowContext(ctx, `SELECT revision,content_hash FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? ORDER BY revision DESC LIMIT 1`, snapshot.SourceID, snapshot.SourceInstanceID).Scan(&latestRevision, &latestHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, err
	}
	if err == nil {
		if snapshot.Revision < latestRevision {
			return WorkspaceSnapshot{}, fmt.Errorf("%w: expected revision > %d", ErrSnapshotConflict, latestRevision)
		}
		if snapshot.Revision == latestRevision && snapshot.ContentHash != latestHash {
			return WorkspaceSnapshot{}, fmt.Errorf("%w: content hash changed at revision %d", ErrSnapshotConflict, snapshot.Revision)
		}
		if snapshot.Revision == latestRevision {
			// A repeated full snapshot is also the source heartbeat. Refresh the
			// lease even when the source has not changed its revision.
			if _, err := tx.ExecContext(ctx, `UPDATE workspace_snapshots SET lease_expires_at=? WHERE source_id=? AND source_instance_id=? AND revision=? AND content_hash=?`, leaseExpiresAt, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision, snapshot.ContentHash); err != nil {
				return WorkspaceSnapshot{}, err
			}
			if err := tx.Commit(); err != nil {
				return WorkspaceSnapshot{}, err
			}
			return snapshot, nil
		}
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	sealed, err := l.sealRaw("workspace_snapshots", fmt.Sprintf("%s/%s/%d", snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision), "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_snapshots(source_id,source_instance_id,revision,content_hash,captured_at,payload,lease_expires_at) VALUES(?,?,?,?,?,?,?)`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision, snapshot.ContentHash, toNano(snapshot.CapturedAt), sealed, leaseExpiresAt); err != nil {
		return WorkspaceSnapshot{}, err
	}
	// A legacy desktop source minted a new revision for every five-second lease
	// heartbeat. When no active run can still depend on an exact older snapshot,
	// collapse that source instance to its newest complete view immediately.
	// This backend guard bounds disk growth even when an older UI is connected.
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_snapshots
		WHERE source_id=? AND source_instance_id=? AND revision<?
		  AND NOT EXISTS (
			SELECT 1 FROM runs
			WHERE context_source_id=? AND context_source_instance_id=?
			  AND state NOT IN ('completed','failed','canceled','exhausted')
		  )`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision, snapshot.SourceID, snapshot.SourceInstanceID); err != nil {
		return WorkspaceSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	return snapshot, nil
}

// PutWorkspaceSnapshotWithTTL is a naming alias for adapters that model the
// source liveness window as a time-to-live.
func (l *Ledger) PutWorkspaceSnapshotWithTTL(ctx context.Context, snapshot WorkspaceSnapshot, ttl time.Duration) (WorkspaceSnapshot, error) {
	return l.PutWorkspaceSnapshotWithLeaseDuration(ctx, snapshot, ttl)
}

func (l *Ledger) LatestWorkspaceSnapshot(ctx context.Context, sourceID, instanceID string) (WorkspaceSnapshot, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	var revision, leaseExpiresAt int64
	var payload []byte
	sourceID = strings.TrimSpace(sourceID)
	instanceID = strings.TrimSpace(instanceID)
	if sourceID == "" || instanceID == "" {
		return WorkspaceSnapshot{}, errors.New("workspace sourceId and sourceInstanceId are required")
	}
	err := l.db.QueryRowContext(ctx, `SELECT revision,payload,lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? ORDER BY revision DESC LIMIT 1`, sourceID, instanceID).Scan(&revision, &payload, &leaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	if leaseExpiresAt <= toNano(nowUTC()) {
		return WorkspaceSnapshot{}, ErrSnapshotExpired
	}
	plain, err := l.openRaw("workspace_snapshots", fmt.Sprintf("%s/%s/%d", sourceID, instanceID, revision), "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	var snapshot WorkspaceSnapshot
	if err := json.Unmarshal(plain, &snapshot); err != nil {
		return WorkspaceSnapshot{}, err
	}
	return snapshot, nil
}

// LatestWorkspaceSnapshotAllowExpired returns the newest encrypted snapshot
// together with whether its source lease has expired. It is only for an
// explicit user-confirmed recovery path; normal tool execution must use
// LatestWorkspaceSnapshot so a disconnected desktop/CLI cannot silently leak
// stale state into a run.
func (l *Ledger) LatestWorkspaceSnapshotAllowExpired(ctx context.Context, sourceID, instanceID string) (WorkspaceSnapshot, bool, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	sourceID = strings.TrimSpace(sourceID)
	instanceID = strings.TrimSpace(instanceID)
	if sourceID == "" || instanceID == "" {
		return WorkspaceSnapshot{}, false, errors.New("workspace sourceId and sourceInstanceId are required")
	}
	var revision, leaseExpiresAt int64
	var payload []byte
	err := l.db.QueryRowContext(ctx, `SELECT revision,payload,lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? ORDER BY revision DESC LIMIT 1`, sourceID, instanceID).Scan(&revision, &payload, &leaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, false, ErrNotFound
	}
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	plain, err := l.openRaw("workspace_snapshots", fmt.Sprintf("%s/%s/%d", sourceID, instanceID, revision), "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	var snapshot WorkspaceSnapshot
	if err := json.Unmarshal(plain, &snapshot); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	return snapshot, leaseExpiresAt <= toNano(nowUTC()), nil
}

// WorkspaceSnapshotByReference loads the exact encrypted snapshot identified
// by a durable tool/checkpoint reference. The boolean reports whether that
// row's source lease has expired; callers may still use the payload when they
// have an explicit stale-workspace policy. Unlike LatestWorkspaceSnapshot this
// method never silently substitutes a newer revision.
func (l *Ledger) WorkspaceSnapshotByReference(ctx context.Context, reference WorkspaceSnapshotReference) (WorkspaceSnapshot, bool, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	if !reference.valid() {
		return WorkspaceSnapshot{}, false, errors.New("workspace snapshot reference is incomplete")
	}
	var payload []byte
	var leaseExpiresAt int64
	err := l.db.QueryRowContext(ctx, `SELECT payload,lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? AND revision=? AND content_hash=?`, reference.SourceID, reference.SourceInstanceID, reference.Revision, reference.ContentHash).Scan(&payload, &leaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, false, ErrNotFound
	}
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	key := fmt.Sprintf("%s/%s/%d", reference.SourceID, reference.SourceInstanceID, reference.Revision)
	plain, err := l.openRaw("workspace_snapshots", key, "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	var snapshot WorkspaceSnapshot
	if err := json.Unmarshal(plain, &snapshot); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	if snapshot.SourceID != reference.SourceID || snapshot.SourceInstanceID != reference.SourceInstanceID || snapshot.Revision != reference.Revision || snapshot.ContentHash != reference.ContentHash {
		return WorkspaceSnapshot{}, false, fmt.Errorf("%w: workspace snapshot reference does not match payload", ErrSnapshotConflict)
	}
	return snapshot, leaseExpiresAt <= toNano(nowUTC()), nil
}

// GetWorkspaceSnapshotByReference is a descriptive alias for adapters and
// tests that prefer Get* naming. Both methods intentionally share the exact
// revision/content-hash semantics above.
func (l *Ledger) GetWorkspaceSnapshotByReference(ctx context.Context, reference WorkspaceSnapshotReference) (WorkspaceSnapshot, bool, error) {
	return l.WorkspaceSnapshotByReference(ctx, reference)
}
