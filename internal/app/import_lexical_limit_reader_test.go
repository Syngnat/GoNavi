package app

import (
	"errors"
	"io"
	"strings"
	"testing"
)

type importLexicalTestChunkReader struct {
	source io.Reader
	chunk  int
}

func (reader *importLexicalTestChunkReader) Read(buffer []byte) (int, error) {
	if len(buffer) > reader.chunk {
		buffer = buffer[:reader.chunk]
	}
	return reader.source.Read(buffer)
}

func TestCSVReaderRejectsOversizedLogicalCellBeforeDecode(t *testing.T) {
	reader, err := newImportCSVReaderWithLimits(
		strings.NewReader("id,payload\n1,123456789\n"),
		importDelimiterComma,
		importLexicalLimits{maxCellBytes: 8, maxRowBytes: 64},
	)
	if err != nil {
		t.Fatalf("create CSV reader: %v", err)
	}
	reader.FieldsPerRecord = -1

	if header, err := reader.Read(); err != nil || len(header) != 2 {
		t.Fatalf("read header = %#v, %v", header, err)
	}
	_, err = reader.Read()
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) {
		t.Fatalf("read oversized row error = %v, want ImportFileLimitError", err)
	}
	if limitErr.Kind != ImportFileCellByteLimit || limitErr.Format != "CSV" || limitErr.Row != 2 || limitErr.Cell != 2 || limitErr.Limit != 8 {
		t.Fatalf("limit error = %#v", limitErr)
	}
	if strings.Contains(err.Error(), "123456789") {
		t.Fatalf("limit error leaked cell content: %v", err)
	}
}

func TestJSONDecoderRejectsOversizedStringBeforeDecode(t *testing.T) {
	decoder := newImportJSONDecoderWithLimits(
		strings.NewReader(`[{"id":1,"payload":"123456789"}]`),
		importLexicalLimits{maxCellBytes: 8, maxRowBytes: 128},
	)
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("read root token: %v", err)
	}
	var row map[string]interface{}
	err := decoder.Decode(&row)
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) {
		t.Fatalf("decode oversized string error = %v, want ImportFileLimitError", err)
	}
	if limitErr.Kind != ImportFileCellByteLimit || limitErr.Format != "JSON" || limitErr.Row != 1 || limitErr.Column != "payload" || limitErr.Limit != 8 {
		t.Fatalf("limit error = %#v", limitErr)
	}
	if strings.Contains(err.Error(), "123456789") {
		t.Fatalf("limit error leaked JSON value: %v", err)
	}
}

func TestJSONDecoderReportsLaterElementRowAndColumn(t *testing.T) {
	decoder := newImportJSONDecoderWithLimits(
		strings.NewReader(`[{"a":"ok"},{"b":"12345"}]`),
		importLexicalLimits{maxCellBytes: 4, maxRowBytes: 64},
	)
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("read root token: %v", err)
	}
	var first map[string]interface{}
	if err := decoder.Decode(&first); err != nil {
		t.Fatalf("decode first row: %v", err)
	}
	var second map[string]interface{}
	err := decoder.Decode(&second)
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) || limitErr.Row != 2 || limitErr.Column != "b" {
		t.Fatalf("second-row limit error = %#v (%v)", limitErr, err)
	}
}

func TestJSONDecoderTracksEscapedStringsAcrossNestedValues(t *testing.T) {
	decoder := newImportJSONDecoderWithLimits(
		strings.NewReader(`[{"m":{"n":"a\"b","u":"\u4F60"}}]`),
		importLexicalLimits{maxCellBytes: 64, maxRowBytes: 128},
	)
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("read root token: %v", err)
	}
	var row map[string]interface{}
	if err := decoder.Decode(&row); err != nil {
		t.Fatalf("decode nested row: %v", err)
	}
	nested, ok := row["m"].(map[string]interface{})
	if !ok || nested["n"] != `a"b` || nested["u"] != "你" {
		t.Fatalf("decoded nested row = %#v", row)
	}
}

func TestJSONDecoderTracksUnicodeEscapeAcrossReadBoundaries(t *testing.T) {
	source := &importLexicalTestChunkReader{
		source: strings.NewReader(`[{"u":"\u4F60"}]`),
		chunk:  1,
	}
	decoder := newImportJSONDecoderWithLimits(
		source,
		importLexicalLimits{maxCellBytes: 6, maxRowBytes: 64},
	)
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("read root token: %v", err)
	}
	var row map[string]interface{}
	if err := decoder.Decode(&row); err != nil {
		t.Fatalf("decode unicode row: %v", err)
	}
	if row["u"] != "你" {
		t.Fatalf("decoded row = %#v", row)
	}
}

