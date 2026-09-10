package db

import (
	"context"
	"database/sql/driver"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	mysql "github.com/go-sql-driver/mysql"
)

const (
	navicatMySQLTunnelMagic                       = 1111
	maxNavicatMySQLTunnelResponseBytes            = 128 << 20
	maxNavicatMySQLTunnelDecodedAllocBytes        = 64 << 20
	maxNavicatMySQLTunnelFields                   = 4096
	maxNavicatMySQLTunnelRows                     = 1_000_000
	maxNavicatMySQLTunnelCells             uint64 = 2_000_000
)

type navicatMySQLTunnelConnector struct {
	client *navicatMySQLTunnelClient
}

type navicatMySQLTunnelDriver struct{}

type navicatMySQLTunnelConn struct {
	client *navicatMySQLTunnelClient
}

type navicatMySQLTunnelStmt struct {
	conn  *navicatMySQLTunnelConn
	query string
}

type navicatMySQLTunnelClient struct {
	endpoint   string
	httpClient *http.Client
	host       string
	port       int
	login      string
	password   string
	database   string
	webUser    string
	webPass    string
	base64SQL  bool
}

type navicatMySQLTunnelResult struct {
	fields       []navicatMySQLTunnelField
	rows         [][]driver.Value
	affectedRows int64
	insertID     int64
	info         string
}

type navicatMySQLTunnelField struct {
	name       string
	table      string
	typeID     uint32
	flags      uint32
	length     uint32
	databaseTy string
}

type navicatMySQLTunnelRows struct {
	fields []navicatMySQLTunnelField
	rows   [][]driver.Value
	index  int
}

type navicatMySQLTunnelExecResult struct {
	lastInsertID int64
	rowsAffected int64
}

type navicatMySQLTunnelProtocolError struct {
	code    uint32
	message string
}

type navicatMySQLTunnelParser struct {
	body                  []byte
	offset                int
	decodedAllocationSize uint64
}

var (
	_ driver.Connector                      = (*navicatMySQLTunnelConnector)(nil)
	_ driver.Driver                         = navicatMySQLTunnelDriver{}
	_ driver.Conn                           = (*navicatMySQLTunnelConn)(nil)
	_ driver.ConnPrepareContext             = (*navicatMySQLTunnelConn)(nil)
	_ driver.Pinger                         = (*navicatMySQLTunnelConn)(nil)
	_ driver.QueryerContext                 = (*navicatMySQLTunnelConn)(nil)
	_ driver.ExecerContext                  = (*navicatMySQLTunnelConn)(nil)
	_ driver.ConnBeginTx                    = (*navicatMySQLTunnelConn)(nil)
	_ driver.Stmt                           = (*navicatMySQLTunnelStmt)(nil)
	_ driver.StmtQueryContext               = (*navicatMySQLTunnelStmt)(nil)
	_ driver.StmtExecContext                = (*navicatMySQLTunnelStmt)(nil)
	_ driver.Rows                           = (*navicatMySQLTunnelRows)(nil)
	_ driver.RowsColumnTypeDatabaseTypeName = (*navicatMySQLTunnelRows)(nil)
	_ driver.RowsColumnTypeLength           = (*navicatMySQLTunnelRows)(nil)
	_ driver.RowsColumnTypeScanType         = (*navicatMySQLTunnelRows)(nil)
	_ driver.Result                         = navicatMySQLTunnelExecResult{}
)

func isNavicatMySQLTunnelURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https")
}

func newNavicatMySQLTunnelConnector(config connection.ConnectionConfig) (*navicatMySQLTunnelConnector, error) {
	endpoint := strings.TrimSpace(config.HTTPTunnel.Host)
	if !isNavicatMySQLTunnelURL(endpoint) {
		return nil, fmt.Errorf("Navicat HTTP 隧道地址无效：必须填写完整的 http:// 或 https:// URL")
	}
	port := config.Port
	if port <= 0 {
		port = resolveMySQLCompatibleDefaultPort(config)
	}
	return &navicatMySQLTunnelConnector{client: &navicatMySQLTunnelClient{
		endpoint: endpoint,
		httpClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			// A 307/308 redirect would replay database credentials and SQL in the
			// POST body to a different endpoint. Tunnel URLs must be explicit.
			return http.ErrUseLastResponse
		}},
		host:      strings.TrimSpace(config.Host),
		port:      port,
		login:     config.User,
		password:  config.Password,
		database:  config.Database,
		webUser:   strings.TrimSpace(config.HTTPTunnel.User),
		webPass:   config.HTTPTunnel.Password,
		base64SQL: config.HTTPTunnel.EncodeBase64 == nil || *config.HTTPTunnel.EncodeBase64,
	}}, nil
}

