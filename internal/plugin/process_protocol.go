package plugin

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// processExitGrace bounds how long the read side waits for the authoritative process exit cause
// once the protocol stream ends.
const processExitGrace = 200 * time.Millisecond

func (p *rpcProcess) readProtocol() {
	defer p.workers.Done()
	scanner := bufio.NewScanner(p.stdout)
	scanner.Buffer(make([]byte, 4096), maxRPCBytes+1)
	window := time.Now()
	count := 0
	bytesRead := 0
	for scanner.Scan() {
		if time.Since(window) > time.Second {
			window = time.Now()
			count = 0
			bytesRead = 0
		}
		count++
		bytesRead += len(scanner.Bytes())
		if count > 256 || bytesRead > 8<<20 {
			p.fail(fmt.Errorf("plugin protocol output rate exceeded"))
			return
		}
		if err := p.receive(scanner.Bytes()); err != nil {
			p.fail(err)
			return
		}
	}
	cause := fmt.Errorf("plugin protocol closed")
	if err := scanner.Err(); err != nil && !errors.Is(err, os.ErrClosed) {
		cause = fmt.Errorf("plugin protocol frame invalid or oversized: %w", err)
	}
	// exec.Cmd.Wait closes the parent pipe ends before it reports how the process ended, so the
	// read side always observes a closed or drained pipe first. The exit status explains that far
	// better than the pipe observation, so the wait worker gets a bounded chance to publish it;
	// a stdout that closes while the process keeps running still faults with the pipe diagnostic.
	select {
	case <-p.done:
	case <-time.After(processExitGrace):
	}
	p.fail(cause)
}
func (p *rpcProcess) receive(frame []byte) error {
	var message rpcEnvelope
	if err := json.Unmarshal(frame, &message); err != nil || message.JSONRPC != "2.0" {
		return fmt.Errorf("malformed plugin json-rpc frame")
	}
	if message.Method != "" {
		return p.rejectHostRequest(message)
	}
	var id uint64
	if len(message.ID) == 0 || json.Unmarshal(message.ID, &id) != nil || id == 0 {
		return fmt.Errorf("invalid plugin response id")
	}
	if (len(message.Result) == 0) == (message.Error == nil) {
		return fmt.Errorf("invalid plugin response result")
	}
	p.mu.Lock()
	call, ok := p.pending[id]
	if ok && call.policy.maxResponseBytes > 0 && len(frame) > call.policy.maxResponseBytes {
		p.mu.Unlock()
		return fmt.Errorf("plugin response exceeds reserved frame limit")
	}
	delete(p.pending, id)
	next := p.next
	p.mu.Unlock()
	if !ok {
		if id > next {
			return fmt.Errorf("unsolicited plugin response")
		}
		return nil
	}
	call.settle()
	if message.Error != nil {
		call.reply <- rpcResult{err: fmt.Errorf("plugin rpc error %d", message.Error.Code)}
	} else {
		call.reply <- rpcResult{value: append(json.RawMessage(nil), message.Result...)}
	}
	return nil
}
func (p *rpcProcess) rejectHostRequest(message rpcEnvelope) error {
	if len(message.ID) == 0 {
		return fmt.Errorf("unsupported plugin notification")
	}
	var id any
	if err := json.Unmarshal(message.ID, &id); err != nil {
		return fmt.Errorf("invalid plugin request id")
	}
	switch id.(type) {
	case string, float64:
	default:
		return fmt.Errorf("invalid plugin request id")
	}
	// host.log, host.describe and host.capability are caller-bound. Every other
	// plugin method stays unsupported.
	handler := p.hostHandler(message.Method)
	if handler == nil {
		frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "error": map[string]any{"code": -32601, "message": "host method is not supported"}})
		if err != nil {
			return err
		}
		return p.replyHost(frame, err)
	}
	// Never run a host callback on the protocol reader: a slow metadata/connection call would
	// stop ping responses from being consumed and the watchdog would quarantine a live plugin.
	slots := p.hostRequestSlots()
	select {
	case slots <- struct{}{}:
	default:
		frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "error": map[string]any{"code": -32001, "message": "host request was rejected"}})
		return p.replyHost(frame, err)
	}
	go func() {
		defer func() { <-slots }()
		result, callErr := handler(message.Params)
		if callErr == nil {
			frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": result})
			_ = p.replyHost(frame, err)
			return
		}
		code := -32003
		if errors.Is(callErr, errHostLogParams) {
			code = -32602
		} else if errors.Is(callErr, errHostLogBusy) {
			code = -32001
		}
		frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "error": map[string]any{"code": code, "message": "host request was rejected"}})
		_ = p.replyHost(frame, err)
	}()
	return nil
}

func (p *rpcProcess) hostRequestSlots() chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.hostRequests == nil {
		p.hostRequests = make(chan struct{}, 8)
	}
	return p.hostRequests
}

func (p *rpcProcess) hostHandler(method string) func(json.RawMessage) (json.RawMessage, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch method {
	case "host.log":
		return p.hostLog
	case "host.describe":
		return p.hostDescribe
	case "host.capability":
		return p.hostCapability
	default:
		return nil
	}
}
func (p *rpcProcess) replyHost(frame []byte, err error) error {
	if err != nil {
		return err
	}
	select {
	case p.outgoing <- append(frame, '\n'):
		return nil
	default:
		return fmt.Errorf("plugin host request rate exceeded")
	}
}
func (p *rpcProcess) readDiagnostics() {
	defer p.workers.Done()
	buffer := make([]byte, 4096)
	total := 0
	for {
		n, err := p.stderr.Read(buffer)
		total += n
		if n > 0 {
			p.keepStderr(buffer[:n])
		}
		if total > 1<<20 {
			p.fail(fmt.Errorf("plugin diagnostic output budget exceeded"))
			return
		}
		if err != nil {
			// exec.Cmd.Wait closes the parent pipe ends before it publishes the exit status, so a
			// closed stderr is the normal end of a crashed or stopped process; the wait worker owns
			// the reason in that case, mirroring the ErrClosed exemption in readProtocol above.
			if err != io.EOF && !errors.Is(err, os.ErrClosed) {
				p.fail(fmt.Errorf("plugin diagnostic stream failed"))
			}
			return
		}
	}
}
func (p *rpcProcess) writeProtocol() {
	defer p.workers.Done()
	for {
		select {
		case <-p.failed:
			return
		case frame := <-p.outgoing:
			if _, err := p.stdin.Write(frame); err != nil {
				p.fail(fmt.Errorf("plugin protocol write failed"))
				return
			}
		}
	}
}
