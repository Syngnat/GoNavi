package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"
)

func (m *MySQLDB) Connect(config connection.ConnectionConfig) error {
	m.batchWritesEnabled = false
	m.navicatTunnel = false
	m.navicatTunnelClient = nil
	runConfig := applyMySQLURI(config)
	addresses := collectMySQLAddresses(runConfig)
	if len(addresses) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 MySQL 地址")
	}
	defaultPort := resolveMySQLCompatibleDefaultPort(runConfig)

	var errorDetails []string
	for index, address := range addresses {
		candidateConfig := runConfig
		host, port, ok := parseHostPortWithDefault(address, defaultPort)
		if !ok {
			continue
		}
		candidateConfig.Host = host
		candidateConfig.Port = port
		candidateConfig.User, candidateConfig.Password = resolveMySQLCredential(runConfig, index)
		if candidateConfig.UseHTTPTunnel && isNavicatMySQLTunnelURL(candidateConfig.HTTPTunnel.Host) {
			connector, connectorErr := newNavicatMySQLTunnelConnector(candidateConfig)
			if connectorErr != nil {
				errorDetails = append(errorDetails, fmt.Sprintf("%s Navicat HTTP 隧道配置失败: %v", address, connectorErr))
				continue
			}
			db := sql.OpenDB(connector)
			configureSQLConnectionPool(db, candidateConfig.Type)
			timeout := getConnectTimeout(candidateConfig)
			ctx, cancel := utils.ContextWithTimeout(timeout)
			pingErr := db.PingContext(ctx)
			cancel()
			if pingErr != nil {
				_ = db.Close()
				errorDetails = append(errorDetails, fmt.Sprintf("%s [Navicat HTTP 隧道] 验证失败: %v", address, pingErr))
				continue
			}
			m.conn = db
			m.pingTimeout = timeout
			m.navicatTunnel = true
			m.navicatTunnelClient = connector.client
			return nil
		}

		protocol, address, err := m.resolveProtocolAndAddress(candidateConfig)
		if err != nil {
			if _, requiresTrust := ssh.HostKeyTrustStatusFromError(err); requiresTrust {
				return fmt.Errorf("MySQL %s 创建 SSH 隧道失败: %w", address, err)
			}
			errorDetails = append(errorDetails, fmt.Sprintf("%s 生成连接串失败: %v", address, err))
			continue
		}
		plans, err := buildMySQLCompatibleConnectPlans(candidateConfig, protocol, address, candidateConfig.Database)
		if err != nil {
			errorDetails = append(errorDetails, fmt.Sprintf("%s 生成连接串失败: %v", address, err))
			continue
		}

		for _, plan := range plans {
			db, err := sql.Open("mysql", plan.dsn)
			if err != nil {
				if len(plans) > 1 || plan.label != mySQLCompatPlanDefaultLabel {
					errorDetails = append(errorDetails, fmt.Sprintf("%s [%s] 打开失败: %v", address, plan.label, err))
				} else {
					errorDetails = append(errorDetails, fmt.Sprintf("%s 打开失败: %v", address, err))
				}
				continue
			}
			configureSQLConnectionPool(db, candidateConfig.Type)

			timeout := getConnectTimeout(candidateConfig)
			ctx, cancel := utils.ContextWithTimeout(timeout)
			pingErr := db.PingContext(ctx)
			cancel()
			if pingErr != nil {
				_ = db.Close()
				if len(plans) > 1 || plan.label != mySQLCompatPlanDefaultLabel {
					errorDetails = append(errorDetails, fmt.Sprintf("%s [%s] 验证失败: %v", address, plan.label, pingErr))
				} else {
					errorDetails = append(errorDetails, fmt.Sprintf("%s 验证失败: %v", address, pingErr))
				}
				continue
			}

			if plan.label != mySQLCompatPlanDefaultLabel {
				logger.Warnf("MySQL 兼容回退生效：地址=%s 模式=%s", address, plan.label)
			}

			m.conn = db
			m.pingTimeout = timeout
			m.batchWritesEnabled = mysqlDSNSupportsBatchWrites(plan.dsn)
			return nil
		}
	}

	if len(errorDetails) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 MySQL 地址")
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(errorDetails, "；"))
}

func (m *MySQLDB) SupportsBatchWrites() bool {
	return m != nil && m.batchWritesEnabled
}

func (m *MySQLDB) SupportsBatchApply() bool {
	return m != nil && !m.navicatTunnel
}

func (m *MySQLDB) SupportsSessionExecer() bool {
	return m != nil && !m.navicatTunnel
}

func (m *MySQLDB) Close() error {
	if m.conn != nil {
		return m.conn.Close()
	}
	return nil
}

func (m *MySQLDB) Ping() error {
	if m.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return m.conn.PingContext(ctx)
}

func (m *MySQLDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if m.navicatTunnel {
		return m.QueryStatementsMultiContext(metadataContextFor(m), []string{query})
	}
	rows, err := m.conn.QueryContext(metadataContextFor(m), query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialect(rows, "mysql")
}

func (m *MySQLDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if m.navicatTunnel {
		return m.QueryStatementsMultiContext(ctx, []string{query})
	}
	rows, err := m.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialectContext(ctx, rows, "mysql")
}

func (m *MySQLDB) SupportsStatementBatchMultiResult() bool {
	return m != nil && m.navicatTunnel && m.navicatTunnelClient != nil
}

func (m *MySQLDB) QueryStatementsMultiContext(ctx context.Context, statements []string) ([]connection.ResultSetData, error) {
	if m == nil || !m.SupportsStatementBatchMultiResult() {
		return nil, errors.New("当前 MySQL 连接不支持语句数组批量查询")
	}
	if err := validateNavicatMySQLTransactionBatch(statements); err != nil {
		return nil, err
	}
	results, err := m.navicatTunnelClient.queryBatch(ctx, statements)
	converted := navicatMySQLTunnelResultSets(results, RowBudgetFromContext(ctx))
	return converted, err
}

func (m *MySQLDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := m.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRowsForDialectContext(ctx, rows, "mysql")
}

func (m *MySQLDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := m.conn.QueryContext(metadataContextFor(m), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, "mysql")
}

func (m *MySQLDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if m.navicatTunnel {
		return nil, navicatMySQLTunnelTransactionError()
	}
	conn, err := m.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	// 必须与 QueryContext 的扫描方言一致（mysql_impl.go:938 用 "mysql"）。
	// 传空串会让 scanDialect 退化，DATE 列在会话路径（流式导出、SQL 编辑器托管事务）
	// 被格式化成 RFC3339 时间戳，与网格直查的 2006-01-02 不一致，导出文件再导入 DATE 列会被拒绝。
	return NewSQLConnStatementExecerWithDialect(conn, "mysql"), nil
}

func (m *MySQLDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) Exec(query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) GetDatabases() ([]string, error) {
	return collectMySQLDatabaseNames(m.Query)
}
