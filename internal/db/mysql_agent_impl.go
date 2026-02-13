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
)

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
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	reader   *bufio.Reader
	nextID   int64
	mu       sync.Mutex
	stderrMu sync.Mutex
	stderr   strings.Builder
}

func newMySQLAgentClient(executablePath string) (*mysqlAgentClient, error) {
	pathText := strings.TrimSpace(executablePath)
	if pathText == "" {
		return nil, fmt.Errorf("MySQL 驱动代理路径为空")
	}
	if info, err := os.Stat(pathText); err != nil || info.IsDir() {
		return nil, fmt.Errorf("MySQL 驱动代理不存在：%s", pathText)
	}

	cmd := exec.Command(pathText)
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
		c.stderrMu.Lock()
		if c.stderr.Len() > 0 {
			c.stderr.WriteString(" | ")
		}
		c.stderr.WriteString(line)
		c.stderrMu.Unlock()
	}
}

func (c *mysqlAgentClient) stderrText() string {
	c.stderrMu.Lock()
	defer c.stderrMu.Unlock()
	return strings.TrimSpace(c.stderr.String())
}

func (c *mysqlAgentClient) call(req mysqlAgentRequest, out interface{}, fields *[]string, rowsAffected *int64) error {
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
			return fmt.Errorf("调用 MySQL 驱动代理失败：%w", err)
		}
		return fmt.Errorf("调用 MySQL 驱动代理失败：%w（stderr: %s）", err, stderrText)
	}

	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		stderrText := c.stderrText()
		if stderrText == "" {
			return fmt.Errorf("读取 MySQL 驱动代理响应失败：%w", err)
		}
		return fmt.Errorf("读取 MySQL 驱动代理响应失败：%w（stderr: %s）", err, stderrText)
	}

	var resp mysqlAgentResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return fmt.Errorf("解析 MySQL 驱动代理响应失败：%w", err)
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
		if err := json.Unmarshal(resp.Data, out); err != nil {
			return fmt.Errorf("解析 MySQL 驱动代理数据失败：%w", err)
		}
	}
	return nil
}

func (c *mysqlAgentClient) close() error {
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

type MySQLAgentDB struct {
	client *mysqlAgentClient
}

func (m *MySQLAgentDB) Connect(config connection.ConnectionConfig) error {
	if m.client != nil {
		_ = m.client.close()
		m.client = nil
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
	m.client = client
	return nil
}

func (m *MySQLAgentDB) Close() error {
	if m.client == nil {
		return nil
	}
	_ = m.client.call(mysqlAgentRequest{Method: mysqlAgentMethodClose}, nil, nil, nil)
	err := m.client.close()
	m.client = nil
	return err
}

func (m *MySQLAgentDB) Ping() error {
	client, err := m.requireClient()
	if err != nil {
		return err
	}
	return client.call(mysqlAgentRequest{Method: mysqlAgentMethodPing}, nil, nil, nil)
}

func (m *MySQLAgentDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	return m.Query(query)
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
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return m.Exec(query)
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
	if m.client == nil {
		return nil, fmt.Errorf("connection not open")
	}
	return m.client, nil
}
