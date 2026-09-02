package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

type importBatchSizeRecorder struct {
	batchSizes []int
	batchErr   error
	singleErr  error
}

type importSourceProgressSnapshot struct {
	bytesRead  int64
	totalBytes int64
	stage      string
}

type importSourceProgressRecorder struct {
	importCollectConsumer
	progress []importSourceProgressSnapshot
}

type cancelAfterFirstImportRowConsumer struct {
	cancel context.CancelFunc
	rows   int
}

func (c *cancelAfterFirstImportRowConsumer) SetColumns([]string) error { return nil }

func (c *cancelAfterFirstImportRowConsumer) ConsumeRow(map[string]interface{}) error {
	c.rows++
	if c.rows == 1 {
		c.cancel()
	}
	return nil
}

func (c *importSourceProgressRecorder) SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string) {
	c.progress = append(c.progress, importSourceProgressSnapshot{
		bytesRead:  bytesRead,
		totalBytes: totalBytes,
		stage:      stage,
	})
}

func (w *importBatchSizeRecorder) SetColumns([]string) {}

func (w *importBatchSizeRecorder) ApplyBatch(rows []map[string]interface{}) error {
	w.batchSizes = append(w.batchSizes, len(rows))
	return w.batchErr
}

func (w *importBatchSizeRecorder) ApplyOne(map[string]interface{}) error { return w.singleErr }

func (w *importBatchSizeRecorder) BatchEnabled() bool { return true }

func TestBuildImportPreviewStopsAtLimitAndMarksTotalUnknown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.csv")
	content := "id,name\n" +
		"1,user_1\n" +
		"2,user_2\n" +
		"3,user_3\n" +
		"4,user_4\n" +
		"5,user_5\n" +
		"6,\"unterminated\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("preview should stop before malformed tail: %v", err)
	}
	if preview.TotalRows != 5 || len(preview.PreviewRows) != 5 {
		t.Fatalf("preview rows = total %d, retained %d; want 5 and 5", preview.TotalRows, len(preview.PreviewRows))
	}

	known := reflect.ValueOf(preview).FieldByName("TotalRowsKnown")
	if !known.IsValid() {
		t.Fatal("preview result must expose TotalRowsKnown")
	}
	if known.Bool() {
		t.Fatal("short-circuited preview must mark total rows unknown")
	}
}

func TestBuildImportPreviewWithOptionsContextRejectsPreCancelledRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := buildImportPreviewWithOptionsContext(ctx, "does-not-need-to-exist.csv", 5, ImportFileOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("preview error = %v, want context.Canceled", err)
	}
}

func TestStreamImportFileWithOptionsContextStopsBetweenRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	consumer := &cancelAfterFirstImportRowConsumer{cancel: cancel}

	err := streamImportFileWithOptionsContext(ctx, path, consumer, ImportFileOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("stream error = %v, want context.Canceled", err)
	}
	if consumer.rows != 1 {
		t.Fatalf("consumed rows = %d, want cancellation before row 2", consumer.rows)
	}
}

func TestBuildImportPreviewWithOptionsUsesConfiguredParser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	content := "exported by GoNavi\nid;name\n1;alice\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}
	preview, err := buildImportPreviewWithOptions(
		path,
		5,
		ImportFileOptions{Delimiter: "semicolon", HeaderRow: 2},
	)
	if err != nil {
		t.Fatalf("build configured preview: %v", err)
	}
	if !reflect.DeepEqual(preview.Columns, []string{"id", "name"}) {
		t.Fatalf("columns = %#v", preview.Columns)
	}
	if !reflect.DeepEqual(preview.PreviewRows, []map[string]interface{}{{"id": "1", "name": "alice"}}) {
		t.Fatalf("preview rows = %#v", preview.PreviewRows)
	}
}

