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
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
)

const (
	mysqlAgentMethodConnect          = "connect"
	mysqlAgentMethodClose            = "close"
	mysqlAgentMethodPing             = "ping"
	mysqlAgentMethodQuery            = "query"
	mysqlAgentMethodExec             = "exec"
	mysqlAgentMethodGetDatabases     = "getDatabases"
	mysqlAgentMethodGetTables        = "getTables"
	mysqlAgentMethodGetCreateStmt    = "getCreateStatement"
	mysqlAgentMethodGetColumns       = "getColumns"
	mysqlAgentMethodGetAllColumns    = "getAllColumns"
	mysqlAgentMethodGetIndexes       = "getIndexes"
	mysqlAgentMethodGetForeignKeys   = "getForeignKeys"
	mysqlAgentMethodGetTriggers      = "getTriggers"
	mysqlAgentMethodApplyChanges     = "applyChanges"
	mysqlAgentDefaultScannerMaxBytes = 8 << 20
	mysqlAgentControlCallTimeout     = 30 * time.Second
	mysqlAgentShutdownCallTimeout    = 2 * time.Second
)

var errMySQLAgentTransportStopped = errors.New("MySQL 驱动代理传输已关闭")

type mysqlAgentRequest struct {
	ID        int64                        `json:"id"`
	Method    string                       `json:"method"`
	Config    *connection.ConnectionConfig `json:"config,omitempty"`
	Query     string                       `json:"query,omitempty"`
	DBName    string                       `json:"dbName,omitempty"`
	TableName string                       `json:"tableName,omitempty"`
	Changes   *connection.ChangeSet        `json:"changes,omitempty"`
}

type mysqlAgentResponse struct {
	ID           int64           `json:"id"`
	Success      bool            `json:"success"`
	Error        string          `json:"error,omitempty"`
	Data         json.RawMessage `json:"data,omitempty"`
	Fields       []string        `json:"fields,omitempty"`
	RowsAffected int64           `json:"rowsAffected,omitempty"`
}

type mysqlAgentClient struct {
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
	shutdownTimeout time.Duration
}

func newMySQLAgentClient(executablePath string) (*mysqlAgentClient, error) {
	pathText := strings.TrimSpace(executablePath)
	if pathText == "" {
		return nil, fmt.Errorf("MySQL 驱动代理路径为空")
	}
	info, err := os.Stat(pathText)
	if err != nil {
		return nil, fmt.Errorf("MySQL 驱动代理不存在：%s", pathText)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("MySQL 驱动代理路径是目录：%s", pathText)
	}

	cmd := exec.Command(pathText)
	configureAgentProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 MySQL 驱动代理 stdin 失败：%w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 MySQL 驱动代理 stdout 失败：%w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 MySQL 驱动代理 stderr 失败：%w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 MySQL 驱动代理失败：%w", err)
	}

	client := &mysqlAgentClient{
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		reader: bufio.NewReader(stdout),
	}
	go client.captureStderr(stderr)
	return client, nil
}

func (c *mysqlAgentClient) captureStderr(stderr io.Reader) {
	scanner := bufio.NewScanner(stderr)
	buffer := make([]byte, 0, 8<<10)
	scanner.Buffer(buffer, mysqlAgentDefaultScannerMaxBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		c.stderr.Append(line)
	}
}

func (c *mysqlAgentClient) stderrText() string {
	return strings.TrimSpace(c.stderr.String())
}

func (c *mysqlAgentClient) call(req mysqlAgentRequest, out interface{}, fields *[]string, rowsAffected *int64) error {
	return c.runWithContext(context.Background(), req.Method, func() error {
		return c.callLocked(req, out, fields, rowsAffected)
	})
}

func (c *mysqlAgentClient) callContext(ctx context.Context, req mysqlAgentRequest, out interface{}, fields *[]string, rowsAffected *int64) error {
	return c.runWithContext(ctx, req.Method, func() error {
		return c.callLocked(req, out, fields, rowsAffected)
	})
}

