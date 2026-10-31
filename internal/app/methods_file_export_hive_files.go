package app

import (
	"context"
	"fmt"
	"io"
	"strconv"

	"GoNavi-Wails/internal/connection"
)

func newHiveAwareQueryFileWriter(ctx context.Context, output io.Writer, config connection.ConnectionConfig, options ExportFileOptions) (exportFileWriter, error) {
	options.LosslessHive = options.LosslessHive || resolveDDLDBType(config) == "hive"
	return newExportFileWriterWithContext(ctx, output, options)
}

func (w *xlsxExportFileWriter) consumeHiveValues(values []interface{}) error {
	if w.rowCount >= w.maxRows {
		if err := w.rotateSheet(); err != nil {
			return err
		}
	}
	if w.current == nil {
		return fmt.Errorf("xlsx sheet not initialized")
	}
	rowRef := strconv.Itoa(w.nextRow)
	if _, err := w.current.writer.WriteString("<row r=\"" + rowRef + "\">"); err != nil {
		return err
	}
	for i := range w.columns {
		var value interface{}
		if i < len(values) {
			value = values[i]
		}
		if value == nil {
			continue
		} // Absent cell is SQL NULL; an inlineStr empty cell is not.
		if err := writeXLSXInlineStringCell(w.current.writer, w.columnRefs[i], rowRef, formatExportCellText(value)); err != nil {
			return err
		}
	}
	if _, err := w.current.writer.WriteString("</row>"); err != nil {
		return err
	}
	w.nextRow++
	w.rowCount++
	return nil
}
