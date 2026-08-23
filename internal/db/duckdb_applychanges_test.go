//go:build gonavi_full_drivers || gonavi_duckdb_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestDuckDBApplyChangesMarksCommitFailureOutcomeUnknown(t *testing.T) {
	commitErr := errors.New("commit response lost")
	database := openWriteOutcomeTransactionDB(t, &writeOutcomeTransactionState{commitErr: commitErr})
	err := (&DuckDB{conn: database}).ApplyChanges("users", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": int64(1)}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
		t.Fatalf("commit error must be outcome unknown, got %v", err)
	}
}

const duckdbRecordingDriverName = "gonavi_duckdb_recording"

var (
	registerDuckDBRecordingDriverOnce sync.Once
	duckdbRecordingDriverMu           sync.Mutex
	duckdbRecordingDriverSeq          int
	duckdbRecordingDriverStates       = map[string]*duckdbRecordingState{}
)

type duckdbRecordingState struct {
	mu          sync.Mutex
	execQueries []string
	execArgs    [][]driver.NamedValue
	failDelete  error
	failUpdate  error
}

func (s *duckdbRecordingState) snapshotExecQueries() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.execQueries...)
}

func (s *duckdbRecordingState) snapshotExecArgs() [][]driver.NamedValue {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([][]driver.NamedValue, len(s.execArgs))
	for i, args := range s.execArgs {
		result[i] = append([]driver.NamedValue(nil), args...)
	}
	return result
}

type duckdbRecordingDriver struct{}

func (duckdbRecordingDriver) Open(name string) (driver.Conn, error) {
	duckdbRecordingDriverMu.Lock()
	state := duckdbRecordingDriverStates[name]
	duckdbRecordingDriverMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("recording state not found: %s", name)
	}
	return &duckdbRecordingConn{state: state}, nil
}

type duckdbRecordingConn struct {
	state *duckdbRecordingState
}

func (c *duckdbRecordingConn) Prepare(query string) (driver.Stmt, error) {
	return nil, fmt.Errorf("prepare not supported in duckdb recording driver: %s", query)
}

func (c *duckdbRecordingConn) Close() error { return nil }

func (c *duckdbRecordingConn) Begin() (driver.Tx, error) { return duckdbRecordingTx{}, nil }

func (c *duckdbRecordingConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.state.execQueries = append(c.state.execQueries, query)
	c.state.execArgs = append(c.state.execArgs, append([]driver.NamedValue(nil), args...))
	if strings.HasPrefix(query, "DELETE FROM ") && c.state.failDelete != nil {
		return nil, c.state.failDelete
	}
	if strings.HasPrefix(query, "UPDATE ") && c.state.failUpdate != nil {
		return nil, c.state.failUpdate
	}
	return driver.RowsAffected(1), nil
}

var _ driver.ExecerContext = (*duckdbRecordingConn)(nil)

type duckdbRecordingTx struct{}

func (duckdbRecordingTx) Commit() error   { return nil }
func (duckdbRecordingTx) Rollback() error { return nil }

func openDuckDBRecordingDB(t *testing.T) (*sql.DB, *duckdbRecordingState) {
	t.Helper()
	registerDuckDBRecordingDriverOnce.Do(func() {
		sql.Register(duckdbRecordingDriverName, duckdbRecordingDriver{})
	})

	duckdbRecordingDriverMu.Lock()
	duckdbRecordingDriverSeq++
	dsn := fmt.Sprintf("duckdb-recording-%d", duckdbRecordingDriverSeq)
	state := &duckdbRecordingState{}
	duckdbRecordingDriverStates[dsn] = state
	duckdbRecordingDriverMu.Unlock()

	dbConn, err := sql.Open(duckdbRecordingDriverName, dsn)
	if err != nil {
		t.Fatalf("打开 duckdb recording db 失败: %v", err)
	}

	t.Cleanup(func() {
		_ = dbConn.Close()
		duckdbRecordingDriverMu.Lock()
		delete(duckdbRecordingDriverStates, dsn)
		duckdbRecordingDriverMu.Unlock()
	})

	return dbConn, state
}

func TestDuckDBApplyChangesUsesUnquotedRowIDLocator(t *testing.T) {
	t.Parallel()

	dbConn, state := openDuckDBRecordingDB(t)
	duckdb := &DuckDB{conn: dbConn}

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"rowid": 17,
			},
			Values: map[string]interface{}{
				"name": "renamed",
			},
		}},
		Deletes: []map[string]interface{}{
			{"rowid": 21},
		},
		LocatorStrategy: "duckdb-rowid",
	}

	if err := duckdb.ApplyChanges("main.events", changes); err != nil {
		t.Fatalf("ApplyChanges 返回错误: %v", err)
	}

	queries := state.snapshotExecQueries()
	if len(queries) != 2 {
		t.Fatalf("期望执行 2 条 SQL，实际=%d %#v", len(queries), queries)
	}
	if queries[0] != `DELETE FROM "main"."events" WHERE rowid = ?` {
		t.Fatalf("删除 SQL 不符合预期: %s", queries[0])
	}
	if queries[1] != `UPDATE "main"."events" SET "name" = ? WHERE rowid = ?` {
		t.Fatalf("更新 SQL 不符合预期: %s", queries[1])
	}

	args := state.snapshotExecArgs()
	if len(args) != 2 || len(args[0]) != 1 || len(args[1]) != 2 {
		t.Fatalf("执行参数数量不符合预期: %#v", args)
	}
	if got, ok := args[0][0].Value.(int64); !ok || got != 21 {
		t.Fatalf("删除 rowid 参数错误: %#v", args[0])
	}
	if args[1][0].Value != "renamed" {
		t.Fatalf("更新参数错误: %#v", args[1])
	}
	if got, ok := args[1][1].Value.(int64); !ok || got != 17 {
		t.Fatalf("更新参数错误: %#v", args[1])
	}
}
