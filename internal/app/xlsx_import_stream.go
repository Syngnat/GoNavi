package app

import (
	"archive/zip"
	"bufio"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

const (
	xlsxWorkbookXMLPath     = "xl/workbook.xml"
	xlsxWorkbookRelsXMLPath = "xl/_rels/workbook.xml.rels"
	xlsxSharedStringsXML    = "xl/sharedStrings.xml"
	xlsxStylesXMLPath       = "xl/styles.xml"
	maxXLSXSharedStrings    = 10_000_000
	maxXLSXCellStyles       = 65_536
	maxXLSXNumberFormats    = 65_536
)

type xlsxArchiveResourceLimits struct {
	MaxEntryUncompressedBytes uint64
	MaxTotalUncompressedBytes uint64
	MaxCompressionRatio       uint64
}

var defaultXLSXArchiveResourceLimits = xlsxArchiveResourceLimits{
	MaxEntryUncompressedBytes: 16 << 30,
	MaxTotalUncompressedBytes: 64 << 30,
	MaxCompressionRatio:       1000,
}

type xlsxSharedStringStore struct {
	path          string
	file          *os.File
	writer        *bufio.Writer
	offsets       []int64
	size          int64
	maxCount      int
	maxValueBytes int
}

type xlsxSharedStringResolver struct {
	reader    io.ReadCloser
	decoder   *xml.Decoder
	store     *xlsxSharedStringStore
	exhausted bool
}

func newXLSXSharedStringStore() (*xlsxSharedStringStore, error) {
	return newXLSXSharedStringStoreWithLimits(maxXLSXSharedStrings, maxImportCellBytes)
}

func newXLSXSharedStringStoreWithLimits(maxCount int, maxValueBytes int) (*xlsxSharedStringStore, error) {
	if maxCount <= 0 || maxValueBytes <= 0 {
		return nil, fmt.Errorf("invalid shared string limits")
	}
	file, err := os.CreateTemp("", "gonavi-xlsx-shared-strings-*.bin")
	if err != nil {
		return nil, err
	}
	return &xlsxSharedStringStore{
		path:          file.Name(),
		file:          file,
		writer:        bufio.NewWriterSize(file, 1024*256),
		maxCount:      maxCount,
		maxValueBytes: maxValueBytes,
	}, nil
}

func (s *xlsxSharedStringStore) Add(value string) error {
	if s == nil || s.file == nil || s.writer == nil {
		return fmt.Errorf("shared string store unavailable")
	}
	// Get seeks the shared-string file to read an earlier value. Flush the
	// buffered writer and restore its append position before adding another
	// value; otherwise a lazy, out-of-order lookup can overwrite earlier data
	// and make subsequent Excel reads fail with EOF.
	if err := s.flush(); err != nil {
		return err
	}
	if _, err := s.file.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	if len(s.offsets) >= s.maxCount {
		return fmt.Errorf("shared string count exceeds %d limit", s.maxCount)
	}
	if len(value) > s.maxValueBytes {
		return fmt.Errorf("shared string exceeds %d-byte cell limit", s.maxValueBytes)
	}
	s.offsets = append(s.offsets, s.size)
	if err := binary.Write(s.writer, binary.LittleEndian, uint32(len(value))); err != nil {
		return err
	}
	written, err := s.writer.WriteString(value)
	s.size += 4 + int64(written)
	return err
}

func (s *xlsxSharedStringStore) Get(index int) (string, error) {
	if s == nil {
		return "", nil
	}
	if index < 0 || index >= len(s.offsets) {
		return "", fmt.Errorf("shared string index out of range: %d", index)
	}
	if err := s.flush(); err != nil {
		return "", err
	}
	if _, err := s.file.Seek(s.offsets[index], io.SeekStart); err != nil {
		return "", err
	}
	var length uint32
	if err := binary.Read(s.file, binary.LittleEndian, &length); err != nil {
		return "", err
	}
	if uint64(length) > uint64(s.maxValueBytes) {
		return "", fmt.Errorf("shared string exceeds %d-byte cell limit", s.maxValueBytes)
	}
	buf := make([]byte, int(length))
	if _, err := io.ReadFull(s.file, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

func (s *xlsxSharedStringStore) flush() error {
	if s == nil || s.writer == nil {
		return nil
	}
	return s.writer.Flush()
}

func (s *xlsxSharedStringStore) Close() error {
	if s == nil {
		return nil
	}
	if s.writer != nil {
		_ = s.writer.Flush()
	}
	var err error
	if s.file != nil {
		err = s.file.Close()
	}
	if s.path != "" {
		_ = os.Remove(s.path)
	}
	return err
}

func (r *xlsxSharedStringResolver) Get(index int) (string, error) {
	if r == nil {
		return "", nil
	}
	if index < 0 {
		return "", fmt.Errorf("shared string index out of range: %d", index)
	}
	for len(r.store.offsets) <= index && !r.exhausted {
		found, err := r.parseNext()
		if err != nil {
			return "", err
		}
		if !found {
			break
		}
	}
	return r.store.Get(index)
}

func (r *xlsxSharedStringResolver) parseNext() (bool, error) {
	for {
		token, err := r.decoder.Token()
		if err != nil {
			if err == io.EOF {
				r.exhausted = true
				return false, nil
			}
			return false, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "si" {
			continue
		}
		value, err := readXLSXSharedStringItem(r.decoder)
		if err != nil {
			return false, err
		}
		if err := r.store.Add(value); err != nil {
			return false, err
		}
		return true, nil
	}
}

func (r *xlsxSharedStringResolver) Close() error {
	if r == nil {
		return nil
	}
	var firstErr error
	if r.reader != nil {
		firstErr = r.reader.Close()
	}
	if r.store != nil {
		if err := r.store.Close(); firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func streamXLSXImportFile(filePath string, consumer importFileConsumer) error {
	return streamXLSXImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamXLSXImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	return streamXLSXImportFileWithOptionsAndLimits(filePath, consumer, options, defaultXLSXArchiveResourceLimits)
}

func streamXLSXImportFileWithLimits(filePath string, consumer importFileConsumer, limits xlsxArchiveResourceLimits) error {
	return streamXLSXImportFileWithOptionsAndLimits(filePath, consumer, ImportFileOptions{}, limits)
}

func streamXLSXImportFileWithOptionsAndLimits(
	filePath string,
	consumer importFileConsumer,
	options ImportFileOptions,
	limits xlsxArchiveResourceLimits,
) error {
	if consumer == nil {
		return fmt.Errorf("import file consumer is required")
	}
	if err := validateImportFileOptions(options); err != nil {
		return err
	}
	reader, err := zip.OpenReader(filePath)
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	defer reader.Close()
	var totalUncompressedBytes uint64
	for _, entry := range reader.File {
		if limits.MaxEntryUncompressedBytes > 0 && entry.UncompressedSize64 > limits.MaxEntryUncompressedBytes {
			return fmt.Errorf(
				"Excel Parse Error: entry %q uncompressed size %d exceeds %d-byte limit",
				entry.Name,
				entry.UncompressedSize64,
				limits.MaxEntryUncompressedBytes,
			)
		}
		if limits.MaxCompressionRatio > 0 && entry.UncompressedSize64 > 0 {
			compressedBytes := entry.CompressedSize64
			ratioExceeded := compressedBytes == 0
			if compressedBytes > 0 {
				quotient := entry.UncompressedSize64 / compressedBytes
				ratioExceeded = quotient > limits.MaxCompressionRatio ||
					(quotient == limits.MaxCompressionRatio && entry.UncompressedSize64%compressedBytes > 0)
			}
			if ratioExceeded {
				return fmt.Errorf(
					"Excel Parse Error: entry %q compression ratio exceeds %d:1 limit",
					entry.Name,
					limits.MaxCompressionRatio,
				)
			}
		}
		if limits.MaxTotalUncompressedBytes > 0 &&
			(totalUncompressedBytes > limits.MaxTotalUncompressedBytes ||
				entry.UncompressedSize64 > limits.MaxTotalUncompressedBytes-totalUncompressedBytes) {
			return fmt.Errorf(
				"Excel Parse Error: total uncompressed size exceeds %d-byte limit",
				limits.MaxTotalUncompressedBytes,
			)
		}
		totalUncompressedBytes += entry.UncompressedSize64
	}
	entryByPath := make(map[string]*zip.File, len(reader.File))
	for _, entry := range reader.File {
		entryByPath[entry.Name] = entry
	}

	sheetPath, err := resolveXLSXSheetPath(entryByPath, options.SheetName)
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	date1904, err := readXLSXWorkbookDate1904(entryByPath[xlsxWorkbookXMLPath])
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}

	sharedStrings, err := loadXLSXSharedStrings(entryByPath[xlsxSharedStringsXML])
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	if sharedStrings != nil {
		defer sharedStrings.Close()
	}
	styles, err := loadXLSXStyles(entryByPath[xlsxStylesXMLPath])
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}

	sheetEntry := entryByPath[sheetPath]
	if sheetEntry == nil {
		return fmt.Errorf("Excel Parse Error: worksheet not found: %s", sheetPath)
	}
	if err := streamXLSXSheetRowsWithOptionsAndStyles(sheetEntry, sharedStrings, styles, date1904, consumer, options); err != nil {
		return fmt.Errorf("Excel Read Error: %w", err)
	}
	return nil
}

func resolveXLSXFirstSheetPath(entryByPath map[string]*zip.File) (string, error) {
	return resolveXLSXSheetPath(entryByPath, "")
}

func readXLSXWorkbookDate1904(entry *zip.File) (bool, error) {
	if entry == nil {
		return false, fmt.Errorf("workbook.xml missing")
	}
	reader, err := entry.Open()
	if err != nil {
		return false, err
	}
	defer reader.Close()

	decoder := xml.NewDecoder(reader)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return false, nil
			}
			return false, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "workbookPr" {
			continue
		}
		for _, attr := range start.Attr {
			if attr.Name.Local != "date1904" {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(attr.Value)) {
			case "", "0", "false":
				return false, nil
			case "1", "true":
				return true, nil
			default:
				return false, fmt.Errorf("invalid workbook date1904 value %q", attr.Value)
			}
		}
		return false, nil
	}
}

type xlsxSheetReference struct {
	name  string
	relID string
}

func resolveXLSXSheetPath(entryByPath map[string]*zip.File, sheetName string) (string, error) {
	workbookEntry := entryByPath[xlsxWorkbookXMLPath]
	if workbookEntry == nil {
		return "", fmt.Errorf("workbook.xml missing")
	}
	workbookReader, err := workbookEntry.Open()
	if err != nil {
		return "", err
	}
	defer workbookReader.Close()

	selectedSheet, found, err := readXLSXSheetReference(workbookReader, sheetName)
	if err != nil {
		return "", err
	}
	if !found && sheetName == "" {
		return "", fmt.Errorf("workbook has no sheets")
	}
	if !found {
		return "", fmt.Errorf("worksheet %q not found", sheetName)
	}

	relsEntry := entryByPath[xlsxWorkbookRelsXMLPath]
	if relsEntry == nil {
		return "", fmt.Errorf("workbook rels missing")
	}
	relsReader, err := relsEntry.Open()
	if err != nil {
		return "", err
	}
	defer relsReader.Close()

	target, err := readXLSXWorkbookRelTarget(relsReader, selectedSheet.relID)
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", fmt.Errorf("worksheet target missing for relationship %s", selectedSheet.relID)
	}
	target = strings.TrimPrefix(strings.TrimSpace(target), "/")
	if strings.HasPrefix(target, "xl/") {
		return path.Clean(target), nil
	}
	return path.Clean(path.Join("xl", target)), nil
}

func readXLSXFirstSheetRelID(reader io.Reader) (string, error) {
	sheet, found, err := readXLSXSheetReference(reader, "")
	if err != nil || !found {
		return "", err
	}
	return sheet.relID, nil
}

func readXLSXSheetReference(reader io.Reader, sheetName string) (xlsxSheetReference, bool, error) {
	decoder := xml.NewDecoder(reader)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return xlsxSheetReference{}, false, nil
			}
			return xlsxSheetReference{}, false, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "sheet" {
			continue
		}
		var sheet xlsxSheetReference
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "name":
				sheet.name = attr.Value
			case "id":
				sheet.relID = strings.TrimSpace(attr.Value)
			}
		}
		if sheet.relID == "" {
			return xlsxSheetReference{}, false, fmt.Errorf("worksheet relationship id missing")
		}
		if sheetName == "" || sheet.name == sheetName {
			return sheet, true, nil
		}
	}
}

