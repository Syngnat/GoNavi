package app

import (
	"archive/zip"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"

	"github.com/xuri/excelize/v2"
)

func TestXLSXExportWorkbookViewIsValid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "views.xlsx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	if err := writeRowsToFile(file, []map[string]interface{}{{"id": 1}}, []string{"id"}, ExportFileOptions{Format: "xlsx"}); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	var workbook struct {
		XMLName xml.Name `xml:"http://schemas.openxmlformats.org/spreadsheetml/2006/main workbook"`
		Views   []struct {
			Attributes []xml.Attr `xml:",any,attr"`
		} `xml:"bookViews>workbookView"`
	}
	if err := xml.Unmarshal(readXLSXExportPart(t, path, "xl/workbook.xml"), &workbook); err != nil {
		t.Fatal(err)
	}
	if len(workbook.Views) != 1 {
		t.Fatalf("workbook views = %d, want 1", len(workbook.Views))
	}
	for _, attribute := range workbook.Views[0].Attributes {
		if attribute.Name.Local == "workbookViewId" {
			t.Error("workbookViewId is a sheetView attribute, not a valid workbookView attribute; strict XLSX readers reject it")
		}
	}

	var worksheet struct {
		Views []struct {
			WorkbookViewID *int `xml:"workbookViewId,attr"`
		} `xml:"sheetViews>sheetView"`
	}
	if err := xml.Unmarshal(readXLSXExportPart(t, path, "xl/worksheets/sheet1.xml"), &worksheet); err != nil {
		t.Fatal(err)
	}
	if len(worksheet.Views) != 1 || worksheet.Views[0].WorkbookViewID == nil || *worksheet.Views[0].WorkbookViewID != 0 {
		t.Fatalf("sheetView must keep its reference to workbook view 0: %+v", worksheet.Views)
	}
}

func TestXLSXExportRowsRoundTrip(t *testing.T) {
	columns := []string{"id", "amount", "name", "code", "bigint", "precise", "nullable"}
	values := [][]interface{}{
		{int64(1), float64(12.5), "alice", "0012", int64(9007199254740993), json.Number("0.1234567890123456"), nil},
		{int64(0), float64(-0.1), "中文 & <test>", "0024", uint64(18446744073709551615), json.Number("12.50"), "end"},
		{int64(-42), float32(0), "tail"},
	}
	rows := makeXLSXExportRows(columns, values)
	for _, route := range []string{"buffered", "fallback", "map-stream", "value-stream"} {
		for _, selected := range []bool{false, true} {
			for _, maxRows := range []int{0, 1} {
				name := fmt.Sprintf("%s/selected=%t/maxRows=%d", route, selected, maxRows)
				t.Run(name, func(t *testing.T) {
					options := ExportFileOptions{Format: "xlsx", XLSXMaxRowsPerSheet: maxRows, ColumnComments: map[string]string{"id": "编号", "name": "姓名"}}
					if selected {
						options.Columns = []string{"name", "amount", "id", "code", "bigint", "precise", "nullable"}
					}
					path := filepath.Join(t.TempDir(), "result.xlsx")
					file, err := os.Create(path)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { _ = file.Close() })
					if route == "buffered" {
						err = writeRowsToFile(file, rows, columns, options)
					} else {
						var count int64
						var actualColumns []string
						count, actualColumns, err = exportQueryResultToFile(file, newXLSXExportSource(route, columns, rows, values), connection.ConnectionConfig{Type: "mysql"}, "SELECT * FROM fixture", options, nil)
						if count != int64(len(values)) {
							t.Errorf("exported rows = %d, want %d", count, len(values))
						}
						wantColumns := columns
						if selected {
							wantColumns = options.Columns
						}
						if !reflect.DeepEqual(actualColumns, wantColumns) {
							t.Errorf("exported columns = %v, want %v", actualColumns, wantColumns)
						}
					}
					if err != nil {
						t.Fatal(err)
					}
					if err := file.Close(); err != nil {
						t.Fatal(err)
					}
					assertXLSXExportRecords(t, path, selected, maxRows)
				})
			}
		}
	}
}

