package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/webidentity"

	"github.com/google/uuid"
)

type scriptWorkbenchFileEvent struct {
	columns []string
	rows    []map[string]any
	done    bool
	err     error
}

type scriptWorkbenchFileReader struct {
	alias   string
	name    string
	columns []string
	ctx     context.Context
	cancel  context.CancelFunc
	events  <-chan scriptWorkbenchFileEvent
	done    chan struct{}
	sources *importSourceRegistry
	run     *scriptWorkbenchRun
	redact  bool

	mu       sync.Mutex
	closed   bool
	finished bool
}

func newScriptWorkbenchFileReader(
	parent context.Context,
	input scriptPreparedInput,
) (*scriptWorkbenchFileReader, error) {
	if parent == nil {
		parent = context.Background()
	}
	batchSize := clampScriptWorkbenchInt(
		input.batchSize,
		1,
		scriptWorkbenchMaxBatchRows,
		scriptWorkbenchDefaultBatchRows,
	)
	ctx, cancel := context.WithCancel(parent)
	events := make(chan scriptWorkbenchFileEvent, 2)
	_, webInput := webidentity.ActorFromContext(parent)
	consumer := &scriptWorkbenchBatchConsumer{
		ctx:          ctx,
		batchSize:    batchSize,
		maxPageBytes: scriptWorkbenchInputPageBytes,
		events:       events,
	}
	reader := &scriptWorkbenchFileReader{
		alias:   input.alias,
		name:    filepath.Base(input.path),
		ctx:     ctx,
		cancel:  cancel,
		events:  events,
		done:    make(chan struct{}),
		sources: &importSourceRegistry{},
		run:     scriptWorkbenchRunFromContext(parent),
		redact:  webInput,
	}
	inputOptions := scriptWorkbenchInputOptions(input)
	inputOptions.sourceRegistry = reader.sources
	go func() {
		defer close(reader.done)
		err := streamImportFileWithOptionsContext(ctx, input.path, consumer, inputOptions)
		if err == nil {
			err = consumer.Flush()
		}
		err = normalizeScriptInputError(err, reader.redact, input.alias)
		consumer.finish(err)
		close(events)
	}()

	select {
	case <-ctx.Done():
		reader.sources.Close()
		cancel()
		return nil, ctx.Err()
	case event, ok := <-events:
		if !ok {
			reader.sources.Close()
			cancel()
			return nil, errors.New("script input ended before headers were read")
		}
		if event.err != nil {
			reader.sources.Close()
			cancel()
			return nil, normalizeScriptInputError(event.err, reader.redact, input.alias)
		}
		if len(event.columns) == 0 {
			reader.sources.Close()
			cancel()
			return nil, errors.New("script input has no usable header")
		}
		reader.columns = append([]string(nil), event.columns...)
		return reader, nil
	}
}

func scriptWorkbenchInputOptions(input scriptPreparedInput) ImportFileOptions {
	return ImportFileOptions{
		SheetName: input.sheetName,
		Encoding:  input.encoding,
		Delimiter: input.delimiter,
		HeaderRow: input.headerRow,
		lexicalLimits: importLexicalLimits{
			maxCellBytes: scriptWorkbenchInputCellBytes,
			maxRowBytes:  scriptWorkbenchInputRowBytes,
			maxFields:    scriptWorkbenchInputFieldLimit,
		},
		xlsxLimits: xlsxArchiveResourceLimits{
			MaxEntryUncompressedBytes: scriptWorkbenchInputEntryBytes,
			MaxTotalUncompressedBytes: scriptWorkbenchInputArchiveBytes,
			MaxCompressionRatio:       scriptWorkbenchInputCompressionRate,
			MaxSharedStringCount:      scriptWorkbenchInputSharedStrings,
			MaxSharedStringValueBytes: scriptWorkbenchInputCellBytes,
			MaxSharedStringBytes:      scriptWorkbenchInputSharedStringBytes,
		},
	}
}

