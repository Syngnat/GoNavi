package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/shared/i18n"
)

const testConnectionTimeoutUpperBoundSeconds = 12

const connectionTestProgressEventName = "connection:test-progress"

type connectionTestProgressEvent struct {
	RunID  string `json:"runId"`
	Stage  string `json:"stage"`
	Status string `json:"status"`
}

type connectionTestProgressReporter func(stage string, status string)

func normalizeTestConnectionConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := config
	if normalized.Timeout <= 0 || normalized.Timeout > testConnectionTimeoutUpperBoundSeconds {
		normalized.Timeout = testConnectionTimeoutUpperBoundSeconds
	}
	return normalized
}

func newQueryExecutionContext(config connection.ConnectionConfig) (context.Context, context.CancelFunc) {
	return newQueryExecutionContextWithParent(context.Background(), config)
}

// newQueryExecutionContextWithParent keeps query cancellation linked to the
// caller while deliberately keeping connection establishment timeout separate
// from the query deadline.
func newQueryExecutionContextWithParent(parent context.Context, config connection.ConnectionConfig) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	if config.QueryTimeout > 0 {
		return context.WithTimeout(parent, time.Duration(config.QueryTimeout)*time.Second)
	}

	// Connection timeout is only for establishing the connection. Do not reuse it
	// as a query deadline; long-running queries remain cancellable via CancelQuery.
	return context.WithCancel(parent)
}

func validateTestConnectionInput(config connection.ConnectionConfig) error {
	return validateTestConnectionInputWithText(config, defaultDBBackendText)
}

func defaultDBBackendText(key string, params map[string]any) string {
	localizer, err := i18n.NewLocalizer(i18n.LanguageZhCN)
	if err != nil {
		return key
	}
	return localizer.T(key, params)
}

func validateTestConnectionInputWithText(config connection.ConnectionConfig, text func(string, map[string]any) string) error {
	if text == nil {
		text = defaultDBBackendText
	}
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "" {
		return fmt.Errorf("%s", text("db.backend.error.data_source_type_required", nil))
	}
	if dbType == "clickhouse" && strings.TrimSpace(config.Host) == "" && strings.TrimSpace(config.URI) == "" {
		return fmt.Errorf("%s", text("db.backend.error.clickhouse_address_required", nil))
	}
	return nil
}

// Generic DB Methods

