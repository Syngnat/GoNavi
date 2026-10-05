package app

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
)

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