func (c *navicatMySQLTunnelConnector) Connect(context.Context) (driver.Conn, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("Navicat HTTP 隧道连接器未初始化")
	}
	return &navicatMySQLTunnelConn{client: c.client}, nil
}

func (*navicatMySQLTunnelConnector) Driver() driver.Driver {
	return navicatMySQLTunnelDriver{}
}

func (navicatMySQLTunnelDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("Navicat HTTP 隧道必须通过 Connector 打开")
}

func (c *navicatMySQLTunnelConn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *navicatMySQLTunnelConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	return &navicatMySQLTunnelStmt{conn: c, query: query}, nil
}

func (*navicatMySQLTunnelConn) Close() error { return nil }

func (*navicatMySQLTunnelConn) Begin() (driver.Tx, error) {
	return nil, navicatMySQLTunnelTransactionError()
}

func (*navicatMySQLTunnelConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return nil, navicatMySQLTunnelTransactionError()
}

func (c *navicatMySQLTunnelConn) Ping(ctx context.Context) error {
	if c == nil || c.client == nil {
		return errors.New("Navicat HTTP 隧道连接未初始化")
	}
	return c.client.ping(ctx)
}

func (c *navicatMySQLTunnelConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("Navicat HTTP 隧道连接未初始化")
	}
	interpolated, err := interpolateNavicatMySQLQuery(query, args)
	if err != nil {
		return nil, err
	}
	if isNavicatMySQLTransactionControl(interpolated) {
		return nil, navicatMySQLTunnelTransactionError()
	}
	result, err := c.client.query(ctx, interpolated)
	if err != nil {
		return nil, err
	}
	return &navicatMySQLTunnelRows{fields: result.fields, rows: result.rows}, nil
}

func (c *navicatMySQLTunnelConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("Navicat HTTP 隧道连接未初始化")
	}
	interpolated, err := interpolateNavicatMySQLQuery(query, args)
	if err != nil {
		return nil, err
	}
	if isNavicatMySQLTransactionControl(interpolated) {
		return nil, navicatMySQLTunnelTransactionError()
	}
	result, err := c.client.query(ctx, interpolated)
	if err != nil {
		return nil, err
	}
	return navicatMySQLTunnelExecResult{
		lastInsertID: result.insertID,
		rowsAffected: result.affectedRows,
	}, nil
}

func (*navicatMySQLTunnelStmt) Close() error { return nil }

func (*navicatMySQLTunnelStmt) NumInput() int { return -1 }

func (s *navicatMySQLTunnelStmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.QueryContext(context.Background(), namedValuesFromDriverValues(args))
}

func (s *navicatMySQLTunnelStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.conn.QueryContext(ctx, s.query, args)
}

func (s *navicatMySQLTunnelStmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.ExecContext(context.Background(), namedValuesFromDriverValues(args))
}

func (s *navicatMySQLTunnelStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.conn.ExecContext(ctx, s.query, args)
}

func namedValuesFromDriverValues(values []driver.Value) []driver.NamedValue {
	result := make([]driver.NamedValue, len(values))
	for index, value := range values {
		result[index] = driver.NamedValue{Ordinal: index + 1, Value: value}
	}
	return result
}

func (r *navicatMySQLTunnelRows) Columns() []string {
	columns := make([]string, len(r.fields))
	for index := range r.fields {
		columns[index] = r.fields[index].name
	}
	return columns
}

func (*navicatMySQLTunnelRows) Close() error { return nil }

func (r *navicatMySQLTunnelRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.index]
	for index := range dest {
		if index < len(row) {
			dest[index] = row[index]
		} else {
			dest[index] = nil
		}
	}
	r.index++
	return nil
}

func (r *navicatMySQLTunnelRows) ColumnTypeDatabaseTypeName(index int) string {
	if index < 0 || index >= len(r.fields) {
		return ""
	}
	return r.fields[index].databaseTy
}