func (a *App) DBConnect(config connection.ConnectionConfig) connection.QueryResult {
	if err := validateTestConnectionInputWithText(config, a.appText); err != nil {
		logger.Warnf("DBConnect 参数校验失败：%s %s", err.Error(), formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	// 连接测试需要强制 ping，避免缓存命中但连接已失效时误判成功。
	_, err := a.getDatabaseForcePing(config)
	if err != nil {
		logger.Error(err, "DBConnect 连接失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	logger.Infof("DBConnect 连接成功：%s", formatConnSummary(config))
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.connect_success", nil)}
}

func (a *App) DBReleaseConnection(config connection.ConnectionConfig) connection.QueryResult {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "redis" {
		closed, err := a.releaseRedisClientsForConfig(config)
		if err != nil {
			logger.Error(err, "DBReleaseConnection 释放 Redis 连接失败：%s", formatConnSummary(config))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		logger.Infof("DBReleaseConnection 已释放 Redis 连接：%s 数量=%d", formatConnSummary(config), closed)
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.release_success", nil), Data: map[string]int{"closed": closed}}
	}

	effectiveConfig, err := a.resolveEffectiveConnectionConfig(config)
	if err != nil {
		logger.Error(err, "DBReleaseConnection 解析运行时连接配置失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	closed := a.releaseCachedDatabaseConnectionsForConfig(effectiveConfig)

	logger.Infof("DBReleaseConnection 已释放数据库连接：%s 数量=%d", formatConnSummary(effectiveConfig), closed)
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.release_success", nil), Data: map[string]int{"closed": closed}}
}

func (a *App) TestConnection(config connection.ConnectionConfig) connection.QueryResult {
	return a.testConnection(config, nil)
}

// TestConnectionWithProgress emits non-sensitive SSH connection stages for one
// interactive test run. The ordinary TestConnection API remains available to
// headless and older clients without an event listener.
func (a *App) TestConnectionWithProgress(config connection.ConnectionConfig, runID string) connection.QueryResult {
	runID = strings.TrimSpace(runID)
	if runID == "" || !config.UseSSH {
		return a.testConnection(config, nil)
	}
	report := func(stage string, status string) {
		uievents.Emit(a.ctx, connectionTestProgressEventName, connectionTestProgressEvent{
			RunID:  runID,
			Stage:  stage,
			Status: status,
		})
	}
	return a.testConnection(config, report)
}

func (a *App) testConnection(config connection.ConnectionConfig, report connectionTestProgressReporter) connection.QueryResult {
	testConfig := normalizeTestConnectionConfig(config)
	started := time.Now()
	if report != nil {
		report("preparing", "running")
		testConfig.SSH = testConfig.SSH.WithProgressReporter(func(event connection.SSHProgressEvent) {
			report(event.Stage, event.Status)
		})
	}
	logger.Infof("TestConnection 开始：%s", formatConnSummary(testConfig))
	if err := validateTestConnectionInputWithText(testConfig, a.appText); err != nil {
		if report != nil {
			report("failed", "error")
		}
		logger.Warnf("TestConnection 参数校验失败：耗时=%s %s 原因=%s", time.Since(started).Round(time.Millisecond), formatConnSummary(testConfig), err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dbInst, err := a.openDatabaseIsolated(testConfig)
	if err != nil {
		dbInst, err = a.retryIsolatedTestConnectionAfterMySQLMaxUserConnections(testConfig, err)
	}
	if err != nil {
		if report != nil {
			report("failed", "error")
		}
		if trustResult, ok := a.sshHostKeyTrustRequiredResult(err); ok {
			logger.Warnf("TestConnection 需要确认 SSH 服务端身份：耗时=%s %s", time.Since(started).Round(time.Millisecond), formatConnSummary(testConfig))
			return trustResult
		}
		logger.Error(err, "TestConnection 连接测试失败：耗时=%s %s", time.Since(started).Round(time.Millisecond), formatConnSummary(testConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if dbInst != nil {
		if closeErr := dbInst.Close(); closeErr != nil {
			if report != nil {
				report("failed", "error")
			}
			logger.Error(closeErr, "TestConnection 释放临时连接失败：耗时=%s %s", time.Since(started).Round(time.Millisecond), formatConnSummary(testConfig))
			return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.test_connection_close_failed", map[string]any{"detail": closeErr.Error()})}
		}
	}

	if report != nil {
		report("database_connected", "success")
	}
	logger.Infof("TestConnection 连接测试成功：耗时=%s %s", time.Since(started).Round(time.Millisecond), formatConnSummary(testConfig))
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.connect_success", nil)}
}

func (a *App) retryIsolatedTestConnectionAfterMySQLMaxUserConnections(config connection.ConnectionConfig, err error) (db.Database, error) {
	if !isMySQLMaxUserConnectionsError(err) {
		return nil, err
	}

	effectiveConfig, resolveErr := a.resolveEffectiveConnectionConfig(config)
	if resolveErr != nil {
		return nil, err
	}
	released := a.releaseCachedDatabaseConnectionsForConfig(effectiveConfig)
	logger.Warnf("测试连接检测到 MySQL 用户连接数超限，已释放同实例缓存连接：%s 数量=%d", formatConnSummary(effectiveConfig), released)
	if released <= 0 {
		return nil, withMySQLMaxUserConnectionsHint(err, released)
	}

	dbInst, retryErr := a.openDatabaseIsolated(config)
	if retryErr != nil {
		if isMySQLMaxUserConnectionsError(retryErr) {
			return nil, withMySQLMaxUserConnectionsHint(retryErr, released)
		}
		return nil, retryErr
	}
	return dbInst, nil
}

func (a *App) MongoDiscoverMembers(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mongodb"

	dbInst, err := a.getDatabaseForcePing(config)
	if err != nil {
		logger.Error(err, "MongoDiscoverMembers 获取连接失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	discoverable, ok := dbInst.(interface {
		DiscoverMembers() (string, []connection.MongoMemberInfo, error)
	})
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.mongo_member_discovery_unsupported", nil)}
	}

	replicaSet, members, err := discoverable.DiscoverMembers()
	if err != nil {
		logger.Error(err, "MongoDiscoverMembers 执行失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	data := map[string]interface{}{
		"replicaSet": replicaSet,
		"members":    members,
	}

	logger.Infof("MongoDiscoverMembers 成功：%s 成员数=%d 副本集=%s", formatConnSummary(config), len(members), replicaSet)
	return connection.QueryResult{
		Success: true,
		Message: a.appText("db.backend.message.mongo_members_discovered", map[string]any{"count": len(members)}),
		Data:    data,
	}
}

func (a *App) CreateDatabase(config connection.ConnectionConfig, dbName string, charset string, collation string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("CREATE DATABASE %s", strings.TrimSpace(dbName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	dbName = strings.TrimSpace(dbName)
	if dbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.create_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := config
	runConfig.Database = ""
	if resolveDDLDBType(config) == "clickhouse" && strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		runConfig = runConfig.WithRuntimeDatabaseOverride("")
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(runConfig)
	query, err := buildCreateDatabaseQuery(dbType, dbName, charset, collation)
	if err != nil {
		switch {
		case errors.Is(err, errCreateDatabaseSphinxUnsupported):
			return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_create_sphinx_unsupported", nil)}
		case errors.Is(err, errCreateDatabaseUserSchemaUnsupported):
			return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_create_user_schema_unsupported", map[string]any{"dbType": dbType})}
		default:
			return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_option_invalid", map[string]any{"detail": err.Error()})}
		}
	}

	_, err = dbInst.Exec(query)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_created", nil)}
}

var (
	errCreateDatabaseSphinxUnsupported     = errors.New("sphinx create database unsupported")
	errCreateDatabaseUserSchemaUnsupported = errors.New("user schema create database unsupported")
)

// buildCreateDatabaseQuery 构造创建数据库 SQL。
//
// MySQL 系方言（mysql/mariadb/diros/oceanbase，以及被归一化为 mysql 的
// goldendb/greatdb 等）支持可选的字符集与排序规则；charset/collation 为空
// 时使用服务器默认值。两者只允许字母、数字与下划线，防止注入。
func buildCreateDatabaseQuery(dbType string, dbName string, charset string, collation string) (string, error) {
	charset = strings.TrimSpace(charset)
	collation = strings.TrimSpace(collation)
	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		escaped := strings.ReplaceAll(dbName, `"`, `""`)
		return fmt.Sprintf(`CREATE DATABASE "%s"`, escaped), nil
	case "sqlserver":
		return fmt.Sprintf("CREATE DATABASE %s", quoteIdentByType(dbType, dbName)), nil
	case "tdengine", "clickhouse", "starrocks":
		return fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", quoteIdentByType(dbType, dbName)), nil
	case "sphinx":
		return "", errCreateDatabaseSphinxUnsupported
	case "oracle", "dameng":
		return "", errCreateDatabaseUserSchemaUnsupported
	default:
		escaped := strings.ReplaceAll(dbName, "`", "``")
		query := fmt.Sprintf("CREATE DATABASE `%s`", escaped)
		if charset != "" {
			if !isSafeDatabaseOption(charset) {
				return "", fmt.Errorf("invalid database charset: %q", charset)
			}
			query += " CHARACTER SET " + charset
		}
		if collation != "" {
			if !isSafeDatabaseOption(collation) {
				return "", fmt.Errorf("invalid database collation: %q", collation)
			}
			query += " COLLATE " + collation
		}
		return query, nil
	}
}

// isSafeDatabaseOption 校验字符集/排序规则标识符，仅允许字母、数字与下划线。
func isSafeDatabaseOption(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return true
}

// supportsDatabaseCharsetOptions 判断数据源是否支持字符集/排序规则选项。
func supportsDatabaseCharsetOptions(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "diros", "oceanbase":
		return true
	default:
		return false
	}
}

// ListDatabaseCharsets 返回 MySQL 系数据源可用的字符集列表（SHOW CHARACTER SET）。
// 非 MySQL 系返回空列表。
func (a *App) ListDatabaseCharsets(config connection.ConnectionConfig) (result connection.QueryResult) {
	if !supportsDatabaseCharsetOptions(resolveDDLDBType(config)) {
		return connection.QueryResult{Success: true, Data: []connection.DatabaseCharset{}}
	}
	runConfig := config
	runConfig.Database = ""
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	rows, _, err := dbInst.Query("SHOW CHARACTER SET")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	charsets := make([]connection.DatabaseCharset, 0, len(rows))
	for _, row := range rows {
		charsets = append(charsets, connection.DatabaseCharset{
			Name:             rowStringValue(row, "Charset"),
			Description:      rowStringValue(row, "Description"),
			DefaultCollation: rowStringValue(row, "Default collation"),
			MaxLength:        rowIntValue(row, "Maxlen"),
		})
	}
	return connection.QueryResult{Success: true, Data: charsets}
}

// ListDatabaseCollations 返回 MySQL 系数据源可用的排序规则列表（SHOW COLLATION）。
// 非 MySQL 系返回空列表。
func (a *App) ListDatabaseCollations(config connection.ConnectionConfig) (result connection.QueryResult) {
	if !supportsDatabaseCharsetOptions(resolveDDLDBType(config)) {
		return connection.QueryResult{Success: true, Data: []connection.DatabaseCollation{}}
	}
	runConfig := config
	runConfig.Database = ""
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	rows, _, err := dbInst.Query("SHOW COLLATION")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	collations := make([]connection.DatabaseCollation, 0, len(rows))
	for _, row := range rows {
		collations = append(collations, connection.DatabaseCollation{
			Name:    rowStringValue(row, "Collation"),
			Charset: rowStringValue(row, "Charset"),
		})
	}
	return connection.QueryResult{Success: true, Data: collations}
}

// rowStringValue 从查询结果行中提取字符串列值。
func rowStringValue(row map[string]interface{}, key string) string {
	value, ok := row[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

// rowIntValue 从查询结果行中提取整数列值。
func rowIntValue(row map[string]interface{}, key string) int {
	value, ok := row[key]
	if !ok || value == nil {
		return 0
	}
	switch n := value.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(n))
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

func isPostgresSchemaDDLDBType(dbType string) bool {
	switch resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return true
	default:
		return false
	}
}

func resolvePGLikeDatabaseDDLCandidates(dbType string, user string) []string {
	switch resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) {
	case "kingbase":
		return []string{"test", "template1", strings.TrimSpace(user)}
	case "vastbase":
		return []string{"vastbase", "postgres", "template1", strings.TrimSpace(user)}
	default:
		return []string{"postgres", "template1", strings.TrimSpace(user)}
	}
}

func resolvePGLikeDatabaseDDLRunConfig(config connection.ConnectionConfig, dbType string, targetDatabase string) connection.ConnectionConfig {
	runConfig := config
	target := strings.TrimSpace(targetDatabase)
	current := strings.TrimSpace(runConfig.Database)
	if current != "" && !strings.EqualFold(current, target) {
		return runConfig
	}

	candidates := resolvePGLikeDatabaseDDLCandidates(dbType, runConfig.User)
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		name := strings.TrimSpace(candidate)
		if name == "" || strings.EqualFold(name, target) {
			continue
		}
		normalized := strings.ToLower(name)
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		runConfig.Database = name
		return runConfig
	}

	runConfig.Database = ""
	return runConfig
}

func buildCreateSchemaSQL(dbType string, schemaName string) (string, error) {
	return buildCreateSchemaSQLWithText(dbType, schemaName, defaultDBBackendText)
}

func buildCreateSchemaSQLWithText(dbType string, schemaName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	schemaName = strings.TrimSpace(schemaName)
	if schemaName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_name_required", nil))
	}

	if !isPostgresSchemaDDLDBType(dbType) {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_create_unsupported", map[string]any{"dbType": dbType}))
	}

	return fmt.Sprintf("CREATE SCHEMA %s", quoteIdentByType(dbType, schemaName)), nil
}

func buildRenameSchemaSQL(dbType string, oldSchemaName string, newSchemaName string) (string, error) {
	return buildRenameSchemaSQLWithText(dbType, oldSchemaName, newSchemaName, defaultDBBackendText)
}

func buildRenameSchemaSQLWithText(dbType string, oldSchemaName string, newSchemaName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	oldSchemaName = strings.TrimSpace(oldSchemaName)
	newSchemaName = strings.TrimSpace(newSchemaName)
	if oldSchemaName == "" || newSchemaName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_name_required", nil))
	}
	if oldSchemaName == newSchemaName {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_same_name", nil))
	}
	if !isPostgresSchemaDDLDBType(dbType) {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_rename_unsupported", map[string]any{"dbType": dbType}))
	}
	return fmt.Sprintf(
		"ALTER SCHEMA %s RENAME TO %s",
		quoteIdentByType(dbType, oldSchemaName),
		quoteIdentByType(dbType, newSchemaName),
	), nil
}

func buildDropSchemaSQL(dbType string, schemaName string) (string, error) {
	return buildDropSchemaSQLWithText(dbType, schemaName, defaultDBBackendText)
}

func buildDropSchemaSQLWithText(dbType string, schemaName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	schemaName = strings.TrimSpace(schemaName)
	if schemaName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_name_required", nil))
	}
	if !isPostgresSchemaDDLDBType(dbType) {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_drop_unsupported", map[string]any{"dbType": dbType}))
	}
	return fmt.Sprintf("DROP SCHEMA %s CASCADE", quoteIdentByType(dbType, schemaName)), nil
}

func resolveSchemaDDLTargetDatabase(config connection.ConnectionConfig, dbName string) (string, error) {
	return resolveSchemaDDLTargetDatabaseWithText(config, dbName, defaultDBBackendText)
}

func resolveSchemaDDLTargetDatabaseWithText(config connection.ConnectionConfig, dbName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	targetDbName := strings.TrimSpace(dbName)
	if targetDbName == "" {
		targetDbName = strings.TrimSpace(config.Database)
	}
	if targetDbName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.target_database_required", nil))
	}
	return targetDbName, nil
}

func (a *App) CreateSchema(config connection.ConnectionConfig, dbName string, schemaName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("CREATE SCHEMA %s", strings.TrimSpace(schemaName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.create_schema"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dbType := resolveDDLDBType(config)
	targetDbName, err := resolveSchemaDDLTargetDatabaseWithText(config, dbName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query, err := buildCreateSchemaSQLWithText(dbType, schemaName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := buildRunConfigForDDL(config, dbType, targetDbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if _, err := dbInst.Exec(query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.schema_created", nil)}
}

func (a *App) RenameSchema(config connection.ConnectionConfig, dbName string, oldSchemaName string, newSchemaName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER SCHEMA %s RENAME TO %s", strings.TrimSpace(oldSchemaName), strings.TrimSpace(newSchemaName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_schema"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dbType := resolveDDLDBType(config)
	targetDbName, err := resolveSchemaDDLTargetDatabaseWithText(config, dbName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query, err := buildRenameSchemaSQLWithText(dbType, oldSchemaName, newSchemaName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := buildRunConfigForDDL(config, dbType, targetDbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.schema_renamed", nil)}
}

func (a *App) DropSchema(config connection.ConnectionConfig, dbName string, schemaName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP SCHEMA %s", strings.TrimSpace(schemaName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_schema"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dbType := resolveDDLDBType(config)
	targetDbName, err := resolveSchemaDDLTargetDatabaseWithText(config, dbName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query, err := buildDropSchemaSQLWithText(dbType, schemaName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := buildRunConfigForDDL(config, dbType, targetDbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.schema_dropped", nil)}
}

func resolveDDLDBType(config connection.ConnectionConfig) string {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "doris" {
		return "diros"
	}
	if dbType == "mssql" || dbType == "sql_server" || dbType == "sql-server" {
		return "sqlserver"
	}
	if dbType == "postgresql" {
		return "postgres"
	}
	if dbType == "gauss_db" || dbType == "gauss-db" {
		return "gaussdb"
	}
	if dbType == "goldendb" || dbType == "greatdb" || dbType == "gdb" {
		return "mysql"
	}
	if dbType == "kingbase8" || dbType == "kingbasees" || dbType == "kingbasev8" {
		return "kingbase"
	}
	if dbType == "milvusdb" || dbType == "milvus-db" {
		return "milvus"
	}
	if dbType == "intersystems" || dbType == "intersystemsiris" || dbType == "inter-systems" || dbType == "inter-systems-iris" {
		return "iris"
	}
	if dbType == "oceanbase" && isOceanBaseOracleProtocol(config) {
		return "oracle"
	}
	if dbType != "custom" {
		return dbType
	}

	driver := strings.ToLower(strings.TrimSpace(config.Driver))
	switch driver {
	case "postgresql", "postgres", "pg", "pq", "pgx":
		return "postgres"
	case "opengauss", "open_gauss", "open-gauss":
		return "opengauss"
	case "gaussdb", "gauss_db", "gauss-db":
		return "gaussdb"
	case "goldendb", "greatdb", "gdb":
		return "mysql"
	case "dm", "dameng", "dm8":
		return "dameng"
	case "sqlite3", "sqlite":
		return "sqlite"
	case "sphinxql":
		return "sphinx"
	case "mssql", "sqlserver", "sql_server", "sql-server":
		return "sqlserver"
	case "diros", "doris":
		return "diros"
	case "starrocks":
		return "starrocks"
	case "kingbase", "kingbase8", "kingbasees", "kingbasev8":
		return "kingbase"
	case "highgo":
		return "highgo"
	case "vastbase":
		return "vastbase"
	case "iris", "intersystems", "intersystemsiris", "inter-systems", "inter-systems-iris":
		return "iris"
	case "oceanbase":
		return "oceanbase"
	case "milvus", "milvusdb", "milvus-db":
		return "milvus"
	}

	switch {
	case strings.Contains(driver, "opengauss"), strings.Contains(driver, "open_gauss"), strings.Contains(driver, "open-gauss"):
		return "opengauss"
	case strings.Contains(driver, "gaussdb"), strings.Contains(driver, "gauss_db"), strings.Contains(driver, "gauss-db"):
		return "gaussdb"
	case strings.Contains(driver, "goldendb"), strings.Contains(driver, "greatdb"):
		return "mysql"
	case strings.Contains(driver, "postgres"):
		return "postgres"
	case strings.Contains(driver, "kingbase"):
		return "kingbase"
	case strings.Contains(driver, "highgo"):
		return "highgo"
	case strings.Contains(driver, "vastbase"):
		return "vastbase"
	case strings.Contains(driver, "iris"), strings.Contains(driver, "intersystems"):
		return "iris"
	case strings.Contains(driver, "sqlite"):
		return "sqlite"
	case strings.Contains(driver, "sphinx"):
		return "sphinx"
	case strings.Contains(driver, "sqlserver"), strings.Contains(driver, "sql_server"), strings.Contains(driver, "sql-server"), strings.Contains(driver, "mssql"):
		return "sqlserver"
	case strings.Contains(driver, "diros"), strings.Contains(driver, "doris"):
		return "diros"
	case strings.Contains(driver, "starrocks"):
		return "starrocks"
	case strings.Contains(driver, "oceanbase"):
		return "oceanbase"
	default:
		return driver
	}
}

func normalizeSchemaAndTableByType(dbType string, dbName string, tableName string) (string, string) {
	rawTable := strings.TrimSpace(tableName)
	rawDB := strings.TrimSpace(dbName)
	if rawTable == "" {
		return rawDB, rawTable
	}

	// Elasticsearch / RocketMQ / MQTT / RabbitMQ / Kafka / Trino：对象名可能含多个点或路径，不能按点分割
	if dbType == "elasticsearch" || dbType == "rocketmq" || dbType == "mqtt" || dbType == "kafka" || dbType == "rabbitmq" || dbType == "trino" {
		return rawDB, rawTable
	}

	if dbType == "kingbase" {
		// DDL target parts are logical identifier values.  The metadata
		// adapters may need to preserve a quoted final segment for their own
		// second-pass parsing, but feeding that delimiter into the generic
		// quoter would encode it as part of the identifier.
		schema, table := db.SplitKingbaseQualifiedName(rawTable)
		if schema != "" && table != "" {
			return schema, table
		}
		if table != "" {
			return "public", table
		}
	}

	if dbType == "postgres" || dbType == "highgo" || dbType == "vastbase" || dbType == "opengauss" || dbType == "gaussdb" {
		// Keep DDL construction separate from metadata argument handling:
		// quoteSqlIdentifierPath/quoteTableIdentByType adds the dialect
		// delimiter itself, so the parts must not retain an input delimiter.
		schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType)
		if schema != "" && table != "" {
			return schema, table
		}
		if table != "" {
			return "public", table
		}
	}

	if dbType == "iris" {
		schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType)
		if schema != "" && table != "" {
			return schema, table
		}
		if table != "" {
			return "", table
		}
	}

	if dbType == "duckdb" {
		return rawDB, rawTable
	}

	if dbType == "sqlite" {
		return normalizeSQLiteSchemaAndTable(rawDB, rawTable)
	}

	// Use the quote-aware splitter for ordinary SQL dialects. A table name
	// such as `Sales.Data` is one identifier; strings.SplitN would incorrectly
	// turn the dot inside its delimiters into a schema separator. Preserve the
	// final delimiter for dialects whose driver parses this argument again.
	if shouldPreserveQuotedTableSegment(dbType) {
		if schema, table := db.SplitSQLQualifiedNamePreserveTableQuoteForDialect(rawTable, dbType); table != "" {
			if schema != "" {
				return schema, table
			}
			return rawDB, table
		}
	} else if schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType); table != "" {
		if schema != "" {
			return schema, table
		}
		return rawDB, table
	}

	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return "public", rawTable
	default:
		return rawDB, rawTable
	}
}

func resolveCreateStatementTargets(config connection.ConnectionConfig, dbType string, dbName string, tableName string) (string, string, string, string) {
	if dbType == "sqlserver" {
		metadataDB := strings.TrimSpace(dbName)
		if metadataDB == "" {
			metadataDB = strings.TrimSpace(config.Database)
		}
		rawTable := strings.TrimSpace(tableName)
		schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType)
		if table == "" {
			table = rawTable
		}
		if schema == "" {
			schema = "dbo"
		}
		return metadataDB, rawTable, schema, table
	}

	// Metadata adapters and DDL rendering intentionally use different forms:
	// adapters that parse the table argument a second time need the delimiter
	// preserved around a dotted final identifier, while the DDL quoter must see
	// the logical value so it can add exactly one delimiter itself.
	ddlSchemaName, ddlTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	metadataSchemaName, metadataTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	// Kingbase's fallback builder and metadata adapters use the explicit
	// public schema contract for an unqualified table. Keep the generic
	// PostgreSQL-family metadata path search_path-aware, but do not pass an
	// empty schema to this legacy-compatible Kingbase fallback.
	if dbType == "kingbase" && strings.TrimSpace(metadataSchemaName) == "" && strings.TrimSpace(ddlSchemaName) != "" {
		metadataSchemaName = ddlSchemaName
	}
	if strings.TrimSpace(metadataTableName) == "" {
		metadataSchemaName, metadataTableName = ddlSchemaName, ddlTableName
	}
	return metadataSchemaName, metadataTableName, ddlSchemaName, ddlTableName
}

func quoteTableIdentByType(dbType string, schema string, table string) string {
	s := strings.TrimSpace(schema)
	t := strings.TrimSpace(table)
	if dbType == "trino" {
		catalog, namespace := splitTrinoNamespace(s)
		switch {
		case catalog == "" && namespace == "":
			return quoteIdentByType(dbType, t)
		case namespace == "":
			return fmt.Sprintf("%s.%s", quoteIdentByType(dbType, catalog), quoteIdentByType(dbType, t))
		default:
			return fmt.Sprintf("%s.%s.%s", quoteIdentByType(dbType, catalog), quoteIdentByType(dbType, namespace), quoteIdentByType(dbType, t))
		}
	}
	if s == "" {
		return quoteIdentByType(dbType, t)
	}
	return fmt.Sprintf("%s.%s", quoteIdentByType(dbType, s), quoteIdentByType(dbType, t))
}

func splitTrinoNamespace(raw string) (string, string) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", ""
	}
	parts := strings.SplitN(text, ".", 2)
	if len(parts) == 1 {
		return strings.TrimSpace(parts[0]), ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func buildRunConfigForDDL(config connection.ConnectionConfig, dbType string, dbName string) connection.ConnectionConfig {
	runConfig := normalizeRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		// custom 连接的 dbName 语义依赖 driver，尽量在常见驱动上对齐内置类型行为。
		switch dbType {
		case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "dameng", "sqlserver", "clickhouse":
			if strings.TrimSpace(dbName) != "" {
				runConfig.Database = strings.TrimSpace(dbName)
			}
		}
	}
	return runConfig
}

func (a *App) RenameDatabase(config connection.ConnectionConfig, oldName string, newName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER DATABASE %s RENAME TO %s", strings.TrimSpace(oldName), strings.TrimSpace(newName))
	defer a.beginSQLAuditUserAction(config, oldName, "object_editor", &auditSQL, &result)()
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.EqualFold(oldName, newName) {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_same_name", nil)}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "diros":
		runConfig := config
		if strings.TrimSpace(runConfig.Database) == "" {
			runConfig.Database = oldName
		}
		dbInst, err := a.getDatabase(runConfig)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		sql := fmt.Sprintf("ALTER DATABASE %s RENAME %s", quoteIdentByType(dbType, oldName), quoteIdentByType(dbType, newName))
		if _, err := dbInst.Exec(sql); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_renamed", nil)}
	case "mysql", "mariadb", "oceanbase", "starrocks", "sphinx":
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_rename_direct_unsupported", nil)}
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		runConfig := resolvePGLikeDatabaseDDLRunConfig(config, dbType, oldName)
		dbInst, err := a.getDatabase(runConfig)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		sql := fmt.Sprintf("ALTER DATABASE %s RENAME TO %s", quoteIdentByType(dbType, oldName), quoteIdentByType(dbType, newName))
		if _, err := dbInst.Exec(sql); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_renamed", nil)}
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_rename_unsupported", map[string]any{"dbType": dbType})}
	}
}

func (a *App) DropDatabase(config connection.ConnectionConfig, dbName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP DATABASE %s", strings.TrimSpace(dbName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	dbName = strings.TrimSpace(dbName)
	if dbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(config)
	var (
		runConfig connection.ConnectionConfig
		sql       string
	)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "tdengine", "clickhouse":
		runConfig = config
		runConfig.Database = ""
		if dbType == "clickhouse" && strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
			runConfig = runConfig.WithRuntimeDatabaseOverride("")
		}
		sql = fmt.Sprintf("DROP DATABASE %s", quoteIdentByType(dbType, dbName))
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		runConfig = resolvePGLikeDatabaseDDLRunConfig(config, dbType, dbName)
		sql = fmt.Sprintf("DROP DATABASE %s", quoteIdentByType(dbType, dbName))
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_drop_unsupported", map[string]any{"dbType": dbType})}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_dropped", nil)}
}

func (a *App) RenameTable(config connection.ConnectionConfig, dbName string, oldTableName string, newTableName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER TABLE %s RENAME TO %s", strings.TrimSpace(oldTableName), strings.TrimSpace(newTableName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	oldTableName = strings.TrimSpace(oldTableName)
	newTableName = strings.TrimSpace(newTableName)
	if oldTableName == "" || newTableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_table"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.EqualFold(oldTableName, newTableName) {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_same_name", nil)}
	}
	if strings.Contains(newTableName, ".") {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_new_name_no_qualifier", nil)}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "clickhouse":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_rename_unsupported", map[string]interface{}{"dbType": dbType})}
	}

	schemaName, pureOldTableName := normalizeSchemaAndTableByType(dbType, dbName, oldTableName)
	if pureOldTableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.old_table_name_required", nil)}
	}
	oldQualifiedTable := quoteTableIdentByType(dbType, schemaName, pureOldTableName)
	newTableQuoted := quoteIdentByType(dbType, newTableName)

	var sql string
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "clickhouse":
		newQualifiedTable := quoteTableIdentByType(dbType, schemaName, newTableName)
		sql = fmt.Sprintf("RENAME TABLE %s TO %s", oldQualifiedTable, newQualifiedTable)
	case "sqlserver":
		// SQL Server 使用 sp_rename，参数为 'schema.oldname', 'newname'
		oldFullName := schemaName + "." + pureOldTableName
		escapedOld := strings.ReplaceAll(oldFullName, "'", "''")
		escapedNew := strings.ReplaceAll(newTableName, "'", "''")
		sql = fmt.Sprintf("EXEC sp_rename '%s', '%s'", escapedOld, escapedNew)
	default:
		sql = fmt.Sprintf("ALTER TABLE %s RENAME TO %s", oldQualifiedTable, newTableQuoted)
	}

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.table_renamed", nil)}
}

func (a *App) DropTable(config connection.ConnectionConfig, dbName string, tableName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP TABLE %s", strings.TrimSpace(tableName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	tableName = strings.TrimSpace(tableName)
	if tableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_table"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "tdengine", "clickhouse":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_drop_unsupported", map[string]interface{}{"dbType": dbType})}
	}

	schemaName, pureTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	if pureTableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
	}
	qualifiedTable := quoteTableIdentByType(dbType, schemaName, pureTableName)
	sql := fmt.Sprintf("DROP TABLE %s", qualifiedTable)

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.table_dropped", nil)}
}

