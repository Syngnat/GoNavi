package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

type fakeExportQueryDB struct {
	data []map[string]interface{}
	cols []string
	err  error

	lastQuery          string
	lastContextTimeout time.Duration
	hasContextDeadline bool
}

func (f *fakeExportQueryDB) Connect(config connection.ConnectionConfig) error { return nil }
func (f *fakeExportQueryDB) Close() error                                     { return nil }
func (f *fakeExportQueryDB) Ping() error                                      { return nil }
func (f *fakeExportQueryDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.lastQuery = query
	return f.data, f.cols, f.err
}
func (f *fakeExportQueryDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.lastQuery = query
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
	return nil, nil
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

func TestFormatExportCellText_FloatNoScientificNotation(t *testing.T) {
	got := formatExportCellText(1.445663e+06)
	if strings.Contains(strings.ToLower(got), "e+") || strings.Contains(strings.ToLower(got), "e-") {
		t.Fatalf("不应输出科学计数法，got=%q", got)
	}
	if got != "1445663" {
		t.Fatalf("浮点整值导出异常，want=%q got=%q", "1445663", got)
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

	if err := writeRowsToFile(f, data, columns, "md"); err != nil {
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

	if err := writeRowsToFile(f, data, columns, "json"); err != nil {
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

	if err := writeRowsToFile(f, data, columns, "html"); err != nil {
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
	if !strings.Contains(content, "<td>NULL</td>") {
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
	if err := writeRowsToFile(f, data, []string{columnName}, "html"); err != nil {
		t.Fatalf("写入 html 失败: %v", err)
	}
	contentBytes, _ := os.ReadFile(f.Name())
	content := string(contentBytes)
	if !strings.Contains(content, "<th>&lt;b&gt;name&lt;/b&gt;</th>") || strings.Contains(content, "<th><b>name</b></th>") {
		t.Fatalf("html 表头未正确转义: %s", content)
	}
}
