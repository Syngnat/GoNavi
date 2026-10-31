//go:build gonavi_mysql_driver

package main

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/db"
)

type mysqlReadOnlyFake struct {
	called   bool
	budget   *db.RowBudget
	deadline bool
}

func (f *mysqlReadOnlyFake) QueryReadOnlyContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	f.called = true
	f.budget = db.RowBudgetFromContext(ctx)
	_, f.deadline = ctx.Deadline()
	if f.budget != nil {
		f.budget.ConsumeRow(10)
		f.budget.MarkTruncated()
	}
	return []map[string]interface{}{{"value": 1}}, []string{"value"}, nil
}
func TestMySQLReadOnlyRequestRoute(t *testing.T) {
	inst := &db.MySQLDB{}
	response := handleRequest(&inst, mysqlAgentRequest{Method: "query_read_only", Query: "SELECT 1"})
	if response.Success || response.Error != "connection not open" {
		t.Fatalf("read-only dispatcher not reached: %+v", response)
	}
}
func TestMySQLReadOnlyRequestContext(t *testing.T) {
	fake := &mysqlReadOnlyFake{}
	options := db.RowBudgetOptions{MaxTotalRows: 2}
	response := handleMySQLReadOnlyQueryRequest(context.Background(), fake, mysqlAgentRequest{ID: 1, Query: "SELECT 1", TimeoutMs: 1000, RowBudget: &options}, mysqlAgentResponse{ID: 1, Success: true})
	if !response.Success || !fake.called || !fake.deadline || fake.budget == nil || fake.budget.Options() != options || !response.Truncated || !response.BudgetExhausted {
		t.Fatalf("response=%+v fake=%+v", response, fake)
	}
}
