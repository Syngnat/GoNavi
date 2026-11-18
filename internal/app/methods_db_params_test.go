package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/sqlparam"
)

// fakeParamsDB 在既有全量 fake 之上叠加参数化契约，捕获重写 SQL 与绑定值。
type fakeParamsDB struct {
	fakeBatchWriteDB
	argsQuerySQL    []string
	argsQueryValues [][]any
	argsExecSQL     []string
	argsExecValues  [][]any
}

func (f *fakeParamsDB) QueryContextWithArgs(ctx context.Context, query string, args []any) ([]map[string]interface{}, []string, error) {
	f.argsQuerySQL = append(f.argsQuerySQL, query)
	f.argsQueryValues = append(f.argsQueryValues, args)
	return []map[string]interface{}{{"id": int64(1)}}, []string{"id"}, nil
}

func (f *fakeParamsDB) ExecContextWithArgs(ctx context.Context, query string, args []any) (int64, error) {
	f.argsExecSQL = append(f.argsExecSQL, query)
	f.argsExecValues = append(f.argsExecValues, args)
	return 1, nil
}

func newParamsTestApp(t *testing.T, fake *fakeParamsDB) *App {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return fake, nil }
	return NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
}

var paramsTestConfig = connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

func TestAnalyzeQueryParametersSplitsStatementsAndParams(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := paramsTestConfig
	analysis := app.AnalyzeQueryParameters(config, "main", "SELECT :a; SELECT :b, :a", true)
	if !analysis.Supported {
		t.Fatalf("mysql 应支持参数绑定: %#v", analysis)
	}
	if len(analysis.Statements) != 2 {
		t.Fatalf("语句拆分异常: %#v", analysis.Statements)
	}
	if strings.Join(analysis.ParameterNames, ",") != "a,b" {
		t.Fatalf("参数名应按首次出现去重: %#v", analysis.ParameterNames)
	}
	if len(analysis.Statements[1].Parameters) != 2 {
		t.Fatalf("第二条语句参数异常: %#v", analysis.Statements[1].Parameters)
	}
}

func TestAnalyzeQueryParametersUnsupportedDriver(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mongodb"}
	analysis := app.AnalyzeQueryParameters(config, "", "SELECT :a", true)
	if analysis.Supported {
		t.Fatal("mongodb 不应声明参数绑定能力")
	}
	if analysis.MessageKey == "" {
		t.Fatal("不支持时应返回说明文案键")
	}
}

func TestDBQueryMultiWithParamsBindsPerStatement(t *testing.T) {
	fake := &fakeParamsDB{}
	app := newParamsTestApp(t, fake)

	result := app.DBQueryMultiWithParams(paramsTestConfig, "main",
		"SELECT id FROM t WHERE a = :x; UPDATE t SET b = :y WHERE id = 1", "q-1",
		[]connection.QueryParamBinding{
			{Name: "x", Type: "string", Value: "hello"},
			{Name: "y", Type: "number", Value: float64(7)},
		}, true)
	if !result.Success {
		t.Fatalf("带参执行失败: %s", result.Message)
	}
	if len(fake.argsQuerySQL) != 1 || len(fake.argsExecSQL) != 1 {
		t.Fatalf("应各执行一条参数化语句: %v %v", fake.argsQuerySQL, fake.argsExecSQL)
	}
	if !strings.Contains(fake.argsQuerySQL[0], "?") || strings.Contains(fake.argsQuerySQL[0], ":x") {
		t.Fatalf("查询应重写为位置占位符: %q", fake.argsQuerySQL[0])
	}
	if len(fake.argsQueryValues[0]) != 1 || fake.argsQueryValues[0][0] != "hello" {
		t.Fatalf("查询绑定值异常: %#v", fake.argsQueryValues[0])
	}
	if len(fake.argsExecValues[0]) != 1 || fake.argsExecValues[0][0] != int64(7) {
		t.Fatalf("写入绑定值异常: %#v", fake.argsExecValues[0])
	}
	if len(result.StatementResults) != 2 ||
		result.StatementResults[0].Status != connection.StatementResultSuccess ||
		result.StatementResults[1].Status != connection.StatementResultSuccess {
		t.Fatalf("参数化逐语句状态异常: %#v", result.StatementResults)
	}
}

func TestDBQueryMultiWithParamsReusesSameNameAcrossStatements(t *testing.T) {
	fake := &fakeParamsDB{}
	app := newParamsTestApp(t, fake)

	result := app.DBQueryMultiWithParams(paramsTestConfig, "main",
		"SELECT :day AS a; SELECT :day AS b", "q-2",
		[]connection.QueryParamBinding{{Name: "day", Type: "string", Value: "2026-09-20"}}, true)
	if !result.Success {
		t.Fatalf("带参执行失败: %s", result.Message)
	}
	if len(fake.argsQuerySQL) != 2 {
		t.Fatalf("应执行两条语句: %v", fake.argsQuerySQL)
	}
	for i, sql := range fake.argsQuerySQL {
		if !strings.Contains(sql, "?") || strings.Contains(sql, ":day") {
			t.Fatalf("语句 %d 未重写: %q", i, sql)
		}
		if len(fake.argsQueryValues[i]) != 1 || fake.argsQueryValues[i][0] != "2026-09-20" {
			t.Fatalf("语句 %d 绑定值异常: %#v", i, fake.argsQueryValues[i])
		}
	}
}

