package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/shared/i18n"
	"github.com/xuri/excelize/v2"
)

type fakeExportQueryDB struct {
	data []map[string]interface{}
	cols []string
	err  error
	defs []connection.ColumnDefinition

	lastQuery          string
	queries            []string
	lastContextTimeout time.Duration
	hasContextDeadline bool
	lastQueryContext   context.Context
}

type fakeStreamExportDB struct {
	fakeExportQueryDB
	streamData    []map[string]interface{}
	streamCols    []string
	streamHits    int
	queryHits     int
	streamStarted chan context.Context
	streamBlock   bool
}

type fakeValueStreamExportDB struct {
	fakeExportQueryDB
	streamCols   []string
	streamValues [][]interface{}
	streamHits   int
	queryHits    int
	valueHits    int
}

type fakeGeneratedValueStreamExportDB struct {
	streamCols []string
	rowCount   int
	streamHits int
	valueHits  int
}

type exportContextTestConsumer struct{}

func (exportContextTestConsumer) SetColumns([]string) error               { return nil }
func (exportContextTestConsumer) ConsumeRow(map[string]interface{}) error { return nil }

type fakeSQLDumpExportDB struct {
	fakeExportQueryDB
	tables    []string
	createSQL string
	createErr error
}

type fakePostgresCommentExportDB struct {
	fakeSQLDumpExportDB
	tableComment      string
	tableCommentErr   error
	commentSchema     string
	commentTable      string
	tableCommentCalls int
}

type captureExportProgressEmitter struct {
	events []exportProgressPayload
}

func (e *captureExportProgressEmitter) Emit(name string, args ...any) {
	if name != exportProgressEvent || len(args) == 0 {
		return
	}
	payload, ok := args[0].(exportProgressPayload)
	if ok {
		e.events = append(e.events, payload)
	}
}

