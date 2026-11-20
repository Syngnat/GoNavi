package scriptengine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"
)

const outputChunkRows = 500

type workerRuntime struct {
	vm          *goja.Runtime
	request     RunRequest
	ctx         context.Context
	cancel      context.CancelFunc
	output      io.Writer
	writeMu     sync.Mutex
	pendingMu   sync.Mutex
	pending     map[int64]chan workerInbound
	nextID      atomic.Int64
	outputRows  int
	outputBytes int
}

// RunWorker serves one script run over stdin/stdout. It is intended to be
// invoked only from the hidden `script-worker` process mode.
func RunWorker(parent context.Context, input io.Reader, output io.Writer) error {
	if input == nil || output == nil {
		return errors.New("script worker requires stdin and stdout")
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	reader := bufio.NewScanner(input)
	reader.Buffer(make([]byte, 64<<10), MaxFrameBytes)
	if !reader.Scan() {
		if err := reader.Err(); err != nil {
			return fmt.Errorf("read script run request: %w", err)
		}
		return errors.New("script worker received no run request")
	}
	var start workerInbound
	if err := json.Unmarshal(reader.Bytes(), &start); err != nil {
		return fmt.Errorf("decode script run request: %w", err)
	}
	if start.Type != frameTypeRun || start.Request == nil {
		return errors.New("script worker expected a run frame")
	}
	if len(start.Request.Script) > MaxScriptBytes {
		return fmt.Errorf("script exceeds %d bytes", MaxScriptBytes)
	}

	runtime := &workerRuntime{
		vm:      goja.New(),
		request: *start.Request,
		ctx:     ctx,
		cancel:  cancel,
		output:  output,
		pending: make(map[int64]chan workerInbound),
	}
	if limit := runtime.request.Limits.MemoryLimitBytes; limit > 0 {
		debug.SetMemoryLimit(limit)
		debug.SetGCPercent(50)
	}
	inbound := make(chan workerInbound, 16)
	go runtime.readInbound(reader, inbound)
	go func() {
		<-ctx.Done()
		runtime.vm.Interrupt(ctx.Err())
	}()

	startedAt := time.Now()
	runtime.installAPI()
	value, runErr := runtime.vm.RunString(runtime.request.Script)
	_ = value
	result := RunResult{
		DurationMs: time.Since(startedAt).Milliseconds(),
	}
	switch {
	case runErr == nil:
		result.Success = true
	case ctx.Err() != nil:
		result.Message = "script cancelled"
		result.Cancelled = true
	default:
		result.Message = formatScriptError(runErr)
	}
	if ctx.Err() != nil {
		result.Success = false
		result.Cancelled = true
		if strings.TrimSpace(result.Message) == "" {
			result.Message = "script cancelled"
		}
	}
	result.Message = truncateUTF8Text(result.Message, MaxErrorMessageBytes)
	if err := runtime.writeFrame(workerOutbound{Type: frameTypeDone, Result: &result}); err != nil {
		return err
	}
	return nil
}

func (r *workerRuntime) readInbound(reader *bufio.Scanner, inbound chan<- workerInbound) {
	for reader.Scan() {
		var frame workerInbound
		if err := json.Unmarshal(reader.Bytes(), &frame); err != nil {
			r.cancel()
			r.vm.Interrupt(fmt.Errorf("invalid worker frame: %w", err))
			return
		}
		switch frame.Type {
		case frameTypeHostResponse:
			r.pendingMu.Lock()
			channel := r.pending[frame.ID]
			delete(r.pending, frame.ID)
			r.pendingMu.Unlock()
			if channel != nil {
				channel <- frame
			}
		case frameTypeCancel:
			r.cancel()
			r.vm.Interrupt(context.Canceled)
		default:
			select {
			case inbound <- frame:
			case <-r.ctx.Done():
				return
			}
		}
	}
	if err := reader.Err(); err != nil {
		r.cancel()
		r.vm.Interrupt(fmt.Errorf("read script worker input: %w", err))
		return
	}
	r.cancel()
	r.vm.Interrupt(io.EOF)
}

func (r *workerRuntime) installAPI() {
	api := r.vm.NewObject()
	files := r.vm.NewObject()
	db := r.vm.NewObject()

	_ = files.Set("open", r.native(r.jsFilesOpen))
	_ = db.Set("query", r.native(r.jsDBQuery))
	_ = db.Set("execute", r.native(r.jsDBExecute))
	_ = db.Set("transaction", r.native(r.jsDBTransaction))
	_ = api.Set("files", files)
	_ = api.Set("db", db)
	_ = api.Set("output", r.native(r.jsOutput))
	_ = api.Set("log", r.jsLog)
	_ = api.Set("progress", r.native(r.jsProgress))
	_ = r.vm.Set("gonavi", api)

	console := r.vm.NewObject()
	_ = console.Set("log", func(call goja.FunctionCall) goja.Value {
		r.emitEvent(Event{Type: "log", Level: "info", Message: formatJSArgs(call.Arguments)})
		return goja.Undefined()
	})
	_ = console.Set("warn", func(call goja.FunctionCall) goja.Value {
		r.emitEvent(Event{Type: "log", Level: "warn", Message: formatJSArgs(call.Arguments)})
		return goja.Undefined()
	})
	_ = console.Set("error", func(call goja.FunctionCall) goja.Value {
		r.emitEvent(Event{Type: "log", Level: "error", Message: formatJSArgs(call.Arguments)})
		return goja.Undefined()
	})
	_ = r.vm.Set("console", console)
}

func (r *workerRuntime) jsFilesOpen(call goja.FunctionCall) (goja.Value, error) {
	alias, err := argumentString(call, 0, "file alias")
	if err != nil {
		return nil, err
	}
	options := argumentObject(call, 1)
	result, err := r.requestHost("file.open", map[string]any{
		"alias":     alias,
		"sheetName": stringOption(options, "sheetName"),
		"headerRow": intOption(options, "headerRow", 0),
		"batchSize": intOption(options, "batchSize", 0),
	})
	if err != nil {
		return nil, err
	}
	var opened hostOpenResult
	if err := json.Unmarshal(result, &opened); err != nil {
		return nil, err
	}
	reader := r.vm.NewObject()
	readerID := opened.ReaderID
	_ = reader.Set("next", r.native(func(call goja.FunctionCall) (goja.Value, error) {
		payload, err := r.requestHost("file.next", map[string]any{"readerId": readerID})
		if err != nil {
			return nil, err
		}
		var page hostNextResult
		if err := json.Unmarshal(payload, &page); err != nil {
			return nil, err
		}
		return r.vm.ToValue(map[string]any{
			"rows": page.Rows,
			"done": page.Done,
		}), nil
	}))
	_ = reader.Set("close", r.native(func(call goja.FunctionCall) (goja.Value, error) {
		_, err := r.requestHost("file.close", map[string]any{"readerId": readerID})
		return goja.Undefined(), err
	}))
	_ = reader.Set("fileName", opened.FileName)
	_ = reader.Set("columns", opened.Columns)
	return reader, nil
}

func (r *workerRuntime) jsDBQuery(call goja.FunctionCall) (goja.Value, error) {
	alias, options, err := r.dbArguments(call)
	if err != nil {
		return nil, err
	}
	payload, err := r.requestHost("db.query", map[string]any{
		"alias":    alias,
		"database": options["database"],
		"sql":      options["sql"],
		"params":   options["params"],
		"maxRows":  options["maxRows"],
	})
	if err != nil {
		return nil, err
	}
	return r.decodeHostValue(payload)
}

func (r *workerRuntime) jsDBExecute(call goja.FunctionCall) (goja.Value, error) {
	alias, options, err := r.dbArguments(call)
	if err != nil {
		return nil, err
	}
	payload, err := r.requestHost("db.execute", map[string]any{
		"alias":    alias,
		"database": options["database"],
		"sql":      options["sql"],
		"params":   options["params"],
	})
	if err != nil {
		return nil, err
	}
	return r.decodeHostValue(payload)
}

func (r *workerRuntime) jsDBTransaction(call goja.FunctionCall) (goja.Value, error) {
	alias, err := argumentString(call, 0, "connection alias")
	if err != nil {
		return nil, err
	}
	options := argumentObject(call, 1)
	callbackArg := call.Argument(2)
	if goja.IsUndefined(callbackArg) || goja.IsNull(callbackArg) {
		options = nil
		callbackArg = call.Argument(1)
	}
	callback, ok := goja.AssertFunction(callbackArg)
	if !ok {
		return nil, errors.New("gonavi.db.transaction requires a callback function")
	}
	payload, err := r.requestHost("tx.begin", map[string]any{
		"alias":    alias,
		"database": options["database"],
	})
	if err != nil {
		return nil, err
	}
	var opened hostTransactionResult
	if err := json.Unmarshal(payload, &opened); err != nil {
		return nil, err
	}

	tx := r.vm.NewObject()
	transactionID := opened.TransactionID
	_ = tx.Set("query", r.native(func(call goja.FunctionCall) (goja.Value, error) {
		sql, params, err := statementArguments(call)
		if err != nil {
			return nil, err
		}
		response, err := r.requestHost("tx.query", map[string]any{
			"transactionId": transactionID,
			"sql":           sql,
			"params":        params,
		})
		if err != nil {
			return nil, err
		}
		return r.decodeHostValue(response)
	}))
	_ = tx.Set("execute", r.native(func(call goja.FunctionCall) (goja.Value, error) {
		sql, params, err := statementArguments(call)
		if err != nil {
			return nil, err
		}
		response, err := r.requestHost("tx.execute", map[string]any{
			"transactionId": transactionID,
			"sql":           sql,
			"params":        params,
		})
		if err != nil {
			return nil, err
		}
		return r.decodeHostValue(response)
	}))
	_ = tx.Set("id", transactionID)

	if _, callbackErr := callback(goja.Undefined(), tx); callbackErr != nil {
		_, rollbackErr := r.requestHost("tx.rollback", map[string]any{"transactionId": transactionID})
		if rollbackErr != nil {
			return nil, errors.Join(callbackErr, fmt.Errorf("transaction rollback failed: %w", rollbackErr))
		}
		return nil, callbackErr
	}
	if _, err := r.requestHost("tx.commit", map[string]any{"transactionId": transactionID}); err != nil {
		return nil, err
	}
	return goja.Undefined(), nil
}

func (r *workerRuntime) dbArguments(call goja.FunctionCall) (string, map[string]any, error) {
	alias, err := argumentString(call, 0, "connection alias")
	if err != nil {
		return "", nil, err
	}
	options := argumentObject(call, 1)
	sqlValue, ok := options["sql"]
	if !ok || strings.TrimSpace(fmt.Sprint(sqlValue)) == "" {
		return "", nil, errors.New("SQL is required")
	}
	return alias, options, nil
}

func (r *workerRuntime) jsOutput(call goja.FunctionCall) (goja.Value, error) {
	name, err := argumentString(call, 0, "output name")
	if err != nil {
		return nil, err
	}
	if len(name) > MaxOutputNameBytes {
		return nil, fmt.Errorf("output name exceeds %d bytes", MaxOutputNameBytes)
	}
	raw := call.Argument(1).Export()
	rows, ok := raw.([]any)
	if !ok {
		return nil, errors.New("gonavi.output requires an array of rows")
	}
	outputRowLimit := r.outputRowLimit()
	if r.outputRows+len(rows) > outputRowLimit {
		return nil, fmt.Errorf("script output exceeds %d rows", outputRowLimit)
	}

	chunk := make([]map[string]any, 0, min(outputChunkRows, len(rows)))
	chunkBytes := 0
	totalBytes := 0
	flush := func() error {
		if len(chunk) == 0 {
			return nil
		}
		payload, err := json.Marshal(map[string]any{
			"name": name,
			"rows": chunk,
		})
		if err != nil {
			return fmt.Errorf("encode script output: %w", err)
		}
		if len(payload) > MaxOutputChunkBytes {
			return fmt.Errorf("script output chunk exceeds %d bytes", MaxOutputChunkBytes)
		}
		if err := r.emitEvent(Event{Type: "output", Name: name, Payload: payload}); err != nil {
			return err
		}
		chunk = chunk[:0]
		chunkBytes = 0
		return nil
	}

	for index, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("gonavi.output row %d must be an object", index+1)
		}
		rowPayload, err := json.Marshal(row)
		if err != nil {
			return nil, fmt.Errorf("encode gonavi.output row %d: %w", index+1, err)
		}
		if len(rowPayload) > MaxOutputChunkBytes {
			return nil, fmt.Errorf("gonavi.output row %d exceeds %d bytes", index+1, MaxOutputChunkBytes)
		}
		if r.outputBytes+totalBytes+len(rowPayload) > MaxOutputBytes {
			return nil, fmt.Errorf("script output exceeds %d bytes", MaxOutputBytes)
		}
		if len(chunk) > 0 &&
			(len(chunk) >= outputChunkRows || chunkBytes+len(rowPayload) > MaxOutputChunkBytes) {
			if err := flush(); err != nil {
				return nil, err
			}
		}
		chunk = append(chunk, row)
		chunkBytes += len(rowPayload)
		totalBytes += len(rowPayload)
	}
	if err := flush(); err != nil {
		return nil, err
	}
	r.outputRows += len(rows)
	r.outputBytes += totalBytes
	return goja.Undefined(), nil
}

