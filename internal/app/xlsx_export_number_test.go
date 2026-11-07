package app

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestXLSXNumericCellLiteral(t *testing.T) {
	cases := []struct {
		text string
		want string
		ok   bool
	}{
		{text: "0", want: "0", ok: true},
		{text: "1", want: "1", ok: true},
		{text: "-42", want: "-42", ok: true},
		{text: "1.25", want: "1.25", ok: true},
		{text: "12.50", ok: false},
		{text: "1445663", want: "1445663", ok: true},
		{text: "0.1", want: "0.1", ok: true},
		{text: "-0.1", want: "-0.1", ok: true},
		{text: "-12.50", ok: false},
		{text: "12.5000000000000000", ok: false},
		{text: "42.0", ok: false},
		{text: "1.00", ok: false},
		{text: "999999999999999", want: "999999999999999", ok: true},
		{text: "-999999999999999", want: "-999999999999999", ok: true},
		{text: "999999999999999.0", ok: false},
		{text: "99999999999999.9", want: "99999999999999.9", ok: true},
		{text: "0.123456789012345", want: "0.123456789012345", ok: true},
		{text: "0.000000123456789012345", want: "0.000000123456789012345", ok: true},
		{text: "1000000000000000", ok: false},
		{text: "-1000000000000000", ok: false},
		{text: "1000000000000000.0", ok: false},
		{text: "1000000000000000000", ok: false},
		{text: "9007199254740991", ok: false},
		{text: "9007199254740992", ok: false},
		{text: "9007199254740993", ok: false},
		{text: "1000000000000000100", ok: false},
		{text: "0.1234567890123456", ok: false},
		{text: "-1000000000000000100", ok: false},
		{text: "1000000000000000100.0", ok: false},
		{text: "-1000000000000000100.0", ok: false},
		{text: "18446744073709551615", ok: false},
		{text: "9223372036854775807", ok: false},
		{text: "-9223372036854775808", ok: false},
		{text: "999999999999999.9", ok: false},
		{text: "-0.1234567890123456", ok: false},
		{text: "1.234567890123456", ok: false},
		{text: "1.0000000000000001", ok: false},
		{text: "0012", ok: false},
		{text: "-0012", ok: false},
		{text: "00.5", ok: false},
		{text: "1e3", ok: false},
		{text: "1.0000000000000001e18", ok: false},
		{text: "-1.0000000000000001E+18", ok: false},
		{text: "=1+1", ok: false},
		{text: "+12", ok: false},
		{text: "NaN", ok: false},
		{text: "Inf", ok: false},
		{text: "alice", ok: false},
		{text: "", ok: false},
		{text: "1.2.3", ok: false},
	}
	for _, tc := range cases {
		t.Run(tc.text, func(t *testing.T) {
			got, ok := xlsxNumericCellLiteral(tc.text)
			if ok != tc.ok || got != tc.want {
				t.Errorf("xlsxNumericCellLiteral(%q) = %q, %v; want %q, %v", tc.text, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestWriteRowsToFile_XLSXNumericCellsAreValues(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "numeric-*.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	data := []map[string]interface{}{{
		"id":     1,
		"amount": 12.5,
		"code":   "0012",
		"huge":   "9007199254740993",
		"name":   "alice",
		"bigint": int64(1000000000000000100),
		"wide":   "0.1234567890123456",
	}}
	columns := []string{"id", "amount", "code", "huge", "name", "bigint", "wide"}
	if err := writeRowsToFile(f, data, columns, ExportFileOptions{Format: "xlsx"}); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	sheet := readXLSXSheetXML(t, f.Name())
	for _, want := range []string{
		`<c r="A2"><v>1</v></c>`,
		`<c r="B2"><v>12.5</v></c>`,
		`<c r="C2" t="inlineStr"><is><t>0012</t></is></c>`,
		`<c r="D2" t="inlineStr"><is><t>9007199254740993</t></is></c>`,
		`<c r="E2" t="inlineStr"><is><t>alice</t></is></c>`,
		`<c r="F2" t="inlineStr"><is><t>1000000000000000100</t></is></c>`,
		`<c r="G2" t="inlineStr"><is><t>0.1234567890123456</t></is></c>`,
	} {
		if !strings.Contains(sheet, want) {
			t.Fatalf("sheet missing %s\n%s", want, sheet)
		}
	}

	book, err := excelize.OpenFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer book.Close()
	rows, err := book.GetRows("Sheet1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || strings.Join(rows[1], ",") != "1,12.5,0012,9007199254740993,alice,1000000000000000100,0.1234567890123456" {
		t.Fatalf("rows = %#v", rows)
	}
}

func TestWriteRowsToFile_XLSXPrecisionPolicy(t *testing.T) {
	cases := []struct {
		name    string
		value   interface{}
		want    string
		numeric bool
	}{
		{name: "ordinary integer", value: 42, want: "42", numeric: true},
		{name: "ordinary decimal", value: "12.50", want: "12.50"},
		{name: "binary inexact decimal", value: "0.1", want: "0.1", numeric: true},
		{name: "negative decimal", value: "-12.50", want: "-12.50"},
		{name: "trailing fractional zeros", value: "12.5000000000000000", want: "12.5000000000000000"},
		{name: "formatted amount", value: "1.00", want: "1.00"},
		{name: "15 digit integer", value: int64(999999999999999), want: "999999999999999", numeric: true},
		{name: "negative 15 digit integer", value: int64(-999999999999999), want: "-999999999999999", numeric: true},
		{name: "15 digit integer decimal", value: "999999999999999.0", want: "999999999999999.0"},
		{name: "15 significant decimal digits", value: "0.000000123456789012345", want: "0.000000123456789012345", numeric: true},
		{name: "16 digit integer", value: int64(1000000000000000), want: "1000000000000000"},
		{name: "negative 16 digit integer", value: int64(-1000000000000000), want: "-1000000000000000"},
		{name: "16 digit integer decimal", value: "1000000000000000.0", want: "1000000000000000.0"},
		{name: "float64 safe integer boundary", value: int64(9007199254740991), want: "9007199254740991"},
		{name: "float64 exact integer boundary", value: int64(9007199254740992), want: "9007199254740992"},
		{name: "float64 rounded integer", value: int64(9007199254740993), want: "9007199254740993"},
		{name: "negative bigint", value: int64(-1000000000000000100), want: "-1000000000000000100"},
		{name: "bigint decimal", value: "1000000000000000100.0", want: "1000000000000000100.0"},
		{name: "negative bigint decimal", value: "-1000000000000000100.0", want: "-1000000000000000100.0"},
		{name: "unsigned maximum", value: uint64(18446744073709551615), want: "18446744073709551615"},
		{name: "wide decimal", value: "0.1234567890123456", want: "0.1234567890123456"},
		{name: "negative wide decimal", value: "-0.1234567890123456", want: "-0.1234567890123456"},
		{name: "leading zero identifier", value: "0012", want: "0012"},
		{name: "negative leading zero identifier", value: "-0012", want: "-0012"},
		{name: "ordinary exponent stays text", value: "1e3", want: "1e3"},
		{name: "bigint exponent stays text", value: "1.0000000000000001e18", want: "1.0000000000000001e18"},
		{name: "formula stays text", value: "=1+1", want: "=1+1"},
	}
	// One column per case keeps the column-level text rule from hiding the
	// per-value policy: a single text value would otherwise make the column text.
	columns := make([]string, len(cases))
	row := make(map[string]interface{}, len(cases))
	for i, tc := range cases {
		columns[i] = fmt.Sprintf("col%02d", i)
		row[columns[i]] = tc.value
	}
	data := []map[string]interface{}{row}
	f, err := os.CreateTemp(t.TempDir(), "precision-*.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := writeRowsToFile(f, data, columns, ExportFileOptions{Format: "xlsx"}); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	sheet := readXLSXSheetXML(t, f.Name())
	book, err := excelize.OpenFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer book.Close()
	for i, header := range columns {
		column, err := excelize.ColumnNumberToName(i + 1)
		if err != nil {
			t.Fatal(err)
		}
		cell := column + "1"
		want := fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, cell, header)
		if !strings.Contains(sheet, want) {
			t.Errorf("header %s is not original inline text: missing %s", cell, want)
		}
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			column, err := excelize.ColumnNumberToName(i + 1)
			if err != nil {
				t.Fatal(err)
			}
			cell := column + "2"
			want := fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, cell, tc.want)
			if tc.numeric {
				want = fmt.Sprintf(`<c r="%s"><v>%s</v></c>`, cell, tc.want)
			}
			if !strings.Contains(sheet, want) {
				t.Errorf("serialized cell missing %s", want)
			}
			got, err := book.GetCellValue("Sheet1", cell, excelize.Options{RawCellValue: true})
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("readback %s = %q, want %q", cell, got, tc.want)
			}
			formula, err := book.GetCellFormula("Sheet1", cell)
			if err != nil || formula != "" {
				t.Errorf("formula %s = %q, %v; want no formula", cell, formula, err)
			}
		})
	}
}

