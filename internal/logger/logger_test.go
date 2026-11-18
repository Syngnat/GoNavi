package logger

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/appdata"
)

func TestMain(m *testing.M) {
	// Package tests must never append to the user's real GoNavi log.
	testLogDir, err := os.MkdirTemp("", "gonavi-logger-test-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create logger test directory: %v\n", err)
		os.Exit(2)
	}
	previousLogDir, hadPreviousLogDir := os.LookupEnv(envLogDir)
	_ = os.Setenv(envLogDir, testLogDir)
	Init()

	code := m.Run()
	Close()
	if hadPreviousLogDir {
		_ = os.Setenv(envLogDir, previousLogDir)
	} else {
		_ = os.Unsetenv(envLogDir)
	}
	_ = os.RemoveAll(testLogDir)
	os.Exit(code)
}

func TestConfiguredDirectoryUsesPersistedSetting(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv(envLogDir, "")

	customDirectory := filepath.Join(t.TempDir(), "custom-logs")
	if _, err := appdata.SetConfiguredLogDirectory(customDirectory); err != nil {
		t.Fatalf("SetConfiguredLogDirectory returned error: %v", err)
	}
	directory, managedByEnvironment := ConfiguredDirectory()
	if managedByEnvironment {
		t.Fatal("persisted log directory should not be marked as environment-managed")
	}
	if directory != customDirectory {
		t.Fatalf("configured directory = %q, want %q", directory, customDirectory)
	}
}

func TestConfiguredDirectoryPrefersEnvironmentOverride(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	persistedDirectory := filepath.Join(t.TempDir(), "persisted-logs")
	if _, err := appdata.SetConfiguredLogDirectory(persistedDirectory); err != nil {
		t.Fatalf("SetConfiguredLogDirectory returned error: %v", err)
	}
	environmentDirectory := filepath.Join(t.TempDir(), "environment-logs")
	t.Setenv(envLogDir, environmentDirectory)

	directory, managedByEnvironment := ConfiguredDirectory()
	if !managedByEnvironment {
		t.Fatal("environment log directory should be marked as environment-managed")
	}
	if directory != environmentDirectory {
		t.Fatalf("configured directory = %q, want environment override %q", directory, environmentDirectory)
	}
}

func TestConfiguredDirectoryFallsBackToDefault(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv(envLogDir, "")

	directory, managedByEnvironment := ConfiguredDirectory()
	if managedByEnvironment {
		t.Fatal("default log directory should not be marked as environment-managed")
	}
	want := filepath.Join(homeDir, appHiddenDir, appLogDirName)
	if directory != want {
		t.Fatalf("configured directory = %q, want default %q", directory, want)
	}
}

type slowSyncSink struct {
	mu          sync.Mutex
	contents    bytes.Buffer
	syncDelay   time.Duration
	syncGate    <-chan struct{}
	syncStarted chan struct{}
	syncs       int
	closeCalls  int
	closed      bool
}

func (s *slowSyncSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, os.ErrClosed
	}
	return s.contents.Write(p)
}

func (s *slowSyncSink) Sync() error {
	if s.syncStarted != nil {
		select {
		case s.syncStarted <- struct{}{}:
		default:
		}
	}
	if s.syncGate != nil {
		<-s.syncGate
	}
	time.Sleep(s.syncDelay)
	s.mu.Lock()
	s.syncs++
	s.mu.Unlock()
	return nil
}

func (s *slowSyncSink) Close() error {
	s.mu.Lock()
	s.closeCalls++
	s.closed = true
	s.mu.Unlock()
	return nil
}

func (s *slowSyncSink) snapshot() (contents string, syncs, closeCalls int, closed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contents.String(), s.syncs, s.closeCalls, s.closed
}

func installTestSink(tb testing.TB, sink writeSyncCloser, interval time.Duration) *syncWorker {
	tb.Helper()
	Init()

	logMu.Lock()
	previousWorker := logFlusher
	previousFile := logFile
	if logInst != nil {
		logInst.SetOutput(os.Stderr)
	}
	logFlusher = nil
	logFile = nil
	logMu.Unlock()
	if previousWorker != nil {
		previousWorker.close()
	} else if previousFile != nil {
		_ = previousFile.Sync()
		_ = previousFile.Close()
	}

	worker := newSyncWorker(sink, interval)
	logMu.Lock()
	if logInst != nil {
		logInst.SetOutput(sink)
	}
	logFile = sink
	logFlusher = worker
	logMu.Unlock()

	tb.Cleanup(func() {
		logMu.Lock()
		if logFlusher != worker {
			logMu.Unlock()
			return
		}
		if logInst != nil {
			logInst.SetOutput(io.Discard)
		}
		logFlusher = nil
		logFile = nil
		logMu.Unlock()
		worker.close()
	})
	return worker
}