func (r *workerRuntime) outputRowLimit() int {
	if r == nil {
		return DefaultOutputRows
	}
	limit := r.request.Limits.MaxOutputRows
	if limit <= 0 {
		return DefaultOutputRows
	}
	if limit > MaxOutputRows {
		return MaxOutputRows
	}
	return limit
}

func (r *workerRuntime) jsLog(call goja.FunctionCall) goja.Value {
	level := "info"
	message := ""
	if len(call.Arguments) > 1 {
		level = strings.ToLower(strings.TrimSpace(call.Argument(0).String()))
		message = formatJSValue(call.Argument(1))
	} else if len(call.Arguments) == 1 {
		message = formatJSValue(call.Argument(0))
	}
	switch level {
	case "debug", "info", "warn", "error":
	default:
		level = "info"
	}
	r.emitEvent(Event{Type: "log", Level: level, Message: message})
	return goja.Undefined()
}

func (r *workerRuntime) jsProgress(call goja.FunctionCall) (goja.Value, error) {
	payload := call.Argument(0).Export()
	if _, ok := payload.(map[string]any); !ok {
		return nil, errors.New("gonavi.progress requires an object")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode gonavi.progress payload: %w", err)
	}
	if len(encoded) > MaxProgressBytes {
		return nil, fmt.Errorf("gonavi.progress payload exceeds %d bytes", MaxProgressBytes)
	}
	if err := r.emitEvent(Event{Type: "progress", Payload: encoded}); err != nil {
		return nil, err
	}
	return goja.Undefined(), nil
}

