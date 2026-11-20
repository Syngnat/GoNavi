package scriptengine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultKillGrace = 2 * time.Second
	maxStderrBytes   = 64 << 10
)

// Runner starts the hidden worker mode from the current GoNavi executable.
type Runner struct {
	Executable       string
	WorkingDirectory string
	Env              []string
	KillGrace        time.Duration
}

// Run executes one script and services host requests until the worker exits.
func (r Runner) Run(
	ctx context.Context,
	request RunRequest,
	host Host,
	observe Observer,
) RunResult {
	startedAt := time.Now()
	if ctx == nil {
		ctx = context.Background()
	}
	if host == nil {
		return RunResult{Success: false, Message: "script host is unavailable"}
	}
	if err := ctx.Err(); err != nil {
		return cancellationResult(startedAt, err)
	}
	request.Limits = NormalizeLimits(request.Limits, request.Limits.Timeout)
	executable := strings.TrimSpace(r.Executable)
	if executable == "" {
		var err error
		executable, err = os.Executable()
		if err != nil {
			return RunResult{Success: false, Message: err.Error()}
		}
	}
	command := exec.Command(executable, WorkerModeArg)
	if r.WorkingDirectory != "" {
		command.Dir = r.WorkingDirectory
	}
	if len(r.Env) > 0 {
		command.Env = append(os.Environ(), r.Env...)
	}
	prepareWorkerCommand(command)

	stdin, err := command.StdinPipe()
	if err != nil {
		return RunResult{Success: false, Message: err.Error()}
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return RunResult{Success: false, Message: err.Error()}
	}
	stderr := &limitedBuffer{limit: maxStderrBytes}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return RunResult{Success: false, Message: err.Error()}
	}
	if err := attachWorkerJob(command, request.Limits.MemoryLimitBytes); err != nil {
		terminateWorkerProcess(command)
		_ = command.Wait()
		return RunResult{Success: false, Message: fmt.Sprintf("attach script worker job: %v", err)}
	}
	defer releaseWorkerJob(command)
	var memoryExceeded atomic.Bool
	stopMemoryWatch := startWorkerMemoryWatch(
		command.Process.Pid,
		request.Limits.MemoryLimitBytes,
		func() {
			memoryExceeded.Store(true)
			terminateWorkerProcess(command)
		},
	)
	defer stopMemoryWatch()

	var writeMu sync.Mutex
	writeFrame := func(frame workerInbound) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		payload, err := json.Marshal(frame)
		if err != nil {
			return err
		}
		if len(payload) > MaxFrameBytes {
			return fmt.Errorf("script frame exceeds %d bytes", MaxFrameBytes)
		}
		payload = append(payload, '\n')
		_, err = stdin.Write(payload)
		return err
	}
	if err := writeFrame(workerInbound{Type: frameTypeRun, Request: &request}); err != nil {
		terminateWorkerProcess(command)
		_ = command.Wait()
		return RunResult{Success: false, Message: err.Error()}
	}

	grace := r.KillGrace
	if grace <= 0 {
		grace = defaultKillGrace
	}
	var terminateOnce sync.Once
	var killTimerMu sync.Mutex
	var killTimer *time.Timer
	var killTimerDone chan struct{}
	terminate := func(sendCancel bool) {
		terminateOnce.Do(func() {
			done := make(chan struct{})
			timer := time.AfterFunc(grace, func() {
				defer close(done)
				terminateWorkerProcess(command)
			})
			killTimerMu.Lock()
			killTimer = timer
			killTimerDone = done
			killTimerMu.Unlock()
			if sendCancel {
				_ = writeFrame(workerInbound{Type: frameTypeCancel})
			}
		})
	}
	ctxDone := make(chan struct{})
	ctxWatcherDone := make(chan struct{})
	go func() {
		defer close(ctxWatcherDone)
		select {
		case <-ctx.Done():
			terminate(true)
		case <-ctxDone:
		}
	}()

	result := RunResult{}
	done := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), MaxFrameBytes)
