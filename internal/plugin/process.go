package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/logger"
)

const maxRPCBytes = 1 << 20
const maxPendingRPC = 64

type rpcResult struct {
	value json.RawMessage
	err   error
}

// rpcCallPolicy is optional; ordinary RPC calls retain their original behavior.
// maxRequestBytes widens only the outbound frame budget for the exact call that
// opts in, so host-managed image requests can exceed the ordinary RPC ceiling
// without relaxing it for any other method.
type rpcCallPolicy struct {
	maxRequestBytes  int
	maxResponseBytes int
	dispatchTimeout  time.Duration
	timeoutError     error
	settled          func()
	dispatched       func()
}

type rpcPending struct {
	reply    chan rpcResult
	policy   rpcCallPolicy
	watchdog *time.Timer
}

func (r rpcPending) settle() {
	if r.watchdog != nil {
		r.watchdog.Stop()
	}
	if r.policy.settled != nil {
		r.policy.settled()
	}
}

func (p rpcCallPolicy) settleUnsent() {
	if p.settled != nil {
		p.settled()
	}
}

type rpcProcess struct {
	cmd            *exec.Cmd
	tree           *processTree
	stdin          io.WriteCloser
	stdout         io.ReadCloser
	stderr         io.ReadCloser
	mu             sync.Mutex
	next           uint64
	pending        map[uint64]rpcPending
	terminal       error
	failed         chan struct{}
	done           chan struct{}
	outgoing       chan []byte
	workers        sync.WaitGroup
	hostLog        func(json.RawMessage) (json.RawMessage, error)
	hostDescribe   func(json.RawMessage) (json.RawMessage, error)
	hostCapability func(json.RawMessage) (json.RawMessage, error)
	// hostRequests bounds the callbacks the protocol reader may run in the background. They
	// left the read loop because a slow metadata/connection call would otherwise stop ping
	// responses from being consumed and get a healthy plugin quarantined by the watchdog.
	hostRequests  chan struct{}
	hostLogWindow time.Time
	hostLogCount  int
	stderrTail     []byte
	stopping       bool
}

// pluginStderrTailBytes bounds the diagnostic tail kept for a post-mortem. The stream itself is
// drained and discarded otherwise, so without this a fault carries no plugin-side evidence.
const pluginStderrTailBytes = 2048

func launchProcess(m Manifest, packageRoot, dataRoot string, proxyEnvironment func() []string) (*rpcProcess, error) {
	entry, err := selectEntry(m)
	if err != nil {
		return nil, err
	}
	executable := filepath.Join(packageRoot, filepath.FromSlash(entry.Executable))
	args := append([]string(nil), entry.Args...)
	switch entry.Runtime {
	case "node", "python":
		names := []string{"node"}
		if entry.Runtime == "python" {
			names = []string{"python3", "python"}
		}
		executable, err = findInterpreter(names)
		if err != nil {
			return nil, err
		}
		args = append([]string{filepath.Join(packageRoot, filepath.FromSlash(entry.Executable))}, args...)
	}
	cmd := exec.Command(executable, args...)
	cmd.Dir = dataRoot
	cmd.Env = processEnvironment(packageRoot, dataRoot, proxyEnvironment)
	p := &rpcProcess{cmd: cmd, pending: make(map[uint64]rpcPending), failed: make(chan struct{}), done: make(chan struct{}), outgoing: make(chan []byte, 64), hostRequests: make(chan struct{}, 8)} // Queue bounded to one frame per pending request.
	if p.stdin, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	if p.stdout, err = cmd.StdoutPipe(); err != nil {
		p.stdin.Close()
		return nil, err
	}
	if p.stderr, err = cmd.StderrPipe(); err != nil {
		p.stdin.Close()
		p.stdout.Close()
		return nil, err
	}
	p.tree, err = startProcessTree(cmd)
	if err != nil {
		p.stdin.Close()
		p.stdout.Close()
		p.stderr.Close()
		return nil, fmt.Errorf("start plugin process: %w", err)
	}
	p.workers.Add(3)
	go p.readProtocol()
	go p.readDiagnostics()
	go p.writeProtocol()
	go func() {
		err := cmd.Wait()
		if err == nil {
			err = errors.New("plugin process exited")
		}
		p.fail(fmt.Errorf("plugin process exited: %w", err))
		close(p.done)
	}()
	return p, nil
}
func selectEntry(m Manifest) (Entry, error) {
	if m.Backend == nil {
		return Entry{}, fmt.Errorf("plugin has no backend")
	}
	if e, ok := m.Backend.Platforms[runtime.GOOS+"/"+runtime.GOARCH]; ok {
		return e, nil
	}
	if m.Backend.Default != nil {
		return *m.Backend.Default, nil
	}
	return Entry{}, fmt.Errorf("plugin backend does not support this platform")
}
func findInterpreter(names []string) (string, error) {
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("required plugin interpreter is not installed")
}