func (f *fakeExportQueryDB) Connect(config connection.ConnectionConfig) error { return nil }
func (f *fakeExportQueryDB) Close() error                                     { return nil }
func (f *fakeExportQueryDB) Ping() error                                      { return nil }
func (f *fakeExportQueryDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.lastQuery = query
	f.queries = append(f.queries, query)
	return f.data, f.cols, f.err
}
func (f *fakeExportQueryDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.lastQuery = query
	f.queries = append(f.queries, query)
	f.lastQueryContext = ctx
	if deadline, ok := ctx.Deadline(); ok {
		f.hasContextDeadline = true
		f.lastContextTimeout = time.Until(deadline)
	}
	return f.data, f.cols, f.err
}
func (f *fakeExportQueryDB) Exec(query string) (int64, error) { return 0, nil }
func (f *fakeExportQueryDB) GetDatabases() ([]string, error)  { return nil, nil }
func (f *fakeExportQueryDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (f *fakeExportQueryDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (f *fakeExportQueryDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return f.defs, nil
}
func (f *fakeExportQueryDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeExportQueryDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *fakeExportQueryDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeExportQueryDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func (f *fakeSQLDumpExportDB) GetTables(dbName string) ([]string, error) {
	return append([]string(nil), f.tables...), nil
}

func (f *fakeSQLDumpExportDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return f.createSQL, f.createErr
}

func (f *fakePostgresCommentExportDB) GetTableComment(dbName, tableName string) (string, error) {
	f.tableCommentCalls++
	f.commentSchema = dbName
	f.commentTable = tableName
	return f.tableComment, f.tableCommentErr
}

func (f *fakeStreamExportDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.Query(query)
}

func (f *fakeStreamExportDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.QueryContext(ctx, query)
}

func (f *fakeStreamExportDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *fakeStreamExportDB) StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.streamHits++
	f.lastQuery = query
	f.lastQueryContext = ctx
	if f.streamStarted != nil {
		select {
		case f.streamStarted <- ctx:
		default:
		}
	}
	if f.streamBlock {
		<-ctx.Done()
		return ctx.Err()
	}
	if err := consumer.SetColumns(f.streamCols); err != nil {
		return err
	}
	for _, row := range f.streamData {
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeValueStreamExportDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.Query(query)
}

func (f *fakeValueStreamExportDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.QueryContext(ctx, query)
}

func (f *fakeValueStreamExportDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *fakeValueStreamExportDB) StreamQueryContext(_ context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.streamHits++
	f.lastQuery = query
	if err := consumer.SetColumns(f.streamCols); err != nil {
		return err
	}
	if valueConsumer, ok := consumer.(db.QueryStreamValueConsumer); ok {
		for _, row := range f.streamValues {
			f.valueHits++
			if err := valueConsumer.ConsumeRowValues(row); err != nil {
				return err
			}
		}
		return nil
	}
	for _, row := range f.streamValues {
		entry := make(map[string]interface{}, len(f.streamCols))
		for idx, column := range f.streamCols {
			if idx < len(row) {
				entry[column] = row[idx]
			}
		}
		if err := consumer.ConsumeRow(entry); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeGeneratedValueStreamExportDB) Connect(config connection.ConnectionConfig) error {
	return nil
}

func (f *fakeGeneratedValueStreamExportDB) Close() error { return nil }

func (f *fakeGeneratedValueStreamExportDB) Ping() error { return nil }

func (f *fakeGeneratedValueStreamExportDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, context.DeadlineExceeded
}

func (f *fakeGeneratedValueStreamExportDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, context.DeadlineExceeded
}

func (f *fakeGeneratedValueStreamExportDB) Exec(query string) (int64, error) { return 0, nil }

func (f *fakeGeneratedValueStreamExportDB) GetDatabases() ([]string, error) { return nil, nil }

func (f *fakeGeneratedValueStreamExportDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}

func (f *fakeGeneratedValueStreamExportDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *fakeGeneratedValueStreamExportDB) StreamQueryContext(_ context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.streamHits++
	if err := consumer.SetColumns(f.streamCols); err != nil {
		return err
	}
	valueConsumer, ok := consumer.(db.QueryStreamValueConsumer)
	if !ok {
		return fmt.Errorf("value stream consumer required")
	}
	for i := 0; i < f.rowCount; i++ {
		f.valueHits++
		if err := valueConsumer.ConsumeRowValues([]interface{}{
			i + 1,
			"benchmark-user",
			"plain export payload without timezone marker",
			"2026-06-17 12:34:56",
			"enabled",
		}); err != nil {
			return err
		}
	}
	return nil
}

func TestFormatExportCellText_FloatNoScientificNotation(t *testing.T) {
	got := formatExportCellText(1.445663e+06)
	if strings.Contains(strings.ToLower(got), "e+") || strings.Contains(strings.ToLower(got), "e-") {
		t.Fatalf("不应输出科学计数法，got=%q", got)
	}
	if got != "1445663" {
		t.Fatalf("浮点整值导出异常，want=%q got=%q", "1445663", got)
	}
}

func TestBuildExportTableSelectQuery_QuotesRequestedColumnsInOrder(t *testing.T) {
	got := buildExportTableSelectQuery(
		"mysql",
		"audit.users",
		[]string{"display name", " id "},
	)
	want := "SELECT `display name`, ` id ` FROM `audit`.`users`"
	if got != want {
		t.Fatalf("整表选列查询异常，want=%q got=%q", want, got)
	}

	got = buildExportTableSelectQuery("postgres", "public.users", nil)
	want = `SELECT * FROM "public"."users"`
	if got != want {
		t.Fatalf("未指定列时应保持 SELECT * 兼容行为，want=%q got=%q", want, got)
	}
}

func TestWriteRowsToFile_TabularFormatsExportNilAsEmptyCell(t *testing.T) {
	var nilTime *time.Time
	data := []map[string]interface{}{
		{"id": 1, "nullable": nil, "nullable_time": nilTime, "tail": "end"},
	}
	columns := []string{"id", "nullable", "nullable_time", "tail"}

	for _, format := range []string{"csv", "md", "html", "xlsx"} {
		t.Run(format, func(t *testing.T) {
			f, err := os.CreateTemp("", fmt.Sprintf("gonavi-export-null-*.%s", format))
			if err != nil {
				t.Fatalf("创建临时文件失败: %v", err)
			}
			defer os.Remove(f.Name())
			defer f.Close()

			if err := writeRowsToFile(f, data, columns, ExportFileOptions{Format: format}); err != nil {
				t.Fatalf("写入 %s 失败: %v", format, err)
			}

			if format == "xlsx" {
				workbook, err := excelize.OpenFile(f.Name())
				if err != nil {
					t.Fatalf("打开 xlsx 失败: %v", err)
				}
				defer workbook.Close()
				rows, err := workbook.GetRows("Sheet1")
				if err != nil {
					t.Fatalf("读取 xlsx 失败: %v", err)
				}
				if len(rows) < 2 || len(rows[1]) < 4 || rows[1][1] != "" || rows[1][2] != "" {
					t.Fatalf("xlsx 实际 nil 应导出为空单元格，rows=%v", rows)
				}
				return
			}

			contentBytes, err := os.ReadFile(f.Name())
			if err != nil {
				t.Fatalf("读取 %s 失败: %v", format, err)
			}
			content := string(contentBytes)
			switch format {
			case "csv":
				if !strings.Contains(content, "1,,,end") {
					t.Fatalf("csv 实际 nil 应导出为空单元格: %q", content)
				}
			case "md":
				if !strings.Contains(content, "| 1 |  |  | end |") {
					t.Fatalf("markdown 实际 nil 应导出为空单元格: %q", content)
				}
			case "html":
				if !strings.Contains(content, "<td>1</td><td></td><td></td><td>end</td>") {
					t.Fatalf("html 实际 nil 应导出为空单元格: %q", content)
				}
			}
		})
	}
}

func TestWriteRowsToFile_ProjectsColumnsFromExportOptions(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-buffered-selected-columns-*.csv")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	data := []map[string]interface{}{
		{"id": 1, " name ": "alice", "note": "internal"},
	}
	columns := []string{"id", " name ", "note"}
	if err := writeRowsToFile(f, data, columns, ExportFileOptions{
		Format:  "csv",
		Columns: []string{" name ", "id", " name ", "   "},
	}); err != nil {
		t.Fatalf("写入 csv 失败: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	content := strings.TrimPrefix(string(contentBytes), "\uFEFF")
	want := "\" name \",id\nalice,1\n"
	if content != want {
		t.Fatalf("缓冲导出未按 options.Columns 投影，want=%q got=%q", want, content)
	}
}

func TestWriteRowsToFile_RejectsExplicitEmptyColumnSelection(t *testing.T) {
	data := []map[string]interface{}{{"id": 1}}
	columns := []string{"id"}
	for name, selectedColumns := range map[string][]string{
		"empty":      {},
		"blank-only": {"", "   "},
	} {
		t.Run(name, func(t *testing.T) {
			f, err := os.CreateTemp("", "gonavi-export-empty-columns-*.csv")
			if err != nil {
				t.Fatalf("创建临时文件失败: %v", err)
			}
			defer os.Remove(f.Name())
			defer f.Close()

			err = writeRowsToFile(f, data, columns, ExportFileOptions{
				Format:  "csv",
				Columns: selectedColumns,
			})
			if err == nil || !strings.Contains(err.Error(), "at least one export column must be selected") {
				t.Fatalf("显式空选列应拒绝导出，err=%v", err)
			}
		})
	}
}

func TestWriteRowsToFile_Markdown_NumberKeepPlainText(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-*.md")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	data := []map[string]interface{}{
		{"id": 1.445663e+06},
	}
	columns := []string{"id"}

	if err := writeRowsToFile(f, data, columns, ExportFileOptions{Format: "md"}); err != nil {
		t.Fatalf("写入 md 失败: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取 md 失败: %v", err)
	}
	content := string(contentBytes)
	if strings.Contains(strings.ToLower(content), "e+") || strings.Contains(strings.ToLower(content), "e-") {
		t.Fatalf("md 导出包含科学计数法: %s", content)
	}
	if !strings.Contains(content, "| 1445663 |") {
		t.Fatalf("md 导出未保留整数字面量，content=%s", content)
	}
}

func TestWriteRowsToFile_JSON_NumberKeepPlainText(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-*.json")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	data := []map[string]interface{}{
		{"id": 1.445663e+06},
	}
	columns := []string{"id"}

	if err := writeRowsToFile(f, data, columns, ExportFileOptions{Format: "json"}); err != nil {
		t.Fatalf("写入 json 失败: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取 json 失败: %v", err)
	}
	content := string(contentBytes)
	if strings.Contains(strings.ToLower(content), "e+") || strings.Contains(strings.ToLower(content), "e-") {
		t.Fatalf("json 导出包含科学计数法: %s", content)
	}

	var decoded []map[string]json.Number
	decoder := json.NewDecoder(bytes.NewReader(contentBytes))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("解析导出 json 失败: %v", err)
	}
	if len(decoded) != 1 {
		t.Fatalf("导出行数异常，got=%d", len(decoded))
	}
	if decoded[0]["id"].String() != "1445663" {
		t.Fatalf("json 数值格式异常，want=1445663 got=%s", decoded[0]["id"].String())
	}
}

func TestWriteRowsToFile_JSONKeepsNilAsJSONNull(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-null-*.json")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	if err := writeRowsToFile(
		f,
		[]map[string]interface{}{{"nullable": nil}},
		[]string{"nullable"},
		ExportFileOptions{Format: "json"},
	); err != nil {
		t.Fatalf("写入 json 失败: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取 json 失败: %v", err)
	}
	var decoded []map[string]interface{}
	if err := json.Unmarshal(contentBytes, &decoded); err != nil {
		t.Fatalf("解析 json 失败: %v", err)
	}
	value, exists := decoded[0]["nullable"]
	if !exists || value != nil {
		t.Fatalf("JSON 导出应保留 null 语义，decoded=%v", decoded)
	}
}

func TestNormalizeExportJSONValue_LocalDateTimeString_NoTimezoneShift(t *testing.T) {
	originalLocal := time.Local
	time.Local = time.FixedZone("UTC+8", 8*60*60)
	defer func() { time.Local = originalLocal }()

	got := normalizeExportJSONValue("2026-04-07 18:44:32")
	if got != "2026-04-07 18:44:32" {
		t.Fatalf("本地无时区字符串不应发生时区偏移，want=%q got=%v", "2026-04-07 18:44:32", got)
	}
}

func TestFormatExportCellText_TimeValue_KeepWallClock(t *testing.T) {
	originalLocal := time.Local
	time.Local = time.FixedZone("UTC+8", 8*60*60)
	defer func() { time.Local = originalLocal }()

	utc := time.Date(2026, 4, 7, 10, 44, 32, 0, time.UTC)
	got := formatExportCellText(utc)
	if got != "2026-04-07 10:44:32" {
		t.Fatalf("time.Time 导出应保持原始钟表时间，want=%q got=%q", "2026-04-07 10:44:32", got)
	}
}

func TestFormatExportCellText_StringRFC3339_KeepWallClock(t *testing.T) {
	originalLocal := time.Local
	time.Local = time.FixedZone("UTC+8", 8*60*60)
	defer func() { time.Local = originalLocal }()

	got := formatExportCellText("2026-04-07T10:44:32Z")
	if got != "2026-04-07 10:44:32" {
		t.Fatalf("字符串时间导出应保持原始钟表时间，want=%q got=%q", "2026-04-07 10:44:32", got)
	}
}

func TestFormatExportCellText_PlainString_Untouched(t *testing.T) {
	got := formatExportCellText("plain export payload without timezone marker")
	if got != "plain export payload without timezone marker" {
		t.Fatalf("普通字符串不应被改写，got=%q", got)
	}
}

func TestParseTemporalString_LocalDateTime_NoTimezoneShift(t *testing.T) {
	originalLocal := time.Local
	time.Local = time.FixedZone("UTC+8", 8*60*60)
	defer func() { time.Local = originalLocal }()

	parsed, ok := parseTemporalString("2026-04-07 18:44:32")
	if !ok {
		t.Fatal("parseTemporalString 应成功解析本地日期时间")
	}
	if parsed.Local().Format("2006-01-02 15:04:05") != "2026-04-07 18:44:32" {
		t.Fatalf("无时区时间解析后不应发生偏移，got=%q", parsed.Local().Format("2006-01-02 15:04:05"))
	}
}

func TestParseTemporalString_RFC3339_KeepWallClock(t *testing.T) {
	originalLocal := time.Local
	time.Local = time.FixedZone("UTC+8", 8*60*60)
	defer func() { time.Local = originalLocal }()

	parsed, ok := parseTemporalString("2026-04-07T10:44:32Z")
	if !ok {
		t.Fatal("parseTemporalString 应成功解析 RFC3339")
	}
	if parsed.Format("2006-01-02 15:04:05") != "2026-04-07 10:44:32" {
		t.Fatalf("RFC3339 解析后应保持原始钟表时间，got=%q", parsed.Format("2006-01-02 15:04:05"))
	}
}

func TestNormalizeExportJSONValue_TimeValue_KeepWallClock(t *testing.T) {
	originalLocal := time.Local
	time.Local = time.FixedZone("UTC+8", 8*60*60)
	defer func() { time.Local = originalLocal }()

	utc := time.Date(2026, 4, 7, 18, 44, 32, 0, time.UTC)
	got := normalizeExportJSONValue(utc)
	if got != "2026-04-07 18:44:32" {
		t.Fatalf("JSON 导出 time.Time 应保持原始钟表时间，want=%q got=%v", "2026-04-07 18:44:32", got)
	}
}

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

func TestVerifyOptionalDriverAgentReadyForExport_RejectsStaleAgent(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	originalResolvePath := resolveOptionalDriverAgentExecutablePathFunc
	originalLanguage := defaultAppTextLanguage
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
		resolveOptionalDriverAgentExecutablePathFunc = originalResolvePath
		setDefaultAppLanguage(originalLanguage)
	})
	setDefaultAppLanguage(i18n.LanguageEnUS)

	resolveOptionalDriverAgentExecutablePathFunc = func(downloadDir string, driverType string) (string, error) {
		return "/tmp/oceanbase-driver-agent", nil
	}
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: "src-stale-agent",
		}, nil
	}

	err := verifyOptionalDriverAgentReadyForExport(connection.ConnectionConfig{Type: "oceanbase"})
	if err == nil {
		t.Fatal("预期旧版 OceanBase driver-agent 被导出前校验拦截")
	}
	expectedDriverName := resolveDriverDisplayName(driverDefinition{Type: "oceanbase"})
	if strings.Contains(err.Error(), "当前导出依赖最新的") {
		t.Fatalf("错误信息不应再直接返回中文原文，got=%q", err.Error())
	}
	if !strings.Contains(err.Error(), "latest "+expectedDriverName+" driver-agent streaming protocol") {
		t.Fatalf("错误信息应说明需要最新的 driver-agent 流式协议，got=%q", err.Error())
	}
}