func (r *navicatMySQLTunnelRows) ColumnTypeLength(index int) (int64, bool) {
	if index < 0 || index >= len(r.fields) {
		return 0, false
	}
	return int64(r.fields[index].length), true
}

func (*navicatMySQLTunnelRows) ColumnTypeScanType(int) reflect.Type {
	return reflect.TypeOf([]byte(nil))
}

func (r navicatMySQLTunnelExecResult) LastInsertId() (int64, error) {
	return r.lastInsertID, nil
}

func (r navicatMySQLTunnelExecResult) RowsAffected() (int64, error) {
	return r.rowsAffected, nil
}

func (e *navicatMySQLTunnelProtocolError) Error() string {
	if strings.TrimSpace(e.message) == "" {
		return fmt.Sprintf("Navicat HTTP 隧道错误 %d", e.code)
	}
	return fmt.Sprintf("Navicat HTTP 隧道错误 %d：%s", e.code, e.message)
}

func (e *navicatMySQLTunnelProtocolError) Unwrap() error {
	if e == nil || e.code > math.MaxUint16 {
		return nil
	}
	return &mysql.MySQLError{Number: uint16(e.code), Message: e.message}
}

func navicatMySQLTunnelTransactionError() error {
	return errors.New("Navicat HTTP 隧道脚本按请求创建数据库连接，不支持跨请求事务")
}

func isNavicatMySQLTransactionControl(query string) bool {
	return navicatMySQLTransactionCommand(query) != ""
}

func navicatMySQLTransactionCommand(query string) string {
	tokens := navicatMySQLLeadingTokens(query, 4)
	if len(tokens) == 0 {
		return ""
	}
	switch tokens[0] {
	case "BEGIN":
		return "begin"
	case "COMMIT", "ROLLBACK":
		return "finish"
	case "SAVEPOINT":
		return "savepoint"
	case "START":
		if len(tokens) > 1 && tokens[1] == "TRANSACTION" {
			return "begin"
		}
	case "RELEASE":
		if len(tokens) > 1 && tokens[1] == "SAVEPOINT" {
			return "savepoint"
		}
	case "SET":
		for _, token := range tokens[1:] {
			if token == "AUTOCOMMIT" {
				return "autocommit"
			}
		}
	case "XA":
		if len(tokens) < 2 {
			return ""
		}
		switch tokens[1] {
		case "START", "BEGIN", "END", "PREPARE", "COMMIT", "ROLLBACK":
			return "xa"
		}
	}
	return ""
}

func navicatMySQLLeadingTokens(query string, limit int) []string {
	tokens := make([]string, 0, limit)
	var scan func(string)
	scan = func(sqlText string) {
		for index := 0; index < len(sqlText) && len(tokens) < limit; {
			for index < len(sqlText) && sqlText[index] <= ' ' {
				index++
			}
			if index >= len(sqlText) {
				return
			}
			if sqlText[index] == '#' {
				if newline := strings.IndexByte(sqlText[index:], '\n'); newline >= 0 {
					index += newline + 1
					continue
				}
				return
			}
			if strings.HasPrefix(sqlText[index:], "--") && index+2 < len(sqlText) && sqlText[index+2] <= ' ' {
				if newline := strings.IndexByte(sqlText[index:], '\n'); newline >= 0 {
					index += newline + 1
					continue
				}
				return
			}
			if strings.HasPrefix(sqlText[index:], "/*") {
				end := strings.Index(sqlText[index+2:], "*/")
				if end < 0 {
					return
				}
				comment := sqlText[index+2 : index+2+end]
				if strings.HasPrefix(comment, "!") {
					executable := strings.TrimSpace(strings.TrimPrefix(comment, "!"))
					for len(executable) > 0 && executable[0] >= '0' && executable[0] <= '9' {
						executable = executable[1:]
					}
					scan(executable)
				}
				index += 2 + end + 2
				continue
			}
			if (sqlText[index] >= 'a' && sqlText[index] <= 'z') || (sqlText[index] >= 'A' && sqlText[index] <= 'Z') || sqlText[index] == '_' {
				start := index
				for index < len(sqlText) && ((sqlText[index] >= 'a' && sqlText[index] <= 'z') || (sqlText[index] >= 'A' && sqlText[index] <= 'Z') || (sqlText[index] >= '0' && sqlText[index] <= '9') || sqlText[index] == '_') {
					index++
				}
				tokens = append(tokens, strings.ToUpper(sqlText[start:index]))
				continue
			}
			if sqlText[index] == '=' {
				tokens = append(tokens, "=")
				index++
				continue
			}
			if sqlText[index] == '@' || sqlText[index] == '.' {
				index++
				continue
			}
			return
		}
	}
	scan(query)
	return tokens
}

