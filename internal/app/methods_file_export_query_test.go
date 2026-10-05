package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestQueryDataForExport_UsesMinimumTimeout(t *testing.T) {
	fake := &fakeExportQueryDB{
		data: []map[string]interface{}{{"v": 1}},
		cols: []string{"v"},
	}
	_, _, err := queryDataForExport(fake, connection.ConnectionConfig{Timeout: 10}, "SELECT 1")
	if err != nil {
		t.Fatalf("queryDataForExport 返回错误: %v", err)
	}
	if !fake.hasContextDeadline {
		t.Fatal("queryDataForExport 应设置 context deadline")
	}
	if fake.lastQuery != "SELECT 1" {
		t.Fatalf("queryDataForExport 查询语句异常，want=%q got=%q", "SELECT 1", fake.lastQuery)
	}
	lowerBound := minExportQueryTimeout - 5*time.Second
	upperBound := minExportQueryTimeout + 5*time.Second
	if fake.lastContextTimeout < lowerBound || fake.lastContextTimeout > upperBound {
		t.Fatalf("导出最小超时异常，want≈%s got=%s", minExportQueryTimeout, fake.lastContextTimeout)
	}
}

type exportMetadataContextKey struct{}

func TestQueryDataForExportUsesBoundMetadataContext(t *testing.T) {
	fake := &fakeExportQueryDB{
		data: []map[string]interface{}{{"v": 1}},
		cols: []string{"v"},
	}
	parent := context.WithValue(context.Background(), exportMetadataContextKey{}, "metadata-request")
	db.BindMetadataContext(fake, parent)
	defer db.ClearMetadataContext(fake)

	if _, _, err := queryDataForExport(fake, connection.ConnectionConfig{Timeout: 10}, "SELECT 1"); err != nil {
		t.Fatalf("queryDataForExport 返回错误: %v", err)
	}
	if got := fake.lastQueryContext.Value(exportMetadataContextKey{}); got != "metadata-request" {
		t.Fatalf("导出查询未继承元数据请求上下文值，got=%v", got)
	}
}

func TestStreamQueryDataForExportUsesBoundMetadataContext(t *testing.T) {
	fake := &fakeStreamExportDB{
		fakeExportQueryDB: fakeExportQueryDB{data: []map[string]interface{}{{"v": 1}}, cols: []string{"v"}},
		streamCols:        []string{"v"},
		streamData:        []map[string]interface{}{{"v": 1}},
	}
	parent := context.WithValue(context.Background(), exportMetadataContextKey{}, "metadata-request")
	db.BindMetadataContext(fake, parent)
	defer db.ClearMetadataContext(fake)

	if err := streamQueryDataForExport(fake, connection.ConnectionConfig{Timeout: 10}, "SELECT 1", exportContextTestConsumer{}); err != nil {
		t.Fatalf("streamQueryDataForExport 返回错误: %v", err)
	}
	if got := fake.lastQueryContext.Value(exportMetadataContextKey{}); got != "metadata-request" {
		t.Fatalf("流式导出查询未继承元数据请求上下文值，got=%v", got)
	}
}

func TestStreamQueryDataForExportCancellationUsesBoundMetadataContext(t *testing.T) {
	fake := &fakeStreamExportDB{
		fakeExportQueryDB: fakeExportQueryDB{data: []map[string]interface{}{{"v": 1}}, cols: []string{"v"}},
		streamStarted:     make(chan context.Context, 1),
		streamBlock:       true,
	}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), exportMetadataContextKey{}, "metadata-request"))
	defer cancel()
	db.BindMetadataContext(fake, parent)
	defer db.ClearMetadataContext(fake)

	resultCh := make(chan error, 1)
	go func() {
		resultCh <- streamQueryDataForExport(fake, connection.ConnectionConfig{Timeout: 10}, "SELECT 1", exportContextTestConsumer{})
	}()
	select {
	case queryCtx := <-fake.streamStarted:
		if queryCtx.Value(exportMetadataContextKey{}) != "metadata-request" {
			t.Fatalf("流式导出查询未继承元数据请求上下文值，got=%v", queryCtx.Value(exportMetadataContextKey{}))
		}
	case <-time.After(time.Second):
		t.Fatal("流式导出查询未启动")
	}
	cancel()

	select {
	case err := <-resultCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("取消后的流式导出错误 = %v，期望 context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("流式导出查询未因取消而退出")
	}
}