func (a *App) MySQLConnect(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mysql"
	return a.DBConnect(config)
}

func (a *App) MySQLQuery(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBQuery(config, dbName, query)
}

func (a *App) MySQLGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mysql"
	return a.DBGetDatabases(config)
}

func (a *App) MySQLGetTables(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBGetTables(config, dbName)
}

func (a *App) MySQLShowCreateTable(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBShowCreateTable(config, dbName, tableName)
}

type dbQueryAuditOptions struct {
	trackHistory              bool
	auditAll                  bool
	auditWrites               bool
	source                    string
	executionContext          context.Context
	synchronousConnectionWait bool
	classifyConnectionErrors  bool
}

type dbQueryMultiAuditOptions struct {
	auditAll                  bool
	auditWrites               bool
	source                    string
	executionContext          context.Context
	synchronousConnectionWait bool
	classifyConnectionErrors  bool
}

func buildQueryConnectionFailure(err error, queryID string, classify bool) connection.QueryResult {
	result := connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		result.Data = map[string]any{"cancelled": true}
		return result
	}
	if classify {
		result.Data = map[string]any{"errorKind": headlessResultErrorKindConnection}
	}
	return result
}

// buildQueryExecutionFailure preserves cancellation provenance when a driver
// returns context.Canceled or context.DeadlineExceeded from an in-flight read.
// The query context may already have been cleaned up by the time the CLI maps
// the result, so the marker must travel with the QueryResult itself.
func buildQueryExecutionFailure(ctx context.Context, err error, message string, queryID string) connection.QueryResult {
	if message == "" && err != nil {
		message = err.Error()
	}
	result := connection.QueryResult{Success: false, Message: message, QueryID: queryID}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
		(ctx != nil && (errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded))) {
		result.Data = map[string]any{"cancelled": true}
	}
	return result
}

func (a *App) buildCancellationUnsupportedExecutionResult(result connection.QueryResult, err error) connection.QueryResult {
	result.Success = err == nil
	result.CancellationState = connection.QueryCancellationStateUnsupported
	result.Message = a.appText("query_editor.message.cancel_unsupported", nil)
	if err != nil {
		result.Message += ": " + err.Error()
	}
	return result
}

func containsSQLAuditWrite(dbType string, query string) bool {
	statements := splitSQLStatementsForDialect(dbType, query)
	if len(statements) == 0 {
		return !isReadOnlySQLQuery(dbType, query)
	}
	for _, statement := range statements {
		statement = strings.TrimSpace(statement)
		if statement != "" && !isReadOnlySQLQuery(dbType, statement) {
			return true
		}
	}
	return false
}

// writeExecutionOutcomeUnknown covers both a driver-level ambiguous response
// and a caller cancellation observed while a write was in flight. The latter
// must be treated as unknown even when a driver returns an opaque error rather
// than context.Canceled after it may already have dispatched the statement.
func writeExecutionOutcomeUnknown(ctx context.Context, err error) bool {
	return db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err) || (ctx != nil && ctx.Err() != nil)
}

// classifyDispatchedWriteError treats opaque connection-loss messages as an
// unknown write outcome. Once a write has been dispatched, reconnecting and
// replaying it is unsafe even when the driver did not return a typed network
// error.
func classifyDispatchedWriteError(err error) error {
	if err == nil || db.IsWriteOutcomeUnknown(err) || !shouldRefreshCachedConnection(err) {
		return err
	}
	return db.MarkWriteOutcomeUnknown(err)
}

// buildWriteExecutionFailure keeps the no-retry/unknown-outcome contract
// visible to headless callers. Drivers normally attach WriteOutcomeUnknown
// themselves; transport failures and a cancelled in-flight context are
// conservatively treated the same way so a statement that may have reached
// the server is never reported as rejected.
func buildWriteExecutionFailure(ctx context.Context, err error, queryID string) connection.QueryResult {
	data := map[string]any{}
	if writeExecutionOutcomeUnknown(ctx, err) {
		data["outcomeUnknown"] = true
	}
	result := connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	if len(data) > 0 {
		result.Data = data
	}
	return result
}

func summarizeMultiStatementResult(result connection.QueryResult, executedCount, failedIndex int, boundaryMode string, outcomeUnknown bool) connection.QueryResult {
	return summarizeMultiStatementResultWithCommitMode(result, executedCount, failedIndex, boundaryMode, sqlaudit.CommitModeAuto, outcomeUnknown)
}

func summarizeMultiStatementResultWithCommitMode(result connection.QueryResult, executedCount, failedIndex int, boundaryMode string, commitMode string, outcomeUnknown bool) connection.QueryResult {
	result.ExecutedCount = executedCount
	result.FailedIndex = failedIndex
	result.BoundaryMode = boundaryMode
	result.CommitMode = commitMode
	result.OutcomeUnknown = result.OutcomeUnknown || outcomeUnknown
	result.Partial = result.Partial || executedCount > 0 && failedIndex > 0
	return result
}

func sqlAuditTextTransactionMetadata(statement string, transactionOpen bool) (boundaryMode string, commitMode string) {
	if !isSQLTransactionControlStatement(statement) {
		if transactionOpen {
			return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
		}
		return sqlaudit.BoundaryModeImplicit, sqlaudit.CommitModeAuto
	}

	keyword, keywordEnd := nextSQLKeyword(statement, 0)
	switch keyword {
	case "begin":
		if isBeginTransactionControlStatement(statement, keywordEnd) {
			return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
		}
	case "start", "savepoint", "release":
		return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
	case "commit", "rollback":
		return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModeManual
	}
	return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
}

func advancesSQLAuditTextTransaction(statement string, transactionOpen bool) bool {
	keyword, keywordEnd := nextSQLKeyword(statement, 0)
	switch keyword {
	case "begin":
		return transactionOpen || isBeginTransactionControlStatement(statement, keywordEnd)
	case "start":
		return transactionOpen || strings.Contains(strings.ToLower(statement), "transaction")
	case "commit":
		return false
	case "rollback":
		// ROLLBACK TO SAVEPOINT preserves the surrounding transaction.
		return strings.Contains(strings.ToLower(statement), " to ")
	default:
		return transactionOpen
	}
}

func executedStatementCount(err error) int {
	if err == nil {
		return 1
	}
	return 0
}

func failedStatementIndex(index int, err error) int {
	if err != nil {
		return index
	}
	return 0
}

func (a *App) DBQuery(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, "", dbQueryAuditOptions{
		auditAll:    a.webRuntime,
		auditWrites: true,
		source:      "application_api",
	})
}

func (a *App) DBQueryWithCancel(config connection.ConnectionConfig, dbName string, query string, queryID string) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	auditSource := "query_editor"
	if !explicitQuery {
		auditSource = "application_api"
	}
	return a.dbQueryWithCancel(config, dbName, query, queryID, dbQueryAuditOptions{
		trackHistory: explicitQuery,
		auditAll:     explicitQuery || a.webRuntime,
		auditWrites:  true,
		source:       auditSource,
	})
}

func (a *App) dbQueryWithCancel(
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	auditOptions dbQueryAuditOptions,
) (result connection.QueryResult) {
	runConfig := normalizeRunConfig(config, dbName)
	if queryID == "" {
		queryID = requestTraceIDFromContext(auditOptions.executionContext)
	}
	if queryID == "" {
		queryID = generateQueryID()
	}
	traceContext, requestTrace, ownsRequestTrace := a.beginQueryRequestTrace(
		auditOptions.executionContext,
		runConfig,
		queryID,
		auditOptions.source,
		"database.query",
	)
	auditOptions.executionContext = traceContext
	defer func() {
		a.recordQueryRequestTraceOutcome(requestTrace, result, ownsRequestTrace)
	}()
	requestTrace.AddEvent("query.accepted", nil)

	trackQueryHistory := auditOptions.trackHistory
	auditStartedAt := time.Now()
	var queryExecutionDuration time.Duration
	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	trackSQLAudit := auditOptions.auditAll || (auditOptions.auditWrites && containsSQLAuditWrite(resolveDDLDBType(runConfig), query))
	if trackSQLAudit {
		defer func() {
			a.recordSQLAuditQuery(sqlAuditQueryInput{
				Config:     runConfig,
				Database:   dbName,
				DBType:     resolveDDLDBType(runConfig),
				QueryID:    queryID,
				SQL:        query,
				Source:     normalizeSQLAuditSource(auditOptions.source),
				CommitMode: "auto",
				Duration:   time.Since(auditStartedAt),
				Result:     result,
			})
		}()
	}
	if trackQueryHistory {
		defer func() {
			if !result.Success {
				return
			}
			durationMs := queryExecutionDuration.Milliseconds()
			a.recordQueryExecution(config, dbName, resolveDDLDBType(runConfig), query, durationMs, 0, queryResultRowsReturned(result))
		}()
	}

	if err := a.ensureDataSourceQueryCapability(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}
	if err := ensureConnectionAllowsQuery(config, query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}

	ctx, cancel := newQueryExecutionContextWithParent(auditOptions.executionContext, runConfig)
	if deadline, ok := ctx.Deadline(); ok {
		requestTrace.SetRequestMetadata("", "", deadline)
	}
	requestTrace.AddEvent("driver.dispatched", nil)
	cleanupRunningQuery, setRunningQueryCancellable := a.registerRunningQueryWithCancellationCapability(queryID, cancel, true)
	defer func() {
		cancel()
		cleanupRunningQuery()
	}()

	var dbInst db.Database
	var err error
	if auditOptions.synchronousConnectionWait {
		dbInst, err = a.getDatabaseSynchronouslyWithContext(ctx, runConfig, false)
	} else {
		dbInst, err = a.getDatabaseWithContext(ctx, runConfig, false)
	}
	if err != nil {
		logger.Error(err, "DBQuery 获取连接失败：%s", formatConnSummary(runConfig))
		return buildQueryConnectionFailure(err, queryID, auditOptions.classifyConnectionErrors)
	}

	isReadQuery := isReadOnlySQLQuery(runConfig.Type, query)
	tryQueryFirst := shouldTryQueryResultFirst(runConfig.Type, query)
	legacyCancellationUnsupported := false

	runReadQuery := func(inst db.Database) ([]map[string]interface{}, []string, error) {
		startedAt := time.Now()
		defer func() { queryExecutionDuration += time.Since(startedAt) }()
		if q, ok := inst.(db.QueryContexter); ok {
			setRunningQueryCancellable(true)
			return q.QueryContext(ctx, query)
		}
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		setRunningQueryCancellable(false)
		if err := ctx.Err(); err != nil {
			setRunningQueryCancellable(true)
			return nil, nil, err
		}
		data, columns, err := inst.Query(query)
		legacyCancellationUnsupported = ctx.Err() != nil
		return data, columns, err
	}

	runReadQueryWithMessages := func(inst db.Database) ([]map[string]interface{}, []string, []string, error) {
		if q, ok := inst.(db.QueryMessageExecer); ok {
			setRunningQueryCancellable(true)
			startedAt := time.Now()
			data, columns, messages, err := q.QueryContextWithMessages(ctx, query)
			queryExecutionDuration += time.Since(startedAt)
			return data, columns, messages, err
		}
		data, columns, err := runReadQuery(inst)
		return data, columns, nil, err
	}

	runExecQuery := func(inst db.Database) (int64, error) {
		startedAt := time.Now()
		defer func() { queryExecutionDuration += time.Since(startedAt) }()
		if e, ok := inst.(db.ExecContexter); ok {
			setRunningQueryCancellable(true)
			return e.ExecContext(ctx, query)
		}
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		setRunningQueryCancellable(false)
		if err := ctx.Err(); err != nil {
			setRunningQueryCancellable(true)
			return 0, err
		}
		affected, err := inst.Exec(query)
		legacyCancellationUnsupported = ctx.Err() != nil
		return affected, err
	}

	if isReadQuery || tryQueryFirst {
		data, columns, messages, err := runReadQueryWithMessages(dbInst)
		if legacyCancellationUnsupported {
			return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
				Data: data, Fields: columns, Messages: messages, QueryID: queryID,
			}, err)
		}
		if err != nil && isReadQuery && shouldRefreshCachedConnection(err) {
			if a.invalidateCachedDatabase(runConfig, err) {
				requestTrace.MarkRetry("cached connection refresh")
				setRunningQueryCancellable(true)
				var retryInst db.Database
				var retryErr error
				if auditOptions.synchronousConnectionWait {
					retryInst, retryErr = a.getDatabaseSynchronouslyWithContext(ctx, runConfig, true)
				} else {
					retryInst, retryErr = a.getDatabaseWithContext(ctx, runConfig, true)
				}
				if retryErr != nil {
					logger.Error(retryErr, "DBQuery 重建连接失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
					return buildQueryConnectionFailure(retryErr, queryID, auditOptions.classifyConnectionErrors)
				}
				data, columns, messages, err = runReadQueryWithMessages(retryInst)
				if legacyCancellationUnsupported {
					return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
						Data: data, Fields: columns, Messages: messages, QueryID: queryID,
					}, err)
				}
			}
		}
		if err == nil {
			return connection.QueryResult{Success: true, Data: data, Fields: columns, Messages: messages, QueryID: queryID}
		}
		if isReadQuery {
			logger.Error(err, "DBQuery 查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
		}
		if shouldRefreshCachedConnection(err) {
			a.invalidateCachedDatabase(runConfig, err)
		}
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQuery 写入查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, queryID)
	}

	affected, err := runExecQuery(dbInst)
	if legacyCancellationUnsupported {
		return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
			Data: map[string]int64{"affectedRows": affected}, QueryID: queryID,
		}, err)
	}
	if err != nil {
		if shouldRefreshCachedConnection(err) {
			a.invalidateCachedDatabase(runConfig, err)
		}
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQuery 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, queryID)
	}
	return connection.QueryResult{Success: true, Data: map[string]int64{"affectedRows": affected}, QueryID: queryID}
}

// DBQueryMulti 执行可能包含多条 SQL 语句的查询，返回多个结果集。
// 如果底层驱动支持 MultiResultQuerier，一次性执行所有语句；
// 否则按分号拆分后逐条执行，模拟多结果集。
func (a *App) DBQueryMulti(config connection.ConnectionConfig, dbName string, query string, queryID string) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	auditSource := "query_editor"
	if !explicitQuery {
		auditSource = "application_api"
	}
	return a.dbQueryMulti(config, dbName, query, queryID, dbQueryMultiAuditOptions{
		auditAll:    explicitQuery || a.webRuntime,
		auditWrites: true,
		source:      auditSource,
	})
}