func (c *mysqlAgentClient) callLocked(req mysqlAgentRequest, out interface{}, fields *[]string, rowsAffected *int64) error {
	if err := c.stoppedError(); err != nil {
		return fmt.Errorf("MySQL 驱动代理传输不可用：%w", err)
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
		_ = c.forceTerminate(err)
		if stderrText == "" {
			return fmt.Errorf("调用 MySQL 驱动代理失败：%w", err)
		}
		return fmt.Errorf("调用 MySQL 驱动代理失败：%w（stderr: %s）", err, stderrText)
	}

	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		stderrText := c.stderrText()
		_ = c.forceTerminate(err)
		if stderrText == "" {
			return fmt.Errorf("读取 MySQL 驱动代理响应失败：%w", err)
		}
		return fmt.Errorf("读取 MySQL 驱动代理响应失败：%w（stderr: %s）", err, stderrText)
	}

	var resp mysqlAgentResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		_ = c.forceTerminate(err)
		return fmt.Errorf("解析 MySQL 驱动代理响应失败：%w", err)
	}
	if resp.ID != req.ID {
		violation := fmt.Errorf("MySQL 驱动代理协议错误：响应 ID 不匹配：收到 %d，期望 %d", resp.ID, req.ID)
		_ = c.forceTerminate(violation)
		return violation
	}
	if !resp.Success {
		errText := strings.TrimSpace(resp.Error)
		if errText == "" {
			errText = "MySQL 驱动代理返回失败"
		}
		return errors.New(errText)
	}

	if fields != nil {
		*fields = resp.Fields
	}
	if rowsAffected != nil {
		*rowsAffected = resp.RowsAffected
	}
	if out != nil && len(resp.Data) > 0 {
		if err := decodeJSONWithUseNumber(resp.Data, out); err != nil {
			return fmt.Errorf("解析 MySQL 驱动代理数据失败：%w", err)
		}
	}
	return nil
}

func (c *mysqlAgentClient) runWithContext(ctx context.Context, method string, operation func() error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return mysqlAgentContextError(method, err)
	}
	if err := c.acquireCallGate(ctx); err != nil {
		return mysqlAgentContextError(method, err)
	}
	defer c.releaseCallGate()
	if err := ctx.Err(); err != nil {
		return mysqlAgentContextError(method, err)
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
	return mysqlAgentContextError(method, ctx.Err())
}