func (r *workerRuntime) requestHost(method string, params any) (json.RawMessage, error) {
	if err := r.ctx.Err(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	if len(encoded) > MaxFrameBytes-(64<<10) {
		return nil, fmt.Errorf("script host request exceeds %d bytes", MaxFrameBytes-(64<<10))
	}
	id := r.nextID.Add(1)
	response := make(chan workerInbound, 1)
	r.pendingMu.Lock()
	r.pending[id] = response
	r.pendingMu.Unlock()
	if err := r.writeFrame(workerOutbound{
		Type:   frameTypeHostRequest,
		ID:     id,
		Method: method,
		Params: encoded,
	}); err != nil {
		r.removePending(id)
		return nil, err
	}
	select {
	case <-r.ctx.Done():
		r.removePending(id)
		return nil, r.ctx.Err()
	case frame := <-response:
		if strings.TrimSpace(frame.Error) != "" {
			return nil, errors.New(frame.Error)
		}
		return frame.Result, nil
	}
}

func (r *workerRuntime) removePending(id int64) {
	r.pendingMu.Lock()
	delete(r.pending, id)
	r.pendingMu.Unlock()
}

func (r *workerRuntime) decodeHostValue(payload json.RawMessage) (goja.Value, error) {
	if len(payload) == 0 {
		return goja.Undefined(), nil
	}
	var decoded any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, err
	}
	return r.vm.ToValue(decoded), nil
}