func readXLSXWorkbookRelTarget(reader io.Reader, relID string) (string, error) {
	decoder := xml.NewDecoder(reader)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return "", nil
			}
			return "", err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "Relationship" {
			continue
		}
		var id string
		var target string
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "Id":
				id = strings.TrimSpace(attr.Value)
			case "Target":
				target = strings.TrimSpace(attr.Value)
			}
		}
		if id == relID {
			return target, nil
		}
	}
}

func loadXLSXSharedStrings(entry *zip.File) (*xlsxSharedStringResolver, error) {
	if entry == nil {
		return nil, nil
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}

	store, err := newXLSXSharedStringStore()
	if err != nil {
		_ = reader.Close()
		return nil, err
	}
	return &xlsxSharedStringResolver{
		reader:  reader,
		decoder: xml.NewDecoder(reader),
		store:   store,
	}, nil
}

type xlsxTemporalKind uint8

const (
	xlsxTemporalNone xlsxTemporalKind = iota
	xlsxTemporalDate
	xlsxTemporalTime
	xlsxTemporalDateTime
	xlsxTemporalElapsedTime
)

type xlsxStyleTable struct {
	temporalKinds []xlsxTemporalKind
}

func (s *xlsxStyleTable) temporalKind(styleIndex int) (xlsxTemporalKind, error) {
	if s == nil {
		return xlsxTemporalNone, nil
	}
	if styleIndex < 0 || styleIndex >= len(s.temporalKinds) {
		return xlsxTemporalNone, fmt.Errorf("cell style index out of range: %d", styleIndex)
	}
	return s.temporalKinds[styleIndex], nil
}

