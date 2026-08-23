package app

import (
	"archive/zip"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type xlsxTestEntry struct {
	body   string
	method uint16
}

func writeXLSXTestArchive(t *testing.T, entries map[string]xlsxTestEntry) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.xlsx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create xlsx: %v", err)
	}
	writer := zip.NewWriter(file)
	for name, entry := range entries {
		header := &zip.FileHeader{Name: name, Method: entry.method}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("create xlsx entry %s: %v", name, err)
		}
		if _, err := part.Write([]byte(entry.body)); err != nil {
			t.Fatalf("write xlsx entry %s: %v", name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close xlsx zip: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close xlsx file: %v", err)
	}
	return path
}

func minimalXLSXTestEntries(sharedStrings string, sheet string) map[string]xlsxTestEntry {
	return map[string]xlsxTestEntry{
		xlsxWorkbookXMLPath: {
			body:   `<workbook xmlns:r="urn:test"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			method: zip.Store,
		},
		xlsxWorkbookRelsXMLPath: {
			body:   `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
			method: zip.Store,
		},
		"xl/worksheets/sheet1.xml": {body: sheet, method: zip.Store},
		xlsxSharedStringsXML:       {body: sharedStrings, method: zip.Store},
	}
}

func TestXLSXImportRejectsOversizedSharedString(t *testing.T) {
	tempRoot := t.TempDir()
	t.Setenv("TMP", tempRoot)
	t.Setenv("TEMP", tempRoot)
	t.Setenv("TMPDIR", tempRoot)
	sharedStrings := `<sst><si><t>payload</t></si><si><t>` + strings.Repeat("x", maxImportCellBytes+1) + `</t></si></sst>`
	sheet := `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`
	path := writeXLSXTestArchive(t, minimalXLSXTestEntries(sharedStrings, sheet))

	_, err := buildImportPreview(path, 5)
	if err == nil {
		t.Fatal("oversized shared string must be rejected")
	}
	if !strings.Contains(err.Error(), "shared string") || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("unexpected shared-string limit error: %v", err)
	}
	entries, err := os.ReadDir(tempRoot)
	if err != nil {
		t.Fatalf("read XLSX temp directory: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "gonavi-xlsx-shared-strings-") {
			t.Fatalf("temporary shared-string file leaked after parse failure: %s", entry.Name())
		}
	}
}

func TestXLSXPreviewDoesNotParseSharedStringsBeyondRowLimit(t *testing.T) {
	tempRoot := t.TempDir()
	t.Setenv("TMP", tempRoot)
	t.Setenv("TEMP", tempRoot)
	t.Setenv("TMPDIR", tempRoot)
	sharedStrings := `<sst>` +
		`<si><t>id</t></si><si><t>1</t></si><si><t>2</t></si><si><t>3</t></si><si><t>4</t></si><si><t>5</t></si>` +
		`<si><t>malformed tail`
	sheet := `<worksheet><sheetData>` +
		`<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
		`<row r="2"><c r="A2" t="s"><v>1</v></c></row>` +
		`<row r="3"><c r="A3" t="s"><v>2</v></c></row>` +
		`<row r="4"><c r="A4" t="s"><v>3</v></c></row>` +
		`<row r="5"><c r="A5" t="s"><v>4</v></c></row>` +
		`<row r="6"><c r="A6" t="s"><v>5</v></c></row>` +
		`<row r="7"><c r="A7" t="s"><v>6</v></c></row>` +
		`</sheetData></worksheet>`
	path := writeXLSXTestArchive(t, minimalXLSXTestEntries(sharedStrings, sheet))

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("preview parsed shared-string tail beyond row limit: %v", err)
	}
	if preview.TotalRows != 5 || preview.TotalRowsKnown {
		t.Fatalf("unexpected short preview result: %#v", preview)
	}
	entries, err := os.ReadDir(tempRoot)
	if err != nil {
		t.Fatalf("read XLSX temp directory: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "gonavi-xlsx-shared-strings-") {
			t.Fatalf("temporary shared-string file leaked after preview short-circuit: %s", entry.Name())
		}
	}
}

func TestXLSXImportRejectsRowOverCombinedByteLimit(t *testing.T) {
	largeValue := strings.Repeat("x", 13*1024*1024)
	sharedStrings := `<sst>` +
		`<si><t>c1</t></si><si><t>c2</t></si><si><t>c3</t></si><si><t>c4</t></si><si><t>c5</t></si>` +
		`<si><t>` + largeValue + `</t></si></sst>`
	sheet := `<worksheet><sheetData>` +
		`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>` +
		`<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" t="s"><v>5</v></c><c r="D2" t="s"><v>5</v></c><c r="E2" t="s"><v>5</v></c></row>` +
		`</sheetData></worksheet>`
	path := writeXLSXTestArchive(t, minimalXLSXTestEntries(sharedStrings, sheet))

	_, err := buildImportPreview(path, 5)
	if err == nil {
		t.Fatal("XLSX row over the combined byte limit must be rejected")
	}
	if !strings.Contains(err.Error(), "row 2") || !strings.Contains(err.Error(), "byte limit") {
		t.Fatalf("unexpected XLSX row limit error: %v", err)
	}
}

