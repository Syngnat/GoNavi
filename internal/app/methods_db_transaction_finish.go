package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// These optional interfaces let context-aware drivers stop a commit/rollback
// when the caller deadline expires. Legacy drivers still use the historical
// no-context TransactionExecer contract.
type managedTransactionContextCommitter interface {
	CommitContext(context.Context) error
}

type managedTransactionContextRollerBacker interface {
	RollbackContext(context.Context) error
}

var managedTransactionFinishTracker = struct {
	sync.Mutex
	next    uint64
	pending map[uint64]chan struct{}
}{
	pending: make(map[uint64]chan struct{}),
}

func registerManagedTransactionFinish() (uint64, func()) {
	tracker := &managedTransactionFinishTracker
	tracker.Lock()
	tracker.next++
	id := tracker.next
	done := make(chan struct{})
	tracker.pending[id] = done
	tracker.Unlock()
	return id, func() {
		tracker.Lock()
		if pending, ok := tracker.pending[id]; ok {
			delete(tracker.pending, id)
			close(pending)
		}
		tracker.Unlock()
	}
}

// waitForManagedTransactionFinishes waits for finalizers that have outlived
// their caller deadline. It deliberately has no timeout: shutdown must not
// close shared database/audit resources while a finalizer can still touch them.
func waitForManagedTransactionFinishes() {
	tracker := &managedTransactionFinishTracker
	for {
		tracker.Lock()
		if len(tracker.pending) == 0 {
			tracker.Unlock()
			return
		}
		pending := make([]chan struct{}, 0, len(tracker.pending))
		for _, done := range tracker.pending {
			pending = append(pending, done)
		}
		tracker.Unlock()
		for _, done := range pending {
			<-done
		}
	}
}

type managedTransactionFinishOutcome struct {
	execErr  error
	closeErr error
}

func (a *App) DBCommitTransaction(transactionID string) connection.QueryResult {
	return a.finishManagedSQLTransactionContext(transactionCleanupContext(a.ctx), transactionID, true, "manual")
}

func (a *App) DBRollbackTransaction(transactionID string) connection.QueryResult {
	return a.finishManagedSQLTransactionContext(transactionCleanupContext(a.ctx), transactionID, false, "manual")
}

func (a *App) DBCommitTransactionWithTrigger(transactionID string, trigger string) connection.QueryResult {
	return a.finishManagedSQLTransactionContext(transactionCleanupContext(a.ctx), transactionID, true, trigger)
}

func (a *App) DBRollbackTransactionWithTrigger(transactionID string, trigger string) connection.QueryResult {
	return a.finishManagedSQLTransactionContext(transactionCleanupContext(a.ctx), transactionID, false, trigger)
}