func loadXLSXStyles(entry *zip.File) (*xlsxStyleTable, error) {
	if entry == nil {
		return nil, nil
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	decoder := xml.NewDecoder(reader)
	customFormats := make(map[int]string)
	styleFormatIDs := make([]int, 0, 32)
	inCellXFs := false
	cellXFsDepth := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			if typed.Name.Local == "numFmt" {
				numFmtID, formatCode, err := readXLSXNumberFormatAttributes(typed)
				if err != nil {
					return nil, err
				}
				if numFmtID >= 0 {
					if _, exists := customFormats[numFmtID]; !exists && len(customFormats) >= maxXLSXNumberFormats {
						return nil, fmt.Errorf("number format count exceeds %d limit", maxXLSXNumberFormats)
					}
					customFormats[numFmtID] = formatCode
				}
			}
			if !inCellXFs && typed.Name.Local == "cellXfs" {
				inCellXFs = true
				cellXFsDepth = 1
				continue
			}
			if inCellXFs {
				if cellXFsDepth == 1 && typed.Name.Local == "xf" {
					if len(styleFormatIDs) >= maxXLSXCellStyles {
						return nil, fmt.Errorf("cell style count exceeds %d limit", maxXLSXCellStyles)
					}
					numFmtID, err := readXLSXCellFormatID(typed)
					if err != nil {
						return nil, err
					}
					styleFormatIDs = append(styleFormatIDs, numFmtID)
				}
				cellXFsDepth++
			}
		case xml.EndElement:
			if !inCellXFs {
				continue
			}
			cellXFsDepth--
			if cellXFsDepth == 0 {
				inCellXFs = false
			}
		}
	}

	table := &xlsxStyleTable{temporalKinds: make([]xlsxTemporalKind, len(styleFormatIDs))}
	for index, numFmtID := range styleFormatIDs {
		table.temporalKinds[index] = classifyXLSXTemporalFormat(numFmtID, customFormats[numFmtID])
	}
	return table, nil
}

