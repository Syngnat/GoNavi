package db

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
	"reflect"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

const (
	optionalAgentMethodConnect             = "connect"
	optionalAgentMethodClose               = "close"
	optionalAgentMethodMetadata            = "metadata"
	optionalAgentMethodPing                = "ping"
	optionalAgentMethodOpenSession         = "openSession"
	optionalAgentMethodCloseSession        = "closeSession"
	optionalAgentMethodOpenTransaction     = "openTransaction"
	optionalAgentMethodCommitTransaction   = "commitTransaction"
	optionalAgentMethodRollbackTransaction = "rollbackTransaction"
	optionalAgentMethodQuery               = "query"
	optionalAgentMethodQueryMulti          = "queryMulti"
	optionalAgentMethodStreamQuery         = "streamQuery"
	optionalAgentMethodExec                = "exec"
	optionalAgentMethodGetDatabases        = "getDatabases"
	optionalAgentMethodGetTables           = "getTables"
	optionalAgentMethodGetCreateStmt       = "getCreateStatement"
	optionalAgentMethodGetColumns          = "getColumns"
	optionalAgentMethodGetAllColumns       = "getAllColumns"
	optionalAgentMethodGetIndexes          = "getIndexes"
	optionalAgentMethodGetForeignKeys      = "getForeignKeys"
	optionalAgentMethodGetTriggers         = "getTriggers"
	optionalAgentMethodApplyChanges        = "applyChanges"
	optionalAgentDefaultScannerMaxBytes    = 8 << 20
	optionalAgentMetadataProbeTimeout      = 5 * time.Second
	optionalAgentControlCallTimeout        = 30 * time.Second
	optionalAgentShutdownCallTimeout       = 2 * time.Second
	// callStreamQueryGCInterval 控制 callStreamQuery 每接收多少行 driver-agent 数据触发一次 runtime.GC。
	//
	// 该路径不走 sql.Rows（scan_rows.go 的周期 GC 覆盖不到），但每个 chunk 解码
	// [][]interface{} + normalizeQueryValue 转换会产生大量临时字符串，需要主动回收。
	// 取 50000 与 scan_rows.go 的 streamRowsPeriodicGCInterval 保持一致，
	// 让两端在相近节奏下分别 GC，避免内存峰值叠加。
	callStreamQueryGCInterval = 50000
)

const (
	optionalAgentChunkColumns = "columns"
	optionalAgentChunkRows    = "rows"
	optionalAgentChunkDone    = "done"
)

var errOptionalAgentTransportStopped = errors.New("驱动代理传输已关闭")

type optionalAgentRequest struct {
	ID        int64                        `json:"id"`
	Method    string                       `json:"method"`
	SessionID string                       `json:"sessionId,omitempty"`
	Config    *connection.ConnectionConfig `json:"config,omitempty"`
	Query     string                       `json:"query,omitempty"`
	TimeoutMs int64                        `json:"timeoutMs,omitempty"`
	DBName    string                       `json:"dbName,omitempty"`
	TableName string                       `json:"tableName,omitempty"`
	Changes   *connection.ChangeSet        `json:"changes,omitempty"`
}

type optionalAgentResponse struct {
	ID           int64           `json:"id"`
	Success      bool            `json:"success"`
	Error        string          `json:"error,omitempty"`
	Data         json.RawMessage `json:"data,omitempty"`
	Fields       []string        `json:"fields,omitempty"`
	Messages     []string        `json:"messages,omitempty"`
	ChunkType    string          `json:"chunkType,omitempty"`
	RowsAffected int64           `json:"rowsAffected,omitempty"`
}

type OptionalDriverAgentMetadata struct {
	DriverType     string `json:"driverType,omitempty"`
	AgentRevision  string `json:"agentRevision,omitempty"`
	ProtocolSchema string `json:"protocolSchema,omitempty"`
}

type optionalDriverAgentClient struct {
	cmd             *exec.Cmd
	stdin           io.WriteCloser
	stdout          io.ReadCloser
	reader          *bufio.Reader
	nextID          int64
	callGateOnce    sync.Once
	callGate        chan struct{}
	stateMu         sync.Mutex
	stopOnce        sync.Once
	stopErr         error
	stopped         error
	stderr          boundedDiagnosticTail
	driver          string
	shutdownTimeout time.Duration
}

