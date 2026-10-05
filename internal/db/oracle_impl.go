package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ssh"

	go_ora "github.com/sijms/go-ora/v2"
)

type OracleDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
	scanDialect string

	// metadataMu 保护 metadataCache 的惰性初始化。
	metadataMu    sync.Mutex
	metadataCache *oracleMetadataCache
}

var _ SessionExecerProvider = (*OracleDB)(nil)
var _ TransactionExecerProvider = (*OracleDB)(nil)
var _ StreamQueryExecer = (*OracleDB)(nil)

const oracleDefaultPrefetchRows = 25

var (
	oracleTriggerCreatePattern = regexp.MustCompile(`(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b`)
	oracleTriggerTimingPattern = regexp.MustCompile(`(?is)^\s*(?:BEFORE|AFTER|INSTEAD\s+OF)\b`)
	// DBMS_METADATA appends the enabled state as a separate statement; it is not part of the trigger definition.
	oracleTriggerEnableStatementPattern = regexp.MustCompile(`(?is)(?:\r?\n|;)\s*ALTER\s+TRIGGER\s+[^;]+?\s+ENABLE\s*;?\s*(?:/\s*)?$`)
)

func oracleRuntimeError(key string, params map[string]any) error {
	return fmt.Errorf("%s", localizedDriverRuntimeText(key, params))
}

// QuoteOracleSchemaIdentifier returns a safe, exact Oracle schema identifier.
// Always quoting preserves schemas created with case-sensitive names.
func QuoteOracleSchemaIdentifier(schema string) string {
	normalized := strings.TrimSpace(schema)
	if normalized == "" {
		return normalized
	}
	return `"` + strings.ReplaceAll(normalized, `"`, `""`) + `"`
}

type oracleCurrentSchemaConnector struct {
	base      driver.Connector
	statement string
}

type oracleSessionDriverConn interface {
	driver.Conn
	driver.ConnPrepareContext
	driver.ConnBeginTx
	driver.ExecerContext
	driver.QueryerContext
	driver.NamedValueChecker
	driver.Pinger
	driver.SessionResetter
}

var _ oracleSessionDriverConn = (*go_ora.Connection)(nil)

type oracleCurrentSchemaConn struct {
	oracleSessionDriverConn
	statement string
}

func newOracleCurrentSchemaConnector(base driver.Connector, schema string) driver.Connector {
	identifier := QuoteOracleSchemaIdentifier(schema)
	if identifier == "" {
		return base
	}
	return &oracleCurrentSchemaConnector{
		base:      base,
		statement: "ALTER SESSION SET CURRENT_SCHEMA = " + identifier,
	}
}

func (c *oracleCurrentSchemaConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	base, ok := conn.(oracleSessionDriverConn)
	if !ok {
		_ = conn.Close()
		return nil, fmt.Errorf("Oracle 驱动不支持 CURRENT_SCHEMA 会话初始化")
	}
	wrapped := &oracleCurrentSchemaConn{oracleSessionDriverConn: base, statement: c.statement}
	if err := wrapped.applyCurrentSchema(ctx); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return wrapped, nil
}

func (c *oracleCurrentSchemaConnector) Driver() driver.Driver {
	return c.base.Driver()
}

func (c *oracleCurrentSchemaConn) applyCurrentSchema(ctx context.Context) error {
	if _, err := c.ExecContext(ctx, c.statement, nil); err != nil {
		return fmt.Errorf("Oracle CURRENT_SCHEMA 初始化失败: %w", err)
	}
	return nil
}

func (c *oracleCurrentSchemaConn) ResetSession(ctx context.Context) error {
	if err := c.oracleSessionDriverConn.ResetSession(ctx); err != nil {
		return err
	}
	if err := c.applyCurrentSchema(ctx); err != nil {
		return driver.ErrBadConn
	}
	return nil
}

func openOracleSQLDatabase(dsn string, currentSchema string) (*sql.DB, error) {
	if strings.TrimSpace(currentSchema) == "" {
		return sql.Open("oracle", dsn)
	}
	return sql.OpenDB(newOracleCurrentSchemaConnector(go_ora.NewConnector(dsn), currentSchema)), nil
}
