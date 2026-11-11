package logger

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/appdata"
)

const (
	envLogDir     = "GONAVI_LOG_DIR"
	appHiddenDir  = ".GoNavi"
	appLogDirName = "Logs"

	logFileName         = "gonavi.log"
	logRotateMaxBytes   = 10 * 1024 * 1024 // 10MB
	logRotateMaxBackups = 10
	logSyncInterval     = 500 * time.Millisecond
	logSyncQueueSize    = 1
)

var (
	once         sync.Once
	logMu        sync.Mutex
	logInst      *log.Logger
	logFile      writeSyncCloser
	logFlusher   *syncWorker
	logCloseDone chan struct{}
	logPath      string
)

type writeSyncCloser interface {
	io.Writer
	Sync() error
	Close() error
}

// syncWorker batches durability barriers away from logging call sites. The
// single-slot queue deliberately coalesces duplicate requests: a pending Sync
// already covers every write completed before it runs, so growing the queue
// would only add redundant disk stalls.
type syncWorker struct {
	sink      writeSyncCloser
	requests  chan struct{}
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	dirty     atomic.Bool
}

func newSyncWorker(sink writeSyncCloser, interval time.Duration) *syncWorker {
	if sink == nil {
		return nil
	}
	if interval <= 0 {
		interval = logSyncInterval
	}
	worker := &syncWorker{
		sink:     sink,
		requests: make(chan struct{}, logSyncQueueSize),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go worker.run(interval)
	return worker
}

func (w *syncWorker) request() {
	if w == nil {
		return
	}
	w.markDirty()
	select {
	case w.requests <- struct{}{}:
	default:
		// Overflow policy: coalesce with the already pending durability barrier.
	}
}

func (w *syncWorker) markDirty() {
	if w != nil {
		w.dirty.Store(true)
	}
}

func (w *syncWorker) syncIfDirty() {
	if w != nil && w.dirty.Swap(false) {
		_ = w.sink.Sync()
	}
}

func (w *syncWorker) close() {
	if w == nil {
		return
	}
	w.closeOnce.Do(func() {
		close(w.stop)
		<-w.done
	})
}

func (w *syncWorker) run(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	defer close(w.done)

	for {
		select {
		case <-w.requests:
			w.syncIfDirty()
		case <-ticker.C:
			w.syncIfDirty()
		case <-w.stop:
			// Close is the durability boundary: all file writes have stopped before
			// the worker is closed, so this final Sync covers the complete log.
			_ = w.sink.Sync()
			_ = w.sink.Close()
			return
		}
	}
}

func Init() {
	once.Do(func() {
		path, out := initOutput()
		logMu.Lock()
		defer logMu.Unlock()
		logPath = path
		logInst = log.New(out, "", log.Ldate|log.Ltime|log.Lmicroseconds)
		logInst.Printf("[INFO] 日志初始化完成，日志文件：%s", logPath)
		logFlusher = newSyncWorker(logFile, logSyncInterval)
		logFlusher.markDirty()
	})
}

func Path() string {
	Init()
	logMu.Lock()
	defer logMu.Unlock()
	return logPath
}

func DefaultDirectory() string {
	return defaultLogDir()
}

func ConfiguredDirectory() (string, bool) {
	if directory := strings.TrimSpace(os.Getenv(envLogDir)); directory != "" {
		if abs, err := filepath.Abs(directory); err == nil {
			directory = filepath.Clean(abs)
		}
		return directory, true
	}
	if directory, err := appdata.ResolveConfiguredLogDirectory(); err == nil && directory != "" {
		return directory, false
	}
	return defaultLogDir(), false
}

func Close() {
	Init()
	logMu.Lock()
	if logCloseDone != nil {
		done := logCloseDone
		logMu.Unlock()
		<-done
		return
	}
	if logInst != nil {
		logInst.SetOutput(os.Stderr)
	}
	worker := logFlusher
	sink := logFile
	logFlusher = nil
	logFile = nil
	if worker == nil && sink == nil {
		logMu.Unlock()
		return
	}
	done := make(chan struct{})
	logCloseDone = done
	logMu.Unlock()
	defer func() {
		logMu.Lock()
		if logCloseDone == done {
			logCloseDone = nil
			close(done)
		}
		logMu.Unlock()
	}()

	if worker != nil {
		worker.close()
		return
	}
	// Defensive compatibility for a sink installed without a worker.
	if sink != nil {
		_ = sink.Sync()
		_ = sink.Close()
	}
}

func Infof(format string, args ...any) {
	printf("INFO", format, args...)
}

func Warnf(format string, args ...any) {
	printf("WARN", format, args...)
}

func Errorf(format string, args ...any) {
	printf("ERROR", format, args...)
}

func Error(err error, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if err == nil {
		Errorf("%s", msg)
		return
	}
	Errorf("%s；错误链：%s", msg, ErrorChain(err))
}

// isErrorTextAlreadyCovered 判断一段错误文本是否已经被前面某一层完整包含。
//
// 只对足够长的文本做包含判断：短文本（如 "EOF"、""）容易误伤，宁可重复也不
// 丢掉有意义的一行。
func isErrorTextAlreadyCovered(existing []string, candidate string) bool {
	const minCoverableLength = 12
	if len(candidate) < minCoverableLength {
		return false
	}
	for _, part := range existing {
		if part == candidate || strings.Contains(part, candidate) {
			return true
		}
	}
	return false
}

func ErrorChain(err error) string {
	if err == nil {
		return ""
	}

	var parts []string
	cur := err
	truncated := false
	for i := 0; cur != nil && i < 20; i++ {
		s := cur.Error()
		// 汇总型错误（connectAttemptError 等）的消息里已经内嵌了 cause 的完整
		// 文本，只做整串相等去重仍会把同一段错误打印两遍。这里再跳过「已经被
		// 前面某条消息包含」的层。
		if !isErrorTextAlreadyCovered(parts, s) {
			parts = append(parts, s)
		}
		cur = errors.Unwrap(cur)
	}
	if cur != nil {
		truncated = true
	}

	if len(parts) == 0 {
		return err.Error()
	}
	if truncated {
		parts = append(parts, "（错误链过长，已截断）")
	}
	return strings.Join(parts, " -> ")
}

func printf(level string, format string, args ...any) {
	Init()
	message := fmt.Sprintf(format, args...)
	logMu.Lock()
	inst := logInst
	if inst == nil {
		logMu.Unlock()
		return
	}
	inst.Printf("[%s] %s", level, message)
	flusher := logFlusher
	flusher.markDirty()
	logMu.Unlock()

	if level == "ERROR" && flusher != nil {
		// Error logs ask the worker to Sync immediately, but the caller never
		// waits for the disk. Repeated errors are coalesced by the bounded queue.
		flusher.request()
	}
}

func initOutput() (string, io.Writer) {
	dir, _ := ConfiguredDirectory()

	if path, writer, ok := openLogFile(dir); ok {
		return path, writer
	}
	defaultDir := defaultLogDir()
	if filepath.Clean(dir) != filepath.Clean(defaultDir) {
		if path, writer, ok := openLogFile(defaultDir); ok {
			return path, writer
		}
	}

	fallbackDir := filepath.Join(os.TempDir(), appHiddenDir, appLogDirName)
	if path, writer, ok := openLogFile(fallbackDir); ok {
		return path, writer
	}

	return "", os.Stderr
}

func defaultLogDir() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return filepath.Join(os.TempDir(), appHiddenDir, appLogDirName)
	}
	return filepath.Join(home, appHiddenDir, appLogDirName)
}

func openLogFile(dir string) (string, io.Writer, bool) {
	if strings.TrimSpace(dir) == "" {
		return "", nil, false
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", nil, false
	}
	path := filepath.Join(dir, logFileName)
	rotateIfNeeded(path, dir)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return "", nil, false
	}
	logFile = f
	return path, f, true
}

func rotateIfNeeded(path, dir string) {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return
	}
	if fi.Size() < logRotateMaxBytes {
		return
	}

	ts := time.Now().Format("20060102-150405")
	rotated := filepath.Join(dir, fmt.Sprintf("gonavi-%s.log", ts))
	if err := os.Rename(path, rotated); err != nil {
		return
	}
	cleanupOldLogs(dir)
}

func cleanupOldLogs(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}

	type item struct {
		name string
		path string
	}
	var logs []item
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "gonavi-") || !strings.HasSuffix(name, ".log") {
			continue
		}
		logs = append(logs, item{name: name, path: filepath.Join(dir, name)})
	}

	sort.Slice(logs, func(i, j int) bool { return logs[i].name > logs[j].name })
	if len(logs) <= logRotateMaxBackups {
		return
	}
	for _, it := range logs[logRotateMaxBackups:] {
		_ = os.Remove(it.path)
	}
}