func ProbeOptionalDriverAgentMetadata(driverType string, executablePath string) (OptionalDriverAgentMetadata, error) {
	client, err := newOptionalDriverAgentClient(driverType, executablePath)
	if err != nil {
		return OptionalDriverAgentMetadata{}, err
	}
	defer func() {
		_ = client.close()
	}()

	var metadata OptionalDriverAgentMetadata
	if err := client.callWithTimeout(optionalAgentRequest{Method: optionalAgentMethodMetadata}, &metadata, nil, nil, nil, optionalAgentMetadataProbeTimeout); err != nil {
		return OptionalDriverAgentMetadata{}, err
	}
	metadata.DriverType = normalizeRuntimeDriverType(metadata.DriverType)
	metadata.AgentRevision = strings.TrimSpace(metadata.AgentRevision)
	metadata.ProtocolSchema = strings.TrimSpace(metadata.ProtocolSchema)
	return metadata, nil
}

func newOptionalDriverAgentClient(driverType string, executablePath string) (*optionalDriverAgentClient, error) {
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
	return c.runWithContext(context.Background(), req.Method, func() error {
		return c.callLocked(req, out, fields, messages, rowsAffected)
	})
}

func (c *optionalDriverAgentClient) callLocked(req optionalAgentRequest, out interface{}, fields *[]string, messages *[]string, rowsAffected *int64) error {
	if err := c.stoppedError(); err != nil {
		return fmt.Errorf("%s 驱动代理传输不可用：%w", driverDisplayName(c.driver), err)
	}

	c.nextID++
	req.ID = c.nextID

	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if _, err := c.stdin.Write(payload); err != nil {
		stderrText := c.stderrText()
		if stderrText == "" {
			return fmt.Errorf("调用 %s 驱动代理失败：%w", driverDisplayName(c.driver), err)
		}
		return fmt.Errorf("调用 %s 驱动代理失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText)
	}

	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		stderrText := c.stderrText()
		if stderrText == "" {
			return fmt.Errorf("读取 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err)
		}
		return fmt.Errorf("读取 %s 驱动代理响应失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText)
	}

	var resp optionalAgentResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return fmt.Errorf("解析 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err)
	}
	if !resp.Success {
		errText := strings.TrimSpace(resp.Error)
		if errText == "" {
			errText = fmt.Sprintf("%s 驱动代理返回失败", driverDisplayName(c.driver))
		}
		return errors.New(errText)
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
	return nil
}

func (c *optionalDriverAgentClient) callContext(ctx context.Context, req optionalAgentRequest, out interface{}, fields *[]string, messages *[]string, rowsAffected *int64) error {
	return c.runWithContext(ctx, req.Method, func() error {
		return c.callLocked(req, out, fields, messages, rowsAffected)
	})
}

func (c *optionalDriverAgentClient) runWithContext(ctx context.Context, method string, operation func() error) error {
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

	if ctx.Done() == nil {
		return operation()
	}

	// Anonymous pipes do not reliably support deadlines on every target OS.
	// Only a request that already owns the serial transport may tear it down.
	// A caller whose context expires while waiting for the gate returns above
	// without interrupting the legitimate long-running request ahead of it.
	// context.AfterFunc avoids leaving one watcher goroutine behind per call.
	terminateDone := make(chan struct{})
	stopTerminate := context.AfterFunc(ctx, func() {
		defer close(terminateDone)
		_ = c.forceTerminate(ctx.Err())
	})

	err := operation()
	if stopTerminate() {
		return err
	}
	<-terminateDone
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
	if timeout <= 0 {
		return c.call(req, out, fields, messages, rowsAffected)
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	err := c.callContext(ctx, req, out, fields, messages, rowsAffected)
	if errors.Is(err, context.DeadlineExceeded) && req.Method == optionalAgentMethodMetadata {
		return fmt.Errorf("%s 驱动代理 metadata 探测超时（%s），请确认导入的是正确的 driver-agent 可执行文件：%w", driverDisplayName(c.driver), timeout, err)
	}
	return err
}

func (c *optionalDriverAgentClient) callStreamQuery(req optionalAgentRequest, consumer QueryStreamConsumer) error {
	return c.runWithContext(context.Background(), req.Method, func() error {
		return c.callStreamQueryLocked(req, consumer)
	})
}

func (c *optionalDriverAgentClient) callStreamQueryLocked(req optionalAgentRequest, consumer QueryStreamConsumer) error {
	if consumer == nil {
		return fmt.Errorf("query stream consumer required")
	}

	if err := c.stoppedError(); err != nil {
		return fmt.Errorf("%s 驱动代理传输不可用：%w", driverDisplayName(c.driver), err)
	}

	c.nextID++
	req.ID = c.nextID

	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if _, err := c.stdin.Write(payload); err != nil {
		stderrText := c.stderrText()
		if stderrText == "" {
			return fmt.Errorf("调用 %s 驱动代理失败：%w", driverDisplayName(c.driver), err)
		}
		return fmt.Errorf("调用 %s 驱动代理失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText)
	}

	var columns []string
	valueConsumer, useValueConsumer := consumer.(QueryStreamValueConsumer)

	// processedRows 用于周期性触发 GC。
	// 该路径不走 sql.Rows，scan_rows.go 的周期 GC 覆盖不到。
	// 每个 chunk 解码会分配 [][]interface{} + normalizeQueryValue 转换副本，
	// 88W 行场景下不主动 GC 会让主进程 RSS 单调爬升。
	var processedRows int64

	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			stderrText := c.stderrText()
			if stderrText == "" {
				return fmt.Errorf("读取 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err)
			}
			return fmt.Errorf("读取 %s 驱动代理响应失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText)
		}

		var resp optionalAgentResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			return fmt.Errorf("解析 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err)
		}
		if !resp.Success {
			errText := strings.TrimSpace(resp.Error)
			if errText == "" {
				errText = fmt.Sprintf("%s 驱动代理返回失败", driverDisplayName(c.driver))
			}
			return errors.New(errText)
		}

		switch resp.ChunkType {
		case optionalAgentChunkColumns:
			columns = append(columns[:0], resp.Fields...)
			if err := consumer.SetColumns(columns); err != nil {
				return err
			}
		case optionalAgentChunkRows:
			if len(columns) == 0 {
				return fmt.Errorf("%s 驱动代理流式响应缺少列信息", driverDisplayName(c.driver))
			}
			rows, err := decodeOptionalAgentRowValueBatch(resp.Data)
			if err != nil {
				return fmt.Errorf("解析 %s 驱动代理流式数据失败：%w", driverDisplayName(c.driver), err)
			}
			for _, row := range rows {
				if useValueConsumer {
					if err := valueConsumer.ConsumeRowValues(row); err != nil {
						return err
					}
					continue
				}
				entry := make(map[string]interface{}, len(columns))
				for i, column := range columns {
					if i < len(row) {
						entry[column] = row[i]
					} else {
						entry[column] = nil
					}
				}
				if err := consumer.ConsumeRow(entry); err != nil {
					return err
				}
			}
			processedRows += int64(len(rows))
			if processedRows >= callStreamQueryGCInterval {
				runtime.GC()
				processedRows = 0
			}
		case optionalAgentChunkDone:
			return nil
		default:
			return fmt.Errorf("%s 驱动代理返回未知流式分片类型：%s", driverDisplayName(c.driver), strings.TrimSpace(resp.ChunkType))
		}
	}
}

func decodeOptionalAgentRowValueBatch(data []byte) ([][]interface{}, error) {
	if len(data) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var rows [][]interface{}
	if err := decoder.Decode(&rows); err != nil {
		return nil, err
	}
	for rowIdx := range rows {
		for colIdx := range rows[rowIdx] {
			rows[rowIdx][colIdx] = normalizeQueryValue(rows[rowIdx][colIdx])
		}
	}
	return rows, nil
}

func (c *optionalDriverAgentClient) callStreamQueryContext(ctx context.Context, req optionalAgentRequest, consumer QueryStreamConsumer) error {
	return c.runWithContext(ctx, req.Method, func() error {
		return c.callStreamQueryLocked(req, consumer)
	})
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

type OptionalDriverAgentDB struct {
	driverType         string
	client             *optionalDriverAgentClient
	kingbaseSearchPath string
	pingTimeout        time.Duration
}

type optionalDriverAgentTransactionalDB struct {
	*OptionalDriverAgentDB
}

type optionalDriverAgentSession struct {
	client    *optionalDriverAgentClient
	driver    string
	sessionID string
	mu        sync.Mutex
	closed    bool
}

type optionalDriverAgentTransaction struct {
	*optionalDriverAgentSession
	finishMu sync.Mutex
	finished bool
}

var _ TransactionExecerProvider = (*optionalDriverAgentTransactionalDB)(nil)
var _ TransactionExecer = (*optionalDriverAgentTransaction)(nil)

func newOptionalDriverAgentDatabase(driverType string) databaseFactory {
	normalized := normalizeRuntimeDriverType(driverType)
	return func() Database {
		return &OptionalDriverAgentDB{driverType: normalized}
	}
}

func newOptionalDriverAgentTransactionalDatabase(driverType string) databaseFactory {
	normalized := normalizeRuntimeDriverType(driverType)
	return func() Database {
		return &optionalDriverAgentTransactionalDB{
			OptionalDriverAgentDB: &OptionalDriverAgentDB{driverType: normalized},
		}
	}
}

func (d *OptionalDriverAgentDB) Connect(config connection.ConnectionConfig) error {
	d.kingbaseSearchPath = ""
	if d.client != nil {
		_ = d.client.close()
		d.client = nil
	}

	executablePath, err := ResolveOptionalDriverAgentExecutablePath("", d.driverType)
	if err != nil {
		return err
	}
	logger.Infof("%s 驱动代理路径：%s", driverDisplayName(d.driverType), executablePath)
	client, err := newOptionalDriverAgentClient(d.driverType, executablePath)
	if err != nil {
		return err
	}
	connectTimeout := getConnectTimeout(config)
	if err := client.callWithTimeout(optionalAgentRequest{
		Method: optionalAgentMethodConnect,
		Config: &config,
	}, nil, nil, nil, nil, connectTimeout); err != nil {
		_ = client.close()
		return err
	}
	d.client = client
	d.pingTimeout = connectTimeout
	d.ensureKingbaseSearchPath(config)
	return nil
}

func (d *OptionalDriverAgentDB) Close() error {
	if d.client == nil {
		return nil
	}
	client := d.client
	d.client = nil
	_ = client.callWithTimeout(
		optionalAgentRequest{Method: optionalAgentMethodClose},
		nil,
		nil,
		nil,
		nil,
		client.shutdownCallTimeout(),
	)
	return client.close()
}

func (d *OptionalDriverAgentDB) Ping() error {
	timeout := d.pingTimeout
	if timeout <= 0 {
		timeout = optionalAgentControlCallTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return d.PingContext(ctx)
}

func (d *OptionalDriverAgentDB) PingContext(ctx context.Context) error {
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	return client.callContext(ctx, optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil)
}

func (d *OptionalDriverAgentDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	data, fields, _, err := d.QueryContextWithMessages(ctx, query)
	return data, fields, err
}

func (d *OptionalDriverAgentDB) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, nil, err
	}
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, nil, err
	}
	var data []map[string]interface{}
	var fields []string
	var messages []string
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodQuery,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, &data, &fields, &messages, nil); err != nil {
		return nil, nil, nil, err
	}
	return data, fields, messages, nil
}

func (d *OptionalDriverAgentDB) Query(query string) ([]map[string]interface{}, []string, error) {
	data, fields, _, err := d.QueryWithMessages(query)
	return data, fields, err
}

func (d *OptionalDriverAgentDB) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, nil, err
	}
	var data []map[string]interface{}
	var fields []string
	var messages []string
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodQuery,
		Query:  query,
	}, &data, &fields, &messages, nil); err != nil {
		return nil, nil, nil, err
	}
	return data, fields, messages, nil
}