func TestQueryDataForExport_UsesLargerConfiguredTimeout(t *testing.T) {
	fake := &fakeExportQueryDB{
		data: []map[string]interface{}{{"v": 1}},
		cols: []string{"v"},
	}
	_, _, err := queryDataForExport(fake, connection.ConnectionConfig{Timeout: 900}, "SELECT 1")
	if err != nil {
		t.Fatalf("queryDataForExport 返回错误: %v", err)
	}
	if !fake.hasContextDeadline {
		t.Fatal("queryDataForExport 应设置 context deadline")
	}
	expected := 900 * time.Second
	lowerBound := expected - 5*time.Second
	upperBound := expected + 5*time.Second
	if fake.lastContextTimeout < lowerBound || fake.lastContextTimeout > upperBound {
		t.Fatalf("导出配置超时异常，want≈%s got=%s", expected, fake.lastContextTimeout)
	}
}

func TestGetExportQueryTimeout_ExplicitQueryTimeoutOverridesExportMinimum(t *testing.T) {
	timeout := getExportQueryTimeout(connection.ConnectionConfig{
		Type:         "mysql",
		Timeout:      900,
		QueryTimeout: 17,
	})
	if timeout != 17*time.Second {
		t.Fatalf("explicit query timeout should take precedence, want=%s got=%s", 17*time.Second, timeout)
	}
}

func TestQueryDataForExportWithContext_PreservesCallerCancellation(t *testing.T) {
	fake := &fakeExportQueryDB{
		data: []map[string]interface{}{{"v": 1}},
		cols: []string{"v"},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := queryDataForExportWithContext(ctx, fake, connection.ConnectionConfig{QueryTimeout: 60}, "SELECT 1")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("buffered export fallback should return caller cancellation, got %v", err)
	}
	if !fake.hasContextDeadline {
		t.Fatal("buffered export fallback must still apply its query deadline")
	}
}

func TestResolveExportTotalRowsFromRows_PrefersNamedTotalColumn(t *testing.T) {
	total, ok := resolveExportTotalRowsFromRows([]map[string]interface{}{
		{"COUNT": "96000", "other": 1},
	})
	if !ok {
		t.Fatal("应成功解析导出总行数")
	}
	if total != 96000 {
		t.Fatalf("解析导出总行数错误，want=%d got=%d", 96000, total)
	}
}

func TestTryResolveExportTableTotalRows_UsesCountQuery(t *testing.T) {
	fake := &fakeExportQueryDB{
		data: []map[string]interface{}{{"total": int64(128000)}},
		cols: []string{"total"},
	}

	total, ok := tryResolveExportTableTotalRows(
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SYS.test",
	)
	if !ok {
		t.Fatal("应成功解析整表导出总行数")
	}
	if total != 128000 {
		t.Fatalf("整表导出总行数错误，want=%d got=%d", 128000, total)
	}
	if fake.lastQuery != "SELECT COUNT(*) AS total FROM `SYS`.`test`" {
		t.Fatalf("整表导出统计 SQL 错误，got=%q", fake.lastQuery)
	}
}

func TestExportQueryResultToFile_UsesStreamQueryPath(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-stream-*.csv")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeStreamExportDB{
		fakeExportQueryDB: fakeExportQueryDB{
			err:  context.DeadlineExceeded,
			data: []map[string]interface{}{{"id": 999}},
			cols: []string{"id"},
		},
		streamCols: []string{"id", "name"},
		streamData: []map[string]interface{}{
			{"id": 1, "name": "alice"},
			{"id": 2, "name": "bob"},
		},
	}

	rowCount, columns, err := exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT id, name FROM users",
		ExportFileOptions{Format: "csv"},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}
	if fake.streamHits != 1 {
		t.Fatalf("应优先使用流式查询，streamHits=%d", fake.streamHits)
	}
	if fake.queryHits != 0 {
		t.Fatalf("不应回退到缓冲查询，queryHits=%d", fake.queryHits)
	}
	if rowCount != 2 {
		t.Fatalf("导出行数异常，want=2 got=%d", rowCount)
	}
	if len(columns) != 2 || columns[0] != "id" || columns[1] != "name" {
		t.Fatalf("导出列异常，got=%v", columns)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	content := string(contentBytes)
	if !strings.Contains(content, "alice") || !strings.Contains(content, "bob") {
		t.Fatalf("流式导出内容异常: %s", content)
	}
}

func TestExportQueryResultToFile_WritesInsertSQLForKnownTargetTable(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-insert-*.sql")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols: []string{"id", "name"},
		streamValues: [][]interface{}{
			{1, "O'Brien"},
			{2, nil},
		},
	}

	rowCount, columns, err := exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT id, name FROM users",
		ExportFileOptions{
			Format:               "sql",
			InsertSQLDialect:     "mysql",
			InsertSQLTargetTable: "users",
		},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}
	if rowCount != 2 {
		t.Fatalf("导出行数异常，want=2 got=%d", rowCount)
	}
	if len(columns) != 2 || columns[0] != "id" || columns[1] != "name" {
		t.Fatalf("导出列异常，got=%v", columns)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	content := string(contentBytes)
	want := "INSERT INTO `users` (`id`, `name`) VALUES (1, 'O''Brien'),\n(2, NULL);\n"
	if content != want {
		t.Fatalf("INSERT SQL 导出内容异常，want=%q got=%q", want, content)
	}
}

