package app

import (
	"archive/zip"
	"bufio"
	"compress/flate"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/xuri/excelize/v2"
)

const (
	xlsxMainNamespace          = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
	xlsxRelationshipsNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
	xlsxPackageRelationshipsNS = "http://schemas.openxmlformats.org/package/2006/relationships"
	xlsxWorksheetType          = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
	xlsxStylesType             = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
	xlsxThemeType              = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
	xlsxWorkbookContentType    = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
	xlsxWorksheetContentType   = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
	xlsxStylesContentType      = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"
	xlsxThemeContentType       = "application/vnd.openxmlformats-officedocument.theme+xml"
	xlsxCoreContentType        = "application/vnd.openxmlformats-package.core-properties+xml"
	xlsxAppContentType         = "application/vnd.openxmlformats-officedocument.extended-properties+xml"
)

var (
	xlsxTemplatePartsOnce sync.Once
	xlsxTemplateParts     map[string][]byte
	xlsxTemplatePartsErr  error
	xlsxZipCopyBufferPool = sync.Pool{
		New: func() interface{} {
			return make([]byte, 1024*1024)
		},
	}
)

type xlsxExportTempSheet struct {
	name   string
	path   string
	file   io.WriteCloser
	writer *bufio.Writer
	closed bool
}

type xlsxExportOutputFile interface {
	io.Writer
	Truncate(size int64) error
	Seek(offset int64, whence int) (int64, error)
}

type xlsxExportWriteOptions struct {
	tempDir string
	budget  *webTransferBudget
}

type xlsxExportFileWriter struct {
	file       xlsxExportOutputFile
	tempDir    string
	budget     *webTransferBudget
	columns    []string
	columnRefs []string
	rowBuf     []string
	sheets     []*xlsxExportTempSheet
	current    *xlsxExportTempSheet
	nextRow    int
	sheetNo    int
	rowCount   int
	maxRows    int
}

func newXLSXExportFileWriter(f xlsxExportOutputFile, maxRowsPerSheet int, writeOptions ...xlsxExportWriteOptions) (*xlsxExportFileWriter, error) {
	if f == nil {
		return nil, fmt.Errorf("file required")
	}
	options := xlsxExportWriteOptions{}
	if len(writeOptions) > 0 {
		options = writeOptions[0]
	}
	return &xlsxExportFileWriter{
		file:    f,
		tempDir: options.tempDir,
		budget:  options.budget,
		maxRows: normalizeXLSXRowsPerSheet(maxRowsPerSheet),
	}, nil
}

func (w *xlsxExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	w.columnRefs = make([]string, len(columns))
	w.rowBuf = make([]string, len(columns))
	for i := range columns {
		ref, err := excelize.ColumnNumberToName(i + 1)
		if err != nil {
			return err
		}
		w.columnRefs[i] = ref
	}
	return w.rotateSheet()
}

func (w *xlsxExportFileWriter) rotateSheet() error {
	if err := w.closeCurrentSheet(); err != nil {
		return err
	}

	tmpFile, err := os.CreateTemp(w.tempDir, "gonavi-export-sheet-*.xml")
	if err != nil {
		return err
	}
	var sheetFile io.WriteCloser = tmpFile
	if w.budget != nil {
		managed, managedErr := newWebTransferFile(tmpFile, w.budget)
		if managedErr != nil {
			_ = tmpFile.Close()
			_ = os.Remove(tmpFile.Name())
			return managedErr
		}
		sheetFile = managed
	}

	sheet := &xlsxExportTempSheet{
		name:   fmt.Sprintf("Sheet%d", w.sheetNo+1),
		path:   tmpFile.Name(),
		file:   sheetFile,
		writer: bufio.NewWriterSize(sheetFile, 1024*256),
	}
	if err := writeXLSXSheetHeader(sheet.writer); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpFile.Name())
		return err
	}

	w.sheetNo++
	w.current = sheet
	w.sheets = append(w.sheets, sheet)
	w.rowCount = 0
	w.nextRow = 2
	return w.writeStringRow(1, w.columns)
}