func (c *mysqlAgentClient) acquireCallGate(ctx context.Context) error {
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

func (c *mysqlAgentClient) releaseCallGate() {
	c.callGateChannel() <- struct{}{}
}

func (c *mysqlAgentClient) callGateChannel() chan struct{} {
	c.callGateOnce.Do(func() {
		c.callGate = make(chan struct{}, 1)
		c.callGate <- struct{}{}
	})
	return c.callGate
}

func mysqlAgentContextError(method string, err error) error {
	if err == nil {
		err = context.Canceled
	}
	action := strings.TrimSpace(method)
	if action == "" {
		action = "IPC"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("MySQL 驱动代理 %s 请求超时：%w", action, err)
	}
	return fmt.Errorf("MySQL 驱动代理 %s 请求已取消：%w", action, err)
}

func (c *mysqlAgentClient) callWithTimeout(req mysqlAgentRequest, out interface{}, fields *[]string, rowsAffected *int64, timeout time.Duration) error {
	if timeout <= 0 {
		return c.call(req, out, fields, rowsAffected)
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return c.callContext(ctx, req, out, fields, rowsAffected)
}

func (c *mysqlAgentClient) stoppedError() error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.stopped
}

func (c *mysqlAgentClient) markStopped(cause error) {
	stoppedErr := errMySQLAgentTransportStopped
	if cause != nil && !errors.Is(cause, errMySQLAgentTransportStopped) {
		stoppedErr = fmt.Errorf("%w（原因：%v）", errMySQLAgentTransportStopped, cause)
	}
	c.stateMu.Lock()
	if c.stopped == nil {
		c.stopped = stoppedErr
	}
	c.stateMu.Unlock()
}

func (c *mysqlAgentClient) forceTerminate(cause error) error {
	// A terminated transport is never reused: a response may still be buffered
	// in the killed agent, so recovery must create a fresh client via Connect.
	c.markStopped(cause)
	return c.stopProcess(true)
}

func (c *mysqlAgentClient) stopProcess(force bool) error {
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

func (c *mysqlAgentClient) close() error {
	c.markStopped(errMySQLAgentTransportStopped)
	return c.stopProcess(false)
}

func (c *mysqlAgentClient) shutdownCallTimeout() time.Duration {
	if c.shutdownTimeout > 0 {
		return c.shutdownTimeout
	}
	return mysqlAgentShutdownCallTimeout
}

type MySQLAgentDB struct {
	lifecycleMu sync.Mutex
	clientMu    sync.RWMutex
	client      *mysqlAgentClient
}

var _ QueryContexter = (*MySQLAgentDB)(nil)
var _ ExecContexter = (*MySQLAgentDB)(nil)

func (m *MySQLAgentDB) Connect(config connection.ConnectionConfig) error {
	// Connect deliberately replaces any prior client, including one stopped by
	// a cancelled request; cancelled SQL is never replayed on the new process.
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()

	oldClient := m.takeClient()
	if oldClient != nil {
		_ = oldClient.close()
	}

	executablePath, err := ResolveMySQLAgentExecutablePath("")
	if err != nil {
		return err
	}
	client, err := newMySQLAgentClient(executablePath)
	if err != nil {
		return err
	}
	if err := client.call(mysqlAgentRequest{
		Method: mysqlAgentMethodConnect,
		Config: &config,
	}, nil, nil, nil); err != nil {
		_ = client.close()
		return err
	}
	m.setClient(client)
	return nil
}

func (m *MySQLAgentDB) Close() error {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()

	client := m.takeClient()
	if client == nil {
		return nil
	}
	closeErr := client.callWithTimeout(
		mysqlAgentRequest{Method: mysqlAgentMethodClose},
		nil,
		nil,
		nil,
		client.shutdownCallTimeout(),
	)
	if closeErr != nil {
		return client.forceTerminate(closeErr)
	}
	err := client.close()
	return err
}

func (m *MySQLAgentDB) Ping() error {
	ctx, cancel := context.WithTimeout(context.Background(), mysqlAgentControlCallTimeout)
	defer cancel()
	return m.PingContext(ctx)
}

func (m *MySQLAgentDB) PingContext(ctx context.Context) error {
	client, err := m.requireClient()
	if err != nil {
		return err
	}
	return client.callContext(ctx, mysqlAgentRequest{Method: mysqlAgentMethodPing}, nil, nil, nil)
}

func (m *MySQLAgentDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	client, err := m.requireClient()
	if err != nil {
		return nil, nil, err
	}
	var data []map[string]interface{}
	var fields []string
	if err := client.callContext(ctx, mysqlAgentRequest{
		Method: mysqlAgentMethodQuery,
		Query:  query,
	}, &data, &fields, nil); err != nil {
		return nil, nil, err
	}
	return data, fields, nil
}

func (m *MySQLAgentDB) Query(query string) ([]map[string]interface{}, []string, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, nil, err
	}
	var data []map[string]interface{}
	var fields []string
	if err := client.call(mysqlAgentRequest{
		Method: mysqlAgentMethodQuery,
		Query:  query,
	}, &data, &fields, nil); err != nil {
		return nil, nil, err
	}
	return data, fields, nil
}

func (m *MySQLAgentDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	client, err := m.requireClient()
	if err != nil {
		return 0, err
	}
	var affected int64
	if err := client.callContext(ctx, mysqlAgentRequest{
		Method: mysqlAgentMethodExec,
		Query:  query,
	}, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (m *MySQLAgentDB) Exec(query string) (int64, error) {
	client, err := m.requireClient()
	if err != nil {
		return 0, err
	}
	var affected int64
	if err := client.call(mysqlAgentRequest{
		Method: mysqlAgentMethodExec,
		Query:  query,
	}, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (m *MySQLAgentDB) GetDatabases() ([]string, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, err
	}
	var dbs []string
	if err := client.call(mysqlAgentRequest{
		Method: mysqlAgentMethodGetDatabases,
	}, &dbs, nil, nil); err != nil {
		return nil, err
	}
	return dbs, nil
}

func (m *MySQLAgentDB) GetTables(dbName string) ([]string, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, err
	}
	var tables []string
	if err := client.call(mysqlAgentRequest{
		Method: mysqlAgentMethodGetTables,
		DBName: dbName,
	}, &tables, nil, nil); err != nil {
		return nil, err
	}
	return tables, nil
}

func (m *MySQLAgentDB) GetCreateStatement(dbName, tableName string) (string, error) {
	client, err := m.requireClient()
	if err != nil {
		return "", err
	}
	var sqlText string
	if err := client.call(mysqlAgentRequest{
		Method:    mysqlAgentMethodGetCreateStmt,
		DBName:    dbName,
		TableName: tableName,
	}, &sqlText, nil, nil); err != nil {
		return "", err
	}
	return sqlText, nil
}

func (m *MySQLAgentDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, err
	}
	var columns []connection.ColumnDefinition
	if err := client.call(mysqlAgentRequest{
		Method:    mysqlAgentMethodGetColumns,
		DBName:    dbName,
		TableName: tableName,
	}, &columns, nil, nil); err != nil {
		return nil, err
	}
	return columns, nil
}

func (m *MySQLAgentDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, err
	}
	var columns []connection.ColumnDefinitionWithTable
	if err := client.call(mysqlAgentRequest{
		Method: mysqlAgentMethodGetAllColumns,
		DBName: dbName,
	}, &columns, nil, nil); err != nil {
		return nil, err
	}
	return columns, nil
}

func (m *MySQLAgentDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, err
	}
	var indexes []connection.IndexDefinition
	if err := client.call(mysqlAgentRequest{
		Method:    mysqlAgentMethodGetIndexes,
		DBName:    dbName,
		TableName: tableName,
	}, &indexes, nil, nil); err != nil {
		return nil, err
	}
	return indexes, nil
}

