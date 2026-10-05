package app

import (
	"bufio"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"os"
)

type xlsxSharedStringStore struct {
	path          string
	file          *os.File
	writer        *bufio.Writer
	offsets       []int64
	size          int64
	maxCount      int
	maxValueBytes int
}

type xlsxSharedStringResolver struct {
	reader    io.ReadCloser
	decoder   *xml.Decoder
	store     *xlsxSharedStringStore
	exhausted bool
}

func newXLSXSharedStringStore() (*xlsxSharedStringStore, error) {
	return newXLSXSharedStringStoreWithLimits(maxXLSXSharedStrings, maxImportCellBytes)
}

func newXLSXSharedStringStoreWithLimits(maxCount int, maxValueBytes int) (*xlsxSharedStringStore, error) {
	if maxCount <= 0 || maxValueBytes <= 0 {
		return nil, fmt.Errorf("invalid shared string limits")
	}
	file, err := os.CreateTemp("", "gonavi-xlsx-shared-strings-*.bin")
	if err != nil {
		return nil, err
	}
	return &xlsxSharedStringStore{
		path:          file.Name(),
		file:          file,
		writer:        bufio.NewWriterSize(file, 1024*256),
		maxCount:      maxCount,
		maxValueBytes: maxValueBytes,
	}, nil
}

func (s *xlsxSharedStringStore) Add(value string) error {
	if s == nil || s.file == nil || s.writer == nil {
		return fmt.Errorf("shared string store unavailable")
	}
	// Get seeks the shared-string file to read an earlier value. Flush the
	// buffered writer and restore its append position before adding another
	// value; otherwise a lazy, out-of-order lookup can overwrite earlier data
	// and make subsequent Excel reads fail with EOF.
	if err := s.flush(); err != nil {
		return err
	}
	if _, err := s.file.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	if len(s.offsets) >= s.maxCount {
		return fmt.Errorf("shared string count exceeds %d limit", s.maxCount)
	}
	if len(value) > s.maxValueBytes {
		return fmt.Errorf("shared string exceeds %d-byte cell limit", s.maxValueBytes)
	}
	s.offsets = append(s.offsets, s.size)
	if err := binary.Write(s.writer, binary.LittleEndian, uint32(len(value))); err != nil {
		return err
	}
	written, err := s.writer.WriteString(value)
	s.size += 4 + int64(written)
	return err
}

func (s *xlsxSharedStringStore) Get(index int) (string, error) {
	if s == nil {
		return "", nil
	}
	if index < 0 || index >= len(s.offsets) {
		return "", fmt.Errorf("shared string index out of range: %d", index)
	}
	if err := s.flush(); err != nil {
		return "", err
	}
	if _, err := s.file.Seek(s.offsets[index], io.SeekStart); err != nil {
		return "", err
	}
	var length uint32
	if err := binary.Read(s.file, binary.LittleEndian, &length); err != nil {
		return "", err
	}
	if uint64(length) > uint64(s.maxValueBytes) {
		return "", fmt.Errorf("shared string exceeds %d-byte cell limit", s.maxValueBytes)
	}
	buf := make([]byte, int(length))
	if _, err := io.ReadFull(s.file, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

func (s *xlsxSharedStringStore) flush() error {
	if s == nil || s.writer == nil {
		return nil
	}
	return s.writer.Flush()
}

func (s *xlsxSharedStringStore) Close() error {
	if s == nil {
		return nil
	}
	if s.writer != nil {
		_ = s.writer.Flush()
	}
	var err error
	if s.file != nil {
		err = s.file.Close()
	}
	if s.path != "" {
		_ = os.Remove(s.path)
	}
	return err
}

func (r *xlsxSharedStringResolver) Get(index int) (string, error) {
	if r == nil {
		return "", nil
	}
	if index < 0 {
		return "", fmt.Errorf("shared string index out of range: %d", index)
	}
	for len(r.store.offsets) <= index && !r.exhausted {
		found, err := r.parseNext()
		if err != nil {
			return "", err
		}
		if !found {
			break
		}
	}
	return r.store.Get(index)
}

func (r *xlsxSharedStringResolver) parseNext() (bool, error) {
	for {
		token, err := r.decoder.Token()
		if err != nil {
			if err == io.EOF {
				r.exhausted = true
				return false, nil
			}
			return false, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "si" {
			continue
		}
		value, err := readXLSXSharedStringItem(r.decoder)
		if err != nil {
			return false, err
		}
		if err := r.store.Add(value); err != nil {
			return false, err
		}
		return true, nil
	}
}

func (r *xlsxSharedStringResolver) Close() error {
	if r == nil {
		return nil
	}
	var firstErr error
	if r.reader != nil {
		firstErr = r.reader.Close()
	}
	if r.store != nil {
		if err := r.store.Close(); firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