func TestXLSXSharedStringStoreRejectsCountOverLimitAndCleansTempFile(t *testing.T) {
	store, err := newXLSXSharedStringStoreWithLimits(2, maxImportCellBytes)
	if err != nil {
		t.Fatalf("create shared-string store: %v", err)
	}
	tempPath := store.path
	if err := store.Add("one"); err != nil {
		t.Fatalf("add first shared string: %v", err)
	}
	if err := store.Add("two"); err != nil {
		t.Fatalf("add second shared string: %v", err)
	}
	if err := store.Add("three"); err == nil || !strings.Contains(err.Error(), "count exceeds") {
		t.Fatalf("third shared string error = %v, want count limit", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close shared-string store: %v", err)
	}
	if _, err := os.Stat(tempPath); !os.IsNotExist(err) {
		t.Fatalf("temporary shared-string file still exists after close: %v", err)
	}
}

func TestXLSXImportRejectsEntryOverUncompressedByteLimit(t *testing.T) {
	entries := minimalXLSXTestEntries(
		`<sst><si><t>id</t></si></sst>`,
		`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
	)
	path := writeXLSXTestArchive(t, entries)
	limits := defaultXLSXArchiveResourceLimits
	limits.MaxEntryUncompressedBytes = 32

	err := streamXLSXImportFileWithLimits(path, newImportPreviewCollector(5), limits)
	if err == nil {
		t.Fatal("XLSX entry over the uncompressed byte limit must be rejected")
	}
	if !strings.Contains(err.Error(), "entry") || !strings.Contains(err.Error(), "uncompressed") {
		t.Fatalf("unexpected entry limit error: %v", err)
	}
}

func TestXLSXImportRejectsArchiveOverTotalUncompressedByteLimit(t *testing.T) {
	entries := minimalXLSXTestEntries(
		`<sst><si><t>id</t></si></sst>`,
		`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
	)
	path := writeXLSXTestArchive(t, entries)
	limits := defaultXLSXArchiveResourceLimits
	limits.MaxEntryUncompressedBytes = 1 << 20
	limits.MaxTotalUncompressedBytes = 64

	err := streamXLSXImportFileWithLimits(path, newImportPreviewCollector(5), limits)
	if err == nil {
		t.Fatal("XLSX archive over the total uncompressed byte limit must be rejected")
	}
	if !strings.Contains(err.Error(), "total uncompressed") {
		t.Fatalf("unexpected total uncompressed limit error: %v", err)
	}
}

func TestXLSXImportRejectsEntryOverCompressionRatioLimit(t *testing.T) {
	entries := minimalXLSXTestEntries(
		`<sst><si><t>id</t></si></sst>`,
		`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
	)
	entries["xl/media/highly-compressible.bin"] = xlsxTestEntry{
		body:   strings.Repeat("x", 4096),
		method: zip.Deflate,
	}
	path := writeXLSXTestArchive(t, entries)
	limits := defaultXLSXArchiveResourceLimits
	limits.MaxEntryUncompressedBytes = 1 << 20
	limits.MaxTotalUncompressedBytes = 1 << 20
	limits.MaxCompressionRatio = 2

	err := streamXLSXImportFileWithLimits(path, newImportPreviewCollector(5), limits)
	if err == nil {
		t.Fatal("XLSX entry over the compression ratio limit must be rejected")
	}
	if !strings.Contains(err.Error(), "compression ratio") {
		t.Fatalf("unexpected compression ratio error: %v", err)
	}
}

func TestXLSXImportSelectsConfiguredSheet(t *testing.T) {
	entries := map[string]xlsxTestEntry{
		xlsxWorkbookXMLPath: {
			body: `<workbook xmlns:r="urn:test"><sheets>` +
				`<sheet name="Summary" sheetId="1" r:id="rId1"/>` +
				`<sheet name="Data" sheetId="2" r:id="rId2"/>` +
				`</sheets></workbook>`,
			method: zip.Store,
		},
		xlsxWorkbookRelsXMLPath: {
			body: `<Relationships>` +
				`<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
				`<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>` +
				`</Relationships>`,
			method: zip.Store,
		},
		"xl/worksheets/sheet1.xml": {
			body:   inlineStringXLSXSheet([][]string{{"summary"}, {"not data"}}),
			method: zip.Store,
		},
		"xl/worksheets/sheet2.xml": {
			body:   inlineStringXLSXSheet([][]string{{"id", "name"}, {"1", "alice"}}),
			method: zip.Store,
		},
	}
	path := writeXLSXTestArchive(t, entries)
	consumer := &importCollectConsumer{}
	if err := streamImportFileWithOptions(path, consumer, ImportFileOptions{SheetName: "Data"}); err != nil {
		t.Fatalf("stream selected worksheet: %v", err)
	}
	if !reflect.DeepEqual(consumer.columns, []string{"id", "name"}) {
		t.Fatalf("columns = %#v", consumer.columns)
	}
	if !reflect.DeepEqual(consumer.rows, []map[string]interface{}{{"id": "1", "name": "alice"}}) {
		t.Fatalf("rows = %#v", consumer.rows)
	}
}

