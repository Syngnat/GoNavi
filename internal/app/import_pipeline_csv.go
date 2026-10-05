package app

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
)

const (
	importDelimiterAuto      = "auto"
	importDelimiterComma     = "comma"
	importDelimiterTab       = "tab"
	importDelimiterSemicolon = "semicolon"
	importDelimiterPipe      = "pipe"
	importDelimiterProbeSize = 256 * 1024
)

var importDelimiterCandidates = []rune{',', '\t', ';', '|'}

func newImportCSVReader(source io.Reader, delimiterName string) (*csv.Reader, error) {
	return newImportCSVReaderWithLimits(source, delimiterName, importLexicalLimits{})
}

func resolveImportDelimiter(value string) (delimiter rune, explicit bool, err error) {
	if value == "" || value == importDelimiterAuto {
		return 0, false, nil
	}
	switch value {
	case importDelimiterComma:
		return ',', true, nil
	case importDelimiterTab:
		return '\t', true, nil
	case importDelimiterSemicolon:
		return ';', true, nil
	case importDelimiterPipe:
		return '|', true, nil
	default:
		return 0, false, fmt.Errorf("unsupported import delimiter %q", value)
	}
}

type importDelimiterProbeScore struct {
	delimiter      rune
	records        int
	consistentRows int
	fieldCount     int
}

func detectImportCSVDelimiter(prefix []byte) (rune, error) {
	best := importDelimiterProbeScore{delimiter: ','}
	tied := false
	for _, delimiter := range importDelimiterCandidates {
		score := scoreImportCSVDelimiter(prefix, delimiter)
		if compareImportDelimiterScores(score, best) > 0 {
			best = score
			tied = false
		} else if delimiter != best.delimiter && compareImportDelimiterScores(score, best) == 0 && score.consistentRows > 0 {
			tied = true
		}
	}
	if tied {
		return 0, fmt.Errorf("CSV delimiter probe is ambiguous; specify delimiter explicitly")
	}
	if best.consistentRows == 0 {
		// Preserve single-column CSV compatibility when no supported delimiter
		// appears outside quoted fields.
		return ',', nil
	}
	return best.delimiter, nil
}

func scoreImportCSVDelimiter(prefix []byte, delimiter rune) importDelimiterProbeScore {
	reader := csv.NewReader(bytes.NewReader(prefix))
	reader.Comma = delimiter
	reader.FieldsPerRecord = -1
	widthCounts := make(map[int]int)
	score := importDelimiterProbeScore{delimiter: delimiter}
	for score.records < 32 {
		record, err := reader.Read()
		if err != nil {
			break
		}
		score.records++
		if len(record) > 1 {
			widthCounts[len(record)]++
		}
	}
	for width, count := range widthCounts {
		if count > score.consistentRows || (count == score.consistentRows && width < score.fieldCount) {
			score.consistentRows = count
			score.fieldCount = width
		}
	}
	return score
}

func compareImportDelimiterScores(left, right importDelimiterProbeScore) int {
	if left.consistentRows != right.consistentRows {
		return left.consistentRows - right.consistentRows
	}
	if left.records != right.records {
		return left.records - right.records
	}
	return 0
}

func validateImportStringCells(format string, rowNumber int, values []string) error {
	totalBytes := 0
	for idx, value := range values {
		if len(value) > maxImportCellBytes {
			return &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileCellByteLimit,
				Row:    rowNumber,
				Cell:   idx + 1,
				Limit:  maxImportCellBytes,
			}
		}
		if totalBytes > maxImportRowBytes-len(value) {
			return &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileRowByteLimit,
				Row:    rowNumber,
				Limit:  maxImportRowBytes,
			}
		}
		totalBytes += len(value)
	}
	return nil
}

func validateImportMapRowBytes(format string, rowNumber int, row map[string]interface{}) (int, error) {
	totalBytes := 0
	for column, value := range row {
		valueBytes := importValueByteSize(value)
		if valueBytes > maxImportCellBytes {
			return 0, &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileCellByteLimit,
				Row:    rowNumber,
				Column: column,
				Limit:  maxImportCellBytes,
			}
		}
		if totalBytes > maxImportRowBytes-valueBytes {
			return 0, &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileRowByteLimit,
				Row:    rowNumber,
				Limit:  maxImportRowBytes,
			}
		}
		totalBytes += valueBytes
	}
	return totalBytes, nil
}

func importValueByteSize(value interface{}) int {
	switch typed := value.(type) {
	case nil:
		return 0
	case string:
		return len(typed)
	case []byte:
		return len(typed)
	case json.Number:
		return len(typed.String())
	case bool:
		if typed {
			return len("true")
		}
		return len("false")
	case []interface{}:
		total := 0
		for _, item := range typed {
			total += importValueByteSize(item)
		}
		return total
	case map[string]interface{}:
		total := 0
		for key, item := range typed {
			total += len(key) + importValueByteSize(item)
		}
		return total
	default:
		return len(fmt.Sprintf("%v", typed))
	}
}