func (d *OptionalDriverAgentDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	results, _, err := d.QueryMultiWithMessages(query)
	return results, err
}

func (d *OptionalDriverAgentDB) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, err
	}
	var results []connection.ResultSetData
	var messages []string
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodQueryMulti,
		Query:  query,
	}, &results, nil, &messages, nil); err != nil {
		if isOptionalAgentMultiResultUnsupportedError(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	return results, messages, nil
}

func (d *OptionalDriverAgentDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	results, _, err := d.QueryMultiContextWithMessages(ctx, query)
	return results, err
}

func (d *OptionalDriverAgentDB) QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, err
	}
	var results []connection.ResultSetData
	var messages []string
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodQueryMulti,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, &results, nil, &messages, nil); err != nil {
		if isOptionalAgentMultiResultUnsupportedError(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	return results, messages, nil
}

func (d *OptionalDriverAgentDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return d.StreamQueryContext(context.Background(), query, consumer)
}

func (d *OptionalDriverAgentDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	err = client.callStreamQueryContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodStreamQuery,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, consumer)
	if isOptionalAgentStreamUnsupportedError(err) {
		logger.Warnf("%s 驱动代理暂不支持流式查询，回退到缓冲模式：err=%v", driverDisplayName(d.driverType), err)
		data, columns, queryErr := d.QueryContext(ctx, query)
		if queryErr != nil {
			return queryErr
		}
		if err := consumer.SetColumns(columns); err != nil {
			return err
		}
		for _, row := range data {
			if err := consumer.ConsumeRow(row); err != nil {
				return err
			}
		}
		return nil
	}
	return err
}

