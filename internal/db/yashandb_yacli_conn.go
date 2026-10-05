//go:build gonavi_full_drivers || gonavi_yashandb_driver

package db

import (
	"context"
	"database/sql/driver"
	"errors"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
	"unsafe"

	"GoNavi-Wails/internal/logger"
)

// yacliConnector 实现 database/sql 的 driver.Connector：每条连接独占一个 yacli 环境句柄与连接句柄。
type yacliConnector struct {
	api           *yacliAPI
	url           string
	user          string
	password      string
	sslRootCert   string
	currentSchema string
}

func (c *yacliConnector) Connect(ctx context.Context) (driver.Conn, error) {
	api := c.api
	conn := &yacliConn{api: api}
	if err := api.call(api.allocHandle, yacHandleEnv, 0, yacliPtr(&conn.env)); err != nil {
		return nil, err
	}
	charset := int32(yacCharsetUTF8)
	if err := api.call(api.setEnvAttr, conn.env, yacAttrCharsetCode, yacliPtr(&charset), 4); err != nil {
		conn.free()
		return nil, err
	}
	driverName := yacliText(yashanClientDriverName)
	_ = api.call(api.setEnvAttr, conn.env, yacAttrClientDriver, yacliPtr(&driverName[0]), uintptr(len(yashanClientDriverName)))
	if err := api.call(api.allocHandle, yacHandleDbc, conn.env, yacliPtr(&conn.dbc)); err != nil {
		conn.free()
		return nil, err
	}
	if c.sslRootCert != "" {
		cert := yacliText(c.sslRootCert)
		if err := api.call(api.setConnAttr, conn.dbc, yacAttrSSLRootCert, yacliPtr(&cert[0]), uintptr(len(c.sslRootCert))); err != nil {
			conn.free()
			return nil, err
		}
	}
	url, user, password := yacliText(c.url), yacliText(c.user), yacliText(c.password)
	done := make(chan error, 1)
	go func() {
		done <- api.call(api.connect, conn.dbc, yacliPtr(&url[0]), uintptr(len(c.url)), yacliPtr(&user[0]), uintptr(len(c.user)),
			yacliPtr(&password[0]), uintptr(len(c.password)))
		runtime.KeepAlive(url)
		runtime.KeepAlive(user)
		runtime.KeepAlive(password)
	}()
	select {
	case err := <-done:
		if err != nil {
			conn.free()
			return nil, err
		}
	case <-ctx.Done():
		// 连接调用无法中断：等它返回后再释放句柄，避免与仍在使用的句柄竞争。
		go func() {
			if err := <-done; err == nil {
				conn.disconnect()
			}
			conn.free()
		}()
		return nil, ctx.Err()
	}
	if err := conn.setAutocommit(true); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := c.switchSchema(ctx, conn); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

// yashanErrInsufficientPrivileges 是权限不足的错误号（普通用户默认没有 ALTER SESSION 权限）。
const yashanErrInsufficientPrivileges = 2213

// switchSchema 把会话的 CURRENT_SCHEMA 切到选中的 Schema（就是登录用户自己时不用切）。没有 ALTER SESSION 权限时
// 只记日志：元数据查询都带 Schema 限定，不切换只影响编辑器里不带 Schema 的对象名解析。
func (c *yacliConnector) switchSchema(ctx context.Context, conn *yacliConn) error {
	if c.currentSchema == "" || strings.EqualFold(c.currentSchema, strings.Trim(c.user, `"`)) {
		return nil
	}
	_, err := conn.ExecContext(ctx, "ALTER SESSION SET CURRENT_SCHEMA = "+yashanSchemaIdentifier(c.currentSchema), nil)
	var yacErr *yacliError
	if errors.As(err, &yacErr) && yacErr.Code == yashanErrInsufficientPrivileges {
		logger.Warnf("崖山用户 %s 没有 ALTER SESSION 权限，未切换到 Schema %s", c.user, c.currentSchema)
		return nil
	}
	return err
}

func (c *yacliConnector) Driver() driver.Driver { return yacliDriver{} }

type yacliDriver struct{}

func (yacliDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("yashandb yacli driver must be opened with sql.OpenDB")
}

// yacliConn 是一条 yacli 连接；database/sql 保证同一时刻只有一个 goroutine 使用它，取消在另一个 goroutine 上进行。
type yacliConn struct {
	api    *yacliAPI
	env    uintptr
	dbc    uintptr
	inTx   bool
	broken bool
	// mu 让取消（yacCancel）与关闭连接互斥。
	mu     sync.Mutex
	closed bool
}

var (
	_ driver.QueryerContext     = (*yacliConn)(nil)
	_ driver.ExecerContext      = (*yacliConn)(nil)
	_ driver.ConnBeginTx        = (*yacliConn)(nil)
	_ driver.Pinger             = (*yacliConn)(nil)
	_ driver.SessionResetter    = (*yacliConn)(nil)
	_ driver.Validator          = (*yacliConn)(nil)
	_ driver.NamedValueChecker  = (*yacliConn)(nil)
	_ driver.ConnPrepareContext = (*yacliConn)(nil)
)

func (c *yacliConn) setAutocommit(enabled bool) error {
	value := int32(0)
	if enabled {
		value = 1
	}
	return c.api.call(c.api.setConnAttr, c.dbc, yacAttrAutocommit, yacliPtr(&value), 4)
}

func (c *yacliConn) Prepare(query string) (driver.Stmt, error) {
	return &yacliPreparedStmt{conn: c, query: query}, nil
}

func (c *yacliConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	return c.Prepare(query)
}

func (c *yacliConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	c.disconnect()
	c.free()
	return nil
}

func (c *yacliConn) disconnect() {
	if c.dbc != 0 {
		_ = c.api.call(c.api.disconnect, c.dbc)
	}
}

func (c *yacliConn) free() {
	if c.dbc != 0 {
		_ = c.api.call(c.api.freeHandle, yacHandleDbc, c.dbc)
		c.dbc = 0
	}
	if c.env != 0 {
		_ = c.api.call(c.api.freeHandle, yacHandleEnv, c.env)
		c.env = 0
	}
}

// cancel 中断这条连接上正在执行的语句（yacCancel 作用于连接句柄）。
func (c *yacliConn) cancel() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed && c.dbc != 0 {
		_ = c.api.call(c.api.cancel, c.dbc)
	}
}

