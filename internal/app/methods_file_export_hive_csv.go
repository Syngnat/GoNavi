package app

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/dataexport"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

type hiveCSVFileWriter struct {
	writer   *bufio.Writer
	encoder  *transform.Writer
	columns  []string
	comments map[string]string
	closed   bool
}

func newHiveCSVFileWriter(output io.Writer, comments map[string]string, name string) (*hiveCSVFileWriter, error) {
	if err := dataexport.ValidateCSVEncoding(name); err != nil {
		return nil, err
	}
	var codec encoding.Encoding
	var bom []byte
	switch name {
	case "", "utf-8-bom":
		bom = []byte{0xef, 0xbb, 0xbf}
	case "gbk":
		codec = simplifiedchinese.GBK
	case "gb18030":
		codec = simplifiedchinese.GB18030
	case "utf-16le":
		bom = []byte{0xff, 0xfe}
		codec = unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM)
	}
	if len(bom) > 0 {
		n, err := output.Write(bom)
		if err == nil && n != len(bom) {
			err = io.ErrShortWrite
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %w", dataexport.ErrCSVEncoding, err)
		}
	}
	writer := &hiveCSVFileWriter{comments: comments}
	if codec != nil {
		writer.encoder = transform.NewWriter(output, codec.NewEncoder())
		output = writer.encoder
	}
	writer.writer = bufio.NewWriterSize(output, 256*1024)
	return writer, nil
}

func (w *hiveCSVFileWriter) SetColumns(columns []string) error {
	w.columns = append([]string(nil), columns...)
	headers := resolveExportColumnHeaders(columns, w.comments)
	values := make([]interface{}, len(headers))
	for i, text := range headers {
		values[i] = text
	}
	return w.ConsumeRowValues(values)
}

func (w *hiveCSVFileWriter) ConsumeRow(row map[string]interface{}) error {
	values := make([]interface{}, len(w.columns))
	for i, name := range w.columns {
		values[i] = row[name]
	}
	return w.ConsumeRowValues(values)
}

func (w *hiveCSVFileWriter) ConsumeRowValues(values []interface{}) error {
	if w.closed {
		return fmt.Errorf("%w: stream closed", dataexport.ErrCSVEncoding)
	}
	for i := range w.columns {
		if i > 0 {
			if err := w.writer.WriteByte(','); err != nil {
				return err
			}
		}
		if i >= len(values) || values[i] == nil {
			if _, err := w.writer.WriteString("NULL"); err != nil {
				return err
			}
			continue
		}
		text := formatExportCellText(values[i])
		if !utf8.ValidString(text) {
			return fmt.Errorf("%w: invalid UTF-8", dataexport.ErrCSVEncoding)
		}
		if len(text) > maxImportCellBytes {
			return fmt.Errorf("Hive CSV cell exceeds byte limit")
		}
		if err := w.writer.WriteByte('"'); err != nil {
			return err
		}
		if _, err := w.writer.WriteString(strings.ReplaceAll(text, "\"", "\"\"")); err != nil {
			return err
		}
		if err := w.writer.WriteByte('"'); err != nil {
			return err
		}
	}
	return w.writer.WriteByte('\n')
}

func (w *hiveCSVFileWriter) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	err := w.writer.Flush()
	if w.encoder != nil {
		err = errors.Join(err, w.encoder.Close())
	}
	if err != nil {
		return fmt.Errorf("%w: %w", dataexport.ErrCSVEncoding, err)
	}
	return nil
}