func (r *scriptWorkbenchFileReader) Next() ([]map[string]any, bool, error) {
	if r == nil {
		return nil, true, errors.New("script input reader is unavailable")
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, true, nil
	}
	if r.finished {
		r.mu.Unlock()
		return nil, true, nil
	}
	r.mu.Unlock()

	select {
	case <-r.ctx.Done():
		return nil, true, r.ctx.Err()
	case event, ok := <-r.events:
		if !ok {
			r.mu.Lock()
			r.finished = true
			r.mu.Unlock()
			return nil, true, nil
		}
		if event.err != nil {
			r.mu.Lock()
			r.finished = true
			r.mu.Unlock()
			return nil, true, normalizeScriptInputError(event.err, r.redact, r.alias)
		}
		if event.done {
			r.mu.Lock()
			r.finished = true
			r.mu.Unlock()
			return nil, true, nil
		}
		if len(event.rows) == 0 {
			return r.Next()
		}
		return event.rows, false, nil
	}
}

func (r *scriptWorkbenchFileReader) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	r.mu.Unlock()
	r.cancel()
	if r.sources != nil {
		r.sources.Close()
	}
	select {
	case <-r.done:
		return nil
	case <-time.After(2 * time.Second):
		err := fmt.Errorf("script input %q reader cleanup timed out", r.alias)
		r.reportCleanupError(err)
		return err
	}
}

func (r *scriptWorkbenchFileReader) reportCleanupError(err error) {
	if r == nil || r.run == nil || err == nil {
		return
	}
	message := truncateUTF8Bytes("script input reader cleanup failed: "+err.Error(), 8<<10)
	r.run.appendLog("error", message)
	r.run.mu.Lock()
	if strings.TrimSpace(r.run.err) == "" {
		r.run.err = message
	} else {
		r.run.err = truncateUTF8Bytes(r.run.err+"; "+message, 8<<10)
	}
	r.run.errorKind = "backend"
	r.run.mu.Unlock()
	r.run.emit("log", map[string]any{"level": "error", "message": message})
}

func normalizeScriptInputError(err error, redact bool, alias string) error {
	if err == nil || !redact {
		return err
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return fmt.Errorf("script input %q is unavailable or invalid", alias)
	}
	return err
}

type scriptWorkbenchBatchConsumer struct {
	ctx          context.Context
	batchSize    int
	maxPageBytes int
	events       chan<- scriptWorkbenchFileEvent
	pending      []map[string]any
	pendingBytes int
	header       []string
	finished     bool
}

func (c *scriptWorkbenchBatchConsumer) SetColumns(columns []string) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	encoded, err := json.Marshal(columns)
	if err != nil {
		return fmt.Errorf("encode script input header: %w", err)
	}
	limit := c.pageLimit()
	if len(encoded) > limit {
		return fmt.Errorf("script input header exceeds %d-byte page budget", limit)
	}
	c.header = append([]string(nil), columns...)
	return c.send(scriptWorkbenchFileEvent{columns: c.header})
}

func (c *scriptWorkbenchBatchConsumer) ConsumeRow(row map[string]any) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	rowPayload, err := json.Marshal(row)
	if err != nil {
		return fmt.Errorf("encode script input row: %w", err)
	}
	rowBytes := len(rowPayload) + 1
	limit := c.pageLimit()
	if rowBytes > limit {
		return fmt.Errorf("script input row exceeds %d-byte page budget", limit)
	}
	if len(c.pending) > 0 && c.pendingBytes+rowBytes > limit {
		if err := c.Flush(); err != nil {
			return err
		}
	}
	c.pending = append(c.pending, cloneScriptWorkbenchRow(row))
	c.pendingBytes += rowBytes
	if len(c.pending) >= c.batchSize {
		return c.Flush()
	}
	return nil
}