func readXLSXNumberFormatAttributes(start xml.StartElement) (int, string, error) {
	numFmtID := -1
	formatCode := ""
	for _, attr := range start.Attr {
		switch attr.Name.Local {
		case "numFmtId":
			value, err := strconv.Atoi(strings.TrimSpace(attr.Value))
			if err != nil || value < 0 {
				return -1, "", fmt.Errorf("invalid number format id %q", attr.Value)
			}
			numFmtID = value
		case "formatCode":
			formatCode = attr.Value
		}
	}
	if numFmtID < 0 {
		return -1, "", fmt.Errorf("number format id missing")
	}
	return numFmtID, formatCode, nil
}

func readXLSXCellFormatID(start xml.StartElement) (int, error) {
	for _, attr := range start.Attr {
		if attr.Name.Local != "numFmtId" {
			continue
		}
		value, err := strconv.Atoi(strings.TrimSpace(attr.Value))
		if err != nil || value < 0 {
			return 0, fmt.Errorf("invalid cell number format id %q", attr.Value)
		}
		return value, nil
	}
	return 0, nil
}

func classifyXLSXTemporalFormat(numFmtID int, customCode string) xlsxTemporalKind {
	switch numFmtID {
	case 14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58:
		return xlsxTemporalDate
	case 18, 19, 20, 21, 32, 33, 45, 47:
		return xlsxTemporalTime
	case 22:
		return xlsxTemporalDateTime
	case 46:
		return xlsxTemporalElapsedTime
	}
	return classifyXLSXCustomTemporalFormat(customCode)
}

