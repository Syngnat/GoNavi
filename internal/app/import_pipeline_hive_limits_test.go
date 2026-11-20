package app

import (
	"bufio"
	"errors"
	"strings"
	"testing"
)

func TestHiveCSVRecordHonorsLexicalFieldLimit(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("a,b,c\n"))
	_, err := readHiveCSVRecord(reader, ',', importLexicalLimits{
		maxCellBytes: 16,
		maxRowBytes:  64,
		maxFields:    2,
	})
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) || limitErr.Kind != ImportFileFieldLimit {
		t.Fatalf("Hive CSV field limit error = %#v (%v)", limitErr, err)
	}
}

func TestHiveXLSXHonorsLexicalFieldLimit(t *testing.T) {
	path := writeXLSXTestArchive(t, minimalXLSXTestEntries(
		`<sst></sst>`,
		inlineStringXLSXSheet([][]string{
			{"a"},
			{"1", "2"},
		}),
	))
	err := streamImportFileWithOptions(path, newImportPreviewCollector(10), ImportFileOptions{
		LosslessHive: true,
		lexicalLimits: importLexicalLimits{
			maxCellBytes: 64,
			maxRowBytes:  1024,
			maxFields:    1,
		},
	})
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) || limitErr.Kind != ImportFileFieldLimit {
		t.Fatalf("Hive XLSX field limit error = %#v (%v)", limitErr, err)
	}
}
