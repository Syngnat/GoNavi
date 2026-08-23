package app

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
)

type ImportFileLimitKind string

const (
	ImportFileCellByteLimit ImportFileLimitKind = "cell_byte_limit"
	ImportFileRowByteLimit  ImportFileLimitKind = "row_byte_limit"
)

// ImportFileLimitError reports a bounded parsing failure without retaining or
// exposing the rejected source value.
type ImportFileLimitError struct {
	Format string
	Kind   ImportFileLimitKind
	Row    int
	Cell   int
	Column string
	Limit  int
}

func (err *ImportFileLimitError) Error() string {
	if err == nil {
		return "import file safety limit exceeded"
	}
	if err.Kind == ImportFileRowByteLimit {
		return fmt.Sprintf("%s row %d exceeds %d-byte limit", err.Format, err.Row, err.Limit)
	}
	if err.Column != "" {
		return fmt.Sprintf("%s row %d column %q exceeds %d-byte cell limit", err.Format, err.Row, err.Column, err.Limit)
	}
	if err.Cell > 0 {
		return fmt.Sprintf("%s row %d cell %d exceeds %d-byte limit", err.Format, err.Row, err.Cell, err.Limit)
	}
	return fmt.Sprintf("%s row %d string exceeds %d-byte cell limit", err.Format, err.Row, err.Limit)
}

type importLexicalLimits struct {
	maxCellBytes int
	maxRowBytes  int
}

func normalizeImportLexicalLimits(limits importLexicalLimits) importLexicalLimits {
	if limits.maxCellBytes <= 0 {
		limits.maxCellBytes = maxImportCellBytes
	}
	if limits.maxRowBytes <= 0 {
		limits.maxRowBytes = maxImportRowBytes
	}
	return limits
}

type importCSVLexicalLimitReader struct {
	reader       io.Reader
	delimiter    byte
	limits       importLexicalLimits
	row          int
	cell         int
	fieldRaw     int
	fieldDecoded int
	rowRaw       int
	rowDecoded   int
	atFieldStart bool
	inQuotes     bool
	afterQuote   bool
	pendingCR    bool
	terminalErr  error
}

func newImportCSVLexicalLimitReader(source io.Reader, delimiter rune, limits importLexicalLimits) io.Reader {
	return &importCSVLexicalLimitReader{
		reader:       source,
		delimiter:    byte(delimiter),
		limits:       normalizeImportLexicalLimits(limits),
		row:          1,
		cell:         1,
		atFieldStart: true,
	}
}

func (reader *importCSVLexicalLimitReader) Read(buffer []byte) (int, error) {
	if reader.terminalErr != nil {
		return 0, reader.terminalErr
	}
	n, readErr := reader.reader.Read(buffer)
	for index := 0; index < n; index++ {
		value := buffer[index]
		if reader.pendingCR {
			reader.pendingCR = false
			if value == '\n' {
				if err := reader.consumeNewline(2); err != nil {
					reader.terminalErr = err
					return index, err
				}
				continue
			}
			if err := reader.consumeDataByte('\r', 1, 1); err != nil {
				reader.terminalErr = err
				return index, err
			}
		}
		if value == '\r' {
			reader.pendingCR = true
			continue
		}
		if value == '\n' {
			if err := reader.consumeNewline(1); err != nil {
				reader.terminalErr = err
				return index, err
			}
			continue
		}
		if err := reader.consumeDataByte(value, 1, 1); err != nil {
			reader.terminalErr = err
			return index, err
		}
	}
	if readErr != nil && reader.pendingCR {
		reader.pendingCR = false
		if err := reader.consumeDataByte('\r', 1, 1); err != nil {
			reader.terminalErr = err
			return n, err
		}
	}
	return n, readErr
}

func (reader *importCSVLexicalLimitReader) consumeDataByte(value byte, rawBytes int, decodedBytes int) error {
	if err := reader.addRowRawBytes(rawBytes); err != nil {
		return err
	}
	if reader.inQuotes {
		if reader.afterQuote {
			reader.afterQuote = false
			switch value {
			case '"':
				return reader.addFieldBytes(2, 1)
			case reader.delimiter:
				reader.inQuotes = false
				reader.finishField()
				return nil
			default:
				// Keep malformed CSV for encoding/csv to diagnose. Counting the
				// byte still bounds the parser's allocation before that happens.
				reader.inQuotes = false
				return reader.addFieldBytes(rawBytes, decodedBytes)
			}
		}
		if value == '"' {
			reader.afterQuote = true
			return nil
		}
		return reader.addFieldBytes(rawBytes, decodedBytes)
	}

	if reader.atFieldStart && value == '"' {
		reader.atFieldStart = false
		reader.inQuotes = true
		return nil
	}
	if value == reader.delimiter {
		reader.finishField()
		return nil
	}
	reader.atFieldStart = false
	return reader.addFieldBytes(rawBytes, decodedBytes)
}