func TestDBQueryMultiWithParamsReportsMissingBinding(t *testing.T) {
	fake := &fakeParamsDB{}
	app := newParamsTestApp(t, fake)

	result := app.DBQueryMultiWithParams(paramsTestConfig, "main",
		"SELECT id FROM t WHERE a = :alpha AND b = :beta", "q-3",
		[]connection.QueryParamBinding{{Name: "alpha", Type: "string", Value: "v"}}, true)
	if result.Success {
		t.Fatal("缺值应失败")
	}
	if !strings.Contains(result.Message, "beta") {
		t.Fatalf("错误应包含缺失参数名: %s", result.Message)
	}
	if len(fake.argsQuerySQL) != 0 {
		t.Fatal("缺值时不得执行任何语句")
	}
	if !errors.Is(sqlparam.ErrMissingParameter, sqlparam.ErrMissingParameter) {
		t.Fatal("哨兵错误引用异常")
	}
}

func TestDBQueryMultiWithParamsRejectsUnsupportedDriver(t *testing.T) {
	// fakeBatchWriteDB 只实现无参契约，模拟静态能力通过但运行时契约缺失。
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return &fakeBatchWriteDB{}, nil }

	result := app.DBQueryMultiWithParams(paramsTestConfig, "main", "SELECT :a", "q-4",
		[]connection.QueryParamBinding{{Name: "a", Type: "string", Value: "v"}}, true)
	if result.Success {
		t.Fatal("无参数化契约的驱动应失败")
	}
	if !strings.Contains(result.Message, "不支持参数绑定") {
		t.Fatalf("错误信息应可操作: %s", result.Message)
	}
}

// fakeParamsTransactionSession 在托管事务会话上叠加参数化契约并捕获绑定值。
type fakeParamsTransactionSession struct {
	fakeTransactionSession
	argsQuerySQL   []string
	argsQueryValue [][]any
	argsExecSQL    []string
	argsExecValue  [][]any
}

func (f *fakeParamsTransactionSession) QueryContextWithArgs(ctx context.Context, query string, args []any) ([]map[string]interface{}, []string, error) {
	f.argsQuerySQL = append(f.argsQuerySQL, query)
	f.argsQueryValue = append(f.argsQueryValue, args)
	return []map[string]interface{}{{"id": int64(9)}}, []string{"id"}, nil
}

func (f *fakeParamsTransactionSession) ExecContextWithArgs(ctx context.Context, query string, args []any) (int64, error) {
	f.argsExecSQL = append(f.argsExecSQL, query)
	f.argsExecValue = append(f.argsExecValue, args)
	return 1, nil
}

type fakeParamsTransactionalDB struct {
	fakeBatchWriteDB
	txSession *fakeParamsTransactionSession
}

func (f *fakeParamsTransactionalDB) OpenTransactionExecer(context.Context) (db.TransactionExecer, error) {
	f.txSession = &fakeParamsTransactionSession{
		fakeTransactionSession: fakeTransactionSession{
			fakeBatchWriteSession: fakeBatchWriteSession{parent: &f.fakeBatchWriteDB},
		},
	}
	return f.txSession, nil
}

func TestDBQueryMultiTransactionalWithParamsBindsInsideTransaction(t *testing.T) {
	fake := &fakeParamsTransactionalDB{}
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return fake, nil }
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))

	config := paramsTestConfig
	started := app.DBQueryMultiTransactionalWithParams(config, "main",
		"UPDATE t SET b = :v WHERE id = 1", "tx-params-1",
		[]connection.QueryParamBinding{{Name: "v", Type: "string", Value: "x"}},
		true,
	)
	if !started.Success || started.TransactionID == "" {
		t.Fatalf("托管事务带参启动失败: %#v", started)
	}
	if fake.txSession == nil || len(fake.txSession.argsExecSQL) != 1 {
		t.Fatalf("事务会话应收到参数化语句: %#v", fake.txSession)
	}
	if !strings.Contains(fake.txSession.argsExecSQL[0], "?") || strings.Contains(fake.txSession.argsExecSQL[0], ":v") {
		t.Fatalf("事务内应重写为位置占位符: %q", fake.txSession.argsExecSQL[0])
	}
	if len(fake.txSession.argsExecValue[0]) != 1 || fake.txSession.argsExecValue[0][0] != "x" {
		t.Fatalf("事务内绑定值异常: %#v", fake.txSession.argsExecValue[0])
	}
}

func TestAnalyzeQueryParametersHonorsQuotedPlaceholderSwitch(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	sql := "SELECT '{code1}-{code2}', :real FROM dual"
	on := app.AnalyzeQueryParameters(paramsTestConfig, "main", sql, true)
	if strings.Join(on.ParameterNames, ",") != "code1,code2,real" {
		t.Fatalf("打开开关时应登记引号内全部占位符: %#v", on.ParameterNames)
	}
	off := app.AnalyzeQueryParameters(paramsTestConfig, "main", sql, false)
	if strings.Join(off.ParameterNames, ",") != "real" {
		t.Fatalf("关闭开关时引号内文本应保持原文: %#v", off.ParameterNames)
	}
}
