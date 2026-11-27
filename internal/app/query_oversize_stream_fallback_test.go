package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

type oversizeFallbackDB struct {
	*fakeBatchWriteDB
	supportMulti            bool
	supportSession          bool
	supportTx               bool
	streamColumns           []string
	streamRows              [][]interface{}
	streamErr               error
	streamErrByQuery        map[string]error
	dbStreamCalls           int
	dbStreamQueries         []string
	multiCalls              int
	multiErrByQuery         map[string]error
	readOnlyQueryErr        error
	readOnlyCalls           int
	session                 *oversizeFallbackSession
	txSession               *oversizeFallbackTxSession
	lastQueryArgsQuery      string
	lastQueryArgs           []any
	queryArgsErr            error
	execArgsAffected        int64
	execArgsErr             error
	sessionQueryCallsBefore int
}

func (f *oversizeFallbackDB) OpenSessionExecer(ctx context.Context) (db.StatementExecer, error) {
	if !f.supportSession {
		return nil, errors.New("session not supported")
	}
	f.session = &oversizeFallbackSession{parent: f}
	return f.session, nil
}

func (f *oversizeFallbackDB) OpenTransactionExecer(ctx context.Context) (db.TransactionExecer, error) {
	if !f.supportTx {
		return nil, errors.New("tx not supported")
	}
	f.txSession = &oversizeFallbackTxSession{
		oversizeFallbackSession: oversizeFallbackSession{parent: f},
	}
	return f.txSession, nil
}

func (f *oversizeFallbackDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *oversizeFallbackDB) StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.dbStreamCalls++
	f.dbStreamQueries = append(f.dbStreamQueries, query)
	return f.emitStream(ctx, query, consumer)
}

func (f *oversizeFallbackDB) emitStream(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := f.streamErrByQuery[query]; err != nil {
		return err
	}
	if f.streamErr != nil {
		return f.streamErr
	}
	if err := consumer.SetColumns(f.streamColumns); err != nil {
		return err
	}
	if valueConsumer, ok := consumer.(db.QueryStreamValueConsumer); ok {
		for _, values := range f.streamRows {
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
		}
		return nil
	}
	for _, values := range f.streamRows {
		row := make(map[string]interface{}, len(f.streamColumns))
		for idx, col := range f.streamColumns {
			if idx < len(values) {
				row[col] = values[idx]
			}
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func (f *oversizeFallbackDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	results, _, err := f.QueryMultiWithMessages(query)
	return results, err
}

func (f *oversizeFallbackDB) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	return f.QueryMultiContextWithMessages(context.Background(), query)
}

func (f *oversizeFallbackDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	results, _, err := f.QueryMultiContextWithMessages(ctx, query)
	return results, err
}

func (f *oversizeFallbackDB) QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error) {
	f.multiCalls++
	if !f.supportMulti {
		return nil, nil, nil
	}
	if err := f.multiErrByQuery[query]; err != nil {
		return nil, nil, err
	}
	if err := f.queryErr[query]; err != nil {
		return nil, nil, err
	}
	rows, cols, messages, err := f.QueryContextWithMessages(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	return []connection.ResultSetData{{Rows: rows, Columns: cols, Messages: messages}}, messages, nil
}

func (f *oversizeFallbackDB) QueryReadOnlyContext(_ context.Context, _ string) ([]map[string]interface{}, []string, error) {
	f.readOnlyCalls++
	if f.readOnlyQueryErr != nil {
		return nil, nil, f.readOnlyQueryErr
	}
	return nil, nil, nil
}

func (f *oversizeFallbackDB) QueryContextWithArgs(_ context.Context, query string, args []any) ([]map[string]interface{}, []string, error) {
	f.lastQueryArgsQuery = query
	f.lastQueryArgs = append([]any(nil), args...)
	if f.queryArgsErr != nil {
		return nil, nil, f.queryArgsErr
	}
	return nil, nil, nil
}

func (f *oversizeFallbackDB) ExecContextWithArgs(_ context.Context, _ string, _ []any) (int64, error) {
	return f.execArgsAffected, f.execArgsErr
}

type oversizeFallbackSession struct {
	parent        *oversizeFallbackDB
	queryCalls    int
	streamCalls   int
	execCalls     int
	closed        bool
	streamQueries []string
}

func (s *oversizeFallbackSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return s.QueryContext(context.Background(), query)
}

func (s *oversizeFallbackSession) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	s.queryCalls++
	return s.parent.QueryContext(ctx, query)
}

func (s *oversizeFallbackSession) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return s.QueryContextWithMessages(context.Background(), query)
}