func (reader *importCSVLexicalLimitReader) consumeNewline(rawBytes int) error {
	if reader.inQuotes && !reader.afterQuote {
		if err := reader.addRowRawBytes(rawBytes); err != nil {
			return err
		}
		return reader.addFieldBytes(rawBytes, 1)
	}
	if reader.inQuotes && reader.afterQuote {
		reader.inQuotes = false
		reader.afterQuote = false
	}
	reader.finishRecord()
	return nil
}

func (reader *importCSVLexicalLimitReader) addFieldBytes(rawBytes int, decodedBytes int) error {
	if reader.fieldRaw > reader.limits.maxCellBytes-rawBytes || reader.fieldDecoded > reader.limits.maxCellBytes-decodedBytes {
		return &ImportFileLimitError{
			Format: "CSV",
			Kind:   ImportFileCellByteLimit,
			Row:    reader.row,
			Cell:   reader.cell,
			Limit:  reader.limits.maxCellBytes,
		}
	}
	if reader.rowDecoded > reader.limits.maxRowBytes-decodedBytes {
		return &ImportFileLimitError{
			Format: "CSV",
			Kind:   ImportFileRowByteLimit,
			Row:    reader.row,
			Limit:  reader.limits.maxRowBytes,
		}
	}
	reader.fieldRaw += rawBytes
	reader.fieldDecoded += decodedBytes
	reader.rowDecoded += decodedBytes
	return nil
}

func (reader *importCSVLexicalLimitReader) addRowRawBytes(rawBytes int) error {
	if reader.rowRaw > reader.limits.maxRowBytes-rawBytes {
		return &ImportFileLimitError{
			Format: "CSV",
			Kind:   ImportFileRowByteLimit,
			Row:    reader.row,
			Limit:  reader.limits.maxRowBytes,
		}
	}
	reader.rowRaw += rawBytes
	return nil
}

func (reader *importCSVLexicalLimitReader) finishField() {
	reader.cell++
	reader.fieldRaw = 0
	reader.fieldDecoded = 0
	reader.atFieldStart = true
}

func (reader *importCSVLexicalLimitReader) finishRecord() {
	reader.row++
	reader.cell = 1
	reader.fieldRaw = 0
	reader.fieldDecoded = 0
	reader.rowRaw = 0
	reader.rowDecoded = 0
	reader.atFieldStart = true
}

func newImportCSVReaderWithLimits(source io.Reader, delimiterName string, limits importLexicalLimits) (*csv.Reader, error) {
	delimiter, explicit, err := resolveImportDelimiter(delimiterName)
	if err != nil {
		return nil, err
	}
	parseSource := source
	if !explicit {
		prefix, readErr := io.ReadAll(io.LimitReader(source, importDelimiterProbeSize+1))
		if readErr != nil {
			return nil, fmt.Errorf("CSV delimiter probe failed: %w", readErr)
		}
		delimiter, err = detectImportCSVDelimiter(prefix)
		if err != nil {
			return nil, err
		}
		parseSource = io.MultiReader(bytes.NewReader(prefix), source)
	}
	limited := newImportCSVLexicalLimitReader(parseSource, delimiter, limits)
	reader := csv.NewReader(bufio.NewReader(limited))
	reader.Comma = delimiter
	return reader, nil
}

type importJSONLexicalLimitReader struct {
	reader          io.Reader
	limits          importLexicalLimits
	row             int
	rootStarted     bool
	rootClosed      bool
	depth           int
	inElement       bool
	elementRaw      int
	inString        bool
	escaped         bool
	unicodeDigits   int
	stringRaw       int
	stringDecoded   int
	stringColumn    string
	stringIsTopKey  bool
	topObjectDepth  int
	topExpectKey    bool
	topColumn       string
	topKeyBuffer    []byte
	topKeyUsable    bool
	topValuePending bool
	topValueMode    importJSONValueLimitMode
	topValueRaw     int
	terminalErr     error
}

type importJSONValueLimitMode uint8

const (
	importJSONValueLimitNone importJSONValueLimitMode = iota
	importJSONValueLimitString
	importJSONValueLimitPrimitive
	importJSONValueLimitComposite
)