func TestVerifyOptionalDriverAgentReadyForExport_SkipsBuiltInDriver(t *testing.T) {
	originalResolvePath := resolveOptionalDriverAgentExecutablePathFunc
	t.Cleanup(func() {
		resolveOptionalDriverAgentExecutablePathFunc = originalResolvePath
	})

	resolveOptionalDriverAgentExecutablePathFunc = func(downloadDir string, driverType string) (string, error) {
		t.Fatalf("内置驱动导出不应探测 optional driver-agent 路径")
		return "", nil
	}

	if err := verifyOptionalDriverAgentReadyForExport(connection.ConnectionConfig{Type: "mysql"}); err != nil {
		t.Fatalf("内置驱动导出不应被 optional driver-agent 校验阻断: %v", err)
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

func TestWriteRowsToFile_HTML_EscapeAndStyle(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-*.html")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	data := []map[string]interface{}{
		{
			"name":     "<script>alert(1)</script>",
			"note":     "line1\nline2",
			"nullable": nil,
		},
	}
	columns := []string{"name", "note", "nullable"}

	if err := writeRowsToFile(f, data, columns, ExportFileOptions{Format: "html"}); err != nil {
		t.Fatalf("写入 html 失败: %v", err)
	}

	contentBytes, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取 html 失败: %v", err)
	}
	content := string(contentBytes)

	if !strings.Contains(content, "<!DOCTYPE html>") {
		t.Fatalf("html 导出缺少 doctype: %s", content)
	}
	if !strings.Contains(content, "position: sticky") {
		t.Fatalf("html 导出缺少表头吸顶样式: %s", content)
	}
	if !strings.Contains(content, "tbody tr:nth-child(even)") {
		t.Fatalf("html 导出缺少斑马纹样式: %s", content)
	}
	if !strings.Contains(content, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Fatalf("html 导出未进行 XSS 转义: %s", content)
	}
	if strings.Contains(content, "<script>alert(1)</script>") {
		t.Fatalf("html 导出包含未转义脚本: %s", content)
	}
	if !strings.Contains(content, "line1<br>line2") {
		t.Fatalf("html 导出换行未转为 <br>: %s", content)
	}
	if !strings.Contains(content, "<td></td>") {
		t.Fatalf("html 导出空值显示异常: %s", content)
	}
}