func TestTextImportStreamsReportSourceByteProgress(t *testing.T) {
	tests := []struct {
		name    string
		ext     string
		content string
	}{
		{name: "CSV", ext: ".csv", content: "id,name\n1,alice\n2,bob\n"},
		{name: "JSON", ext: ".json", content: `[{"id":1},{"id":2}]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rows"+test.ext)
			if err := os.WriteFile(path, []byte(test.content), 0o600); err != nil {
				t.Fatalf("write import file: %v", err)
			}
			consumer := &importSourceProgressRecorder{}
			if err := streamImportFile(path, consumer); err != nil {
				t.Fatalf("stream import file: %v", err)
			}
			if len(consumer.progress) == 0 {
				t.Fatal("source byte progress was not reported")
			}
			last := consumer.progress[len(consumer.progress)-1]
			if last.bytesRead != int64(len(test.content)) || last.totalBytes != int64(len(test.content)) || last.stage != "parse" {
				t.Fatalf("last source progress = %#v, want full parse bytes", last)
			}
		})
	}
}

func TestCSVImportStripsUTF8BOMFromFirstHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, []byte("\xEF\xBB\xBFid,name\n1,alice\n"), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("build preview: %v", err)
	}
	if !reflect.DeepEqual(preview.Columns, []string{"id", "name"}) {
		t.Fatalf("columns = %#v, want BOM-free header", preview.Columns)
	}
	if got := preview.PreviewRows[0]["id"]; got != "1" {
		t.Fatalf("id = %#v, want 1", got)
	}
}

func TestCSVImportRejectsDuplicateHeadersBeforeRowsAreMapped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, []byte("id, ID \n1,2\n"), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	err := streamImportFile(path, &importCollectConsumer{})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "duplicate") {
		t.Fatalf("duplicate header error = %v", err)
	}
}

func TestCSVImportDecodesUTF16LEBOMWithAutoEncoding(t *testing.T) {
	raw, _, err := transform.Bytes(
		unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder(),
		[]byte("id,name\n1,张三\n"),
	)
	if err != nil {
		t.Fatalf("encode UTF-16LE fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}

	consumer := &importSourceProgressRecorder{}
	if err := streamImportFileWithOptions(path, consumer, ImportFileOptions{Encoding: "auto"}); err != nil {
		t.Fatalf("stream UTF-16LE CSV: %v", err)
	}
	if !reflect.DeepEqual(consumer.columns, []string{"id", "name"}) {
		t.Fatalf("columns = %#v", consumer.columns)
	}
	if got := consumer.rows[0]["name"]; got != "张三" {
		t.Fatalf("name = %#v, want 张三", got)
	}
	last := consumer.progress[len(consumer.progress)-1]
	if last.bytesRead != int64(len(raw)) || last.totalBytes != int64(len(raw)) {
		t.Fatalf("raw progress = %#v, want %d bytes", last, len(raw))
	}
}

func TestCSVImportDecodesExplicitUTF16BEWithoutBOM(t *testing.T) {
	raw, _, err := transform.Bytes(
		unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewEncoder(),
		[]byte("id,name\n1,李四\n"),
	)
	if err != nil {
		t.Fatalf("encode UTF-16BE fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}

	consumer := &importCollectConsumer{}
	if err := streamImportFileWithOptions(path, consumer, ImportFileOptions{Encoding: "utf-16be"}); err != nil {
		t.Fatalf("stream UTF-16BE CSV: %v", err)
	}
	if got := consumer.rows[0]["name"]; got != "李四" {
		t.Fatalf("name = %#v, want 李四", got)
	}
}

func TestCSVImportAutoEncodingFallsBackToGB18030(t *testing.T) {
	raw, _, err := transform.Bytes(
		simplifiedchinese.GB18030.NewEncoder(),
		[]byte("id,name\n1,张三\n"),
	)
	if err != nil {
		t.Fatalf("encode GB18030 fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}

	consumer := &importCollectConsumer{}
	if err := streamImportFileWithOptions(path, consumer, ImportFileOptions{Encoding: "auto"}); err != nil {
		t.Fatalf("stream GB18030 CSV: %v", err)
	}
	if got := consumer.rows[0]["name"]; got != "张三" {
		t.Fatalf("name = %#v, want 张三", got)
	}
}

func TestOpenImportTextSourceBoundsAutomaticEncodingDetection(t *testing.T) {
	const detectionSampleBytes = 1 << 20
	path := filepath.Join(t.TempDir(), "large.csv")
	content := append(bytes.Repeat([]byte("a"), detectionSampleBytes+1), 0xff)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}

	source, err := openImportTextSource(path, "auto")
	if err != nil {
		t.Fatalf("open import text source: %v", err)
	}
	defer source.Close()
	if source.encoding != importTextEncodingUTF8 {
		t.Fatalf("encoding = %q, want bounded UTF-8 detection", source.encoding)
	}
}

func TestCSVImportAutoDetectsTabWithoutCountingQuotedComma(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	content := "id\tdescription\n1\t\"alpha,beta\"\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}

	consumer := &importCollectConsumer{}
	if err := streamImportFileWithOptions(path, consumer, ImportFileOptions{Delimiter: "auto"}); err != nil {
		t.Fatalf("stream tab-delimited CSV: %v", err)
	}
	if !reflect.DeepEqual(consumer.columns, []string{"id", "description"}) {
		t.Fatalf("columns = %#v", consumer.columns)
	}
	if got := consumer.rows[0]["description"]; got != "alpha,beta" {
		t.Fatalf("description = %#v, want quoted comma preserved", got)
	}
}

func TestCSVImportAutoDelimiterFailsClosedWhenAmbiguous(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	content := "left|right,third\n1|2,3\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}
	err := streamImportFileWithOptions(path, &importCollectConsumer{}, ImportFileOptions{Delimiter: "auto"})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "ambiguous") {
		t.Fatalf("ambiguous delimiter error = %v", err)
	}
}

func TestCSVImportUsesConfiguredHeaderRow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	content := "exported by GoNavi\nid;name\n1;alice\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}

	consumer := &importCollectConsumer{}
	options := ImportFileOptions{Delimiter: "semicolon", HeaderRow: 2}
	if err := streamImportFileWithOptions(path, consumer, options); err != nil {
		t.Fatalf("stream CSV with second header row: %v", err)
	}
	if !reflect.DeepEqual(consumer.columns, []string{"id", "name"}) {
		t.Fatalf("columns = %#v", consumer.columns)
	}
	if !reflect.DeepEqual(consumer.rows, []map[string]interface{}{{"id": "1", "name": "alice"}}) {
		t.Fatalf("rows = %#v", consumer.rows)
	}
}

func TestCSVImportNormalizesConfiguredNullTokenAndEmptyString(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, []byte("id,marker,note\n1,\\N,\n"), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}
	nullToken := "\\N"
	consumer := &importCollectConsumer{}
	options := ImportFileOptions{NullToken: &nullToken, EmptyStringAsNull: true}
	if err := streamImportFileWithOptions(path, consumer, options); err != nil {
		t.Fatalf("stream CSV with null options: %v", err)
	}
	row := consumer.rows[0]
	if row["marker"] != nil || row["note"] != nil {
		t.Fatalf("normalized row = %#v, want marker and note null", row)
	}
}

func TestImportFileOptionsRejectUnknownConflictPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, []byte("id\n1\n"), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}
	err := streamImportFileWithOptions(
		path,
		&importCollectConsumer{},
		ImportFileOptions{ConflictPolicy: "overwrite_everything"},
	)
	if err == nil || !strings.Contains(err.Error(), "conflictPolicy") {
		t.Fatalf("unknown conflict policy error = %v", err)
	}
}

func TestImportFileOptionsRejectUnknownParserEnums(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	if err := os.WriteFile(path, []byte("id\n1\n"), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}
	tests := []struct {
		name    string
		options ImportFileOptions
	}{
		{name: "encoding", options: ImportFileOptions{Encoding: "windows-1252"}},
		{name: "delimiter", options: ImportFileOptions{Delimiter: "colon"}},
		{name: "header row", options: ImportFileOptions{HeaderRow: maxImportHeaderRow + 1}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := streamImportFileWithOptions(path, &importCollectConsumer{}, test.options); err == nil {
				t.Fatalf("options %#v were accepted", test.options)
			}
		})
	}
}

func TestImportFileOptionsExposeStableJSONNames(t *testing.T) {
	nullToken := "\\N"
	encoded, err := json.Marshal(ImportFileOptions{
		Encoding:            "gb18030",
		Delimiter:           "pipe",
		HeaderRow:           2,
		NullToken:           &nullToken,
		EmptyStringAsNull:   true,
		SheetName:           "Data",
		SourceIdentityToken: "source-v1",
		ConflictPolicy:      "upsert",
		ConflictKeyColumns:  []string{"id"},
		ResumeJobID:         "job-v1",
	})
	if err != nil {
		t.Fatalf("marshal options: %v", err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("unmarshal options payload: %v", err)
	}
	for _, key := range []string{
		"encoding", "delimiter", "headerRow", "nullToken", "emptyStringAsNull",
		"sheetName", "sourceIdentityToken", "conflictPolicy", "conflictKeyColumns", "resumeJobId",
	} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("options JSON %s missing key %q", encoded, key)
		}
	}
}

func TestImportFileRejectsLegacyBinaryXLSWithClearError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.xls")
	if err := os.WriteFile(path, []byte("legacy binary workbook"), 0o600); err != nil {
		t.Fatalf("write XLS fixture: %v", err)
	}
	err := streamImportFile(path, &importCollectConsumer{})
	if err == nil || !strings.Contains(err.Error(), ".xls") || !strings.Contains(strings.ToLower(err.Error()), "not supported") {
		t.Fatalf("legacy XLS error = %v", err)
	}
}

func TestCSVImportRejectsCellOverByteLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.csv")
	content := "id,payload\n1," + strings.Repeat("x", 16*1024*1024+1) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	_, err := buildImportPreview(path, 5)
	if err == nil {
		t.Fatal("oversized CSV cell must be rejected")
	}
	if !strings.Contains(err.Error(), "cell 2 exceeds") {
		t.Fatalf("unexpected oversized-cell error: %v", err)
	}
}

func TestImportStringRowRejectsCombinedBytesOverLimit(t *testing.T) {
	value := strings.Repeat("x", 13*1024*1024)
	err := validateImportStringCells("CSV", 1, []string{value, value, value, value, value})
	if err == nil {
		t.Fatal("row whose cells exceed the combined byte limit must be rejected")
	}
	if !strings.Contains(err.Error(), "row 1 exceeds") {
		t.Fatalf("unexpected oversized-row error: %v", err)
	}
}

func TestImportBatchFlushesAtByteLimitBeforeRowLimit(t *testing.T) {
	writer := &importBatchSizeRecorder{}
	consumer := newImportBatchConsumer(writer, 1000, 7, true, false, nil)
	value := strings.Repeat("x", 10*1024*1024)
	for row := 1; row <= 7; row++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"payload": value}); err != nil {
			t.Fatalf("consume row %d: %v", row, err)
		}
	}
	if err := consumer.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if !reflect.DeepEqual(writer.batchSizes, []int{6, 1}) {
		t.Fatalf("batch sizes = %#v, want byte-bounded batches [6 1]", writer.batchSizes)
	}
}

func TestImportBatchConsumerReportsStructuredSanitizedRowError(t *testing.T) {
	writer := &importBatchSizeRecorder{
		singleErr: errors.New("duplicate key value is (alice@example.com); password=secret-token-123"),
	}
	consumer := newImportBatchConsumer(writer, 1, 1, true, true, nil)
	var reported []ImportRowError
	consumer.SetRowErrorHandler(func(rowError ImportRowError) error {
		reported = append(reported, rowError)
		return nil
	})
	row := map[string]interface{}{"id": 7, "name": "alice"}

	if err := consumer.ConsumeRow(row); err != nil {
		t.Fatalf("consume row: %v", err)
	}
	row["name"] = "mutated"
	if len(reported) != 1 {
		t.Fatalf("reported row errors = %d, want 1", len(reported))
	}
	got := reported[0]
	if got.SourceRow != 1 || got.Category == "" {
		t.Fatalf("unexpected row error identity: %#v", got)
	}
	if strings.Contains(got.Message, "alice@example.com") || strings.Contains(got.Message, "secret-token-123") {
		t.Fatalf("row error message was not sanitized: %q", got.Message)
	}
	if !reflect.DeepEqual(got.Values, map[string]interface{}{"id": 7, "name": "alice"}) {
		t.Fatalf("row error values = %#v, want cloned source values", got.Values)
	}
}

func TestImportBatchConsumerDoesNotInventRowErrorForUnknownBatchOutcome(t *testing.T) {
	writer := &importBatchSizeRecorder{batchErr: errors.New("password=secret-token-123")}
	consumer := newImportBatchConsumer(writer, 1, 1, true, false, nil)
	reportedRows := 0
	consumer.SetRowErrorHandler(func(ImportRowError) error {
		reportedRows++
		return nil
	})

	err := consumer.ConsumeRow(map[string]interface{}{"id": 7})
	if !errors.Is(err, errImportStoppedOnError) {
		t.Fatalf("consume row error = %v, want errImportStoppedOnError", err)
	}
	if reportedRows != 0 {
		t.Fatalf("unknown batch outcome reported %d concrete row errors", reportedRows)
	}
	result := consumer.Result()
	if !result.OutcomeUnknown || len(result.ErrorLogs) != 1 || !strings.Contains(result.ErrorLogs[0], "Rows 1-1") {
		t.Fatalf("unexpected unknown batch result: %#v", result)
	}
	if strings.Contains(result.ErrorLogs[0], "secret-token-123") {
		t.Fatalf("batch range error was not sanitized: %q", result.ErrorLogs[0])
	}
}

func TestImportBatchConsumerStopsWhenRejectedRowPersistenceFails(t *testing.T) {
	writer := &importBatchSizeRecorder{singleErr: errors.New("duplicate key")}
	consumer := newImportBatchConsumer(writer, 2, 2, true, true, nil)
	persistErr := errors.New("rejected-row artifact is full")
	callbackCalls := 0
	consumer.SetRowErrorHandler(func(ImportRowError) error {
		callbackCalls++
		return persistErr
	})

	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1}); err != nil {
		t.Fatalf("buffer first row: %v", err)
	}
	err := consumer.ConsumeRow(map[string]interface{}{"id": 2})
	if !errors.Is(err, persistErr) {
		t.Fatalf("consume row error = %v, want persistence failure", err)
	}
	if callbackCalls != 1 {
		t.Fatalf("row error callbacks = %d, want 1", callbackCalls)
	}
	result := consumer.Result()
	if !result.StoppedOnError || result.Failed != 1 || result.Success != 0 {
		t.Fatalf("unexpected persistence-stop result: %#v", result)
	}
}

func TestImportBatchConsumerThrottlesLargeSequentialProgress(t *testing.T) {
	writer := &importBatchSizeRecorder{}
	progress := make([]importProgressState, 0)
	consumer := newImportBatchConsumer(writer, 1000, 1000, true, true, func(state importProgressState) {
		progress = append(progress, state)
	})
	for row := 1; row <= 1000; row++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"id": row}); err != nil {
			t.Fatalf("consume row %d: %v", row, err)
		}
	}
	if err := consumer.Flush(); err != nil {
		t.Fatal(err)
	}
	if len(progress) >= 100 {
		t.Fatalf("progress events = %d, want bounded reporting", len(progress))
	}
	if len(progress) == 0 || progress[len(progress)-1].Current != 1000 {
		t.Fatalf("final progress = %#v, want row 1000", progress)
	}
}

func TestImportProgressStateExposesByteAndStageSeams(t *testing.T) {
	encoded, err := json.Marshal(importProgressState{
		BytesRead:  12,
		TotalBytes: 24,
		Stage:      "write",
	})
	if err != nil {
		t.Fatalf("marshal progress state: %v", err)
	}
	text := string(encoded)
	for _, want := range []string{`"bytesRead":12`, `"totalBytes":24`, `"stage":"write"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("progress payload %s missing %s", text, want)
		}
	}
}

