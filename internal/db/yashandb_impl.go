//go:build gonavi_full_drivers || gonavi_yashandb_driver

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultYashanDBPort   = 1688
	yashanDBScanDialect   = "yashandb"
	yashanDBVersionQuery  = "SELECT banner AS version FROM v$version"
	yashanDBInstanceQuery = "SELECT version FROM v$instance"
)

// YashanDB 接入崖山数据库：通过用户安装的崖山客户端（yacli 库，见 yashandb_yacli_*.go）连接。崖山提供 Oracle 兼容的
// 数据字典（ALL_TABLES、ALL_TAB_COLUMNS、ALL_CONSTRAINTS…）与 DBMS_METADATA，表、列、索引、外键、触发器、
// 建表语句直接复用 OracleDB；库 = Schema（用户），选中的 Schema 写进每条连接的 CURRENT_SCHEMA。
type YashanDB struct {
	OracleDB
	driverVariantState
	// defaultSchema 是未限定的表名所属的 Schema（连接的默认库，留空时为登录用户）。
	defaultSchema string
}

var (
	_ Database                  = (*YashanDB)(nil)
	_ DriverVariantReporter     = (*YashanDB)(nil)
	_ TransactionExecerProvider = (*YashanDB)(nil)
	_ BatchApplierContext       = (*YashanDB)(nil)
)

// Connect 加载客户端库，按需建立 SSH 隧道后连接；连接参数里的 clientDir 指定客户端目录（留空时用 YASDB_HOME
// 或 ~/.yashandb/client），sslRootCert 指定服务端开启 SSL 时的根证书。
func (y *YashanDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = y.Close()
	defer func() {
		if err != nil {
			_ = y.Close()
		}
	}()
	params := connectionParamsFromText(config.ConnectionParams)
	library, err := resolveYashanClientLibrary(params.Get("clientDir"), params.Get("yacliLibrary"))
	if err != nil {
		return err
	}
	api, err := loadYacliAPI(library)
	if err != nil {
		return err
	}
	runConfig := config
	if runConfig.Port <= 0 {
		runConfig.Port = defaultYashanDBPort
	}
	y.pingTimeout = getConnectTimeout(runConfig)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		y.forwarder = forwarder
		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}
		runConfig.Host, runConfig.Port, runConfig.UseSSH = host, port, false
	}
	connector := &yacliConnector{
		api:           api,
		url:           net.JoinHostPort(strings.TrimSpace(runConfig.Host), strconv.Itoa(runConfig.Port)),
		user:          runConfig.User,
		password:      runConfig.Password,
		sslRootCert:   strings.TrimSpace(params.Get("sslRootCert")),
		currentSchema: strings.TrimSpace(runConfig.Database),
	}
	pool := sql.OpenDB(connector)
	configureSQLConnectionPool(pool, "oracle", runConfig)
	y.conn = pool
	y.scanDialect = yashanDBScanDialect
	y.defaultSchema = strings.TrimSpace(runConfig.Database)
	if y.defaultSchema == "" && !strings.HasPrefix(strings.TrimSpace(runConfig.User), `"`) {
		y.defaultSchema = strings.ToUpper(strings.TrimSpace(runConfig.User))
	}
	y.resetOracleMetadataCache()
	if err := y.Ping(); err != nil {
		return localizedDatabaseRuntimeError("db.backend.error.yashandb_connect_failed", map[string]any{"detail": err.Error()})
	}
	return y.resolve("yashandb", config, y.queryVersion())
}

// yashanSchemaIdentifier 返回 CURRENT_SCHEMA 的标识符：全大写或全小写的普通名字不加引号（按崖山规则转大写），
// 其余（大小写混合、含特殊字符，通常来自导航树的精确名字）加双引号保留原样。
func yashanSchemaIdentifier(schema string) string {
	if yashanPlainIdentifier.MatchString(schema) && (schema == strings.ToUpper(schema) || schema == strings.ToLower(schema)) {
		return schema
	}
	return QuoteOracleSchemaIdentifier(schema)
}

var (
	yashanPlainIdentifier = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_$#]*$`)
	yashanVersionPattern  = regexp.MustCompile(`(\d+\.\d+\.\d+(?:\.\d+)?)`)
)

// queryVersion 读取服务端版本（如 23.4.7.100）；v$version 不可见时改查 v$instance。
func (y *YashanDB) queryVersion() string {
	for _, query := range []string{yashanDBVersionQuery, yashanDBInstanceQuery} {
		rows, _, err := y.Query(query)
		if err != nil {
			logger.Warnf("崖山版本识别失败：%v", err)
			continue
		}
		if match := yashanVersionPattern.FindString(FirstQueryRowValue(rows)); match != "" {
			return match
		}
	}
	return ""
}

func (y *YashanDB) Close() error {
	err := y.OracleDB.Close()
	y.conn = nil
	return err
}

// OpenTransactionExecer 为 SQL 编辑器的托管事务固定一条连接并关闭自动提交（客户端的自动提交开着时文本
// COMMIT / ROLLBACK 管不住已执行的语句）。
func (y *YashanDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if y.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conn, err := y.conn.Conn(context.Background())
	if err != nil {
		return nil, err
	}
	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return NewSQLTxStatementExecerWithConn(tx, conn), nil
}

func (y *YashanDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return y.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 用 Oracle 的改动语句（:n 占位符、ROWID 定位）在驱动事务里提交网格改动，任一条失败整体回滚。
func (y *YashanDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if y.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	// 导入等入口传来的表名可能不带 Schema：先补上默认 Schema，Oracle 的列元数据回退查询（同义词）崖山不认。
	if schema, table := splitOracleQualifiedTableName(tableName); schema == "" && table != "" && y.defaultSchema != "" {
		tableName = y.defaultSchema + "." + tableName
	}
	columnTypeMap, err := y.loadColumnTypeMap(tableName)
	if err != nil {
		return err
	}
	tx, err := y.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := y.execOracleChanges(ctx, tx, tableName, changes, columnTypeMap); err != nil {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			return MarkWriteOutcomeUnknown(errors.Join(err, rollbackErr))
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		return MarkWriteOutcomeUnknown(fmt.Errorf("事务提交失败：%w", err))
	}
	return nil
}
