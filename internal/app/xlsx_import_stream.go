package app

import (
	"archive/zip"
	"bufio"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

const (
	xlsxWorkbookXMLPath     = "xl/workbook.xml"
	xlsxWorkbookRelsXMLPath = "xl/_rels/workbook.xml.rels"
	xlsxSharedStringsXML    = "xl/sharedStrings.xml"
)

type xlsxSharedStringStore struct {
	path    string
	file    *os.File
	writer  *bufio.Writer
	offsets []int64
	size    int64
}

func newXLSXSharedStringStore() (*xlsxSharedStringStore, error) {
	file, err := os.CreateTemp("", "gonavi-xlsx-shared-strings-*.bin")
	if err != nil {
		return nil, err
	}
	return &xlsxSharedStringStore{
		path:   file.Name(),
		file:   file,
		writer: bufio.NewWriterSize(file, 1024*256),
	}, nil
}

func (s *xlsxSharedStringStore) Add(value string) error {
	if s == nil || s.file == nil || s.writer == nil {
		return fmt.Errorf("shared string store unavailable")
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

func streamXLSXImportFile(filePath string, consumer importFileConsumer) error {
	reader, err := zip.OpenReader(filePath)
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	defer reader.Close()

	entryByPath := make(map[string]*zip.File, len(reader.File))
	for _, entry := range reader.File {
		entryByPath[entry.Name] = entry
	}

	sheetPath, err := resolveXLSXFirstSheetPath(entryByPath)
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

	sheetEntry := entryByPath[sheetPath]
	if sheetEntry == nil {
		return fmt.Errorf("Excel Parse Error: worksheet not found: %s", sheetPath)
	}
	if err := streamXLSXSheetRows(sheetEntry, sharedStrings, consumer); err != nil {
		return fmt.Errorf("Excel Read Error: %w", err)
	}
	return nil
}

func streamLegacyExcelImportFile(filePath string, consumer importFileConsumer) error {
	workbook, err := excelize.OpenFile(filePath)
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	defer workbook.Close()

	sheetName := workbook.GetSheetName(0)
	if sheetName == "" {
		return fmt.Errorf("Excel file has no sheets")
	}

	rows, err := workbook.Rows(sheetName)
	if err != nil {
		return fmt.Errorf("Excel Read Error: %w", err)
	}
	defer rows.Close()

	if !rows.Next() {
		if err := rows.Error(); err != nil {
			return fmt.Errorf("Excel Read Error: %w", err)
		}
		return fmt.Errorf("Excel empty or missing header")
	}
	header, err := rows.Columns()
	if err != nil {
		return fmt.Errorf("Excel Read Error: %w", err)
	}
	columns := cloneImportColumns(header)
	if !hasImportUsableColumns(columns) {
		return fmt.Errorf("Excel empty or missing header")
	}
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}

	for rows.Next() {
		record, err := rows.Columns()
		if err != nil {
			return fmt.Errorf("Excel Read Error: %w", err)
		}
		if err := consumer.ConsumeRow(buildImportRowFromValues(columns, record)); err != nil {
			return err
		}
	}
	if err := rows.Error(); err != nil {
		return fmt.Errorf("Excel Read Error: %w", err)
	}
	return nil
}

func resolveXLSXFirstSheetPath(entryByPath map[string]*zip.File) (string, error) {
	workbookEntry := entryByPath[xlsxWorkbookXMLPath]
	if workbookEntry == nil {
		return "", fmt.Errorf("workbook.xml missing")
	}
	workbookReader, err := workbookEntry.Open()
	if err != nil {
		return "", err
	}
	defer workbookReader.Close()

	firstSheetRelID, err := readXLSXFirstSheetRelID(workbookReader)
	if err != nil {
		return "", err
	}
	if firstSheetRelID == "" {
		return "", fmt.Errorf("workbook has no sheets")
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

	target, err := readXLSXWorkbookRelTarget(relsReader, firstSheetRelID)
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", fmt.Errorf("worksheet target missing for relationship %s", firstSheetRelID)
	}
	target = strings.TrimPrefix(strings.TrimSpace(target), "/")
	if strings.HasPrefix(target, "xl/") {
		return path.Clean(target), nil
	}
	return path.Clean(path.Join("xl", target)), nil
}

func readXLSXFirstSheetRelID(reader io.Reader) (string, error) {
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
		if !ok || start.Name.Local != "sheet" {
			continue
		}
		for _, attr := range start.Attr {
			if attr.Name.Local == "id" {
				return strings.TrimSpace(attr.Value), nil
			}
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

func loadXLSXSharedStrings(entry *zip.File) (*xlsxSharedStringStore, error) {
	if entry == nil {
		return nil, nil
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	store, err := newXLSXSharedStringStore()
	if err != nil {
		return nil, err
	}
	if err := parseXLSXSharedStrings(reader, store); err != nil {
		_ = store.Close()
		return nil, err
	}
	if err := store.flush(); err != nil {
		_ = store.Close()
		return nil, err
	}
	return store, nil
}

func parseXLSXSharedStrings(reader io.Reader, store *xlsxSharedStringStore) error {
	decoder := xml.NewDecoder(reader)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "si" {
			continue
		}
		value, err := readXLSXSharedStringItem(decoder)
		if err != nil {
			return err
		}
		if err := store.Add(value); err != nil {
			return err
		}
	}
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
				text, err := readXMLTextNode(decoder, typed.Name.Local)
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

func streamXLSXSheetRows(entry *zip.File, sharedStrings *xlsxSharedStringStore, consumer importFileConsumer) error {
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()

	decoder := xml.NewDecoder(reader)
	var columns []string
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
		values, err := readXLSXRow(decoder, sharedStrings)
		if err != nil {
			return err
		}
		if columns == nil {
			columns = cloneImportColumns(values)
			if !hasImportUsableColumns(columns) {
				return fmt.Errorf("Excel empty or missing header")
			}
			if err := consumer.SetColumns(columns); err != nil {
				return err
			}
			continue
		}
		if err := consumer.ConsumeRow(buildImportRowFromValues(columns, values)); err != nil {
			return err
		}
	}
	if columns == nil {
		return fmt.Errorf("Excel empty or missing header")
	}
	return nil
}

func readXLSXRow(decoder *xml.Decoder, sharedStrings *xlsxSharedStringStore) ([]string, error) {
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
			for _, attr := range typed.Attr {
				switch attr.Name.Local {
				case "r":
					if idx := xlsxCellRefColumnIndex(attr.Value); idx > 0 {
						columnIndex = idx
					}
				case "t":
					cellType = strings.TrimSpace(attr.Value)
				}
			}
			if columnIndex <= 0 {
				columnIndex = currentColumn + 1
			}
			cellValue, err := readXLSXCell(decoder, cellType, sharedStrings)
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

func readXLSXCell(decoder *xml.Decoder, cellType string, sharedStrings *xlsxSharedStringStore) (string, error) {
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
				text, err := readXMLTextNode(decoder, typed.Name.Local)
				if err != nil {
					return "", err
				}
				rawValue.WriteString(text)
			case "t":
				text, err := readXMLTextNode(decoder, typed.Name.Local)
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
				return rawValue.String(), nil
			}
		}
	}
}

func readXMLTextNode(decoder *xml.Decoder, endLocal string) (string, error) {
	var builder strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}
		switch typed := token.(type) {
		case xml.CharData:
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
