package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/db"
)

type readOnlyAgentDB struct {
	plainQueryAgentDB
	called        bool
	budget        *db.RowBudget
	deadline      bool
	err           error
	waitForCancel bool
}

func (d *readOnlyAgentDB) Query(string) ([]map[string]interface{}, []string, error) {
	return nil, nil, errors.New("ordinary Query must not run")
}
func (d *readOnlyAgentDB) QueryContext(context.Context, string) ([]map[string]interface{}, []string, error) {
	return nil, nil, errors.New("ordinary QueryContext must not run")
}
func (d *readOnlyAgentDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	d.called = true
	d.budget = db.RowBudgetFromContext(ctx)
	_, d.deadline = ctx.Deadline()
	if d.waitForCancel {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	if d.err != nil {
		return nil, nil, d.err
	}
	if query != "SELECT protected" {
		return nil, nil, errors.New("wrong SQL")
	}
	if d.budget != nil {
		d.budget.ConsumeRow(20)
		d.budget.MarkTruncated()
	}
	return []map[string]interface{}{{"protected": true}}, []string{"protected"}, nil
}
func TestReadOnlyRequestRoutesToOptionalInterface(t *testing.T) {
	fake := &readOnlyAgentDB{}
	options := db.RowBudgetOptions{MaxTotalRows: 2, MaxFieldBytes: 16}
	response := handleRequest(&agentRuntime{inst: fake}, agentRequest{ID: 73, Method: "query_read_only", Query: "SELECT protected", TimeoutMs: 1000, RowBudget: &options})
	if !response.Success {
		t.Fatalf("read-only RPC failed: %s", response.Error)
	}
	if !fake.called || !fake.deadline || fake.budget == nil || fake.budget.Options() != options {
		t.Fatalf("RPC context called=%v deadline=%v budget=%v", fake.called, fake.deadline, fake.budget)
	}
	if len(response.Fields) != 1 || response.Fields[0] != "protected" || !response.Truncated || !response.BudgetExhausted {
		t.Fatalf("response = %+v", response)
	}
}
func TestReadOnlyRequestFailsClosed(t *testing.T) {
	response := handleRequest(&agentRuntime{inst: &plainQueryAgentDB{}}, agentRequest{Method: "query_read_only", Query: "SELECT protected"})
	if response.Success || !strings.Contains(response.Error, "read-only") {
		t.Fatalf("unsupported response = %+v", response)
	}
}
func TestReadOnlyRequestPreservesErrorsAndCancellation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		wait    bool
		message string
	}{
		{name: "driver error", message: "protected failure"},
		{name: "deadline", wait: true, message: context.DeadlineExceeded.Error()},
		{name: "parent cancel", wait: true, message: context.Canceled.Error()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &readOnlyAgentDB{waitForCancel: tc.wait, err: errors.New(tc.message)}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.name == "parent cancel" {
				cancel()
			}
			response := handleRequestWithContext(ctx, &agentRuntime{inst: fake}, agentRequest{Method: "query_read_only", Query: "SELECT protected", TimeoutMs: int64((10 * time.Millisecond) / time.Millisecond)}, nil)
			if response.Success || !strings.Contains(response.Error, tc.message) {
				t.Fatalf("response=%+v", response)
			}
		})
	}
}
