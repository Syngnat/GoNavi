//go:build gonavi_full_drivers || gonavi_firebird_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"reflect"
	"strings"
	"time"

	"github.com/nakagami/firebirdsql"
)

// 包装 firebirdsql 的连接，处理两件事：
//
//  1. 驱动的自动提交是 COMMIT RETAINING，每条连接上的第一个事务永远不会真正结束，连接池里闲置的连接会一直持有
//     对象的使用锁，别的连接上的 DROP / ALTER 在 WAIT 模式下会无限等待。这里让事务之外的每条语句都在自己的短事务里
//     执行并硬提交；DDL 用 NOWAIT，对象被占用时立即报错而不是卡住。
//  2. DATE 返回成当天零点、TIME 返回成 0000-01-01 的时间戳、TIME WITH TIME ZONE 换算成 UTC 的时间戳，直接展示会多出
//     日期或时刻；取行时转成 Firebird 的文本形式（2024-02-29、13:14:15.1234）。

type firebirdTemporalKind int

const (
	firebirdTemporalNone firebirdTemporalKind = iota
	firebirdTemporalDate
	firebirdTemporalTime
	firebirdTemporalTimeTZ
)

var firebirdStringType = reflect.TypeOf("")

// firebirdBaseConn 是 firebirdsql 连接实现的接口集合。
type firebirdBaseConn interface {
	driver.Conn
	driver.ConnBeginTx
	driver.ConnPrepareContext
	driver.ExecerContext
	driver.QueryerContext
	driver.Pinger
}

// firebirdConnector 用 firebirdsql 打开连接并包装成 firebirdConn。
type firebirdConnector struct {
	dsn  string
	base driver.Driver
}

func newFirebirdConnector(dsn string) (*firebirdConnector, error) {
	probe, err := sql.Open("firebirdsql", dsn)
	if err != nil {
		return nil, err
	}
	base := probe.Driver()
	_ = probe.Close()
	return &firebirdConnector{dsn: dsn, base: base}, nil
}

func (c *firebirdConnector) Connect(ctx context.Context) (driver.Conn, error) {
	type result struct {
		conn driver.Conn
		err  error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := c.base.Open(c.dsn)
		done <- result{conn, err}
	}()
	select {
	case opened := <-done:
		if opened.err != nil {
			return nil, opened.err
		}
		if base, ok := opened.conn.(firebirdBaseConn); ok {
			return &firebirdConn{firebirdBaseConn: base}, nil
		}
		return opened.conn, nil
	case <-ctx.Done():
		// 驱动的建连不接受 ctx：等它返回后关掉，避免泄漏连接。
		go func() {
			if opened := <-done; opened.err == nil {
				_ = opened.conn.Close()
			}
		}()
		return nil, ctx.Err()
	}
}

func (c *firebirdConnector) Driver() driver.Driver { return c.base }

type firebirdConn struct {
	firebirdBaseConn
	// inTx 表示 database/sql 在这条连接上开着显式事务，语句直接在其中执行。
	inTx bool
}

func (c *firebirdConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *firebirdConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	tx, err := c.firebirdBaseConn.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	c.inTx = true
	return &firebirdTx{Tx: tx, conn: c}, nil
}

// firebirdTx 结束时清掉连接上的显式事务标记。
type firebirdTx struct {
	driver.Tx
	conn *firebirdConn
}

func (t *firebirdTx) Commit() error {
	t.conn.inTx = false
	return t.Tx.Commit()
}

func (t *firebirdTx) Rollback() error {
	t.conn.inTx = false
	return t.Tx.Rollback()
}

// statementTxOptions 是事务之外执行一条语句时用的短事务：DDL 用 READ COMMITTED NOWAIT，其余 READ COMMITTED WAIT。
func statementTxOptions(query string) driver.TxOptions {
	if isFirebirdDDL(query) {
		return driver.TxOptions{Isolation: driver.IsolationLevel(firebirdsql.LevelReadCommittedNoWait)}
	}
	return driver.TxOptions{Isolation: driver.IsolationLevel(sql.LevelReadCommitted)}
}

var firebirdDDLKeywords = map[string]struct{}{
	"CREATE": {}, "ALTER": {}, "DROP": {}, "RECREATE": {}, "COMMENT": {}, "GRANT": {}, "REVOKE": {}, "DECLARE": {},
}

// isFirebirdDDL 按首个关键字（跳过注释）判断是否为元数据语句。
func isFirebirdDDL(query string) bool {
	text := strings.TrimSpace(query)
	for strings.HasPrefix(text, "--") || strings.HasPrefix(text, "/*") {
		if strings.HasPrefix(text, "--") {
			if newline := strings.IndexByte(text, '\n'); newline >= 0 {
				text = strings.TrimSpace(text[newline+1:])
				continue
			}
			return false
		}
		end := strings.Index(text, "*/")
		if end < 0 {
			return false
		}
		text = strings.TrimSpace(text[end+2:])
	}
	keyword, _, _ := strings.Cut(text, " ")
	_, ok := firebirdDDLKeywords[strings.ToUpper(strings.TrimSpace(keyword))]
	return ok
}