func newImportJSONLexicalLimitReader(source io.Reader, limits importLexicalLimits) io.Reader {
	return &importJSONLexicalLimitReader{
		reader: source,
		limits: normalizeImportLexicalLimits(limits),
	}
}

func (reader *importJSONLexicalLimitReader) Read(buffer []byte) (int, error) {
	if reader.terminalErr != nil {
		return 0, reader.terminalErr
	}
	n, readErr := reader.reader.Read(buffer)
	for index := 0; index < n; index++ {
		if err := reader.consumeByte(buffer[index]); err != nil {
			reader.terminalErr = err
			return index, err
		}
	}
	return n, readErr
}

func (reader *importJSONLexicalLimitReader) consumeByte(value byte) error {
	if reader.inString {
		if reader.inElement {
			if err := reader.addElementRawByte(); err != nil {
				return err
			}
		}
		if reader.topValueMode == importJSONValueLimitComposite {
			if err := reader.addTopValueRawByte(); err != nil {
				return err
			}
		}
		return reader.consumeStringByte(value)
	}

	if !reader.rootStarted {
		if isImportJSONWhitespace(value) {
			return nil
		}
		if value == '[' {
			reader.rootStarted = true
			reader.depth = 1
		}
		return nil
	}
	if reader.rootClosed {
		return nil
	}

	if reader.depth == 1 && !reader.inElement {
		if isImportJSONWhitespace(value) || value == ',' {
			return nil
		}
		if value == ']' {
			reader.rootClosed = true
			reader.depth = 0
			return nil
		}
		reader.row++
		reader.inElement = true
		reader.elementRaw = 0
	}
	if reader.depth == 1 && reader.inElement && (value == ',' || value == ']') {
		reader.finishElement()
		if value == ']' {
			reader.rootClosed = true
			reader.depth = 0
		}
		return nil
	}
	if err := reader.consumeTopValueByte(value); err != nil {
		return err
	}
	if reader.inElement {
		if err := reader.addElementRawByte(); err != nil {
			return err
		}
	}

	if value == '"' {
		reader.startString()
		return nil
	}

	switch value {
	case '{':
		reader.depth++
		if reader.topObjectDepth == 0 && reader.depth == 2 {
			reader.topObjectDepth = reader.depth
			reader.topExpectKey = true
		}
	case '[':
		reader.depth++
	case '}':
		if reader.topObjectDepth == reader.depth {
			reader.topObjectDepth = 0
			reader.topExpectKey = false
			reader.topColumn = ""
		}
		if reader.depth > 1 {
			reader.depth--
		}
	case ']':
		if reader.depth > 1 {
			reader.depth--
		}
	case ',':
		if reader.topObjectDepth > 0 && reader.depth == reader.topObjectDepth {
			reader.topExpectKey = true
			reader.topColumn = ""
		}
	case ':':
		if reader.topObjectDepth > 0 && reader.depth == reader.topObjectDepth && !reader.topExpectKey {
			reader.topValuePending = true
			reader.topValueMode = importJSONValueLimitNone
			reader.topValueRaw = 0
		}
	}
	return nil
}

func (reader *importJSONLexicalLimitReader) startString() {
	reader.inString = true
	reader.escaped = false
	reader.unicodeDigits = 0
	reader.stringRaw = 0
	reader.stringDecoded = 0
	reader.stringIsTopKey = reader.topObjectDepth > 0 && reader.depth == reader.topObjectDepth && reader.topExpectKey
	reader.stringColumn = ""
	reader.topKeyBuffer = reader.topKeyBuffer[:0]
	reader.topKeyUsable = reader.stringIsTopKey
	if !reader.stringIsTopKey {
		reader.stringColumn = reader.topColumn
	}
}