func TestJSONDecoderRejectsOversizedTopLevelArrayElementBeforeDecode(t *testing.T) {
	decoder := newImportJSONDecoderWithLimits(
		strings.NewReader(`[{"a":[1,2,3]}]`),
		importLexicalLimits{maxCellBytes: 64, maxRowBytes: 12},
	)
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("read root token: %v", err)
	}
	var row map[string]interface{}
	err := decoder.Decode(&row)
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) || limitErr.Kind != ImportFileRowByteLimit || limitErr.Row != 1 || limitErr.Limit != 12 {
		t.Fatalf("row limit error = %#v (%v)", limitErr, err)
	}
}

func TestJSONDecoderRejectsOversizedCompositeColumnBeforeDecode(t *testing.T) {
	decoder := newImportJSONDecoderWithLimits(
		strings.NewReader(`[{"payload":{"a":"123","b":"456"}}]`),
		importLexicalLimits{maxCellBytes: 16, maxRowBytes: 128},
	)
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("read root token: %v", err)
	}
	var row map[string]interface{}
	err := decoder.Decode(&row)
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) || limitErr.Kind != ImportFileCellByteLimit || limitErr.Row != 1 || limitErr.Column != "payload" || limitErr.Limit != 16 {
		t.Fatalf("composite cell limit error = %#v (%v)", limitErr, err)
	}
}

func TestCSVReaderCountsQuotedEscapesAndCRLFAsLogicalFieldContent(t *testing.T) {
	reader, err := newImportCSVReaderWithLimits(
		strings.NewReader("id;data\r\n1;\"a\"\"b\"\r\n2;\"a\r\nb\"\r\n"),
		importDelimiterSemicolon,
		importLexicalLimits{maxCellBytes: 4, maxRowBytes: 16},
	)
	if err != nil {
		t.Fatalf("create CSV reader: %v", err)
	}
	reader.FieldsPerRecord = -1

	want := [][]string{{"id", "data"}, {"1", `a"b`}, {"2", "a\nb"}}
	for index, wantRecord := range want {
		got, readErr := reader.Read()
		if readErr != nil {
			t.Fatalf("read record %d: %v", index+1, readErr)
		}
		if len(got) != len(wantRecord) || got[0] != wantRecord[0] || got[1] != wantRecord[1] {
			t.Fatalf("record %d = %#v, want %#v", index+1, got, wantRecord)
		}
	}
}

func TestCSVReaderRejectsCombinedLogicalRowBeforeDecode(t *testing.T) {
	reader, err := newImportCSVReaderWithLimits(
		strings.NewReader("a,b\n12,345\n"),
		importDelimiterComma,
		importLexicalLimits{maxCellBytes: 8, maxRowBytes: 4},
	)
	if err != nil {
		t.Fatalf("create CSV reader: %v", err)
	}
	reader.FieldsPerRecord = -1
	if _, err := reader.Read(); err != nil {
		t.Fatalf("read header: %v", err)
	}
	_, err = reader.Read()
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) || limitErr.Kind != ImportFileRowByteLimit || limitErr.Row != 2 || limitErr.Limit != 4 {
		t.Fatalf("row limit error = %#v (%v)", limitErr, err)
	}
}

func TestCSVReaderBoundsRawRecordSyntaxBeforeFieldSliceGrowth(t *testing.T) {
	reader, err := newImportCSVReaderWithLimits(
		strings.NewReader("a\n,,,,,\n"),
		importDelimiterComma,
		importLexicalLimits{maxCellBytes: 8, maxRowBytes: 4},
	)
	if err != nil {
		t.Fatalf("create CSV reader: %v", err)
	}
	reader.FieldsPerRecord = -1
	if _, err := reader.Read(); err != nil {
		t.Fatalf("read header: %v", err)
	}
	_, err = reader.Read()
	var limitErr *ImportFileLimitError
	if !errors.As(err, &limitErr) || limitErr.Kind != ImportFileRowByteLimit || limitErr.Row != 2 {
		t.Fatalf("raw row limit error = %#v (%v)", limitErr, err)
	}
}

func TestCSVReaderTracksCRLFAndEscapedQuoteAcrossReadBoundaries(t *testing.T) {
	source := &importLexicalTestChunkReader{
		source: strings.NewReader("a;b\r\n1;\"x\"\"y\"\r\n"),
		chunk:  1,
	}
	reader, err := newImportCSVReaderWithLimits(
		source,
		importDelimiterSemicolon,
		importLexicalLimits{maxCellBytes: 4, maxRowBytes: 16},
	)
	if err != nil {
		t.Fatalf("create CSV reader: %v", err)
	}
	reader.FieldsPerRecord = -1
	if _, err := reader.Read(); err != nil {
		t.Fatalf("read header: %v", err)
	}
	row, err := reader.Read()
	if err != nil {
		t.Fatalf("read row: %v", err)
	}
	if len(row) != 2 || row[0] != "1" || row[1] != `x"y` {
		t.Fatalf("row = %#v", row)
	}
}