func TestWriteRowsToFile_HTML_EscapeHeader(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-*.html")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	columnName := "<b>name</b>"
	data := []map[string]interface{}{{columnName: "ok"}}
	if err := writeRowsToFile(f, data, []string{columnName}, ExportFileOptions{Format: "html"}); err != nil {
		t.Fatalf("写入 html 失败: %v", err)
	}
	contentBytes, _ := os.ReadFile(f.Name())
	content := string(contentBytes)
	if !strings.Contains(content, "<th>&lt;b&gt;name&lt;/b&gt;</th>") || strings.Contains(content, "<th><b>name</b></th>") {
		t.Fatalf("html 表头未正确转义: %s", content)
	}
}

func TestWriteRowsToFile_XLSX_SplitsByMaxRowsPerSheet(t *testing.T) {
	f, err := os.CreateTemp("", "gonavi-export-*.xlsx")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	data := []map[string]interface{}{
		{"id": 1, "name": "alice"},
		{"id": 2, "name": "bob"},
		{"id": 3, "name": "carol"},
	}
	columns := []string{"id", "name"}

	if err := writeRowsToFile(f, data, columns, ExportFileOptions{
		Format:              "xlsx",
		XLSXMaxRowsPerSheet: 2,
	}); err != nil {
		t.Fatalf("写入 xlsx 失败: %v", err)
	}

	workbook, err := excelize.OpenFile(f.Name())
	if err != nil {
		t.Fatalf("打开 xlsx 失败: %v", err)
	}
	defer workbook.Close()

	sheets := workbook.GetSheetList()
	if len(sheets) != 2 {
		t.Fatalf("sheet 数量异常，want=2 got=%d (%v)", len(sheets), sheets)
	}

	rows1, err := workbook.GetRows("Sheet1")
	if err != nil {
		t.Fatalf("读取 Sheet1 失败: %v", err)
	}
	if len(rows1) != 3 {
		t.Fatalf("Sheet1 行数异常，want=3 got=%d", len(rows1))
	}

	rows2, err := workbook.GetRows("Sheet2")
	if err != nil {
		t.Fatalf("读取 Sheet2 失败: %v", err)
	}
	if len(rows2) != 2 {
		t.Fatalf("Sheet2 行数异常，want=2 got=%d", len(rows2))
	}
	if rows2[1][1] != "carol" {
		t.Fatalf("Sheet2 数据异常，want=%q got=%q", "carol", rows2[1][1])
	}
}

func benchmarkExportRows(rowCount int) ([]map[string]interface{}, []string) {
	columns := []string{"id", "name", "note", "created_at", "status"}
	rows := make([]map[string]interface{}, rowCount)
	for i := 0; i < rowCount; i++ {
		rows[i] = map[string]interface{}{
			"id":         i + 1,
			"name":       "benchmark-user",
			"note":       "plain export payload without timezone marker",
			"created_at": "2026-06-17 12:34:56",
			"status":     "enabled",
		}
	}
	return rows, columns
}

func benchmarkExportRowValues(rowCount int) ([][]interface{}, []string) {
	columns := []string{"id", "name", "note", "created_at", "status"}
	rows := make([][]interface{}, rowCount)
	for i := 0; i < rowCount; i++ {
		rows[i] = []interface{}{
			i + 1,
			"benchmark-user",
			"plain export payload without timezone marker",
			"2026-06-17 12:34:56",
			"enabled",
		}
	}
	return rows, columns
}

func BenchmarkFormatExportCellText_PlainString(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = formatExportCellText("plain export payload without timezone marker")
	}
}

func BenchmarkWriteRowsToFile_XLSX_20000Rows(b *testing.B) {
	rows, columns := benchmarkExportRows(20000)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		f, err := os.CreateTemp("", "gonavi-export-bench-*.xlsx")
		if err != nil {
			b.Fatalf("创建临时文件失败: %v", err)
		}
		name := f.Name()
		if err := writeRowsToFile(f, rows, columns, ExportFileOptions{Format: "xlsx"}); err != nil {
			_ = os.Remove(name)
			b.Fatalf("写入 xlsx 失败: %v", err)
		}
		if err := os.Remove(name); err != nil {
			b.Fatalf("删除临时文件失败: %v", err)
		}
	}
}

func BenchmarkExportQueryResultToFile_XLSX_StreamMap_20000Rows(b *testing.B) {
	rows, columns := benchmarkExportRows(20000)
	streamDB := &fakeStreamExportDB{
		streamCols: columns,
		streamData: rows,
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		f, err := os.CreateTemp("", "gonavi-export-stream-map-*.xlsx")
		if err != nil {
			b.Fatalf("创建临时文件失败: %v", err)
		}
		name := f.Name()
		if _, _, err := exportQueryResultToFile(
			f,
			streamDB,
			connection.ConnectionConfig{Type: "mysql", Timeout: 10},
			"SELECT * FROM users",
			ExportFileOptions{Format: "xlsx"},
			nil,
		); err != nil {
			_ = os.Remove(name)
			b.Fatalf("流式 map 导出失败: %v", err)
		}
		if err := os.Remove(name); err != nil {
			b.Fatalf("删除临时文件失败: %v", err)
		}
	}
}

func BenchmarkExportQueryResultToFile_XLSX_StreamValues_20000Rows(b *testing.B) {
	rows, columns := benchmarkExportRowValues(20000)
	streamDB := &fakeValueStreamExportDB{
		streamCols:   columns,
		streamValues: rows,
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		f, err := os.CreateTemp("", "gonavi-export-stream-values-*.xlsx")
		if err != nil {
			b.Fatalf("创建临时文件失败: %v", err)
		}
		name := f.Name()
		if _, _, err := exportQueryResultToFile(
			f,
			streamDB,
			connection.ConnectionConfig{Type: "mysql", Timeout: 10},
			"SELECT * FROM users",
			ExportFileOptions{Format: "xlsx"},
			nil,
		); err != nil {
			_ = os.Remove(name)
			b.Fatalf("流式值数组导出失败: %v", err)
		}
		if err := os.Remove(name); err != nil {
			b.Fatalf("删除临时文件失败: %v", err)
		}
	}
}

