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

func TestMySQLAgentReadOnlyQueryRPC(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		success        bool
	}{
		{"success", `{"id":1,"success":true,"data":[{"value":1}],"fields":["value"],"budgetExhausted":true}`, true},
		{"old agent", `{"id":1,"success":false,"error":"unknown method query_read_only"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdin mysqlAgentTestWriteCloser
			database := &MySQLAgentDB{client: &mysqlAgentClient{stdin: &stdin, reader: bufio.NewReader(strings.NewReader(tc.response + "\n"))}}
			querier, ok := interface{}(database).(readOnlyTestQuerier)
			if !ok {
				t.Fatal("MySQLAgentDB must implement QueryReadOnlyContext")
			}
			budget := NewRowBudget(2)
			ctx, cancel := context.WithTimeout(ContextWithRowBudget(context.Background(), budget), time.Second)
			defer cancel()
			rows, fields, err := querier.QueryReadOnlyContext(ctx, "SELECT value")
			if tc.success {
				if err != nil || len(rows) != 1 || len(fields) != 1 || !budget.Truncated() {
					t.Fatalf("rows=%v fields=%v err=%v truncated=%v", rows, fields, err, budget.Truncated())
				}
			} else if err == nil || rows != nil || fields != nil {
				t.Fatalf("old agent accepted rows=%v fields=%v err=%v", rows, fields, err)
			}
			var request struct {
				Method    string
				TimeoutMs int64
				RowBudget *RowBudgetOptions
			}
			if err := json.Unmarshal(bytes.TrimSpace(stdin.Bytes()), &request); err != nil {
				t.Fatalf("expected one request: %v", err)
			}
			if request.Method != "query_read_only" || request.TimeoutMs <= 0 || request.RowBudget == nil || *request.RowBudget != budget.Options() {
				t.Fatalf("request=%+v", request)
			}
		})
	}
}