func classifyXLSXCustomTemporalFormat(formatCode string) xlsxTemporalKind {
	normalized, elapsed := normalizeXLSXNumberFormatCode(formatCode)
	hasDate := strings.ContainsAny(normalized, "yd")
	hasTime := strings.ContainsAny(normalized, "hs")
	if elapsed {
		return xlsxTemporalElapsedTime
	}
	switch {
	case hasDate && hasTime:
		return xlsxTemporalDateTime
	case hasDate:
		return xlsxTemporalDate
	case hasTime:
		return xlsxTemporalTime
	default:
		return xlsxTemporalNone
	}
}

func normalizeXLSXNumberFormatCode(formatCode string) (string, bool) {
	var builder strings.Builder
	inQuote := false
	elapsed := false
	for index := 0; index < len(formatCode); index++ {
		ch := formatCode[index]
		if ch == '"' {
			inQuote = !inQuote
			continue
		}
		if inQuote {
			continue
		}
		switch ch {
		case '\\', '_', '*':
			if index+1 < len(formatCode) {
				index++
			}
			continue
		case '[':
			end := strings.IndexByte(formatCode[index+1:], ']')
			if end < 0 {
				continue
			}
			end += index + 1
			content := strings.ToLower(strings.TrimSpace(formatCode[index+1 : end]))
			if content == "h" || content == "hh" || content == "m" || content == "mm" || content == "s" || content == "ss" {
				elapsed = true
				builder.WriteString(content)
			}
			index = end
			continue
		}
		if ch >= 'A' && ch <= 'Z' {
			ch += 'a' - 'A'
		}
		builder.WriteByte(ch)
	}
	return builder.String(), elapsed
}