func BenchmarkExportQueryResultToFile_XLSX_StreamGenerated_50000Rows(b *testing.B) {
	streamDB := &fakeGeneratedValueStreamExportDB{
		streamCols: []string{"id", "name", "note", "created_at", "status"},
		rowCount:   50000,
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		f, err := os.CreateTemp("", "gonavi-export-stream-generated-*.xlsx")
		if err != nil {
			b.Fatalf("创建临时文件失败: %v", err)
		}
		name := f.Name()
		if _, _, err := exportQueryResultToFile(
			f,
			streamDB,
			connection.ConnectionConfig{Type: "mysql", Timeout: 10},
			"SELECT * FROM users",
			ExportFileOptions{Format: "xlsx"},
			nil,
		); err != nil {
			_ = os.Remove(name)
			b.Fatalf("流式生成导出失败: %v", err)
		}
		if err := os.Remove(name); err != nil {
			b.Fatalf("删除临时文件失败: %v", err)
		}
	}
}

func BenchmarkDumpTableSQL_SQLBackup_StreamMap_20000Rows(b *testing.B) {
	rows, columns := benchmarkExportRows(20000)
	streamDB := &fakeStreamExportDB{
		streamCols: columns,
		streamData: rows,
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		writer := bufio.NewWriterSize(io.Discard, 1024*1024)
		if err := dumpTableSQL(
			writer,
			streamDB,
			connection.ConnectionConfig{Type: "mysql"},
			"app",
			"users",
			false,
			true,
			map[string]string{},
		); err != nil {
			b.Fatalf("SQL 备份导出失败: %v", err)
		}
		if err := writer.Flush(); err != nil {
			b.Fatalf("flush SQL 备份失败: %v", err)
		}
	}
}

func BenchmarkDumpTableSQL_SQLBackup_StreamValues_20000Rows(b *testing.B) {
	rows, columns := benchmarkExportRowValues(20000)
	streamDB := &fakeValueStreamExportDB{
		streamCols:   columns,
		streamValues: rows,
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		writer := bufio.NewWriterSize(io.Discard, 1024*1024)
		if err := dumpTableSQL(
			writer,
			streamDB,
			connection.ConnectionConfig{Type: "mysql"},
			"app",
			"users",
			false,
			true,
			map[string]string{},
		); err != nil {
			b.Fatalf("SQL 备份导出失败: %v", err)
		}
		if err := writer.Flush(); err != nil {
			b.Fatalf("flush SQL 备份失败: %v", err)
		}
	}
}

func TestFormatImportSQLValue_NormalizesTimestampWithoutTimezone(t *testing.T) {
	got := formatImportSQLValue("postgres", "timestamp without time zone", "2026-01-21T18:32:26+08:00")
	if got != "'2026-01-21 18:32:26'" {
		t.Fatalf("时间字面量归一化异常，want=%q got=%q", "'2026-01-21 18:32:26'", got)
	}
}

func TestFormatImportSQLValue_LeavesTextLiteralUntouched(t *testing.T) {
	got := formatImportSQLValue("postgres", "text", "2026-01-21T18:32:26+08:00")
	if got != "'2026-01-21T18:32:26+08:00'" {
		t.Fatalf("文本字段不应被归一化，want=%q got=%q", "'2026-01-21T18:32:26+08:00'", got)
	}
}

func TestFormatImportSQLValue_MySQLHexLookingTextRemainsText(t *testing.T) {
	got := formatImportSQLValue("mysql", "varchar(32)", "0xDEADBEEF")
	if got != "'0xDEADBEEF'" {
		t.Fatalf("hex-looking text must remain quoted during import, got %q", got)
	}
}

func TestFormatImportSQLValue_PostgresBooleanColumnUsesBooleanLiteral(t *testing.T) {
	cases := []struct {
		name       string
		dbType     string
		columnType string
		value      interface{}
		want       string
	}{
		{name: "postgres bool true", dbType: "postgres", columnType: "boolean", value: true, want: "true"},
		{name: "postgres bool false", dbType: "postgres", columnType: "bool", value: false, want: "false"},
		{name: "pg catalog bool string", dbType: "postgres", columnType: "pg_catalog.bool", value: "t", want: "true"},
		{name: "highgo boolean bytes", dbType: "highgo", columnType: "boolean", value: []byte("0"), want: "false"},
		{name: "mysql keeps numeric bool", dbType: "mysql", columnType: "tinyint(1)", value: true, want: "1"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := formatImportSQLValue(tc.dbType, tc.columnType, tc.value)
			if got != tc.want {
				t.Fatalf("布尔字面量异常，want=%q got=%q", tc.want, got)
			}
		})
	}
}

func TestDumpTableSQL_PostgresBooleanBackupUsesBooleanLiterals(t *testing.T) {
	fake := &fakeExportQueryDB{
		data: []map[string]interface{}{
			{"active": true, "archived": false},
		},
		cols: []string{"active", "archived"},
		defs: []connection.ColumnDefinition{
			{Name: "active", Type: "boolean"},
			{Name: "archived", Type: "bool"},
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		writer,
		fake,
		connection.ConnectionConfig{Type: "postgres"},
		"public",
		"orders",
		false,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL 返回错误: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush 导出 SQL 失败: %v", err)
	}

	content := buf.String()
	if !strings.Contains(content, `INSERT INTO "public"."orders" ("active", "archived") VALUES (true, false);`) {
		t.Fatalf("PostgreSQL bool 备份应使用 true/false 字面量，content=%s", content)
	}
	if strings.Contains(content, "VALUES (1, 0)") {
		t.Fatalf("PostgreSQL bool 备份不应输出数字布尔值，content=%s", content)
	}
}

func TestDumpTableSQL_PostgresBackupExportIncludesEscapedTableComment(t *testing.T) {
	fake := &fakePostgresCommentExportDB{
		fakeSQLDumpExportDB: fakeSQLDumpExportDB{
			fakeExportQueryDB: fakeExportQueryDB{
				defs: []connection.ColumnDefinition{{Name: "ID", Type: "bigint", Nullable: "NO"}},
			},
			createSQL: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.",
		},
		tableComment: "Owner's archive\\path\n第二行",
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		writer,
		fake,
		connection.ConnectionConfig{Type: "postgres"},
		"app",
		`"Sales.Schema"."Order.Items"`,
		true,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush exported SQL: %v", err)
	}

	content := buf.String()
	for _, want := range []string{
		`CREATE TABLE "Sales.Schema"."Order.Items"`,
		"COMMENT ON TABLE \"Sales.Schema\".\"Order.Items\" IS 'Owner''s archive\\path\n第二行';",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("expected PostgreSQL backup export to contain %q, got %s", want, content)
		}
	}
	if fake.tableCommentCalls != 1 || fake.commentSchema != "Sales.Schema" || fake.commentTable != "Order.Items" {
		t.Fatalf("unexpected table-comment metadata target: calls=%d target=%q.%q", fake.tableCommentCalls, fake.commentSchema, fake.commentTable)
	}
}