func (a *App) dbQueryMulti(
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	auditOptions dbQueryMultiAuditOptions,
) (result connection.QueryResult) {
	runConfig := normalizeRunConfig(config, dbName)
	if queryID == "" {
		queryID = requestTraceIDFromContext(auditOptions.executionContext)
	}
	if queryID == "" {
		queryID = generateQueryID()
	}
	traceContext, requestTrace, ownsRequestTrace := a.beginQueryRequestTrace(
		auditOptions.executionContext,
		runConfig,
		queryID,
		auditOptions.source,
		"database.query_multi",
	)
	auditOptions.executionContext = traceContext
	defer func() {
		a.recordQueryRequestTraceOutcome(requestTrace, result, ownsRequestTrace)
	}()
	requestTrace.AddEvent("query.accepted", nil)

	resolvedDBType := resolveDDLDBType(runConfig)
	trackSQLAudit := auditOptions.auditAll || (auditOptions.auditWrites && containsSQLAuditWrite(resolvedDBType, query))
	auditSource := normalizeSQLAuditSource(auditOptions.source)
	auditStartedAt := time.Now()
	var statementAuditEvents []sqlaudit.Event
	if trackSQLAudit {
		defer func() {
			a.recordSQLAuditQuery(sqlAuditQueryInput{
				Config:     runConfig,
				Database:   dbName,
				DBType:     resolvedDBType,
				QueryID:    queryID,
				SQL:        query,
				Source:     auditSource,
				CommitMode: result.CommitMode,
				Duration:   time.Since(auditStartedAt),
				Result:     result,
			})
		}()
		defer func() {
			a.appendSQLAuditEvents(statementAuditEvents)
		}()
	}
	// 慢 SQL 埋点：成功执行后记录（低于阈值 500ms 自动跳过）。
	// 用 named return + defer 覆盖所有 return path，避免遗漏。
	var queryExecutionDuration time.Duration
	queryExecuted := false
	defer func() {
		if !result.Success {
			return
		}
		durationMs := queryExecutionDuration.Milliseconds()
		a.recordQueryExecution(config, dbName, resolvedDBType, query, durationMs, 0, queryResultRowsReturned(result))
	}()
	measureQueryExecution := func(run func()) {
		startedAt := time.Now()
		queryExecuted = true
		run()
		queryExecutionDuration += time.Since(startedAt)
	}

	buildStatementExecutionFailedMessage := func(index int, err error, previousSuccessCount int) string {
		message := a.appText("db.backend.error.multi_statement_execution_failed", map[string]any{
			"index":  index,
			"detail": err.Error(),
		})
		if previousSuccessCount > 0 {
			message += a.appText("db.backend.error.multi_statement_previous_success", map[string]any{
				"count": previousSuccessCount,
			})
		}
		return message
	}
	buildSequentialFallbackMessage := func(statementCount int) string {
		return a.appText("db.backend.message.multi_statement_sequential_fallback", map[string]any{
			"dbType": runConfig.Type,
			"count":  statementCount,
		})
	}

	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	if err := a.ensureDataSourceQueryCapability(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}
	if err := ensureConnectionAllowsQuery(config, query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}

	ctx, cancel := newQueryExecutionContextWithParent(auditOptions.executionContext, runConfig)
	if deadline, ok := ctx.Deadline(); ok {
		requestTrace.SetRequestMetadata("", "", deadline)
	}
	requestTrace.AddEvent("driver.dispatched", nil)
	cleanupRunningQuery, setRunningQueryCancellable := a.registerRunningQueryWithCancellationCapability(queryID, cancel, true)
	defer func() {
		cancel()
		cleanupRunningQuery()
	}()

	var dbInst db.Database
	var err error
	if auditOptions.synchronousConnectionWait {
		dbInst, err = a.getDatabaseSynchronouslyWithContext(ctx, runConfig, false)
	} else {
		dbInst, err = a.getDatabaseWithContext(ctx, runConfig, false)
	}
	if err != nil {
		logger.Error(err, "DBQueryMulti 获取连接失败：%s", formatConnSummary(runConfig))
		return buildQueryConnectionFailure(err, queryID, auditOptions.classifyConnectionErrors)
	}
	defer func() {
		// A successful SQL round trip is at least as strong a health signal as Ping.
		if result.Success && queryExecuted {
			a.markCachedDatabaseHealthy(dbInst, time.Now())
		}
	}()
	legacyCancellationUnsupported := false

	// 尝试使用驱动原生多结果集支持。
	// 注意：原生 conn.Query() 执行写操作（UPDATE/INSERT/DELETE）时，
	// sql.Rows 不暴露 RowsAffected，导致影响行数丢失。
	// 因此仅在全部语句皆为读操作时才使用原生路径。
	statements := splitSQLStatementsForDialect(resolvedDBType, query)
	statementCount := 0
	for _, statement := range statements {
		if strings.TrimSpace(statement) != "" {
			statementCount++
		}
	}
	auditSequentialStatements := trackSQLAudit && statementCount > 1
	appendStatementAudit := func(
		statement string,
		statementIndex int,
		startedAt time.Time,
		rowsAffected int64,
		rowsReturned int64,
		boundaryMode string,
		commitMode string,
		statementErr error,
	) {
		if !auditSequentialStatements {
			return
		}
		completedAt := time.Now()
		event := buildSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:         runConfig,
			Database:       dbName,
			DBType:         resolvedDBType,
			QueryID:        queryID,
			EventType:      "query_statement",
			Status:         sqlAuditStatusFromError(statementErr),
			Source:         auditSource,
			CommitMode:     commitMode,
			BoundaryMode:   boundaryMode,
			SQL:            statement,
			StatementIndex: statementIndex,
			StatementCount: statementCount,
			ExecutedCount:  executedStatementCount(statementErr),
			FailedIndex:    failedStatementIndex(statementIndex, statementErr),
			OutcomeUnknown: writeExecutionOutcomeUnknown(ctx, statementErr),
			Duration:       completedAt.Sub(startedAt),
			RowsAffected:   rowsAffected,
			RowsReturned:   rowsReturned,
			Err:            statementErr,
		})
		event.Timestamp = completedAt.UnixMilli()
		statementAuditEvents = append(statementAuditEvents, event)
	}
	allReadOnly := true
	for _, stmt := range statements {
		if strings.TrimSpace(stmt) != "" && !isReadOnlySQLQuery(runConfig.Type, stmt) {
			allReadOnly = false
			break
		}
	}
	useNativeMultiResult := shouldUseNativeMultiResultBatch(resolvedDBType, statements, allReadOnly)

	runMultiQuery := func(inst db.Database) ([]connection.ResultSetData, []string, error) {
		if !useNativeMultiResult {
			return nil, nil, nil // 包含写操作，走逐条执行路径
		}
		var (
			results  []connection.ResultSetData
			messages []string
			err      error
		)
		if q, ok := inst.(db.MultiResultQueryMessageExecer); ok {
			setRunningQueryCancellable(true)
			measureQueryExecution(func() {
				results, messages, err = q.QueryMultiContextWithMessages(ctx, query)
			})
			return results, messages, err
		}
		if q, ok := inst.(db.MultiResultQuerierContext); ok {
			setRunningQueryCancellable(true)
			measureQueryExecution(func() {
				results, err = q.QueryMultiContext(ctx, query)
			})
			return results, nil, err
		}
		if q, ok := inst.(db.MultiResultQuerier); ok {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			setRunningQueryCancellable(false)
			if err := ctx.Err(); err != nil {
				setRunningQueryCancellable(true)
				return nil, nil, err
			}
			measureQueryExecution(func() {
				results, err = q.QueryMulti(query)
			})
			legacyCancellationUnsupported = ctx.Err() != nil
			return results, nil, err
		}
		return nil, nil, nil // 返回 nil 表示不支持
	}

	results, resultMessages, err := runMultiQuery(dbInst)
	if legacyCancellationUnsupported {
		return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
			Data: results, Messages: resultMessages, QueryID: queryID,
		}, err)
	}
	// A native multi-result call may have already returned one or more result
	// sets before the driver reports an error. Retrying that batch could replay
	// query-first writes, so only refresh a cached connection before any result
	// has been observed.
	if err != nil && allReadOnly && len(results) == 0 && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			requestTrace.MarkRetry("cached connection refresh")
			setRunningQueryCancellable(true)
			var retryInst db.Database
			var retryErr error
			if auditOptions.synchronousConnectionWait {
				retryInst, retryErr = a.getDatabaseSynchronouslyWithContext(ctx, runConfig, true)
			} else {
				retryInst, retryErr = a.getDatabaseWithContext(ctx, runConfig, true)
			}
			if retryErr != nil {
				logger.Error(retryErr, "DBQueryMulti 重建连接失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
				return buildQueryConnectionFailure(retryErr, queryID, auditOptions.classifyConnectionErrors)
			}
			dbInst = retryInst
			results, resultMessages, err = runMultiQuery(retryInst)
			if legacyCancellationUnsupported {
				return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
					Data: results, Messages: resultMessages, QueryID: queryID,
				}, err)
			}
		}
	}
	if err != nil {
		logger.Error(err, "DBQueryMulti 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		normalizeNativeResultStatementIndexes(runConfig.Type, statements, results)
		executedCount, exactPrefix := nativeResultExecutedStatementCount(statements, results)
		// A query-first write can have reached the server even when a native
		// result-stream error leaves no result set for the failing statement.
		outcomeUnknown := containsSQLAuditWrite(resolvedDBType, query)
		if exactPrefix {
			for index := 1; index <= executedCount; index++ {
				var rowsAffected, rowsReturned int64
				for _, resultSet := range results {
					if resultSet.StatementIndex != index {
						continue
					}
					affected, returned := summarizeManagedSQLResultSet(resultSet)
					rowsAffected += affected
					rowsReturned += returned
				}
				appendStatementAudit(statements[index-1], index, auditStartedAt, rowsAffected, rowsReturned, sqlaudit.BoundaryModeDriverAPI, sqlaudit.CommitModeAuto, nil)
			}
		}
		failedIndex := 0
		if exactPrefix && executedCount < statementCount {
			failedIndex = executedCount + 1
			appendStatementAudit(statements[failedIndex-1], failedIndex, auditStartedAt, 0, 0, sqlaudit.BoundaryModeDriverAPI, sqlaudit.CommitModeAuto, err)
			if outcomeUnknown && len(statementAuditEvents) > 0 {
				statementAuditEvents[len(statementAuditEvents)-1].OutcomeUnknown = true
			}
		}
		failure := buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
		failure.Data = results
		failure.Messages = resultMessages
		failure.Partial = len(results) > 0
		// For query-first writes, a scanner/transport error after native results
		// cannot prove the outcome of the failing statement. Preserve the known
		// prefix and surface the remaining uncertainty to callers and the audit.
		return summarizeMultiStatementResult(failure, executedCount, failedIndex, sqlaudit.BoundaryModeDriverAPI, outcomeUnknown)
	}

	// 某些 optional driver-agent 的原生多结果集路径会异常返回“成功但无可展示列/行”。
	// 对只读查询这是不可信信号，回退到逐条执行可以避免普通 SELECT 在结果面板中被吃空。
	if useNativeMultiResult && nativeReadOnlyResultsMissingTabularPayload(allReadOnly, results) {
		logger.Warnf("DBQueryMulti 原生多结果集返回空结果，将回退逐条执行：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		results = nil
	}
	if useNativeMultiResult && results != nil {
		normalizeNativeResultStatementIndexes(runConfig.Type, statements, results)
	}

	// 驱动支持多结果集，直接返回
	if results != nil {
		for index, statement := range statements {
			if strings.TrimSpace(statement) != "" {
				appendStatementAudit(statement, index+1, auditStartedAt, 0, 0, sqlaudit.BoundaryModeDriverAPI, sqlaudit.CommitModeAuto, nil)
			}
		}
		return summarizeMultiStatementResult(connection.QueryResult{Success: true, Data: results, Messages: resultMessages, QueryID: queryID}, statementCount, 0, sqlaudit.BoundaryModeDriverAPI, false)
	}

	// 驱动不支持多结果集，回退到逐条执行
	if len(statements) == 0 {
		return connection.QueryResult{
			Success: true,
			Data:    []connection.ResultSetData{},
			QueryID: queryID,
		}
	}

	var sessionQueryTarget db.StatementQueryExecer
	var sessionQueryMessageTarget db.StatementQueryMessageExecer
	var sessionMultiQueryTarget db.StatementMultiResultQueryExecer
	var sessionMultiQueryMessageTarget db.StatementMultiResultQueryMessageExecer
	var sessionExecTarget db.StatementExecer
	var sessionBatchTarget db.BatchWriteExecer
	closeExecTarget := func() {}
	if provider, ok := dbInst.(db.SessionExecerProvider); ok {
		setRunningQueryCancellable(true)
		sessionExecer, sessionErr := provider.OpenSessionExecer(ctx)
		if sessionErr != nil {
			logger.Warnf("DBQueryMulti 打开会话级执行器失败，将回退共享连接：%s SQL片段=%q err=%v", formatConnSummary(runConfig), sqlSnippet(query), sessionErr)
		} else {
			if statementQueryExecer, ok := sessionExecer.(db.StatementQueryExecer); ok {
				sessionQueryTarget = statementQueryExecer
			}
			if statementQueryMessageExecer, ok := sessionExecer.(db.StatementQueryMessageExecer); ok {
				sessionQueryMessageTarget = statementQueryMessageExecer
			}
			if statementMultiResultQueryExecer, ok := sessionExecer.(db.StatementMultiResultQueryExecer); ok {
				sessionMultiQueryTarget = statementMultiResultQueryExecer
			}
			if statementMultiResultQueryMessageExecer, ok := sessionExecer.(db.StatementMultiResultQueryMessageExecer); ok {
				sessionMultiQueryMessageTarget = statementMultiResultQueryMessageExecer
			}
			sessionExecTarget = sessionExecer
			if batcher, ok := sessionExecer.(db.BatchWriteExecer); ok {
				sessionBatchTarget = batcher
			}
			closeExecTarget = func() {
				if err := sessionExecer.Close(); err != nil {
					logger.Warnf("DBQueryMulti 关闭会话级执行器失败：%v", err)
				}
			}
		}
	}
	defer closeExecTarget()

	// 单条写语句且驱动支持批量 Exec 时，可复用批量路径。
	// 多条写语句必须逐条返回结果；部分驱动对多语句 Exec 仅暴露最后一条 RowsAffected，
	// 会导致前面语句已成功执行但结果页只剩一个写入结果。
	if !allReadOnly {
		allWrite := true
		containsPLSQLBlock := false
		containsQueryFirstWrite := false
		for _, stmt := range statements {
			stmt = strings.TrimSpace(stmt)
			if stmt == "" {
				continue
			}
			if !isBatchableWriteSQLStatement(runConfig.Type, stmt) {
				allWrite = false
			}
			if shouldTryQueryResultFirst(runConfig.Type, stmt) {
				containsQueryFirstWrite = true
			}
			if isPLSQLBlockStatementForDialect(resolvedDBType, stmt) {
				containsPLSQLBlock = true
			}
		}
		if allWrite && !containsPLSQLBlock && !containsQueryFirstWrite && len(statements) == 1 {
			batcher := sessionBatchTarget
			if batcher == nil {
				if fallbackBatcher, ok := dbInst.(db.BatchWriteExecer); ok {
					batcher = fallbackBatcher
				}
			}
			if batcher != nil {
				var (
					affected int64
					batchErr error
				)
				measureQueryExecution(func() {
					setRunningQueryCancellable(true)
					affected, batchErr = batcher.ExecBatchContext(ctx, query)
				})
				if batchErr != nil {
					if shouldRefreshCachedConnection(batchErr) {
						a.invalidateCachedDatabase(runConfig, batchErr)
					}
					batchErr = classifyDispatchedWriteError(batchErr)
					logger.Error(batchErr, "DBQueryMulti 批量写执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
					return summarizeMultiStatementResult(buildWriteExecutionFailure(ctx, batchErr, queryID), 0, 1, sqlaudit.BoundaryModeImplicit, writeExecutionOutcomeUnknown(ctx, batchErr))
				}
				logger.Infof("DBQueryMulti 批量写执行成功：%s 语句数=%d affectedRows=%d", formatConnSummary(runConfig), len(statements), affected)
				return summarizeMultiStatementResult(connection.QueryResult{
					Success: true,
					Data: []connection.ResultSetData{{
						Rows:    []map[string]interface{}{{"affectedRows": affected}},
						Columns: []string{"affectedRows"},
					}},
					QueryID: queryID,
				}, 1, 0, sqlaudit.BoundaryModeImplicit, false)
			}
		}
	}

	var resultSets []connection.ResultSetData
	executedCount := 0
	textTransactionOpen := false
	summaryBoundaryMode := sqlaudit.BoundaryModeImplicit
	summaryCommitMode := sqlaudit.CommitModeAuto
	for idx, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		statementStartedAt := time.Now()
		statementBoundaryMode, statementCommitMode := sqlAuditTextTransactionMetadata(stmt, textTransactionOpen)
		summaryBoundaryMode = statementBoundaryMode
		summaryCommitMode = statementCommitMode

		isReadStmt := isReadOnlySQLQuery(runConfig.Type, stmt)
		tryQueryStmtFirst := shouldTryQueryResultFirst(runConfig.Type, stmt)
		if isReadStmt || tryQueryStmtFirst {
			preferPlainReadQuery := isReadStmt && shouldPreferPlainReadQueryResult(resolvedDBType)
			var (
				data             []map[string]interface{}
				columns          []string
				messages         []string
				statementResults []connection.ResultSetData
				usedMultiResult  bool
			)
			runStatementQuery := func() error {
				measureQueryExecution(func() {
					if sessionQueryMessageTarget != nil {
						setRunningQueryCancellable(true)
						data, columns, messages, err = sessionQueryMessageTarget.QueryContextWithMessages(ctx, stmt)
					} else if sessionQueryTarget != nil {
						setRunningQueryCancellable(true)
						data, columns, err = sessionQueryTarget.QueryContext(ctx, stmt)
					} else if q, ok := dbInst.(db.QueryMessageExecer); ok {
						setRunningQueryCancellable(true)
						data, columns, messages, err = q.QueryContextWithMessages(ctx, stmt)
					} else if q, ok := dbInst.(db.QueryContexter); ok {
						setRunningQueryCancellable(true)
						data, columns, err = q.QueryContext(ctx, stmt)
					} else {
						if ctxErr := ctx.Err(); ctxErr != nil {
							err = ctxErr
							return
						}
						setRunningQueryCancellable(false)
						if ctxErr := ctx.Err(); ctxErr != nil {
							setRunningQueryCancellable(true)
							err = ctxErr
							return
						}
						data, columns, err = dbInst.Query(stmt)
						legacyCancellationUnsupported = ctx.Err() != nil
					}
				})
				return err
			}
			if preferPlainReadQuery {
				err = runStatementQuery()
			} else if sessionMultiQueryMessageTarget != nil {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, messages, err = sessionMultiQueryMessageTarget.QueryMultiContextWithMessages(ctx, stmt)
				})
				usedMultiResult = true
			} else if sessionMultiQueryTarget != nil {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, err = sessionMultiQueryTarget.QueryMultiContext(ctx, stmt)
				})
				usedMultiResult = true
			} else if q, ok := dbInst.(db.MultiResultQueryMessageExecer); ok {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, messages, err = q.QueryMultiContextWithMessages(ctx, stmt)
				})
				usedMultiResult = true
			} else if q, ok := dbInst.(db.MultiResultQuerierContext); ok {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, err = q.QueryMultiContext(ctx, stmt)
				})
				usedMultiResult = true
			} else if q, ok := dbInst.(db.MultiResultQuerier); ok {
				if ctxErr := ctx.Err(); ctxErr != nil {
					err = ctxErr
				} else {
					setRunningQueryCancellable(false)
					if ctxErr := ctx.Err(); ctxErr != nil {
						setRunningQueryCancellable(true)
						err = ctxErr
					} else {
						measureQueryExecution(func() {
							statementResults, err = q.QueryMulti(stmt)
						})
						legacyCancellationUnsupported = ctx.Err() != nil
					}
				}
				usedMultiResult = true
			} else {
				err = runStatementQuery()
			}
			if legacyCancellationUnsupported {
				cancellationResults := append([]connection.ResultSetData(nil), resultSets...)
				if err == nil {
					if usedMultiResult {
						for resultIndex := range statementResults {
							statementResults[resultIndex].StatementIndex = idx + 1
						}
						cancellationResults = append(cancellationResults, statementResults...)
					} else {
						cancellationResults = append(cancellationResults, connection.ResultSetData{
							Rows: data, Columns: columns, Messages: messages, StatementIndex: idx + 1,
						})
					}
				}
				return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
					Data: cancellationResults, QueryID: queryID,
				}, err)
			}
			if err == nil && usedMultiResult && shouldFallbackToPlainQueryAfterMultiResult(isReadStmt, statementResults, messages) {
				logger.Warnf("DBQueryMulti 逐条多结果集返回空结果，将回退普通查询（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
				usedMultiResult = false
				statementResults = nil
				data = nil
				columns = nil
				messages = nil
				err = runStatementQuery()
			}
			if err == nil {
				if usedMultiResult {
					var rowsAffected, rowsReturned int64
					if len(statementResults) == 0 && len(messages) > 0 {
						statementResults = []connection.ResultSetData{{
							Rows:     []map[string]interface{}{},
							Columns:  []string{},
							Messages: append([]string(nil), messages...),
						}}
					}
					for _, statementResult := range statementResults {
						if statementResult.Rows == nil {
							statementResult.Rows = []map[string]interface{}{}
						}
						if statementResult.Columns == nil {
							statementResult.Columns = []string{}
						}
						statementResult.StatementIndex = idx + 1
						affected, returned := summarizeManagedSQLResultSet(statementResult)
						rowsAffected += affected
						rowsReturned += returned
						resultSets = append(resultSets, statementResult)
					}
					appendStatementAudit(stmt, idx+1, statementStartedAt, rowsAffected, rowsReturned, statementBoundaryMode, statementCommitMode, nil)
					executedCount++
					textTransactionOpen = advancesSQLAuditTextTransaction(stmt, textTransactionOpen)
					continue
				}
				if data == nil {
					data = make([]map[string]interface{}, 0)
				}
				if columns == nil {
					columns = []string{}
				}
				resultSets = append(resultSets, connection.ResultSetData{
					Rows:           data,
					Columns:        columns,
					Messages:       messages,
					StatementIndex: idx + 1,
				})
				appendStatementAudit(stmt, idx+1, statementStartedAt, 0, int64(len(data)), statementBoundaryMode, statementCommitMode, nil)
				executedCount++
				textTransactionOpen = advancesSQLAuditTextTransaction(stmt, textTransactionOpen)
				continue
			}
			if isReadStmt {
				logger.Error(err, "DBQueryMulti 逐条查询失败（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
				errMsg := buildStatementExecutionFailedMessage(idx+1, err, len(resultSets))
				appendStatementAudit(stmt, idx+1, statementStartedAt, 0, 0, statementBoundaryMode, statementCommitMode, err)
				return summarizeMultiStatementResultWithCommitMode(buildQueryExecutionFailure(ctx, err, errMsg, queryID), executedCount, idx+1, statementBoundaryMode, statementCommitMode, false)
			}
			if shouldRefreshCachedConnection(err) {
				a.invalidateCachedDatabase(runConfig, err)
			}
			err = classifyDispatchedWriteError(err)
			logger.Error(err, "DBQueryMulti 写入查询失败（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
			errMsg := buildStatementExecutionFailedMessage(idx+1, err, len(resultSets))
			appendStatementAudit(stmt, idx+1, statementStartedAt, 0, 0, statementBoundaryMode, statementCommitMode, err)
			failure := buildWriteExecutionFailure(ctx, err, queryID)
			failure.Message = errMsg
			return summarizeMultiStatementResultWithCommitMode(failure, executedCount, idx+1, statementBoundaryMode, statementCommitMode, writeExecutionOutcomeUnknown(ctx, err))
		}

		var affected int64
		measureQueryExecution(func() {
			if sessionExecTarget != nil {
				setRunningQueryCancellable(true)
				affected, err = sessionExecTarget.ExecContext(ctx, stmt)
			} else if e, ok := dbInst.(db.ExecContexter); ok {
				setRunningQueryCancellable(true)
				affected, err = e.ExecContext(ctx, stmt)
			} else {
				if ctxErr := ctx.Err(); ctxErr != nil {
					err = ctxErr
					return
				}
				setRunningQueryCancellable(false)
				if ctxErr := ctx.Err(); ctxErr != nil {
					setRunningQueryCancellable(true)
					err = ctxErr
					return
				}
				affected, err = dbInst.Exec(stmt)
				legacyCancellationUnsupported = ctx.Err() != nil
			}
		})
		if legacyCancellationUnsupported {
			cancellationResults := append([]connection.ResultSetData(nil), resultSets...)
			if err == nil {
				cancellationResults = append(cancellationResults, connection.ResultSetData{
					Rows: []map[string]interface{}{{"affectedRows": affected}}, Columns: []string{"affectedRows"}, StatementIndex: idx + 1,
				})
			}
			return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
				Data: cancellationResults, QueryID: queryID,
			}, err)
		}
		if err != nil {
			if shouldRefreshCachedConnection(err) {
				a.invalidateCachedDatabase(runConfig, err)
			}
			err = classifyDispatchedWriteError(err)
			logger.Error(err, "DBQueryMulti 逐条执行失败（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
			errMsg := buildStatementExecutionFailedMessage(idx+1, err, len(resultSets))
			appendStatementAudit(stmt, idx+1, statementStartedAt, 0, 0, statementBoundaryMode, statementCommitMode, err)
			if writeExecutionOutcomeUnknown(ctx, err) {
				return summarizeMultiStatementResultWithCommitMode(connection.QueryResult{Success: false, Message: errMsg, Data: map[string]any{"outcomeUnknown": true}, QueryID: queryID}, executedCount, idx+1, statementBoundaryMode, statementCommitMode, true)
			}
			return summarizeMultiStatementResultWithCommitMode(connection.QueryResult{Success: false, Message: errMsg, QueryID: queryID}, executedCount, idx+1, statementBoundaryMode, statementCommitMode, false)
		}
		resultSets = append(resultSets, connection.ResultSetData{
			Rows:           []map[string]interface{}{{"affectedRows": affected}},
			Columns:        []string{"affectedRows"},
			StatementIndex: idx + 1,
		})
		appendStatementAudit(stmt, idx+1, statementStartedAt, affected, 0, statementBoundaryMode, statementCommitMode, nil)
		executedCount++
		textTransactionOpen = advancesSQLAuditTextTransaction(stmt, textTransactionOpen)
	}

	if resultSets == nil {
		resultSets = []connection.ResultSetData{}
	}
	// 回退到逐条执行且有多条语句时，附加提示信息
	var fallbackMsg string
	if len(statements) > 1 {
		fallbackMsg = buildSequentialFallbackMessage(len(statements))
	}
	return summarizeMultiStatementResultWithCommitMode(connection.QueryResult{Success: true, Data: resultSets, QueryID: queryID, Message: fallbackMsg}, executedCount, 0, summaryBoundaryMode, summaryCommitMode, false)
}