func TestXLSXImportUsesConfiguredHeaderRow(t *testing.T) {
	entries := minimalXLSXTestEntries(
		`<sst></sst>`,
		inlineStringXLSXSheet([][]string{{"exported by GoNavi"}, {"id", "name"}, {"1", "alice"}}),
	)
	path := writeXLSXTestArchive(t, entries)
	consumer := &importCollectConsumer{}
	if err := streamImportFileWithOptions(path, consumer, ImportFileOptions{HeaderRow: 2}); err != nil {
		t.Fatalf("stream XLSX with second header row: %v", err)
	}
	if !reflect.DeepEqual(consumer.columns, []string{"id", "name"}) {
		t.Fatalf("columns = %#v", consumer.columns)
	}
	if !reflect.DeepEqual(consumer.rows, []map[string]interface{}{{"id": "1", "name": "alice"}}) {
		t.Fatalf("rows = %#v", consumer.rows)
	}
}

func TestXLSXImportSharedStringLookupAfterOutOfOrderAccess(t *testing.T) {
	sharedStrings := `<sst>` +
		`<si><t>row-one</t></si>` +
		`<si><t>row-two</t></si>` +
		`<si><t>name</t></si>` +
		`<si><t>row-three</t></si>` +
		`</sst>`
	sheet := `<worksheet><sheetData>` +
		`<row r="1"><c r="A1" t="s"><v>2</v></c></row>` +
		`<row r="2"><c r="A2" t="s"><v>0</v></c></row>` +
		`<row r="3"><c r="A3" t="s"><v>3</v></c></row>` +
		`</sheetData></worksheet>`
	path := writeXLSXTestArchive(t, minimalXLSXTestEntries(sharedStrings, sheet))

	consumer := &importCollectConsumer{}
	if err := streamImportFile(path, consumer); err != nil {
		t.Fatalf("stream XLSX with out-of-order shared strings: %v", err)
	}
	want := []map[string]interface{}{{"name": "row-one"}, {"name": "row-three"}}
	if !reflect.DeepEqual(consumer.rows, want) {
		t.Fatalf("rows = %#v, want %#v", consumer.rows, want)
	}
}

