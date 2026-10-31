package app

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
)

func streamHiveXLSXSheetRows(entry *zip.File, shared *xlsxSharedStringResolver, styles *xlsxStyleTable, date1904 bool, consumer importFileConsumer, options ImportFileOptions) error {
	input, err := entry.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	decoder := xml.NewDecoder(input)
	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return err
	}
	var columns []string
	rowNumber := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
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
		values, err := readHiveXLSXRow(decoder, shared, styles, date1904)
		if err != nil {
			return err
		}
		if columns == nil {
			columns = make([]string, len(values))
			for i, value := range values {
				if value != nil {
					columns[i] = value.(string)
				}
			}
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
			return fmt.Errorf("Excel row %d is wider than the header", rowNumber)
		}
		row := make(map[string]interface{}, len(columns))
		for i, name := range columns {
			if i < len(values) {
				row[name] = values[i]
			} else {
				row[name] = nil
			}
		}
		if _, err := validateImportMapRowBytes("Excel", rowNumber, row); err != nil {
			return err
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	if columns == nil {
		return fmt.Errorf("Excel header row %d is missing", headerRow)
	}
	return nil
}

func readHiveXLSXRow(decoder *xml.Decoder, shared *xlsxSharedStringResolver, styles *xlsxStyleTable, date1904 bool) ([]interface{}, error) {
	var values []interface{}
	current := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		switch part := token.(type) {
		case xml.StartElement:
			if part.Name.Local != "c" {
				continue
			}
			index, style, kind := current+1, 0, ""
			for _, attr := range part.Attr {
				switch attr.Name.Local {
				case "r":
					if n := xlsxCellRefColumnIndex(attr.Value); n > 0 {
						index = n
					}
				case "t":
					kind = strings.TrimSpace(attr.Value)
				case "s":
					n, err := strconv.Atoi(attr.Value)
					if err != nil || n < 0 {
						return nil, fmt.Errorf("invalid Excel style")
					}
					style = n
				}
			}
			if index <= current || index > xlsxMaxColumns {
				return nil, fmt.Errorf("invalid Excel cell order")
			}
			temporal, err := styles.temporalKind(style)
			if err != nil {
				return nil, err
			}
			text, err := readXLSXCellWithTemporalStyle(decoder, kind, temporal, date1904, shared)
			if err != nil {
				return nil, err
			}
			for len(values) < index {
				values = append(values, nil)
			}
			if kind == "s" || kind == "inlineStr" || kind == "str" || text != "" {
				values[index-1] = text
			}
			current = index
		case xml.EndElement:
			if part.Name.Local == "row" {
				return values, nil
			}
		}
	}
}
