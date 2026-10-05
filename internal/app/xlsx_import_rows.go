package app

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

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
