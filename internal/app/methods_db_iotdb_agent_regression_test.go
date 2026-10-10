package app

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestIoTDBReadQueriesPreferPlainQuery(t *testing.T) {
	query := "SELECT Time, value FROM root.streampipes.tem LIMIT 100"
	for _, dbType := range []string{
		"iotdb", "apache-iotdb", "apache_iotdb",
		"clickhouse", "elasticsearch", "elastic", "duckdb", "mongodb",
	} {
		if !shouldPreferPlainReadQueryResult(dbType) || shouldUseNativeMultiResultBatch(dbType, []string{query}, true) {
			t.Fatalf("%s read queries must use the plain query path", dbType)
		}
	}
}

type fakeIoTDBOptionalAgentDB struct {
	*fakeUnsupportedMultiResultDB
}

func (f *fakeIoTDBOptionalAgentDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return f.QueryMultiContext(context.Background(), query)
}

func (f *fakeIoTDBOptionalAgentDB) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	return f.QueryMultiContextWithMessages(context.Background(), query)
}

func (f *fakeIoTDBOptionalAgentDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	results, _, err := f.QueryMultiContextWithMessages(ctx, query)
	return results, err
}

func (f *fakeIoTDBOptionalAgentDB) QueryMultiContextWithMessages(ctx context.Context, _ string) ([]connection.ResultSetData, []string, error) {
	f.multiCalls++
	if db.RowBudgetFromContext(ctx) != nil {
		return nil, nil, errors.New("当前驱动不支持带结果预算的多结果集上下文查询")
	}
	return nil, nil, nil
}

func (*fakeIoTDBOptionalAgentDB) OpenSessionExecer(context.Context) (db.StatementExecer, error) {
	return nil, errors.New("IoTDB driver does not support pinned sessions")
}

func TestDBQueryMultiWithOptionsIoTDBSelectUsesPlainQuery(t *testing.T) {
	query := "SELECT\n `Time`,\n `value`\nFROM root.`streampipes`.`tem` LIMIT 100"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"Time": int64(1), "value": 21.5}},
		},
		fieldMap: map[string][]string{
			query: {"Time", "value"},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeIoTDBOptionalAgentDB{
		fakeUnsupportedMultiResultDB: &fakeUnsupportedMultiResultDB{fakeBatchWriteDB: baseDB},
	}
	installFakeOptionalDriverDatabase(t, fakeDB)

	app := NewApp()
	result := app.DBQueryMultiWithOptions(
		connection.ConnectionConfig{Type: "iotdb", Host: "127.0.0.1", Port: 6667, Database: "root.streampipes"},
		"root.streampipes",
		query,
		"iotdb-table-select",
		QueryResultBudgetOptions{MaxRowsPerResult: 100},
	)
	if !result.Success {
		t.Fatalf("IoTDB SELECT returned failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 {
		t.Fatalf("IoTDB SELECT result sets = %#v, want one result set", result.Data)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"Time", "value"}) {
		t.Fatalf("IoTDB SELECT columns = %#v", resultSets[0].Columns)
	}
	if len(resultSets[0].Rows) != 1 || resultSets[0].Rows[0]["value"] != 21.5 {
		t.Fatalf("IoTDB SELECT rows = %#v, want one data row", resultSets[0].Rows)
	}
	if fakeDB.multiCalls != 0 {
		t.Fatalf("IoTDB SELECT must not probe the budgeted multi-result API, calls=%d", fakeDB.multiCalls)
	}
	if baseDB.queryCalls != 1 {
		t.Fatalf("IoTDB SELECT should execute exactly once through plain Query, calls=%d", baseDB.queryCalls)
	}
	if db.RowBudgetFromContext(baseDB.lastCtx) == nil {
		t.Fatal("plain IoTDB query must receive the result budget")
	}
}