func (r *workerRuntime) emitEvent(event Event) error {
	if event.Type == "log" {
		event.Message = truncateUTF8Text(event.Message, MaxLogMessageBytes)
	}
	if event.Name != "" {
		event.Name = truncateUTF8Text(event.Name, MaxOutputNameBytes)
	}
	if event.Type == "progress" && len(event.Payload) > MaxProgressBytes {
		return fmt.Errorf("script progress payload exceeds %d bytes", MaxProgressBytes)
	}
	frame := workerOutbound{Type: frameTypeEvent, Event: &event}
	if err := r.writeFrame(frame); err != nil {
		r.cancel()
		return err
	}
	return nil
}

func (r *workerRuntime) writeFrame(frame workerOutbound) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if len(payload) > MaxFrameBytes {
		return fmt.Errorf("script frame exceeds %d bytes", MaxFrameBytes)
	}
	payload = append(payload, '\n')
	_, err = r.output.Write(payload)
	return err
}

func (r *workerRuntime) native(
	function func(goja.FunctionCall) (goja.Value, error),
) func(goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		value, err := function(call)
		if err == nil {
			return value
		}
		var exception *goja.Exception
		if errors.As(err, &exception) {
			panic(exception)
		}
		var interrupted *goja.InterruptedError
		if errors.As(err, &interrupted) {
			panic(interrupted)
		}
		panic(r.vm.NewGoError(err))
	}
}