func TestDumpTableSQL_PostgresSchemaExportOmitsEmptyTableComment(t *testing.T) {
	fake := &fakePostgresCommentExportDB{
		fakeSQLDumpExportDB: fakeSQLDumpExportDB{
			fakeExportQueryDB: fakeExportQueryDB{
				defs: []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO"}},
			},
			createSQL: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.",
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	if err := dumpTableSQL(
		writer,
		fake,
		connection.ConnectionConfig{Type: "postgres"},
		"app",
		"public.orders",
		true,
		false,
		map[string]string{},
	); err != nil {
		t.Fatalf("dumpTableSQL returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush exported SQL: %v", err)
	}

	if content := buf.String(); strings.Contains(content, "COMMENT ON TABLE") {
		t.Fatalf("empty PostgreSQL table comment should not emit DDL, got %s", content)
	}
	if fake.tableCommentCalls != 1 {
		t.Fatalf("expected one table-comment metadata lookup, got %d", fake.tableCommentCalls)
	}
}

func TestDumpTableSQL_MySQLBackupBatchesRowsIntoMultiValueInsert(t *testing.T) {
	fake := &fakeValueStreamExportDB{
		streamCols: []string{"id", "name"},
		streamValues: [][]interface{}{
			{1, "alice"},
			{2, "bob"},
			{3, "carol"},
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		writer,
		fake,
		connection.ConnectionConfig{Type: "mysql"},
		"app",
		"users",
		false,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL 返回错误: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush 导出 SQL 失败: %v", err)
	}

	content := buf.String()
	if strings.Count(content, "INSERT INTO `app`.`users`") != 1 {
		t.Fatalf("MySQL 备份应合并为单条批量 INSERT，content=%s", content)
	}
	if !strings.Contains(content, "VALUES (1, 'alice'),\n(2, 'bob'),\n(3, 'carol');") {
		t.Fatalf("MySQL 批量 INSERT 内容异常，content=%s", content)
	}
}

func TestDumpTableSQL_OracleBackupBatchesRowsIntoInsertAll(t *testing.T) {
	fake := &fakeValueStreamExportDB{
		streamCols: []string{"id", "name"},
		streamValues: [][]interface{}{
			{1, "alice"},
			{2, "bob"},
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		writer,
		fake,
		connection.ConnectionConfig{Type: "oracle"},
		"APP",
		"USERS",
		false,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL 返回错误: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush 导出 SQL 失败: %v", err)
	}

	content := buf.String()
	if strings.Count(content, "INSERT ALL") != 1 {
		t.Fatalf("Oracle 备份应合并为单条 INSERT ALL，content=%s", content)
	}
	if !strings.Contains(content, "INTO \"APP\".\"USERS\" (\"id\", \"name\") VALUES (1, 'alice')\n  INTO \"APP\".\"USERS\" (\"id\", \"name\") VALUES (2, 'bob')\nSELECT 1 FROM DUAL;") {
		t.Fatalf("Oracle INSERT ALL 内容异常，content=%s", content)
	}
}

func TestNormalizeExportFileOptionsPreservesSQLDatabaseOptions(t *testing.T) {
	normalized := normalizeExportFileOptions("sql", ExportFileOptions{
		Format:                 " SQL ",
		IncludeDropIfExists:    true,
		IncludeDatabaseContext: true,
	})

	if normalized.Format != "sql" {
		t.Fatalf("expected normalized SQL format, got %q", normalized.Format)
	}
	if !normalized.IncludeDropIfExists {
		t.Fatal("expected IncludeDropIfExists to survive option normalization")
	}
	if !normalized.IncludeDatabaseContext {
		t.Fatal("expected IncludeDatabaseContext to survive option normalization")
	}
}

func TestWriteSQLDropIfExistsPreambleDefaultsOffAndRequiresSchemaExport(t *testing.T) {
	config := connection.ConnectionConfig{Type: "mysql"}
	objects := []string{"users"}

	for _, tc := range []struct {
		name          string
		includeSchema bool
		options       ExportFileOptions
	}{
		{name: "default off", includeSchema: true, options: ExportFileOptions{}},
		{name: "data only", includeSchema: false, options: ExportFileOptions{IncludeDropIfExists: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			writer := bufio.NewWriter(&output)
			if err := writeSQLDropIfExistsPreamble(
				writer,
				config,
				"app",
				objects,
				map[string]string{},
				tc.includeSchema,
				tc.options,
			); err != nil {
				t.Fatalf("writeSQLDropIfExistsPreamble returned error: %v", err)
			}
			if err := writer.Flush(); err != nil {
				t.Fatalf("flush drop preamble: %v", err)
			}
			if output.Len() != 0 {
				t.Fatalf("drop preamble must be omitted, got %q", output.String())
			}
		})
	}
}

func TestExportDatabaseSQLToFileDefaultOptionsDoNotEmitDropsOrDatabaseContext(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		tables:    []string{"users"},
		createSQL: "CREATE TABLE `users` (`id` BIGINT)",
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	app := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}

	legacyFile, err := os.CreateTemp(t.TempDir(), "legacy-export-*.sql")
	if err != nil {
		t.Fatalf("create legacy export file: %v", err)
	}
	legacyPath := legacyFile.Name()
	if err := legacyFile.Close(); err != nil {
		t.Fatalf("close legacy export file: %v", err)
	}
	legacyResult := app.exportDatabaseSQLToFile(config, "app", false, legacyPath, ExportFileOptions{})
	if !legacyResult.Success {
		t.Fatalf("legacy export failed: %+v", legacyResult)
	}
	legacyContent, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("read legacy export: %v", err)
	}
	if strings.Contains(string(legacyContent), "DROP TABLE") {
		t.Fatalf("default/legacy export must not emit DROP statements: %s", legacyContent)
	}
	if strings.Contains(string(legacyContent), "CREATE DATABASE") || strings.Contains(string(legacyContent), "USE `app`;") {
		t.Fatalf("default export must not emit database context statements: %s", legacyContent)
	}

	optInFile, err := os.CreateTemp(t.TempDir(), "drop-export-*.sql")
	if err != nil {
		t.Fatalf("create opt-in export file: %v", err)
	}
	optInPath := optInFile.Name()
	if err := optInFile.Close(); err != nil {
		t.Fatalf("close opt-in export file: %v", err)
	}
	contextFreeDropResult := app.exportDatabaseSQLToFile(
		config,
		"app",
		false,
		optInPath,
		ExportFileOptions{IncludeDropIfExists: true},
	)
	if !contextFreeDropResult.Success {
		t.Fatalf("context-free DROP export failed: %+v", contextFreeDropResult)
	}
	optInContent, err := os.ReadFile(optInPath)
	if err != nil {
		t.Fatalf("read opt-in export: %v", err)
	}
	dropIndex := strings.Index(string(optInContent), "DROP TABLE IF EXISTS `users`;")
	createIndex := strings.Index(string(optInContent), "CREATE TABLE `users`")
	if dropIndex < 0 || createIndex < 0 || dropIndex >= createIndex {
		t.Fatalf("context-free export must place unqualified DROP before CREATE: %s", optInContent)
	}
	if strings.Contains(string(optInContent), "`app`.`users`") {
		t.Fatalf("context-free export must not qualify output objects with the source database: %s", optInContent)
	}
}

func TestExportDatabaseSQLToFileDatabaseContextIsExplicitOptIn(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		fakeExportQueryDB: fakeExportQueryDB{
			data: []map[string]interface{}{{"id": int64(1)}},
			cols: []string{"id"},
			defs: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
		},
		tables:    []string{"users"},
		createSQL: "CREATE TABLE `users` (`id` BIGINT)",
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	app := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}

	contextFreePath := filepath.Join(t.TempDir(), "context-free.sql")
	contextFreeResult := app.exportDatabaseSQLToFile(
		config,
		"app",
		true,
		contextFreePath,
		ExportFileOptions{IncludeDropIfExists: true},
	)
	if !contextFreeResult.Success {
		t.Fatalf("context-free export failed: %+v", contextFreeResult)
	}
	contextFreeContent, err := os.ReadFile(contextFreePath)
	if err != nil {
		t.Fatalf("read context-free export: %v", err)
	}
	contextFreeSQL := string(contextFreeContent)
	for _, unexpected := range []string{
		"CREATE DATABASE",
		"USE `app`;",
		"DROP TABLE IF EXISTS `app`.`users`;",
		"INSERT INTO `app`.`users`",
	} {
		if strings.Contains(contextFreeSQL, unexpected) {
			t.Fatalf("context-free export must not contain %q: %s", unexpected, contextFreeSQL)
		}
	}
	for _, expected := range []string{
		"DROP TABLE IF EXISTS `users`;",
		"INSERT INTO `users` (`id`) VALUES (1);",
	} {
		if !strings.Contains(contextFreeSQL, expected) {
			t.Fatalf("context-free export must contain %q: %s", expected, contextFreeSQL)
		}
	}
	if !slices.Contains(fakeDB.queries, "SELECT * FROM `app`.`users`") {
		t.Fatalf("context-free output must still read from the source database, queries=%#v", fakeDB.queries)
	}

	contextPath := filepath.Join(t.TempDir(), "with-context.sql")
	contextResult := app.exportDatabaseSQLToFile(
		config,
		"app",
		true,
		contextPath,
		ExportFileOptions{
			IncludeDropIfExists:    true,
			IncludeDatabaseContext: true,
		},
	)
	if !contextResult.Success {
		t.Fatalf("database-context export failed: %+v", contextResult)
	}
	contextContent, err := os.ReadFile(contextPath)
	if err != nil {
		t.Fatalf("read database-context export: %v", err)
	}
	contextSQL := string(contextContent)
	orderedStatements := []string{
		"CREATE DATABASE IF NOT EXISTS `app`;",
		"USE `app`;",
		"DROP TABLE IF EXISTS `app`.`users`;",
		"CREATE TABLE `users`",
		"INSERT INTO `app`.`users` (`id`) VALUES (1);",
	}
	previousIndex := -1
	for _, statement := range orderedStatements {
		index := strings.Index(contextSQL, statement)
		if index < 0 || index <= previousIndex {
			t.Fatalf("database-context export statement order is invalid at %q: %s", statement, contextSQL)
		}
		previousIndex = index
	}
}

func TestExportDatabaseSQLToFileReportsObjectProgress(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		tables:    []string{"users", "orders"},
		createSQL: "CREATE TABLE `placeholder` (`id` BIGINT)",
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	emitter := &captureExportProgressEmitter{}
	app := NewApp()
	app.ctx = uievents.WithEmitter(context.Background(), emitter)
	filePath := filepath.Join(t.TempDir(), "app_backup.sql")

	result := app.exportDatabaseSQLToFile(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app",
		false,
		filePath,
		ExportFileOptions{Format: "sql", JobID: "database-backup-job"},
	)
	if !result.Success {
		t.Fatalf("database export failed: %+v", result)
	}
	if len(emitter.events) < 4 {
		t.Fatalf("expected start/running/finalizing/done events, got %#v", emitter.events)
	}
	statuses := make([]string, 0, len(emitter.events))
	for _, event := range emitter.events {
		statuses = append(statuses, event.Status)
		if event.JobID != "database-backup-job" {
			t.Fatalf("unexpected progress job id: %#v", event)
		}
		if event.FilePath != filePath {
			t.Fatalf("progress must expose selected backup path: %#v", event)
		}
	}
	for _, want := range []string{"start", "running", "finalizing", "done"} {
		if !slices.Contains(statuses, want) {
			t.Fatalf("missing %q progress status in %v", want, statuses)
		}
	}
	itemEvents := make([]exportProgressPayload, 0, 2)
	for _, event := range emitter.events {
		if event.Status == "running" && (strings.Contains(event.Stage, "users") || strings.Contains(event.Stage, "orders")) {
			itemEvents = append(itemEvents, event)
		}
	}
	if len(itemEvents) != 2 || itemEvents[0].Current != 0 || itemEvents[1].Current != 1 {
		t.Fatalf("expected one running event per object with completed-object counts, got %#v", itemEvents)
	}
	last := emitter.events[len(emitter.events)-1]
	if !last.TotalRowsKnown || last.Total != 2 || last.Current != 2 {
		t.Fatalf("done progress must report all exported objects: %#v", last)
	}
}

func TestExportDatabaseSQLToFilePreservesExistingBackupOnFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		tables:    []string{"users"},
		createErr: fmt.Errorf("forced create statement failure"),
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	directory := t.TempDir()
	filePath := filepath.Join(directory, "app_backup.sql")
	const previousBackup = "-- previous complete backup\n"
	if err := os.WriteFile(filePath, []byte(previousBackup), 0o600); err != nil {
		t.Fatalf("write previous backup: %v", err)
	}

	result := NewApp().exportDatabaseSQLToFile(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app",
		false,
		filePath,
		ExportFileOptions{Format: "sql"},
	)
	if result.Success {
		t.Fatalf("expected export failure, got %+v", result)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read preserved backup: %v", err)
	}
	if string(content) != previousBackup {
		t.Fatalf("failed export must preserve previous backup, got %q", content)
	}
	temporaryFiles, err := filepath.Glob(filepath.Join(directory, ".gonavi-export-*.part"))
	if err != nil {
		t.Fatalf("glob temporary export files: %v", err)
	}
	if len(temporaryFiles) != 0 {
		t.Fatalf("failed export must remove temporary files, got %v", temporaryFiles)
	}
}

