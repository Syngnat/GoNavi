package app

import (
	"bufio"
	"encoding/xml"
	"math"
	"math/big"
	"strconv"
	"strings"
)

func writeXLSXCell(writer *bufio.Writer, columnRef string, rowRef string, value string, numericCells bool) error {
	if numericCells {
		if literal, ok := xlsxNumericCellLiteral(value); ok {
			return writeXLSXNumberCell(writer, columnRef, rowRef, literal)
		}
	}
	return writeXLSXInlineStringCell(writer, columnRef, rowRef, value)
}

func writeXLSXNumberCell(writer *bufio.Writer, columnRef string, rowRef string, literal string) error {
	if _, err := writer.WriteString(`<c r="`); err != nil {
		return err
	}
	if _, err := writer.WriteString(columnRef); err != nil {
		return err
	}
	if _, err := writer.WriteString(rowRef); err != nil {
		return err
	}
	if _, err := writer.WriteString(`"><v>`); err != nil {
		return err
	}
	if _, err := writer.WriteString(literal); err != nil {
		return err
	}
	_, err := writer.WriteString(`</v></c>`)
	return err
}

// xlsxNumericCellLiteral accepts plain decimals within Excel's 15-digit precision.
// Integers with more than 15 digits stay text (also keeping them below 2^53);
// decimals must round-trip without changing value, not be exactly binary-representable.
// The spelling must already be canonical: a text value such as "1.00" or "0001"
// is someone's identifier or formatted amount, and Excel must not normalize it.
func xlsxNumericCellLiteral(text string) (string, bool) {
	if text == "" || text[0] == '+' {
		return "", false
	}
	body := text
	if body[0] == '-' {
		body = body[1:]
	}
	if body == "" || strings.ContainsAny(body, "eExX_") {
		return "", false
	}
	if len(body) > 1 && body[0] == '0' && body[1] != '.' {
		return "", false
	}
	dot := 0
	for _, r := range body {
		switch {
		case r >= '0' && r <= '9':
		case r == '.':
			dot++
			if dot > 1 {
				return "", false
			}
		default:
			return "", false
		}
	}
	if dot > 0 && (strings.HasPrefix(body, ".") || strings.HasSuffix(body, ".")) {
		return "", false
	}
	// Long integer/ID values stay text, even when float64 rounds back to the same spelling.
	const maxExcelSignificantDigits = 15
	integer, fraction, _ := strings.Cut(body, ".")
	significant := strings.TrimLeft(integer+strings.TrimRight(fraction, "0"), "0")
	if len(integer) > maxExcelSignificantDigits || len(significant) > maxExcelSignificantDigits {
		return "", false
	}
	original, ok := new(big.Rat).SetString(text)
	if !ok {
		return "", false
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return "", false
	}
	canonical := strconv.FormatFloat(value, 'f', -1, 64)
	parsed, ok := new(big.Rat).SetString(canonical)
	if !ok || original.Cmp(parsed) != 0 || canonical != text {
		return "", false
	}
	return canonical, true
}

// resolveXLSXTextColumns judges a materialized export column the way the person
// reading the workbook expects: one value that is not already written as a
// canonical number makes the whole column text, so identifiers keep their
// leading zeros and amounts keep trailing zeros such as "1.00".
func resolveXLSXTextColumns(data []map[string]interface{}, columns []string) map[string]bool {
	text := make(map[string]bool)
	for _, row := range data {
		for _, column := range columns {
			if text[column] {
				continue
			}
			value := row[column]
			if value == nil {
				continue
			}
			formatted := formatExportCellText(value)
			if formatted == "" {
				continue
			}
			if _, ok := xlsxNumericCellLiteral(formatted); !ok {
				text[column] = true
			}
		}
	}
	return text
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