func readXLSXSharedStringItem(decoder *xml.Decoder) (string, error) {
	var builder strings.Builder
	depth := 1
	for depth > 0 {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			if typed.Name.Local == "si" {
				depth++
				continue
			}
			if typed.Name.Local == "t" {
				remaining := maxImportCellBytes - builder.Len()
				text, err := readXMLTextNodeLimited(decoder, typed.Name.Local, remaining, "shared string")
				if err != nil {
					return "", err
				}
				builder.WriteString(text)
			}
		case xml.EndElement:
			if typed.Name.Local == "si" {
				depth--
			}
		}
	}
	return builder.String(), nil
}

func streamXLSXSheetRows(entry *zip.File, sharedStrings *xlsxSharedStringResolver, consumer importFileConsumer) error {
	return streamXLSXSheetRowsWithOptions(entry, sharedStrings, consumer, ImportFileOptions{})
}

func streamXLSXSheetRowsWithOptions(
	entry *zip.File,
	sharedStrings *xlsxSharedStringResolver,
	consumer importFileConsumer,
	options ImportFileOptions,
) error {
	return streamXLSXSheetRowsWithOptionsAndStyles(entry, sharedStrings, nil, false, consumer, options)
}

func streamXLSXSheetRowsWithOptionsAndStyles(
	entry *zip.File,
	sharedStrings *xlsxSharedStringResolver,
	styles *xlsxStyleTable,
	date1904 bool,
	consumer importFileConsumer,
	options ImportFileOptions,
) error {
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()

	decoder := xml.NewDecoder(reader)
	var columns []string
	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return err
	}
	rowNumber := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "row" {
			continue
		}
		rowNumber = resolveXLSXRowNumber(start, rowNumber+1)
		if rowNumber < headerRow {
			if err := decoder.Skip(); err != nil {
				return err
			}
			continue
		}
		if columns == nil && rowNumber > headerRow {
			return fmt.Errorf("Excel header row %d is missing", headerRow)
		}
		values, err := readXLSXRowWithStyles(decoder, sharedStrings, styles, date1904)
		if err != nil {
			return err
		}
		if err := validateImportStringCells("Excel", rowNumber, values); err != nil {
			return err
		}
		if columns == nil {
			columns = cloneImportColumns(values)
			if !hasImportUsableColumns(columns) {
				return fmt.Errorf("Excel empty or missing header")
			}
			if err := validateImportUniqueColumns("Excel", columns); err != nil {
				return err
			}
			if err := consumer.SetColumns(columns); err != nil {
				return err
			}
			continue
		}
		if len(values) > len(columns) {
			return fmt.Errorf(
				"Excel row %d has %d columns, wider than the %d-column header",
				rowNumber,
				len(values),
				len(columns),
			)
		}
		if err := consumer.ConsumeRow(buildImportRowFromValuesWithOptions(columns, values, options)); err != nil {
			return err
		}
	}
	if columns == nil {
		return fmt.Errorf("Excel header row %d is missing", headerRow)
	}
	return nil
}

const xlsxMaxRows = 1_048_576

func resolveXLSXRowNumber(start xml.StartElement, fallback int) int {
	for _, attr := range start.Attr {
		if attr.Name.Local != "r" {
			continue
		}
		rowNumber, err := strconv.Atoi(strings.TrimSpace(attr.Value))
		if err == nil && rowNumber >= fallback && rowNumber <= xlsxMaxRows {
			return rowNumber
		}
		break
	}
	return fallback
}

func readXLSXRow(decoder *xml.Decoder, sharedStrings *xlsxSharedStringResolver) ([]string, error) {
	return readXLSXRowWithStyles(decoder, sharedStrings, nil, false)
}

