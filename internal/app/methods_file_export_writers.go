package app

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
)

type exportFileWriter interface {
	db.QueryStreamConsumer
	Close() error
}

type exportValueStreamConsumer interface {
	ConsumeRowValues(values []interface{}) error
}

type exportColumnProjectionConsumer struct {
	delegate         db.QueryStreamConsumer
	requestedColumns []string
	columns          []string
	columnIndexes    []int
	values           []interface{}
}

func (c *exportColumnProjectionConsumer) SetColumns(columns []string) error {
	selectedColumns, err := resolveRequestedExportColumns(columns, c.requestedColumns)
	if err != nil {
		return err
	}
	indexByColumn := make(map[string]int, len(columns))
	for index, column := range columns {
		if _, exists := indexByColumn[column]; !exists {
			indexByColumn[column] = index
		}
	}

	c.columns = selectedColumns
	c.columnIndexes = make([]int, len(selectedColumns))
	for index, column := range selectedColumns {
		c.columnIndexes[index] = indexByColumn[column]
	}
	c.values = make([]interface{}, len(c.columns))
	if c.delegate == nil {
		return nil
	}
	return c.delegate.SetColumns(c.columns)
}

func (c *exportColumnProjectionConsumer) ConsumeRow(row map[string]interface{}) error {
	if c.delegate == nil {
		return nil
	}
	return c.delegate.ConsumeRow(row)
}

func (c *exportColumnProjectionConsumer) ConsumeRowValues(values []interface{}) error {
	for selectedIndex, sourceIndex := range c.columnIndexes {
		if sourceIndex < len(values) {
			c.values[selectedIndex] = values[sourceIndex]
		} else {
			c.values[selectedIndex] = nil
		}
	}
	if c.delegate == nil {
		return nil
	}
	if valueConsumer, ok := c.delegate.(exportValueStreamConsumer); ok {
		return valueConsumer.ConsumeRowValues(c.values)
	}
	row := make(map[string]interface{}, len(c.columns))
	for index, column := range c.columns {
		row[column] = c.values[index]
	}
	return c.delegate.ConsumeRow(row)
}

type countingExportConsumer struct {
	delegate db.QueryStreamConsumer
	columns  []string
	rowCount int64
	reporter *exportProgressReporter
}

func (c *countingExportConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	if c.delegate != nil {
		if err := c.delegate.SetColumns(columns); err != nil {
			return err
		}
	}
	if c.reporter != nil {
		c.reporter.ForceRunning(c.rowCount, c.reporter.text("data_export.progress.stage.writing_file", nil))
	}
	return nil
}

func (c *countingExportConsumer) ConsumeRow(row map[string]interface{}) error {
	if c.delegate != nil {
		if err := c.delegate.ConsumeRow(row); err != nil {
			return err
		}
	}
	c.rowCount++
	if c.reporter != nil {
		c.reporter.Rows(c.rowCount, c.reporter.text("data_export.progress.stage.writing_file", nil))
	}
	return nil
}

func (c *countingExportConsumer) ConsumeRowValues(values []interface{}) error {
	if c.delegate != nil {
		if valueConsumer, ok := c.delegate.(exportValueStreamConsumer); ok {
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
		} else {
			row := make(map[string]interface{}, len(c.columns))
			for i, column := range c.columns {
				if i < len(values) {
					row[column] = values[i]
				} else {
					row[column] = nil
				}
			}
			if err := c.delegate.ConsumeRow(row); err != nil {
				return err
			}
		}
	}
	c.rowCount++
	if c.reporter != nil {
		c.reporter.Rows(c.rowCount, c.reporter.text("data_export.progress.stage.writing_file", nil))
	}
	return nil
}

type csvExportFileWriter struct {
	writer  *csv.Writer
	columns []string
	record  []string
}

func newCSVExportFileWriter(f io.Writer) (*csvExportFileWriter, error) {
	if _, err := f.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
		return nil, err
	}
	return &csvExportFileWriter{writer: csv.NewWriter(f)}, nil
}

func (w *csvExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	w.record = make([]string, len(columns))
	return w.writer.Write(columns)
}

func (w *csvExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	return w.writer.Write(fillExportRecordFromRow(w.record, row, w.columns, false))
}

func (w *csvExportFileWriter) ConsumeRowValues(values []interface{}) error {
	return w.writer.Write(fillExportRecordFromValues(w.record, values, false))
}

func (w *csvExportFileWriter) Close() error {
	w.writer.Flush()
	return w.writer.Error()
}

type jsonExportFileWriter struct {
	file    io.Writer
	encoder *json.Encoder
	columns []string
	rowBuf  map[string]interface{}
	first   bool
}

func newJSONExportFileWriter(f io.Writer) (*jsonExportFileWriter, error) {
	if _, err := io.WriteString(f, "[\n"); err != nil {
		return nil, err
	}
	encoder := json.NewEncoder(f)
	encoder.SetIndent("  ", "  ")
	return &jsonExportFileWriter{file: f, encoder: encoder, first: true}, nil
}

func (w *jsonExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	w.rowBuf = make(map[string]interface{}, len(columns))
	return nil
}

func (w *jsonExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	for _, col := range w.columns {
		w.rowBuf[col] = normalizeExportJSONValue(row[col])
	}
	return w.writeCurrentRow()
}

