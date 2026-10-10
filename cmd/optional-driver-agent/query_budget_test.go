package main

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestHandleRequestPassesRowBudgetToDriverContext(t *testing.T) {
	fake := &fakeAgentTimeoutDB{}
	runtimeState := &agentRuntime{inst: fake, sessions: make(map[string]db.StatementExecer)}
	options := db.RowBudgetOptions{
		MaxRowsPerResult: 12,
		MaxTotalRows:     18,
		MaxTotalBytes:    4096,
		MaxFieldBytes:    512,
	}

	response := handleRequest(runtimeState, agentRequest{
		ID:        41,
		Method:    agentMethodQuery,
		Query:     "SELECT payload FROM items",
		RowBudget: &options,
	})
	if !response.Success {
		t.Fatalf("budgeted agent query failed: %s", response.Error)
	}
	if !fake.queryContextCalled || fake.queryCalled {
		t.Fatalf("budgeted agent query path = QueryContext:%v Query:%v", fake.queryContextCalled, fake.queryCalled)
	}
	if fake.rowBudget == nil || fake.rowBudget.Options() != options {
		t.Fatalf("agent row budget = %#v", fake.rowBudget)
	}
}

func TestBudgetedMultiResultWithoutAPIReportsUnsupported(t *testing.T) {
	options := &db.RowBudgetOptions{MaxRowsPerResult: 10}
	query := "SELECT Time, value FROM root.streampipes.tem LIMIT 100"
	data, messages, supported, _, err := queryMultiWithMessagesRequest(context.Background(), &plainQueryAgentDB{}, query, 0, options)
	if err != nil || supported || data != nil || messages != nil {
		t.Fatalf("driver without multi-result API: supported=%v err=%v data=%#v messages=%#v", supported, err, data, messages)
	}

	sessionData, sessionMessages, sessionSupported, _, sessionErr := queryMultiStatementWithMessagesRequest(
		context.Background(), plainStatementExecer{}, query, 0, options,
	)
	if sessionErr != nil || sessionSupported || sessionData != nil || sessionMessages != nil {
		t.Fatalf("session without multi-result API: supported=%v err=%v data=%#v", sessionSupported, sessionErr, sessionData)
	}
}

func TestBudgetedMultiResultRejectsBudgetBlindImplementation(t *testing.T) {
	driver := &nonContextMultiAgentDB{}
	options := &db.RowBudgetOptions{MaxRowsPerResult: 10}
	_, _, supported, _, err := queryMultiWithMessagesRequest(
		context.Background(), driver, "SELECT 1", 0, options,
	)
	if supported || err == nil || !strings.Contains(err.Error(), "当前驱动不支持带结果预算的多结果集上下文查询") {
		t.Fatalf("budget-blind multi-result: supported=%v err=%v", supported, err)
	}
	if driver.multiCalled {
		t.Fatal("budget-blind QueryMulti must not run")
	}
}

type plainQueryAgentDB struct{}

func (plainQueryAgentDB) Connect(connection.ConnectionConfig) error { return nil }
func (plainQueryAgentDB) Close() error                              { return nil }
func (plainQueryAgentDB) Ping() error                               { return nil }
func (plainQueryAgentDB) Query(string) ([]map[string]interface{}, []string, error) {
	return []map[string]interface{}{{"value": 1}}, []string{"value"}, nil
}
func (plainQueryAgentDB) QueryContext(context.Context, string) ([]map[string]interface{}, []string, error) {
	return []map[string]interface{}{{"value": 1}}, []string{"value"}, nil
}
func (plainQueryAgentDB) Exec(string) (int64, error) { return 0, nil }
func (plainQueryAgentDB) GetDatabases() ([]string, error) {
	return nil, nil
}
func (plainQueryAgentDB) GetTables(string) ([]string, error) { return nil, nil }
func (plainQueryAgentDB) GetCreateStatement(string, string) (string, error) {
	return "", nil
}
func (plainQueryAgentDB) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (plainQueryAgentDB) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (plainQueryAgentDB) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (plainQueryAgentDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (plainQueryAgentDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

type nonContextMultiAgentDB struct {
	plainQueryAgentDB
	multiCalled bool
}

func (n *nonContextMultiAgentDB) QueryMulti(string) ([]connection.ResultSetData, error) {
	n.multiCalled = true
	return []connection.ResultSetData{{
		Columns: []string{"value"},
		Rows:    []map[string]interface{}{{"value": 1}},
	}}, nil
}

type plainStatementExecer struct{}

func (plainStatementExecer) Exec(string) (int64, error) { return 0, nil }
func (plainStatementExecer) ExecContext(context.Context, string) (int64, error) {
	return 0, nil
}
func (plainStatementExecer) Close() error { return nil }