// pluginEnvironmentAllowed lists the host process variables a plugin backend
// inherits. Application credentials, RPC tokens and interpreter injection
// variables stay excluded. Matching is case-insensitive because Windows variable
// names are.
var pluginEnvironmentAllowed = map[string]bool{
	"PATH": true, "SYSTEMROOT": true, "WINDIR": true,
	"TEMP": true, "TMP": true, "TMPDIR": true,
	"LANG": true, "LC_ALL": true,
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "ALL_PROXY": true, "NO_PROXY": true,
}

// pluginProxyEnvironmentAllowed bounds what the embedding host may inject, so an
// injected entry can never replace PATH, a credential or any other host variable.
var pluginProxyEnvironmentAllowed = map[string]bool{
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "ALL_PROXY": true, "NO_PROXY": true,
}

// processEnvironment merges the host environment with the proxy entries the
// embedding host injects for this launch. Injected entries win and duplicates
// collapse into one entry: POSIX getenv answers with the first match, so a plain
// append would keep the inherited value instead of the configured proxy.
func processEnvironment(packageRoot, dataRoot string, proxyEnvironment func() []string) []string {
	env := make([]string, 0, len(pluginEnvironmentAllowed)+len(pluginProxyEnvironmentAllowed)+3)
	position := make(map[string]int, len(pluginEnvironmentAllowed)+len(pluginProxyEnvironmentAllowed)+3)
	appendEntry := func(value string, allowed map[string]bool) {
		key, content, ok := strings.Cut(value, "=")
		if !ok || key == "" || content == "" || !allowed[strings.ToUpper(key)] {
			return
		}
		upper := strings.ToUpper(key)
		if previous, exists := position[upper]; exists {
			env[previous] = value
			return
		}
		position[upper] = len(env)
		env = append(env, value)
	}
	for _, value := range os.Environ() {
		appendEntry(value, pluginEnvironmentAllowed)
	}
	if proxyEnvironment != nil {
		for _, value := range proxyEnvironment() {
			appendEntry(value, pluginProxyEnvironmentAllowed)
		}
	}
	return append(env, "GONAVI_PLUGIN_PACKAGE="+packageRoot, "GONAVI_PLUGIN_DATA="+dataRoot, "PYTHONNOUSERSITE=1")
}
func (p *rpcProcess) fail(err error) { p.failPending(err, 0) }

// keepStderr retains the newest diagnostic bytes so a later fault can report them.
func (p *rpcProcess) keepStderr(chunk []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stderrTail = append(p.stderrTail, chunk...)
	if len(p.stderrTail) > pluginStderrTailBytes {
		p.stderrTail = append(p.stderrTail[:0], p.stderrTail[len(p.stderrTail)-pluginStderrTailBytes:]...)
	}
}