func (d *OptionalDriverAgentDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	client, err := d.requireClient()
	if err != nil {
		return 0, err
	}
	var affected int64
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodExec,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, nil, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (d *OptionalDriverAgentDB) Exec(query string) (int64, error) {
	client, err := d.requireClient()
	if err != nil {
		return 0, err
	}
	var affected int64
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodExec,
		Query:  query,
	}, nil, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (d *OptionalDriverAgentDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var sessionID string
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodOpenSession,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, &sessionID, nil, nil, nil); err != nil {
		return nil, err
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("%s 驱动代理未返回事务会话 ID", driverDisplayName(d.driverType))
	}
	session := &optionalDriverAgentSession{
		client:    client,
		driver:    d.driverType,
		sessionID: sessionID,
	}
	if searchPath := strings.TrimSpace(d.kingbaseSearchPath); searchPath != "" {
		if _, err := session.ExecContext(ctx, fmt.Sprintf("SET search_path TO %s", searchPath)); err != nil {
			_ = session.Close()
			return nil, fmt.Errorf("人大金仓会话初始化 search_path 失败：%w", err)
		}
	}
	return session, nil
}

func (d *optionalDriverAgentTransactionalDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if d == nil || d.OptionalDriverAgentDB == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var sessionID string
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodOpenTransaction,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, &sessionID, nil, nil, nil); err != nil {
		return nil, err
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("%s 驱动代理未返回事务 ID", driverDisplayName(d.driverType))
	}
	return &optionalDriverAgentTransaction{
		optionalDriverAgentSession: &optionalDriverAgentSession{
			client:    client,
			driver:    d.driverType,
			sessionID: sessionID,
		},
	}, nil
}

