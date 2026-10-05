package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

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