func normalizeNativeResultStatementIndexes(dbType string, statements []string, results []connection.ResultSetData) {
	if !isSQLServerDBType(dbType) || len(results) == 0 {
		return
	}
	hasExplicitStatementIndex := false
	for _, result := range results {
		if result.StatementIndex > 0 {
			hasExplicitStatementIndex = true
			break
		}
	}
	if hasExplicitStatementIndex {
		return
	}

	switch {
	case len(statements) <= 1:
		for idx := range results {
			results[idx].StatementIndex = 1
		}
	case len(results) == len(statements):
		for idx := range results {
			results[idx].StatementIndex = idx + 1
		}
	case len(results) == len(statements)*2:
		// go-mssqldb 会在每个 SELECT 数据结果后再发送一条 MsgRowsAffected。
		// 仅在整个批次严格呈现 [数据结果, affectedRows] 成对结构时补索引，
		// 避免把存储过程返回的多个真实结果集错误归并到不同语句。
		for statementIdx := range statements {
			resultIdx := statementIdx * 2
			if isAffectedRowsResultSet(results[resultIdx]) || !isAffectedRowsResultSet(results[resultIdx+1]) {
				return
			}
		}
		for statementIdx := range statements {
			resultIdx := statementIdx * 2
			results[resultIdx].StatementIndex = statementIdx + 1
			results[resultIdx+1].StatementIndex = statementIdx + 1
		}
	}
}

// nativeResultExecutedStatementCount reports a completed leading statement
// prefix only when result-set indexes prove that mapping. A stored procedure
// can emit multiple result sets, so result-set count alone is not evidence of
// how many statements completed.
func nativeResultExecutedStatementCount(statements []string, results []connection.ResultSetData) (int, bool) {
	if len(results) == 0 {
		return 0, true
	}
	completed := make(map[int]struct{}, len(results))
	for _, result := range results {
		if result.StatementIndex < 1 || result.StatementIndex > len(statements) {
			return 0, false
		}
		completed[result.StatementIndex] = struct{}{}
	}
	for index := 1; index <= len(statements); index++ {
		if _, ok := completed[index]; !ok {
			for later := index + 1; later <= len(statements); later++ {
				if _, found := completed[later]; found {
					return 0, false
				}
			}
			return index - 1, true
		}
	}
	return len(statements), true
}

func nativeReadOnlyResultsMissingTabularPayload(allReadOnly bool, results []connection.ResultSetData) bool {
	if !allReadOnly || results == nil {
		return false
	}
	if len(results) == 0 {
		return true
	}
	for _, result := range results {
		if isAffectedRowsResultSet(result) {
			continue
		}
		if len(result.Columns) > 0 || len(result.Rows) > 0 {
			return false
		}
	}
	return true
}

func shouldFallbackToPlainQueryAfterMultiResult(readOnly bool, results []connection.ResultSetData, messages []string) bool {
	if !readOnly {
		return false
	}
	// Optional driver agents use nil results with no messages to signal that the
	// native multi-result method is unsupported. Retrying is only safe for reads;
	// query-first writes and stored procedures may already have side effects.
	if results == nil && len(messages) == 0 {
		return true
	}
	return nativeReadOnlyResultsMissingTabularPayload(true, results)
}

func shouldUseNativeMultiResultBatch(dbType string, statements []string, allReadOnly bool) bool {
	if allReadOnly {
		return !shouldPreferPlainReadQueryResult(dbType)
	}
	if !strings.EqualFold(strings.TrimSpace(dbType), "sqlserver") {
		return false
	}
	for _, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if isReadOnlySQLQuery(dbType, stmt) || shouldTryQueryResultFirst(dbType, stmt) {
			continue
		}
		return false
	}
	return true
}

func shouldPreferPlainReadQueryResult(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "sqlite",
		"postgres", "postgresql",
		"oracle",
		"kingbase", "kingbase8", "kingbasees", "kingbasev8",
		"highgo", "vastbase",
		"opengauss", "open_gauss", "open-gauss",
		"gaussdb", "gauss_db", "gauss-db",
		"dameng", "dm", "dm8":
		return true
	case "tdengine":
		// TDengine only implements the plain query API. The optional driver-agent
		// exposes a transport-level multi-result method, but reports it unsupported.
		// Skipping that probe prevents a successful SELECT from becoming an empty result.
		return true
	default:
		return false
	}
}

func shouldTryQueryResultFirst(dbType string, query string) bool {
	isSQLServer := isSQLServerDBType(dbType)
	if sqlWriteStatementReturnsRows(dbType, query) {
		return true
	}
	keyword := leadingSQLKeyword(query)
	if normalizeSQLClassifierDBType(dbType) == "mqtt" && keyword == "unsubscribe" {
		// MQTT models UNSUBSCRIBE as a query command because it returns the
		// released topic filter. Route it through QueryContext instead of the
		// JSON-only publish Exec path.
		return true
	}
	switch keyword {
	case "explain", "pragma":
		return true
	case "exec", "execute", "call":
		return true
	case "set", "print":
		return isSQLServer
	case "dbcc":
		return isSQLServer
	case "do":
		return isPostgresNoticeCapableDBType(dbType) && strings.Contains(strings.ToLower(query), "raise")
	default:
		if isSQLServer {
			if strings.HasPrefix(keyword, "sp_") || strings.HasPrefix(keyword, "xp_") {
				return true
			}
			if sqlServerControlFlowMayReturnMessages(query) {
				return true
			}
			return looksLikeSQLServerProcedureInvocation(query)
		}
		return false
	}
}

func looksLikeSQLServerProcedureInvocation(query string) bool {
	switch leadingSQLKeyword(query) {
	case "select", "with", "insert", "update", "delete", "merge", "replace", "upsert",
		"if", "begin", "declare", "while", "create", "alter", "drop", "truncate", "grant", "revoke",
		"use", "set", "print", "dbcc", "commit", "rollback", "save", "return", "throw", "raiserror",
		"waitfor", "open", "fetch", "close", "deallocate":
		return false
	}

	pos := skipSQLTrivia(query, 0)
	if pos >= len(query) {
		return false
	}

	next, ok := skipSQLIdentifierToken(query, pos, "sqlserver")
	if !ok || next <= pos {
		return false
	}
	pos = skipSQLTrivia(query, next)
	for pos < len(query) && query[pos] == '.' {
		pos = skipSQLTrivia(query, pos+1)
		next, ok = skipSQLIdentifierToken(query, pos, "sqlserver")
		if !ok || next <= pos {
			return false
		}
		pos = skipSQLTrivia(query, next)
	}

	if pos >= len(query) {
		return true
	}
	switch ch := query[pos]; {
	case ch == ';' || ch == ',' || ch == '@' || ch == '\'' || ch == '"' || ch == '[' || ch == '(':
		return true
	case ch == '+' || ch == '-':
		return true
	case ch >= '0' && ch <= '9':
		return true
	default:
		keyword, _ := nextSQLKeyword(query, pos)
		return keyword != ""
	}
}

func (a *App) DBQueryIsolated(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	return a.dbQueryIsolatedContext(context.Background(), config, dbName, query)
}

