package app

import (
	"testing"

	"GoNavi-Wails/internal/secretstore"
)

// TestHandleFrontendDomReadyRollsBackAbandonedTransactions 覆盖前端刷新导致的托管事务泄漏。
//
// 回归背景：SQL 编辑器待提交事务的 ID 只存在于前端组件内存
// （useSqlEditorTransactionController 的 useState/useRef），持久化状态里只有
// commitMode/autoCommitDelayMs 这类设置。因此前端一旦刷新，残留在 a.sqlTransactions 中的
// 条目就再也无法被提交或回滚，却仍开着并持有数据库行锁，直到应用退出。
//
// 实测复现：执行 DELETE 进入托管事务后不点提交、直接刷新前端，再执行同一条 DELETE，
// 会卡满 innodb_lock_wait_timeout（默认 50 秒）并报
// Error 1205 (HY000): Lock wait timeout exceeded，只能重启应用恢复。
//
// 修复后由 Wails 的 OnDomReady（每次导航完成，含刷新）触发回滚。
func TestHandleFrontendDomReadyRollsBackAbandonedTransactions(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	finisher := &fakeManagedTransactionFinisher{}
	app.sqlTransactions["tx-abandoned"] = &managedSQLTransaction{
		id:         "tx-abandoned",
		execer:     finisher,
		transactor: finisher,
		dbType:     "mysql",
	}

	HandleFrontendDomReady(app)

	if finisher.rollbackCalls != 1 {
		t.Fatalf("期望回滚 1 次，实际 %d 次（刷新后事务仍持有行锁）", finisher.rollbackCalls)
	}
	if finisher.closeCalls != 1 {
		t.Errorf("期望关闭会话 1 次，实际 %d 次（pinned 连接未释放）", finisher.closeCalls)
	}

	app.sqlTransactionMu.Lock()
	remaining := len(app.sqlTransactions)
	app.sqlTransactionMu.Unlock()
	if remaining != 0 {
		t.Errorf("回滚后事务表仍有 %d 条残留", remaining)
	}
}

// TestHandleFrontendDomReadyIsNoOpWithoutPendingTransactions 首次加载时事务表为空，
// 本调用必须无副作用（OnDomReady 在初次导航时也会触发）。
func TestHandleFrontendDomReadyIsNoOpWithoutPendingTransactions(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	HandleFrontendDomReady(app)

	app.sqlTransactionMu.Lock()
	remaining := len(app.sqlTransactions)
	app.sqlTransactionMu.Unlock()
	if remaining != 0 {
		t.Fatalf("空事务表被意外写入 %d 条", remaining)
	}
}

// TestHandleFrontendDomReadyToleratesNilApp 防御 nil，避免钩子在初始化竞态下 panic。
func TestHandleFrontendDomReadyToleratesNilApp(t *testing.T) {
	HandleFrontendDomReady(nil)
}

// TestHandleFrontendDomReadySkipsAlreadyFinishedTransactions 已完成的事务不得重复回滚。
func TestHandleFrontendDomReadySkipsAlreadyFinishedTransactions(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()

	finisher := &fakeManagedTransactionFinisher{}
	app.sqlTransactions["tx-finished"] = &managedSQLTransaction{
		id:         "tx-finished",
		execer:     finisher,
		transactor: finisher,
		dbType:     "mysql",
		finished:   true,
	}

	HandleFrontendDomReady(app)

	if finisher.rollbackCalls != 0 {
		t.Fatalf("已完成的事务被重复回滚 %d 次", finisher.rollbackCalls)
	}
}