func (a *App) finishManagedSQLTransactionContext(ctx context.Context, transactionID string, commit bool, trigger string) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	transactionID = strings.TrimSpace(transactionID)
	trigger = normalizeSQLTransactionFinishTrigger(trigger)
	if transactionID == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_id_required", nil)}
	}
	if err := ctx.Err(); err != nil {
		key := "db.backend.error.transaction_rollback_failed"
		if commit {
			key = "db.backend.error.transaction_commit_failed"
		}
		return connection.QueryResult{
			Success: false,
			Message: a.appText(key, map[string]any{"detail": "transaction finish was not attempted: " + err.Error()}),
		}
	}
	_, finish := registerManagedTransactionFinish()
	defer finish()

	a.sqlTransactionMu.Lock()
	tx, ok := a.sqlTransactions[transactionID]
	if ok {
		if err := a.authorizeManagedSQLTransactionAccess(ctx, tx, ""); err != nil {
			a.sqlTransactionMu.Unlock()
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		delete(a.sqlTransactions, transactionID)
	}
	a.sqlTransactionMu.Unlock()
	if !ok || tx == nil || tx.execer == nil {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_not_found", nil)}
	}
	tx.mu.Lock()
	defer tx.mu.Unlock()
	if tx.finished || tx.execer == nil {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_not_found", nil)}
	}
	tx.finished = true

	actionCode := "rollback"
	sqlText := tx.rollbackSQL
	eventType := "transaction_rollback"
	if commit {
		actionCode = "commit"
		sqlText = tx.commitSQL
		eventType = "transaction_commit"
	} else if trigger == "tab_close" || trigger == "auto" {
		eventType = "transaction_auto_rollback"
	}
	auditSource := normalizeSQLAuditSource(tx.auditSource)
	if trigger == "tab_close" {
		auditSource = "tab_close"
	}
	commitMode := "manual"
	if trigger == "auto" {
		commitMode = "auto"
	}

	requestedEventType := "transaction_rollback_requested"
	if commit {
		requestedEventType = "transaction_commit_requested"
	}
	a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
		Config:        tx.config,
		Database:      tx.config.Database,
		DBType:        tx.dbType,
		TransactionID: transactionID,
		RunID:         tx.auditRunID,
		Actor:         tx.auditActor,
		EventType:     requestedEventType,
		Status:        "success",
		Source:        auditSource,
		CommitMode:    commitMode,
		BoundaryMode:  tx.boundaryMode,
	})
	startedAt := time.Now()

	finishCtx, cancelFinish := context.WithTimeout(ctx, sqlEditorTransactionFinishTimeout)
	outcome, timedOut := a.runManagedTransactionFinish(finishCtx, tx, commit, sqlText)
	cancelFinish()
	if timedOut {
		execErr := errors.New("transaction finish did not complete before the deadline; outcome is unknown")
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: transactionID,
			RunID:         tx.auditRunID,
			Actor:         tx.auditActor,
			EventType:     eventType,
			Status:        "error",
			Source:        auditSource,
			CommitMode:    commitMode,
			BoundaryMode:  tx.boundaryMode,
			Duration:      time.Since(startedAt),
			Err:           execErr,
		})
		logger.Error(execErr, "SQL 编辑器事务%s超时：id=%s dbType=%s", actionCode, transactionID, tx.dbType)
		key := "db.backend.error.transaction_rollback_failed"
		if commit {
			key = "db.backend.error.transaction_commit_failed"
		}
		return connection.QueryResult{
			Success:        false,
			Message:        a.appText(key, map[string]any{"detail": execErr.Error()}),
			OutcomeUnknown: true,
		}
	}
	execErr := outcome.execErr
	closeErr := outcome.closeErr
	if execErr != nil {
		if closeErr != nil {
			execErr = errors.Join(execErr, closeErr)
		}
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: transactionID,
			RunID:         tx.auditRunID,
			Actor:         tx.auditActor,
			EventType:     eventType,
			Status:        "error",
			Source:        auditSource,
			CommitMode:    commitMode,
			BoundaryMode:  tx.boundaryMode,
			Duration:      time.Since(startedAt),
			Err:           execErr,
		})
		logger.Error(execErr, "SQL 编辑器事务%s失败：id=%s dbType=%s", actionCode, transactionID, tx.dbType)
		key := "db.backend.error.transaction_rollback_failed"
		if commit {
			key = "db.backend.error.transaction_commit_failed"
		}
		return connection.QueryResult{
			Success:        false,
			Message:        a.appText(key, map[string]any{"detail": execErr.Error()}),
			OutcomeUnknown: true,
		}
	}
	if closeErr != nil {
		// Commit/Rollback has already succeeded at the database boundary. Record that
		// outcome as success while retaining the local session cleanup error.
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: transactionID,
			RunID:         tx.auditRunID,
			Actor:         tx.auditActor,
			EventType:     eventType,
			Status:        "success",
			Source:        auditSource,
			CommitMode:    commitMode,
			BoundaryMode:  tx.boundaryMode,
			Duration:      time.Since(startedAt),
			Err:           closeErr,
		})
		logger.Error(closeErr, "SQL 编辑器事务%s后关闭会话失败：id=%s dbType=%s", actionCode, transactionID, tx.dbType)
		key := "db.backend.error.transaction_rollback_close_failed"
		if commit {
			key = "db.backend.error.transaction_commit_close_failed"
		}
		return connection.QueryResult{Success: false, Message: a.appText(key, map[string]any{"detail": closeErr.Error()})}
	}
	a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
		Config:        tx.config,
		Database:      tx.config.Database,
		DBType:        tx.dbType,
		TransactionID: transactionID,
		RunID:         tx.auditRunID,
		Actor:         tx.auditActor,
		EventType:     eventType,
		Status:        "success",
		Source:        auditSource,
		CommitMode:    commitMode,
		BoundaryMode:  tx.boundaryMode,
		Duration:      time.Since(startedAt),
	})

	if commit {
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.transaction_committed", nil)}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.transaction_rolled_back", nil)}
}

