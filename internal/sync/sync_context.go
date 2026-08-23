package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"errors"
	"fmt"
	"strings"
)

type syncDriverContextKey struct{}

// markSyncDriverContext keeps RunSync's historical Query/Exec dispatch intact
// while allowing callers that explicitly choose RunSyncContext to opt in to
// the optional context-aware driver methods. This matters for compatibility
// with wrappers that override Query/Exec but inherit unrelated context methods.
func markSyncDriverContext(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, syncDriverContextKey{}, true)
}

func syncDriverContextEnabled(ctx context.Context) bool {
	enabled, _ := ctx.Value(syncDriverContextKey{}).(bool)
	return enabled
}

type syncQueryContexter interface {
	QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
}

type syncExecContexter interface {
	ExecContext(context.Context, string) (int64, error)
}

type syncBatchApplyContexter interface {
	ApplyChangesContext(context.Context, string, connection.ChangeSet) error
}

func (s *SyncEngine) context() context.Context {
	if s == nil || s.ctx == nil {
		return context.Background()
	}
	return s.ctx
}

func (s *SyncEngine) contextError() error {
	return s.context().Err()
}

func querySyncDatabaseContext(ctx context.Context, database db.Database, query string) ([]map[string]interface{}, []string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if syncDriverContextEnabled(ctx) {
		if contextDatabase, ok := database.(syncQueryContexter); ok {
			return contextDatabase.QueryContext(ctx, query)
		}
	}
	rows, columns, err := database.Query(query)
	if err != nil {
		return rows, columns, err
	}
	if contextErr := ctx.Err(); contextErr != nil {
		return nil, nil, contextErr
	}
	return rows, columns, nil
}

func execSyncDatabaseContext(ctx context.Context, database db.Database, query string) (int64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if syncDriverContextEnabled(ctx) {
		if contextDatabase, ok := database.(syncExecContexter); ok {
			return contextDatabase.ExecContext(ctx, query)
		}
	}
	affected, err := database.Exec(query)
	if err != nil {
		return affected, err
	}
	if contextErr := ctx.Err(); contextErr != nil {
		return affected, contextErr
	}
	return affected, nil
}

func applySyncChangesContext(ctx context.Context, applier db.BatchApplier, tableName string, changes connection.ChangeSet) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if syncDriverContextEnabled(ctx) {
		if contextApplier, ok := applier.(syncBatchApplyContexter); ok {
			return contextApplier.ApplyChangesContext(ctx, tableName, changes)
		}
	}
	if err := applier.ApplyChanges(tableName, changes); err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return db.MarkWriteOutcomeUnknown(errors.Join(err, contextErr))
		}
		return err
	}
	if err := ctx.Err(); err != nil {
		// A legacy applier cannot observe cancellation while the call is in
		// flight. Its write may already have reached the target.
		return db.MarkWriteOutcomeUnknown(err)
	}
	return nil
}

func executeSyncSQLStatementsContext(ctx context.Context, database db.Database, statements []string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for _, statement := range statements {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := execSyncDatabaseContext(ctx, database, statement); err != nil {
			return fmt.Errorf("执行 SQL 失败：%s: %w", statement, err)
		}
	}
	return nil
}
