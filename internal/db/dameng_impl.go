//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "gitee.com/chunanyong/dm"
)

type DamengDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
}

var _ TransactionExecerProvider = (*DamengDB)(nil)

func (d *DamengDB) getDSN(config connection.ConnectionConfig) string {
	// dm://user:password@host:port?schema=...
	// or dm://user:password@host:port

	address := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	q := url.Values{}
	if config.Database != "" {
		q.Set("schema", config.Database)
	}
	if config.UseSSL {
		if certPath := strings.TrimSpace(config.SSLCertPath); certPath != "" {
			q.Set("sslCertPath", certPath)
		}
		if keyPath := strings.TrimSpace(config.SSLKeyPath); keyPath != "" {
			q.Set("sslKeyPath", keyPath)
		}
	}
	mergeConnectionParamsFromConfigWithAllowlist(q, config, damengConnectionParamNames, "dm", "dameng")

	// 当前达梦 Go 驱动使用字符串切分解析 DSN，认证信息不会做 URL 反解码。
	// 密码保持原样传入，避免 p%40ss 这类转义文本被当作真实密码登录。
	dsn := fmt.Sprintf("dm://%s:%s@%s", config.User, config.Password, address)
	encoded := q.Encode()
	if encoded == "" {
		if strings.Contains(config.User, "?") || strings.Contains(config.Password, "?") {
			return dsn + "?"
		}
		return dsn
	}
	return dsn + "?" + encoded
}

