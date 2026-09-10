//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// TestSQLiteContractReadOnlyQueryContextBoundaries is intentionally limited to
// an in-memory SQLite fixture. It verifies the context contract without
// creating a schema, mutating a user database, or requiring a live service.
func TestSQLiteContractReadOnlyQueryContextBoundaries(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("connect in-memory SQLite fixture: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	t.Run("read-only query", func(t *testing.T) {
		rows, columns, err := client.QueryContext(context.Background(), "SELECT 42 AS answer")
		if err != nil {
			t.Fatalf("query fixture: %v", err)
		}
		if !reflect.DeepEqual(columns, []string{"answer"}) || len(rows) != 1 || fmt.Sprint(rows[0]["answer"]) != "42" {
			t.Fatalf("unexpected read-only query result: columns=%v rows=%#v", columns, rows)
		}
	})

	t.Run("cancelled context", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, _, err := client.QueryContext(ctx, "SELECT 1")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled query error = %v, want context.Canceled", err)
		}
	})

	t.Run("expired deadline", func(t *testing.T) {
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer cancel()
		_, _, err := client.QueryContext(ctx, "SELECT 1")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expired query error = %v, want context.DeadlineExceeded", err)
		}
	})
}

// TestSQLiteGetColumnsContextHonorsCallerContext locks the cancellation contract
// of GetColumnsContext: both metadata queries it performs (PRAGMA table_info and
// the sqlite_master DDL lookup that restores the AUTOINCREMENT marker) must run
// under the caller context, never under an unrelated metadata/background one.
func TestSQLiteGetColumnsContextHonorsCallerContext(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("connect in-memory SQLite fixture: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.ExecContext(context.Background(),
		"CREATE TABLE auto_t (id INTEGER PRIMARY KEY ON CONFLICT ABORT AUTOINCREMENT, note TEXT)"); err != nil {
		t.Fatalf("create fixture table: %v", err)
	}

	t.Run("live context runs both metadata queries", func(t *testing.T) {
		cols, err := client.GetColumnsContext(context.Background(), "", "auto_t")
		if err != nil {
			t.Fatalf("GetColumnsContext: %v", err)
		}
		// AUTOINCREMENT 标记只能来自 sqlite_master 的第二次查询，断言它
		// 在调用方 ctx 下真实完成且结果正确。
		if len(cols) != 2 || cols[0].Extra != "auto_increment" {
			t.Fatalf("autoincrement marker from sqlite_master query missing: %+v", cols)
		}
	})

	t.Run("cancelled context", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := client.GetColumnsContext(ctx, "", "auto_t")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled GetColumnsContext error = %v, want context.Canceled", err)
		}
	})

	t.Run("expired deadline", func(t *testing.T) {
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer cancel()
		_, err := client.GetColumnsContext(ctx, "", "auto_t")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expired GetColumnsContext error = %v, want context.DeadlineExceeded", err)
		}
	})
}