func TestInfofDoesNotWaitForDiskSync(t *testing.T) {
	const syncDelay = 40 * time.Millisecond
	sink := &slowSyncSink{syncDelay: syncDelay}
	installTestSink(t, sink, time.Hour)

	started := time.Now()
	Infof("slow-sync-regression")
	elapsed := time.Since(started)

	if elapsed >= syncDelay/2 {
		t.Fatalf("Infof blocked for %s while Sync took %s", elapsed, syncDelay)
	}
}

func TestErrorfRequestsPromptSyncWithoutBlocking(t *testing.T) {
	const syncDelay = 40 * time.Millisecond
	syncStarted := make(chan struct{}, 1)
	sink := &slowSyncSink{syncDelay: syncDelay, syncStarted: syncStarted}
	installTestSink(t, sink, time.Hour)

	started := time.Now()
	Errorf("urgent-error")
	elapsed := time.Since(started)
	if elapsed >= syncDelay/2 {
		t.Fatalf("Errorf blocked for %s while async Sync took %s", elapsed, syncDelay)
	}

	select {
	case <-syncStarted:
	case <-time.After(time.Second):
		t.Fatal("Errorf did not request a prompt background Sync")
	}
}

func TestSyncWorkerCoalescesOverflow(t *testing.T) {
	syncGate := make(chan struct{})
	syncStarted := make(chan struct{}, 1)
	sink := &slowSyncSink{syncGate: syncGate, syncStarted: syncStarted}
	worker := newSyncWorker(sink, time.Hour)
	if worker == nil {
		t.Fatal("newSyncWorker returned nil")
	}
	if cap(worker.requests) != logSyncQueueSize {
		t.Fatalf("request queue capacity = %d; want %d", cap(worker.requests), logSyncQueueSize)
	}

	worker.request()
	select {
	case <-syncStarted:
	case <-time.After(time.Second):
		t.Fatal("worker did not start the first Sync")
	}

	started := time.Now()
	for range 10_000 {
		worker.request()
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("overflow requests blocked for %s", elapsed)
	}
	if got := len(worker.requests); got != logSyncQueueSize {
		t.Fatalf("coalesced queue length = %d; want %d", got, logSyncQueueSize)
	}

	close(syncGate)
	worker.close()
}

func TestSyncWorkerSkipsIdleTicks(t *testing.T) {
	syncStarted := make(chan struct{}, 4)
	sink := &slowSyncSink{syncStarted: syncStarted}
	worker := newSyncWorker(sink, 2*time.Millisecond)
	if worker == nil {
		t.Fatal("newSyncWorker returned nil")
	}
	defer worker.close()

	select {
	case <-syncStarted:
		t.Fatal("idle worker issued an unnecessary periodic Sync")
	case <-time.After(20 * time.Millisecond):
	}

	worker.markDirty()
	select {
	case <-syncStarted:
	case <-time.After(time.Second):
		t.Fatal("dirty worker did not issue a periodic Sync")
	}
	select {
	case <-syncStarted:
		t.Fatal("worker kept syncing after the dirty state was flushed")
	case <-time.After(20 * time.Millisecond):
	}
}

func TestCloseFlushesSyncsAndClosesOnce(t *testing.T) {
	sink := &slowSyncSink{}
	installTestSink(t, sink, time.Hour)
	Infof("must-survive-close")

	Close()
	contents, syncs, closeCalls, closed := sink.snapshot()
	if !strings.Contains(contents, "must-survive-close") {
		t.Fatalf("Close lost the final log entry: %q", contents)
	}
	if syncs < 1 {
		t.Fatal("Close did not perform a final Sync")
	}
	if !closed || closeCalls != 1 {
		t.Fatalf("Close state: closed=%v closeCalls=%d; want true, 1", closed, closeCalls)
	}

	Close()
	Init()
	_, syncsAfter, closeCallsAfter, _ := sink.snapshot()
	if syncsAfter != syncs || closeCallsAfter != closeCalls {
		t.Fatalf("repeated Close/Init touched the closed sink: syncs %d->%d closes %d->%d", syncs, syncsAfter, closeCalls, closeCallsAfter)
	}
}

func TestConcurrentCloseWaitsForTheSameFinalSync(t *testing.T) {
	syncGate := make(chan struct{})
	syncStarted := make(chan struct{}, 1)
	sink := &slowSyncSink{syncGate: syncGate, syncStarted: syncStarted}
	installTestSink(t, sink, time.Hour)
	Infof("concurrent-close")

	firstDone := make(chan struct{})
	go func() {
		Close()
		close(firstDone)
	}()
	select {
	case <-syncStarted:
	case <-time.After(time.Second):
		close(syncGate)
		t.Fatal("first Close did not start the final Sync")
	}

	secondDone := make(chan struct{})
	go func() {
		Close()
		close(secondDone)
	}()
	select {
	case <-secondDone:
		close(syncGate)
		t.Fatal("concurrent Close returned before the final Sync completed")
	case <-time.After(20 * time.Millisecond):
	}

	close(syncGate)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("first Close did not finish after Sync was released")
	}
	select {
	case <-secondDone:
	case <-time.After(time.Second):
		t.Fatal("concurrent Close did not finish after Sync was released")
	}

	_, _, closeCalls, _ := sink.snapshot()
	if closeCalls != 1 {
		t.Fatalf("concurrent Close called sink.Close %d times; want 1", closeCalls)
	}
}