func (c *firebirdConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if c.inTx {
		return c.firebirdBaseConn.ExecContext(ctx, query, args)
	}
	tx, err := c.firebirdBaseConn.BeginTx(ctx, statementTxOptions(query))
	if err != nil {
		return nil, err
	}
	result, err := c.firebirdBaseConn.ExecContext(ctx, query, args)
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *firebirdConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if c.inTx {
		rows, err := c.firebirdBaseConn.QueryContext(ctx, query, args)
		if err != nil {
			return nil, err
		}
		return newFirebirdRows(rows, nil), nil
	}
	tx, err := c.firebirdBaseConn.BeginTx(ctx, statementTxOptions(query))
	if err != nil {
		return nil, err
	}
	rows, err := c.firebirdBaseConn.QueryContext(ctx, query, args)
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return newFirebirdRows(rows, tx), nil
}

// firebirdRows 在取行时转换日期、时刻列，关闭时提交语句自己的短事务；其余方法转给驱动的结果集。
type firebirdRows struct {
	driver.Rows
	kinds  []firebirdTemporalKind
	tx     driver.Tx
	failed bool
}

func newFirebirdRows(rows driver.Rows, tx driver.Tx) driver.Rows {
	wrapped := &firebirdRows{Rows: rows, kinds: make([]firebirdTemporalKind, len(rows.Columns())), tx: tx}
	if typed, ok := rows.(driver.RowsColumnTypeDatabaseTypeName); ok {
		for i := range wrapped.kinds {
			wrapped.kinds[i] = firebirdTemporalKindOf(typed.ColumnTypeDatabaseTypeName(i))
		}
	}
	return wrapped
}

func (r *firebirdRows) Close() error {
	err := r.Rows.Close()
	if r.tx == nil {
		return err
	}
	tx := r.tx
	r.tx = nil
	if err != nil || r.failed {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func firebirdTemporalKindOf(databaseTypeName string) firebirdTemporalKind {
	switch strings.ToUpper(strings.TrimSpace(databaseTypeName)) {
	case "DATE":
		return firebirdTemporalDate
	case "TIME":
		return firebirdTemporalTime
	case "TIME WITH TIMEZONE", "TIME WITH TIME ZONE":
		return firebirdTemporalTimeTZ
	}
	return firebirdTemporalNone
}

func (r *firebirdRows) Next(dest []driver.Value) error {
	if err := r.Rows.Next(dest); err != nil {
		if err != io.EOF {
			r.failed = true
		}
		return err
	}
	for i, kind := range r.kinds {
		value, ok := dest[i].(time.Time)
		if !ok || kind == firebirdTemporalNone {
			continue
		}
		dest[i] = formatFirebirdTemporal(value, kind)
	}
	return nil
}

// formatFirebirdTemporal 按列类型输出 Firebird 的文本形式；时刻精度是 1/10000 秒，末尾的 0 去掉。
func formatFirebirdTemporal(value time.Time, kind firebirdTemporalKind) string {
	switch kind {
	case firebirdTemporalDate:
		return value.Format("2006-01-02")
	case firebirdTemporalTimeTZ:
		return value.Format("15:04:05.9999") + " " + value.Format("Z07:00")
	default:
		return value.Format("15:04:05.9999")
	}
}

func (r *firebirdRows) ColumnTypeDatabaseTypeName(index int) string {
	if typed, ok := r.Rows.(driver.RowsColumnTypeDatabaseTypeName); ok {
		return typed.ColumnTypeDatabaseTypeName(index)
	}
	return ""
}

func (r *firebirdRows) ColumnTypeScanType(index int) reflect.Type {
	if r.kinds[index] != firebirdTemporalNone {
		return firebirdStringType
	}
	if typed, ok := r.Rows.(driver.RowsColumnTypeScanType); ok {
		return typed.ColumnTypeScanType(index)
	}
	return reflect.TypeOf(new(any)).Elem()
}

func (r *firebirdRows) ColumnTypeNullable(index int) (bool, bool) {
	if typed, ok := r.Rows.(driver.RowsColumnTypeNullable); ok {
		return typed.ColumnTypeNullable(index)
	}
	return false, false
}

func (r *firebirdRows) ColumnTypeLength(index int) (int64, bool) {
	if typed, ok := r.Rows.(driver.RowsColumnTypeLength); ok {
		return typed.ColumnTypeLength(index)
	}
	return 0, false
}

func (r *firebirdRows) ColumnTypePrecisionScale(index int) (int64, int64, bool) {
	if typed, ok := r.Rows.(driver.RowsColumnTypePrecisionScale); ok {
		return typed.ColumnTypePrecisionScale(index)
	}
	return 0, 0, false
}