func TestWriteRowsToFile_XLSXTextColumnKeepsEveryCellText(t *testing.T) {
	data := []map[string]interface{}{
		{"code": "0001", "amount": "1.5", "mixed": "42"},
		{"code": "1.00", "amount": "2", "mixed": "abc"},
	}
	f, err := os.CreateTemp(t.TempDir(), "text-column-*.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRowsToFile(f, data, []string{"code", "amount", "mixed"}, ExportFileOptions{Format: "xlsx"}); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	sheet := readXLSXSheetXML(t, f.Name())
	for _, want := range []string{
		`<c r="A2" t="inlineStr"><is><t>0001</t></is></c>`,
		`<c r="A3" t="inlineStr"><is><t>1.00</t></is></c>`,
		`<c r="B2"><v>1.5</v></c>`,
		`<c r="B3"><v>2</v></c>`,
		`<c r="C2" t="inlineStr"><is><t>42</t></is></c>`,
		`<c r="C3" t="inlineStr"><is><t>abc</t></is></c>`,
	} {
		if !strings.Contains(sheet, want) {
			t.Errorf("sheet missing %s\n%s", want, sheet)
		}
	}
}

func readXLSXSheetXML(t *testing.T, path string) string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	for _, entry := range zr.File {
		if entry.Name != "xl/worksheets/sheet1.xml" {
			continue
		}
		rc, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	t.Fatal("sheet1.xml missing")
	return ""
}
