package app

import (
	"context"
	"errors"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/dbuser"
)

var errUserMgmtSessionUnsupported = errors.New("user management: pinned session unsupported by runtime")

// buildUserManagementTarget 把连接配置归一为 dbuser.Target。
// 方言类型取 resolveDDLDBType（goldendb → mysql、OceanBase Oracle 租户 → oracle），
// 原始类型用于识别分支（mariadb / oceanbase / goldendb / kingbase ...）。
func buildUserManagementTarget(config connection.ConnectionConfig) dbuser.Target {
	return dbuser.Target{
		DBType:             resolveDDLDBType(config),
		SourceType:         normalizeDriverType(config.Type),
		OceanBaseOracle:    isOceanBaseOracleProtocol(config),
		ConnectionUser:     strings.TrimSpace(config.User),
		ConnectionDatabase: strings.TrimSpace(config.Database),
	}
}

// userMgmtSQLExecutor 按库复用 getDatabase 缓存的连接，并优先走带 ctx 的查询契约，
// 使取消与超时能传到驱动（含外置 agent 进程）。
type userMgmtSQLExecutor struct {
	app       *App
	config    connection.ConnectionConfig
	mu        sync.Mutex
	instances map[string]db.Database
}

func newUserMgmtSQLExecutor(app *App, config connection.ConnectionConfig) *userMgmtSQLExecutor {
	return &userMgmtSQLExecutor{app: app, config: config, instances: map[string]db.Database{}}
}

func (e *userMgmtSQLExecutor) database(name string) (db.Database, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if instance, ok := e.instances[name]; ok {
		return instance, nil
	}
	instance, err := e.app.getDatabase(normalizeRunConfig(e.config, name))
	if err != nil {
		return nil, err
	}
	e.instances[name] = instance
	return instance, nil
}

// Query 实现 dbuser.Executor。
func (e *userMgmtSQLExecutor) Query(ctx context.Context, database, statement string) ([]map[string]any, error) {
	instance, err := e.database(database)
	if err != nil {
		return nil, err
	}
	if contexter, ok := instance.(db.QueryContexter); ok {
		rows, _, queryErr := contexter.QueryContext(ctx, statement)
		return rows, queryErr
	}
	rows, _, err := instance.Query(statement)
	return rows, err
}

// Exec 实现 dbuser.Executor。
func (e *userMgmtSQLExecutor) Exec(ctx context.Context, database, statement string) error {
	instance, err := e.database(database)
	if err != nil {
		return err
	}
	if contexter, ok := instance.(db.ExecContexter); ok {
		_, err = contexter.ExecContext(ctx, statement)
		return err
	}
	_, err = instance.Exec(statement)
	return err
}

// supportsSessions 判断默认库的运行时能否固定会话（HTTP 隧道等不支持）。
func (e *userMgmtSQLExecutor) supportsSessions(database string) bool {
	instance, err := e.database(database)
	if err != nil {
		return false
	}
	return runtimeSupportsSessionExecer(instance)
}

// OpenSession 实现 dbuser.SessionOpener。
func (e *userMgmtSQLExecutor) OpenSession(ctx context.Context, database string) (dbuser.Session, error) {
	instance, err := e.database(database)
	if err != nil {
		return nil, err
	}
	provider, ok := instance.(db.SessionExecerProvider)
	if !ok || !runtimeSupportsSessionExecer(instance) {
		return nil, errUserMgmtSessionUnsupported
	}
	execer, err := provider.OpenSessionExecer(ctx)
	if err != nil {
		return nil, err
	}
	return userMgmtSession{execer: execer}, nil
}

type userMgmtSession struct {
	execer db.StatementExecer
}

func (s userMgmtSession) Exec(ctx context.Context, statement string) error {
	_, err := s.execer.ExecContext(ctx, statement)
	return err
}

func (s userMgmtSession) Close() error {
	return s.execer.Close()
}

// newUserManagementEnv 按数据源族装配执行能力。
func (a *App) newUserManagementEnv(config connection.ConnectionConfig, family dbuser.Family) (dbuser.Env, *userMgmtSQLExecutor, error) {
	if family == dbuser.FamilyRedis {
		commands, err := a.newUserMgmtRedisExecutor(config)
		return dbuser.Env{Commands: commands}, nil, err
	}
	executor := newUserMgmtSQLExecutor(a, config)
	return dbuser.Env{SQL: executor}, executor, nil
}
