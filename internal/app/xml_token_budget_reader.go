package app

import (
	"fmt"
	"io"
)

const (
	maxXLSXTagBytes          = 64 << 10
	maxXLSXMetadataTextBytes = 1 << 20
)

// xmlTokenBudgetReader bounds a single XML tag or text run before encoding/xml
// materializes an unbounded attribute, character-data token, or comment.
type xmlTokenBudgetReader struct {
	reader       io.Reader
	maxTextBytes int
	maxTagBytes  int
	label        string
	inTag        bool
	quote        byte
	runBytes     int
	terminalErr  error
}

func newXMLTokenBudgetReader(reader io.Reader, maxTextBytes int, maxTagBytes int, label string) io.Reader {
	return &xmlTokenBudgetReader{
		reader:       reader,
		maxTextBytes: maxTextBytes,
		maxTagBytes:  maxTagBytes,
		label:        label,
	}
}

func (reader *xmlTokenBudgetReader) Read(buffer []byte) (int, error) {
	if reader.terminalErr != nil {
		return 0, reader.terminalErr
	}
	n, readErr := reader.reader.Read(buffer)
	for index := 0; index < n; index++ {
		value := buffer[index]
		if !reader.inTag {
			if value == '<' {
				reader.inTag = true
				reader.quote = 0
				reader.runBytes = 1
				continue
			}
			reader.runBytes++
			if reader.maxTextBytes > 0 && reader.runBytes > reader.maxTextBytes {
				reader.terminalErr = fmt.Errorf("%s text token exceeds %d bytes", reader.tokenLabel(), reader.maxTextBytes)
				return index, reader.terminalErr
			}
			continue
		}

		reader.runBytes++
		if reader.maxTagBytes > 0 && reader.runBytes > reader.maxTagBytes {
			reader.terminalErr = fmt.Errorf("%s tag token exceeds %d bytes", reader.tokenLabel(), reader.maxTagBytes)
			return index, reader.terminalErr
		}
		if reader.quote != 0 {
			if value == reader.quote {
				reader.quote = 0
			}
			continue
		}
		switch value {
		case '\'', '"':
			reader.quote = value
		case '>':
			reader.inTag = false
			reader.runBytes = 0
		}
	}
	return n, readErr
}

func (reader *xmlTokenBudgetReader) tokenLabel() string {
	if reader.label == "" {
		return "XML"
	}
	return reader.label
}