scanLoop:
	for scanner.Scan() {
		var frame workerOutbound
		if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
			result = RunResult{Success: false, Message: fmt.Sprintf("decode script worker frame: %v", err)}
			terminate(false)
			break
		}
		switch frame.Type {
		case frameTypeEvent:
			if frame.Event != nil && observe != nil {
				if observeErr := observe(*frame.Event); observeErr != nil {
					result = RunResult{
						Success: false,
						Message: fmt.Sprintf("handle script worker event: %v", observeErr),
					}
					terminate(false)
					break scanLoop
				}
			}
		case frameTypeHostRequest:
			if err := ctx.Err(); err != nil {
				_ = writeFrame(workerInbound{
					Type:  frameTypeHostResponse,
					ID:    frame.ID,
					Error: truncateUTF8Text(err.Error(), MaxErrorMessageBytes),
				})
				continue
			}
			value, handleErr := host.Handle(ctx, HostRequest{
				ID:     frame.ID,
				Method: frame.Method,
				Params: frame.Params,
			})
			response := workerInbound{Type: frameTypeHostResponse, ID: frame.ID}
			if handleErr != nil {
				response.Error = truncateUTF8Text(handleErr.Error(), MaxErrorMessageBytes)
			} else {
				payload, err := json.Marshal(value)
				if err != nil {
					response.Error = truncateUTF8Text(err.Error(), MaxErrorMessageBytes)
				} else if len(payload) > MaxFrameBytes-(64<<10) {
					response.Error = fmt.Sprintf("script host response exceeds %d bytes", MaxFrameBytes-(64<<10))
				} else {
					response.Result = payload
				}
			}
			if err := writeFrame(response); err != nil {
				result = RunResult{Success: false, Message: err.Error()}
				terminate(false)
			}
		case frameTypeDone:
			if frame.Result != nil {
				result = *frame.Result
			} else {
				result = RunResult{Success: false, Message: "script worker returned no result"}
			}
			done = true
		}
		if done {
			break
		}
	}
	close(ctxDone)
	<-ctxWatcherDone
	// Join every signal producer before calling Wait. After this point only the
	// os.Process handle may be used for the wait-timeout kill.
	killTimerMu.Lock()
	timer := killTimer
	timerDone := killTimerDone
	killTimerMu.Unlock()
	if timer != nil {
		if !timer.Stop() {
			<-timerDone
		}
	}
	stopMemoryWatch()
	if err := scanner.Err(); err != nil && !done && strings.TrimSpace(result.Message) == "" {
		result = RunResult{Success: false, Message: fmt.Sprintf("read script worker output: %v", err)}
	}

	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()
	select {
	case waitErr := <-waitDone:
		if !done && waitErr != nil && strings.TrimSpace(result.Message) == "" {
			result.Message = waitErr.Error()
		}
	case <-time.After(grace):
		killWorkerProcessHandle(command)
		<-waitDone
	}
	_ = stdin.Close()
	if !done {
		result.Success = false
		if strings.TrimSpace(result.Message) == "" {
			result.Message = summarizeWorkerFailure(stderr.String())
		}
	}
	if !memoryExceeded.Load() && request.Limits.MemoryLimitBytes > 0 &&
		workerExitIndicatesMemoryLimit(command.ProcessState, stderr.String()) {
		memoryExceeded.Store(true)
	}
	result.DurationMs = time.Since(startedAt).Milliseconds()
	if ctx.Err() != nil {
		result.Success = false
		result.Cancelled = errors.Is(ctx.Err(), context.Canceled)
		result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		if result.TimedOut {
			result.Message = "script timed out"
		} else if strings.TrimSpace(result.Message) == "" {
			result.Message = "script cancelled"
		}
	}
	if memoryExceeded.Load() {
		result.Success = false
		result.Cancelled = false
		result.TimedOut = false
		result.MemoryExceeded = true
		result.Message = "script memory limit exceeded"
	}
	result.Message = truncateUTF8Text(result.Message, MaxErrorMessageBytes)
	return result
}

func cancellationResult(startedAt time.Time, err error) RunResult {
	return RunResult{
		Success:    false,
		Message:    err.Error(),
		Cancelled:  errors.Is(err, context.Canceled),
		TimedOut:   errors.Is(err, context.DeadlineExceeded),
		DurationMs: time.Since(startedAt).Milliseconds(),
	}
}

func summarizeWorkerFailure(stderr string) string {
	stderr = strings.TrimSpace(stderr)
	if stderr == "" {
		return "script worker exited unexpectedly"
	}
	if len(stderr) > 2000 {
		stderr = stderr[len(stderr)-2000:]
	}
	return "script worker exited: " + stderr
}

type limitedBuffer struct {
	mu    sync.Mutex
	limit int
	data  bytes.Buffer
}

func (b *limitedBuffer) Write(payload []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	original := len(payload)
	if b.limit <= 0 {
		return original, nil
	}
	remaining := b.limit - b.data.Len()
	if remaining > 0 {
		if len(payload) > remaining {
			payload = payload[:remaining]
		}
		_, _ = b.data.Write(payload)
	}
	return original, nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.String()
}

var _ io.Writer = (*limitedBuffer)(nil)

func workerExecutableLabel() string {
	if runtime.GOOS == "windows" {
		return "script-worker.exe"
	}
	return "script-worker"
}