func (w *xlsxExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	if w.rowCount >= w.maxRows {
		if err := w.rotateSheet(); err != nil {
			return err
		}
	}

	values := w.rowBuf
	for i, col := range w.columns {
		val := row[col]
		if val == nil {
			values[i] = ""
			continue
		}
		values[i] = formatExportCellText(val)
	}
	if err := w.writeStringRow(w.nextRow, values); err != nil {
		return err
	}
	w.nextRow++
	w.rowCount++
	return nil
}

func (w *xlsxExportFileWriter) ConsumeRowValues(values []interface{}) error {
	if w.rowCount >= w.maxRows {
		if err := w.rotateSheet(); err != nil {
			return err
		}
	}

	record := w.rowBuf
	for i := range w.columns {
		var value interface{}
		if i < len(values) {
			value = values[i]
		}
		if value == nil {
			record[i] = ""
			continue
		}
		record[i] = formatExportCellText(value)
	}
	if err := w.writeStringRow(w.nextRow, record); err != nil {
		return err
	}
	w.nextRow++
	w.rowCount++
	return nil
}

func (w *xlsxExportFileWriter) Close() error {
	if err := w.closeCurrentSheet(); err != nil {
		_ = w.cleanupTempSheets()
		return err
	}
	if len(w.sheets) == 0 {
		return w.cleanupTempSheets()
	}

	if err := w.file.Truncate(0); err != nil {
		_ = w.cleanupTempSheets()
		return err
	}
	if _, err := w.file.Seek(0, 0); err != nil {
		_ = w.cleanupTempSheets()
		return err
	}

	zw := zip.NewWriter(w.file)
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestSpeed)
	})

	if err := writeXLSXZipFile(zw, w.sheets); err != nil {
		_ = zw.Close()
		_ = w.cleanupTempSheets()
		return err
	}
	zipErr := zw.Close()
	cleanupErr := w.cleanupTempSheets()
	if zipErr != nil {
		return zipErr
	}
	return cleanupErr
}

func (w *xlsxExportFileWriter) closeCurrentSheet() error {
	if w.current == nil || w.current.closed {
		return nil
	}
	if _, err := w.current.writer.WriteString(`</sheetData></worksheet>`); err != nil {
		return err
	}
	if err := w.current.writer.Flush(); err != nil {
		return err
	}
	if err := w.current.file.Close(); err != nil {
		return err
	}
	w.current.closed = true
	w.current = nil
	return nil
}