func (t *optionalDriverAgentTransaction) Commit() error {
	return t.finish(optionalAgentMethodCommitTransaction)
}

func (t *optionalDriverAgentTransaction) Rollback() error {
	return t.finish(optionalAgentMethodRollbackTransaction)
}

func (t *optionalDriverAgentTransaction) finish(method string) error {
	if t == nil || t.optionalDriverAgentSession == nil {
		return nil
	}
	t.finishMu.Lock()
	defer t.finishMu.Unlock()
	if t.finished {
		return nil
	}
	if err := t.ensureOpen(); err != nil {
		return err
	}
	t.finished = true
	// Commit/Rollback have no context in TransactionExecer. A fixed client-side
	// timeout can report failure after the server has already committed, leaving
	// the transaction outcome unknowable. Keep transaction finalization bounded
	// by the database/driver itself; app shutdown still force-closes the agent.
	return t.client.call(optionalAgentRequest{
		Method:    method,
		SessionID: t.sessionID,
	}, nil, nil, nil, nil)
}

func (s *optionalDriverAgentSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return s.QueryContext(context.Background(), query)
}

func (s *optionalDriverAgentSession) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return s.QueryContextWithMessages(context.Background(), query)
}

func (s *optionalDriverAgentSession) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return s.StreamQueryContext(context.Background(), query, consumer)
}

func (s *optionalDriverAgentSession) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	err := s.client.callStreamQueryContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodStreamQuery,
		SessionID: s.sessionID,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, consumer)
	if isOptionalAgentStreamUnsupportedError(err) {
		logger.Warnf("%s 驱动代理事务会话暂不支持流式查询，回退到缓冲模式：err=%v", driverDisplayName(s.driver), err)
		data, columns, queryErr := s.QueryContext(ctx, query)
		if queryErr != nil {
			return queryErr
		}
		if err := consumer.SetColumns(columns); err != nil {
			return err
		}
		for _, row := range data {
			if err := consumer.ConsumeRow(row); err != nil {
				return err
			}
		}
		return nil
	}
	return err
}

