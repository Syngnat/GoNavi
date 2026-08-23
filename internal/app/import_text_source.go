package app

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

const (
	importTextEncodingAuto    = "auto"
	importTextEncodingUTF8    = "utf-8"
	importTextEncodingUTF16LE = "utf-16le"
	importTextEncodingUTF16BE = "utf-16be"
	importTextEncodingGB18030 = "gb18030"

	// Automatic detection must stay bounded: multi-gigabyte imports should not
	// read the complete source once merely to decide between UTF-8 and GB18030.
	importTextEncodingDetectionSampleBytes = int64(1 << 20)
)

var (
	importUTF8BOM    = []byte{0xef, 0xbb, 0xbf}
	importUTF16LEBOM = []byte{0xff, 0xfe}
	importUTF16BEBOM = []byte{0xfe, 0xff}
)

// importTextSource exposes decoded UTF-8 while retaining progress in original
// on-disk bytes. It never buffers the complete decoded import payload.
type importTextSource struct {
	io.Reader
	file       *os.File
	rawCounter *importByteCountingReader
	totalBytes int64
	encoding   string
}

func (source *importTextSource) RawBytesRead() int64 {
	if source == nil || source.rawCounter == nil {
		return 0
	}
	return source.rawCounter.bytesRead
}

func (source *importTextSource) TotalBytes() int64 {
	if source == nil {
		return 0
	}
	return source.totalBytes
}

func (source *importTextSource) Close() error {
	if source == nil || source.file == nil {
		return nil
	}
	return source.file.Close()
}

func normalizeImportTextEncoding(value string) (string, error) {
	if value == "" {
		return importTextEncodingAuto, nil
	}
	switch value {
	case importTextEncodingAuto,
		importTextEncodingUTF8,
		importTextEncodingUTF16LE,
		importTextEncodingUTF16BE,
		importTextEncodingGB18030:
		return value, nil
	default:
		return "", fmt.Errorf("unsupported import text encoding %q", value)
	}
}

func openImportTextSource(filePath string, requestedEncoding string) (*importTextSource, error) {
	requestedEncoding, err := normalizeImportTextEncoding(requestedEncoding)
	if err != nil {
		return nil, err
	}

	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = file.Close()
		}
	}()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	totalBytes := info.Size()
	if totalBytes < 0 {
		totalBytes = 0
	}

	detectedEncoding, bomBytes, err := detectImportTextBOM(file)
	if err != nil {
		return nil, err
	}
	selectedEncoding := requestedEncoding
	if requestedEncoding == importTextEncodingAuto {
		if detectedEncoding != "" {
			selectedEncoding = detectedEncoding
		} else {
			validUTF8, err := importFilePrefixIsValidUTF8(file, totalBytes)
			if err != nil {
				return nil, err
			}
			if validUTF8 {
				selectedEncoding = importTextEncodingUTF8
			} else {
				selectedEncoding = importTextEncodingGB18030
			}
		}
	} else if detectedEncoding != "" && detectedEncoding != requestedEncoding {
		return nil, fmt.Errorf(
			"import text encoding %q conflicts with %s BOM",
			requestedEncoding,
			detectedEncoding,
		)
	}

	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	rawCounter := &importByteCountingReader{reader: file}
	buffered := bufio.NewReader(rawCounter)
	if bomBytes > 0 {
		if _, err := buffered.Discard(bomBytes); err != nil {
			return nil, fmt.Errorf("read import text BOM: %w", err)
		}
	}

	var decoded io.Reader = buffered
	switch selectedEncoding {
	case importTextEncodingUTF8:
		decoded = transform.NewReader(buffered, encoding.UTF8Validator)
	case importTextEncodingUTF16LE:
		decoded = transform.NewReader(buffered, unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder())
	case importTextEncodingUTF16BE:
		decoded = transform.NewReader(buffered, unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder())
	case importTextEncodingGB18030:
		decoded = transform.NewReader(buffered, simplifiedchinese.GB18030.NewDecoder())
	default:
		return nil, fmt.Errorf("unsupported import text encoding %q", selectedEncoding)
	}

	closeOnError = false
	return &importTextSource{
		Reader:     decoded,
		file:       file,
		rawCounter: rawCounter,
		totalBytes: totalBytes,
		encoding:   selectedEncoding,
	}, nil
}

func detectImportTextBOM(file *os.File) (encodingName string, bomBytes int, err error) {
	prefix := make([]byte, len(importUTF8BOM))
	read, readErr := file.ReadAt(prefix, 0)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return "", 0, readErr
	}
	prefix = prefix[:read]
	switch {
	case bytes.HasPrefix(prefix, importUTF8BOM):
		return importTextEncodingUTF8, len(importUTF8BOM), nil
	case bytes.HasPrefix(prefix, importUTF16LEBOM):
		return importTextEncodingUTF16LE, len(importUTF16LEBOM), nil
	case bytes.HasPrefix(prefix, importUTF16BEBOM):
		return importTextEncodingUTF16BE, len(importUTF16BEBOM), nil
	default:
		return "", 0, nil
	}
}

func importFilePrefixIsValidUTF8(file *os.File, totalBytes int64) (bool, error) {
	sampleBytes := totalBytes
	if sampleBytes > importTextEncodingDetectionSampleBytes {
		sampleBytes = importTextEncodingDetectionSampleBytes
	}
	if sampleBytes <= 0 {
		return true, nil
	}

	sample := make([]byte, sampleBytes)
	n, err := file.ReadAt(sample, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	sample = sample[:n]
	for len(sample) > 0 {
		if sample[0] < utf8.RuneSelf {
			sample = sample[1:]
			continue
		}
		if !utf8.FullRune(sample) {
			// A bounded prefix can end in the middle of an otherwise valid rune.
			return int64(n) < totalBytes, nil
		}
		r, size := utf8.DecodeRune(sample)
		if r == utf8.RuneError && size == 1 {
			return false, nil
		}
		sample = sample[size:]
	}
	return true, nil
}
