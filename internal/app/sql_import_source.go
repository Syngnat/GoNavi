package app

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// SQLImportSourceOptions defines safety limits applied while decoding an SQL
// import source. Zero values select production-safe defaults.
type SQLImportSourceOptions struct {
	MaxDecodedBytes            int64
	MaxCompressionRatio        float64
	MinCompressedBytesForRatio int64
	// RawObserver receives the original on-disk bytes as they are read. It is
	// suitable for streaming hashes and never receives decoded SQL content.
	RawObserver io.Writer
}

type SQLImportSourceLimitKind string

const (
	SQLImportSourceDecodedByteLimit            SQLImportSourceLimitKind = "decoded_byte_limit"
	SQLImportSourceCompressionRatio            SQLImportSourceLimitKind = "compression_ratio"
	defaultSQLImportMaxDecodedBytes                                     = int64(16 << 30)
	defaultSQLImportMaxCompressionRatio                                 = 1000.0
	defaultSQLImportMinCompressedBytesForRatio                          = int64(1)
)

// SQLImportSourceLimitError reports a streaming safety limit without exposing
// source content.
type SQLImportSourceLimitError struct {
	Kind                SQLImportSourceLimitKind
	Limit               int64
	DecodedBytes        int64
	CompressedBytes     int64
	Ratio               float64
	MaxCompressionRatio float64
}

func (err *SQLImportSourceLimitError) Error() string {
	return fmt.Sprintf("SQL import source exceeded %s safety limit", err.Kind)
}

type sqlImportDecodedLimitReader struct {
	reader                  io.Reader
	maxBytes                int64
	decodedBytes            int64
	compressed              *sqlImportCountingReader
	maxCompressionRatio     float64
	minCompressedRatioBytes int64
}

func (reader *sqlImportDecodedLimitReader) Read(buffer []byte) (int, error) {
	remaining := reader.maxBytes - reader.decodedBytes
	if remaining < 0 {
		remaining = 0
	}
	probeSize := int64(len(buffer))
	if probeSize > remaining+1 {
		probeSize = remaining + 1
	}
	n, readErr := reader.reader.Read(buffer[:int(probeSize)])
	projectedDecodedBytes := reader.decodedBytes + int64(n)
	if int64(n) > remaining {
		allowed := int(remaining)
		reader.decodedBytes += int64(allowed)
		return allowed, &SQLImportSourceLimitError{
			Kind:         SQLImportSourceDecodedByteLimit,
			Limit:        reader.maxBytes,
			DecodedBytes: reader.decodedBytes,
		}
	}
	if reader.compressed != nil && reader.compressed.bytes >= reader.minCompressedRatioBytes {
		ratio := float64(projectedDecodedBytes) / float64(reader.compressed.bytes)
		if ratio > reader.maxCompressionRatio {
			reader.decodedBytes = projectedDecodedBytes
			return 0, &SQLImportSourceLimitError{
				Kind:                SQLImportSourceCompressionRatio,
				DecodedBytes:        projectedDecodedBytes,
				CompressedBytes:     reader.compressed.bytes,
				Ratio:               ratio,
				MaxCompressionRatio: reader.maxCompressionRatio,
			}
		}
	}
	reader.decodedBytes = projectedDecodedBytes
	return n, readErr
}

type sqlImportCountingReader struct {
	reader io.Reader
	bytes  int64
}

func (reader *sqlImportCountingReader) Read(buffer []byte) (int, error) {
	n, err := reader.reader.Read(buffer)
	reader.bytes += int64(n)
	return n, err
}

// SQLImportSource is a streaming, UTF-8 SQL source. Callers must close it.
type SQLImportSource struct {
	io.Reader
	Encoding   string
	Compressed bool
	rawCounter *sqlImportCountingReader
	close      func() error
}

// RawBytesRead returns bytes consumed from the original file. For .sql.gz it
// therefore reports compressed bytes rather than decoded SQL bytes.
func (source *SQLImportSource) RawBytesRead() int64 {
	if source == nil || source.rawCounter == nil {
		return 0
	}
	return source.rawCounter.bytes
}

func (source *SQLImportSource) Close() error {
	if source == nil || source.close == nil {
		return nil
	}
	return source.close()
}

// OpenSQLImportSource opens path without loading it into memory.
func OpenSQLImportSource(path string, options SQLImportSourceOptions) (*SQLImportSource, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	rawReader := io.Reader(file)
	if options.RawObserver != nil {
		rawReader = io.TeeReader(rawReader, options.RawObserver)
	}
	rawCounter := &sqlImportCountingReader{reader: rawReader}
	payload := io.Reader(rawCounter)
	compressed := strings.HasSuffix(strings.ToLower(path), ".sql.gz")
	var compressionCounter *sqlImportCountingReader
	closeSource := file.Close
	if compressed {
		compressionCounter = rawCounter
		gzipReader, gzipErr := gzip.NewReader(rawCounter)
		if gzipErr != nil {
			_ = file.Close()
			return nil, gzipErr
		}
		payload = gzipReader
		closeSource = func() error {
			gzipCloseErr := gzipReader.Close()
			fileCloseErr := file.Close()
			if gzipCloseErr != nil {
				return gzipCloseErr
			}
			return fileCloseErr
		}
	}
	buffered := bufio.NewReader(payload)
	reader := io.Reader(buffered)
	encodingName := "utf-8"
	if prefix, _ := buffered.Peek(3); bytes.Equal(prefix, []byte{0xef, 0xbb, 0xbf}) {
		_, _ = buffered.Discard(3)
	} else if prefix, _ := buffered.Peek(2); bytes.Equal(prefix, []byte{0xff, 0xfe}) {
		_, _ = buffered.Discard(2)
		reader = transform.NewReader(buffered, unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder())
		encodingName = "utf-16le"
	} else if prefix, _ := buffered.Peek(2); bytes.Equal(prefix, []byte{0xfe, 0xff}) {
		_, _ = buffered.Discard(2)
		reader = transform.NewReader(buffered, unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder())
		encodingName = "utf-16be"
	}
	maxDecodedBytes := options.MaxDecodedBytes
	if maxDecodedBytes <= 0 {
		maxDecodedBytes = defaultSQLImportMaxDecodedBytes
	}
	maxCompressionRatio := options.MaxCompressionRatio
	if maxCompressionRatio <= 0 {
		maxCompressionRatio = defaultSQLImportMaxCompressionRatio
	}
	minCompressedRatioBytes := options.MinCompressedBytesForRatio
	if minCompressedRatioBytes <= 0 {
		minCompressedRatioBytes = defaultSQLImportMinCompressedBytesForRatio
	}
	reader = &sqlImportDecodedLimitReader{
		reader:                  reader,
		maxBytes:                maxDecodedBytes,
		compressed:              compressionCounter,
		maxCompressionRatio:     maxCompressionRatio,
		minCompressedRatioBytes: minCompressedRatioBytes,
	}
	return &SQLImportSource{
		Reader:     reader,
		Encoding:   encodingName,
		Compressed: compressed,
		rawCounter: rawCounter,
		close:      closeSource,
	}, nil
}