func TestImportBatchConsumerProgressUsesWriteStage(t *testing.T) {
	writer := &importBatchSizeRecorder{}
	var progress []importProgressState
	consumer := newImportBatchConsumer(writer, 1, 1, true, false, func(state importProgressState) {
		progress = append(progress, state)
	})

	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1}); err != nil {
		t.Fatalf("consume row: %v", err)
	}
	if len(progress) != 1 || progress[0].Stage != "write" {
		t.Fatalf("progress = %#v, want one write-stage event", progress)
	}
}

func TestImportBatchConsumerProgressCarriesSourceBytes(t *testing.T) {
	writer := &importBatchSizeRecorder{}
	var progress []importProgressState
	consumer := newImportBatchConsumer(writer, 1, 1, true, false, func(state importProgressState) {
		progress = append(progress, state)
	})
	consumer.SetImportSourceProgress(12, 24, "parse")

	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1}); err != nil {
		t.Fatalf("consume row: %v", err)
	}
	if len(progress) != 1 || progress[0].BytesRead != 12 || progress[0].TotalBytes != 24 {
		t.Fatalf("progress = %#v, want source byte counters", progress)
	}
}

func TestImportColumnMappingConsumerForwardsSourceProgress(t *testing.T) {
	downstream := &importSourceProgressRecorder{}
	consumer := &importColumnMappingConsumer{downstream: downstream}
	reportImportSourceProgress(consumer, 12, 24)

	if len(downstream.progress) != 1 || downstream.progress[0].bytesRead != 12 || downstream.progress[0].totalBytes != 24 {
		t.Fatalf("forwarded progress = %#v, want source byte counters", downstream.progress)
	}
}

