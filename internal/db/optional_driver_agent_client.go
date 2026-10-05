package db

import (
	"bufio"
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
	"syscall"
	"time"

	"GoNavi-Wails/internal/logger"
	sshbridge "GoNavi-Wails/internal/ssh"
)

type optionalDriverAgentClient struct {
	cmd             *exec.Cmd
	stdin           io.WriteCloser
	stdout          io.ReadCloser
	reader          *bufio.Reader
	callGateOnce    sync.Once
	callGate        chan struct{}
	stateMu         sync.Mutex
	stopOnce        sync.Once
	stopErr         error
	stopped         error
	stderr          boundedDiagnosticTail
	driver          string
	shutdownTimeout time.Duration
	// protocolSchema 来自 connect 响应；旧版 agent 不回显（空串）。
	protocolSchema string
	// inFlightCancel 来自 connect 响应；旧版 agent 不回显（false）。
	inFlightCancel bool
	// nextRequestID 与 inFlightRequestID 供取消通知定位目标请求：前者是请求 ID 计数，
	// 后者是当前持有串行传输的请求。二者都由 requestMu 保护，因为取消通知由
	// 独立的 watcher goroutine 发出，不再只在持锁的调用线程里读写。
	requestMu         sync.Mutex
	nextRequestID     int64
	inFlightRequestID int64
	writeMu           sync.Mutex
}

// schema 返回 connect 响应回显的协议版本，供参数绑定等能力门控读取。
func (c *optionalDriverAgentClient) schema() string {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.protocolSchema
}

func (c *optionalDriverAgentClient) setSchema(schema string) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.protocolSchema == "" {
		c.protocolSchema = schema
	}
}

// extraEnv 追加到代理进程环境变量（如用户自备客户端库的目录与动态库搜索路径），为空时继承当前进程环境。
func newOptionalDriverAgentClient(driverType string, executablePath string, extraEnv ...string) (*optionalDriverAgentClient, error) {
	pathText := strings.TrimSpace(executablePath)
	if pathText == "" {
		return nil, fmt.Errorf("%s 驱动代理路径为空", driverDisplayName(driverType))
	}
	info, err := os.Stat(pathText)
	if err != nil {
		return nil, fmt.Errorf("%s 驱动代理不存在：%s", driverDisplayName(driverType), pathText)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%s 驱动代理路径是目录：%s", driverDisplayName(driverType), pathText)
	}

	cmd := exec.Command(pathText)
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	configureAgentProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 %s 驱动代理 stdin 失败：%w", driverDisplayName(driverType), err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 %s 驱动代理 stdout 失败：%w", driverDisplayName(driverType), err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 %s 驱动代理 stderr 失败：%w", driverDisplayName(driverType), err)
	}
	if err := cmd.Start(); err != nil {
		if isWindowsExecutableMachineMismatch(err) {
			return nil, fmt.Errorf("启动 %s 驱动代理失败：%w（检测到驱动代理与当前系统架构不兼容，请在驱动管理中重新安装启用）", driverDisplayName(driverType), err)
		}
		return nil, fmt.Errorf("启动 %s 驱动代理失败：%w", driverDisplayName(driverType), err)
	}

	client := &optionalDriverAgentClient{
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		reader: bufio.NewReader(stdout),
		driver: normalizeRuntimeDriverType(driverType),
	}
	go client.captureStderr(stderr)
	return client, nil
}