func (a *App) dbQueryIsolatedContext(parent context.Context, config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	if parent == nil {
		parent = context.Background()
	}
	if err := parent.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), Data: map[string]any{"cancelled": true}}
	}
	runConfig := normalizeRunConfig(config, dbName)

	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	if err := a.ensureDataSourceQueryCapability(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := ensureConnectionAllowsQuery(config, query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbInst, err := a.openDatabaseIsolated(runConfig)
	if err != nil {
		logger.Error(err, "DBQueryIsolated 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() {
		if closeErr := dbInst.Close(); closeErr != nil {
			logger.Error(closeErr, "DBQueryIsolated 关闭临时连接失败：%s", formatConnSummary(runConfig))
		}
	}()
	if err := parent.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), Data: map[string]any{"cancelled": true}}
	}

	ctx, cancel := newQueryExecutionContextWithParent(parent, runConfig)
	defer cancel()

	isReadQuery := isReadOnlySQLQuery(runConfig.Type, query)
	tryQueryFirst := shouldTryQueryResultFirst(runConfig.Type, query)

	if isReadQuery || tryQueryFirst {
		var (
			data     []map[string]interface{}
			columns  []string
			messages []string
		)
		if q, ok := dbInst.(db.QueryMessageExecer); ok {
			data, columns, messages, err = q.QueryContextWithMessages(ctx, query)
		} else if q, ok := dbInst.(interface {
			QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
		}); ok {
			data, columns, err = q.QueryContext(ctx, query)
		} else {
			if contextErr := ctx.Err(); contextErr != nil {
				return buildQueryExecutionFailure(ctx, contextErr, contextErr.Error(), "")
			}
			data, columns, err = dbInst.Query(query)
			if ctx.Err() != nil {
				return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
					Data: data, Fields: columns, Messages: messages,
				}, err)
			}
		}
		if err == nil {
			return connection.QueryResult{Success: true, Data: data, Fields: columns, Messages: messages}
		}
		if isReadQuery {
			logger.Error(err, "DBQueryIsolated 查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQueryIsolated 写入查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, "")
	}

	var affected int64
	if e, ok := dbInst.(interface {
		ExecContext(context.Context, string) (int64, error)
	}); ok {
		affected, err = e.ExecContext(ctx, query)
	} else {
		if contextErr := ctx.Err(); contextErr != nil {
			return buildQueryExecutionFailure(ctx, contextErr, contextErr.Error(), "")
		}
		affected, err = dbInst.Exec(query)
		if ctx.Err() != nil {
			return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
				Data: map[string]int64{"affectedRows": affected},
			}, err)
		}
	}
	if err != nil {
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQueryIsolated 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, "")
	}
	return connection.QueryResult{Success: true, Data: map[string]int64{"affectedRows": affected}}
}

func sqlSnippet(query string) string {
	q := strings.TrimSpace(sqlaudit.RedactSQL(query))
	const max = 200
	if len([]rune(q)) <= max {
		return q
	}
	return string([]rune(q)[:max]) + "..."
}

func ensureNonNilSlice[T any](items []T) []T {
	if items == nil {
		return make([]T, 0)
	}
	return items
}

func resolveConfiguredMongoDatabase(config connection.ConnectionConfig) string {
	if !strings.EqualFold(strings.TrimSpace(config.Type), "mongodb") {
		return ""
	}
	if database := strings.TrimSpace(config.Database); database != "" {
		return database
	}

	rawURI := strings.TrimSpace(config.URI)
	lowerURI := strings.ToLower(rawURI)
	if !strings.HasPrefix(lowerURI, "mongodb://") && !strings.HasPrefix(lowerURI, "mongodb+srv://") {
		return ""
	}
	parsed, err := url.Parse(rawURI)
	if err != nil {
		return ""
	}
	database := strings.Trim(strings.TrimSpace(parsed.Path), "/")
	if database == "" || strings.Contains(database, "/") {
		return ""
	}
	return database
}

func (a *App) DBGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	runConfig := normalizeRunConfig(config, "")
	configuredMongoDatabase := resolveConfiguredMongoDatabase(runConfig)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		runConfig.Type = "redis"
		client, err := a.getRedisClient(runConfig)
		if err != nil {
			logger.Error(err, "DBGetDatabases 获取 Redis 连接失败：%s", formatConnSummary(runConfig))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		dbs, err := client.GetDatabases()
		if err != nil {
			logger.Error(err, "DBGetDatabases 获取 Redis 库列表失败：%s", formatConnSummary(runConfig))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		resData := make([]map[string]string, 0, len(dbs))
		for _, item := range dbs {
			resData = append(resData, map[string]string{"Database": strconv.Itoa(item.Index)})
		}
		return connection.QueryResult{Success: true, Data: resData}
	}
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetDatabases 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if configuredMongoDatabase != "" {
		return connection.QueryResult{
			Success: true,
			Data:    []map[string]string{{"Database": configuredMongoDatabase}},
		}
	}

	dbs, err := dbInst.GetDatabases()
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetDatabases 重建连接失败：%s", formatConnSummary(runConfig))
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			dbs, err = retryInst.GetDatabases()
		}
	}
	if err != nil {
		var partialErr *db.PartialMetadataError
		if errors.As(err, &partialErr) {
			warning := partialErr.Error()
			logger.Warnf("DBGetDatabases 获取到部分数据库列表：%s err=%s", formatConnSummary(runConfig), warning)
			resData := make([]map[string]string, 0, len(dbs))
			for _, name := range dbs {
				resData = append(resData, map[string]string{"Database": name})
			}
			return connection.QueryResult{
				Success:           len(resData) > 0,
				Data:              resData,
				Message:           warning,
				Partial:           true,
				Warnings:          partialErr.Warnings(),
				FailedObjectTypes: []string{"database"},
				Retryable:         true,
			}
		}
		logger.Error(err, "DBGetDatabases 获取数据库列表失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbs = dedupeMetadataDatabaseNames(dbs)
	resData := make([]map[string]string, 0, len(dbs))
	for _, name := range dbs {
		resData = append(resData, map[string]string{"Database": name})
	}

	return connection.QueryResult{Success: true, Data: resData}
}

func (a *App) DBGetTables(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		runConfig.Type = "redis"
		client, err := a.getRedisClient(runConfig)
		if err != nil {
			logger.Error(err, "DBGetTables 获取 Redis 连接失败：%s", formatConnSummary(runConfig))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		cursor := uint64(0)
		tables := make([]string, 0, 128)
		seen := make(map[string]struct{}, 128)
		seenCursors := map[uint64]struct{}{cursor: {}}
		for {
			result, err := client.ScanKeys("*", cursor, 1000)
			if err != nil {
				logger.Error(err, "DBGetTables 扫描 Redis Key 失败：%s", formatConnSummary(runConfig))
				return connection.QueryResult{Success: false, Message: err.Error()}
			}
			for _, item := range result.Keys {
				key := strings.TrimSpace(item.Key)
				if key == "" {
					continue
				}
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				tables = append(tables, key)
			}
			rawCursor := strings.TrimSpace(result.Cursor)
			if rawCursor == "0" {
				break
			}
			next, err := strconv.ParseUint(rawCursor, 10, 64)
			if err != nil {
				return buildRedisTablesPartialResult(tables, fmt.Sprintf("invalid cursor %q: %v", rawCursor, err))
			}
			if _, exists := seenCursors[next]; exists {
				return buildRedisTablesPartialResult(tables, fmt.Sprintf("cursor loop detected (cursor=%d next=%d)", cursor, next))
			}
			seenCursors[next] = struct{}{}
			cursor = next
		}
		resData := make([]map[string]string, 0, len(tables))
		for _, name := range tables {
			resData = append(resData, map[string]string{"Table": name})
		}
		return connection.QueryResult{Success: true, Data: resData, ScannedCount: len(tables)}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetTables 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(dbName)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetTables 重建连接失败：%s", formatConnSummary(runConfig))
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			dbInst = retryInst
			tables, err = retryInst.GetTables(dbName)
		}
	}
	if err != nil {
		logger.Error(err, "DBGetTables 获取表列表失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	tables = dedupeMetadataTableNames(tables)

	if isSQLiteConnection(runConfig) {
		cachedStats, cacheErr := a.readSQLiteTableStats(runConfig, dbName)
		if cacheErr != nil {
			logger.Warnf("DBGetTables 读取 SQLite 表统计缓存失败（保留表列表）：%s err=%v", formatConnSummary(runConfig), cacheErr)
			cachedStats = map[string]sqliteCachedTableStat{}
		}
		resData := make([]map[string]string, 0, len(tables))
		for _, name := range tables {
			item := map[string]string{"Table": name}
			if stat, ok := cachedStats[name]; ok {
				applySQLiteTableStats(item, stat)
			}
			resData = append(resData, item)
		}
		return connection.QueryResult{Success: true, Data: resData}
	}

	tableRowCounts := map[string]int64{}
	if rowCounter, ok := dbInst.(db.TableRowCounter); ok {
		var countErr error
		tableRowCounts, countErr = rowCounter.GetTableRowCounts(dbName, tables)
		if countErr != nil {
			logger.Warnf("DBGetTables 获取表行数失败（保留已获取的表列表）：%s err=%v", formatConnSummary(runConfig), countErr)
		}
	}
	tableStorageStats := map[string]db.TableStorageStats{}
	if storageProvider, ok := dbInst.(db.TableStorageStatsProvider); ok {
		var storageErr error
		tableStorageStats, storageErr = storageProvider.GetTableStorageStats(dbName, tables)
		if storageErr != nil {
			logger.Warnf("DBGetTables 获取表存储大小失败（保留已获取的表列表）：%s err=%v", formatConnSummary(runConfig), storageErr)
		}
	}

	resData := make([]map[string]string, 0, len(tables))
	for _, name := range tables {
		item := map[string]string{"Table": name}
		if rowCount, ok := tableRowCounts[name]; ok {
			item["Rows"] = strconv.FormatInt(rowCount, 10)
		}
		if storageStats, ok := tableStorageStats[name]; ok {
			item["Data_length"] = strconv.FormatInt(storageStats.DataLength, 10)
			item["Index_length"] = strconv.FormatInt(storageStats.IndexLength, 10)
		}
		resData = append(resData, item)
	}

	return connection.QueryResult{Success: true, Data: resData}
}

// Metadata may come from a driver agent or catalog query with duplicate rows.
// Preserve exact identifiers and order while removing only identical nonblank entries.
func dedupeMetadataDatabaseNames(databases []string) []string {
	if len(databases) == 0 {
		return databases
	}
	seen := make(map[string]struct{}, len(databases))
	result := make([]string, 0, len(databases))
	for _, database := range databases {
		if strings.TrimSpace(database) == "" {
			continue
		}
		if _, exists := seen[database]; exists {
			continue
		}
		seen[database] = struct{}{}
		result = append(result, database)
	}
	return result
}

// Metadata may come from an optional driver agent or a catalog view with
// duplicate rows. Preserve exact identifiers and order while removing only
// identical nonblank entries so schema-qualified names remain distinct.
func dedupeMetadataTableNames(tables []string) []string {
	if len(tables) == 0 {
		return tables
	}
	seen := make(map[string]struct{}, len(tables))
	result := make([]string, 0, len(tables))
	for _, table := range tables {
		if strings.TrimSpace(table) == "" {
			continue
		}
		if _, exists := seen[table]; exists {
			continue
		}
		seen[table] = struct{}{}
		result = append(result, table)
	}
	return result
}

func buildRedisTablesPartialResult(tables []string, reason string) connection.QueryResult {
	warning := fmt.Sprintf("Redis key scan truncated after %d keys: %s", len(tables), strings.TrimSpace(reason))
	resData := make([]map[string]string, 0, len(tables))
	for _, name := range tables {
		resData = append(resData, map[string]string{"Table": name})
	}
	return connection.QueryResult{
		Success:           true,
		Data:              resData,
		Message:           warning,
		Partial:           true,
		Warnings:          []string{warning},
		Retryable:         true,
		Truncated:         true,
		ScannedCount:      len(tables),
		FailedObjectTypes: []string{"key"},
	}
}

func (a *App) DBRefreshTableStats(config connection.ConnectionConfig, dbName string, rawTables []string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	if !isSQLiteConnection(runConfig) {
		return connection.QueryResult{Success: false, Message: "table statistics refresh is only supported for SQLite connections"}
	}

	tables := make([]string, 0, len(rawTables))
	seen := make(map[string]struct{}, len(rawTables))
	for _, rawTable := range rawTables {
		tableName := strings.TrimSpace(rawTable)
		if tableName == "" {
			continue
		}
		if _, ok := seen[tableName]; ok {
			continue
		}
		seen[tableName] = struct{}{}
		tables = append(tables, tableName)
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBRefreshTableStats 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tableRowCounts := map[string]int64{}
	if rowCounter, ok := dbInst.(db.TableRowCounter); ok {
		tableRowCounts, err = rowCounter.GetTableRowCounts(dbName, tables)
		if err != nil {
			logger.Warnf("DBRefreshTableStats 获取 SQLite 表行数失败（保留旧缓存）：%s err=%v", formatConnSummary(runConfig), err)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	tableStorageStats := map[string]db.TableStorageStats{}
	if storageProvider, ok := dbInst.(db.TableStorageStatsProvider); ok {
		tableStorageStats, err = storageProvider.GetTableStorageStats(dbName, tables)
		if err != nil {
			logger.Warnf("DBRefreshTableStats 获取 SQLite 表存储大小失败（保留旧缓存大小）：%s err=%v", formatConnSummary(runConfig), err)
			tableStorageStats = map[string]db.TableStorageStats{}
		}
	}

	if err := a.mergeSQLiteTableStats(runConfig, dbName, tables, tableRowCounts, tableStorageStats); err != nil {
		logger.Warnf("DBRefreshTableStats 写入 SQLite 表统计缓存失败（仍返回实时结果）：%s err=%v", formatConnSummary(runConfig), err)
	}
	cachedStats, cacheErr := a.readSQLiteTableStats(runConfig, dbName)
	if cacheErr != nil {
		cachedStats = map[string]sqliteCachedTableStat{}
	}
	resData := make([]map[string]string, 0, len(tables))
	for _, name := range tables {
		item := map[string]string{"Table": name}
		if stat, ok := cachedStats[name]; ok {
			applySQLiteTableStats(item, stat)
		}
		if rowCount, ok := tableRowCounts[name]; ok {
			item["Rows"] = strconv.FormatInt(rowCount, 10)
		}
		if storage, ok := tableStorageStats[name]; ok {
			item["Data_length"] = strconv.FormatInt(storage.DataLength, 10)
			item["Index_length"] = strconv.FormatInt(storage.IndexLength, 10)
		}
		resData = append(resData, item)
	}
	return connection.QueryResult{Success: true, Data: resData}
}

func containsExactTableName(tables []string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" {
		return false
	}
	for _, table := range tables {
		if strings.TrimSpace(table) == target {
			return true
		}
	}
	return false
}

type tableNameMetadataProvider interface {
	GetTables(dbName string) ([]string, error)
}

func lookupExactTableExists(database tableNameMetadataProvider, dbName, tableName string) (bool, error) {
	if checker, ok := database.(db.TableExistsChecker); ok {
		return checker.TableExists(dbName, tableName)
	}

	tables, err := database.GetTables(dbName)
	if err != nil {
		return false, err
	}
	return containsExactTableName(tables, tableName), nil
}

// usesBareTableCatalogNames identifies drivers whose GetTables result is the
// object name only. Query text may retain a delimiter around a dotted literal,
// but exact catalog comparison must receive the logical object name.
func usesBareTableCatalogNames(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "tidb", "clickhouse", "tdengine":
		return true
	default:
		return false
	}
}

func normalizeTableExistsLookup(config connection.ConnectionConfig, dbName, tableName string) (string, string) {
	dbType := resolveDDLDBType(config)
	if usesBareTableCatalogNames(dbType) {
		if schema, table := normalizeMetadataSchemaAndTable(config, dbName, tableName); strings.TrimSpace(table) != "" {
			// Metadata normalization preserves a quoted dotted final segment for
			// DDL helpers. GetTables, however, returns its logical bare name.
			if _, logicalTable := db.SplitSQLQualifiedNameForDialect(table, dbType); strings.TrimSpace(logicalTable) != "" {
				table = logicalTable
			}
			return schema, table
		}
	}

	if dbType == "sqlite" {
		// SQLite normalization already distinguishes an attached-database
		// qualifier from a literal dotted table name. Do not parse its bare
		// catalog result again or `order.items` would be split incorrectly.
		if schema, table := normalizeMetadataSchemaAndTable(config, dbName, tableName); strings.TrimSpace(table) != "" {
			return schema, table
		}
	}

	if dbType == "sqlserver" {
		// SQL Server metadata returns dotted table names as
		// `[schema].[order.items]`. Match that canonical form when the query
		// uses a bracketed dotted final segment; ordinary schema.table names
		// retain their existing catalog spelling.
		segments := db.SplitSQLIdentifierPathForDialect(tableName, "sqlserver")
		if len(segments) >= 1 && segments[len(segments)-1].Quoted && strings.Contains(segments[len(segments)-1].Value, ".") {
			quote := func(value string) string {
				return "[" + strings.ReplaceAll(strings.TrimSpace(value), "]", "]]") + "]"
			}
			schemaParts := make([]string, 0, len(segments)-1)
			for _, segment := range segments[:len(segments)-1] {
				if value := strings.TrimSpace(segment.Value); value != "" {
					schemaParts = append(schemaParts, quote(value))
				}
			}
			if len(schemaParts) == 0 {
				schemaParts = append(schemaParts, quote("dbo"))
			}
			return dbName, strings.Join(schemaParts, ".") + "." + quote(segments[len(segments)-1].Value)
		}
	}
	return dbName, tableName
}

// DBTableExists checks one table against the driver's table-name metadata without
// loading row counts, storage statistics, or sampled message fields.
func (a *App) DBTableExists(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	targetTableName := strings.TrimSpace(tableName)
	if targetTableName == "" {
		return connection.QueryResult{Success: true, Data: map[string]bool{"exists": false}}
	}

	lookupDBName, lookupTableName := normalizeTableExistsLookup(config, dbName, targetTableName)
	runConfig := normalizeMetadataRunConfig(config, lookupDBName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		runConfig.Type = "redis"
		client, err := a.getRedisClient(runConfig)
		if err != nil {
			logger.Error(err, "DBTableExists 获取 Redis 连接失败：%s key=%s", formatConnSummary(runConfig), targetTableName)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		exists, err := client.KeyExists(targetTableName)
		if err != nil {
			logger.Error(err, "DBTableExists 检查 Redis Key 失败：%s key=%s", formatConnSummary(runConfig), targetTableName)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Data: map[string]bool{"exists": exists}}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBTableExists 获取连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, targetTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	exists, err := lookupExactTableExists(dbInst, lookupDBName, lookupTableName)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBTableExists 重建连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, targetTableName)
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			exists, err = lookupExactTableExists(retryInst, lookupDBName, lookupTableName)
		}
	}
	if err != nil {
		logger.Error(err, "DBTableExists 检查表是否存在失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, targetTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{
		Success: true,
		Data:    map[string]bool{"exists": exists},
	}
}

func (a *App) DBGetViews(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		return connection.QueryResult{Success: true, Data: []map[string]string{}}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetViews 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	viewLookup, err := listViewNameLookupWithStatus(dbInst, runConfig, dbName)
	if err != nil {
		logger.Warnf("DBGetViews 获取视图元数据失败：%s err=%v", formatConnSummary(runConfig), err)
		return connection.QueryResult{
			Success:   false,
			Message:   err.Error(),
			Data:      []map[string]string{},
			Retryable: true,
		}
	}

	views := mapValuesSorted(viewLookup)
	resData := make([]map[string]string, 0, len(views))
	for _, name := range views {
		resData = append(resData, map[string]string{"View": name})
	}

	return connection.QueryResult{Success: true, Data: resData}
}

func (a *App) DBShowCreateTable(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	dbType := resolveDDLDBType(config)
	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	if isOceanBaseOracleProtocol(config) {
		runConfig = normalizeMetadataRunConfig(config, dbName)
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	sqlStr, err := resolveCreateStatementWithFallbackWithText(dbInst, config, dbName, tableName, a.appText)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取建表语句失败：%s 表=%s", formatConnSummary(runConfig), tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: sqlStr}
}

func resolveCreateStatementWithFallback(dbInst db.Database, config connection.ConnectionConfig, dbName string, tableName string) (string, error) {
	return resolveCreateStatementWithFallbackWithText(dbInst, config, dbName, tableName, defaultDBBackendText)
}

func resolveCreateStatementWithFallbackWithText(dbInst db.Database, config connection.ConnectionConfig, dbName string, tableName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	dbType := resolveDDLDBType(config)
	metadataSchemaName, metadataTableName, ddlSchemaName, ddlTableName := resolveCreateStatementTargets(config, dbType, dbName, tableName)
	if metadataTableName == "" || ddlTableName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.table_name_required", nil))
	}

	sqlStr, sourceErr := dbInst.GetCreateStatement(metadataSchemaName, metadataTableName)
	if sourceErr == nil && !shouldFallbackCreateStatement(dbType, sqlStr) {
		if strings.TrimSpace(sqlStr) != "" {
			if columns, err := loadCreateStatementCommentColumns(dbInst, dbType, metadataSchemaName, metadataTableName); err == nil {
				sqlStr = appendCreateStatementColumnComments(dbType, ddlSchemaName, ddlTableName, sqlStr, columns)
			}
			sqlStr = appendCreateStatementTableComment(
				dbInst,
				dbType,
				metadataSchemaName,
				metadataTableName,
				ddlSchemaName,
				ddlTableName,
				sqlStr,
			)
			return sqlStr, nil
		}
		if isOceanBaseOracleProtocol(config) {
			if showDDL, ok := tryGetOceanBaseOracleShowCreateStatement(dbInst, metadataSchemaName, metadataTableName); ok {
				return showDDL, nil
			}
		}
		return sqlStr, nil
	}

	if isOceanBaseOracleProtocol(config) {
		if showDDL, ok := tryGetOceanBaseOracleShowCreateStatement(dbInst, metadataSchemaName, metadataTableName); ok {
			return showDDL, nil
		}
	}

	if supportsViewCreateStatementLookup(dbType) {
		if viewDDL, ok := tryGetViewCreateStatement(dbInst, config, dbName, ddlSchemaName, ddlTableName); ok {
			return viewDDL, nil
		}
	}

	if !supportsCreateStatementFallback(dbType) {
		if sourceErr != nil {
			return "", sourceErr
		}
		return sqlStr, nil
	}

	columns, colErr := dbInst.GetColumns(metadataSchemaName, metadataTableName)
	if colErr != nil {
		if sourceErr != nil {
			return "", sourceErr
		}
		return "", colErr
	}

	var indexes []connection.IndexDefinition
	if indexRows, idxErr := dbInst.GetIndexes(metadataSchemaName, metadataTableName); idxErr == nil {
		indexes = indexRows
	}

	fallbackDDL, buildErr := buildFallbackCreateStatementWithText(dbType, ddlSchemaName, ddlTableName, columns, indexes, text)
	if buildErr != nil {
		if sourceErr != nil {
			return "", sourceErr
		}
		return "", buildErr
	}
	fallbackDDL = appendCreateStatementTableComment(
		dbInst,
		dbType,
		metadataSchemaName,
		metadataTableName,
		ddlSchemaName,
		ddlTableName,
		fallbackDDL,
	)
	return fallbackDDL, nil
}

func tryGetOceanBaseOracleShowCreateStatement(dbInst db.Database, schemaName string, tableName string) (string, bool) {
	query := "SHOW CREATE TABLE " + quoteOracleMetadataTableRef(schemaName, tableName)
	data, _, err := dbInst.Query(query)
	if err != nil {
		return "", false
	}
	for _, row := range data {
		for _, key := range []string{"Create Table", "CREATE TABLE", "CREATE_TABLE", "DDL", "ddl"} {
			if val, ok := row[key]; ok {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text, true
				}
			}
		}
		for _, val := range row {
			text := strings.TrimSpace(fmt.Sprintf("%v", val))
			lower := strings.ToLower(text)
			if strings.HasPrefix(lower, "create table") ||
				strings.HasPrefix(lower, "create view") ||
				strings.HasPrefix(lower, "create or replace view") {
				return text, true
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text, true
				}
			}
		}
	}
	return "", false
}

func supportsCreateStatementFallback(dbType string) bool {
	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver":
		return true
	default:
		return false
	}
}