func (s *optionalDriverAgentSession) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	data, fields, _, err := s.QueryContextWithMessages(ctx, query)
	return data, fields, err
}

func (s *optionalDriverAgentSession) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, nil, nil, err
	}
	var data []map[string]interface{}
	var fields []string
	var messages []string
	if err := s.client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodQuery,
		SessionID: s.sessionID,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, &data, &fields, &messages, nil); err != nil {
		return nil, nil, nil, err
	}
	return data, fields, messages, nil
}

func (s *optionalDriverAgentSession) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *optionalDriverAgentSession) ExecContext(ctx context.Context, query string) (int64, error) {
	if err := s.ensureOpen(); err != nil {
		return 0, err
	}
	var affected int64
	if err := s.client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodExec,
		SessionID: s.sessionID,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, nil, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (s *optionalDriverAgentSession) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	sessionID := s.sessionID
	s.mu.Unlock()
	return s.client.callWithTimeout(optionalAgentRequest{
		Method:    optionalAgentMethodCloseSession,
		SessionID: sessionID,
	}, nil, nil, nil, nil, s.client.shutdownCallTimeout())
}

func (s *optionalDriverAgentSession) ensureOpen() error {
	if s == nil || s.client == nil {
		return fmt.Errorf("连接未打开")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || strings.TrimSpace(s.sessionID) == "" {
		return fmt.Errorf("%s 事务会话已关闭", driverDisplayName(s.driver))
	}
	return nil
}

func isOptionalAgentStreamUnsupportedError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.TrimSpace(err.Error())
	if text == "" {
		return false
	}
	return strings.Contains(text, "不支持的方法") || strings.Contains(text, "不支持流式查询")
}

func isOptionalAgentMultiResultUnsupportedError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.TrimSpace(err.Error())
	if text == "" {
		return false
	}
	return strings.Contains(text, "不支持的方法") ||
		strings.Contains(text, "不支持原生多结果集查询") ||
		strings.Contains(text, "不支持多结果集查询")
}