func (reader *importJSONLexicalLimitReader) consumeStringByte(value byte) error {
	if reader.unicodeDigits > 0 {
		if err := reader.addStringBytes(1, 0); err != nil {
			return err
		}
		reader.unicodeDigits--
		if reader.unicodeDigits == 0 {
			// A single JSON unicode escape decodes to at most three UTF-8
			// bytes. Surrogate pairs are conservatively counted as six.
			if err := reader.addStringBytes(0, 3); err != nil {
				return err
			}
		}
		return nil
	}
	if reader.escaped {
		reader.escaped = false
		if err := reader.addStringBytes(1, 0); err != nil {
			return err
		}
		if value == 'u' {
			reader.unicodeDigits = 4
			reader.topKeyUsable = false
			return nil
		}
		if reader.stringIsTopKey {
			mapped, ok := importJSONSimpleEscape(value)
			if !ok || len(reader.topKeyBuffer) >= 128 {
				reader.topKeyUsable = false
			} else {
				reader.topKeyBuffer = append(reader.topKeyBuffer, mapped)
			}
		}
		return reader.addStringBytes(0, 1)
	}
	if value == '\\' {
		reader.escaped = true
		return reader.addStringBytes(1, 0)
	}
	if value == '"' {
		reader.inString = false
		if reader.stringIsTopKey {
			reader.topExpectKey = false
			if reader.topKeyUsable {
				reader.topColumn = string(reader.topKeyBuffer)
			} else {
				reader.topColumn = ""
			}
		}
		return nil
	}
	if reader.stringIsTopKey {
		if len(reader.topKeyBuffer) >= 128 {
			reader.topKeyUsable = false
		} else {
			reader.topKeyBuffer = append(reader.topKeyBuffer, value)
		}
	}
	return reader.addStringBytes(1, 1)
}

func (reader *importJSONLexicalLimitReader) addStringBytes(rawBytes int, decodedBytes int) error {
	if reader.stringRaw > reader.limits.maxCellBytes-rawBytes || reader.stringDecoded > reader.limits.maxCellBytes-decodedBytes {
		return &ImportFileLimitError{
			Format: "JSON",
			Kind:   ImportFileCellByteLimit,
			Row:    reader.row,
			Column: reader.stringColumn,
			Limit:  reader.limits.maxCellBytes,
		}
	}
	reader.stringRaw += rawBytes
	reader.stringDecoded += decodedBytes
	return nil
}

func (reader *importJSONLexicalLimitReader) addElementRawByte() error {
	if reader.elementRaw >= reader.limits.maxRowBytes {
		return &ImportFileLimitError{
			Format: "JSON",
			Kind:   ImportFileRowByteLimit,
			Row:    reader.row,
			Limit:  reader.limits.maxRowBytes,
		}
	}
	reader.elementRaw++
	return nil
}

func (reader *importJSONLexicalLimitReader) consumeTopValueByte(value byte) error {
	if reader.topObjectDepth == 0 {
		return nil
	}
	if reader.depth == reader.topObjectDepth && (value == ',' || value == '}') {
		reader.finishTopValue()
		return nil
	}
	if reader.topValuePending {
		if isImportJSONWhitespace(value) {
			return nil
		}
		reader.topValuePending = false
		switch value {
		case '"':
			reader.topValueMode = importJSONValueLimitString
			return nil
		case '{', '[':
			reader.topValueMode = importJSONValueLimitComposite
		default:
			reader.topValueMode = importJSONValueLimitPrimitive
		}
	}
	switch reader.topValueMode {
	case importJSONValueLimitComposite:
		return reader.addTopValueRawByte()
	case importJSONValueLimitPrimitive:
		if !isImportJSONWhitespace(value) {
			return reader.addTopValueRawByte()
		}
	}
	return nil
}

func (reader *importJSONLexicalLimitReader) addTopValueRawByte() error {
	if reader.topValueRaw >= reader.limits.maxCellBytes {
		return &ImportFileLimitError{
			Format: "JSON",
			Kind:   ImportFileCellByteLimit,
			Row:    reader.row,
			Column: reader.topColumn,
			Limit:  reader.limits.maxCellBytes,
		}
	}
	reader.topValueRaw++
	return nil
}

func (reader *importJSONLexicalLimitReader) finishTopValue() {
	reader.topValuePending = false
	reader.topValueMode = importJSONValueLimitNone
	reader.topValueRaw = 0
}

func (reader *importJSONLexicalLimitReader) finishElement() {
	reader.inElement = false
	reader.elementRaw = 0
	reader.topObjectDepth = 0
	reader.topExpectKey = false
	reader.topColumn = ""
	reader.finishTopValue()
}

func importJSONSimpleEscape(value byte) (byte, bool) {
	switch value {
	case '"', '\\', '/':
		return value, true
	case 'b':
		return '\b', true
	case 'f':
		return '\f', true
	case 'n':
		return '\n', true
	case 'r':
		return '\r', true
	case 't':
		return '\t', true
	default:
		return 0, false
	}
}

func isImportJSONWhitespace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

func newImportJSONDecoderWithLimits(source io.Reader, limits importLexicalLimits) *json.Decoder {
	limited := newImportJSONLexicalLimitReader(source, limits)
	decoder := json.NewDecoder(bufio.NewReader(limited))
	decoder.UseNumber()
	return decoder
}