func (w *xlsxExportFileWriter) cleanupTempSheets() error {
	var firstErr error
	for _, sheet := range w.sheets {
		if sheet == nil {
			continue
		}
		if !sheet.closed && sheet.file != nil {
			if err := sheet.writer.Flush(); err != nil && firstErr == nil {
				firstErr = err
			}
			if err := sheet.file.Close(); err != nil && firstErr == nil {
				firstErr = err
			}
			sheet.closed = true
		}
		if sheet.path != "" {
			if err := os.Remove(sheet.path); err != nil && !os.IsNotExist(err) && firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

func (w *xlsxExportFileWriter) writeStringRow(rowNumber int, values []string) error {
	if w.current == nil {
		return fmt.Errorf("xlsx sheet not initialized")
	}

	if _, err := w.current.writer.WriteString(`<row r="`); err != nil {
		return err
	}
	if _, err := w.current.writer.WriteString(strconv.Itoa(rowNumber)); err != nil {
		return err
	}
	if _, err := w.current.writer.WriteString(`">`); err != nil {
		return err
	}
	rowRef := strconv.Itoa(rowNumber)
	for i, value := range values {
		if err := writeXLSXInlineStringCell(w.current.writer, w.columnRefs[i], rowRef, value); err != nil {
			return err
		}
	}
	_, err := w.current.writer.WriteString(`</row>`)
	return err
}

func writeXLSXZipFile(zw *zip.Writer, sheets []*xlsxExportTempSheet) error {
	parts, err := loadXLSXTemplateParts()
	if err != nil {
		return err
	}

	if err := writeZipBytes(zw, "[Content_Types].xml", buildXLSXContentTypes(len(sheets))); err != nil {
		return err
	}
	if err := writeZipBytes(zw, "_rels/.rels", parts["_rels/.rels"]); err != nil {
		return err
	}
	if err := writeZipBytes(zw, "docProps/app.xml", parts["docProps/app.xml"]); err != nil {
		return err
	}
	if err := writeZipBytes(zw, "docProps/core.xml", parts["docProps/core.xml"]); err != nil {
		return err
	}
	if err := writeZipBytes(zw, "xl/workbook.xml", buildXLSXWorkbookXML(sheets)); err != nil {
		return err
	}
	if err := writeZipBytes(zw, "xl/_rels/workbook.xml.rels", buildXLSXWorkbookRels(sheets)); err != nil {
		return err
	}
	if err := writeZipBytes(zw, "xl/styles.xml", parts["xl/styles.xml"]); err != nil {
		return err
	}
	if err := writeZipBytes(zw, "xl/theme/theme1.xml", parts["xl/theme/theme1.xml"]); err != nil {
		return err
	}
	for idx, sheet := range sheets {
		if err := writeZipFileFromPath(zw, fmt.Sprintf("xl/worksheets/sheet%d.xml", idx+1), sheet.path); err != nil {
			return err
		}
	}
	return nil
}

func loadXLSXTemplateParts() (map[string][]byte, error) {
	xlsxTemplatePartsOnce.Do(func() {
		workbook := excelize.NewFile()
		defer workbook.Close()

		required := []string{
			"_rels/.rels",
			"docProps/app.xml",
			"docProps/core.xml",
			"xl/styles.xml",
			"xl/theme/theme1.xml",
		}
		xlsxTemplateParts = make(map[string][]byte, len(required))
		for _, path := range required {
			value, ok := workbook.Pkg.Load(path)
			if !ok {
				xlsxTemplatePartsErr = fmt.Errorf("xlsx template part missing: %s", path)
				return
			}
			xlsxTemplateParts[path] = append([]byte(nil), value.([]byte)...)
		}
	})
	return xlsxTemplateParts, xlsxTemplatePartsErr
}

func writeZipBytes(zw *zip.Writer, name string, content []byte) error {
	writer, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = writer.Write(content)
	return err
}

func writeZipFileFromPath(zw *zip.Writer, name string, path string) error {
	writer, err := zw.Create(name)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	buffer := xlsxZipCopyBufferPool.Get().([]byte)
	defer xlsxZipCopyBufferPool.Put(buffer)
	_, err = io.CopyBuffer(writer, file, buffer)
	return err
}

func writeXLSXSheetHeader(writer *bufio.Writer) error {
	_, err := writer.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` +
		`<worksheet xmlns="` + xlsxMainNamespace + `" xmlns:r="` + xlsxRelationshipsNamespace + `">` +
		`<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
		`<sheetFormatPr defaultRowHeight="15"/>` +
		`<sheetData>`)
	return err
}

func writeXLSXInlineStringCell(writer *bufio.Writer, columnRef string, rowRef string, value string) error {
	if _, err := writer.WriteString(`<c r="`); err != nil {
		return err
	}
	if _, err := writer.WriteString(columnRef); err != nil {
		return err
	}
	if _, err := writer.WriteString(rowRef); err != nil {
		return err
	}
	if _, err := writer.WriteString(`" t="inlineStr"><is><t`); err != nil {
		return err
	}
	if value != strings.TrimSpace(value) {
		if _, err := writer.WriteString(` xml:space="preserve"`); err != nil {
			return err
		}
	}
	if _, err := writer.WriteString(`>`); err != nil {
		return err
	}
	if err := xml.EscapeText(writer, []byte(value)); err != nil {
		return err
	}
	_, err := writer.WriteString(`</t></is></c>`)
	return err
}

func buildXLSXContentTypes(sheetCount int) []byte {
	var builder strings.Builder
	builder.Grow(1024 + sheetCount*128)
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	builder.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`)
	builder.WriteString(`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`)
	builder.WriteString(`<Default Extension="xml" ContentType="application/xml"/>`)
	builder.WriteString(`<Override PartName="/xl/workbook.xml" ContentType="` + xlsxWorkbookContentType + `"/>`)
	builder.WriteString(`<Override PartName="/xl/styles.xml" ContentType="` + xlsxStylesContentType + `"/>`)
	builder.WriteString(`<Override PartName="/xl/theme/theme1.xml" ContentType="` + xlsxThemeContentType + `"/>`)
	builder.WriteString(`<Override PartName="/docProps/core.xml" ContentType="` + xlsxCoreContentType + `"/>`)
	builder.WriteString(`<Override PartName="/docProps/app.xml" ContentType="` + xlsxAppContentType + `"/>`)
	for i := 1; i <= sheetCount; i++ {
		builder.WriteString(`<Override PartName="/xl/worksheets/sheet`)
		builder.WriteString(strconv.Itoa(i))
		builder.WriteString(`.xml" ContentType="`)
		builder.WriteString(xlsxWorksheetContentType)
		builder.WriteString(`"/>`)
	}
	builder.WriteString(`</Types>`)
	return []byte(builder.String())
}

func buildXLSXWorkbookXML(sheets []*xlsxExportTempSheet) []byte {
	var builder strings.Builder
	builder.Grow(512 + len(sheets)*96)
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	builder.WriteString(`<workbook xmlns="` + xlsxMainNamespace + `" xmlns:r="` + xlsxRelationshipsNamespace + `">`)
	builder.WriteString(`<bookViews><workbookView workbookViewId="0"/></bookViews>`)
	builder.WriteString(`<sheets>`)
	for i, sheet := range sheets {
		builder.WriteString(`<sheet name="`)
		builder.WriteString(sheet.name)
		builder.WriteString(`" sheetId="`)
		builder.WriteString(strconv.Itoa(i + 1))
		builder.WriteString(`" r:id="rId`)
		builder.WriteString(strconv.Itoa(i + 1))
		builder.WriteString(`"/>`)
	}
	builder.WriteString(`</sheets>`)
	builder.WriteString(`</workbook>`)
	return []byte(builder.String())
}

func buildXLSXWorkbookRels(sheets []*xlsxExportTempSheet) []byte {
	var builder strings.Builder
	builder.Grow(512 + len(sheets)*160)
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	builder.WriteString(`<Relationships xmlns="` + xlsxPackageRelationshipsNS + `">`)
	for i := range sheets {
		builder.WriteString(`<Relationship Id="rId`)
		builder.WriteString(strconv.Itoa(i + 1))
		builder.WriteString(`" Type="`)
		builder.WriteString(xlsxWorksheetType)
		builder.WriteString(`" Target="worksheets/sheet`)
		builder.WriteString(strconv.Itoa(i + 1))
		builder.WriteString(`.xml"/>`)
	}
	builder.WriteString(`<Relationship Id="rId`)
	builder.WriteString(strconv.Itoa(len(sheets) + 1))
	builder.WriteString(`" Type="`)
	builder.WriteString(xlsxStylesType)
	builder.WriteString(`" Target="styles.xml"/>`)
	builder.WriteString(`<Relationship Id="rId`)
	builder.WriteString(strconv.Itoa(len(sheets) + 2))
	builder.WriteString(`" Type="`)
	builder.WriteString(xlsxThemeType)
	builder.WriteString(`" Target="theme/theme1.xml"/>`)
	builder.WriteString(`</Relationships>`)
	return []byte(builder.String())
}