func makeXLSXExportRows(columns []string, values [][]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, len(values))
	for rowIndex, record := range values {
		row := make(map[string]interface{}, len(record))
		for index, value := range record {
			row[columns[index]] = value
		}
		rows[rowIndex] = row
	}
	return rows
}

func newXLSXExportSource(route string, columns []string, rows []map[string]interface{}, values [][]interface{}) db.Database {
	switch route {
	case "map-stream":
		return &fakeStreamExportDB{streamCols: columns, streamData: rows}
	case "value-stream":
		return &fakeValueStreamExportDB{streamCols: columns, streamValues: values}
	default:
		return &fakeExportQueryDB{cols: columns, data: rows}
	}
}

func assertXLSXExportRecords(t *testing.T, path string, selected bool, maxRows int) {
	t.Helper()
	book, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = book.Close() })
	headers := []string{"编号", "amount", "姓名", "code", "bigint", "precise", "nullable"}
	wantRows := [][]string{
		{"1", "12.5", "alice", "0012", "9007199254740993", "0.1234567890123456", ""},
		{"0", "-0.1", "中文 & <test>", "0024", "18446744073709551615", "12.50", "end"},
		{"-42", "0", "tail", "", "", "", ""},
	}
	if selected {
		headers[0], headers[2] = headers[2], headers[0]
		for _, row := range wantRows {
			row[0], row[2] = row[2], row[0]
		}
	}
	sheets := book.GetSheetList()
	wantSheetCount := 1
	if maxRows == 1 {
		wantSheetCount = len(wantRows)
	}
	if len(sheets) != wantSheetCount {
		t.Fatalf("sheets = %v, want %d sheets", sheets, wantSheetCount)
	}
	for _, sheet := range sheets {
		rows, err := book.GetRows(sheet, excelize.Options{RawCellValue: true})
		if err != nil {
			t.Fatal(err)
		}
		wantRowCount := len(wantRows) + 1
		if maxRows == 1 {
			wantRowCount = 2
		}
		if len(rows) != wantRowCount {
			t.Errorf("%s rows = %d, want %d including header", sheet, len(rows), wantRowCount)
		}
		for column, want := range headers {
			cell, err := excelize.CoordinatesToCellName(column+1, 1)
			if err != nil {
				t.Fatal(err)
			}
			assertXLSXExportCell(t, book, sheet, cell, want, excelize.CellTypeInlineString)
		}
	}
	for index, row := range wantRows {
		sheet, rowNumber := sheets[0], index+2
		if maxRows == 1 {
			sheet, rowNumber = sheets[index], 2
		}
		for column, want := range row {
			cell, err := excelize.CoordinatesToCellName(column+1, rowNumber)
			if err != nil {
				t.Fatal(err)
			}
			cellType := excelize.CellTypeInlineString
			if column == 1 || (!selected && column == 0) || (selected && column == 2) {
				cellType = excelize.CellTypeNumber
			}
			assertXLSXExportCell(t, book, sheet, cell, want, cellType)
		}
	}
}

func assertXLSXExportCell(t *testing.T, book *excelize.File, sheet, cell, want string, wantType excelize.CellType) {
	t.Helper()
	got, err := book.GetCellValue(sheet, cell, excelize.Options{RawCellValue: true})
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("%s!%s = %q, want %q", sheet, cell, got, want)
	}
	gotType, err := book.GetCellType(sheet, cell)
	if err != nil {
		t.Fatal(err)
	}
	// OOXML defaults an omitted t attribute to numeric; Excelize reports it as unset.
	defaultNumeric := wantType == excelize.CellTypeNumber && gotType == excelize.CellTypeUnset
	if gotType != wantType && !defaultNumeric {
		t.Errorf("%s!%s cell type = %v, want %v", sheet, cell, gotType, wantType)
	}
}

func readXLSXExportPart(t *testing.T, path, name string) []byte {
	t.Helper()
	archive, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	part, err := archive.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer part.Close()
	body, err := io.ReadAll(part)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