func (s *oversizeFallbackSession) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	s.queryCalls++
	return s.parent.QueryContextWithMessages(ctx, query)
}

func (s *oversizeFallbackSession) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return s.StreamQueryContext(context.Background(), query, consumer)
}

func (s *oversizeFallbackSession) StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	s.streamCalls++
	s.streamQueries = append(s.streamQueries, query)
	return s.parent.emitStream(ctx, query, consumer)
}

func (s *oversizeFallbackSession) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *oversizeFallbackSession) ExecContext(ctx context.Context, query string) (int64, error) {
	s.execCalls++
	return s.parent.ExecContext(ctx, query)
}

func (s *oversizeFallbackSession) Close() error {
	s.closed = true
	return nil
}

type oversizeFallbackTxSession struct {
	oversizeFallbackSession
	committed  bool
	rolledBack bool
}

func (tx *oversizeFallbackTxSession) Commit() error {
	tx.committed = true
	return nil
}

func (tx *oversizeFallbackTxSession) Rollback() error {
	tx.rolledBack = true
	return nil
}

func (tx *oversizeFallbackTxSession) QueryContextWithArgs(ctx context.Context, query string, args []any) ([]map[string]interface{}, []string, error) {
	return tx.parent.QueryContextWithArgs(ctx, query, args)
}

func (tx *oversizeFallbackTxSession) ExecContextWithArgs(ctx context.Context, query string, args []any) (int64, error) {
	return tx.parent.ExecContextWithArgs(ctx, query, args)
}

func setupOversizeFallbackApp(t *testing.T, fakeDB db.Database, lang i18n.Language) *App {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(lang))
	return app
}

