package app

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

type hiveCSVField struct {
	text   string
	quoted bool
}

func readHiveCSVRecord(reader *bufio.Reader, delimiter byte) ([]hiveCSVField, error) {
	var fields []hiveCSVField
	var cell strings.Builder
	quoted, inQuote, closed, started := false, false, false, false
	rawBytes := 0
	finish := func() {
		fields = append(fields, hiveCSVField{text: cell.String(), quoted: quoted})
		cell.Reset()
		quoted, inQuote, closed, started = false, false, false, false
	}
	for {
		ch, err := reader.ReadByte()
		if err != nil {
			if err != io.EOF {
				return nil, err
			}
			if inQuote {
				return nil, fmt.Errorf("unterminated quoted Hive CSV field")
			}
			if !started && !closed && len(fields) == 0 {
				return nil, io.EOF
			}
			finish()
			return fields, nil
		}
		rawBytes++
		if rawBytes > maxImportRowBytes {
			return nil, fmt.Errorf("Hive CSV row exceeds byte limit")
		}
		if inQuote {
			if ch == '"' {
				next, _ := reader.Peek(1)
				if len(next) > 0 && next[0] == '"' {
					if _, err := reader.ReadByte(); err != nil {
						return nil, err
					}
					cell.WriteByte('"')
				} else {
					inQuote = false
					closed = true
				}
			} else {
				cell.WriteByte(ch)
			}
			if cell.Len() > maxImportCellBytes {
				return nil, fmt.Errorf("Hive CSV field exceeds byte limit")
			}
			continue
		}
		newline := ch == '\n'
		if ch == '\r' {
			next, _ := reader.Peek(1)
			if len(next) > 0 && next[0] == '\n' {
				if _, err := reader.ReadByte(); err != nil {
					return nil, err
				}
				newline = true
			}
		}
		if newline {
			if !started && !closed && len(fields) == 0 {
				rawBytes = 0
				continue
			}
			finish()
			return fields, nil
		}
		if ch == delimiter {
			finish()
			continue
		}
		if closed {
			return nil, fmt.Errorf("unexpected character after quoted Hive CSV field")
		}
		if ch == '"' {
			if started {
				return nil, fmt.Errorf("bare quote in Hive CSV field")
			}
			quoted, inQuote, started = true, true, true
			continue
		}
		started = true
		cell.WriteByte(ch)
		if cell.Len() > maxImportCellBytes {
			return nil, fmt.Errorf("Hive CSV field exceeds byte limit")
		}
	}
}

func hiveCSVImportedValue(field hiveCSVField, options ImportFileOptions) interface{} {
	if field.quoted {
		return field.text
	}
	if field.text == "NULL" || options.NullToken != nil && field.text == *options.NullToken || options.EmptyStringAsNull && field.text == "" {
		return nil
	}
	return field.text
}

func streamHiveCSVImportFile(path string, consumer importFileConsumer, options ImportFileOptions) error {
	source, err := openImportTextSource(path, options.Encoding)
	if err != nil {
		return err
	}
	defer source.Close()
	reader := bufio.NewReaderSize(source, importDelimiterProbeSize)
	delimiter, explicit, err := resolveImportDelimiter(options.Delimiter)
	if err != nil {
		return err
	}
	if !explicit {
		prefix, peekErr := reader.Peek(importDelimiterProbeSize)
		if peekErr != nil && peekErr != io.EOF && peekErr != bufio.ErrBufferFull {
			return peekErr
		}
		delimiter, err = detectImportCSVDelimiter(prefix)
		if err != nil {
			return err
		}
	}
	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return err
	}
	var fields []hiveCSVField
	for row := 1; row <= headerRow; row++ {
		fields, err = readHiveCSVRecord(reader, byte(delimiter))
		if err != nil {
			return fmt.Errorf("read Hive CSV header: %w", err)
		}
	}
	columns := make([]string, len(fields))
	for i, field := range fields {
		columns[i] = field.text
	}
	if len(columns) > 0 {
		columns[0] = strings.TrimPrefix(columns[0], "\ufeff")
	}
	if !hasImportUsableColumns(columns) {
		return fmt.Errorf("Hive CSV has no usable header")
	}
	if err := validateImportUniqueColumns("CSV", columns); err != nil {
		return err
	}
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}
	for {
		fields, err = readHiveCSVRecord(reader, byte(delimiter))
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if len(fields) != len(columns) {
			return fmt.Errorf("Hive CSV row has %d fields, expected %d", len(fields), len(columns))
		}
		row := make(map[string]interface{}, len(columns))
		for i, name := range columns {
			row[name] = hiveCSVImportedValue(fields[i], options)
		}
		reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
}
