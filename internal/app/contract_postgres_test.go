package app

import (
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// TestPostgresContractQueryContextUsesExplicitTimeout keeps the contract
// matrix tied to a concrete PostgreSQL configuration without opening a
// database connection.
func TestPostgresContractQueryContextUsesExplicitTimeout(t *testing.T) {
	ctx, cancel := newQueryExecutionContext(connection.ConnectionConfig{
		Type:         "postgres",
		Timeout:      1,
		QueryTimeout: 7,
	})
	defer cancel()

	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("expected explicit PostgreSQL query timeout to carry a deadline")
	}
	remaining := time.Until(deadline)
	if remaining <= 0 || remaining > 8*time.Second {
		t.Fatalf("expected deadline around 7s, got remaining=%s", remaining)
	}
}
