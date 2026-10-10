package intersystems

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"net"
	"time"
	"unicode"

	_ "io"
	_ "math"
	_ "reflect"
	_ "strconv"
	_ "strings"
	_ "unsafe"

	"github.com/caretdev/go-irisnative/src/connection"
)

var (
	ErrCouldNotDetectUsername = errors.New("intersystems: Could not detect default username. Please provide one explicitly")
)

var (
	_ driver.Driver = Driver{}
)

type values map[string]string

// Driver implements database/sql/driver.Driver.
type Driver struct{}

func (d Driver) Open(name string) (driver.Conn, error) {
	return Open(name)
}

func init() {
	sql.Register("intersystems", &Driver{})
	sql.Register("iris", &Driver{})
}

func Open(dsn string) (_ driver.Conn, err error) {
	c, err := NewConnector(dsn)
	if err != nil {
		return nil, err
	}
	return c.open(context.Background())
}

type conn struct {
	c  connection.Connection
	tx bool
}

func (c *Connector) open(ctx context.Context) (cn *conn, err error) {
	o := make(values)
	for k, v := range c.opts {
		o[k] = v
	}
	host := o["host"]
	addr := net.JoinHostPort(host, o["port"])
	namespace := o["namespace"]
	login := o["user"]
	password := o["password"]

	cn = &conn{}

	cn.c, err = connection.Connect(addr, namespace, login, password)
	if err != nil {
		return nil, err
	}
	// 可选 DSN 参数 query_timeout：单次读响应的最大等待时间。
	// 驱动不响应 context，对受限账号的 %SYS 视图或大量系统投影表
	// （INFORMATION_SCHEMA.TABLES/COLUMNS）会出现服务端长时间不回包
	// 的情况；该参数给 ReadMessage 兜底，让上层在有限时间内拿到错误。
	// 解析失败静默忽略，保持原行为（GoNavi issue #1430/#1427）。
	if raw := o["query_timeout"]; raw != "" {
		if d, perr := time.ParseDuration(raw); perr == nil && d > 0 {
			cn.c.SetQueryTimeout(d)
		}
	}
	return cn, nil
}

func (cn *conn) Begin() (driver.Tx, error) {
	return cn.c.BeginTx(driver.TxOptions{})
}

func (cn *conn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return cn.c.BeginTx(opts)
}

func (cn *conn) Close() (err error) {
	cn.c.Disconnect()
	return nil
}

func (cn *conn) Prepare(q string) (st driver.Stmt, err error) {
	return cn.c.Prepare(q)
}

func (cn *conn) Commit() error {
	if !cn.tx {
		panic("transaction already closed")
	}
	cn.tx = false
	cn.c.Commit()
	return nil
}

func (cn *conn) Rollback() error {
	if !cn.tx {
		panic("transaction already closed")
	}
	cn.tx = false
	cn.c.Rollback()
	return nil
}

func (cn *conn) Exec(query string, args []driver.NamedValue) (res driver.Result, err error) {
	parameters := make([]interface{}, len(args))
	for i, a := range args {
		parameters[i] = a
	}
	_, err = cn.c.DirectUpdate(query, parameters...)
	if err != nil {
		return nil, err
	}
	return res, nil
}

func (cn *conn) Query(query string, args []driver.NamedValue) (rows driver.Rows, err error) {
	parameters := make([]interface{}, len(args))
	for i, a := range args {
		parameters[i] = a
	}
	// var rs *connection.ResultSet
	_, err = cn.c.Query(query, parameters...)
	if err != nil {
		return nil, err
	}
	// rows = &connection.Rows{
	// 	cn: cn.c,
	// 	rs: rs,
	// }
	return
}

func parseOpts(name string, o values) error {
	s := newScanner(name)

	for {
		var (
			keyRunes, valRunes []rune
			r                  rune
			ok                 bool
		)

		if r, ok = s.SkipSpaces(); !ok {
			break
		}

		// Scan the key
		for !unicode.IsSpace(r) && r != '=' {
			keyRunes = append(keyRunes, r)
			if r, ok = s.Next(); !ok {
				break
			}
		}

		// Skip any whitespace if we're not at the = yet
		if r != '=' {
			r, ok = s.SkipSpaces()
		}

		// The current character should be =
		if r != '=' || !ok {
			return fmt.Errorf(`missing "=" after %q in connection info string"`, string(keyRunes))
		}

		// Skip any whitespace after the =
		if r, ok = s.SkipSpaces(); !ok {
			// If we reach the end here, the last value is just an empty string as per libpq.
			o[string(keyRunes)] = ""
			break
		}

		if r != '\'' {
			for !unicode.IsSpace(r) {
				if r == '\\' {
					if r, ok = s.Next(); !ok {
						return fmt.Errorf(`missing character after backslash`)
					}
				}
				valRunes = append(valRunes, r)

				if r, ok = s.Next(); !ok {
					break
				}
			}
		} else {
		quote:
			for {
				if r, ok = s.Next(); !ok {
					return fmt.Errorf(`unterminated quoted string literal in connection string`)
				}
				switch r {
				case '\'':
					break quote
				case '\\':
					r, _ = s.Next()
					fallthrough
				default:
					valRunes = append(valRunes, r)
				}
			}
		}

		o[string(keyRunes)] = string(valRunes)
	}

	return nil
}
