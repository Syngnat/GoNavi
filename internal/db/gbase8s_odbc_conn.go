//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// odbcConnector 实现 database/sql 的 driver.Connector：每条连接是一个 ODBC 连接句柄。
type odbcConnector struct {
	api     *odbcAPI
	connStr string
}

func (c *odbcConnector) Connect(ctx context.Context) (driver.Conn, error) {
	var dbc uintptr
	if rc := odbcCall(c.api.allocHandle, sqlHandleDbc, c.api.env, ptr(&dbc)); !odbcOK(rc) {
		return nil, c.api.diagError(sqlHandleEnv, c.api.env, rc)
	}
	connStr := cString(c.connStr)
	out := make([]byte, 1024)
	var outLen int16
	done := make(chan int16, 1)
	go func() {
		done <- odbcCall(c.api.driverConnect, dbc, 0, ptr(&connStr[0]), sqlInt(sqlNTS), ptr(&out[0]), uintptr(len(out)), ptr(&outLen), sqlDriverNoPrompt)
		runtime.KeepAlive(connStr)
		runtime.KeepAlive(out)
	}()
	select {
	case rc := <-done:
		if !odbcOK(rc) {
			err := c.api.diagError(sqlHandleDbc, dbc, rc)
			odbcCall(c.api.freeHandle, sqlHandleDbc, dbc)
			return nil, err
		}
	case <-ctx.Done():
		// 驱动的连接调用无法中断：等它返回后再释放句柄，避免与仍在使用的句柄竞争。
		go func() {
			if rc := <-done; odbcOK(rc) {
				odbcCall(c.api.disconnect, dbc)
			}
			odbcCall(c.api.freeHandle, sqlHandleDbc, dbc)
		}()
		return nil, ctx.Err()
	}
	return &odbcConn{api: c.api, dbc: dbc}, nil
}

func (c *odbcConnector) Driver() driver.Driver { return odbcDriver{} }

type odbcDriver struct{}

func (odbcDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("gbase8s odbc driver must be opened with sql.OpenDB")
}

// odbcConn 是一个 ODBC 连接；database/sql 保证同一时刻只有一个 goroutine 使用它。
type odbcConn struct {
	api    *odbcAPI
	dbc    uintptr
	inTx   bool
	broken bool
}

var (
	_ driver.QueryerContext     = (*odbcConn)(nil)
	_ driver.ExecerContext      = (*odbcConn)(nil)
	_ driver.ConnBeginTx        = (*odbcConn)(nil)
	_ driver.SessionResetter    = (*odbcConn)(nil)
	_ driver.Validator          = (*odbcConn)(nil)
	_ driver.NamedValueChecker  = (*odbcConn)(nil)
	_ driver.ConnPrepareContext = (*odbcConn)(nil)
)

func (c *odbcConn) Prepare(query string) (driver.Stmt, error) {
	return &odbcPreparedStmt{conn: c, query: query}, nil
}

func (c *odbcConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	return c.Prepare(query)
}

func (c *odbcConn) Close() error {
	odbcCall(c.api.disconnect, c.dbc)
	odbcCall(c.api.freeHandle, sqlHandleDbc, c.dbc)
	c.dbc = 0
	return nil
}

func (c *odbcConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *odbcConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	if rc := odbcCall(c.api.setConnectAttr, c.dbc, sqlAttrAutocommit, sqlAutocommitOff, 0); !odbcOK(rc) {
		return nil, c.api.diagError(sqlHandleDbc, c.dbc, rc)
	}
	c.inTx = true
	return &odbcTx{conn: c}, nil
}

func (c *odbcConn) ResetSession(context.Context) error {
	if c.broken {
		return driver.ErrBadConn
	}
	return nil
}

func (c *odbcConn) IsValid() bool { return !c.broken && c.dbc != 0 }

// CheckNamedValue 接受 database/sql 的标准值类型，其余（如自定义整数类型）交给默认转换。
func (c *odbcConn) CheckNamedValue(value *driver.NamedValue) error {
	switch value.Value.(type) {
	case nil, int64, float64, bool, []byte, string, time.Time:
		return nil
	}
	return driver.ErrSkip
}

// odbcTx 提交或回滚后恢复自动提交；恢复失败的连接标记为损坏，不再放回连接池。
type odbcTx struct {
	conn *odbcConn
}

func (t *odbcTx) Commit() error   { return t.finish(sqlCommit) }
func (t *odbcTx) Rollback() error { return t.finish(sqlRollback) }

func (t *odbcTx) finish(completion int) error {
	c := t.conn
	if !c.inTx {
		return driver.ErrBadConn
	}
	c.inTx = false
	var err error
	if rc := odbcCall(c.api.endTran, sqlHandleDbc, c.dbc, uintptr(completion)); !odbcOK(rc) {
		err = c.api.diagError(sqlHandleDbc, c.dbc, rc)
	}
	if rc := odbcCall(c.api.setConnectAttr, c.dbc, sqlAttrAutocommit, sqlAutocommitOn, 0); !odbcOK(rc) {
		c.broken = true
		if err == nil {
			err = c.api.diagError(sqlHandleDbc, c.dbc, rc)
		}
	}
	return err
}

func (c *odbcConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	stmt, err := c.run(ctx, query, args)
	if err != nil {
		return nil, err
	}
	rows, err := newODBCRows(stmt)
	if err != nil {
		stmt.close()
		return nil, err
	}
	return rows, nil
}

func (c *odbcConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	stmt, err := c.run(ctx, query, args)
	if err != nil {
		return nil, err
	}
	defer stmt.close()
	var affected int64
	if rc := odbcCall(c.api.rowCount, stmt.handle, ptr(&affected)); !odbcOK(rc) {
		return nil, c.api.diagError(sqlHandleStmt, stmt.handle, rc)
	}
	return driver.RowsAffected(max(affected, 0)), nil
}