func validateNavicatMySQLTransactionBatch(queries []string) error {
	transactionOpen := false
	for index, query := range queries {
		switch navicatMySQLTransactionCommand(query) {
		case "begin":
			if transactionOpen {
				return fmt.Errorf("Navicat HTTP 隧道第 %d 条语句重复开启事务", index+1)
			}
			transactionOpen = true
		case "finish":
			if !transactionOpen {
				return fmt.Errorf("Navicat HTTP 隧道第 %d 条事务结束语句没有同请求内的事务起点", index+1)
			}
			transactionOpen = false
		case "savepoint":
			if !transactionOpen {
				return fmt.Errorf("Navicat HTTP 隧道第 %d 条保存点语句没有同请求内的事务", index+1)
			}
		case "autocommit":
			return fmt.Errorf("Navicat HTTP 隧道不支持跨请求保留 autocommit 状态；请在同一批次使用 START TRANSACTION 和 COMMIT/ROLLBACK")
		case "xa":
			return errors.New("Navicat HTTP 隧道不支持可能跨请求存续的 XA 事务")
		}
	}
	if transactionOpen {
		return errors.New("Navicat HTTP 隧道事务必须在同一请求内以 COMMIT 或 ROLLBACK 结束")
	}
	return nil
}

func (c *navicatMySQLTunnelClient) ping(ctx context.Context) error {
	body, err := c.post(ctx, "C", nil)
	if err != nil {
		return err
	}
	parser := &navicatMySQLTunnelParser{body: body}
	if _, err := parser.parseCommonHeader(); err != nil {
		return err
	}
	for index := 0; index < 3; index++ {
		if _, err := parser.parseBlock(); err != nil {
			return fmt.Errorf("Navicat HTTP 隧道连接信息响应不完整：%w", err)
		}
	}
	return nil
}

func (c *navicatMySQLTunnelClient) query(ctx context.Context, query string) (*navicatMySQLTunnelResult, error) {
	results, err := c.queryBatch(ctx, []string{query})
	if err != nil {
		return nil, err
	}
	if len(results) != 1 {
		return nil, fmt.Errorf("Navicat HTTP 隧道返回结果数异常：收到 %d，预期 1", len(results))
	}
	return results[0], nil
}

func (c *navicatMySQLTunnelClient) queryBatch(ctx context.Context, queries []string) ([]*navicatMySQLTunnelResult, error) {
	filtered := make([]string, 0, len(queries))
	for _, query := range queries {
		if strings.TrimSpace(query) != "" {
			filtered = append(filtered, query)
		}
	}
	if len(filtered) == 0 {
		return nil, errors.New("Navicat HTTP 隧道查询内容不能为空")
	}
	body, err := c.post(ctx, "Q", filtered)
	if err != nil {
		return nil, err
	}
	parser := &navicatMySQLTunnelParser{body: body}
	if _, err := parser.parseCommonHeader(); err != nil {
		return nil, err
	}
	results := make([]*navicatMySQLTunnelResult, 0, len(filtered))
	for index := range filtered {
		result, resultErr := parser.parseResult()
		if resultErr != nil {
			return results, fmt.Errorf("Navicat HTTP 隧道第 %d/%d 条查询失败：%w", index+1, len(filtered), resultErr)
		}
		results = append(results, result)
		marker, markerErr := parser.readByte()
		if markerErr != nil {
			return results, fmt.Errorf("Navicat HTTP 隧道第 %d/%d 条结果缺少结束标记：%w", index+1, len(filtered), markerErr)
		}
		expectedMarker := byte(1)
		if index == len(filtered)-1 {
			expectedMarker = 0
		}
		if marker != expectedMarker {
			return results, fmt.Errorf("Navicat HTTP 隧道第 %d/%d 条结果分隔标记异常：收到 0x%02x，预期 0x%02x", index+1, len(filtered), marker, expectedMarker)
		}
	}
	if parser.offset != len(parser.body) {
		return results, fmt.Errorf("Navicat HTTP 隧道响应包含 %d 个未解析字节", len(parser.body)-parser.offset)
	}
	return results, nil
}