func TestJSONImportRejectsFieldsIntroducedAfterFirstRow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.json")
	content := `[{"id":1},{"id":2,"name":"alice"}]`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write json: %v", err)
	}

	_, err := buildImportPreview(path, 5)
	if err == nil {
		t.Fatal("later JSON fields must not be silently dropped")
	}
	if !strings.Contains(err.Error(), "row 2") || !strings.Contains(err.Error(), `"name"`) {
		t.Fatalf("structure drift error lacks row/field context: %v", err)
	}
}

func TestJSONImportPreservesLargeIntegerPrecision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.json")
	if err := os.WriteFile(path, []byte(`[{"id":9007199254740993}]`), 0o600); err != nil {
		t.Fatalf("write json: %v", err)
	}

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("build preview: %v", err)
	}
	value, ok := preview.PreviewRows[0]["id"].(json.Number)
	if !ok {
		t.Fatalf("id type = %T, want json.Number", preview.PreviewRows[0]["id"])
	}
	if value.String() != "9007199254740993" {
		t.Fatalf("id = %q, want exact integer", value.String())
	}
}

func TestJSONImportUsesStreamingUTF16TextSource(t *testing.T) {
	raw, _, err := transform.Bytes(
		unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder(),
		[]byte(`[{"id":1,"name":"张三"}]`),
	)
	if err != nil {
		t.Fatalf("encode UTF-16 JSON fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "rows.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write JSON: %v", err)
	}
	consumer := &importSourceProgressRecorder{}
	if err := streamImportFileWithOptions(path, consumer, ImportFileOptions{Encoding: "auto"}); err != nil {
		t.Fatalf("stream UTF-16 JSON: %v", err)
	}
	if got := consumer.rows[0]["name"]; got != "张三" {
		t.Fatalf("name = %#v, want 张三", got)
	}
	last := consumer.progress[len(consumer.progress)-1]
	if last.bytesRead != int64(len(raw)) || last.totalBytes != int64(len(raw)) {
		t.Fatalf("raw progress = %#v, want %d bytes", last, len(raw))
	}
}

func TestJSONImportNormalizesConfiguredStringNulls(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.json")
	if err := os.WriteFile(path, []byte(`[{"id":1,"marker":"\\N","note":""}]`), 0o600); err != nil {
		t.Fatalf("write JSON: %v", err)
	}
	nullToken := "\\N"
	consumer := &importCollectConsumer{}
	options := ImportFileOptions{NullToken: &nullToken, EmptyStringAsNull: true}
	if err := streamImportFileWithOptions(path, consumer, options); err != nil {
		t.Fatalf("stream JSON with null options: %v", err)
	}
	row := consumer.rows[0]
	if row["marker"] != nil || row["note"] != nil {
		t.Fatalf("normalized row = %#v, want marker and note null", row)
	}
}

func TestJSONImportRejectsTrailingContentAfterArray(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.json")
	if err := os.WriteFile(path, []byte(`[{"id":1}] {"id":2}`), 0o600); err != nil {
		t.Fatalf("write json: %v", err)
	}

	_, err := buildImportPreview(path, 5)
	if err == nil {
		t.Fatal("JSON content after the root array must be rejected")
	}
	if !strings.Contains(err.Error(), "trailing content") {
		t.Fatalf("unexpected trailing-content error: %v", err)
	}
}

func TestJSONImportRejectsCellOverByteLimitDuringPreview(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rows.json")
	content := `[{"payload":"` + strings.Repeat("x", 16*1024*1024+1) + `"}]`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write json: %v", err)
	}

	_, err := buildImportPreview(path, 5)
	if err == nil {
		t.Fatal("oversized JSON cell must be rejected during preview")
	}
	if !strings.Contains(err.Error(), `column "payload" exceeds`) {
		t.Fatalf("unexpected oversized JSON cell error: %v", err)
	}
}