func argumentString(call goja.FunctionCall, index int, label string) (string, error) {
	value := call.Argument(index)
	if goja.IsUndefined(value) || goja.IsNull(value) {
		return "", fmt.Errorf("%s is required", label)
	}
	text := strings.TrimSpace(value.String())
	if text == "" {
		return "", fmt.Errorf("%s is required", label)
	}
	return text, nil
}

func argumentObject(call goja.FunctionCall, index int) map[string]any {
	value := call.Argument(index)
	if goja.IsUndefined(value) || goja.IsNull(value) {
		return map[string]any{}
	}
	exported := value.Export()
	if result, ok := exported.(map[string]any); ok {
		return result
	}
	return map[string]any{}
}

func statementArguments(call goja.FunctionCall) (string, any, error) {
	sql, err := argumentString(call, 0, "SQL")
	if err != nil {
		return "", nil, err
	}
	options := argumentObject(call, 1)
	return sql, options["params"], nil
}

func stringOption(options map[string]any, name string) string {
	value, ok := options[name]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func intOption(options map[string]any, name string, fallback int) int {
	value, ok := options[name]
	if !ok || value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return fallback
	}
}

func formatJSArgs(values []goja.Value) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, formatJSValue(value))
	}
	return strings.Join(parts, " ")
}

func formatJSValue(value goja.Value) string {
	if goja.IsUndefined(value) {
		return "undefined"
	}
	if goja.IsNull(value) {
		return "null"
	}
	exported := value.Export()
	if text, ok := exported.(string); ok {
		return text
	}
	encoded, err := json.Marshal(exported)
	if err != nil {
		return value.String()
	}
	return string(encoded)
}

func formatScriptError(err error) string {
	if err == nil {
		return ""
	}
	var interrupted *goja.InterruptedError
	if errors.As(err, &interrupted) {
		return "script interrupted"
	}
	var exception *goja.Exception
	if errors.As(err, &exception) {
		return exception.String()
	}
	return err.Error()
}