func isWindowsExecutableMachineMismatch(err error) bool {
	if err == nil || runtime.GOOS != "windows" {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == syscall.Errno(216) {
		return true
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" {
		return false
	}
	if strings.Contains(text, "not compatible with the version of windows") {
		return true
	}
	if strings.Contains(text, "win32") && strings.Contains(text, "compatible") {
		return true
	}
	if strings.Contains(text, "不是有效的win32应用程序") || strings.Contains(text, "无法在win32模式下运行") {
		return true
	}
	return false
}

func (c *optionalDriverAgentClient) captureStderr(stderr io.Reader) {
	scanner := bufio.NewScanner(stderr)
	buffer := make([]byte, 0, 8<<10)
	scanner.Buffer(buffer, optionalAgentDefaultScannerMaxBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		logger.Warnf("%s 驱动代理 stderr: %s", driverDisplayName(c.driver), line)
		c.stderr.Append(line)
	}
}

func (c *optionalDriverAgentClient) stderrText() string {
	return strings.TrimSpace(c.stderr.String())
}

func (c *optionalDriverAgentClient) call(req optionalAgentRequest, out interface{}, fields *[]string, messages *[]string, rowsAffected *int64) error {
	return c.runWithContext(context.Background(), req.Method, func(requestID int64) error {
		return c.callLocked(requestID, req, out, fields, messages, rowsAffected)
	})
}

func markOptionalAgentApplyChangesTransportUnknown(req optionalAgentRequest, err error) error {
	if err != nil && req.Method == optionalAgentMethodApplyChanges {
		return MarkWriteOutcomeUnknown(err)
	}
	return err
}

func (c *optionalDriverAgentClient) callLocked(requestID int64, req optionalAgentRequest, out interface{}, fields *[]string, messages *[]string, rowsAffected *int64) error {
	if err := c.stoppedError(); err != nil {
		return fmt.Errorf("%s 驱动代理传输不可用：%w", driverDisplayName(c.driver), err)
	}

	req.ID = requestID

	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if len(payload) > OptionalDriverAgentMaxJSONLineBytes {
		_ = c.forceTerminate(ErrOptionalDriverAgentJSONLineTooLarge)
		return markOptionalAgentApplyChangesTransportUnknown(req, fmt.Errorf("发送 %s 驱动代理请求失败：%w", driverDisplayName(c.driver), ErrOptionalDriverAgentJSONLineTooLarge))
	}
	if err := c.writeRequestFrame(payload); err != nil {
		stderrText := c.stderrText()
		if stderrText == "" {
			return markOptionalAgentApplyChangesTransportUnknown(req, fmt.Errorf("调用 %s 驱动代理失败：%w", driverDisplayName(c.driver), err))
		}
		return markOptionalAgentApplyChangesTransportUnknown(req, fmt.Errorf("调用 %s 驱动代理失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText))
	}

	for {
		line, err := ReadOptionalDriverAgentJSONLine(c.reader)
		if err != nil {
			if errors.Is(err, ErrOptionalDriverAgentJSONLineTooLarge) {
				_ = c.forceTerminate(err)
			}
			stderrText := c.stderrText()
			if stderrText == "" {
				return markOptionalAgentApplyChangesTransportUnknown(req, fmt.Errorf("读取 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err))
			}
			return markOptionalAgentApplyChangesTransportUnknown(req, fmt.Errorf("读取 %s 驱动代理响应失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText))
		}

		var resp optionalAgentResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			return markOptionalAgentApplyChangesTransportUnknown(req, fmt.Errorf("解析 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err))
		}
		if resp.ID != req.ID {
			return c.rejectProtocolViolation(req, "响应 ID 不匹配：收到 %d，期望 %d", resp.ID, req.ID)
		}
		if resp.OutcomeUnknown && (resp.Success || req.Method != optionalAgentMethodApplyChanges) {
			return c.rejectProtocolViolation(req, "outcomeUnknown 仅允许用于失败的 applyChanges 响应")
		}
		if resp.SSHProgress != nil {
			if !resp.Success || req.Method != optionalAgentMethodConnect || !req.StreamSSHProgress || req.sshProgressReporter == nil {
				return c.rejectProtocolViolation(req, "收到了未订阅或无效的 SSH 进度帧")
			}
			req.sshProgressReporter(*resp.SSHProgress)
			continue
		}
		if !resp.Success {
			errText := strings.TrimSpace(resp.Error)
			if errText == "" {
				errText = fmt.Sprintf("%s 驱动代理返回失败", driverDisplayName(c.driver))
			}
			if errText == ErrOptionalDriverAgentJSONLineTooLarge.Error() {
				_ = c.forceTerminate(ErrOptionalDriverAgentJSONLineTooLarge)
				return markOptionalAgentApplyChangesTransportUnknown(req, ErrOptionalDriverAgentJSONLineTooLarge)
			}
			if resp.SSHHostKeyTrust != nil {
				return fmt.Errorf("%s: %w", errText, &sshbridge.HostKeyTrustRequiredError{Status: *resp.SSHHostKeyTrust})
			}
			if resp.ExternalAttachNotAttached {
				return fmt.Errorf("%s: %w", errText, ErrExternalAttachNotAttached)
			}
			if resp.PartialData && out != nil && len(resp.Data) > 0 {
				// 部分结果解析失败时退回只返回错误，与旧协议行为一致。
				_ = decodeJSONWithUseNumber(resp.Data, out)
			}
			err := errors.New(errText)
			if resp.OutcomeUnknown {
				return MarkWriteOutcomeUnknown(err)
			}
			return err
		}

		if fields != nil {
			*fields = resp.Fields
		}
		if messages != nil {
			*messages = append((*messages)[:0], resp.Messages...)
		}
		if rowsAffected != nil {
			*rowsAffected = resp.RowsAffected
		}
		if out != nil && len(resp.Data) > 0 {
			if err := decodeJSONWithUseNumber(resp.Data, out); err != nil {
				return fmt.Errorf("解析 %s 驱动代理数据失败：%w", driverDisplayName(c.driver), err)
			}
		}
		recordOptionalAgentBudgetResponse(req, out, resp)
		return nil
	}
}

func (c *optionalDriverAgentClient) rejectProtocolViolation(req optionalAgentRequest, format string, args ...interface{}) error {
	violation := fmt.Errorf("%s 驱动代理协议错误：%s", driverDisplayName(c.driver), fmt.Sprintf(format, args...))
	_ = c.forceTerminate(violation)
	return markOptionalAgentApplyChangesTransportUnknown(req, violation)
}

func (c *optionalDriverAgentClient) callContext(ctx context.Context, req optionalAgentRequest, out interface{}, fields *[]string, messages *[]string, rowsAffected *int64) error {
	return c.runWithContext(ctx, req.Method, func(requestID int64) error {
		return c.callLocked(requestID, req, out, fields, messages, rowsAffected)
	})
}

// runWithContext 在串行传输上执行一次请求，并把请求上下文生命周期与传输生命周期解耦。
//
// operation 的入参是本次请求的 ID：它已提前登记为在途请求，取消通知据此定位目标。
func (c *optionalDriverAgentClient) runWithContext(ctx context.Context, method string, operation func(requestID int64) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return optionalAgentContextError(c.driver, method, err)
	}
	if err := c.acquireCallGate(ctx); err != nil {
		return optionalAgentContextError(c.driver, method, err)
	}
	defer c.releaseCallGate()
	if err := ctx.Err(); err != nil {
		return optionalAgentContextError(c.driver, method, err)
	}

	requestID, releaseRequest := c.beginRequest()
	defer releaseRequest()

	if ctx.Done() == nil {
		return operation(requestID)
	}

	// Anonymous pipes do not reliably support deadlines on every target OS.
	// Only a request that already owns the serial transport may tear it down.
	// A caller whose context expires while waiting for the gate returns above
	// without interrupting the legitimate long-running request ahead of it.
	// context.AfterFunc avoids leaving one watcher goroutine behind per call.
	operationDone := make(chan struct{})
	watcherDone := make(chan struct{})
	stopWatcher := context.AfterFunc(ctx, func() {
		defer close(watcherDone)
		c.cancelInFlightRequest(ctx, requestID, operationDone)
	})

	err := operation(requestID)
	close(operationDone)
	if stopWatcher() {
		return err
	}
	// watcher 可能仍在宽限期内等待本次请求自行结束；operationDone 已关闭，它会立刻返回。
	<-watcherDone
	return optionalAgentContextError(c.driver, method, ctx.Err())
}

func (c *optionalDriverAgentClient) acquireCallGate(ctx context.Context) error {
	gate := c.callGateChannel()
	if ctx == nil || ctx.Done() == nil {
		<-gate
		return nil
	}
	select {
	case <-gate:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *optionalDriverAgentClient) releaseCallGate() {
	c.callGateChannel() <- struct{}{}
}

func (c *optionalDriverAgentClient) callGateChannel() chan struct{} {
	c.callGateOnce.Do(func() {
		c.callGate = make(chan struct{}, 1)
		c.callGate <- struct{}{}
	})
	return c.callGate
}

func optionalAgentContextError(driverType, method string, err error) error {
	if err == nil {
		err = context.Canceled
	}
	action := strings.TrimSpace(method)
	if action == "" {
		action = "IPC"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s 驱动代理 %s 请求超时：%w", driverDisplayName(driverType), action, err)
	}
	return fmt.Errorf("%s 驱动代理 %s 请求已取消：%w", driverDisplayName(driverType), action, err)
}

func (c *optionalDriverAgentClient) callWithTimeout(req optionalAgentRequest, out interface{}, fields *[]string, messages *[]string, rowsAffected *int64, timeout time.Duration) error {
	return c.callWithContext(context.Background(), req, out, fields, messages, rowsAffected, timeout)
}

func (c *optionalDriverAgentClient) callWithContext(ctx context.Context, req optionalAgentRequest, out interface{}, fields *[]string, messages *[]string, rowsAffected *int64, timeout time.Duration) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		return c.callContext(ctx, req, out, fields, messages, rowsAffected)
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := c.callContext(ctx, req, out, fields, messages, rowsAffected)
	if errors.Is(err, context.DeadlineExceeded) && req.Method == optionalAgentMethodMetadata {
		return fmt.Errorf("%s 驱动代理 metadata 探测超时（%s），请确认导入的是正确的 driver-agent 可执行文件：%w", driverDisplayName(c.driver), timeout, err)
	}
	return err
}

func (c *optionalDriverAgentClient) stoppedError() error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.stopped
}

func (c *optionalDriverAgentClient) markStopped(cause error) {
	stoppedErr := errOptionalAgentTransportStopped
	if cause != nil && !errors.Is(cause, errOptionalAgentTransportStopped) {
		stoppedErr = fmt.Errorf("%w（原因：%v）", errOptionalAgentTransportStopped, cause)
	}
	c.stateMu.Lock()
	if c.stopped == nil {
		c.stopped = stoppedErr
	}
	c.stateMu.Unlock()
}

func (c *optionalDriverAgentClient) forceTerminate(cause error) error {
	c.markStopped(cause)
	return c.stopProcess(true)
}

func (c *optionalDriverAgentClient) stopProcess(force bool) error {
	// A forced stop must be able to interrupt a graceful wait already running
	// inside stopOnce, so issue Kill before entering the once gate.
	if force && c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	c.stopOnce.Do(func() {
		// Close both pipe directions before waiting. This unblocks an in-flight
		// call without taking the serial gate; waiting for it here would recreate the
		// shutdown deadlock this cleanup path is meant to break.
		if c.stdin != nil {
			_ = c.stdin.Close()
		}
		if c.stdout != nil {
			_ = c.stdout.Close()
		}
		if c.cmd == nil || c.cmd.Process == nil {
			return
		}
		c.stopErr = waitForAgentExit(c.cmd.Wait, c.cmd.Process.Kill, agentProcessExitTimeout)
	})
	return c.stopErr
}

func (c *optionalDriverAgentClient) close() error {
	c.markStopped(errOptionalAgentTransportStopped)
	return c.stopProcess(false)
}

func (c *optionalDriverAgentClient) shutdownCallTimeout() time.Duration {
	if c.shutdownTimeout > 0 {
		return c.shutdownTimeout
	}
	return optionalAgentShutdownCallTimeout
}