// Ping 用 yacPingWithTimeout 探活（23.4.4 起的客户端才有），老客户端执行一条最轻的查询。
func (c *yacliConn) Ping(ctx context.Context) error {
	if c.broken {
		return driver.ErrBadConn
	}
	if c.api.ping != 0 {
		timeout := int32(-1)
		if deadline, ok := ctx.Deadline(); ok {
			timeout = int32(max(time.Until(deadline).Milliseconds(), 1))
		}
		if err := c.api.call(c.api.ping, c.dbc, yacliInt(int(timeout))); err != nil {
			return c.markBroken(err)
		}
		return nil
	}
	rows, err := c.QueryContext(ctx, "SELECT 1 FROM DUAL", nil)
	if err != nil {
		return err
	}
	return rows.Close()
}

func (c *yacliConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *yacliConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	if err := c.setAutocommit(false); err != nil {
		return nil, err
	}
	c.inTx = true
	return &yacliTx{conn: c}, nil
}

func (c *yacliConn) ResetSession(context.Context) error {
	if c.broken {
		return driver.ErrBadConn
	}
	return nil
}

func (c *yacliConn) IsValid() bool { return !c.broken && c.dbc != 0 }

// CheckNamedValue 接受 database/sql 的标准值类型，其余（如自定义整数类型）交给默认转换。
func (c *yacliConn) CheckNamedValue(value *driver.NamedValue) error {
	switch value.Value.(type) {
	case nil, int64, float64, bool, []byte, string, time.Time:
		return nil
	}
	return driver.ErrSkip
}

func (c *yacliConn) markBroken(err error) error {
	c.broken = true
	return err
}

// yacliTx 提交或回滚后恢复自动提交；恢复失败的连接标记为损坏，不再放回连接池。
type yacliTx struct {
	conn *yacliConn
}

func (t *yacliTx) Commit() error   { return t.finish(t.conn.api.commit) }
func (t *yacliTx) Rollback() error { return t.finish(t.conn.api.rollback) }

func (t *yacliTx) finish(completion uintptr) error {
	c := t.conn
	if !c.inTx {
		return driver.ErrBadConn
	}
	c.inTx = false
	err := c.api.call(completion, c.dbc)
	if restoreErr := c.setAutocommit(true); restoreErr != nil {
		c.broken = true
		if err == nil {
			err = restoreErr
		}
	}
	return err
}

func (c *yacliConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	stmt, err := c.run(ctx, query, args)
	if err != nil {
		return nil, err
	}
	rows, err := newYacliRows(stmt)
	if err != nil {
		stmt.close()
		return nil, err
	}
	return rows, nil
}