func TestXLSXImportRejectsDataRowWiderThanHeader(t *testing.T) {
	entries := minimalXLSXTestEntries(
		`<sst></sst>`,
		inlineStringXLSXSheet([][]string{{"id", "name"}, {"1", "alice", "unexpected"}}),
	)
	path := writeXLSXTestArchive(t, entries)
	consumer := &importCollectConsumer{}

	err := streamImportFile(path, consumer)
	if err == nil {
		t.Fatal("XLSX data row wider than its header must be rejected")
	}
	if !strings.Contains(err.Error(), "row 2") || !strings.Contains(err.Error(), "3 columns") || !strings.Contains(err.Error(), "2-column header") {
		t.Fatalf("unexpected wide-row error: %v", err)
	}
	if len(consumer.rows) != 0 {
		t.Fatalf("wide row reached import consumer: %#v", consumer.rows)
	}
}

func TestXLSXPreviewAndImportConvertStyledDateAndTimeSerials(t *testing.T) {
	entries := minimalXLSXTestEntries(
		`<sst></sst>`,
		`<worksheet><sheetData>`+
			`<row r="1">`+
			`<c r="A1" t="inlineStr"><is><t>created_on</t></is></c>`+
			`<c r="B1" t="inlineStr"><is><t>at_time</t></is></c>`+
			`<c r="C1" t="inlineStr"><is><t>created_at</t></is></c>`+
			`<c r="D1" t="inlineStr"><is><t>precise_time</t></is></c>`+
			`</row>`+
			`<row r="2">`+
			`<c r="A2" s="1"><v>45293</v></c>`+
			`<c r="B2" s="2"><v>0.5</v></c>`+
			`<c r="C2" s="3"><v>45293.75</v></c>`+
			`<c r="D2" s="4"><v>45293.04309170139</v></c>`+
			`</row>`+
			`</sheetData></worksheet>`,
	)
	entries["xl/styles.xml"] = xlsxTestEntry{
		body: `<styleSheet>` +
			`<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss.000"/></numFmts>` +
			`<cellXfs count="5">` +
			`<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="21"/><xf numFmtId="164"/><xf numFmtId="165"/>` +
			`</cellXfs>` +
			`</styleSheet>`,
		method: zip.Store,
	}
	path := writeXLSXTestArchive(t, entries)
	want := map[string]interface{}{
		"created_on":   "2024-01-02",
		"at_time":      "12:00:00",
		"created_at":   "2024-01-02 18:00:00",
		"precise_time": "2024-01-02 01:02:03.123",
	}

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("preview styled XLSX values: %v", err)
	}
	if !reflect.DeepEqual(preview.PreviewRows, []map[string]interface{}{want}) {
		t.Fatalf("preview rows = %#v, want %#v", preview.PreviewRows, []map[string]interface{}{want})
	}

	consumer := &importCollectConsumer{}
	if err := streamImportFile(path, consumer); err != nil {
		t.Fatalf("import styled XLSX values: %v", err)
	}
	if !reflect.DeepEqual(consumer.rows, preview.PreviewRows) {
		t.Fatalf("import rows = %#v, preview rows = %#v", consumer.rows, preview.PreviewRows)
	}
}

