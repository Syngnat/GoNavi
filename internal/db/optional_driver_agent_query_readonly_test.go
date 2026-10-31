package db

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestOptionalAgentReadOnlyQueryUsesDedicatedRPC(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		success        bool
	}{
		{"success", `{"id":1,"success":true,"data":[{"value":1}],"fields":["value"],"budgetExhausted":true}`, true},
		{"old agent", `{"id":1,"success":false,"error":"unknown method query_read_only"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdin optionalAgentTestWriteCloser
			database := &OptionalDriverAgentDB{driverType: "postgres", client: &optionalDriverAgentClient{stdin: &stdin, reader: bufio.NewReader(strings.NewReader(tc.response + "\n")), driver: "postgres"}}
			budget := NewRowBudgetWithOptions(RowBudgetOptions{MaxRowsPerResult: 2, MaxTotalRows: 2, MaxTotalBytes: 1024, MaxFieldBytes: 16})
			ctx, cancel := context.WithTimeout(ContextWithRowBudget(context.Background(), budget), time.Second)
			defer cancel()
			rows, fields, err := database.QueryReadOnlyContext(ctx, "SELECT value")
			if tc.success {
				if err != nil || len(rows) != 1 || len(fields) != 1 || !budget.Truncated() {
					t.Fatalf("rows=%v fields=%v err=%v truncated=%v", rows, fields, err, budget.Truncated())
				}
			} else if err == nil || rows != nil || fields != nil {
				t.Fatalf("old agent must fail closed: rows=%v fields=%v err=%v", rows, fields, err)
			}
			var request optionalAgentRequest
			if err := json.Unmarshal(bytes.TrimSpace(stdin.Bytes()), &request); err != nil {
				t.Fatalf("expected exactly one RPC: %v bytes=%q", err, stdin.Bytes())
			}
			if request.Method != "query_read_only" || request.Query != "SELECT value" || request.TimeoutMs <= 0 || request.TimeoutMs > 1000 || request.RowBudget == nil || *request.RowBudget != budget.Options() {
				t.Fatalf("request=%+v", request)
			}
		})
	}
}
func TestOptionalAgentReadOnlyQueryRejectsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	database := &OptionalDriverAgentDB{}
	if _, _, err := database.QueryReadOnlyContext(ctx, "SELECT 1"); err != context.Canceled {
		t.Fatalf("error=%v", err)
	}
}
