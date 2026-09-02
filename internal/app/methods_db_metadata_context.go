package app

import (
	"context"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	redisbackend "GoNavi-Wails/internal/redis"
)

// metadataSession 仅持有一个 MCP 元数据请求的资源。
// Close 只会在执行请求的协程、元数据方法返回后调用，避免与运行中的查询并发关闭驱动。
type metadataSession struct {
	app         *App
	ctx         context.Context
	synchronous bool

	closeOnce sync.Once
	mu        sync.Mutex
	closed    bool
	databases []db.Database
	redis     []redisbackend.RedisClient
}

type metadataRedisOpenResult struct {
	client redisbackend.RedisClient
	err    error
}

func newMetadataSession(owner *App, ctx context.Context) *metadataSession {
	return newMetadataSessionWithMode(owner, ctx, false)
}

func newMetadataSessionWithMode(owner *App, ctx context.Context, synchronous bool) *metadataSession {
	if owner == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	sessionApp := NewAppWithSecretStore(owner.secretStore)
	sessionApp.ctx = owner.ctx
	sessionApp.webRuntime = owner.webRuntime
	sessionApp.headlessRuntime = owner.headlessRuntime
	sessionApp.startedAt = owner.startedAt
	sessionApp.configDir = owner.configDir
	owner.i18nMu.RLock()
	sessionApp.localizer = owner.localizer
	owner.i18nMu.RUnlock()

	session := &metadataSession{app: sessionApp, ctx: ctx, synchronous: synchronous}
	sessionApp.metadataSession = session
	return session
}

func (s *metadataSession) bindDatabase(database db.Database) {
	if s == nil || database == nil {
		return
	}
	db.BindMetadataContext(database, s.ctx)
	s.mu.Lock()
	s.databases = append(s.databases, database)
	s.mu.Unlock()
}

func (s *metadataSession) bindRedisClient(client redisbackend.RedisClient) bool {
	if s == nil || client == nil {
		return false
	}
	redisbackend.BindMetadataContext(client, s.ctx)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		redisbackend.ClearMetadataContext(client)
		return false
	}
	s.redis = append(s.redis, client)
	s.mu.Unlock()
	return true
}

func (s *metadataSession) openRedisClient(config connection.ConnectionConfig) (redisbackend.RedisClient, error) {
	if s == nil || s.app == nil {
		return nil, context.Canceled
	}
	if err := s.ctx.Err(); err != nil {
		return nil, err
	}
	if s.synchronous {
		client, err := s.app.openRedisClientIsolated(config)
		if err != nil {
			return nil, err
		}
		if err := s.ctx.Err(); err != nil {
			_ = client.Close()
			return nil, err
		}
		if !s.bindRedisClient(client) {
			_ = client.Close()
			return nil, context.Canceled
		}
		return client, nil
	}
	resultCh := make(chan metadataRedisOpenResult, 1)
	go func() {
		client, err := s.app.openRedisClientIsolated(config)
		if err == nil && client != nil && !s.bindRedisClient(client) {
			_ = client.Close()
			if ctxErr := s.ctx.Err(); ctxErr != nil {
				err = ctxErr
			} else {
				err = context.Canceled
			}
			client = nil
		}
		resultCh <- metadataRedisOpenResult{client: client, err: err}
	}()

	var result metadataRedisOpenResult
	select {
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	case result = <-resultCh:
	}
	if result.err != nil {
		return nil, result.err
	}
	if err := s.ctx.Err(); err != nil {
		return nil, err
	}
	return result.client, nil
}

func (s *metadataSession) Close() {
	if s == nil || s.app == nil {
		return
	}
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		databases := append([]db.Database(nil), s.databases...)
		clients := append([]redisbackend.RedisClient(nil), s.redis...)
		s.databases = nil
		s.redis = nil
		s.mu.Unlock()

		for _, database := range databases {
			db.ClearMetadataContext(database)
		}
		for _, client := range clients {
			redisbackend.ClearMetadataContext(client)
		}
		s.app.beginDatabaseShutdown()
		s.app.closeCachedDatabasesForShutdown()
		for _, client := range clients {
			if client != nil {
				_ = client.Close()
			}
		}
	})
}

func (a *App) runMetadataWithContext(ctx context.Context, operation func(*App) connection.QueryResult) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	session := newMetadataSession(a, ctx)
	if session == nil {
		return connection.QueryResult{Success: false, Message: "元数据会话不可用"}
	}

	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		result := operation(session.app)
		session.Close()
		resultCh <- result
	}()

	select {
	case result := <-resultCh:
		if err := ctx.Err(); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return result
	case <-ctx.Done():
		// 不在此处关闭：Database 未承诺 Close 可与 Query 并发执行。
		// Query 会收到 ctx，工作协程只在查询返回后关闭资源。
		return connection.QueryResult{Success: false, Message: ctx.Err().Error()}
	}
}

// runWebMetadataWithContext is deliberately synchronous. Context-aware
// drivers observe cancellation through their bound metadata context; legacy
// Connect/query calls finish in this goroutine before the HTTP handler returns.
func (a *App) runWebMetadataWithContext(ctx context.Context, operation func(*App) connection.QueryResult) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	session := newMetadataSessionWithMode(a, ctx, true)
	if session == nil {
		return connection.QueryResult{Success: false, Message: "元数据会话不可用"}
	}
	defer session.Close()
	result := operation(session.app)
	if err := ctx.Err(); err != nil && result.Success {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return result
}

func (a *App) DBGetDatabasesContext(ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetDatabases(config) })
}

func (a *App) DBGetTablesContext(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetTables(config, dbName) })
}

func (a *App) DBGetViewsContext(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetViews(config, dbName) })
}

func (a *App) DBGetObjectsContext(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetObjects(config, dbName) })
}

func (a *App) DBGetAllColumnsContext(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetAllColumns(config, dbName) })
}

func (a *App) DBGetColumnsContext(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetColumns(config, dbName, tableName) })
}

func (a *App) DBGetIndexesContext(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetIndexes(config, dbName, tableName) })
}

func (a *App) DBGetForeignKeysContext(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetForeignKeys(config, dbName, tableName) })
}

func (a *App) DBGetTriggersContext(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetTriggers(config, dbName, tableName) })
}

func (a *App) DBShowCreateTableContext(ctx context.Context, config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	return a.runMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBShowCreateTable(config, dbName, tableName) })
}