func TestExportQueryResultToFile_WritesInsertSQLWithEmptyTargetTable(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-insert-empty-target-*.sql")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols: []string{"user_id", "role_name"},
		streamValues: [][]interface{}{
			{1, "admin"},
		},
	}

	_, _, err = exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT u.id AS user_id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id",
		ExportFileOptions{
			Format:                         "sql",
			InsertSQLDialect:               "mysql",
			InsertSQLAllowEmptyTargetTable: true,
		},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	want := "INSERT INTO `<table_name>` (`user_id`, `role_name`) VALUES (1, 'admin');\n"
	if string(contentBytes) != want {
		t.Fatalf("空目标表 INSERT SQL 导出内容异常，want=%q got=%q", want, string(contentBytes))
	}
}

func TestExportQueryResultToFile_WritesPostgresBooleanWithPlaceholderTable(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-insert-postgres-placeholder-*.sql")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols:   []string{"active"},
		streamValues: [][]interface{}{{true}},
	}

	_, _, err = exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "postgres", Timeout: 10},
		"SELECT u.active FROM users u JOIN roles r ON r.id = u.role_id",
		ExportFileOptions{
			Format:                         "sql",
			InsertSQLDialect:               "postgres",
			InsertSQLAllowEmptyTargetTable: true,
		},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	want := "INSERT INTO \"<table_name>\" (\"active\") VALUES (true);\n"
	if string(contentBytes) != want {
		t.Fatalf("PostgreSQL 占位表布尔值导出异常，want=%q got=%q", want, string(contentBytes))
	}
}

func TestExportQueryResultToFile_UsesColumnTypesForInsertSQLLiterals(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-insert-types-*.sql")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols: []string{"active", "archived"},
		streamValues: [][]interface{}{
			{true, false},
		},
	}

	_, _, err = exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "postgres", Timeout: 10},
		"SELECT active, archived FROM public.users",
		ExportFileOptions{
			Format:               "sql",
			InsertSQLDialect:     "postgres",
			InsertSQLTargetTable: "public.users",
			InsertSQLColumnTypes: map[string]string{
				"active":   "boolean",
				"archived": "bool",
			},
		},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	want := "INSERT INTO \"public\".\"users\" (\"active\", \"archived\") VALUES (true, false);\n"
	if string(contentBytes) != want {
		t.Fatalf("布尔字段 INSERT SQL 导出内容异常，want=%q got=%q", want, string(contentBytes))
	}
}

func TestExportQueryResultToFile_RejectsColumnsOutsideInsertTargetTable(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-insert-mismatch-*.sql")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols:   []string{"user_id"},
		streamValues: [][]interface{}{{1}},
	}

	_, _, err = exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT id AS user_id FROM users",
		ExportFileOptions{
			Format:                 "sql",
			InsertSQLDialect:       "mysql",
			InsertSQLTargetTable:   "users",
			InsertSQLTargetColumns: map[string]string{"id": "id"},
		},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), `query result column "user_id" does not match`) {
		t.Fatalf("列别名不匹配时应拒绝 INSERT SQL 导出，err=%v", err)
	}
}

func TestExportQueryResultToFile_UsesValueStreamPathWhenAvailable(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-stream-values-*.csv")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols: []string{"id", "name"},
		streamValues: [][]interface{}{
			{1, "alice"},
			{2, "bob"},
		},
	}

	rowCount, columns, err := exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT id, name FROM users",
		ExportFileOptions{Format: "csv"},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}
	if fake.streamHits != 1 {
		t.Fatalf("应优先使用流式查询，streamHits=%d", fake.streamHits)
	}
	if fake.valueHits != 2 {
		t.Fatalf("应走值数组流式路径，valueHits=%d", fake.valueHits)
	}
	if fake.queryHits != 0 {
		t.Fatalf("不应回退到缓冲查询，queryHits=%d", fake.queryHits)
	}
	if rowCount != 2 {
		t.Fatalf("导出行数异常，want=2 got=%d", rowCount)
	}
	if len(columns) != 2 || columns[0] != "id" || columns[1] != "name" {
		t.Fatalf("导出列异常，got=%v", columns)
	}
}

