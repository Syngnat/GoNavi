package app

import (
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"GoNavi-Wails/internal/db"
)

const (
	maxCompressedExportEncodedBytes = 60 * 1024 * 1024
	maxCompressedExportDecodedBytes = 512 * 1024 * 1024
)

func newCompressedExportDecoder(encoded string) (*json.Decoder, io.Closer, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return nil, nil, fmt.Errorf("compressed export data required")
	}
	if len(encoded) > maxCompressedExportEncodedBytes {
		return nil, nil, fmt.Errorf("compressed export data exceeds the transport limit")
	}
	base64Reader := base64.NewDecoder(base64.StdEncoding, strings.NewReader(encoded))
	gzipReader, err := gzip.NewReader(base64Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("decode compressed export data: %w", err)
	}
	decoder := json.NewDecoder(io.LimitReader(gzipReader, maxCompressedExportDecodedBytes+1))
	token, err := decoder.Token()
	if err != nil {
		_ = gzipReader.Close()
		return nil, nil, fmt.Errorf("parse compressed export data: %w", err)
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '[' {
		_ = gzipReader.Close()
		return nil, nil, fmt.Errorf("compressed export data must be a JSON array")
	}
	return decoder, gzipReader, nil
}

func firstCompressedExportRow(decoder *json.Decoder) (map[string]interface{}, bool, error) {
	if !decoder.More() {
		return nil, false, nil
	}
	var row map[string]interface{}
	if err := decoder.Decode(&row); err != nil {
		return nil, false, fmt.Errorf("parse compressed export row: %w", err)
	}
	return row, true, nil
}

func resolveCompressedExportColumns(columns []string, requested []string, firstRow map[string]interface{}, hasFirst bool) ([]string, error) {
	if len(columns) == 0 && hasFirst {
		columns = resolveExportColumns(nil, []map[string]interface{}{firstRow})
	}
	return resolveRequestedExportColumns(columns, requested)
}

func startCompressedExportWriter(
	exportCtx context.Context,
	f io.Writer,
	columns []string,
	options ExportFileOptions,
	reporter *exportProgressReporter,
) (exportFileWriter, db.QueryStreamConsumer, error) {
	writer, err := newExportFileWriterWithContext(exportCtx, f, options)
	if err != nil {
		return nil, nil, err
	}
	var consumer db.QueryStreamConsumer = writer
	if options.LosslessHive {
		consumer = &hiveExportConsumer{delegate: writer}
	}
	if err := consumer.SetColumns(columns); err != nil {
		return writer, consumer, err
	}
	if reporter != nil {
		reporter.ForceRunning(0, reporter.text("data_export.progress.stage.writing_file", nil))
	}
	return writer, consumer, nil
}

func finishCompressedExportArray(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("parse compressed export data: %w", err)
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != ']' {
		return fmt.Errorf("compressed export data has no closing array")
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err == nil {
		return fmt.Errorf("compressed export data has trailing content")
	} else if !errors.Is(err, io.EOF) {
		return fmt.Errorf("parse trailing compressed export data: %w", err)
	}
	return nil
}

// writeGzipBase64RowsToFileWithReporter decodes the query-result row array as a
// stream so large materialized exports do not have to fit in one Wails IPC body.
// The row array is expected to be JSON gzip-compressed by the frontend; the
// output format is still selected by ExportFileOptions exactly as before.
func writeGzipBase64RowsToFileWithReporter(
	exportCtx context.Context,
	f io.Writer,
	encoded string,
	columns []string,
	options ExportFileOptions,
	reporter *exportProgressReporter,
) (int64, error) {
	if f == nil {
		return 0, fmt.Errorf("file required")
	}
	if exportCtx == nil {
		exportCtx = context.Background()
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return 0, err
	}

	decoder, closer, err := newCompressedExportDecoder(encoded)
	if err != nil {
		return 0, err
	}
	defer closer.Close()

	if err := exportCtx.Err(); err != nil {
		return 0, err
	}
	firstRow, hasFirst, err := firstCompressedExportRow(decoder)
	if err != nil {
		return 0, err
	}
	columns, err = resolveCompressedExportColumns(columns, options.Columns, firstRow, hasFirst)
	if err != nil {
		return 0, err
	}

	writer, consumer, err := startCompressedExportWriter(exportCtx, f, columns, options, reporter)
	if err != nil {
		if writer != nil {
			return 0, errors.Join(err, abortExportFileWriter(writer))
		}
		return 0, err
	}
	var rowCount int64
	abort := func(err error) (int64, error) {
		return rowCount, errors.Join(err, abortExportFileWriter(writer))
	}

	if hasFirst {
		if err := consumer.ConsumeRow(firstRow); err != nil {
			return abort(err)
		}
		rowCount++
		if reporter != nil {
			reporter.Rows(rowCount, reporter.text("data_export.progress.stage.writing_file", nil))
		}
	}
	for decoder.More() {
		if err := exportCtx.Err(); err != nil {
			return abort(err)
		}
		var row map[string]interface{}
		if err := decoder.Decode(&row); err != nil {
			return abort(fmt.Errorf("parse compressed export row: %w", err))
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return abort(err)
		}
		rowCount++
		if reporter != nil {
			reporter.Rows(rowCount, reporter.text("data_export.progress.stage.writing_file", nil))
		}
	}

	if err := finishCompressedExportArray(decoder); err != nil {
		return abort(err)
	}

	if reporter != nil {
		reporter.Finalizing(rowCount)
	}
	if err := writer.Close(); err != nil {
		return rowCount, err
	}
	return rowCount, nil
}
