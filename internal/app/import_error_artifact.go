package app

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/sqlaudit"

	"github.com/google/uuid"
)

// ImportRowError is the durable, exportable representation of a rejected
// source row. Values are retained only in the user-local artifact; driver
// messages are sanitized before persistence.
type ImportRowError struct {
	SourceRow int64                  `json:"sourceRow"`
	Line      int64                  `json:"line,omitempty"`
	Byte      int64                  `json:"byteOffset,omitempty"`
	Column    string                 `json:"column,omitempty"`
	Category  string                 `json:"category"`
	Code      string                 `json:"code,omitempty"`
	Message   string                 `json:"message"`
	Retryable bool                   `json:"retryable,omitempty"`
	Values    map[string]interface{} `json:"values,omitempty"`
}

type ImportErrorArtifact struct {
	ID               string `json:"id"`
	Count            int64  `json:"count"`
	Bytes            int64  `json:"bytes,omitempty"`
	OmittedCount     int64  `json:"omittedCount,omitempty"`
	Truncated        bool   `json:"truncated,omitempty"`
	RetryableCount   int64  `json:"retryableCount,omitempty"`
	UnretryableCount int64  `json:"unretryableCount,omitempty"`
	MaxRows          int64  `json:"maxRows,omitempty"`
	MaxBytes         int64  `json:"maxBytes,omitempty"`
	CreatedAt        int64  `json:"createdAt"`
}

// Error artifacts are intentionally bounded because they live in the user's
// durable data directory and may contain rejected source values.
const (
	maxImportErrorArtifactRows  int64 = 10_000
	maxImportErrorArtifactBytes int64 = 32 * 1024 * 1024
	maxImportRetryColumns             = 4096
)

type importErrorArtifactStore struct {
	root string
}

type importErrorArtifactWriter struct {
	store       *importErrorArtifactStore
	id          string
	path        string
	file        *os.File
	buffered    *bufio.Writer
	count       int64
	bytes       int64
	omitted     int64
	truncated   bool
	retryable   int64
	unretryable int64
	finished    bool
	createdAt   int64
}

func isRetryableImportErrorRow(row ImportRowError) bool {
	if len(row.Values) == 0 {
		return false
	}
	return row.Retryable || strings.EqualFold(strings.TrimSpace(row.Category), "database")
}

func newImportErrorArtifactStore(root string) (*importErrorArtifactStore, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("import error artifact directory is empty")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absRoot, 0o700); err != nil {
		return nil, err
	}
	return &importErrorArtifactStore{root: absRoot}, nil
}

func (s *importErrorArtifactStore) Begin(_ string) (*importErrorArtifactWriter, error) {
	if s == nil || strings.TrimSpace(s.root) == "" {
		return nil, errors.New("import error artifact store is unavailable")
	}
	id := uuid.NewString()
	path := filepath.Join(s.root, id+".jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	buffered := bufio.NewWriterSize(f, 64*1024)
	return &importErrorArtifactWriter{
		store:     s,
		id:        id,
		path:      path,
		file:      f,
		buffered:  buffered,
		createdAt: time.Now().UnixMilli(),
	}, nil
}

func (w *importErrorArtifactWriter) Append(row ImportRowError) error {
	if w == nil || w.finished || w.buffered == nil {
		return errors.New("import error artifact writer is closed")
	}
	row.Category = strings.ToLower(strings.TrimSpace(row.Category))
	row.Code = strings.TrimSpace(row.Code)
	row.Column = strings.TrimSpace(row.Column)
	row.Message = sqlaudit.RedactError(row.Message)
	retryable := isRetryableImportErrorRow(row)
	row.Retryable = retryable
	if w.truncated || w.count >= maxImportErrorArtifactRows {
		w.truncated = true
		w.omitted++
		return nil
	}
	encoded, err := json.Marshal(row)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if w.bytes+int64(len(encoded)) > maxImportErrorArtifactBytes {
		w.truncated = true
		w.omitted++
		return nil
	}
	written, err := w.buffered.Write(encoded)
	if err != nil {
		return err
	}
	if written != len(encoded) {
		return io.ErrShortWrite
	}
	w.count++
	w.bytes += int64(written)
	if retryable {
		w.retryable++
	} else {
		w.unretryable++
	}
	return nil
}

func (w *importErrorArtifactWriter) Finish() (ImportErrorArtifact, error) {
	if w == nil || w.finished {
		return ImportErrorArtifact{}, errors.New("import error artifact writer is closed")
	}
	w.finished = true
	if err := w.buffered.Flush(); err != nil {
		_ = w.file.Close()
		_ = os.Remove(w.path)
		return ImportErrorArtifact{}, err
	}
	if err := w.file.Sync(); err != nil {
		_ = w.file.Close()
		_ = os.Remove(w.path)
		return ImportErrorArtifact{}, err
	}
	if err := w.file.Close(); err != nil {
		_ = os.Remove(w.path)
		return ImportErrorArtifact{}, err
	}
	return ImportErrorArtifact{
		ID:               w.id,
		Count:            w.count,
		Bytes:            w.bytes,
		OmittedCount:     w.omitted,
		Truncated:        w.truncated,
		RetryableCount:   w.retryable,
		UnretryableCount: w.unretryable,
		MaxRows:          maxImportErrorArtifactRows,
		MaxBytes:         maxImportErrorArtifactBytes,
		CreatedAt:        w.createdAt,
	}, nil
}

func (w *importErrorArtifactWriter) Abort() {
	if w == nil || w.finished {
		return
	}
	w.finished = true
	if w.file != nil {
		_ = w.file.Close()
	}
	if w.path != "" {
		_ = os.Remove(w.path)
	}
}

func (s *importErrorArtifactStore) Open(id string) (*os.File, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	if err != nil || parsed.String() != strings.ToLower(strings.TrimSpace(id)) {
		return nil, os.ErrNotExist
	}
	path := filepath.Join(s.root, parsed.String()+".jsonl")
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, fmt.Errorf("import error artifact is not a regular file")
	}
	return f, nil
}

func (s *importErrorArtifactStore) Delete(id string) error {
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	if err != nil || parsed.String() != strings.ToLower(strings.TrimSpace(id)) {
		return os.ErrNotExist
	}
	if err := os.Remove(filepath.Join(s.root, parsed.String()+".jsonl")); err != nil {
		return err
	}
	return nil
}