func readXLSXRowWithStyles(
	decoder *xml.Decoder,
	sharedStrings *xlsxSharedStringResolver,
	styles *xlsxStyleTable,
	date1904 bool,
) ([]string, error) {
	values := make([]string, 0, 16)
	currentColumn := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			if typed.Name.Local != "c" {
				continue
			}
			columnIndex := currentColumn + 1
			cellType := ""
			styleIndex := 0
			for _, attr := range typed.Attr {
				switch attr.Name.Local {
				case "r":
					if idx := xlsxCellRefColumnIndex(attr.Value); idx > 0 {
						columnIndex = idx
					}
				case "t":
					cellType = strings.TrimSpace(attr.Value)
				case "s":
					parsed, err := strconv.Atoi(strings.TrimSpace(attr.Value))
					if err != nil || parsed < 0 {
						return nil, fmt.Errorf("invalid cell style index %q", attr.Value)
					}
					styleIndex = parsed
				}
			}
			if columnIndex <= 0 {
				columnIndex = currentColumn + 1
			}
			temporalKind, err := styles.temporalKind(styleIndex)
			if err != nil {
				return nil, err
			}
			cellValue, err := readXLSXCellWithTemporalStyle(decoder, cellType, temporalKind, date1904, sharedStrings)
			if err != nil {
				return nil, err
			}
			for len(values) < columnIndex {
				values = append(values, "")
			}
			values[columnIndex-1] = cellValue
			currentColumn = columnIndex
		case xml.EndElement:
			if typed.Name.Local == "row" {
				return values, nil
			}
		}
	}
}

func readXLSXCell(decoder *xml.Decoder, cellType string, sharedStrings *xlsxSharedStringResolver) (string, error) {
	return readXLSXCellWithTemporalStyle(decoder, cellType, xlsxTemporalNone, false, sharedStrings)
}

func readXLSXCellWithTemporalStyle(
	decoder *xml.Decoder,
	cellType string,
	temporalKind xlsxTemporalKind,
	date1904 bool,
	sharedStrings *xlsxSharedStringResolver,
) (string, error) {
	var rawValue strings.Builder
	var inlineValue strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			switch typed.Name.Local {
			case "v":
				text, err := readXMLTextNodeLimited(decoder, typed.Name.Local, maxImportCellBytes-rawValue.Len(), "cell")
				if err != nil {
					return "", err
				}
				rawValue.WriteString(text)
			case "t":
				text, err := readXMLTextNodeLimited(decoder, typed.Name.Local, maxImportCellBytes-inlineValue.Len(), "cell")
				if err != nil {
					return "", err
				}
				inlineValue.WriteString(text)
			}
		case xml.EndElement:
			if typed.Name.Local != "c" {
				continue
			}
			switch cellType {
			case "s":
				indexText := strings.TrimSpace(rawValue.String())
				if indexText == "" {
					return "", nil
				}
				index, err := strconv.Atoi(indexText)
				if err != nil {
					return "", err
				}
				return sharedStrings.Get(index)
			case "inlineStr":
				return inlineValue.String(), nil
			default:
				if inlineValue.Len() > 0 {
					return inlineValue.String(), nil
				}
				value := rawValue.String()
				if temporalKind == xlsxTemporalNone || (cellType != "" && cellType != "n") || strings.TrimSpace(value) == "" {
					return value, nil
				}
				return formatXLSXTemporalSerial(value, temporalKind, date1904)
			}
		}
	}
}

func formatXLSXTemporalSerial(raw string, kind xlsxTemporalKind, date1904 bool) (string, error) {
	serial, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(serial) || math.IsInf(serial, 0) {
		return "", fmt.Errorf("invalid Excel date/time serial %q", raw)
	}
	if kind == xlsxTemporalElapsedTime {
		return formatXLSXElapsedTime(serial)
	}

	wholeDays := math.Floor(serial)
	if wholeDays < -3_000_000 || wholeDays > 3_000_000 {
		return "", fmt.Errorf("Excel date/time serial out of range: %q", raw)
	}
	fraction := serial - wholeDays
	nanos := roundXLSXTemporalNanos(fraction * float64(24*time.Hour))
	if nanos >= int64(24*time.Hour) {
		wholeDays++
		nanos -= int64(24 * time.Hour)
	}

	clock := formatXLSXClockTime(nanos)
	if kind == xlsxTemporalTime {
		return clock, nil
	}

	dateText := ""
	if !date1904 && wholeDays == 60 {
		// Excel's 1900 date system intentionally preserves Lotus 1-2-3's
		// fictitious leap day. Keep the workbook-visible value stable even
		// though time.Time cannot represent this date.
		dateText = "1900-02-29"
	} else {
		base := time.Date(1899, time.December, 31, 0, 0, 0, 0, time.UTC)
		adjustedDays := wholeDays
		if date1904 {
			base = time.Date(1904, time.January, 1, 0, 0, 0, 0, time.UTC)
		} else if adjustedDays > 60 {
			adjustedDays--
		}
		date := base.AddDate(0, 0, int(adjustedDays))
		dateText = date.Format("2006-01-02")
	}
	if kind == xlsxTemporalDate {
		return dateText, nil
	}
	return dateText + " " + clock, nil
}