func TestXLSXImportUsesWorkbook1904DateSystem(t *testing.T) {
	entries := minimalXLSXTestEntries(
		`<sst></sst>`,
		`<worksheet><sheetData>`+
			`<row r="1"><c r="A1" t="inlineStr"><is><t>created_at</t></is></c></row>`+
			`<row r="2"><c r="A2" s="1"><v>1.25</v></c></row>`+
			`</sheetData></worksheet>`,
	)
	entries[xlsxWorkbookXMLPath] = xlsxTestEntry{
		body: `<workbook xmlns:r="urn:test"><workbookPr date1904="1"/>` +
			`<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		method: zip.Store,
	}
	entries["xl/styles.xml"] = xlsxTestEntry{
		body:   `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="22"/></cellXfs></styleSheet>`,
		method: zip.Store,
	}
	path := writeXLSXTestArchive(t, entries)
	consumer := &importCollectConsumer{}

	if err := streamImportFile(path, consumer); err != nil {
		t.Fatalf("import XLSX using 1904 date system: %v", err)
	}
	want := []map[string]interface{}{{"created_at": "1904-01-02 06:00:00"}}
	if !reflect.DeepEqual(consumer.rows, want) {
		t.Fatalf("rows = %#v, want %#v", consumer.rows, want)
	}
}

func inlineStringXLSXSheet(rows [][]string) string {
	var builder strings.Builder
	builder.WriteString(`<worksheet><sheetData>`)
	for rowIndex, row := range rows {
		builder.WriteString(`<row r="`)
		builder.WriteString(strconv.Itoa(rowIndex + 1))
		builder.WriteString(`">`)
		for columnIndex, value := range row {
			builder.WriteString(`<c r="`)
			builder.WriteString(string(rune('A' + columnIndex)))
			builder.WriteString(strconv.Itoa(rowIndex + 1))
			builder.WriteString(`" t="inlineStr"><is><t>`)
			builder.WriteString(value)
			builder.WriteString(`</t></is></c>`)
		}
		builder.WriteString(`</row>`)
	}
	builder.WriteString(`</sheetData></worksheet>`)
	return builder.String()
}

// TestXLSXCellRefColumnIndexRejectsOutOfRangeColumns 覆盖 xlsx 单元格 r 属性的列号上限。
//
// 回归背景：列号原先无任何上限。单元格的 r 属性完全来自文件内容且可被任意篡改，
// 形如 <c r="ZZZZZZZZ1"/> 会解析出约 2.2e11 的列号，直接驱动 readXLSXRow 的 slice
// 填充循环分配 TB 级内存，使整个桌面进程被 OOM 杀死——9 字节属性即可放大到 TB 级。
// 超限时返回 0，由调用方回退到顺序列号。
func TestXLSXCellRefColumnIndexRejectsOutOfRangeColumns(t *testing.T) {
	cases := []struct {
		ref  string
		want int
	}{
		// 合法范围内的既有行为必须保持不变。
		{ref: "A1", want: 1},
		{ref: "B2", want: 2},
		{ref: "Z1", want: 26},
		{ref: "AA1", want: 27},
		{ref: "a1", want: 1},
		{ref: "XFD1", want: xlsxMaxColumns}, // OOXML 最后一列
		{ref: "", want: 0},
		{ref: "1", want: 0},

		// 超出 OOXML 上限：一律判为非法。
		{ref: "XFE1", want: 0},
		{ref: "ZZZZZ1", want: 0},
		{ref: "ZZZZZZZZ1", want: 0},
		{ref: "ZZZZZZZZZZZZ1", want: 0},
	}

	for _, tc := range cases {
		if got := xlsxCellRefColumnIndex(tc.ref); got != tc.want {
			t.Errorf("xlsxCellRefColumnIndex(%q) = %d，期望 %d", tc.ref, got, tc.want)
		}
	}
}

// TestXLSXCellRefColumnIndexDoesNotOverflow 断言超长纯字母引用不会因持续累加而溢出成
// 正数或负数（溢出成正数会绕过上限守卫，溢出成负数会命中调用方的 <=0 回退但掩盖问题）。
func TestXLSXCellRefColumnIndexDoesNotOverflow(t *testing.T) {
	long := ""
	for i := 0; i < 64; i++ {
		long += "Z"
	}
	if got := xlsxCellRefColumnIndex(long + "1"); got != 0 {
		t.Fatalf("64 个 Z 的引用返回 %d，期望 0（存在整型溢出或未熔断）", got)
	}
}