func (d *DamengDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = d.Close()
	defer func() {
		if err != nil {
			_ = d.Close()
		}
	}()

	runConfig := config
	if runConfig.UseSSL {
		if strings.TrimSpace(runConfig.SSLCertPath) == "" || strings.TrimSpace(runConfig.SSLKeyPath) == "" {
			return fmt.Errorf("达梦启用 SSL 需要同时配置证书路径(sslCertPath)与私钥路径(sslKeyPath)")
		}
	}

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("达梦数据库使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		d.forwarder = forwarder

		// Parse local address
		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		// Create a modified config pointing to local forwarder
		localConfig := config
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false

		runConfig = localConfig
		logger.Infof("达梦数据库通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for idx, attempt := range attempts {
		dsn := d.getDSN(attempt)
		db, err := sql.Open("dm", dsn)
		if err != nil {
			failures = append(failures, fmt.Sprintf("第%d次连接打开失败: %v", idx+1, err))
			continue
		}
		configureSQLConnectionPool(db, "dameng")
		d.conn = db
		d.pingTimeout = getConnectTimeout(attempt)
		if err := d.Ping(); err != nil {
			_ = db.Close()
			d.conn = nil
			failures = append(failures, fmt.Sprintf("第%d次连接验证失败: %v", idx+1, err))
			continue
		}
		if idx > 0 {
			logger.Warnf("达梦 SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (d *DamengDB) Close() error {
	// Close SSH forwarder first if exists
	if d.forwarder != nil {
		if err := d.forwarder.Release(); err != nil {
			logger.Warnf("关闭达梦数据库 SSH 端口转发失败：%v", err)
		}
		d.forwarder = nil
	}

	// Then close database connection
	if d.conn != nil {
		return d.conn.Close()
	}
	return nil
}

func (d *DamengDB) Ping() error {
	if d.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := d.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return d.conn.PingContext(ctx)
}

func (d *DamengDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := d.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRowsContext(ctx, rows)
}

func (d *DamengDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := d.conn.QueryContext(metadataContextFor(d), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (d *DamengDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if d.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	rows, err := d.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()

	return streamRows(rows, consumer)
}

func (d *DamengDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return d.StreamQueryContext(context.Background(), query, consumer)
}

func (d *DamengDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if d.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := d.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DamengDB) Exec(query string) (int64, error) {
	if d.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := d.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// OpenTransactionExecer starts a driver-backed transaction that can remain
// open across SQL editor RPCs until an explicit commit or rollback.
func (d *DamengDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if d.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Do not bind the transaction to ctx: the editor finishes it in a later RPC.
	// Keep the pinned connection so failed finalization can evict it instead of
	// returning an unresolved transaction to database/sql's idle pool.
	conn, err := d.conn.Conn(context.Background())
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

func (d *DamengDB) GetDatabases() ([]string, error) {
	// 达梦在本项目中将 schema/owner 作为“数据库”展示口径。
	// 先查当前 schema / 当前用户，再聚合可见用户与 owner，避免权限受限时返回空列表。
	return collectDamengDatabaseNames(d.Query)
}

func (d *DamengDB) GetTables(dbName string) ([]string, error) {
	// 始终返回 OWNER.TABLE_NAME，与 Oracle 实现对齐，避免下游 SQL 缺少 schema 前缀（refs issue #445）
	// 列别名用双引号包裹强制大写，避免不同驱动版本返回不一致 case 导致 row map 取值失败
	escapedDBName := escapeDamengMetadataLiteral(dbName)
	var query string
	if escapedDBName != "" {
		query = fmt.Sprintf(`SELECT owner AS "OWNER", table_name AS "TABLE_NAME" FROM all_tables WHERE owner = '%s' ORDER BY table_name`, escapedDBName)
	} else {
		query = `SELECT USER AS "OWNER", table_name AS "TABLE_NAME" FROM user_tables ORDER BY table_name`
	}

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		owner, okOwner := row["OWNER"]
		name, okName := row["TABLE_NAME"]
		if okOwner && okName && name != nil {
			tables = append(tables, fmt.Sprintf("%v.%v", owner, name))
			continue
		}
		if okName && name != nil {
			tables = append(tables, fmt.Sprintf("%v", name))
		}
	}
	return tables, nil
}

func (d *DamengDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// DM: SP_TABLEDEF usually returns definition
	// Or standard Oracle way if supported.
	// We'll try a common DM approach.
	// SELECT DBMS_METADATA.GET_DDL('TABLE', 'TABLE_NAME', 'OWNER') FROM DUAL;

	escapedDBName := escapeDamengMetadataLiteral(dbName)
	escapedTableName := escapeDamengMetadataLiteral(tableName)
	query := fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s', '%s') as ddl FROM DUAL",
		escapedTableName, escapedDBName)

	if escapedDBName == "" {
		query = fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s') as ddl FROM DUAL", escapedTableName)
	}

	data, _, err := d.Query(query)
	if err != nil {
		return "", err
	}

	if len(data) > 0 {
		if ddl := getDamengRowString(data[0], "DDL"); ddl != "" {
			commentData, _, commentErr := d.Query(buildDamengTableCommentQuery(dbName, tableName))
			if commentErr != nil {
				logger.Warnf("达梦 GetCreateStatement 表注释元数据查询失败，已返回基础 DDL：%v", commentErr)
				return ddl, nil
			}
			if len(commentData) == 0 {
				return ddl, nil
			}
			comment := getDamengRowString(commentData[0], "TABLE_COMMENT", "COMMENT", "COMMENTS")
			return appendDamengTableCommentDDL(ddl, dbName, tableName, comment), nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func (d *DamengDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	data, _, err := d.Query(buildDamengColumnsQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}

	columns := buildDamengColumnDefinitions(data)
	if len(columns) == 0 {
		return columns, nil
	}
	if !hasDamengColumnComments(columns) {
		commentData, _, commentErr := d.Query(buildDamengColumnCommentsQuery(dbName, tableName))
		if commentErr != nil {
			logger.Warnf("达梦 GetColumns 原生字段注释查询失败，已返回基础字段定义：%v", commentErr)
		} else {
			columns = applyDamengColumnComments(columns, commentData)
		}
	}

	autoIncrementData, _, autoIncrementErr := d.Query(buildDamengAutoIncrementColumnsQuery(dbName, tableName))
	if autoIncrementErr != nil {
		logger.Warnf("达梦 GetColumns 自增字段元数据查询失败，已返回基础字段定义：%v", autoIncrementErr)
		return columns, nil
	}

	return applyDamengAutoIncrementColumns(columns, autoIncrementData), nil
}

func (d *DamengDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	data, _, err := d.Query(buildDamengIndexesQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}
	return buildDamengIndexDefinitions(data), nil
}

func (d *DamengDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	// Reusing Oracle style query as DM is highly compatible
	data, _, err := d.Query(buildDamengForeignKeysQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
			ColumnName:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			RefTableName:   fmt.Sprintf("%v", row["R_TABLE_NAME"]),
			RefColumnName:  fmt.Sprintf("%v", row["R_COLUMN_NAME"]),
			ConstraintName: fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (d *DamengDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	query := fmt.Sprintf(`SELECT trigger_name, trigger_type, triggering_event 
		FROM all_triggers 
		WHERE table_owner = '%s' AND table_name = '%s'`,
		escapeDamengMetadataLiteral(dbName), escapeDamengMetadataLiteral(tableName))

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["TRIGGER_NAME"]),
			Timing:    fmt.Sprintf("%v", row["TRIGGER_TYPE"]),
			Event:     fmt.Sprintf("%v", row["TRIGGERING_EVENT"]),
			Statement: "SOURCE HIDDEN",
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (d *DamengDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return d.ApplyChangesContext(context.Background(), tableName, changes)
}

func (d *DamengDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if d.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		n = strings.Trim(n, "\"")
		n = strings.ReplaceAll(n, "\"", "\"\"")
		if n == "" {
			return "\"\""
		}
		return `"` + n + `"`
	}

	schema, table := SplitSQLQualifiedNameForDialect(tableName, "dameng")

	qualifiedTable := ""
	if schema != "" {
		qualifiedTable = fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))
	} else {
		qualifiedTable = quoteIdent(table)
	}

	identityColumns, identityColumnsErr := d.identityColumnsForApply(schema, table)
	if identityColumnsErr != nil {
		// 旧版达梦或受限账号可能无法访问 SYS.SYSCOLUMNS。元数据只用于
		// 决定是否开启显式 identity 写入，不能因此阻断本来合法的普通 DML；
		// 若调用方确实写入了 identity 值，数据库仍会返回明确的原始错误。
		logger.Warnf("达梦 ApplyChanges 自增列元数据查询失败，将按普通 DML 继续：%v", identityColumnsErr)
		identityColumns = nil
	}
	identityInsertNeeded := changesWriteDamengIdentityColumns(changes, identityColumns)
	err = d.applyDamengChangesTransaction(ctx, qualifiedTable, changes, identityInsertNeeded)
	if err == nil || identityInsertNeeded || IsWriteOutcomeUnknown(err) || !isDamengIdentityInsertError(err) {
		return err
	}
	// 部分 DM8 版本/账号无法从 SYS.SYSCOLUMNS 读出 identity 标记。首批
	// 显式写入因此可能漏开关；此时首个事务已回滚，针对明确的 identity
	// 错误用新事务重放一次并强制开启开关。普通约束/网络错误不会走这里。
	logger.Warnf("达梦检测到显式写入自增列但未识别到 identity 元数据，将回滚后重试并开启 IDENTITY_INSERT：%v", err)
	return d.applyDamengChangesTransaction(ctx, qualifiedTable, changes, true)
}

func (d *DamengDB) applyDamengChangesTransaction(ctx context.Context, qualifiedTable string, changes connection.ChangeSet, identityInsertNeeded bool) (err error) {
	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		n = strings.Trim(n, "\"")
		n = strings.ReplaceAll(n, "\"", "\"\"")
		if n == "" {
			return "\"\""
		}
		return `"` + n + `"`
	}

	tx, err := d.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

	identityInsertEnabled := false
	disableIdentityInsert := func() error {
		if !identityInsertEnabled {
			return nil
		}
		if _, disableErr := tx.ExecContext(ctx, fmt.Sprintf("SET IDENTITY_INSERT %s OFF", qualifiedTable)); disableErr != nil {
			return fmt.Errorf("关闭 IDENTITY_INSERT 失败：%w", disableErr)
		}
		identityInsertEnabled = false
		return nil
	}
	defer func() {
		if disableErr := disableIdentityInsert(); disableErr != nil && err == nil {
			err = disableErr
		}
	}()
	if identityInsertNeeded {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("SET IDENTITY_INSERT %s ON", qualifiedTable)); err != nil {
			return fmt.Errorf("开启 IDENTITY_INSERT 失败：%w", err)
		}
		identityInsertEnabled = true
	}

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		idx := 0
		for k, v := range pk {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = :%d", quoteIdent(k), idx))
			args = append(args, v)
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, v := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = :%d", quoteIdent(k), idx))
			args = append(args, v)
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = :%d", quoteIdent(k), idx))
			args = append(args, v)
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
	}

	// 3. Inserts
	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}
		idx := 0

		for k, v := range row {
			idx++
			cols = append(cols, quoteIdent(k))
			placeholders = append(placeholders, fmt.Sprintf(":%d", idx))
			args = append(args, v)
		}

		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("插入失败：%v", err)
		}
	}

	if err := disableIdentityInsert(); err != nil {
		return err
	}
	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}

func isDamengIdentityInsertError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "identity_insert") {
		return true
	}
	return strings.Contains(text, "自增列") && strings.Contains(text, "指定列列表")
}

// identityColumnsForApply returns the target columns that require
// IDENTITY_INSERT for explicit values. The metadata lookup happens before the
// write transaction so its query cannot be scheduled onto the transaction's
// pinned connection.
func (d *DamengDB) identityColumnsForApply(schema, table string) (map[string]struct{}, error) {
	columns, err := d.GetColumns(schema, table)
	if err != nil {
		return nil, err
	}
	identityColumns := make(map[string]struct{})
	for _, column := range columns {
		if strings.Contains(strings.ToLower(strings.TrimSpace(column.Extra)), "auto_increment") {
			identityColumns[strings.ToLower(strings.TrimSpace(column.Name))] = struct{}{}
		}
	}
	return identityColumns, nil
}

// changesWriteDamengIdentityColumns checks only written values. Identity keys
// used in UPDATE predicates do not need IDENTITY_INSERT, while inserts and
// identity assignments in SET clauses do.
func changesWriteDamengIdentityColumns(changes connection.ChangeSet, identityColumns map[string]struct{}) bool {
	if len(identityColumns) == 0 {
		return false
	}
	containsIdentityColumn := func(values map[string]interface{}) bool {
		for column := range values {
			if _, ok := identityColumns[strings.ToLower(strings.TrimSpace(column))]; ok {
				return true
			}
		}
		return false
	}
	for _, row := range changes.Inserts {
		if containsIdentityColumn(row) {
			return true
		}
	}
	for _, update := range changes.Updates {
		if containsIdentityColumn(update.Values) {
			return true
		}
	}
	return false
}

func (d *DamengDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	// 达梦 COMMENT 为保留字，别名使用 col_comment（Error -2007: AS comment 语法分析出错）
	query := fmt.Sprintf(`SELECT c.table_name, c.column_name, c.data_type, cc.comments AS col_comment
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		WHERE c.owner = '%s'`, escapeDamengMetadataLiteral(dbName))

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["DATA_TYPE"]),
			Comment:   getDamengRowString(row, "COL_COMMENT", "COMMENT", "COMMENTS"),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