func formatXLSXClockTime(nanos int64) string {
	if nanos < 0 {
		nanos = 0
	}
	hours := nanos / int64(time.Hour)
	nanos %= int64(time.Hour)
	minutes := nanos / int64(time.Minute)
	nanos %= int64(time.Minute)
	seconds := nanos / int64(time.Second)
	nanos %= int64(time.Second)
	formatted := fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
	if nanos == 0 {
		return formatted
	}
	return formatted + "." + strings.TrimRight(fmt.Sprintf("%09d", nanos), "0")
}

func formatXLSXElapsedTime(serial float64) (string, error) {
	negative := serial < 0
	if negative {
		serial = -serial
	}
	if serial > float64(math.MaxInt64)/float64(24*time.Hour) {
		return "", fmt.Errorf("Excel elapsed time serial out of range")
	}
	totalNanos := roundXLSXTemporalNanos(serial * float64(24*time.Hour))
	formatted := formatXLSXClockTime(totalNanos)
	if negative {
		return "-" + formatted, nil
	}
	return formatted, nil
}

func roundXLSXTemporalNanos(value float64) int64 {
	return int64(math.Round(value/float64(time.Microsecond))) * int64(time.Microsecond)
}

func readXMLTextNodeLimited(decoder *xml.Decoder, endLocal string, maxBytes int, label string) (string, error) {
	var builder strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}
		switch typed := token.(type) {
		case xml.CharData:
			if len(typed) > maxBytes-builder.Len() {
				return "", fmt.Errorf("%s exceeds %d-byte limit", label, maxBytes)
			}
			builder.Write([]byte(typed))
		case xml.EndElement:
			if typed.Name.Local == endLocal {
				return builder.String(), nil
			}
		}
	}
}

// xlsxMaxColumns 是 OOXML/SpreadsheetML 的列数上限（XFD = 16384）。
//
// 单元格的 r 属性完全来自文件内容且可被任意篡改，必须设上限：形如 <c r="ZZZZZZZZ1"/>
// 会解析出约 2.2e11 的列号，直接驱动 readXLSXRow 的 slice 填充循环分配 TB 级内存，
// 使整个桌面进程被 OOM 杀死（其他标签页的未保存内容一并丢失）。9 字节属性即可放大到 TB 级。
const xlsxMaxColumns = 16384

func xlsxCellRefColumnIndex(ref string) int {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return 0
	}
	value := 0
	for i := 0; i < len(ref); i++ {
		ch := ref[i]
		switch {
		case ch >= 'A' && ch <= 'Z':
			value = value*26 + int(ch-'A'+1)
		case ch >= 'a' && ch <= 'z':
			value = value*26 + int(ch-'a'+1)
		default:
			// 字母段结束（后面是行号），此时 value 即列号。
			if value > 0 {
				return value
			}
			continue
		}
		if value > xlsxMaxColumns {
			// 超出 OOXML 列上限：视为非法 r 属性，返回 0 让调用方回退到顺序列号；
			// 同时提前熔断，避免继续累加造成整型溢出。
			return 0
		}
	}
	return value
}
