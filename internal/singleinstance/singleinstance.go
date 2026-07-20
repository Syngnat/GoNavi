// Package singleinstance 提供跨平台主进程单实例约束与次实例激活转发。
//
// 设计目标：
//  1. 同一用户会话中只允许一个 GoNavi 主 GUI 进程
//  2. 第二个主进程启动时，把启动参数转发给已运行主实例后退出
//  3. detached-window / mcp-server 等特殊模式不使用本包
//
// 平台实现：
//   - Windows: 命名互斥体
//   - macOS/Linux: flock 锁文件（路径固定，不依赖 XDG_RUNTIME_DIR/TMPDIR）
//
// IPC 统一使用 TCP 回环 + endpoint 文件，避免命名管道/Unix Socket 差异。
package singleinstance

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultName           = "gonavi"
	notifyRetryWindow     = 3 * time.Second
	notifyAttemptTimeout  = 250 * time.Millisecond
	notifyRetryInterval   = 50 * time.Millisecond
	activationReadTimeout = 3 * time.Second
)

// ActivationMessage 是次实例发给主实例的激活载荷。
type ActivationMessage struct {
	Args []string `json:"args"`
}

// AcquireResult 描述单实例获取结果。
type AcquireResult struct {
	// Acquired 为 true 表示当前进程成为主实例。
	Acquired bool
	// Handle 仅在 Acquired=true 时有效。
	Handle *Handle
	// AcquireErr 表示锁本身获取失败（非“已被占用”）。
	AcquireErr error
	// NotifyErr 表示次实例通知主实例失败。
	NotifyErr error
}

// Handle 表示主实例持有的锁与 IPC 服务端。
type Handle struct {
	lock     platformLock
	listener net.Listener
	mu       sync.Mutex
	closed   bool
	wg       sync.WaitGroup
}

// ActivationHandler 处理次实例激活请求。
type ActivationHandler func(message ActivationMessage) error

// Logger 由宿主注入，避免循环依赖。
type Logger interface {
	Infof(format string, args ...any)
	Warnf(format string, args ...any)
}

type stderrLogger struct{}

func (stderrLogger) Infof(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[singleinstance] "+format+"\n", args...)
}

func (stderrLogger) Warnf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[singleinstance] WARN "+format+"\n", args...)
}

var (
	packageLogger Logger = stderrLogger{}
	// platformAcquireLock 可在测试中替换。
	platformAcquireLock = acquireLock
)

// SetLogger 注入宿主日志实现。
func SetLogger(logger Logger) {
	if logger == nil {
		packageLogger = stderrLogger{}
		return
	}
	packageLogger = logger
}

// Acquire 尝试成为主实例。
//
//   - 成功：Acquired=true，调用方应 Listen 并在退出时 Close
//   - 锁已被占用：尝试通知主实例后 Acquired=false
//   - 锁初始化失败：Acquired=false 且 AcquireErr 非空（调用方应终止 GUI 启动）
func Acquire(name string, args []string) AcquireResult {
	name = normalizeName(name)
	lock, err := platformAcquireLock(name)
	if err != nil {
		if isLockHeldError(err) {
			notifyErr := notifyPrimaryWithRetry(name, ActivationMessage{Args: append([]string(nil), args...)})
			return AcquireResult{Acquired: false, NotifyErr: notifyErr}
		}
		return AcquireResult{
			Acquired:   false,
			AcquireErr: fmt.Errorf("acquire single-instance lock %q: %w", name, err),
		}
	}
	return AcquireResult{
		Acquired: true,
		Handle:   &Handle{lock: lock},
	}
}

// Listen 启动主实例 IPC 服务端。应在拿到主实例锁后尽快调用。
func (h *Handle) Listen(name string, handler ActivationHandler) error {
	if h == nil {
		return errors.New("nil single-instance handle")
	}
	if handler == nil {
		return errors.New("nil activation handler")
	}
	name = normalizeName(name)

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return errors.New("single-instance handle already closed")
	}
	if h.listener != nil {
		return nil
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen single-instance ipc: %w", err)
	}
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return fmt.Errorf("unexpected single-instance listener address type %T", listener.Addr())
	}
	if err := writeEndpoint(name, addr.Port); err != nil {
		_ = listener.Close()
		return err
	}
	h.listener = listener
	h.wg.Add(1)
	go h.serve(handler)
	return nil
}

// Close 释放锁并关闭 IPC。
func (h *Handle) Close() error {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil
	}
	h.closed = true
	listener := h.listener
	h.listener = nil
	lock := h.lock
	h.lock = nil
	h.mu.Unlock()

	if listener != nil {
		_ = listener.Close()
	}
	h.wg.Wait()

	var firstErr error
	if lock != nil {
		if err := lock.Release(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (h *Handle) serve(handler ActivationHandler) {
	defer h.wg.Done()
	for {
		h.mu.Lock()
		listener := h.listener
		closed := h.closed
		h.mu.Unlock()
		if closed || listener == nil {
			return
		}
		conn, err := listener.Accept()
		if err != nil {
			if closed || errors.Is(err, net.ErrClosed) {
				return
			}
			packageLogger.Warnf("single-instance accept failed: %v", err)
			continue
		}
		h.wg.Add(1)
		go func(c net.Conn) {
			defer h.wg.Done()
			h.handleConn(c, handler)
		}(conn)
	}
}

func (h *Handle) handleConn(conn net.Conn, handler ActivationHandler) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(activationReadTimeout))
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		packageLogger.Warnf("single-instance read failed: %v", err)
		return
	}
	line = bytesTrimSpace(line)
	if len(line) == 0 {
		return
	}
	var message ActivationMessage
	if err := json.Unmarshal(line, &message); err != nil {
		packageLogger.Warnf("single-instance decode failed: %v", err)
		return
	}
	if err := handler(message); err != nil {
		packageLogger.Warnf("single-instance handler failed: %v", err)
	}
}