func navicatMySQLTunnelResultSets(results []*navicatMySQLTunnelResult, budget *RowBudget) []connection.ResultSetData {
	if results == nil {
		return nil
	}
	converted := make([]connection.ResultSetData, 0, len(results))
	for resultIndex, result := range results {
		if result == nil {
			continue
		}
		if len(result.fields) == 0 {
			converted = append(converted, connection.ResultSetData{
				Rows:           []map[string]interface{}{{"affectedRows": result.affectedRows}},
				Columns:        []string{"affectedRows"},
				StatementIndex: resultIndex + 1,
			})
			continue
		}
		columns := make([]string, len(result.fields))
		for index := range result.fields {
			columns[index] = result.fields[index].name
		}
		columns = ensureUniqueQueryColumnNames(columns)
		maxRows := budget.MaxRowsPerResult()
		rowCount := len(result.rows)
		truncated := maxRows > 0 && rowCount > maxRows
		if truncated {
			rowCount = maxRows
			budget.MarkTruncated()
		}
		rows := make([]map[string]interface{}, 0, rowCount)
		for rowIndex := 0; rowIndex < rowCount; rowIndex++ {
			row := result.rows[rowIndex]
			entry := make(map[string]interface{}, len(columns))
			for columnIndex, column := range columns {
				var value driver.Value
				if columnIndex < len(row) {
					value = row[columnIndex]
				}
				entry[column] = normalizeInteractiveQueryValue(value, result.fields[columnIndex].databaseTy, "mysql")
			}
			rows = append(rows, entry)
		}
		converted = append(converted, connection.ResultSetData{
			Rows:           rows,
			Columns:        columns,
			Truncated:      truncated,
			StatementIndex: resultIndex + 1,
		})
		if truncated {
			break
		}
	}
	return converted
}

func (c *navicatMySQLTunnelClient) post(ctx context.Context, action string, queries []string) ([]byte, error) {
	form := url.Values{}
	form.Set("actn", action)
	form.Set("host", c.host)
	form.Set("port", strconv.Itoa(c.port))
	form.Set("login", c.login)
	form.Set("password", c.password)
	form.Set("db", c.database)
	if len(queries) > 0 {
		if c.base64SQL {
			form.Set("encodeBase64", "1")
		}
		for _, query := range queries {
			if c.base64SQL {
				query = base64.StdEncoding.EncodeToString([]byte(query))
			}
			form.Add("q[]", query)
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("创建 Navicat HTTP 隧道请求失败：%w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept-Encoding", "identity")
	if c.webUser != "" || c.webPass != "" {
		req.SetBasicAuth(c.webUser, c.webPass)
	}

	response, err := c.httpClient.Do(req)
	if err != nil {
		// http.Client.Do and a custom RoundTripper can each wrap the failure in
		// url.Error. Unwrap the complete chain because every layer's Error text
		// includes the endpoint, whose query string may contain access tokens.
		for {
			requestErr, ok := err.(*url.Error)
			if !ok || requestErr.Err == nil {
				break
			}
			err = requestErr.Err
		}
		return nil, fmt.Errorf("请求 Navicat HTTP 隧道失败：%w", err)
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxNavicatMySQLTunnelResponseBytes+1))
	if readErr != nil {
		return nil, fmt.Errorf("读取 Navicat HTTP 隧道响应失败：%w", readErr)
	}
	if len(body) > maxNavicatMySQLTunnelResponseBytes {
		return nil, fmt.Errorf("Navicat HTTP 隧道响应超过 %d MiB 限制", maxNavicatMySQLTunnelResponseBytes>>20)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("Navicat HTTP 隧道返回 HTTP %d：%s", response.StatusCode, navicatMySQLTunnelResponseSnippet(body))
	}
	return body, nil
}

func navicatMySQLTunnelResponseSnippet(body []byte) string {
	const maxSnippetBytes = 200
	if len(body) > maxSnippetBytes {
		body = body[:maxSnippetBytes]
	}
	text := strings.Join(strings.Fields(string(body)), " ")
	if text == "" {
		return "空响应"
	}
	return text
}

func (p *navicatMySQLTunnelParser) parseCommonHeader() (uint16, error) {
	magic, err := p.readUint32()
	if err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应头不完整：%w", err)
	}
	if magic != navicatMySQLTunnelMagic {
		return 0, fmt.Errorf("响应不是 Navicat HTTP 隧道协议（开头：%s）", navicatMySQLTunnelResponseSnippet(p.body))
	}
	version, err := p.readUint16()
	if err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应缺少脚本版本：%w", err)
	}
	errno, err := p.readUint32()
	if err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应缺少错误码：%w", err)
	}
	if _, err := p.read(6); err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应头不完整：%w", err)
	}
	if errno > 0 {
		message, blockErr := p.parseBlock()
		if blockErr != nil {
			return version, fmt.Errorf("Navicat HTTP 隧道错误 %d，且错误信息无法解析：%w", errno, blockErr)
		}
		return version, &navicatMySQLTunnelProtocolError{code: errno, message: string(message)}
	}
	return version, nil
}