func TestDBQueryMultiWithOptionsOversizeFallsBackToSessionStreamQuery(t *testing.T) {
	query := `SELECT * FROM "MD_ORG_NB2024" AS mon`
	t.Run("uses session StreamQueryContext when session is open and obeys budget", func(t *testing.T) {
		fakeDB := &oversizeFallbackDB{
			supportSession: true,
			fakeBatchWriteDB: &fakeBatchWriteDB{
				queryErr: map[string]error{
					query: db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
			},
			streamColumns: []string{"ID", "ORG_NAME"},
			streamRows: [][]interface{}{
				{int64(1), "Org A"},
				{int64(2), "Org B"},
				{int64(3), "Org C"},
			},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryMultiWithOptions(
			connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
			"SYSDBA",
			query,
			"oversize-session-read",
			QueryResultBudgetOptions{MaxRowsPerResult: 2},
		)
		if !res.Success {
			t.Fatalf("expected DBQueryMultiWithOptions to recover via streamQuery, got failure: %+v", res)
		}
		resultSets, ok := res.Data.([]connection.ResultSetData)
		if !ok || len(resultSets) != 1 {
			t.Fatalf("unexpected Data = %#v", res.Data)
		}
		if len(resultSets[0].Rows) != 2 || !resultSets[0].Truncated {
			t.Fatalf("resultSets[0] = rows:%d truncated:%t, want 2 rows + truncated", len(resultSets[0].Rows), resultSets[0].Truncated)
		}
		if fakeDB.session == nil || fakeDB.session.streamCalls != 1 {
			t.Fatalf("expected pinned session StreamQueryContext call count = 1, got %+v", fakeDB.session)
		}
		if fakeDB.dbStreamCalls != 0 {
			t.Fatalf("must not bypass pinned session to call dbInst.StreamQueryContext, got %d", fakeDB.dbStreamCalls)
		}
	})

	t.Run("falls back to db StreamQueryContext when session is unavailable", func(t *testing.T) {
		fakeDB := &oversizeFallbackDB{
			supportSession: false,
			fakeBatchWriteDB: &fakeBatchWriteDB{
				queryErr: map[string]error{
					query: db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
			},
			streamColumns: []string{"ID", "ORG_NAME"},
			streamRows: [][]interface{}{
				{int64(10), "Org X"},
			},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryMultiWithOptions(
			connection.ConnectionConfig{Type: "kingbase", Host: "127.0.0.1", Port: 54321},
			"public",
			query,
			"oversize-db-read",
			QueryResultBudgetOptions{MaxRowsPerResult: 100},
		)
		if !res.Success {
			t.Fatalf("expected DBQueryMultiWithOptions to recover via db StreamQueryContext, got failure: %+v", res)
		}
		resultSets, ok := res.Data.([]connection.ResultSetData)
		if !ok || len(resultSets) != 1 || len(resultSets[0].Rows) != 1 {
			t.Fatalf("unexpected resultSets = %#v", res.Data)
		}
		if fakeDB.dbStreamCalls != 1 {
			t.Fatalf("dbStreamCalls = %d, want 1", fakeDB.dbStreamCalls)
		}
	})
}

func TestDBQueryMultiWithOptionsNativeMultiReadOversizeFallback(t *testing.T) {
	t.Run("single read statement recovers directly via StreamQueryContext", func(t *testing.T) {
		query := "SELECT id FROM big_orders"
		fakeDB := &oversizeFallbackDB{
			supportMulti: true,
			fakeBatchWriteDB: &fakeBatchWriteDB{
				queryErr: map[string]error{
					query: db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
			},
			streamColumns: []string{"id"},
			streamRows:    [][]interface{}{{int64(1)}, {int64(2)}},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryMultiWithOptions(
			connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433},
			"app",
			query,
			"oversize-native-single",
			QueryResultBudgetOptions{MaxRowsPerResult: 10},
		)
		if !res.Success {
			t.Fatalf("expected native single read oversize to recover, got %+v", res)
		}
		resultSets, ok := res.Data.([]connection.ResultSetData)
		if !ok || len(resultSets) != 1 || len(resultSets[0].Rows) != 2 {
			t.Fatalf("unexpected resultSets = %#v", res.Data)
		}
		if fakeDB.multiCalls != 1 || fakeDB.dbStreamCalls != 1 {
			t.Fatalf("multiCalls=%d dbStreamCalls=%d, want 1 and 1", fakeDB.multiCalls, fakeDB.dbStreamCalls)
		}
	})

	t.Run("multi-statement read batch falls back to sequential and streams oversized statement", func(t *testing.T) {
		batch := "SELECT id FROM big_orders; SELECT id FROM small_orders"
		fakeDB := &oversizeFallbackDB{
			supportMulti:   true,
			supportSession: true,
			fakeBatchWriteDB: &fakeBatchWriteDB{
				queryErr: map[string]error{
					"SELECT id FROM big_orders": db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
				queryMap: map[string][]map[string]interface{}{
					"SELECT id FROM small_orders": {{"id": int64(99)}},
				},
				fieldMap: map[string][]string{
					"SELECT id FROM small_orders": {"id"},
				},
			},
			multiErrByQuery: map[string]error{
				batch: db.ErrOptionalDriverAgentJSONLineTooLarge,
			},
			streamColumns: []string{"id"},
			streamRows:    [][]interface{}{{int64(1)}},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryMultiWithOptions(
			connection.ConnectionConfig{Type: "mariadb", Host: "127.0.0.1", Port: 3306},
			"app",
			batch,
			"oversize-native-multi",
			QueryResultBudgetOptions{MaxRowsPerResult: 10},
		)
		if !res.Success {
			t.Fatalf("expected native multi-statement read fallback to succeed, got %+v", res)
		}
		resultSets, ok := res.Data.([]connection.ResultSetData)
		if !ok || len(resultSets) != 2 {
			t.Fatalf("resultSets = %#v, want 2 result sets", res.Data)
		}
		if resultSets[0].Rows[0]["id"] != int64(1) || resultSets[1].Rows[0]["id"] != int64(99) {
			t.Fatalf("unexpected resultSets rows = %#v", resultSets)
		}
		if fakeDB.session == nil || fakeDB.session.streamCalls != 1 {
			t.Fatalf("expected 1 stream call for first statement, got %+v", fakeDB.session)
		}
	})
}

func TestDBQueryWithCancelOversizeReadFallsBackToStreamAndPluginDoesNot(t *testing.T) {
	query := `SELECT * FROM "MD_ORG_NB2024"`
	t.Run("ordinary DBQueryWithCancel read recovers via streamQuery", func(t *testing.T) {
		fakeDB := &oversizeFallbackDB{
			fakeBatchWriteDB: &fakeBatchWriteDB{
				queryErr: map[string]error{
					query: db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
			},
			streamColumns: []string{"id"},
			streamRows:    [][]interface{}{{int64(7)}},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryWithCancel(
			connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
			"SYSDBA",
			query,
			"dbquery-oversize-read",
		)
		if !res.Success {
			t.Fatalf("expected DBQueryWithCancel to recover via streamQuery, got %+v", res)
		}
		rows, ok := res.Data.([]map[string]interface{})
		if !ok || len(rows) != 1 || rows[0]["id"] != int64(7) {
			t.Fatalf("unexpected DBQueryWithCancel Data = %#v", res.Data)
		}
		if fakeDB.dbStreamCalls != 1 {
			t.Fatalf("dbStreamCalls = %d, want 1", fakeDB.dbStreamCalls)
		}
	})

	t.Run("plugin read-only query must not bypass read-only tx with stream fallback", func(t *testing.T) {
		fakeDB := &oversizeFallbackDB{
			fakeBatchWriteDB: &fakeBatchWriteDB{},
			readOnlyQueryErr: db.ErrOptionalDriverAgentJSONLineTooLarge,
			streamColumns:    []string{"id"},
			streamRows:       [][]interface{}{{int64(7)}},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageEnUS)

		res := app.dbQueryWithCancel(
			connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
			"SYSDBA",
			query,
			"plugin-oversize-read",
			dbQueryAuditOptions{
				source: pluginPageQueryAuditSource,
			},
		)
		if res.Success {
			t.Fatalf("plugin query must fail instead of falling back outside read-only tx: %+v", res)
		}
		if fakeDB.readOnlyCalls != 1 || fakeDB.dbStreamCalls != 0 {
			t.Fatalf("readOnlyCalls=%d dbStreamCalls=%d, want 1 and 0", fakeDB.readOnlyCalls, fakeDB.dbStreamCalls)
		}
		if !strings.Contains(res.Message, "Driver Manager") || !strings.Contains(res.Message, "32 MiB") {
			t.Fatalf("expected localized Driver Manager upgrade guidance, got %q", res.Message)
		}
	})
}

func TestManagedTransactionOversizeReadFallsBackToSessionStream(t *testing.T) {
	t.Run("unparameterized read statement in managed tx recovers via tx session StreamQueryContext", func(t *testing.T) {
		writeStmt := "INSERT INTO audit_log(note) VALUES ('begin')"
		readStmt := `SELECT * FROM "MD_ORG_NB2024"`
		fakeDB := &oversizeFallbackDB{
			supportTx: true,
			fakeBatchWriteDB: &fakeBatchWriteDB{
				execAffected: map[string]int64{writeStmt: 1},
				queryErr: map[string]error{
					readStmt: db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
			},
			streamColumns: []string{"id"},
			streamRows:    [][]interface{}{{int64(42)}},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryMultiTransactionalWithOptions(
			connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
			"SYSDBA",
			writeStmt+"; "+readStmt,
			"tx-oversize-read",
			QueryResultBudgetOptions{MaxRowsPerResult: 50},
		)
		if !res.Success || !res.TransactionPending {
			t.Fatalf("expected managed tx to recover read oversize without rollback, got %+v", res)
		}
		resultSets, ok := res.Data.([]connection.ResultSetData)
		if !ok || len(resultSets) != 2 || resultSets[1].Rows[0]["id"] != int64(42) {
			t.Fatalf("unexpected tx resultSets = %#v", res.Data)
		}
		if fakeDB.txSession == nil || fakeDB.txSession.streamCalls != 1 || fakeDB.dbStreamCalls != 0 {
			t.Fatalf("expected txSession.streamCalls=1 dbStreamCalls=0, got tx=%+v db=%d", fakeDB.txSession, fakeDB.dbStreamCalls)
		}
		if fakeDB.txSession.rolledBack {
			t.Fatal("transaction should stay pending, not roll back")
		}
	})

	t.Run("parameterized read statement in managed tx must not strip args via StreamQueryContext", func(t *testing.T) {
		fakeDB := &oversizeFallbackDB{
			supportTx:        true,
			fakeBatchWriteDB: &fakeBatchWriteDB{},
			queryArgsErr:     db.ErrOptionalDriverAgentJSONLineTooLarge,
			streamColumns:    []string{"id"},
			streamRows:       [][]interface{}{{int64(1)}},
		}
		session := &oversizeFallbackTxSession{
			oversizeFallbackSession: oversizeFallbackSession{parent: fakeDB},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageEnUS)

		_, err := executeManagedSQLTransactionStatementsWithObserver(
			context.Background(),
			session,
			connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
			[]string{"SELECT * FROM items WHERE id = :id"},
			app.appText,
			nil,
			managedTransactionStatementOptions{
				ExecutableTexts: []string{"SELECT * FROM items WHERE id = ?"},
				ArgsByStatement: [][]any{{1}},
			},
		)
		if err == nil {
			t.Fatal("expected parameterized query oversize error")
		}
		if session.streamCalls != 0 {
			t.Fatalf("parameterized query must not fall back to StreamQueryContext, got %d calls", session.streamCalls)
		}
		if !strings.Contains(err.Error(), "Driver Manager") || !strings.Contains(err.Error(), "Statement 1 failed") {
			t.Fatalf("expected localized statement error with upgrade hint, got %q", err.Error())
		}
	})
}

func TestDBQueryIsolatedOversizeReadFallsBackToStream(t *testing.T) {
	query := `SELECT * FROM "MD_ORG_NB2024"`
	fakeDB := &oversizeFallbackDB{
		fakeBatchWriteDB: &fakeBatchWriteDB{
			queryErr: map[string]error{
				query: db.ErrOptionalDriverAgentJSONLineTooLarge,
			},
		},
		streamColumns: []string{"id"},
		streamRows:    [][]interface{}{{int64(5)}},
	}
	app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

	res := app.DBQueryIsolated(
		connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
		"SYSDBA",
		query,
	)
	if !res.Success {
		t.Fatalf("expected DBQueryIsolated to recover via StreamQueryContext, got %+v", res)
	}
	rows, ok := res.Data.([]map[string]interface{})
	if !ok || len(rows) != 1 || rows[0]["id"] != int64(5) {
		t.Fatalf("unexpected isolated query rows = %#v", res.Data)
	}
	if fakeDB.dbStreamCalls != 1 {
		t.Fatalf("dbStreamCalls = %d, want 1", fakeDB.dbStreamCalls)
	}
}

func TestOversizeErrorNotRecoveredShowsLocalizedUpgradeHint(t *testing.T) {
	t.Run("query-first write must never replay via stream fallback", func(t *testing.T) {
		writeSQL := "INSERT INTO items(name) VALUES ('a') OUTPUT INSERTED.id"
		fakeDB := &oversizeFallbackDB{
			supportMulti: true,
			fakeBatchWriteDB: &fakeBatchWriteDB{
				queryErr: map[string]error{
					writeSQL: db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
			},
			streamColumns: []string{"id"},
			streamRows:    [][]interface{}{{int64(1)}},
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryMultiWithOptions(
			connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433},
			"app",
			writeSQL,
			"query-first-write-oversize",
			QueryResultBudgetOptions{MaxRowsPerResult: 10},
		)
		if res.Success {
			t.Fatalf("query-first write must fail instead of streaming again: %+v", res)
		}
		if fakeDB.session != nil && fakeDB.session.streamCalls != 0 {
			t.Fatalf("query-first write replayed streamCalls=%d", fakeDB.session.streamCalls)
		}
		if fakeDB.dbStreamCalls != 0 {
			t.Fatalf("query-first write called dbStreamCalls=%d", fakeDB.dbStreamCalls)
		}
		if !strings.Contains(res.Message, "驱动管理") || !strings.Contains(res.Message, "SQL Server") {
			t.Fatalf("expected SQL Server + 驱动管理 hint in message, got %q", res.Message)
		}
	})

	t.Run("single oversized row even in streamQuery returns actionable upgrade hint", func(t *testing.T) {
		query := `SELECT big_blob FROM "MD_ORG_NB2024"`
		fakeDB := &oversizeFallbackDB{
			supportSession: true,
			fakeBatchWriteDB: &fakeBatchWriteDB{
				queryErr: map[string]error{
					query: db.ErrOptionalDriverAgentJSONLineTooLarge,
				},
			},
			streamErr: db.ErrOptionalDriverAgentJSONLineTooLarge,
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageEnUS)

		res := app.DBQueryMultiWithOptions(
			connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
			"SYSDBA",
			query,
			"single-row-oversize",
			QueryResultBudgetOptions{MaxRowsPerResult: 10},
		)
		if res.Success {
			t.Fatalf("expected failure when even streamQuery hits single-row 32 MiB limit")
		}
		if fakeDB.session == nil || fakeDB.session.streamCalls != 1 {
			t.Fatalf("expected 1 stream attempt before failing, got %+v", fakeDB.session)
		}
		if !strings.Contains(res.Message, "Statement 1 failed:") ||
			!strings.Contains(res.Message, "Driver Manager") ||
			!strings.Contains(res.Message, "Dameng") ||
			!strings.Contains(res.Message, db.ErrOptionalDriverAgentJSONLineTooLarge.Error()) {
			t.Fatalf("unexpected error message = %q", res.Message)
		}
	})

	t.Run("parameterized DBQueryMultiWithParams formats upgrade hint without fallback", func(t *testing.T) {
		fakeDB := &oversizeFallbackDB{
			fakeBatchWriteDB: &fakeBatchWriteDB{},
			queryArgsErr:     fmt.Errorf("wrapped: %w", db.ErrOptionalDriverAgentJSONLineTooLarge),
		}
		app := setupOversizeFallbackApp(t, fakeDB, i18n.LanguageZhCN)

		res := app.DBQueryMultiWithParams(
			connection.ConnectionConfig{Type: "dameng", Host: "127.0.0.1", Port: 5236},
			"SYSDBA",
			"SELECT * FROM items WHERE id = :id",
			"params-oversize",
			[]connection.QueryParamBinding{{Name: "id", Type: "number", Value: "1"}},
			false,
		)
		if res.Success {
			t.Fatalf("expected params query to fail cleanly")
		}
		if fakeDB.dbStreamCalls != 0 {
			t.Fatalf("parameterized query must not call StreamQueryContext, got %d", fakeDB.dbStreamCalls)
		}
		if !strings.Contains(res.Message, "驱动管理") || !strings.Contains(res.Message, "Dameng") {
			t.Fatalf("expected upgrade hint for params query, got %q", res.Message)
		}
		if strings.Count(res.Message, "驱动管理") != 1 {
			t.Fatalf("upgrade hint duplicated in message: %q", res.Message)
		}
	})
}
