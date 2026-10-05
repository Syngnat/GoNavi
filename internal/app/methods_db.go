package app

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
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
	variantInfo := captureTestConnectionVariant(testConfig, dbInst)
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
	return a.testConnectionSuccessResult(testConfig, variantInfo)
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