func (p *navicatMySQLTunnelParser) parseResult() (*navicatMySQLTunnelResult, error) {
	errno, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果头不完整：%w", err)
	}
	affected, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少影响行数：%w", err)
	}
	insertID, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少自增 ID：%w", err)
	}
	fieldCount, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少字段数：%w", err)
	}
	rowCount, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少行数：%w", err)
	}
	if _, err := p.read(12); err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果头不完整：%w", err)
	}
	if errno > 0 {
		message, blockErr := p.parseBlock()
		if blockErr != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道查询错误 %d，且错误信息无法解析：%w", errno, blockErr)
		}
		return nil, &navicatMySQLTunnelProtocolError{code: errno, message: string(message)}
	}
	if fieldCount > maxNavicatMySQLTunnelFields {
		return nil, fmt.Errorf("Navicat HTTP 隧道字段数异常：%d", fieldCount)
	}
	if rowCount > maxNavicatMySQLTunnelRows {
		return nil, fmt.Errorf("Navicat HTTP 隧道行数异常：%d", rowCount)
	}
	cellCount := uint64(fieldCount) * uint64(rowCount)
	if cellCount > maxNavicatMySQLTunnelCells {
		return nil, fmt.Errorf("Navicat HTTP 隧道解码分配异常：字段数 %d x 行数 %d = %d 个单元格", fieldCount, rowCount, cellCount)
	}

	result := &navicatMySQLTunnelResult{
		affectedRows: navicatMySQLTunnelUint32ToInt64(affected),
		insertID:     navicatMySQLTunnelUint32ToInt64(insertID),
	}
	if fieldCount == 0 {
		info, err := p.parseBlock()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道执行信息不完整：%w", err)
		}
		result.info = string(info)
		return result, nil
	}

	if err := p.reserveDecodedAllocation(uint64(fieldCount) * 96); err != nil {
		return nil, err
	}
	result.fields = make([]navicatMySQLTunnelField, fieldCount)
	for index := range result.fields {
		name, err := p.parseBlock()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 名称不完整：%w", index+1, err)
		}
		table, err := p.parseBlock()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 表名不完整：%w", index+1, err)
		}
		if err := p.reserveDecodedAllocation(uint64(len(name) + len(table))); err != nil {
			return nil, err
		}
		typeID, err := p.readUint32()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 类型不完整：%w", index+1, err)
		}
		flags, err := p.readUint32()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 标志不完整：%w", index+1, err)
		}
		length, err := p.readUint32()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 长度不完整：%w", index+1, err)
		}
		result.fields[index] = navicatMySQLTunnelField{
			name: string(name), table: string(table), typeID: typeID, flags: flags, length: length,
			databaseTy: navicatMySQLDatabaseTypeName(typeID),
		}
	}

	if cellCount > uint64(len(p.body)-p.offset) {
		return nil, fmt.Errorf("Navicat HTTP 隧道行数据不完整：%d 个单元格至少需要 %d 字节，仅剩 %d 字节", cellCount, cellCount, len(p.body)-p.offset)
	}
	// 64-bit Go uses 24 bytes per slice header and 16 bytes per interface slot.
	// The estimate is deliberately conservative and guards allocation before make.
	allocationEstimate := uint64(rowCount)*24 + cellCount*16
	if err := p.reserveDecodedAllocation(allocationEstimate); err != nil {
		return nil, err
	}
	result.rows = make([][]driver.Value, rowCount)
	for rowIndex := range result.rows {
		row := make([]driver.Value, fieldCount)
		for columnIndex := range row {
			first, err := p.readByte()
			if err != nil {
				return nil, fmt.Errorf("Navicat HTTP 隧道第 %d 行第 %d 列不完整：%w", rowIndex+1, columnIndex+1, err)
			}
			if first == 0xff {
				row[columnIndex] = nil
				continue
			}
			value, err := p.parseBlockWithFirstByte(first)
			if err != nil {
				return nil, fmt.Errorf("Navicat HTTP 隧道第 %d 行第 %d 列不完整：%w", rowIndex+1, columnIndex+1, err)
			}
			row[columnIndex] = value
		}
		result.rows[rowIndex] = row
	}
	return result, nil
}