func (m *MySQLAgentDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, err
	}
	var keys []connection.ForeignKeyDefinition
	if err := client.call(mysqlAgentRequest{
		Method:    mysqlAgentMethodGetForeignKeys,
		DBName:    dbName,
		TableName: tableName,
	}, &keys, nil, nil); err != nil {
		return nil, err
	}
	return keys, nil
}

func (m *MySQLAgentDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	client, err := m.requireClient()
	if err != nil {
		return nil, err
	}
	var triggers []connection.TriggerDefinition
	if err := client.call(mysqlAgentRequest{
		Method:    mysqlAgentMethodGetTriggers,
		DBName:    dbName,
		TableName: tableName,
	}, &triggers, nil, nil); err != nil {
		return nil, err
	}
	return triggers, nil
}

func (m *MySQLAgentDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	client, err := m.requireClient()
	if err != nil {
		return err
	}
	return client.call(mysqlAgentRequest{
		Method:    mysqlAgentMethodApplyChanges,
		TableName: tableName,
		Changes:   &changes,
	}, nil, nil, nil)
}

func (m *MySQLAgentDB) requireClient() (*mysqlAgentClient, error) {
	m.clientMu.RLock()
	client := m.client
	m.clientMu.RUnlock()
	if client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return client, nil
}

func (m *MySQLAgentDB) takeClient() *mysqlAgentClient {
	m.clientMu.Lock()
	client := m.client
	m.client = nil
	m.clientMu.Unlock()
	return client
}

func (m *MySQLAgentDB) setClient(client *mysqlAgentClient) {
	m.clientMu.Lock()
	m.client = client
	m.clientMu.Unlock()
}
