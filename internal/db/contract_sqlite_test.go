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
