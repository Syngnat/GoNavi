package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// schemaApplyFlipExecDB 在每条语句执行后跑一次钩子，用来在两条语句之间翻转授权状态。
type schemaApplyFlipExecDB struct {
	*fakeBatchWriteDB
	mu        sync.Mutex
	executed  int
	afterExec func(executed int)
}

// OpenSessionExecer 故意失败，让 dbQueryMulti 回退到共享连接的批量写路径：
// 本用例验证的是 apply 的结果聚合，不需要会话级执行器。
func (f *schemaApplyFlipExecDB) OpenSessionExecer(context.Context) (db.StatementExecer, error) {
	return nil, errors.New("test fixture uses the shared batch path")
}

func (f *schemaApplyFlipExecDB) ExecContext(ctx context.Context, query string) (int64, error) {
	return f.runAndFlip(f.fakeBatchWriteDB.ExecContext(ctx, query))
}

func (f *schemaApplyFlipExecDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	return f.runAndFlip(f.fakeBatchWriteDB.ExecBatchContext(ctx, query))
}

func (f *schemaApplyFlipExecDB) runAndFlip(affected int64, err error) (int64, error) {
	f.mu.Lock()
	f.executed++
	executed := f.executed
	hook := f.afterExec
	f.mu.Unlock()
	if hook != nil {
		hook(executed)
	}
	return affected, err
}

// 第一批语句已经落库之后才失权时，必须把已执行的结果连中断原因一起回传：
// 只返回错误码会让调用方以为整批都没跑，重试会把不可逆 DDL 再执行一遍。
func TestPluginSchemaApplyReportsPartialExecution(t *testing.T) {
	a := newPluginTestApp(t)
	base := &fakeBatchWriteDB{}
	flip := &schemaApplyFlipExecDB{fakeBatchWriteDB: base}
	original := newDatabaseFunc
	newDatabaseFunc = func(string) (db.Database, error) { return flip, nil }
	t.Cleanup(func() { newDatabaseFunc = original })

	config := connection.ConnectionConfig{Type: "postgres", Host: "db.internal"}
	save := func() {
		t.Helper()
		if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{ID: "partial-schema", Name: "Partial", Config: config}); err != nil {
			t.Fatal(err)
		}
	}
	save()
	status := runningSchemaWriteStatus(t, a, "test.schema.partial")
	a.schemaConfirm = func(context.Context, string) (bool, error) { return true, nil }
	// 第一条语句执行完成后禁用插件，模拟「用户确认之后、整批跑完之前」失权。
	flip.afterExec = func(executed int) {
		if executed != 1 {
			return
		}
		manager, err := a.pluginManager(a.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := manager.SetEnabled(a.ctx, status.Manifest.ID, false); err != nil {
			t.Fatal(err)
		}
	}

	planID := a.schemaWritePlans.put(schemaWritePlan{
		connectionID: "partial-schema",
		database:     "app",
		statements:   []string{"CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"},
		expiresAt:    time.Now().Add(time.Minute),
	})
	arguments, err := json.Marshal(pluginCapabilitySchemaApplyArguments{PlanID: planID})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := a.pluginCapabilityCall(a.ctx, status, pluginCapabilityChannelWindow, "schema.apply", arguments)
	if err != nil {
		t.Fatal(err)
	}
	if ok, code := decodePluginCapabilityEnvelope(t, raw); !ok || code != "" {
		t.Fatalf("partial apply must still report what ran: %s", raw)
	}
	var envelope struct {
		Data pluginCapabilitySchemaApplyResult `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	got := envelope.Data
	if got.Applied != 1 || got.Failed != 0 || got.Pending != 1 || got.Stopped != "not_running" {
		t.Fatalf("partial apply report = %+v", got)
	}
	if len(got.Statements) != 1 || !got.Statements[0].Success {
		t.Fatalf("executed statement must stay in the report: %+v", got.Statements)
	}
	if executed := base.execCalls + base.batchCalls; executed != 1 {
		t.Fatalf("only the first statement may run, executed=%d", executed)
	}
}

// 确认框必须展示语句本身，且截断不能切坏多字节标识符。
func TestSchemaWriteConfirmationMessageListsStatements(t *testing.T) {
	message := schemaWriteConfirmationMessage(schemaWritePlan{
		database:   "app",
		statements: []string{"CREATE TABLE a (id INT)", "ALTER TABLE b ADD COLUMN c INT"},
	})
	for _, want := range []string{
		"2 DDL statement(s) will run on app",
		"1. CREATE TABLE a (id INT)",
		"2. ALTER TABLE b ADD COLUMN c INT",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("confirmation message missing %q: %s", want, message)
		}
	}

	noDatabase := schemaWriteConfirmationMessage(schemaWritePlan{statements: []string{"DROP TABLE t"}})
	if !strings.Contains(noDatabase, "the saved connection") || !strings.Contains(noDatabase, "1. DROP TABLE t") {
		t.Fatalf("saved-connection message = %s", noDatabase)
	}

	// 每条语句压成单行，超长按 rune 截断。
	multiline := schemaWriteConfirmationMessage(schemaWritePlan{
		statements: []string{"CREATE TABLE t (\n  id INT,\n  注释 VARCHAR(10)\n)"},
	})
	if !strings.Contains(multiline, "1. CREATE TABLE t ( id INT, 注释 VARCHAR(10) )") {
		t.Fatalf("statement must collapse to one line: %s", multiline)
	}
	long := schemaWriteConfirmationMessage(schemaWritePlan{
		statements: []string{"CREATE TABLE t (" + strings.Repeat("字段", 300) + ")"},
	})
	if !utf8.ValidString(multiline) || !utf8.ValidString(long) {
		t.Fatal("truncation split a multi-byte rune")
	}
	if !strings.Contains(long, "…") {
		t.Fatalf("oversized statement must be truncated: %s", long)
	}
}