func (a *App) runManagedTransactionFinish(
	ctx context.Context,
	tx *managedSQLTransaction,
	commit bool,
	sqlText string,
) (managedTransactionFinishOutcome, bool) {
	if tx == nil {
		return managedTransactionFinishOutcome{execErr: errors.New("managed transaction is unavailable")}, false
	}
	if err := ctx.Err(); err != nil {
		outcome := managedTransactionFinishOutcome{execErr: err}
		if tx.execer != nil {
			outcome.closeErr = tx.execer.Close()
		}
		if tx.cancel != nil {
			tx.cancel()
		}
		return outcome, false
	}
	resultCh := make(chan managedTransactionFinishOutcome, 1)
	_, finish := registerManagedTransactionFinish()
	go func() {
		defer finish()
		outcome := managedTransactionFinishOutcome{}
		switch {
		case tx.transactor != nil && commit:
			if finisher, ok := tx.transactor.(managedTransactionContextCommitter); ok {
				outcome.execErr = finisher.CommitContext(ctx)
			} else {
				outcome.execErr = tx.transactor.Commit()
			}
		case tx.transactor != nil:
			if finisher, ok := tx.transactor.(managedTransactionContextRollerBacker); ok {
				outcome.execErr = finisher.RollbackContext(ctx)
			} else {
				outcome.execErr = tx.transactor.Rollback()
			}
		case strings.TrimSpace(sqlText) != "":
			_, outcome.execErr = tx.execer.ExecContext(ctx, sqlText)
		}
		if tx.execer != nil {
			outcome.closeErr = tx.execer.Close()
		}
		if tx.cancel != nil {
			tx.cancel()
		}
		resultCh <- outcome
	}()
	select {
	case outcome := <-resultCh:
		return outcome, false
	case <-ctx.Done():
		return managedTransactionFinishOutcome{}, true
	}
}

func normalizeSQLTransactionFinishTrigger(trigger string) string {
	switch strings.ToLower(strings.TrimSpace(trigger)) {
	case "auto", "tab_close":
		return strings.ToLower(strings.TrimSpace(trigger))
	default:
		return "manual"
	}
}

func (a *App) rollbackPendingSQLTransactionsOnShutdown() {
	// Finalizers that already outlived a caller deadline still own their
	// sessions. Wait for them before enumerating and closing the remaining
	// transactions so shutdown never closes a session underneath them.
	waitForManagedTransactionFinishes()
	a.rollbackAllPendingSQLTransactions("app_shutdown", "关闭应用时")
}

// rollbackAbandonedSQLTransactionsOnReload 回滚前端重载后已无法再被引用的托管事务。
//
// SQL 编辑器的待提交事务 ID 只存在于 React 组件内存（useSqlEditorTransactionController 的
// useState/useRef），持久化状态里只有 commitMode/autoCommitDelayMs 这类设置。
// 因此前端一旦重载，残留在 a.sqlTransactions 中的条目必然是不可能再被提交或回滚的孤儿：
// 它们会一直占着 pinned 连接与数据库行锁，直到应用退出。
//
// 实测后果：执行 DELETE 进入托管事务后不点提交、直接刷新，再执行同一条 DELETE 就会卡满
// innodb_lock_wait_timeout（默认 50 秒）并报 Error 1205 Lock wait timeout exceeded，
// 只能重启应用才能恢复。
func (a *App) rollbackAbandonedSQLTransactionsOnReload() {
	a.rollbackAllPendingSQLTransactions("frontend_reload", "前端重载后")
}

