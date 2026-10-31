package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func newExportFileWriterWithContext(ctx context.Context, f io.Writer, options ExportFileOptions) (exportFileWriter, error) {
	if isPluginExportRequest(options) {
		return nil, errors.New("plugin formats require the materialized snapshot entrypoint")
	}
	options = normalizeExportFileOptions("", options)
	switch options.Format {
	case "csv":
		if options.LosslessHive {
			return newHiveCSVFileWriter(f, options.ColumnComments, options.CSVEncoding)
		}
		return newCSVExportFileWriter(f, options.ColumnComments, options.CSVEncoding)
	case "parquet":
		return newParquetExportFileWriter(ctx, f), nil
	case "json":
		return newJSONExportFileWriter(f)
	case "md":
		return &markdownExportFileWriter{file: f, columnComments: options.ColumnComments}, nil
	case "html":
		return newHTMLExportFileWriter(f, options.ColumnComments), nil
	case "xlsx":
		file, ok := f.(xlsxExportOutputFile)
		if !ok {
			return nil, fmt.Errorf("xlsx export requires a seekable file")
		}
		writeOptions := xlsxExportWriteOptions{columnComments: options.ColumnComments}
		if managed, ok := f.(*webTransferFile); ok {
			writeOptions.tempDir = filepath.Dir(managed.file.Name())
			writeOptions.budget = managed.budget
		}
		writer, err := newXLSXExportFileWriter(file, options.XLSXMaxRowsPerSheet, writeOptions)
		if err == nil {
			writer.losslessHive = options.LosslessHive
		}
		return writer, err
	case "sql":
		return newSQLInsertExportFileWriter(f, options)
	default:
		return nil, fmt.Errorf("unsupported format: %s", options.Format)
	}
}

func exportQueryResultToFileWithContext(ctx context.Context, f io.Writer, dbInst db.Database, config connection.ConnectionConfig, query string, options ExportFileOptions, reporter *exportProgressReporter) (int64, []string, error) {
	if isPluginExportRequest(options) {
		return 0, nil, errors.New("plugin formats require the materialized snapshot entrypoint")
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return 0, nil, err
	}
	writer, err := newHiveAwareQueryFileWriter(ctx, f, config, options)
	if err != nil {
		return 0, nil, err
	}

	if reporter != nil {
		reporter.Start(reporter.text("data_export.progress.stage.querying_data", nil))
	}
	var projection *exportColumnProjectionConsumer
	delegate := db.QueryStreamConsumer(writer)
	if len(options.Columns) > 0 {
		projection = &exportColumnProjectionConsumer{
			delegate:         writer,
			requestedColumns: options.Columns,
		}
		delegate = projection
	}
	consumer := &countingExportConsumer{delegate: delegate, reporter: reporter}
	streamErr := streamQueryDataForExportWithContext(ctx, dbInst, config, query, consumer)
	if reporter != nil && streamErr == nil {
		reporter.Finalizing(consumer.rowCount)
	}
	var closeErr error
	if streamErr != nil {
		closeErr = abortExportFileWriter(writer)
	} else {
		closeErr = writer.Close()
	}
	exportedColumns := consumer.columns
	if projection != nil {
		exportedColumns = projection.columns
	}
	if streamErr != nil {
		return consumer.rowCount, exportedColumns, errors.Join(streamErr, closeErr)
	}
	if closeErr != nil {
		return consumer.rowCount, exportedColumns, closeErr
	}
	return consumer.rowCount, exportedColumns, nil
}

func writeRowsToFileWithReporter(exportCtx context.Context, f io.Writer, data []map[string]interface{}, columns []string, options ExportFileOptions, reporter *exportProgressReporter) (int64, error) {
	if isPluginExportRequest(options) {
		return 0, errors.New("plugin formats require the materialized snapshot entrypoint")
	}
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
	columns = resolveExportColumns(columns, data)
	columns, err := resolveRequestedExportColumns(columns, options.Columns)
	if err != nil {
		return 0, err
	}
	writer, err := newExportFileWriterWithContext(exportCtx, f, options)
	if err != nil {
		return 0, err
	}
	var consumer db.QueryStreamConsumer = writer
	if options.LosslessHive {
		consumer = &hiveExportConsumer{delegate: writer}
	}
	if err := consumer.SetColumns(columns); err != nil {
		return 0, errors.Join(err, abortExportFileWriter(writer))
	}
	if reporter != nil {
		reporter.ForceRunning(0, reporter.text("data_export.progress.stage.writing_file", nil))
	}
	for index, row := range data {
		if err := exportCtx.Err(); err != nil {
			return int64(index), errors.Join(err, abortExportFileWriter(writer))
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return int64(index), errors.Join(err, abortExportFileWriter(writer))
		}
		if reporter != nil {
			reporter.Rows(int64(index+1), reporter.text("data_export.progress.stage.writing_file", nil))
		}
	}
	if reporter != nil {
		reporter.Finalizing(int64(len(data)))
	}
	if err := writer.Close(); err != nil {
		return int64(len(data)), err
	}
	return int64(len(data)), nil
}