func (c *yacliConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	stmt, err := c.run(ctx, query, args)
	if err != nil {
		return nil, err
	}
	defer stmt.close()
	var affected uint32
	var length int32
	if err := c.api.call(c.api.getStmtAttr, stmt.handle, yacAttrRowsAffected, yacliPtr(&affected), 4, yacliPtr(&length)); err != nil {
		return nil, err
	}
	return driver.RowsAffected(int64(affected)), nil
}

// yacliStatement 是一次执行用到的语句句柄、绑定参数的缓冲区与临时大对象（执行结束前必须保持存活且不被移动）。
type yacliStatement struct {
	conn       *yacliConn
	handle     uintptr
	buffers    [][]byte
	indicators []int32
	lobs       []yacliLob
	pinner     runtime.Pinner
	closed     bool
}

func (s *yacliStatement) close() {
	if s.closed {
		return
	}
	s.closed = true
	api := s.conn.api
	for _, lob := range s.lobs {
		lob.release(s.conn)
	}
	_ = api.call(api.freeHandle, yacHandleStmt, s.handle)
	s.pinner.Unpin()
}

// run 分配语句句柄并执行；有参数时先 yacPrepare 再逐个绑定。ctx 取消时用 yacCancel 中断。
func (c *yacliConn) run(ctx context.Context, query string, args []driver.NamedValue) (*yacliStatement, error) {
	api := c.api
	stmt := &yacliStatement{conn: c}
	if err := api.call(api.allocHandle, yacHandleStmt, c.dbc, yacliPtr(&stmt.handle)); err != nil {
		return nil, c.markBroken(err)
	}
	text := yacliText(query)
	stmt.pinner.Pin(&text[0])
	stop := context.AfterFunc(ctx, c.cancel)
	defer stop()
	var err error
	if len(args) == 0 {
		err = api.call(api.directExecute, stmt.handle, yacliPtr(&text[0]), uintptr(len(query)))
	} else if err = api.call(api.prepare, stmt.handle, yacliPtr(&text[0]), uintptr(len(query))); err == nil {
		if err = stmt.bindAll(args); err == nil {
			err = api.call(api.execute, stmt.handle)
		}
	}
	runtime.KeepAlive(text)
	if err != nil {
		stmt.close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	return stmt, nil
}

// yacliMaxInlineText 是按 VARCHAR / RAW 直接绑定的最大字节数，更长的值写进临时 CLOB / BLOB 再绑定。
const yacliMaxInlineText = 32000

// bindAll 绑定输入参数：整数、浮点、布尔、时间按原生类型传，字符串按 VARCHAR，二进制与超长文本走临时大对象。
func (s *yacliStatement) bindAll(args []driver.NamedValue) error {
	api := s.conn.api
	s.indicators = make([]int32, len(args))
	s.pinner.Pin(&s.indicators[0])
	for i, arg := range args {
		var (
			bindType          int
			buffer            []byte
			bindSize, bufSize int
			indicator         = &s.indicators[i]
			indicatorPtr      = yacliPtr(indicator)
		)
		switch value := arg.Value.(type) {
		case nil:
			bindType, buffer, *indicator = yacTypeChar, make([]byte, 1), yacNullData
		case int64:
			buffer = make([]byte, 8)
			*(*int64)(unsafe.Pointer(&buffer[0])) = value
			bindType, bindSize, bufSize, *indicator = yacTypeBigint, 8, 8, 8
		case float64:
			buffer = make([]byte, 8)
			*(*float64)(unsafe.Pointer(&buffer[0])) = value
			bindType, bindSize, bufSize, *indicator = yacTypeDouble, 8, 8, 8
		case bool:
			buffer = []byte{0}
			if value {
				buffer[0] = 1
			}
			bindType, bindSize, bufSize, *indicator = yacTypeBool, 1, 1, 1
		case time.Time:
			buffer = yacliTimestampBytes(value)
			bindType, bindSize, bufSize, *indicator = yacTypeTimestamp, len(buffer), len(buffer), int32(len(buffer))
		case []byte:
			lob, err := s.tempLob(yacTypeBlob, value)
			if err != nil {
				return err
			}
			if err := api.call(api.bindParameter, s.handle, uintptr(i+1), yacParamInput, yacTypeBlob, lob, yacliInt(-1), yacliInt(-1), 0); err != nil {
				return err
			}
			continue
		default:
			text := yashanParamText(value)
			if len(text) > yacliMaxInlineText {
				lob, err := s.tempLob(yacTypeClob, []byte(text))
				if err != nil {
					return err
				}
				if err := api.call(api.bindParameter, s.handle, uintptr(i+1), yacParamInput, yacTypeClob, lob, yacliInt(-1), yacliInt(-1), 0); err != nil {
					return err
				}
				continue
			}
			buffer = yacliText(text)
			bindType, bindSize, bufSize, indicatorPtr = yacTypeVarchar, len(text)+1, len(text), 0
		}
		s.buffers = append(s.buffers, buffer)
		s.pinner.Pin(&buffer[0])
		if err := api.call(api.bindParameter, s.handle, uintptr(i+1), yacParamInput, uintptr(bindType), yacliPtr(&buffer[0]),
			yacliInt(bindSize), yacliInt(bufSize), indicatorPtr); err != nil {
			return err
		}
	}
	return nil
}

// yacliLob 是语句持有的大对象定位符：holder 存放 yacli 分配的定位符指针（按指针的指针绑定）。
// 参数用的是临时大对象（temporary），结果列用的只是描述符。
type yacliLob struct {
	lobType   int
	holder    *uintptr
	temporary bool
}

func (l yacliLob) release(conn *yacliConn) {
	api := conn.api
	if l.temporary {
		_ = api.call(api.lobFree, conn.dbc, *l.holder)
	}
	_ = api.call(api.lobDescFree, *l.holder, uintptr(l.lobType))
}

// tempLob 创建临时大对象并分段写入数据，返回绑定参数用的定位符指针的地址。
func (s *yacliStatement) tempLob(lobType int, data []byte) (uintptr, error) {
	api, dbc := s.conn.api, s.conn.dbc
	holder := new(uintptr)
	s.pinner.Pin(holder)
	if err := api.call(api.lobDescAlloc, dbc, uintptr(lobType), yacliPtr(holder)); err != nil {
		return 0, err
	}
	if err := api.call(api.lobCreateTemporary, dbc, *holder); err != nil {
		_ = api.call(api.lobDescFree, *holder, uintptr(lobType))
		return 0, err
	}
	lob := yacliLob{lobType: lobType, holder: holder, temporary: true}
	s.lobs = append(s.lobs, lob)
	for offset := 0; offset < len(data); {
		end := min(offset+yacliLobChunkSize, len(data))
		if lobType == yacTypeClob {
			// 字符大对象每段都必须是完整的 UTF-8 序列，分段点退到字符边界。
			for end < len(data) && end > offset && !utf8.RuneStart(data[end]) {
				end--
			}
		}
		chunk := data[offset:end]
		offset = end
		written := uint64(len(chunk))
		err := api.call(api.lobWrite, dbc, *holder, yacliPtr(&written), yacliPtr(&chunk[0]), uintptr(len(chunk)))
		runtime.KeepAlive(chunk)
		if err != nil {
			return 0, err
		}
	}
	return yacliPtr(holder), nil
}

// yacliTimestampBytes 按 yacli 的 TIMESTAMP 结构（#pragma pack(4)：int64 微秒时间戳 + int16 时区偏移分钟 + 保留）
// 编码时间；时间戳是墙上时间按 UTC 计的微秒数，与服务端会话时区无关。
func yacliTimestampBytes(value time.Time) []byte {
	wall := time.Date(value.Year(), value.Month(), value.Day(), value.Hour(), value.Minute(), value.Second(), value.Nanosecond(), time.UTC)
	buffer := make([]byte, 12)
	*(*int64)(unsafe.Pointer(&buffer[0])) = wall.UnixMicro()
	return buffer
}

// yacliPreparedStmt 让 database/sql 的 Prepare 路径也能用：每次执行时直接走 run。
type yacliPreparedStmt struct {
	conn  *yacliConn
	query string
}

func (s *yacliPreparedStmt) Close() error  { return nil }
func (s *yacliPreparedStmt) NumInput() int { return -1 }

func (s *yacliPreparedStmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.conn.ExecContext(context.Background(), s.query, yacliNamedValues(args))
}

func (s *yacliPreparedStmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.conn.QueryContext(context.Background(), s.query, yacliNamedValues(args))
}

func (s *yacliPreparedStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.conn.ExecContext(ctx, s.query, args)
}

func (s *yacliPreparedStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.conn.QueryContext(ctx, s.query, args)
}

func yacliNamedValues(args []driver.Value) []driver.NamedValue {
	named := make([]driver.NamedValue, len(args))
	for i, value := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: value}
	}
	return named
}
