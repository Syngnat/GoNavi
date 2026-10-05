package app

import (
	"context"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestDBQueryMultiTransactionalKeepsOracleAnonymousBlockTransactionOpenUntilRollback(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := `BEGIN
    UPDATE users SET name = 'new' WHERE id = 1;
    DELETE FROM audit_logs WHERE user_id = 1;
END;`
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 2,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

	result := app.DBQueryMultiTransactional(config, "ORCLPDB1", stmt, "oracle-anonymous-block-tx-query")
	if !result.Success {
		t.Fatalf("expected Oracle anonymous block transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected Oracle anonymous block to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected Oracle anonymous block transaction session to stay open before rollback")
	}
	if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != stmt {
		t.Fatalf("expected Oracle anonymous block to execute as a single statement before rollback, got %#v", fakeDB.execQueries)
	}

	rollbackResult := app.DBRollbackTransaction(result.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected Oracle anonymous block rollback success, got failure: %s", rollbackResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected Oracle anonymous block transaction session to close after rollback")
	}
	wantExecs := []string{stmt, "ROLLBACK"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected Oracle anonymous block rollback on pinned session, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalOraclePrefersTransactionProviderForFinish(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	for _, tt := range []struct {
		name              string
		finish            func(*App, string) connection.QueryResult
		wantCommitCalls   int
		wantRollbackCalls int
	}{
		{
			name: "commit",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBCommitTransaction(transactionID)
			},
			wantCommitCalls: 1,
		},
		{
			name: "rollback",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBRollbackTransaction(transactionID)
			},
			wantRollbackCalls: 1,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			stmt := "UPDATE users SET name = 'new' WHERE id = 1"
			fakeDB := &fakeTransactionalDB{
				fakeBatchWriteDB: fakeBatchWriteDB{
					execAffected: map[string]int64{
						stmt: 1,
					},
					execErr: map[string]error{
						"COMMIT":   errors.New("oracle commit rows affected unavailable"),
						"ROLLBACK": errors.New("oracle rollback rows affected unavailable"),
					},
				},
			}
			newDatabaseFunc = func(dbType string) (db.Database, error) {
				return fakeDB, nil
			}

			app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

			result := app.DBQueryMultiTransactional(config, "ORCLPDB1", stmt, "oracle-provider-finish-"+tt.name)
			if !result.Success {
				t.Fatalf("expected Oracle transactional query success, got failure: %s", result.Message)
			}
			if result.TransactionID == "" || !result.TransactionPending {
				t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
			}
			if fakeDB.session != nil {
				t.Fatal("expected Oracle to use transaction provider instead of plain session provider")
			}
			if fakeDB.txSession == nil {
				t.Fatal("expected Oracle to open a transaction provider session")
			}

			finishResult := tt.finish(app, result.TransactionID)
			if !finishResult.Success {
				t.Fatalf("expected Oracle transaction %s success through transaction provider, got failure: %s", tt.name, finishResult.Message)
			}
			if fakeDB.txSession.commitCalls != tt.wantCommitCalls {
				t.Fatalf("expected commitCalls=%d, got %d", tt.wantCommitCalls, fakeDB.txSession.commitCalls)
			}
			if fakeDB.txSession.rollbackCalls != tt.wantRollbackCalls {
				t.Fatalf("expected rollbackCalls=%d, got %d", tt.wantRollbackCalls, fakeDB.txSession.rollbackCalls)
			}
			if !fakeDB.txSession.closed {
				t.Fatal("expected transaction provider session to close after finish")
			}
			for _, query := range fakeDB.execQueries {
				if query == "COMMIT" || query == "ROLLBACK" {
					t.Fatalf("expected finish to avoid plain ExecContext(%q), got exec queries %#v", query, fakeDB.execQueries)
				}
			}
		})
	}
}

func TestDBQueryMultiTransactionalUsesOracleImplicitSessionForOceanBaseOracleProtocol(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	stmt := "UPDATE USERS SET NAME = 'new' WHERE ID = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 1,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              "127.0.0.1",
		Port:              2881,
		User:              "app",
		OceanBaseProtocol: "oracle",
	}

	result := app.DBQueryMultiTransactional(config, "APP", stmt, "ob-oracle-tx-query")
	if !result.Success {
		t.Fatalf("expected OceanBase Oracle transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected OceanBase Oracle transactional query to open a pinned Oracle-style session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected OceanBase Oracle transaction session to stay open before commit")
	}
	if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != stmt {
		t.Fatalf("expected OceanBase Oracle to skip START TRANSACTION and execute only DML before commit, got %#v", fakeDB.execQueries)
	}

	commitResult := app.DBCommitTransaction(result.TransactionID)
	if !commitResult.Success {
		t.Fatalf("expected OceanBase Oracle commit success, got failure: %s", commitResult.Message)
	}
	wantExecs := []string{stmt, "COMMIT"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected OceanBase Oracle implicit transaction COMMIT on pinned session, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalOracleImplicitSessionOutlivesAppContextCancellation(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	for _, tt := range []struct {
		name         string
		finish       func(*App, string) connection.QueryResult
		wantFinalSQL string
	}{
		{
			name: "commit",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBCommitTransaction(transactionID)
			},
			wantFinalSQL: "COMMIT",
		},
		{
			name: "rollback",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBRollbackTransaction(transactionID)
			},
			wantFinalSQL: "ROLLBACK",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			stmt := "UPDATE users SET name = 'new' WHERE id = 1"
			fakeDB := &fakeBatchWriteDB{
				execAffected: map[string]int64{
					stmt: 1,
				},
			}
			newDatabaseFunc = func(dbType string) (db.Database, error) {
				return fakeDB, nil
			}

			appCtx, cancelAppCtx := context.WithCancel(context.Background())
			app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			app.ctx = appCtx
			config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

			result := app.DBQueryMultiTransactional(config, "ORCLPDB1", stmt, "oracle-tx-context-"+tt.name)
			if !result.Success {
				t.Fatalf("expected Oracle transactional query success, got failure: %s", result.Message)
			}
			if result.TransactionID == "" || !result.TransactionPending {
				t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
			}

			cancelAppCtx()
			finishResult := tt.finish(app, result.TransactionID)
			if !finishResult.Success {
				t.Fatalf("expected Oracle transaction %s success after app context cancellation, got failure: %s", tt.name, finishResult.Message)
			}
			if fakeDB.session == nil || !fakeDB.session.closed {
				t.Fatal("expected Oracle transaction session to close after finish")
			}
			if len(fakeDB.execQueries) != 2 || fakeDB.execQueries[0] != stmt || fakeDB.execQueries[1] != tt.wantFinalSQL {
				t.Fatalf("expected Oracle implicit transaction to finish with %s, got %#v", tt.wantFinalSQL, fakeDB.execQueries)
			}
		})
	}
}

func TestDBQueryMultiTransactionalRollsBackOracleImplicitSessionOnDMLFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execErr: map[string]error{
			secondStmt: errors.New("delete failed"),
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

	result := app.DBQueryMultiTransactional(config, "ORCLPDB1", firstStmt+";\n"+secondStmt+";", "oracle-tx-failure")
	if result.Success {
		t.Fatal("expected Oracle transactional query failure")
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected failed transaction not to be exposed, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected Oracle transactional query to open a pinned session")
	}
	if !fakeDB.session.closed {
		t.Fatal("expected failed Oracle transaction session to close")
	}
	wantExecs := []string{firstStmt, secondStmt, "ROLLBACK"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected Oracle implicit transaction rollback, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}