func (a *App) rollbackAllPendingSQLTransactions(auditSource string, logPrefix string) {
	a.rollbackPendingSQLTransactionsMatching(nil, auditSource, logPrefix)
}

func (a *App) rollbackPendingSQLTransactionsForDriverType(driverType string, auditSource string, logPrefix string) int {
	normalized := normalizeDriverType(driverType)
	if normalized == "" {
		return 0
	}
	return a.rollbackPendingSQLTransactionsMatching(func(tx *managedSQLTransaction) bool {
		if tx == nil {
			return false
		}
		return optionalDriverTypeForConnectionConfig(tx.config) == normalized || normalizeDriverType(tx.dbType) == normalized
	}, auditSource, logPrefix)
}

func (a *App) rollbackPendingSQLTransactionsMatching(match func(*managedSQLTransaction) bool, auditSource string, logPrefix string) int {
	a.sqlTransactionMu.Lock()
	pending := make([]*managedSQLTransaction, 0, len(a.sqlTransactions))
	for id, tx := range a.sqlTransactions {
		if tx == nil {
			delete(a.sqlTransactions, id)
			continue
		}
		if match != nil && !match(tx) {
			continue
		}
		pending = append(pending, tx)
		delete(a.sqlTransactions, id)
	}
	a.sqlTransactionMu.Unlock()

	for _, tx := range pending {
		tx.mu.Lock()
		if tx.finished {
			tx.mu.Unlock()
			continue
		}
		tx.finished = true
		ctx, cancel := context.WithTimeout(context.Background(), sqlEditorTransactionFinishTimeout)
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: tx.id,
			RunID:         tx.auditRunID,
			Actor:         tx.auditActor,
			EventType:     "transaction_rollback_requested",
			Status:        "success",
			Source:        auditSource,
			CommitMode:    "auto",
			BoundaryMode:  tx.boundaryMode,
		})
		startedAt := time.Now()
		var rollbackErr error
		if tx.transactor != nil {
			if finisher, ok := tx.transactor.(managedTransactionContextRollerBacker); ok {
				if err := finisher.RollbackContext(ctx); err != nil {
					rollbackErr = err
					logger.Warnf("%s回滚 SQL 编辑器事务失败：id=%s dbType=%s err=%v", logPrefix, tx.id, tx.dbType, err)
				}
			} else if err := tx.transactor.Rollback(); err != nil {
				rollbackErr = err
				logger.Warnf("%s回滚 SQL 编辑器事务失败：id=%s dbType=%s err=%v", logPrefix, tx.id, tx.dbType, err)
			}
		} else if strings.TrimSpace(tx.rollbackSQL) != "" && tx.execer != nil {
			if _, err := tx.execer.ExecContext(ctx, tx.rollbackSQL); err != nil {
				rollbackErr = err
				logger.Warnf("%s回滚 SQL 编辑器事务失败：id=%s dbType=%s err=%v", logPrefix, tx.id, tx.dbType, err)
			}
		}
		cancel()
		if tx.cancel != nil {
			tx.cancel()
		}
		var closeErr error
		if tx.execer != nil {
			if err := tx.execer.Close(); err != nil {
				closeErr = err
				logger.Warnf("%s关闭 SQL 编辑器事务会话失败：id=%s dbType=%s err=%v", logPrefix, tx.id, tx.dbType, err)
			}
		}
		auditErr := rollbackErr
		status := sqlAuditStatusFromError(rollbackErr)
		if auditErr == nil && closeErr != nil {
			// The database rollback succeeded; retain only the cleanup warning.
			auditErr = closeErr
		}
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: tx.id,
			RunID:         tx.auditRunID,
			Actor:         tx.auditActor,
			EventType:     "transaction_auto_rollback",
			Status:        status,
			Source:        auditSource,
			CommitMode:    "auto",
			BoundaryMode:  tx.boundaryMode,
			Duration:      time.Since(startedAt),
			Err:           auditErr,
		})
		tx.mu.Unlock()
	}
	return len(pending)
}
