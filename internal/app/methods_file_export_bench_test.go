package app

import (
	"bufio"
	"context"
	"io"
	"os"
	"testing"

	"GoNavi-Wails/internal/connection"
)

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
			context.Background(),
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
			context.Background(),
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