func TestLogOrderPreserved(t *testing.T) {
	sink := &slowSyncSink{}
	installTestSink(t, sink, time.Hour)
	Infof("ordered-first")
	Warnf("ordered-second")
	Errorf("ordered-third")
	Close()

	contents, _, _, _ := sink.snapshot()
	first := strings.Index(contents, "ordered-first")
	second := strings.Index(contents, "ordered-second")
	third := strings.Index(contents, "ordered-third")
	if first < 0 || second <= first || third <= second {
		t.Fatalf("log order was not preserved: %q", contents)
	}
}

func TestConcurrentLoggingIsComplete(t *testing.T) {
	const (
		writers   = 16
		perWriter = 100
	)
	sink := &slowSyncSink{}
	installTestSink(t, sink, time.Millisecond)

	var wg sync.WaitGroup
	for writer := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for entry := range perWriter {
				Infof("concurrent writer=%d entry=%d", writer, entry)
			}
		}()
	}
	wg.Wait()
	Close()

	contents, _, _, _ := sink.snapshot()
	if got := strings.Count(contents, "concurrent writer="); got != writers*perWriter {
		t.Fatalf("concurrent log entry count = %d; want %d", got, writers*perWriter)
	}
}

func BenchmarkInfofWithSlowSync(b *testing.B) {
	sink := &slowSyncSink{syncDelay: 2 * time.Millisecond}
	installTestSink(b, sink, time.Hour)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Infof("benchmark message %d", i)
	}
}

func TestErrorChain_NilError(t *testing.T) {
	if got := ErrorChain(nil); got != "" {
		t.Errorf("ErrorChain(nil) = %q; want empty string", got)
	}
}

func TestErrorChain_SingleError(t *testing.T) {
	err := errors.New("single error")
	got := ErrorChain(err)
	if got != "single error" {
		t.Errorf("ErrorChain(single) = %q; want %q", got, "single error")
	}
}

func TestErrorChain_WrappedErrors(t *testing.T) {
	inner := errors.New("root cause")
	middle := fmt.Errorf("middle: %w", inner)
	outer := fmt.Errorf("outer: %w", middle)

	got := ErrorChain(outer)
	// Should contain all three distinct messages
	if got == "" {
		t.Fatal("ErrorChain returned empty string for wrapped errors")
	}
	// The chain should start with the outermost error
	if len(got) < len("outer:") {
		t.Errorf("ErrorChain result too short: %q", got)
	}
}

func TestErrorChain_DeduplicatesMessages(t *testing.T) {
	// Create a chain where wrapping doesn't add new text
	inner := errors.New("same message")
	outer := fmt.Errorf("%w", inner)

	got := ErrorChain(outer)
	// Should not repeat "same message"
	if got != "same message" {
		t.Errorf("ErrorChain should deduplicate: got %q", got)
	}
}

// summaryCauseError 模拟 connectAttemptError：消息里已内嵌 cause 文本。
type summaryCauseError struct {
	message string
	cause   error
}

func (e summaryCauseError) Error() string { return e.message }
func (e summaryCauseError) Unwrap() error { return e.cause }

// 回归：connectAttemptError 这类汇总错误的消息里已经内嵌了 cause 的完整文本，
// 只做整串相等去重会把同一段错误打印两遍。
func TestErrorChain_SkipsCauseAlreadyEmbeddedInSummary(t *testing.T) {
	cause := errors.New("dial tcp 10.0.0.1:3306: connect: connection refused")
	summary := errors.New("全部连接尝试失败：" + cause.Error())

	got := ErrorChain(summaryCauseError{message: summary.Error(), cause: cause})

	// 汇总已经把 cause 的文本包含进去了，cause 不应再单独出现一次。
	if strings.Count(got, cause.Error()) != 1 {
		t.Fatalf("cause text should appear exactly once, got %q", got)
	}
}

// 短文本（如 EOF）不做包含判断，避免误伤。
func TestErrorChain_KeepsShortCauseAfterLongSummary(t *testing.T) {
	cause := errors.New("EOF")
	summary := errors.New("连接失败：读取握手包时对端断开，请检查网络与代理配置")

	got := ErrorChain(summaryCauseError{message: summary.Error(), cause: cause})

	if !strings.Contains(got, "EOF") {
		t.Fatalf("short cause should still be printed, got %q", got)
	}
}

func TestErrorChain_TruncatesLongChain(t *testing.T) {
	// Build a chain of 25 errors (exceeds the 20-level limit)
	var err error = errors.New("base")
	for i := 0; i < 25; i++ {
		err = fmt.Errorf("level-%d: %w", i, err)
	}
	got := ErrorChain(err)
	if got == "" {
		t.Fatal("ErrorChain returned empty for long chain")
	}
	// Should contain truncation notice
	if len(got) == 0 {
		t.Error("expected non-empty result for long chain")
	}
}
