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

	"GoNavi-Wails/internal/connection"
)

const (
	optionalAgentMethodConnect          = "connect"
	optionalAgentMethodClose            = "close"
	optionalAgentMethodPing             = "ping"
	optionalAgentMethodQuery            = "query"
	optionalAgentMethodExec             = "exec"
	optionalAgentMethodGetDatabases     = "getDatabases"
	optionalAgentMethodGetTables        = "getTables"
	optionalAgentMethodGetCreateStmt    = "getCreateStatement"
	optionalAgentMethodGetColumns       = "getColumns"
	optionalAgentMethodGetAllColumns    = "getAllColumns"
	optionalAgentMethodGetIndexes       = "getIndexes"
	optionalAgentMethodGetForeignKeys   = "getForeignKeys"
	optionalAgentMethodGetTriggers      = "getTriggers"
	optionalAgentMethodApplyChanges     = "applyChanges"
	optionalAgentDefaultScannerMaxBytes = 8 << 20
)

type optionalAgentRequest struct {
	ID        int64                        `json:"id"`
	Method    string                       `json:"method"`
	Config    *connection.ConnectionConfig `json:"config,omitempty"`
	Query     string                       `json:"query,omitempty"`
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
	RowsAffected int64           `json:"rowsAffected,omitempty"`
}

type optionalDriverAgentClient struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	reader   *bufio.Reader
	nextID   int64
	mu       sync.Mutex
	stderrMu sync.Mutex
	stderr   strings.Builder
	driver   string
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
		return nil, fmt.Errorf("启动 %s 驱动代理失败：%w", driverDisplayName(driverType), err)
	}

	client := &optionalDriverAgentClient{
		cmd:    cmd,
		stdin:  stdin,
		reader: bufio.NewReader(stdout),
		driver: normalizeRuntimeDriverType(driverType),
	}
	go client.captureStderr(stderr)
	return client, nil
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
		c.stderrMu.Lock()
		if c.stderr.Len() > 0 {
			c.stderr.WriteString(" | ")
		}
		c.stderr.WriteString(line)
		c.stderrMu.Unlock()
	}
}

func (c *optionalDriverAgentClient) stderrText() string {
	c.stderrMu.Lock()
	defer c.stderrMu.Unlock()
	return strings.TrimSpace(c.stderr.String())
}

func (c *optionalDriverAgentClient) call(req optionalAgentRequest, out interface{}, fields *[]string, rowsAffected *int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

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
	if rowsAffected != nil {
		*rowsAffected = resp.RowsAffected
	}
	if out != nil && len(resp.Data) > 0 {
		if err := json.Unmarshal(resp.Data, out); err != nil {
			return fmt.Errorf("解析 %s 驱动代理数据失败：%w", driverDisplayName(c.driver), err)
		}
	}
	return nil
}

func (c *optionalDriverAgentClient) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var closeErr error
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	if c.cmd != nil && c.cmd.Process != nil {
		if err := c.cmd.Process.Kill(); err != nil {
			closeErr = err
		}
	}
	if c.cmd != nil {
		_ = c.cmd.Wait()
	}
	return closeErr
}

type OptionalDriverAgentDB struct {
	driverType string
	client     *optionalDriverAgentClient
}

func newOptionalDriverAgentDatabase(driverType string) databaseFactory {
	normalized := normalizeRuntimeDriverType(driverType)
	return func() Database {
		return &OptionalDriverAgentDB{driverType: normalized}
	}
}

func (d *OptionalDriverAgentDB) Connect(config connection.ConnectionConfig) error {
	if d.client != nil {
		_ = d.client.close()
		d.client = nil
	}

	executablePath, err := ResolveOptionalDriverAgentExecutablePath("", d.driverType)
	if err != nil {
		return err
	}
	client, err := newOptionalDriverAgentClient(d.driverType, executablePath)
	if err != nil {
		return err
	}
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodConnect,
		Config: &config,
	}, nil, nil, nil); err != nil {
		_ = client.close()
		return err
	}
	d.client = client
	return nil
}

func (d *OptionalDriverAgentDB) Close() error {
	if d.client == nil {
		return nil
	}
	_ = d.client.call(optionalAgentRequest{Method: optionalAgentMethodClose}, nil, nil, nil)
	err := d.client.close()
	d.client = nil
	return err
}

func (d *OptionalDriverAgentDB) Ping() error {
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	return client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil)
}

func (d *OptionalDriverAgentDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	return d.Query(query)
}

func (d *OptionalDriverAgentDB) Query(query string) ([]map[string]interface{}, []string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, err
	}
	var data []map[string]interface{}
	var fields []string
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodQuery,
		Query:  query,
	}, &data, &fields, nil); err != nil {
		return nil, nil, err
	}
	return data, fields, nil
}

func (d *OptionalDriverAgentDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return d.Exec(query)
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
	}, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (d *OptionalDriverAgentDB) GetDatabases() ([]string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var dbs []string
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodGetDatabases,
	}, &dbs, nil, nil); err != nil {
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
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodGetTables,
		DBName: dbName,
	}, &tables, nil, nil); err != nil {
		return nil, err
	}
	return tables, nil
}

func (d *OptionalDriverAgentDB) GetCreateStatement(dbName, tableName string) (string, error) {
	client, err := d.requireClient()
	if err != nil {
		return "", err
	}
	var sqlText string
	if err := client.call(optionalAgentRequest{
		Method:    optionalAgentMethodGetCreateStmt,
		DBName:    dbName,
		TableName: tableName,
	}, &sqlText, nil, nil); err != nil {
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
	if err := client.call(optionalAgentRequest{
		Method:    optionalAgentMethodGetColumns,
		DBName:    dbName,
		TableName: tableName,
	}, &columns, nil, nil); err != nil {
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
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodGetAllColumns,
		DBName: dbName,
	}, &columns, nil, nil); err != nil {
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
	if err := client.call(optionalAgentRequest{
		Method:    optionalAgentMethodGetIndexes,
		DBName:    dbName,
		TableName: tableName,
	}, &indexes, nil, nil); err != nil {
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
	if err := client.call(optionalAgentRequest{
		Method:    optionalAgentMethodGetForeignKeys,
		DBName:    dbName,
		TableName: tableName,
	}, &keys, nil, nil); err != nil {
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
	if err := client.call(optionalAgentRequest{
		Method:    optionalAgentMethodGetTriggers,
		DBName:    dbName,
		TableName: tableName,
	}, &triggers, nil, nil); err != nil {
		return nil, err
	}
	return triggers, nil
}

func (d *OptionalDriverAgentDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	return client.call(optionalAgentRequest{
		Method:    optionalAgentMethodApplyChanges,
		TableName: tableName,
		Changes:   &changes,
	}, nil, nil, nil)
}

func (d *OptionalDriverAgentDB) requireClient() (*optionalDriverAgentClient, error) {
	if d.client == nil {
		return nil, fmt.Errorf("connection not open")
	}
	return d.client, nil
}
