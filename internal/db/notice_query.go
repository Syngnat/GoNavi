package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"strings"
)

type sqlTextNoticeHandlerSetter func(driver.Conn, func(string))

func querySQLConnWithTextNotices(ctx context.Context, conn *sql.Conn, query string, setHandler sqlTextNoticeHandlerSetter) ([]map[string]interface{}, []string, []string, error) {
	if conn == nil {
		return nil, nil, nil, fmt.Errorf("连接未打开")
	}
	if setHandler == nil {
		return nil, nil, nil, fmt.Errorf("未配置消息捕获处理器")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	notices := make([]string, 0, 2)
	addNotice := func(text string) {
		text = strings.TrimSpace(text)
		if text != "" {
			notices = append(notices, text)
		}
	}

	if err := conn.Raw(func(rawConn interface{}) error {
		driverConn, ok := rawConn.(driver.Conn)
		if !ok {
			return fmt.Errorf("底层连接类型不支持消息捕获")
		}
		setHandler(driverConn, addNotice)
		return nil
	}); err != nil {
		return nil, nil, nil, err
	}
	defer func() {
		_ = conn.Raw(func(rawConn interface{}) error {
			driverConn, ok := rawConn.(driver.Conn)
			if ok {
				setHandler(driverConn, nil)
			}
			return nil
		})
	}()

	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, append([]string(nil), notices...), err
	}
	defer rows.Close()

	data, columns, err := scanRowsContext(ctx, rows)
	return data, columns, append([]string(nil), notices...), err
}