func (c *scriptWorkbenchBatchConsumer) pageLimit() int {
	if c == nil || c.maxPageBytes <= 0 {
		return scriptWorkbenchInputPageBytes
	}
	return c.maxPageBytes
}

func (c *scriptWorkbenchBatchConsumer) Flush() error {
	if len(c.pending) == 0 {
		return nil
	}
	rows := c.pending
	c.pending = nil
	c.pendingBytes = 0
	return c.send(scriptWorkbenchFileEvent{rows: rows})
}

func (c *scriptWorkbenchBatchConsumer) finish(err error) {
	if c == nil || c.finished {
		return
	}
	c.finished = true
	if err != nil {
		_ = c.send(scriptWorkbenchFileEvent{err: err, done: true})
		return
	}
	_ = c.send(scriptWorkbenchFileEvent{done: true})
}

func (c *scriptWorkbenchBatchConsumer) send(event scriptWorkbenchFileEvent) error {
	if c == nil || c.events == nil {
		return errors.New("script input event channel is unavailable")
	}
	select {
	case <-c.ctx.Done():
		return c.ctx.Err()
	case c.events <- event:
		return nil
	}
}

func cloneScriptWorkbenchRow(row map[string]any) map[string]any {
	if len(row) == 0 {
		return map[string]any{}
	}
	cloned := make(map[string]any, len(row))
	for key, value := range row {
		cloned[key] = value
	}
	return cloned
}

func (h *scriptWorkbenchHost) openFile(
	ctx context.Context,
	alias string,
	options scriptWorkbenchFileOpenOptions,
) (map[string]any, error) {
	if h == nil {
		return nil, errScriptWorkbenchUnavailable
	}
	alias = strings.TrimSpace(alias)
	prepared, exists := h.prepared.inputs[alias]
	if !exists {
		return nil, fmt.Errorf("script input %q is not bound", alias)
	}
	if sheet := strings.TrimSpace(options.SheetName); sheet != "" {
		prepared.sheetName = sheet
	}
	if options.HeaderRow > 0 {
		prepared.headerRow = options.HeaderRow
	}
	batchSize := options.BatchSize
	if batchSize > 0 {
		prepared.batchSize = clampScriptWorkbenchInt(
			batchSize,
			1,
			scriptWorkbenchMaxBatchRows,
			prepared.batchSize,
		)
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, errors.New("script host is closed")
	}
	if h.readers == nil {
		h.readers = make(map[string]*scriptWorkbenchFileReader)
	}
	if len(h.readers) >= 8 {
		h.mu.Unlock()
		return nil, errors.New("too many script input readers are open")
	}
	h.mu.Unlock()

	reader, err := newScriptWorkbenchFileReader(ctx, prepared)
	if err != nil {
		return nil, err
	}
	readerID := "script-reader-" + uuid.NewString()
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		reader.Close()
		return nil, errors.New("script host is closed")
	}
	if len(h.readers) >= 8 {
		h.mu.Unlock()
		reader.Close()
		return nil, errors.New("too many script input readers are open")
	}
	h.readers[readerID] = reader
	h.mu.Unlock()
	return map[string]any{
		"readerId": readerID,
		"fileName": prepared.name,
		"columns":  reader.columns,
	}, nil
}

func (h *scriptWorkbenchHost) nextFile(readerID string) (map[string]any, error) {
	if h == nil {
		return nil, errScriptWorkbenchUnavailable
	}
	h.mu.Lock()
	reader := h.readers[strings.TrimSpace(readerID)]
	h.mu.Unlock()
	if reader == nil {
		return nil, errors.New("script input reader not found")
	}
	rows, done, err := reader.Next()
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	return map[string]any{"rows": rows, "done": done}, nil
}

func (h *scriptWorkbenchHost) closeFile(readerID string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	reader := h.readers[strings.TrimSpace(readerID)]
	delete(h.readers, strings.TrimSpace(readerID))
	h.mu.Unlock()
	if reader != nil {
		reader.Close()
	}
}