func (p *rpcProcess) failPending(err error, expectedID uint64) {
	p.mu.Lock()
	if p.terminal != nil {
		p.mu.Unlock()
		return
	}
	if expectedID != 0 {
		if _, ok := p.pending[expectedID]; !ok {
			p.mu.Unlock()
			return
		}
	}
	p.terminal = err
	close(p.failed)
	tail := ""
	if !p.stopping {
		tail = strings.TrimSpace(string(p.stderrTail))
	}
	pending := make([]rpcPending, 0, len(p.pending))
	for id, call := range p.pending {
		pending = append(pending, call)
		delete(p.pending, id)
	}
	p.mu.Unlock()
	if tail != "" {
		logger.Warnf("plugin diagnostics before failure (%v): %s", err, tail)
	}
	// Settlement callbacks never run under the transport lock.
	for _, call := range pending {
		call.settle()
		call.reply <- rpcResult{err: err}
	}
}
func (p *rpcProcess) failure() error { p.mu.Lock(); defer p.mu.Unlock(); return p.terminal }
func (p *rpcProcess) notify(method string, params any) {
	frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil || len(frame) > maxRPCBytes {
		return
	}
	select {
	case p.outgoing <- append(frame, '\n'):
	default:
	}
}
func (p *rpcProcess) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return p.callBounded(ctx, method, params, rpcCallPolicy{})
}

func (p *rpcProcess) callBounded(ctx context.Context, method string, params any, policy rpcCallPolicy) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		policy.settleUnsent()
		return nil, err
	}
	p.mu.Lock()
	if p.terminal != nil {
		err := p.terminal
		p.mu.Unlock()
		policy.settleUnsent()
		return nil, err
	}
	if len(p.pending) >= maxPendingRPC {
		p.mu.Unlock()
		policy.settleUnsent()
		return nil, ErrBusy
	}
	p.next++
	id := p.next
	reply := make(chan rpcResult, 1) // One response can arrive after the caller cancels.
	p.pending[id] = rpcPending{reply: reply, policy: policy}
	p.mu.Unlock()
	requestBytes := maxRPCBytes
	if policy.maxRequestBytes > requestBytes {
		requestBytes = policy.maxRequestBytes
	}
	frame, err := json.Marshal(struct {
		JSONRPC string `json:"jsonrpc"`
		ID      uint64 `json:"id"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}{"2.0", id, method, params})
	if err != nil || len(frame) > requestBytes {
		p.removePending(id)
		return nil, fmt.Errorf("plugin request is invalid or too large")
	}
	select {
	case p.outgoing <- append(frame, '\n'):
		if policy.dispatched != nil {
			policy.dispatched()
		}
		p.armReplyDeadline(id, policy)
	default:
		p.removePending(id)
		return nil, ErrBusy
	}
	select {
	case result := <-reply:
		return result.value, result.err
	case <-ctx.Done():
		cancelFrame, marshalErr := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "$/cancelRequest", "params": map[string]uint64{"id": id}})
		if marshalErr == nil {
			select {
			case p.outgoing <- append(cancelFrame, '\n'):
			default:
			}
		}
		// Keep canceled requests bounded and reserved until their response or process exit.
		return nil, ctx.Err()
	case <-p.failed:
		return nil, p.failure()
	}
}
func (p *rpcProcess) removePending(id uint64) {
	p.mu.Lock()
	call, ok := p.pending[id]
	delete(p.pending, id)
	p.mu.Unlock()
	if ok {
		call.settle()
	}
}
func (p *rpcProcess) stop(grace time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	p.mu.Lock()
	p.stopping = true
	p.mu.Unlock()
	if p.failure() == nil {
		p.call(ctx, "plugin.shutdown", struct{}{})
	}
	select {
	case <-p.done:
	case <-ctx.Done():
	case <-p.failed:
	}
	p.tree.kill()
	p.stdin.Close()
	p.stdout.Close()
	p.stderr.Close()
	p.fail(errors.New("plugin process stopped"))
	<-p.done
	p.workers.Wait()
	p.tree.close()
}
