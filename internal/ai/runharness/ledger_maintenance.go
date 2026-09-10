package runharness

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LedgerStorageStats is a non-sensitive storage projection. Payload contents
// stay encrypted and are never returned to settings surfaces.
type LedgerStorageStats struct {
	FileBytes      int64 `json:"fileBytes"`
	WALBytes       int64 `json:"walBytes"`
	AllocatedBytes int64 `json:"allocatedBytes"`
	FreeBytes      int64 `json:"freeBytes"`
	SessionCount   int64 `json:"sessionCount"`
	RunCount       int64 `json:"runCount"`
	SnapshotCount  int64 `json:"snapshotCount"`
	ActiveRunCount int64 `json:"activeRunCount"`
}

type LedgerMaintenanceResult struct {
	Before           LedgerStorageStats `json:"before"`
	After            LedgerStorageStats `json:"after"`
	RemovedSnapshots int64              `json:"removedSnapshots"`
	RemovedSessions  int64              `json:"removedSessions"`
}

func (l *Ledger) StorageStats(ctx context.Context) (LedgerStorageStats, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return LedgerStorageStats{}, err
	}
	return l.storageStatsLocked(ctx)
}

func (l *Ledger) storageStatsLocked(ctx context.Context) (LedgerStorageStats, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	stats := LedgerStorageStats{}
	if l.path != "" && l.path != ":memory:" && !strings.HasPrefix(l.path, "file:") {
		stats.FileBytes = regularFileSize(l.path)
		stats.WALBytes = regularFileSize(l.path + "-wal")
	}
	var pageSize, pageCount, freePages int64
	if err := l.db.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return LedgerStorageStats{}, err
	}
	if err := l.db.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pageCount); err != nil {
		return LedgerStorageStats{}, err
	}
	if err := l.db.QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&freePages); err != nil {
		return LedgerStorageStats{}, err
	}
	stats.AllocatedBytes = pageSize * pageCount
	stats.FreeBytes = pageSize * freePages
	queries := []struct {
		query string
		value *int64
	}{
		{`SELECT COUNT(*) FROM sessions`, &stats.SessionCount},
		{`SELECT COUNT(*) FROM runs`, &stats.RunCount},
		{`SELECT COUNT(*) FROM workspace_snapshots`, &stats.SnapshotCount},
		{`SELECT COUNT(*) FROM runs WHERE state NOT IN ('completed','failed','canceled','exhausted')`, &stats.ActiveRunCount},
	}
	for _, item := range queries {
		if err := l.db.QueryRowContext(ctx, item.query).Scan(item.value); err != nil {
			return LedgerStorageStats{}, err
		}
	}
	return stats, nil
}

// OptimizeStorage drops superseded workspace snapshots while retaining the
// newest complete view for each desktop/CLI instance, then compacts SQLite.
// Active runs are rejected because they may hold an exact historical snapshot
// reference that is required to finish a pending model or tool step.
func (l *Ledger) OptimizeStorage(ctx context.Context) (LedgerMaintenanceResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return LedgerMaintenanceResult{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	before, err := l.storageStatsLocked(ctx)
	if err != nil {
		return LedgerMaintenanceResult{}, err
	}
	if before.ActiveRunCount > 0 {
		return LedgerMaintenanceResult{}, fmt.Errorf("agent data maintenance requires all runs to finish; %d run(s) are active", before.ActiveRunCount)
	}
	result, err := l.db.ExecContext(ctx, `DELETE FROM workspace_snapshots
		WHERE revision <> (
			SELECT MAX(newest.revision) FROM workspace_snapshots AS newest
			WHERE newest.source_id=workspace_snapshots.source_id
			  AND newest.source_instance_id=workspace_snapshots.source_instance_id
		)`)
	if err != nil {
		return LedgerMaintenanceResult{}, err
	}
	removed, _ := result.RowsAffected()
	if err := l.compactLocked(ctx); err != nil {
		return LedgerMaintenanceResult{}, fmt.Errorf("compact agent ledger after pruning %d snapshot(s): %w", removed, err)
	}
	after, err := l.storageStatsLocked(ctx)
	if err != nil {
		return LedgerMaintenanceResult{}, err
	}
	return LedgerMaintenanceResult{Before: before, After: after, RemovedSnapshots: removed}, nil
}

// ClearStorage removes all assistant conversations, runs and workspace
// snapshots while preserving the ledger encryption identity and schema.
func (l *Ledger) ClearStorage(ctx context.Context) (LedgerMaintenanceResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return LedgerMaintenanceResult{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	before, err := l.storageStatsLocked(ctx)
	if err != nil {
		return LedgerMaintenanceResult{}, err
	}
	if before.ActiveRunCount > 0 {
		return LedgerMaintenanceResult{}, fmt.Errorf("clearing agent data requires all runs to finish; %d run(s) are active", before.ActiveRunCount)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return LedgerMaintenanceResult{}, err
	}
	defer tx.Rollback()
	for _, table := range []string{
		"approvals", "tool_calls", "events", "checkpoints", "token_reservations",
		"queued_inputs", "control_commands", "steer_requests", "runs", "messages",
		"sessions", "workspace_snapshots", "migration_records",
	} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table); err != nil {
			return LedgerMaintenanceResult{}, fmt.Errorf("clear %s: %w", table, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return LedgerMaintenanceResult{}, err
	}
	if err := l.compactLocked(ctx); err != nil {
		return LedgerMaintenanceResult{}, fmt.Errorf("compact cleared agent ledger: %w", err)
	}
	after, err := l.storageStatsLocked(ctx)
	if err != nil {
		return LedgerMaintenanceResult{}, err
	}
	return LedgerMaintenanceResult{
		Before: before, After: after, RemovedSnapshots: before.SnapshotCount, RemovedSessions: before.SessionCount,
	}, nil
}

// BackupTo writes a transactionally consistent, compact copy. VACUUM INTO
// includes committed WAL pages and never copies a live -wal/-shm pair.
func (l *Ledger) BackupTo(ctx context.Context, target string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	target = strings.TrimSpace(target)
	if target == "" || !filepath.IsAbs(target) {
		return errors.New("agent ledger backup target must be an absolute path")
	}
	if _, err := os.Lstat(target); err == nil {
		return errors.New("agent ledger backup target already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, err := l.db.ExecContext(ctx, `VACUUM INTO '`+strings.ReplaceAll(target, `'`, `''`)+`'`)
	return err
}

func (l *Ledger) compactLocked(ctx context.Context) error {
	if _, err := l.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return err
	}
	if _, err := l.db.ExecContext(ctx, `VACUUM`); err != nil {
		return err
	}
	_, err := l.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	return err
}

func regularFileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0
	}
	return info.Size()
}
