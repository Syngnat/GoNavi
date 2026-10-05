//go:build gonavi_full_drivers || gonavi_gbase8a_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync/atomic"

	"github.com/go-sql-driver/mysql"
)

// GBase 8a 用 MySQL 协议，但 BEGIN / START TRANSACTION 不开启事务（之后的 DML 照常自动提交，ROLLBACK 无效），
// 只有 SET autocommit=0 之后的语句才能整体提交或回滚。这里包一层 MySQL 驱动：database/sql 的 BeginTx
// 改为关闭自动提交，Commit / Rollback 结束事务后恢复自动提交；恢复失败的连接标记为失效，不再回到连接池。
// 网格提交、托管事务、数据同步等所有走 BeginTx 的路径因此都能得到真正的事务。

const gbase8aSQLDriverName = "gonavi-gbase8a"

func init() {
	sql.Register(gbase8aSQLDriverName, gbase8aDriver{})
}

type gbase8aDriver struct{}

func (gbase8aDriver) Open(dsn string) (driver.Conn, error) {
	connector, err := (gbase8aDriver{}).OpenConnector(dsn)
	if err != nil {
		return nil, err
	}
	return connector.Connect(context.Background())
}

func (gbase8aDriver) OpenConnector(dsn string) (driver.Connector, error) {
	inner, err := (mysql.MySQLDriver{}).OpenConnector(dsn)
	if err != nil {
		return nil, err
	}
	return gbase8aConnector{inner: inner}, nil
}

type gbase8aConnector struct {
	inner driver.Connector
}

func (c gbase8aConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.inner.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &gbase8aConn{inner: conn}, nil
}

func (gbase8aConnector) Driver() driver.Driver {
	return gbase8aDriver{}
}

// gbase8aConn 转发 MySQL 连接的全部可选接口，只替换事务的开始与结束。
type gbase8aConn struct {
	inner driver.Conn
	// broken 为 true 表示自动提交没能恢复，连接不能再给别的请求用。
	broken atomic.Bool
}

var (
	_ driver.Conn               = (*gbase8aConn)(nil)
	_ driver.ConnBeginTx        = (*gbase8aConn)(nil)
	_ driver.ConnPrepareContext = (*gbase8aConn)(nil)
	_ driver.ExecerContext      = (*gbase8aConn)(nil)
	_ driver.QueryerContext     = (*gbase8aConn)(nil)
	_ driver.Pinger             = (*gbase8aConn)(nil)
	_ driver.SessionResetter    = (*gbase8aConn)(nil)
	_ driver.Validator          = (*gbase8aConn)(nil)
	_ driver.NamedValueChecker  = (*gbase8aConn)(nil)
)

func (c *gbase8aConn) Prepare(query string) (driver.Stmt, error) {
	return c.inner.Prepare(query)
}

func (c *gbase8aConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if preparer, ok := c.inner.(driver.ConnPrepareContext); ok {
		return preparer.PrepareContext(ctx, query)
	}
	return c.inner.Prepare(query)
}

func (c *gbase8aConn) Close() error {
	return c.inner.Close()
}

func (c *gbase8aConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

// BeginTx 关闭自动提交开始事务；GBase 8a 不支持事务隔离级别与只读事务，选项被忽略。
func (c *gbase8aConn) BeginTx(ctx context.Context, _ driver.TxOptions) (driver.Tx, error) {
	if err := c.execText(ctx, "SET autocommit=0"); err != nil {
		return nil, err
	}
	return &gbase8aTx{conn: c}, nil
}

func (c *gbase8aConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if execer, ok := c.inner.(driver.ExecerContext); ok {
		return execer.ExecContext(ctx, query, args)
	}
	return nil, driver.ErrSkip
}

func (c *gbase8aConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if queryer, ok := c.inner.(driver.QueryerContext); ok {
		return queryer.QueryContext(ctx, query, args)
	}
	return nil, driver.ErrSkip
}

func (c *gbase8aConn) Ping(ctx context.Context) error {
	if pinger, ok := c.inner.(driver.Pinger); ok {
		return pinger.Ping(ctx)
	}
	return nil
}

func (c *gbase8aConn) ResetSession(ctx context.Context) error {
	if c.broken.Load() {
		return driver.ErrBadConn
	}
	if resetter, ok := c.inner.(driver.SessionResetter); ok {
		return resetter.ResetSession(ctx)
	}
	return nil
}

func (c *gbase8aConn) IsValid() bool {
	if c.broken.Load() {
		return false
	}
	if validator, ok := c.inner.(driver.Validator); ok {
		return validator.IsValid()
	}
	return true
}

func (c *gbase8aConn) CheckNamedValue(value *driver.NamedValue) error {
	if checker, ok := c.inner.(driver.NamedValueChecker); ok {
		return checker.CheckNamedValue(value)
	}
	return driver.ErrSkip
}

func (c *gbase8aConn) execText(ctx context.Context, query string) error {
	_, err := c.ExecContext(ctx, query, nil)
	if errors.Is(err, driver.ErrSkip) {
		return errors.New("gbase8a: driver connection does not support ExecContext")
	}
	return err
}

type gbase8aTx struct {
	conn *gbase8aConn
}

func (t *gbase8aTx) Commit() error {
	return t.finish("COMMIT")
}

func (t *gbase8aTx) Rollback() error {
	return t.finish("ROLLBACK")
}

// finish 结束事务并恢复自动提交。结束语句本身的错误照常返回；恢复失败只让连接失效，不改变事务结果。
func (t *gbase8aTx) finish(statement string) error {
	ctx := context.Background()
	err := t.conn.execText(ctx, statement)
	if restoreErr := t.conn.execText(ctx, "SET autocommit=1"); restoreErr != nil {
		t.conn.broken.Store(true)
	}
	return err
}
