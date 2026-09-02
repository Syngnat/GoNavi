package app

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestOpenSQLImportSourceStripsUTF8BOM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql")
	if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, []byte("SELECT 1;")...), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	got, err := io.ReadAll(source)
	if err != nil {
		t.Fatalf("read SQL import source: %v", err)
	}
	if string(got) != "SELECT 1;" {
		t.Fatalf("decoded source = %q, want BOM-free UTF-8", got)
	}
}

func TestOpenSQLImportSourceDecodesUTF16LE(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql")
	if err := os.WriteFile(path, encodeUTF16SQL("SELECT '中文';", binary.LittleEndian), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	got, err := io.ReadAll(source)
	if err != nil {
		t.Fatalf("read SQL import source: %v", err)
	}
	if string(got) != "SELECT '中文';" || source.Encoding != "utf-16le" {
		t.Fatalf("decoded source = %q (%s), want UTF-16LE decoded as UTF-8", got, source.Encoding)
	}
}

func TestOpenSQLImportSourceDecodesUTF16BE(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql")
	if err := os.WriteFile(path, encodeUTF16SQL("SELECT '中文';", binary.BigEndian), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	got, err := io.ReadAll(source)
	if err != nil {
		t.Fatalf("read SQL import source: %v", err)
	}
	if string(got) != "SELECT '中文';" || source.Encoding != "utf-16be" {
		t.Fatalf("decoded source = %q (%s), want UTF-16BE decoded as UTF-8", got, source.Encoding)
	}
}

func TestOpenSQLImportSourceStreamsGzipBeforeEncodingDetection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql.gz")
	writeGzipSQL(t, path, append([]byte{0xef, 0xbb, 0xbf}, []byte("SELECT 1;")...))

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	got, err := io.ReadAll(source)
	if err != nil {
		t.Fatalf("read SQL import source: %v", err)
	}
	if string(got) != "SELECT 1;" || !source.Compressed {
		t.Fatalf("decoded source = %q (compressed=%v), want streamed gzip SQL", got, source.Compressed)
	}
}

func TestOpenSQLImportSourceReportsAndObservesRawCompressedBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql.gz")
	writeGzipSQL(t, path, []byte("SELECT 1;"))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read raw source: %v", err)
	}
	var observed bytes.Buffer

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{RawObserver: &observed})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()
	if _, err := io.ReadAll(source); err != nil {
		t.Fatalf("read SQL import source: %v", err)
	}
	if source.RawBytesRead() != int64(len(raw)) {
		t.Fatalf("raw bytes read = %d, want compressed size %d", source.RawBytesRead(), len(raw))
	}
	if !bytes.Equal(observed.Bytes(), raw) {
		t.Fatal("raw observer did not receive the original compressed bytes")
	}
}

func TestOpenSQLImportSourceEnforcesDecodedByteLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql")
	if err := os.WriteFile(path, []byte("SELECT 1234567890;"), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{MaxDecodedBytes: 8})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	got, readErr := io.ReadAll(source)
	var limitErr *SQLImportSourceLimitError
	if !errors.As(readErr, &limitErr) || limitErr.Kind != SQLImportSourceDecodedByteLimit {
		t.Fatalf("read error = %v, want decoded-byte limit error", readErr)
	}
	if len(got) > 8 || limitErr.DecodedBytes != 8 || limitErr.Limit != 8 {
		t.Fatalf("read %d bytes, error = %#v; want no bytes beyond limit", len(got), limitErr)
	}
}

func TestOpenSQLImportSourceRejectsExcessiveCompressionRatio(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql.gz")
	writeGzipSQL(t, path, []byte(strings.Repeat("INSERT INTO t VALUES (1);\n", 4096)))

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{
		MaxDecodedBytes:            1 << 20,
		MaxCompressionRatio:        2,
		MinCompressedBytesForRatio: 1,
	})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	_, readErr := io.ReadAll(source)
	var limitErr *SQLImportSourceLimitError
	if !errors.As(readErr, &limitErr) || limitErr.Kind != SQLImportSourceCompressionRatio {
		t.Fatalf("read error = %v, want compression-ratio limit error", readErr)
	}
	if limitErr.Ratio <= 2 || limitErr.MaxCompressionRatio != 2 || limitErr.CompressedBytes <= 0 {
		t.Fatalf("limit error = %#v, want measured ratio above limit", limitErr)
	}
}

func TestOpenSQLImportSourceDefaultCompressionRatioProtectsSmallGzipBomb(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql.gz")
	// BestCompression keeps this compact fixture well above the production
	// 1000:1 ratio threshold across supported Go versions.
	writeGzipSQLLevel(t, path, []byte(strings.Repeat("A", 8<<20)), gzip.BestCompression)

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	_, readErr := io.ReadAll(source)
	var limitErr *SQLImportSourceLimitError
	if !errors.As(readErr, &limitErr) || limitErr.Kind != SQLImportSourceCompressionRatio {
		t.Fatalf("read error = %v, want default compression-ratio protection", readErr)
	}
}

func TestOpenSQLImportSourceReportsDecodedLimitBeforeRatioWhenBothCross(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql.gz")
	writeGzipSQL(t, path, []byte(strings.Repeat("A", 4096)))

	source, err := OpenSQLImportSource(path, SQLImportSourceOptions{
		MaxDecodedBytes:            8,
		MaxCompressionRatio:        0.01,
		MinCompressedBytesForRatio: 1,
	})
	if err != nil {
		t.Fatalf("open SQL import source: %v", err)
	}
	defer source.Close()

	_, readErr := io.ReadAll(source)
	var limitErr *SQLImportSourceLimitError
	if !errors.As(readErr, &limitErr) || limitErr.Kind != SQLImportSourceDecodedByteLimit {
		t.Fatalf("read error = %v, want earlier decoded-byte limit", readErr)
	}
}

func writeGzipSQL(t *testing.T, path string, payload []byte) {
	writeGzipSQLLevel(t, path, payload, gzip.DefaultCompression)
}

func writeGzipSQLLevel(t *testing.T, path string, payload []byte, level int) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create gzip source: %v", err)
	}
	writer, err := gzip.NewWriterLevel(file, level)
	if err != nil {
		_ = file.Close()
		t.Fatalf("create gzip writer: %v", err)
	}
	if _, err := writer.Write(payload); err != nil {
		_ = file.Close()
		t.Fatalf("write gzip source: %v", err)
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		t.Fatalf("close gzip writer: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close gzip source: %v", err)
	}
}

func encodeUTF16SQL(value string, order binary.ByteOrder) []byte {
	encoded := utf16.Encode([]rune(value))
	result := make([]byte, 2, 2+len(encoded)*2)
	if order == binary.LittleEndian {
		result[0], result[1] = 0xff, 0xfe
	} else {
		result[0], result[1] = 0xfe, 0xff
	}
	for _, codeUnit := range encoded {
		result = append(result, 0, 0)
		order.PutUint16(result[len(result)-2:], codeUnit)
	}
	return result
}