func navicatMySQLTunnelUint32ToInt64(value uint32) int64 {
	if value == math.MaxUint32 {
		return 0
	}
	return int64(value)
}

func (p *navicatMySQLTunnelParser) parseBlock() ([]byte, error) {
	first, err := p.readByte()
	if err != nil {
		return nil, err
	}
	return p.parseBlockWithFirstByte(first)
}

func (p *navicatMySQLTunnelParser) parseBlockWithFirstByte(first byte) ([]byte, error) {
	length := uint32(first)
	if first == 0xfe {
		var err error
		length, err = p.readUint32()
		if err != nil {
			return nil, err
		}
	}
	if uint64(length) > uint64(len(p.body)-p.offset) {
		return nil, io.ErrUnexpectedEOF
	}
	if length == 0 {
		return []byte{}, nil
	}
	value, err := p.read(int(length))
	if err != nil {
		return nil, err
	}
	// Values remain immutable and retain the response backing array. Avoiding a
	// second copy keeps decoded memory bounded by the wire-body limit.
	return value, nil
}

func (p *navicatMySQLTunnelParser) reserveDecodedAllocation(size uint64) error {
	if size > maxNavicatMySQLTunnelDecodedAllocBytes-p.decodedAllocationSize {
		return fmt.Errorf("Navicat HTTP 隧道解码分配超过 %d MiB 限制", maxNavicatMySQLTunnelDecodedAllocBytes>>20)
	}
	p.decodedAllocationSize += size
	return nil
}

func (p *navicatMySQLTunnelParser) readUint16() (uint16, error) {
	value, err := p.read(2)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(value), nil
}

func (p *navicatMySQLTunnelParser) readUint32() (uint32, error) {
	value, err := p.read(4)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(value), nil
}

func (p *navicatMySQLTunnelParser) readByte() (byte, error) {
	value, err := p.read(1)
	if err != nil {
		return 0, err
	}
	return value[0], nil
}

func (p *navicatMySQLTunnelParser) read(length int) ([]byte, error) {
	if length < 0 || p.offset > len(p.body)-length {
		return nil, io.ErrUnexpectedEOF
	}
	value := p.body[p.offset : p.offset+length]
	p.offset += length
	return value, nil
}

func navicatMySQLDatabaseTypeName(typeID uint32) string {
	switch typeID {
	case 0:
		return "DECIMAL"
	case 1:
		return "TINYINT"
	case 2:
		return "SMALLINT"
	case 3:
		return "INT"
	case 4:
		return "FLOAT"
	case 5:
		return "DOUBLE"
	case 6:
		return "NULL"
	case 7:
		return "TIMESTAMP"
	case 8:
		return "BIGINT"
	case 9:
		return "MEDIUMINT"
	case 10, 14:
		return "DATE"
	case 11, 19:
		return "TIME"
	case 12, 18:
		return "DATETIME"
	case 13:
		return "YEAR"
	case 15:
		return "VARCHAR"
	case 16:
		return "BIT"
	case 17:
		return "TIMESTAMP"
	case 245:
		return "JSON"
	case 246:
		return "DECIMAL"
	case 247:
		return "ENUM"
	case 248:
		return "SET"
	case 249:
		return "TINYBLOB"
	case 250:
		return "MEDIUMBLOB"
	case 251:
		return "LONGBLOB"
	case 252:
		return "BLOB"
	case 253:
		return "VAR_STRING"
	case 254:
		return "STRING"
	case 255:
		return "GEOMETRY"
	default:
		return fmt.Sprintf("MYSQL_%d", typeID)
	}
}