func notifyPrimaryWithRetry(name string, message ActivationMessage) error {
	deadline := time.Now().Add(notifyRetryWindow)
	var lastErr error
	for {
		lastErr = notifyPrimary(name, message)
		if lastErr == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return lastErr
		}
		time.Sleep(notifyRetryInterval)
	}
}

func notifyPrimary(name string, message ActivationMessage) error {
	port, err := readEndpoint(name)
	if err != nil {
		return err
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), notifyAttemptTimeout)
	if err != nil {
		return fmt.Errorf("dial primary instance: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(notifyAttemptTimeout))
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("write activation message: %w", err)
	}
	return nil
}

func normalizeName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return defaultName
	}
	// 仅保留文件名安全字符，避免路径穿越。
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return defaultName
	}
	return b.String()
}

func endpointFileName(name string) string {
	return normalizeName(name) + ".endpoint"
}

func endpointFilePath(name string) string {
	return filepath.Join(runtimeDir(), endpointFileName(name))
}

func endpointCandidatePaths(name string) []string {
	fileName := endpointFileName(name)
	seen := make(map[string]struct{})
	var paths []string
	add := func(dir string) {
		if dir == "" {
			return
		}
		path := filepath.Join(dir, fileName)
		if _, ok := seen[path]; ok {
			return
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	// 当前进程选中的可写目录优先。
	add(runtimeDir())
	if override := strings.TrimSpace(os.Getenv("GONAVI_RUNTIME_DIR")); override != "" {
		add(override)
	}
	for _, dir := range candidateRuntimeDirs() {
		add(dir)
	}
	return paths
}

func writeEndpoint(name string, port int) error {
	path := endpointFilePath(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create single-instance runtime dir: %w", err)
	}
	content := []byte(strconv.Itoa(port) + "\n")
	if err := writeFileAtomic(path, content, 0o600); err != nil {
		return fmt.Errorf("write single-instance endpoint: %w", err)
	}
	return nil
}

func writeFileAtomic(path string, content []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".endpoint-*.tmp")
	if err != nil {
		// CreateTemp 失败时退回直接写入（例如目录权限异常时给出原始错误）。
		return os.WriteFile(path, content, perm)
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		// Windows 上 Chmod 可能无效，忽略。
		_ = err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		// Windows 上目标已存在时 rename 可能失败，尝试覆盖。
		_ = os.Remove(path)
		if err2 := os.Rename(tmpName, path); err2 != nil {
			return err2
		}
	}
	cleanup = false
	return nil
}

func readEndpoint(name string) (int, error) {
	var lastErr error
	for _, path := range endpointCandidatePaths(name) {
		data, err := os.ReadFile(path)
		if err != nil {
			lastErr = err
			continue
		}
		port, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err != nil || port <= 0 || port > 65535 {
			lastErr = fmt.Errorf("invalid single-instance endpoint content %q", strings.TrimSpace(string(data)))
			continue
		}
		return port, nil
	}
	if lastErr == nil {
		lastErr = os.ErrNotExist
	}
	return 0, fmt.Errorf("read single-instance endpoint: %w", lastErr)
}

func removeEndpoint(name string) {
	for _, path := range endpointCandidatePaths(name) {
		_ = os.Remove(path)
	}
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}

// platformLock 是各平台锁抽象。
type platformLock interface {
	Release() error
}

// lockHeldError 表示锁已被其他进程持有。
type lockHeldError struct {
	name string
}

func (e *lockHeldError) Error() string {
	return fmt.Sprintf("single-instance lock already held: %s", e.name)
}

func isLockHeldError(err error) bool {
	var held *lockHeldError
	return errors.As(err, &held)
}

var (
	runtimeDirOnce   sync.Once
	runtimeDirCached string
)

// runtimeDir 返回跨启动器稳定的运行时目录。
// 优先固定用户目录，避免 macOS Finder 与终端因 TMPDIR 不同而分裂；
// 若当前环境不可写（沙箱/权限），自动回退到可写位置。
// 进程内缓存，保证 Listen/notify/Close 使用同一目录。
func runtimeDir() string {
	runtimeDirOnce.Do(func() {
		if override := strings.TrimSpace(os.Getenv("GONAVI_RUNTIME_DIR")); override != "" {
			_ = os.MkdirAll(override, 0o700)
			runtimeDirCached = override
			return
		}
		runtimeDirCached = ensureWritableRuntimeDir()
	})
	return runtimeDirCached
}

func candidateRuntimeDirs() []string {
	var dirs []string
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		dirs = append(dirs, filepath.Join(home, ".gonavi", "runtime"))
	}
	if local := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); local != "" {
		dirs = append(dirs, filepath.Join(local, "GoNavi", "runtime"))
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_CACHE_HOME")); xdg != "" {
		dirs = append(dirs, filepath.Join(xdg, "gonavi", "runtime"))
	}
	dirs = append(dirs, filepath.Join(os.TempDir(), "gonavi-runtime"))
	return dirs
}

func ensureWritableRuntimeDir() string {
	for _, dir := range candidateRuntimeDirs() {
		if dir == "" {
			continue
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			continue
		}
		probe := filepath.Join(dir, ".write-probe-"+strconv.FormatInt(time.Now().UnixNano(), 36))
		if err := os.WriteFile(probe, []byte("1"), 0o600); err != nil {
			continue
		}
		_ = os.Remove(probe)
		return dir
	}
	// 最后兜底：即使探测失败也返回 TempDir 路径，让调用方拿到明确错误。
	return filepath.Join(os.TempDir(), "gonavi-runtime")
}