func TestWriteSQLDropIfExistsPreambleReversesCreateOrderAndDistinguishesViews(t *testing.T) {
	config := connection.ConnectionConfig{Type: "mysql"}
	objects := []string{"accounts", "orders", "active_orders"}
	viewLookup := map[string]string{
		normalizeExportObjectKey(config, "app", "active_orders"): "active_orders",
	}
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)

	if err := writeSQLDropIfExistsPreamble(
		writer,
		config,
		"app",
		objects,
		viewLookup,
		true,
		ExportFileOptions{IncludeDropIfExists: true},
	); err != nil {
		t.Fatalf("writeSQLDropIfExistsPreamble returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush drop preamble: %v", err)
	}

	content := output.String()
	wantStatements := []string{
		"DROP VIEW IF EXISTS `app`.`active_orders`;",
		"DROP TABLE IF EXISTS `app`.`orders`;",
		"DROP TABLE IF EXISTS `app`.`accounts`;",
	}
	previousIndex := -1
	for _, statement := range wantStatements {
		index := strings.Index(content, statement)
		if index < 0 {
			t.Fatalf("drop preamble is missing %q: %s", statement, content)
		}
		if index <= previousIndex {
			t.Fatalf("drop statements do not follow reverse create order: %s", content)
		}
		previousIndex = index
	}
}