func interpolateNavicatMySQLQuery(query string, args []driver.NamedValue) (string, error) {
	if len(args) == 0 {
		return query, nil
	}
	for _, arg := range args {
		if arg.Name != "" {
			return "", fmt.Errorf("Navicat HTTP 隧道不支持命名参数 %q", arg.Name)
		}
	}

	var result strings.Builder
	result.Grow(len(query) + len(args)*8)
	argIndex := 0
	state := byte(0)
	for index := 0; index < len(query); index++ {
		current := query[index]
		switch state {
		case '\'':
			result.WriteByte(current)
			if current == '\\' && index+1 < len(query) {
				index++
				result.WriteByte(query[index])
			} else if current == '\'' {
				if index+1 < len(query) && query[index+1] == '\'' {
					index++
					result.WriteByte(query[index])
				} else {
					state = 0
				}
			}
		case '"':
			result.WriteByte(current)
			if current == '\\' && index+1 < len(query) {
				index++
				result.WriteByte(query[index])
			} else if current == '"' {
				if index+1 < len(query) && query[index+1] == '"' {
					index++
					result.WriteByte(query[index])
				} else {
					state = 0
				}
			}
		case '`':
			result.WriteByte(current)
			if current == '`' {
				if index+1 < len(query) && query[index+1] == '`' {
					index++
					result.WriteByte(query[index])
				} else {
					state = 0
				}
			}
		case '#':
			result.WriteByte(current)
			if current == '\n' || current == '\r' {
				state = 0
			}
		case '-':
			result.WriteByte(current)
			if current == '\n' || current == '\r' {
				state = 0
			}
		case '*':
			result.WriteByte(current)
			if current == '*' && index+1 < len(query) && query[index+1] == '/' {
				index++
				result.WriteByte('/')
				state = 0
			}
		default:
			switch {
			case current == '\'', current == '"', current == '`':
				state = current
				result.WriteByte(current)
			case current == '#':
				state = '#'
				result.WriteByte(current)
			case current == '-' && index+2 < len(query) && query[index+1] == '-' && query[index+2] <= ' ':
				state = '-'
				result.WriteString("--")
				index++
			case current == '/' && index+1 < len(query) && query[index+1] == '*':
				state = '*'
				result.WriteString("/*")
				index++
			case current == '?':
				if argIndex >= len(args) {
					return "", fmt.Errorf("Navicat HTTP 隧道 SQL 参数不足")
				}
				literal, err := navicatMySQLLiteral(args[argIndex].Value)
				if err != nil {
					return "", fmt.Errorf("Navicat HTTP 隧道 SQL 参数 %d 无法编码：%w", argIndex+1, err)
				}
				result.WriteString(literal)
				argIndex++
			default:
				result.WriteByte(current)
			}
		}
	}
	if argIndex != len(args) {
		return "", fmt.Errorf("Navicat HTTP 隧道 SQL 参数过多：需要 %d，收到 %d", argIndex, len(args))
	}
	return result.String(), nil
}

func navicatMySQLLiteral(value interface{}) (string, error) {
	switch typed := value.(type) {
	case nil:
		return "NULL", nil
	case bool:
		if typed {
			return "1", nil
		}
		return "0", nil
	case int64:
		return strconv.FormatInt(typed, 10), nil
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return "", fmt.Errorf("不支持非有限浮点数")
		}
		return strconv.FormatFloat(typed, 'g', -1, 64), nil
	case []byte:
		return "X'" + hex.EncodeToString(typed) + "'", nil
	case string:
		if typed == "" {
			return "''", nil
		}
		return "CONVERT(X'" + hex.EncodeToString([]byte(typed)) + "' USING utf8mb4)", nil
	case time.Time:
		return "'" + typed.Format("2006-01-02 15:04:05.999999") + "'", nil
	default:
		converted, err := driver.DefaultParameterConverter.ConvertValue(value)
		if err != nil {
			return "", err
		}
		if reflect.DeepEqual(converted, value) {
			return "", fmt.Errorf("不支持参数类型 %T", value)
		}
		return navicatMySQLLiteral(converted)
	}
}