func (d *OptionalDriverAgentDB) GetDatabases() ([]string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var dbs []string
	if err := client.callWithTimeout(optionalAgentRequest{
		Method: optionalAgentMethodGetDatabases,
	}, &dbs, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return dbs, nil
}

func (d *OptionalDriverAgentDB) GetTables(dbName string) ([]string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var tables []string
	if err := client.callWithTimeout(optionalAgentRequest{
		Method: optionalAgentMethodGetTables,
		DBName: dbName,
	}, &tables, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return tables, nil
}

func (d *OptionalDriverAgentDB) GetTableRowCounts(_ string, tables []string) (map[string]int64, error) {
	if normalizeRuntimeDriverType(d.driverType) != "sqlite" {
		return map[string]int64{}, nil
	}
	return getSQLiteTableRowCounts(d.Query, tables)
}

func (d *OptionalDriverAgentDB) GetTableStorageStats(_ string, tables []string) (map[string]TableStorageStats, error) {
	if normalizeRuntimeDriverType(d.driverType) != "sqlite" {
		return map[string]TableStorageStats{}, nil
	}
	return getSQLiteTableStorageStats(d.Query, tables)
}

func (d *OptionalDriverAgentDB) GetCreateStatement(dbName, tableName string) (string, error) {
	client, err := d.requireClient()
	if err != nil {
		return "", err
	}
	var sqlText string
	if err := client.callWithTimeout(optionalAgentRequest{
		Method:    optionalAgentMethodGetCreateStmt,
		DBName:    dbName,
		TableName: tableName,
	}, &sqlText, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return "", err
	}
	return sqlText, nil
}

func (d *OptionalDriverAgentDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var columns []connection.ColumnDefinition
	if err := client.callWithTimeout(optionalAgentRequest{
		Method:    optionalAgentMethodGetColumns,
		DBName:    dbName,
		TableName: tableName,
	}, &columns, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return columns, nil
}

func (d *OptionalDriverAgentDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var columns []connection.ColumnDefinitionWithTable
	if err := client.callWithTimeout(optionalAgentRequest{
		Method: optionalAgentMethodGetAllColumns,
		DBName: dbName,
	}, &columns, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return columns, nil
}

func (d *OptionalDriverAgentDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var indexes []connection.IndexDefinition
	if err := client.callWithTimeout(optionalAgentRequest{
		Method:    optionalAgentMethodGetIndexes,
		DBName:    dbName,
		TableName: tableName,
	}, &indexes, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return indexes, nil
}

func (d *OptionalDriverAgentDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var keys []connection.ForeignKeyDefinition
	if err := client.callWithTimeout(optionalAgentRequest{
		Method:    optionalAgentMethodGetForeignKeys,
		DBName:    dbName,
		TableName: tableName,
	}, &keys, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return keys, nil
}

func (d *OptionalDriverAgentDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var triggers []connection.TriggerDefinition
	if err := client.callWithTimeout(optionalAgentRequest{
		Method:    optionalAgentMethodGetTriggers,
		DBName:    dbName,
		TableName: tableName,
	}, &triggers, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return triggers, nil
}

func (d *OptionalDriverAgentDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	if strings.EqualFold(d.driverType, "kingbase") {
		if normalized := normalizeKingbaseAgentTableName(tableName); normalized != "" {
			tableName = normalized
		}
		if normalized, normErr := d.normalizeKingbaseAgentChangeSet(tableName, changes); normErr == nil {
			changes = normalized
		} else {
			logger.Warnf("Kingbase ApplyChanges 字段名规范化失败：%v", normErr)
		}
	}
	return client.call(optionalAgentRequest{
		Method:    optionalAgentMethodApplyChanges,
		TableName: tableName,
		Changes:   &changes,
	}, nil, nil, nil, nil)
}

func (d *OptionalDriverAgentDB) requireClient() (*optionalDriverAgentClient, error) {
	if d.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return d.client, nil
}

func (d *OptionalDriverAgentDB) ensureKingbaseSearchPath(config connection.ConnectionConfig) {
	if !strings.EqualFold(d.driverType, "kingbase") {
		return
	}
	client, err := d.requireClient()
	if err != nil || client == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	schemas, err := d.listKingbaseSchemas(ctx)
	if err != nil || len(schemas) == 0 {
		if err != nil {
			logger.Warnf("人大金仓驱动代理探测 schema 失败：%v", err)
		}
		return
	}

	searchPath := buildKingbaseSearchPathFromSchemas(schemas)
	if strings.TrimSpace(searchPath) == "" {
		return
	}
	d.kingbaseSearchPath = searchPath

	if _, err := d.ExecContext(ctx, fmt.Sprintf("SET search_path TO %s", searchPath)); err != nil {
		logger.Warnf("人大金仓驱动代理设置 search_path 失败：%v", err)
		return
	}
	logger.Infof("人大金仓驱动代理已设置默认 search_path：%s", searchPath)
}

func (d *OptionalDriverAgentDB) listKingbaseSchemas(ctx context.Context) ([]string, error) {
	query := `SELECT nspname FROM pg_namespace
		WHERE nspname NOT IN ('pg_catalog', 'information_schema')
		  AND nspname NOT LIKE 'pg|_%' ESCAPE '|'
		ORDER BY nspname`
	rows, _, err := d.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}

	schemas := make([]string, 0, len(rows))
	for _, row := range rows {
		for key, val := range row {
			if strings.EqualFold(key, "nspname") || strings.EqualFold(key, "schema") {
				name := strings.TrimSpace(fmt.Sprintf("%v", val))
				if name != "" {
					schemas = append(schemas, name)
				}
				break
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				name := strings.TrimSpace(fmt.Sprintf("%v", val))
				if name != "" {
					schemas = append(schemas, name)
				}
				break
			}
		}
	}
	return schemas, nil
}

func buildKingbaseSearchPathFromSchemas(schemas []string) string {
	searchPath, _ := buildKingbaseSearchPathCommon(schemas)
	return searchPath
}

func quoteKingbaseAgentIdent(name string) string {
	n := normalizeKingbaseAgentIdent(name)
	if n == "" {
		return "\"\""
	}
	n = strings.ReplaceAll(n, `"`, `""`)
	return `"` + n + `"`
}

func normalizeKingbaseAgentTableName(raw string) string {
	schema, table := splitKingbaseQualifiedNameCommon(raw)
	if table == "" {
		return ""
	}
	if schema == "" {
		return table
	}
	return schema + "." + table
}

func normalizeKingbaseAgentIdent(raw string) string {
	return normalizeKingbaseIdentCommon(raw)
}

type kingbaseAgentColumnIndex struct {
	exact   map[string]string
	compact map[string]string
}

func buildKingbaseAgentColumnIndex(columns []string) kingbaseAgentColumnIndex {
	exact := make(map[string]string, len(columns))
	compact := make(map[string]string, len(columns))
	compactSeen := make(map[string]string, len(columns))
	compactDup := make(map[string]struct{}, len(columns))

	for _, col := range columns {
		name := normalizeKingbaseAgentIdent(col)
		if name == "" {
			continue
		}
		lower := strings.ToLower(name)
		if _, ok := exact[lower]; !ok {
			exact[lower] = name
		}
		key := normalizeKingbaseAgentCompactKey(name)
		if key == "" {
			continue
		}
		if prev, ok := compactSeen[key]; ok && !strings.EqualFold(prev, name) {
			compactDup[key] = struct{}{}
			continue
		}
		compactSeen[key] = name
	}

	if len(compactDup) > 0 {
		for key := range compactDup {
			delete(compactSeen, key)
		}
	}
	for key, value := range compactSeen {
		compact[key] = value
	}
	return kingbaseAgentColumnIndex{exact: exact, compact: compact}
}

func normalizeKingbaseAgentCompactKey(raw string) string {
	name := normalizeKingbaseAgentIdent(raw)
	if name == "" {
		return ""
	}
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.Join(strings.Fields(name), "")
	name = strings.ReplaceAll(name, "_", "")
	return name
}

func resolveKingbaseAgentColumnName(name string, index kingbaseAgentColumnIndex) string {
	cleaned := normalizeKingbaseAgentIdent(name)
	if cleaned == "" {
		return name
	}
	lower := strings.ToLower(cleaned)
	if actual, ok := index.exact[lower]; ok {
		return actual
	}
	compact := normalizeKingbaseAgentCompactKey(cleaned)
	if actual, ok := index.compact[compact]; ok {
		return actual
	}
	return cleaned
}

func normalizeKingbaseAgentChangeSetByColumns(changes connection.ChangeSet, columns []string) (connection.ChangeSet, error) {
	index := buildKingbaseAgentColumnIndex(columns)
	if len(index.exact) == 0 && len(index.compact) == 0 {
		return changes, nil
	}

	mapRow := func(row map[string]interface{}) (map[string]interface{}, error) {
		if row == nil {
			return row, nil
		}
		out := make(map[string]interface{}, len(row))
		for key, value := range row {
			nextKey := resolveKingbaseAgentColumnName(key, index)
			if existing, ok := out[nextKey]; ok && !reflect.DeepEqual(existing, value) {
				return nil, fmt.Errorf("duplicate mapped column %q", nextKey)
			}
			out[nextKey] = value
		}
		return out, nil
	}

	next := connection.ChangeSet{
		Inserts: make([]map[string]interface{}, 0, len(changes.Inserts)),
		Updates: make([]connection.UpdateRow, 0, len(changes.Updates)),
		Deletes: make([]map[string]interface{}, 0, len(changes.Deletes)),
	}

	for _, row := range changes.Inserts {
		mapped, err := mapRow(row)
		if err != nil {
			return changes, err
		}
		next.Inserts = append(next.Inserts, mapped)
	}

	for _, upd := range changes.Updates {
		keys, err := mapRow(upd.Keys)
		if err != nil {
			return changes, err
		}
		values, err := mapRow(upd.Values)
		if err != nil {
			return changes, err
		}
		next.Updates = append(next.Updates, connection.UpdateRow{
			Keys:   keys,
			Values: values,
		})
	}

	for _, row := range changes.Deletes {
		mapped, err := mapRow(row)
		if err != nil {
			return changes, err
		}
		next.Deletes = append(next.Deletes, mapped)
	}

	return next, nil
}

func (d *OptionalDriverAgentDB) normalizeKingbaseAgentChangeSet(tableName string, changes connection.ChangeSet) (connection.ChangeSet, error) {
	columns, err := d.GetColumns("", tableName)
	if err != nil {
		return changes, err
	}
	if len(columns) == 0 {
		return changes, nil
	}
	names := make([]string, 0, len(columns))
	for _, col := range columns {
		name := strings.TrimSpace(col.Name)
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return normalizeKingbaseAgentChangeSetByColumns(changes, names)
}

func timeoutMsFromContext(ctx context.Context) int64 {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 0
	}
	remaining := time.Until(deadline).Milliseconds()
	if remaining <= 0 {
		return 1
	}
	return remaining
}