func supportsViewCreateStatementLookup(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "oracle", "dameng", "sqlite", "duckdb", "clickhouse":
		return true
	default:
		return false
	}
}

func shouldFallbackCreateStatement(dbType string, ddl string) bool {
	if !supportsCreateStatementFallback(dbType) {
		return false
	}

	trimmed := strings.TrimSpace(ddl)
	if trimmed == "" {
		return true
	}
	if hasCreateTableOrViewHead(trimmed) {
		return false
	}

	lower := strings.ToLower(trimmed)
	if strings.Contains(lower, "not fully supported") ||
		strings.Contains(lower, "not directly supported") ||
		strings.Contains(lower, "not supported") {
		return true
	}
	return true
}

func hasCreateTableOrViewHead(sqlText string) bool {
	lines := strings.Split(sqlText, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "--") || strings.HasPrefix(line, "/*") || strings.HasPrefix(line, "*") {
			continue
		}
		lower := strings.ToLower(line)
		return strings.HasPrefix(lower, "create table") ||
			strings.HasPrefix(lower, "create view") ||
			strings.HasPrefix(lower, "create or replace view")
	}
	return false
}

func buildFallbackCreateStatement(dbType string, schemaName string, tableName string, columns []connection.ColumnDefinition) (string, error) {
	return buildFallbackCreateStatementWithText(dbType, schemaName, tableName, columns, nil, defaultDBBackendText)
}

func loadCreateStatementCommentColumns(dbInst db.Database, dbType string, schemaName string, tableName string) ([]connection.ColumnDefinition, error) {
	if !shouldAppendColumnCommentsToCreateStatement(dbType) {
		return nil, nil
	}
	return dbInst.GetColumns(schemaName, tableName)
}

func shouldAppendColumnCommentsToCreateStatement(dbType string) bool {
	switch dbType {
	case "dameng":
		return true
	default:
		return false
	}
}

func appendCreateStatementColumnComments(dbType string, schemaName string, tableName string, ddl string, columns []connection.ColumnDefinition) string {
	if !shouldAppendColumnCommentsToCreateStatement(dbType) || strings.TrimSpace(ddl) == "" || len(columns) == 0 {
		return ddl
	}

	qualifiedTable := quoteTableIdentByType(dbType, schemaName, tableName)
	existingDDLUpper := strings.ToUpper(ddl)
	commentStatements := make([]string, 0, len(columns))
	for _, col := range columns {
		commentSQL := buildFallbackColumnCommentStatement(dbType, schemaName, tableName, qualifiedTable, col.Name, col.Comment)
		if commentSQL == "" {
			continue
		}
		if strings.Contains(existingDDLUpper, strings.ToUpper(commentSQL)) {
			continue
		}
		commentStatements = append(commentStatements, commentSQL)
	}
	if len(commentStatements) == 0 {
		return ddl
	}

	trimmedDDL := strings.TrimRight(ddl, " \t\r\n")
	if !strings.HasSuffix(trimmedDDL, ";") {
		trimmedDDL += ";"
	}
	return trimmedDDL + "\n" + strings.Join(commentStatements, "\n")
}

func appendCreateStatementTableComment(
	dbInst db.Database,
	dbType string,
	metadataSchemaName string,
	metadataTableName string,
	ddlSchemaName string,
	ddlTableName string,
	ddl string,
) string {
	if dbType != "postgres" || strings.TrimSpace(ddl) == "" {
		return ddl
	}
	provider, ok := dbInst.(db.TableCommentProvider)
	if !ok {
		return ddl
	}

	comment, err := provider.GetTableComment(metadataSchemaName, metadataTableName)
	if err != nil || comment == "" {
		return ddl
	}

	tableRef := quoteTableIdentByType(dbType, ddlSchemaName, ddlTableName)
	marker := "COMMENT ON TABLE " + strings.ToUpper(tableRef)
	if strings.Contains(strings.ToUpper(ddl), marker) {
		return ddl
	}

	trimmedDDL := strings.TrimRight(ddl, " \t\r\n")
	if !strings.HasSuffix(trimmedDDL, ";") {
		trimmedDDL += ";"
	}
	return fmt.Sprintf(
		"%s\nCOMMENT ON TABLE %s IS '%s';",
		trimmedDDL,
		tableRef,
		escapeSQLStringLiteralBody(dbType, comment),
	)
}

func buildFallbackCreateStatementWithText(dbType string, schemaName string, tableName string, columns []connection.ColumnDefinition, indexes []connection.IndexDefinition, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.table_name_required", nil))
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("%s", text("db.backend.error.table_columns_missing_for_ddl", nil))
	}

	qualifiedTable := quoteTableIdentByType(dbType, schemaName, table)
	columnLines := make([]string, 0, len(columns)+1)
	columnCommentLines := make([]string, 0, len(columns))
	primaryKeys := make([]string, 0, 2)

	for _, col := range columns {
		colNameRaw := strings.TrimSpace(col.Name)
		if colNameRaw == "" {
			continue
		}
		colType := strings.TrimSpace(col.Type)
		if colType == "" {
			colType = "text"
		}

		colName := quoteIdentByType(dbType, colNameRaw)
		defParts := []string{fmt.Sprintf("%s %s", colName, colType)}

		if dbType == "sqlserver" && strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
			defParts = append(defParts, "IDENTITY(1,1)")
		}
		if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
			defParts = append(defParts, "NOT NULL")
		}
		if col.Default != nil {
			defVal := strings.TrimSpace(*col.Default)
			if defVal != "" {
				defParts = append(defParts, "DEFAULT "+defVal)
			}
		}

		columnLines = append(columnLines, "  "+strings.Join(defParts, " "))
		if commentSQL := buildFallbackColumnCommentStatement(dbType, schemaName, table, qualifiedTable, colNameRaw, col.Comment); commentSQL != "" {
			columnCommentLines = append(columnCommentLines, commentSQL)
		}
		if strings.EqualFold(strings.TrimSpace(col.Key), "PRI") {
			primaryKeys = append(primaryKeys, colName)
		}
	}

	if len(columnLines) == 0 {
		return "", fmt.Errorf("%s", text("db.backend.error.table_columns_empty_for_ddl", nil))
	}
	if len(primaryKeys) > 0 {
		columnLines = append(columnLines, "  PRIMARY KEY ("+strings.Join(primaryKeys, ", ")+")")
	}
	indexStatements := buildFallbackIndexStatements(dbType, qualifiedTable, primaryKeys, indexes)

	ddl := strings.Builder{}
	ddl.WriteString("CREATE TABLE ")
	ddl.WriteString(qualifiedTable)
	ddl.WriteString(" (\n")
	ddl.WriteString(strings.Join(columnLines, ",\n"))
	ddl.WriteString("\n);")
	if len(indexStatements) > 0 {
		ddl.WriteString("\n")
		ddl.WriteString(strings.Join(indexStatements, "\n"))
	}
	if len(columnCommentLines) > 0 {
		ddl.WriteString("\n")
		ddl.WriteString(strings.Join(columnCommentLines, "\n"))
	}
	return ddl.String(), nil
}

type fallbackIndexGroup struct {
	Name    string
	Unique  bool
	Columns []string
}

func buildFallbackIndexStatements(dbType string, qualifiedTable string, primaryKeys []string, indexes []connection.IndexDefinition) []string {
	grouped := groupFallbackIndexDefinitions(indexes)
	if len(grouped) == 0 {
		return nil
	}

	statements := make([]string, 0, len(grouped))
	for _, idx := range grouped {
		if strings.TrimSpace(idx.Name) == "" || len(idx.Columns) == 0 {
			continue
		}
		if sameFallbackColumnNameList(idx.Columns, primaryKeys) {
			continue
		}

		quotedColumns := make([]string, 0, len(idx.Columns))
		for _, columnName := range idx.Columns {
			columnName = strings.TrimSpace(columnName)
			if columnName == "" {
				continue
			}
			quotedColumns = append(quotedColumns, quoteIdentByType(dbType, columnName))
		}
		if len(quotedColumns) == 0 {
			continue
		}

		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		statements = append(statements, fmt.Sprintf(
			"%s %s ON %s (%s);",
			prefix,
			quoteIdentByType(dbType, idx.Name),
			qualifiedTable,
			strings.Join(quotedColumns, ", "),
		))
	}

	return statements
}

func groupFallbackIndexDefinitions(indexes []connection.IndexDefinition) []fallbackIndexGroup {
	if len(indexes) == 0 {
		return nil
	}

	groupMap := make(map[string][]connection.IndexDefinition)
	order := make([]string, 0)
	for _, idx := range indexes {
		name := strings.TrimSpace(idx.Name)
		if name == "" {
			continue
		}
		if _, ok := groupMap[name]; !ok {
			order = append(order, name)
		}
		groupMap[name] = append(groupMap[name], idx)
	}

	grouped := make([]fallbackIndexGroup, 0, len(order))
	for _, name := range order {
		rows := groupMap[name]
		sort.SliceStable(rows, func(i, j int) bool {
			return rows[i].SeqInIndex < rows[j].SeqInIndex
		})

		group := fallbackIndexGroup{Name: name, Unique: true}
		for _, row := range rows {
			if row.NonUnique != 0 {
				group.Unique = false
			}
			columnName := strings.TrimSpace(row.ColumnName)
			if columnName != "" {
				group.Columns = append(group.Columns, columnName)
			}
		}
		grouped = append(grouped, group)
	}

	return grouped
}