func (w *jsonExportFileWriter) ConsumeRowValues(values []interface{}) error {
	for i, col := range w.columns {
		if i < len(values) {
			w.rowBuf[col] = normalizeExportJSONValue(values[i])
		} else {
			w.rowBuf[col] = nil
		}
	}
	return w.writeCurrentRow()
}

func (w *jsonExportFileWriter) writeCurrentRow() error {
	if !w.first {
		if _, err := io.WriteString(w.file, ",\n"); err != nil {
			return err
		}
	}
	if err := w.encoder.Encode(w.rowBuf); err != nil {
		return err
	}
	w.first = false
	return nil
}

func (w *jsonExportFileWriter) Close() error {
	_, err := io.WriteString(w.file, "\n]")
	return err
}

type markdownExportFileWriter struct {
	file    io.Writer
	columns []string
	record  []string
}

func (w *markdownExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	w.record = make([]string, len(columns))
	if _, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(columns, " | ")); err != nil {
		return err
	}
	seps := make([]string, len(columns))
	for i := range seps {
		seps[i] = "---"
	}
	_, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(seps, " | "))
	return err
}

func (w *markdownExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	_, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(fillExportRecordFromRow(w.record, row, w.columns, true), " | "))
	return err
}

func (w *markdownExportFileWriter) ConsumeRowValues(values []interface{}) error {
	_, err := fmt.Fprintf(w.file, "| %s |\n", strings.Join(fillExportRecordFromValues(w.record, values, true), " | "))
	return err
}

func (w *markdownExportFileWriter) Close() error {
	return nil
}

type htmlExportFileWriter struct {
	writer   *bufio.Writer
	columns  []string
	rowCount int64
}

func newHTMLExportFileWriter(f io.Writer) *htmlExportFileWriter {
	return &htmlExportFileWriter{writer: bufio.NewWriterSize(f, 1024*256)}
}

func (w *htmlExportFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	if _, err := w.writer.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GoNavi Export</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8f9fa;
      --card: #ffffff;
      --line: #dee2e6;
      --text: #212529;
      --muted: #6c757d;
      --hover: #f1f3f5;
      --zebra: #f8f9fa;
      --head: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
    }
    .export-wrap {
      max-width: 100%;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .export-head {
      padding: 16px 20px;
      background: var(--head);
      border-bottom: 2px solid var(--line);
    }
    .export-head h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
    }
    .export-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .table-wrap {
      width: 100%;
      overflow: auto;
      padding: 16px;
    }
    table {
      border-collapse: collapse;
      width: auto;
      font-size: 13px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--head);
      text-align: left;
      font-weight: 600;
      white-space: nowrap;
      border-bottom: 2px solid var(--line);
      color: var(--text);
      padding: 12px 16px;
    }
    td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      max-width: 500px;
      color: var(--text);
    }
    tbody tr:nth-child(even) {
      background: var(--zebra);
    }
    tbody tr:hover {
      background: var(--hover);
    }
    td.empty {
      text-align: center;
      color: var(--muted);
      font-style: italic;
    }
    @media (max-width: 768px) {
      body { padding: 16px; }
      .export-head { padding: 12px 16px; }
      .table-wrap { padding: 12px; }
      th, td { padding: 8px 12px; font-size: 12px; }
    }
    @media print {
      body { background: white; padding: 0; }
      .export-wrap { border: none; }
    }
  </style>
</head>
<body>
  <div class="export-wrap">
    <div class="export-head">
      <h1>GoNavi Data Export</h1>
      <div class="export-meta">`); err != nil {
		return err
	}

	if _, err := fmt.Fprintf(w.writer, "Columns: %d · Generated: %s", len(columns), time.Now().Format("2006-01-02 15:04:05")); err != nil {
		return err
	}

	if _, err := w.writer.WriteString(`</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>`); err != nil {
		return err
	}

	for _, col := range columns {
		if _, err := fmt.Fprintf(w.writer, "<th>%s</th>", html.EscapeString(col)); err != nil {
			return err
		}
	}

	_, err := w.writer.WriteString(`</tr></thead><tbody>`)
	return err
}

func (w *htmlExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	if _, err := w.writer.WriteString("<tr>"); err != nil {
		return err
	}
	for _, col := range w.columns {
		if _, err := fmt.Fprintf(w.writer, "<td>%s</td>", formatExportHTMLCell(row[col])); err != nil {
			return err
		}
	}
	if _, err := w.writer.WriteString("</tr>"); err != nil {
		return err
	}
	w.rowCount++
	return nil
}

func (w *htmlExportFileWriter) ConsumeRowValues(values []interface{}) error {
	if _, err := w.writer.WriteString("<tr>"); err != nil {
		return err
	}
	for i := range w.columns {
		var value interface{}
		if i < len(values) {
			value = values[i]
		}
		if _, err := fmt.Fprintf(w.writer, "<td>%s</td>", formatExportHTMLCell(value)); err != nil {
			return err
		}
	}
	if _, err := w.writer.WriteString("</tr>"); err != nil {
		return err
	}
	w.rowCount++
	return nil
}

func (w *htmlExportFileWriter) Close() error {
	if w.rowCount == 0 {
		colspan := len(w.columns)
		if colspan <= 0 {
			colspan = 1
		}
		if _, err := fmt.Fprintf(w.writer, `<tr><td class="empty" colspan="%d">(0 rows)</td></tr>`, colspan); err != nil {
			return err
		}
	}
	if _, err := w.writer.WriteString(`</tbody></table>
    </div>
  </div>
</body>
</html>`); err != nil {
		return err
	}
	return w.writer.Flush()
}