// odbcStatement 是一次执行用到的语句句柄与绑定参数的缓冲区（执行结束前必须保持存活且不被移动）。
type odbcStatement struct {
	api     *odbcAPI
	handle  uintptr
	buffers [][]byte
	lengths []int64
	pinner  runtime.Pinner
	// mu 让取消（另一个 goroutine 调 SQLCancel）与释放句柄互斥。
	mu     sync.Mutex
	closed bool
}

func (s *odbcStatement) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	odbcCall(s.api.freeStmt, s.handle, sqlClose)
	odbcCall(s.api.freeHandle, sqlHandleStmt, s.handle)
	s.pinner.Unpin()
}

func (s *odbcStatement) cancel() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		odbcCall(s.api.cancel, s.handle)
	}
}

// run 分配语句句柄并执行；有参数时先 SQLPrepare 再逐个 SQLBindParameter。ctx 取消时用 SQLCancel 中断。
func (c *odbcConn) run(ctx context.Context, query string, args []driver.NamedValue) (*odbcStatement, error) {
	stmt := &odbcStatement{api: c.api}
	if rc := odbcCall(c.api.allocHandle, sqlHandleStmt, c.dbc, ptr(&stmt.handle)); !odbcOK(rc) {
		return nil, c.markBroken(c.api.diagError(sqlHandleDbc, c.dbc, rc))
	}
	text := cString(query)
	stmt.pinner.Pin(&text[0])
	var rc int16
	stop := context.AfterFunc(ctx, stmt.cancel)
	defer stop()
	if len(args) == 0 {
		rc = odbcCall(c.api.execDirect, stmt.handle, ptr(&text[0]), sqlInt(sqlNTS))
	} else {
		if rc = odbcCall(c.api.prepare, stmt.handle, ptr(&text[0]), sqlInt(sqlNTS)); odbcOK(rc) {
			if err := stmt.bindAll(args); err != nil {
				stmt.close()
				return nil, err
			}
			rc = odbcCall(c.api.execute, stmt.handle)
		}
	}
	runtime.KeepAlive(text)
	if rc == sqlNoData {
		return stmt, nil
	}
	if !odbcOK(rc) {
		err := c.api.diagError(sqlHandleStmt, stmt.handle, rc)
		stmt.close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	return stmt, nil
}

func (c *odbcConn) markBroken(err error) error {
	c.broken = true
	return err
}

// bindAll 绑定输入参数：整数、浮点、二进制按原生 C 类型传，其余按字符串传给服务端转换。
func (s *odbcStatement) bindAll(args []driver.NamedValue) error {
	s.lengths = make([]int64, len(args))
	s.pinner.Pin(&s.lengths[0])
	for i, arg := range args {
		var (
			cType, sqlType int
			size           int
			buffer         []byte
		)
		length := &s.lengths[i]
		switch value := arg.Value.(type) {
		case nil:
			cType, sqlType, size, *length = sqlCChar, sqlTypeVarchar, 1, sqlNullData
		case int64:
			buffer = make([]byte, 8)
			*(*int64)(unsafePointer(buffer)) = value
			cType, sqlType, size, *length = sqlCSBigint, sqlTypeBigint, 19, 8
		case float64:
			buffer = make([]byte, 8)
			*(*float64)(unsafePointer(buffer)) = value
			cType, sqlType, size, *length = sqlCDouble, sqlTypeDouble, 15, 8
		case []byte:
			buffer = append([]byte(nil), value...)
			cType, sqlType, size, *length = sqlCBinary, sqlTypeLongVarBinary, max(len(value), 1), int64(len(value))
		default:
			text := odbcParamText(value)
			buffer = cString(text)
			sqlType = sqlTypeVarchar
			if len(text) > 32000 {
				sqlType = sqlTypeLongVarchar
			}
			cType, size, *length = sqlCChar, max(len(text), 1), int64(len(text))
		}
		var data uintptr
		if len(buffer) > 0 {
			s.buffers = append(s.buffers, buffer)
			s.pinner.Pin(&buffer[0])
			data = ptr(&buffer[0])
		}
		rc := odbcCall(s.api.bindParameter, s.handle, uintptr(i+1), sqlParamInput, sqlInt(cType), sqlInt(sqlType),
			uintptr(size), 0, data, uintptr(len(buffer)), ptr(length))
		if !odbcOK(rc) {
			return s.api.diagError(sqlHandleStmt, s.handle, rc)
		}
	}
	return nil
}

// odbcParamText 把字符串类参数转成服务端可隐式转换的文本（时间用 Informix DATETIME 字面量格式）。
func odbcParamText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		if typed {
			return "t"
		}
		return "f"
	case time.Time:
		return typed.Format("2006-01-02 15:04:05.00000")
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	default:
		return fmt.Sprint(typed)
	}
}

// odbcPreparedStmt 让 database/sql 的 Prepare 路径也能用：每次执行时直接走 run。
type odbcPreparedStmt struct {
	conn  *odbcConn
	query string
}

func (s *odbcPreparedStmt) Close() error  { return nil }
func (s *odbcPreparedStmt) NumInput() int { return -1 }

func (s *odbcPreparedStmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.conn.ExecContext(context.Background(), s.query, namedValues(args))
}

func (s *odbcPreparedStmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.conn.QueryContext(context.Background(), s.query, namedValues(args))
}

func (s *odbcPreparedStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.conn.ExecContext(ctx, s.query, args)
}

func (s *odbcPreparedStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.conn.QueryContext(ctx, s.query, args)
}

func namedValues(args []driver.Value) []driver.NamedValue {
	named := make([]driver.NamedValue, len(args))
	for i, value := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: value}
	}
	return named
}