func sameFallbackColumnNameList(a []string, b []string) bool {
	if len(a) == 0 || len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(strings.TrimSpace(a[i]), strings.TrimSpace(b[i])) {
			return false
		}
	}
	return true
}

func buildFallbackColumnCommentStatement(dbType string, schemaName string, tableName string, qualifiedTable string, columnName string, comment string) string {
	colName := strings.TrimSpace(columnName)
	commentText := strings.TrimSpace(comment)
	if colName == "" || commentText == "" {
		return ""
	}
	if dbType == "sqlserver" {
		schema := strings.TrimSpace(schemaName)
		if schema == "" {
			schema = "dbo"
		}
		return fmt.Sprintf(
			"EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'%s', @level0type = N'SCHEMA', @level0name = N'%s', @level1type = N'TABLE', @level1name = N'%s', @level2type = N'COLUMN', @level2name = N'%s';",
			strings.ReplaceAll(commentText, "'", "''"),
			strings.ReplaceAll(schema, "'", "''"),
			strings.ReplaceAll(strings.TrimSpace(tableName), "'", "''"),
			strings.ReplaceAll(colName, "'", "''"),
		)
	}
	columnRef := fmt.Sprintf("%s.%s", qualifiedTable, quoteIdentByType(dbType, colName))
	return fmt.Sprintf("COMMENT ON COLUMN %s IS '%s';", columnRef, strings.ReplaceAll(commentText, "'", "''"))
}

func getColumnsWithMetadataFallback(
	dbInst db.Database,
	config connection.ConnectionConfig,
	schemaName string,
	tableName string,
	text func(string, map[string]any) string,
) ([]connection.ColumnDefinition, error) {
	columns, err := dbInst.GetColumns(schemaName, tableName)
	if err != nil {
		return nil, err
	}
	if len(columns) > 0 || resolveDDLDBType(config) != "oracle" {
		return columns, nil
	}

	if inferred, inferErr := inferOracleColumnsFromDictionary(dbInst, schemaName, tableName, text); inferErr == nil && len(inferred) > 0 {
		return inferred, nil
	}
	if inferred, inferErr := inferOracleColumnsFromEmptySelect(dbInst, schemaName, tableName, text); inferErr == nil && len(inferred) > 0 {
		return inferred, nil
	}
	return columns, nil
}

func (a *App) DBGetColumns(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	text := a.appText

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetColumns 获取连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	columns, err := getColumnsWithMetadataFallback(dbInst, config, schemaName, pureTableName, text)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetColumns 重建连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			columns, err = getColumnsWithMetadataFallback(retryInst, config, schemaName, pureTableName, text)
		}
	}
	if err != nil {
		logger.Error(err, "DBGetColumns 获取列定义失败：%s 表=%s.%s schema=%s pureTable=%s", formatConnSummary(runConfig), dbName, tableName, schemaName, pureTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(columns)}
}

func inferOracleColumnsFromDictionary(dbInst db.Database, schemaName string, tableName string, text func(string, map[string]any) string) ([]connection.ColumnDefinition, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	var lastErr error
	for _, candidate := range appOracleMetadataNamePairs(schemaName, tableName) {
		data, _, err := dbInst.Query(buildAppOracleColumnsQuery(candidate.schema, candidate.table))
		if err != nil {
			lastErr = err
			continue
		}
		columns := parseAppOracleColumns(data)
		if len(columns) > 0 {
			return columns, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("%s", text("db.backend.error.column_definitions_missing", nil))
}

type appOracleMetadataNamePair struct {
	schema string
	table  string
}

func appOracleMetadataNamePairs(schemaName string, tableName string) []appOracleMetadataNamePair {
	rawSchema := strings.TrimSpace(schemaName)
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		return nil
	}

	upperSchema := strings.ToUpper(rawSchema)
	upperTable := strings.ToUpper(rawTable)
	pairs := make([]appOracleMetadataNamePair, 0, 4)
	seen := map[string]struct{}{}
	add := func(schema string, table string) {
		key := schema + "\x00" + table
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		pairs = append(pairs, appOracleMetadataNamePair{schema: schema, table: table})
	}

	add(rawSchema, rawTable)
	add(upperSchema, upperTable)
	add(rawSchema, upperTable)
	add(upperSchema, rawTable)
	return pairs
}

func buildAppOracleColumnsQuery(schema string, table string) string {
	metadataTableName := escapeAppOracleMetadataLiteral(table)
	metadataSchemaName := escapeAppOracleMetadataLiteral(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
		cc.comments AS "COMMENT"
	FROM user_tab_columns c
	LEFT JOIN user_col_comments cc
	  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
	LEFT JOIN (
		SELECT cols.table_name, cols.column_name
		FROM user_constraints cons
		JOIN user_cons_columns cols
		  ON cons.constraint_name = cols.constraint_name
		WHERE cons.constraint_type = 'P'
	) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
	WHERE c.table_name = '%s'
	ORDER BY c.column_id`, metadataTableName)
	}

	return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
		cc.comments AS "COMMENT"
	FROM all_tab_columns c
	LEFT JOIN all_col_comments cc
	  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
	LEFT JOIN (
		SELECT cols.owner, cols.table_name, cols.column_name
		FROM all_constraints cons
		JOIN all_cons_columns cols
		  ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
		WHERE cons.constraint_type = 'P'
	) pk ON c.owner = pk.owner AND c.table_name = pk.table_name AND c.column_name = pk.column_name
	WHERE c.owner = '%s' AND c.table_name = '%s'
	ORDER BY c.column_id`, metadataSchemaName, metadataTableName)
}

func parseAppOracleColumns(data []map[string]interface{}) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		name := appOracleRowString(row, "COLUMN_NAME", "column_name")
		if strings.TrimSpace(name) == "" {
			continue
		}

		defaultValue := appOracleRowString(row, "DATA_DEFAULT", "COLUMN_DEFAULT", "data_default", "column_default")
		col := connection.ColumnDefinition{
			Name:     name,
			Type:     formatAppOracleColumnType(row),
			Nullable: normalizeAppOracleNullable(appOracleRowString(row, "NULLABLE", "nullable")),
			Key:      appOracleRowString(row, "COLUMN_KEY", "column_key", "KEY", "key"),
			Extra:    appOracleAutoIncrementExtra(defaultValue),
			Comment:  appOracleRowString(row, "COMMENT", "COMMENTS", "comment", "comments"),
		}
		if defaultValue != "" {
			col.Default = &defaultValue
		}
		columns = append(columns, col)
	}
	return columns
}

func formatAppOracleColumnType(row map[string]interface{}) string {
	dataType := appOracleRowString(row, "DATA_TYPE", "TYPE_NAME", "data_type", "type_name")
	if dataType == "" || strings.Contains(dataType, "(") {
		return dataType
	}

	upperType := strings.ToUpper(dataType)
	if isAppOracleLengthQualifiedType(upperType) {
		if charLength, ok := appOracleRowInt(row, "CHAR_LENGTH", "CHAR_COL_DECL_LENGTH", "char_length", "char_col_decl_length"); ok && charLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, charLength)
		}
		if dataLength, ok := appOracleRowInt(row, "DATA_LENGTH", "data_length"); ok && dataLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, dataLength)
		}
	}

	if strings.Contains(upperType, "NUMBER") || strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC") {
		precision, hasPrecision := appOracleRowInt(row, "DATA_PRECISION", "NUMERIC_PRECISION", "data_precision", "numeric_precision")
		if hasPrecision && precision > 0 {
			scale, hasScale := appOracleRowInt(row, "DATA_SCALE", "NUMERIC_SCALE", "data_scale", "numeric_scale")
			if hasScale && scale > 0 {
				return fmt.Sprintf("%s(%d,%d)", dataType, precision, scale)
			}
			return fmt.Sprintf("%s(%d)", dataType, precision)
		}
	}

	return dataType
}

func isAppOracleLengthQualifiedType(upperType string) bool {
	switch strings.TrimSpace(upperType) {
	case "CHAR", "NCHAR", "VARCHAR", "VARCHAR2", "NVARCHAR", "NVARCHAR2", "RAW", "BINARY", "VARBINARY":
		return true
	default:
		return strings.Contains(upperType, "CHARACTER")
	}
}

func normalizeAppOracleNullable(nullable string) string {
	switch strings.ToUpper(strings.TrimSpace(nullable)) {
	case "N", "NO":
		return "NO"
	case "Y", "YES":
		return "YES"
	default:
		return strings.TrimSpace(nullable)
	}
}

func appOracleAutoIncrementExtra(defaultValue string) string {
	if strings.Contains(strings.ToUpper(strings.TrimSpace(defaultValue)), "NEXTVAL") {
		return "auto_increment"
	}
	return ""
}

func appOracleRowValue(row map[string]interface{}, names ...string) interface{} {
	for _, name := range names {
		if value, ok := row[name]; ok {
			return value
		}
	}
	for key, value := range row {
		for _, name := range names {
			if strings.EqualFold(key, name) {
				return value
			}
		}
	}
	return nil
}

func appOracleRowString(row map[string]interface{}, names ...string) string {
	return appOracleValueString(appOracleRowValue(row, names...))
}

func appOracleValueString(value interface{}) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case []byte:
		return strings.TrimSpace(string(typed))
	case string:
		return strings.TrimSpace(typed)
	default:
		text := strings.TrimSpace(fmt.Sprintf("%v", typed))
		if strings.EqualFold(text, "<nil>") {
			return ""
		}
		return text
	}
}

func appOracleRowInt(row map[string]interface{}, names ...string) (int, bool) {
	value := appOracleRowValue(row, names...)
	switch typed := value.(type) {
	case int:
		return typed, true
	case int8:
		return int(typed), true
	case int16:
		return int(typed), true
	case int32:
		return int(typed), true
	case int64:
		return int(typed), true
	case uint:
		return int(typed), true
	case uint8:
		return int(typed), true
	case uint16:
		return int(typed), true
	case uint32:
		return int(typed), true
	case uint64:
		return int(typed), true
	case float32:
		return int(typed), true
	case float64:
		return int(typed), true
	case []byte:
		parsed, err := strconv.Atoi(strings.TrimSpace(string(typed)))
		return parsed, err == nil
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return 0, false
	}
}

func escapeAppOracleMetadataLiteral(text string) string {
	return strings.ReplaceAll(strings.TrimSpace(text), "'", "''")
}

func inferOracleColumnsFromEmptySelect(dbInst db.Database, schemaName string, tableName string, text func(string, map[string]any) string) ([]connection.ColumnDefinition, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("%s", text("db.backend.error.table_name_required", nil))
	}

	query := "SELECT * FROM " + quoteOracleMetadataTableRef(schemaName, table) + " WHERE 1 = 0"
	_, fields, err := dbInst.Query(query)
	if err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("%s", text("db.backend.error.column_definitions_missing", nil))
	}

	columns := make([]connection.ColumnDefinition, 0, len(fields))
	for _, field := range fields {
		name := strings.TrimSpace(field)
		if name == "" {
			continue
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     name,
			Nullable: "",
			Key:      "",
			Extra:    "",
			Comment:  "",
		})
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("%s", text("db.backend.error.column_definitions_missing", nil))
	}
	return columns, nil
}

func quoteOracleMetadataIdentifier(ident string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(ident), `"`, `""`) + `"`
}

func quoteOracleMetadataTableRef(schemaName string, tableName string) string {
	tableRef := quoteOracleMetadataIdentifier(tableName)
	if strings.TrimSpace(schemaName) != "" {
		return quoteOracleMetadataIdentifier(schemaName) + "." + tableRef
	}
	return tableRef
}

func (a *App) DBGetIndexes(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetIndexes 获取连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	indexes, err := dbInst.GetIndexes(schemaName, pureTableName)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetIndexes 重建连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			indexes, err = retryInst.GetIndexes(schemaName, pureTableName)
		}
	}
	if err != nil {
		logger.Error(err, "DBGetIndexes 获取索引定义失败：%s 表=%s.%s schema=%s pureTable=%s", formatConnSummary(runConfig), dbName, tableName, schemaName, pureTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(indexes)}
}

func (a *App) DBGetForeignKeys(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	fks, err := dbInst.GetForeignKeys(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(fks)}
}

func (a *App) DBGetDatabaseForeignKeys(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	provider, ok := dbInst.(db.DatabaseForeignKeyProvider)
	if !ok {
		return connection.QueryResult{Success: false, Message: "database-wide foreign-key metadata is not supported"}
	}

	foreignKeysByTable, err := provider.GetDatabaseForeignKeys(dbName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if foreignKeysByTable == nil {
		foreignKeysByTable = make(map[string][]connection.ForeignKeyDefinition)
	}
	return connection.QueryResult{Success: true, Data: foreignKeysByTable}
}

func (a *App) DBGetTriggers(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	triggers, err := dbInst.GetTriggers(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(triggers)}
}

func (a *App) DropView(config connection.ConnectionConfig, dbName string, viewName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP VIEW %s", strings.TrimSpace(viewName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	viewName = strings.TrimSpace(viewName)
	if viewName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_view"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "clickhouse":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_drop_unsupported", map[string]any{"dbType": dbType})}
	}

	schemaName, pureViewName := normalizeSchemaAndTableByType(dbType, dbName, viewName)
	if pureViewName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
	}
	qualifiedView := quoteTableIdentByType(dbType, schemaName, pureViewName)
	sql := fmt.Sprintf("DROP VIEW %s", qualifiedView)

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.view_dropped", nil)}
}

func (a *App) DropFunction(config connection.ConnectionConfig, dbName string, routineName string, routineType string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP %s %s", strings.ToUpper(strings.TrimSpace(routineType)), strings.TrimSpace(routineName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	routineName = strings.TrimSpace(routineName)
	routineType = strings.TrimSpace(strings.ToUpper(routineType))
	if routineName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.routine_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_function_or_procedure"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if routineType != "FUNCTION" && routineType != "PROCEDURE" {
		routineType = "FUNCTION"
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "duckdb":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.routine_drop_unsupported", map[string]any{"dbType": dbType})}
	}
	if dbType == "duckdb" && routineType == "PROCEDURE" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.duckdb_procedure_drop_unsupported", nil)}
	}

	schemaName, pureName := normalizeSchemaAndTableByType(dbType, dbName, routineName)
	if pureName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.routine_name_required", nil)}
	}
	qualifiedName := quoteTableIdentByType(dbType, schemaName, pureName)
	sql := fmt.Sprintf("DROP %s %s", routineType, qualifiedName)

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if routineType == "PROCEDURE" {
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.procedure_dropped", nil)}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.function_dropped", nil)}
}

func (a *App) RenameView(config connection.ConnectionConfig, dbName string, oldName string, newName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER VIEW %s RENAME TO %s", strings.TrimSpace(oldName), strings.TrimSpace(newName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_view"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.EqualFold(oldName, newName) {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_same_name", nil)}
	}
	if strings.Contains(newName, ".") {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_new_name_no_qualifier", nil)}
	}
	if strings.HasSuffix(oldName, ".") {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.old_view_name_required", nil)}
	}

	dbType := resolveDDLDBType(config)
	schemaName, pureOldName := normalizeSchemaAndTableByType(dbType, dbName, oldName)
	if pureOldName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.old_view_name_required", nil)}
	}
	oldQualified := quoteTableIdentByType(dbType, schemaName, pureOldName)
	newQuoted := quoteIdentByType(dbType, newName)

	var sql string
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "clickhouse":
		newQualified := quoteTableIdentByType(dbType, schemaName, newName)
		sql = fmt.Sprintf("RENAME TABLE %s TO %s", oldQualified, newQualified)
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		sql = fmt.Sprintf("ALTER VIEW %s RENAME TO %s", oldQualified, newQuoted)
	case "sqlserver":
		oldFullName := schemaName + "." + pureOldName
		escapedOld := strings.ReplaceAll(oldFullName, "'", "''")
		escapedNew := strings.ReplaceAll(newName, "'", "''")
		sql = fmt.Sprintf("EXEC sp_rename '%s', '%s'", escapedOld, escapedNew)
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_rename_unsupported", map[string]any{"dbType": dbType})}
	}

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.view_renamed", nil)}
}

func (a *App) DBGetAllColumns(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	cols, err := dbInst.GetAllColumns(dbName)
	if err != nil {
		var partialErr *db.PartialMetadataError
		if errors.As(err, &partialErr) {
			return connection.QueryResult{
				Success:  true,
				Message:  partialErr.Error(),
				Data:     ensureNonNilSlice(cols),
				Partial:  true,
				Warnings: partialErr.Warnings(),
			}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(cols)}
}