func TestBuildSQLDropIfExistsStatementKeepsOracleBackwardCompatible(t *testing.T) {
	statement := buildSQLDropIfExistsStatement(
		connection.ConnectionConfig{Type: "oracle"},
		"APP",
		"USERS",
		false,
	)

	for _, fragment := range []string{
		`EXECUTE IMMEDIATE 'DROP TABLE "APP"."USERS"'`,
		"IF SQLCODE != -942 THEN",
		"END;\n/",
	} {
		if !strings.Contains(statement, fragment) {
			t.Fatalf("Oracle drop block is missing %q: %s", fragment, statement)
		}
	}

	statements := splitSQLStatementsForDialect("oracle", statement+"\nCREATE TABLE \"APP\".\"USERS\" (\"ID\" NUMBER);")
	if len(statements) != 2 {
		t.Fatalf("Oracle drop block must remain one executable statement before CREATE, got %#v", statements)
	}
	if !strings.Contains(statements[0], `EXECUTE IMMEDIATE 'DROP TABLE "APP"."USERS"'`) {
		t.Fatalf("unexpected Oracle drop statement after splitting: %#v", statements)
	}
}

func TestBuildSQLDropIfExistsStatementUsesDropTableForClickHouseViews(t *testing.T) {
	statement := buildSQLDropIfExistsStatement(
		connection.ConnectionConfig{Type: "clickhouse"},
		"analytics",
		"events_by_hour",
		true,
	)

	if want := "DROP TABLE IF EXISTS `analytics`.`events_by_hour`;"; statement != want {
		t.Fatalf("ClickHouse view drop statement mismatch: got %q, want %q", statement, want)
	}
}

func TestWriteSQLDatabaseBackupHeaderCreatesMySQLDatabaseBeforeSelectingIt(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)

	if err := writeSQLDatabaseBackupHeader(writer, connection.ConnectionConfig{Type: "mysql"}, "restore_target"); err != nil {
		t.Fatalf("writeSQLDatabaseBackupHeader returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush header: %v", err)
	}

	content := output.String()
	createIndex := strings.Index(content, "CREATE DATABASE IF NOT EXISTS `restore_target`;")
	useIndex := strings.Index(content, "USE `restore_target`;")
	if createIndex < 0 {
		t.Fatalf("database backup header must create the source database, content=%q", content)
	}
	if useIndex < 0 || createIndex > useIndex {
		t.Fatalf("database backup header must create the database before USE, content=%q", content)
	}
}

func TestFilterExportObjectsBySchema_PostgresQualifiedObjectsOnly(t *testing.T) {
	got := filterExportObjectsBySchema(
		connection.ConnectionConfig{Type: "postgres"},
		"app_db",
		[]string{"public.users", "sales.orders", "sales.v_orders", "analytics.events"},
		"sales",
	)

	want := []string{"sales.orders", "sales.v_orders"}
	if len(got) != len(want) {
		t.Fatalf("filtered objects length mismatch, want=%d got=%d (%v)", len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("filtered objects mismatch at %d, want=%q got=%q", i, want[i], got[i])
		}
	}
}

func TestFilterExportViewLookupBySchema_PostgresQualifiedViewsOnly(t *testing.T) {
	got := filterExportViewLookupBySchema(
		connection.ConnectionConfig{Type: "postgres"},
		"app_db",
		map[string]string{
			"public.v_users":  "public.v_users",
			"sales.v_orders":  "sales.v_orders",
			"sales.v_summary": "sales.v_summary",
		},
		"sales",
	)

	if len(got) != 2 {
		t.Fatalf("filtered views length mismatch, want=2 got=%d (%v)", len(got), got)
	}
	if got["sales.v_orders"] != "sales.v_orders" {
		t.Fatalf("expected sales.v_orders to be retained, got=%q", got["sales.v_orders"])
	}
	if got["sales.v_summary"] != "sales.v_summary" {
		t.Fatalf("expected sales.v_summary to be retained, got=%q", got["sales.v_summary"])
	}
	if _, ok := got["public.v_users"]; ok {
		t.Fatalf("expected public.v_users to be filtered out, got=%v", got)
	}
}

func TestWriteSQLSchemaExportHeaderPostgresCreatesQuotedSchema(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := writeSQLSchemaExportHeader(
		writer,
		connection.ConnectionConfig{Type: "postgres"},
		"app_db",
		`Sales"Ops`,
	); err != nil {
		t.Fatalf("write postgres schema export header: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush postgres schema export header: %v", err)
	}

	content := output.String()
	if !strings.Contains(content, `-- Schema: Sales"Ops`) {
		t.Fatalf("schema export header must describe the selected schema, content=%q", content)
	}
	if !strings.Contains(content, `CREATE SCHEMA IF NOT EXISTS "Sales""Ops";`) {
		t.Fatalf("schema export header must bootstrap the quoted schema, content=%q", content)
	}
	databaseIndex := strings.Index(content, "-- Database: app_db")
	schemaIndex := strings.Index(content, `-- Schema: Sales"Ops`)
	createIndex := strings.Index(content, `CREATE SCHEMA IF NOT EXISTS "Sales""Ops";`)
	if databaseIndex < 0 || schemaIndex < databaseIndex || createIndex < schemaIndex {
		t.Fatalf("schema bootstrap must follow the database and schema metadata, content=%q", content)
	}
}

func TestWriteSQLSchemaExportHeaderDoesNotBootstrapNonPostgresSchema(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := writeSQLSchemaExportHeader(
		writer,
		connection.ConnectionConfig{Type: "mysql"},
		"app_db",
		"sales",
	); err != nil {
		t.Fatalf("write non-postgres schema export header: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush non-postgres schema export header: %v", err)
	}

	if strings.Contains(output.String(), "CREATE SCHEMA") {
		t.Fatalf("non-postgres schema export must not inject postgres bootstrap SQL, content=%q", output.String())
	}
}