func TestExportQueryResultToFile_ProjectsRequestedColumnsInOrderForValueStream(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-selected-columns-*.csv")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols: []string{"id", "name", "note"},
		streamValues: [][]interface{}{
			{1, "alice", "internal"},
			{2, "bob", "private"},
		},
	}

	rowCount, columns, err := exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT id, name, note FROM users",
		ExportFileOptions{Format: "csv", Columns: []string{"name", "id"}},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}
	if rowCount != 2 {
		t.Fatalf("导出行数异常，want=2 got=%d", rowCount)
	}
	if len(columns) != 2 || columns[0] != "name" || columns[1] != "id" {
		t.Fatalf("导出列未按请求顺序投影，got=%v", columns)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	content := strings.TrimPrefix(string(contentBytes), "\uFEFF")
	want := "name,id\nalice,1\nbob,2\n"
	if content != want {
		t.Fatalf("选列导出内容异常，want=%q got=%q", want, content)
	}
}

func TestExportQueryResultToFile_ProjectsRequestedColumnsInOrderForMapStream(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-selected-map-columns-*.csv")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeStreamExportDB{
		streamCols: []string{"id", "name", "note"},
		streamData: []map[string]interface{}{
			{"id": 1, "name": "alice", "note": "internal"},
		},
	}

	_, columns, err := exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT id, name, note FROM users",
		ExportFileOptions{Format: "csv", Columns: []string{"note", "id"}},
		nil,
	)
	if err != nil {
		t.Fatalf("exportQueryResultToFile 返回错误: %v", err)
	}
	if len(columns) != 2 || columns[0] != "note" || columns[1] != "id" {
		t.Fatalf("导出列未按请求顺序投影，got=%v", columns)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	content := strings.TrimPrefix(string(contentBytes), "\uFEFF")
	want := "note,id\ninternal,1\n"
	if content != want {
		t.Fatalf("选列 map 流导出内容异常，want=%q got=%q", want, content)
	}
}

func TestExportQueryResultToFile_RejectsRequestedColumnMissingFromResult(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-missing-column-*.csv")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	fake := &fakeValueStreamExportDB{
		streamCols:   []string{"id", "name"},
		streamValues: [][]interface{}{{1, "alice"}},
	}

	_, _, err = exportQueryResultToFile(
		f,
		fake,
		connection.ConnectionConfig{Type: "mysql", Timeout: 10},
		"SELECT id, name FROM users",
		ExportFileOptions{Format: "csv", Columns: []string{"name", "missing"}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), `requested export column "missing" was not found`) {
		t.Fatalf("查询结果不包含请求列时应拒绝导出，err=%v", err)
	}
}

func TestExportQueryResultToFile_RejectsExplicitEmptyColumnSelection(t *testing.T) {
	fake := &fakeValueStreamExportDB{
		streamCols:   []string{"id"},
		streamValues: [][]interface{}{{1}},
	}
	for name, selectedColumns := range map[string][]string{
		"empty":      {},
		"blank-only": {"", "   "},
	} {
		t.Run(name, func(t *testing.T) {
			f, err := os.CreateTemp("", "gonavi-export-empty-query-columns-*.csv")
			if err != nil {
				t.Fatalf("创建临时文件失败: %v", err)
			}
			defer os.Remove(f.Name())
			defer f.Close()

			_, _, err = exportQueryResultToFile(
				f,
				fake,
				connection.ConnectionConfig{Type: "mysql", Timeout: 10},
				"SELECT id FROM users",
				ExportFileOptions{Format: "csv", Columns: selectedColumns},
				nil,
			)
			if err == nil || !strings.Contains(err.Error(), "at least one export column must be selected") {
				t.Fatalf("显式空选列应拒绝查询导出，err=%v", err)
			}
		})
	}
}

func TestGetExportQueryTimeout_ClickHouseUsesLongerMinimum(t *testing.T) {
	timeout := getExportQueryTimeout(connection.ConnectionConfig{
		Type:    "clickhouse",
		Timeout: 30,
	})
	if timeout != minClickHouseExportQueryTimeout {
		t.Fatalf("clickhouse 导出超时下限异常，want=%s got=%s", minClickHouseExportQueryTimeout, timeout)
	}
}

func TestGetExportQueryTimeout_CustomClickHouseUsesLongerMinimum(t *testing.T) {
	timeout := getExportQueryTimeout(connection.ConnectionConfig{
		Type:    "custom",
		Driver:  "clickhouse",
		Timeout: 30,
	})
	if timeout != minClickHouseExportQueryTimeout {
		t.Fatalf("custom clickhouse 导出超时下限异常，want=%s got=%s", minClickHouseExportQueryTimeout, timeout)
	}
}

func TestLooksLikeSelectOrWith_AllowsInnerJoinQueryAfterLeadingComments(t *testing.T) {
	query := `
-- query result export
/* generated by query editor */
SELECT
  o.id,
  c.name
FROM orders o
INNER JOIN customers c ON c.id = o.customer_id
`

	if !looksLikeSelectOrWith(query) {
		t.Fatalf("SELECT 换行后的 INNER JOIN 查询应允许导出，query=%q", query)
	}
}
