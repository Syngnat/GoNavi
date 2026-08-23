package app

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	redisbackend "GoNavi-Wails/internal/redis"
)

type contextAwareMetadataDB struct {
	started   chan context.Context
	done      chan struct{}
	release   chan struct{}
	closeDone chan struct{}

	doneOnce       sync.Once
	closeOnce      sync.Once
	closeCalls     atomic.Int32
	skipTableQuery bool
	createErr      error
}

type metadataRequestContextKey struct{}

func newContextAwareMetadataDB() *contextAwareMetadataDB {
	return &contextAwareMetadataDB{
		started:   make(chan context.Context, 1),
		done:      make(chan struct{}),
		release:   make(chan struct{}),
		closeDone: make(chan struct{}),
	}
}

func (f *contextAwareMetadataDB) Connect(connection.ConnectionConfig) error { return nil }
func (f *contextAwareMetadataDB) Close() error {
	select {
	case <-f.done:
	default:
		panic("查询尚未退出即关闭数据库")
	}
	f.closeCalls.Add(1)
	f.closeOnce.Do(func() { close(f.closeDone) })
	return nil
}
func (f *contextAwareMetadataDB) Ping() error { return nil }
func (f *contextAwareMetadataDB) Query(string) ([]map[string]interface{}, []string, error) {
	return f.queryWithContext(db.MetadataContext(f))
}
func (f *contextAwareMetadataDB) QueryContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	return f.queryWithContext(ctx)
}
func (f *contextAwareMetadataDB) queryWithContext(ctx context.Context) ([]map[string]interface{}, []string, error) {
	select {
	case f.started <- ctx:
	default:
	}
	select {
	case <-ctx.Done():
		f.doneOnce.Do(func() { close(f.done) })
		return nil, nil, ctx.Err()
	case <-f.release:
		f.doneOnce.Do(func() { close(f.done) })
		return []map[string]interface{}{{"name": "orders"}}, []string{"name"}, nil
	}
}
func (f *contextAwareMetadataDB) Exec(string) (int64, error)      { return 0, nil }
func (f *contextAwareMetadataDB) GetDatabases() ([]string, error) { return nil, nil }
func (f *contextAwareMetadataDB) GetTables(string) ([]string, error) {
	if f.skipTableQuery {
		return []string{"orders"}, nil
	}
	_, _, err := f.Query("metadata tables")
	if err != nil {
		return nil, err
	}
	return []string{"orders"}, nil
}
func (f *contextAwareMetadataDB) GetCreateStatement(string, string) (string, error) {
	return "", f.createErr
}
func (f *contextAwareMetadataDB) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	_, _, err := f.Query("metadata columns")
	if err != nil {
		return nil, err
	}
	return []connection.ColumnDefinition{{Name: "id", Type: "bigint"}}, nil
}
func (f *contextAwareMetadataDB) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *contextAwareMetadataDB) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *contextAwareMetadataDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *contextAwareMetadataDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

var _ db.Database = (*contextAwareMetadataDB)(nil)

type contextAwareMetadataRedisClient struct {
	capturingRedisClient
	started    chan context.Context
	done       chan struct{}
	closeDone  chan struct{}
	doneOnce   sync.Once
	closeOnce  sync.Once
	closeCalls atomic.Int32
}

func newContextAwareMetadataRedisClient() *contextAwareMetadataRedisClient {
	return &contextAwareMetadataRedisClient{
		started:   make(chan context.Context, 1),
		done:      make(chan struct{}),
		closeDone: make(chan struct{}),
	}
}

func (c *contextAwareMetadataRedisClient) Close() error {
	select {
	case <-c.done:
	default:
		panic("Redis 扫描尚未退出即关闭客户端")
	}
	c.closeCalls.Add(1)
	c.closeOnce.Do(func() { close(c.closeDone) })
	return nil
}

func (c *contextAwareMetadataRedisClient) ScanKeys(string, uint64, int64) (*redisbackend.RedisScanResult, error) {
	ctx := redisbackend.MetadataContext(c)
	c.started <- ctx
	<-ctx.Done()
	c.doneOnce.Do(func() { close(c.done) })
	return nil, ctx.Err()
}

var _ redisbackend.RedisClient = (*contextAwareMetadataRedisClient)(nil)

type blockingConnectMetadataDB struct {
	connectStarted chan struct{}
	releaseConnect chan struct{}
	closeDone      chan struct{}

	connectOnce sync.Once
	closeOnce   sync.Once
	closeCalls  atomic.Int32
}

func newBlockingConnectMetadataDB() *blockingConnectMetadataDB {
	return &blockingConnectMetadataDB{
		connectStarted: make(chan struct{}),
		releaseConnect: make(chan struct{}),
		closeDone:      make(chan struct{}),
	}
}

func (f *blockingConnectMetadataDB) Connect(connection.ConnectionConfig) error {
	f.connectOnce.Do(func() { close(f.connectStarted) })
	<-f.releaseConnect
	return nil
}

func (f *blockingConnectMetadataDB) Close() error {
	f.closeCalls.Add(1)
	f.closeOnce.Do(func() { close(f.closeDone) })
	return nil
}

func (f *blockingConnectMetadataDB) Ping() error { return nil }
func (f *blockingConnectMetadataDB) Query(string) ([]map[string]interface{}, []string, error) {
	return nil, nil, context.Canceled
}
func (f *blockingConnectMetadataDB) Exec(string) (int64, error)      { return 0, nil }
func (f *blockingConnectMetadataDB) GetDatabases() ([]string, error) { return nil, nil }
func (f *blockingConnectMetadataDB) GetTables(string) ([]string, error) {
	return nil, context.Canceled
}
func (f *blockingConnectMetadataDB) GetCreateStatement(string, string) (string, error) {
	return "", nil
}
func (f *blockingConnectMetadataDB) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (f *blockingConnectMetadataDB) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *blockingConnectMetadataDB) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *blockingConnectMetadataDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *blockingConnectMetadataDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

var _ db.Database = (*blockingConnectMetadataDB)(nil)

type blockingConnectMetadataRedisClient struct {
	capturingRedisClient
	connectStarted chan struct{}
	releaseConnect chan struct{}
	closeDone      chan struct{}

	connectOnce sync.Once
	closeOnce   sync.Once
	closeCalls  atomic.Int32
	scanCalls   atomic.Int32
}

func newBlockingConnectMetadataRedisClient() *blockingConnectMetadataRedisClient {
	return &blockingConnectMetadataRedisClient{
		connectStarted: make(chan struct{}),
		releaseConnect: make(chan struct{}),
		closeDone:      make(chan struct{}),
	}
}

func (c *blockingConnectMetadataRedisClient) Connect(connection.ConnectionConfig) error {
	c.connectOnce.Do(func() { close(c.connectStarted) })
	<-c.releaseConnect
	return nil
}

func (c *blockingConnectMetadataRedisClient) Close() error {
	c.closeCalls.Add(1)
	c.closeOnce.Do(func() { close(c.closeDone) })
	return nil
}

func (c *blockingConnectMetadataRedisClient) ScanKeys(string, uint64, int64) (*redisbackend.RedisScanResult, error) {
	c.scanCalls.Add(1)
	return nil, context.Canceled
}

var _ redisbackend.RedisClient = (*blockingConnectMetadataRedisClient)(nil)

func installMetadataSessionTestHooks(t *testing.T) {
	t.Helper()
	installDatabaseCacheConcurrencyTestHooks(t)
}

func waitForContext(t *testing.T, contexts <-chan context.Context, message string) context.Context {
	t.Helper()
	select {
	case ctx := <-contexts:
		return ctx
	case <-time.After(time.Second):
		t.Fatal(message)
		return nil
	}
}

func waitForMetadataSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal(message)
	}
}

func TestMetadataContextCancellationReachesQuery(t *testing.T) {
	tests := []struct {
		name string
		call func(*App, context.Context, connection.ConnectionConfig) connection.QueryResult
	}{
		{
			name: "tables",
			call: func(application *App, ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
				return application.DBGetTablesContext(ctx, config, "app")
			},
		},
		{
			name: "columns",
			call: func(application *App, ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
				return application.DBGetColumnsContext(ctx, config, "app", "orders")
			},
		},
		{
			name: "views",
			call: func(application *App, ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
				return application.DBGetViewsContext(ctx, config, "app")
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			installMetadataSessionTestHooks(t)
			instance := newContextAwareMetadataDB()
			newDatabaseFunc = func(string) (db.Database, error) { return instance, nil }
			application := newDatabaseCacheConcurrencyTestApp()
			config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}
			ctx, cancel := context.WithCancel(context.WithValue(context.Background(), metadataRequestContextKey{}, "metadata-request"))
			defer cancel()

			resultCh := make(chan connection.QueryResult, 1)
			go func() { resultCh <- testCase.call(application, ctx, config) }()
			if got := waitForContext(t, instance.started, "元数据查询未启动"); got.Value(metadataRequestContextKey{}) != "metadata-request" {
				t.Fatalf("查询上下文未继承请求上下文值：%v", got)
			}
			cancel()

			select {
			case result := <-resultCh:
				if result.Success {
					t.Fatalf("取消的元数据请求意外成功：%#v", result)
				}
			case <-time.After(time.Second):
				t.Fatal("取消的元数据请求未及时返回")
			}
			waitForMetadataSignal(t, instance.done, "查询未因上下文取消而退出")
			waitForMetadataSignal(t, instance.closeDone, "查询退出后未关闭隔离数据库")
			if calls := instance.closeCalls.Load(); calls != 1 {
				t.Fatalf("隔离数据库 Close 调用次数 = %d，期望 1", calls)
			}
		})
	}
}

func TestMetadataObjectsFallbackCancellationReachesQuery(t *testing.T) {
	installMetadataSessionTestHooks(t)
	instance := newContextAwareMetadataDB()
	instance.skipTableQuery = true
	newDatabaseFunc = func(string) (db.Database, error) { return instance, nil }
	application := newDatabaseCacheConcurrencyTestApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), metadataRequestContextKey{}, "metadata-request"))
	defer cancel()

	resultCh := make(chan connection.QueryResult, 1)
	go func() { resultCh <- application.DBGetObjectsContext(ctx, config, "app") }()
	if got := waitForContext(t, instance.started, "对象后备元数据查询未启动"); got.Value(metadataRequestContextKey{}) != "metadata-request" {
		t.Fatalf("对象后备查询未继承请求上下文值：%v", got)
	}
	cancel()

	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("取消的对象元数据请求意外成功：%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("取消的对象元数据请求未及时返回")
	}
	waitForMetadataSignal(t, instance.done, "对象后备查询未因上下文取消而退出")
	waitForMetadataSignal(t, instance.closeDone, "对象后备查询退出后未关闭隔离数据库")
}

func TestMetadataDDLViewFallbackCancellationReachesQuery(t *testing.T) {
	installMetadataSessionTestHooks(t)
	instance := newContextAwareMetadataDB()
	instance.createErr = errors.New("create statement unavailable")
	newDatabaseFunc = func(string) (db.Database, error) { return instance, nil }
	application := newDatabaseCacheConcurrencyTestApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), metadataRequestContextKey{}, "metadata-request"))
	defer cancel()

	resultCh := make(chan connection.QueryResult, 1)
	go func() { resultCh <- application.DBShowCreateTableContext(ctx, config, "app", "orders") }()
	if got := waitForContext(t, instance.started, "DDL 视图回退查询未启动"); got.Value(metadataRequestContextKey{}) != "metadata-request" {
		t.Fatalf("DDL 视图回退查询未继承请求上下文值：%v", got)
	}
	cancel()

	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("取消的 DDL 元数据请求意外成功：%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("取消的 DDL 元数据请求未及时返回")
	}
	waitForMetadataSignal(t, instance.done, "DDL 视图回退查询未因上下文取消而退出")
	waitForMetadataSignal(t, instance.closeDone, "DDL 视图回退查询退出后未关闭隔离数据库")
}

func TestCancelledMetadataRequestClosesLateDatabaseConnection(t *testing.T) {
	installMetadataSessionTestHooks(t)
	instance := newBlockingConnectMetadataDB()
	newDatabaseFunc = func(string) (db.Database, error) { return instance, nil }
	application := newDatabaseCacheConcurrencyTestApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resultCh := make(chan connection.QueryResult, 1)
	go func() { resultCh <- application.DBGetTablesContext(ctx, config, "app") }()
	waitForMetadataSignal(t, instance.connectStarted, "元数据连接未启动")

	cancel()
	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("取消的元数据请求意外成功：%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("阻塞连接的元数据请求未及时返回")
	}

	close(instance.releaseConnect)
	waitForMetadataSignal(t, instance.closeDone, "迟到完成的元数据连接未被关闭")
	if calls := instance.closeCalls.Load(); calls != 1 {
		t.Fatalf("迟到连接 Close 调用次数 = %d，期望 1", calls)
	}
}

func TestCancelledMetadataRequestClosesLateRedisConnection(t *testing.T) {
	originalNewRedisClientFunc := newRedisClientFunc
	t.Cleanup(func() { newRedisClientFunc = originalNewRedisClientFunc })
	client := newBlockingConnectMetadataRedisClient()
	newRedisClientFunc = func() redisbackend.RedisClient { return client }
	application := newDatabaseCacheConcurrencyTestApp()
	config := connection.ConnectionConfig{Type: "redis", Host: "127.0.0.1", Port: 6379}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resultCh := make(chan connection.QueryResult, 1)
	go func() { resultCh <- application.DBGetTablesContext(ctx, config, "0") }()
	waitForMetadataSignal(t, client.connectStarted, "Redis 元数据连接未启动")

	cancel()
	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("取消的 Redis 元数据请求意外成功：%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("阻塞 Redis 连接的元数据请求未及时返回")
	}

	close(client.releaseConnect)
	waitForMetadataSignal(t, client.closeDone, "迟到完成的 Redis 元数据连接未被关闭")
	if calls := client.closeCalls.Load(); calls != 1 {
		t.Fatalf("迟到 Redis 连接 Close 调用次数 = %d，期望 1", calls)
	}
	if calls := client.scanCalls.Load(); calls != 0 {
		t.Fatalf("取消后仍执行了 Redis 元数据扫描 %d 次", calls)
	}
}

func TestCancelledMetadataRequestDoesNotAffectConcurrentRequest(t *testing.T) {
	installMetadataSessionTestHooks(t)
	instances := make(chan *contextAwareMetadataDB, 2)
	newDatabaseFunc = func(string) (db.Database, error) {
		instance := newContextAwareMetadataDB()
		instances <- instance
		return instance, nil
	}
	application := newDatabaseCacheConcurrencyTestApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()

	firstResult := make(chan connection.QueryResult, 1)
	go func() { firstResult <- application.DBGetTablesContext(firstCtx, config, "app") }()
	first := <-instances
	if got := waitForContext(t, first.started, "第一个元数据查询未启动"); got != firstCtx {
		t.Fatal("第一个查询未接收其请求上下文")
	}

	secondResult := make(chan connection.QueryResult, 1)
	go func() { secondResult <- application.DBGetTablesContext(context.Background(), config, "app") }()
	second := <-instances
	waitForContext(t, second.started, "第二个元数据查询未启动")

	cancelFirst()
	select {
	case result := <-firstResult:
		if result.Success {
			t.Fatalf("取消的请求意外成功：%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("第一个取消请求未返回")
	}
	waitForMetadataSignal(t, first.closeDone, "第一个会话未释放")
	if calls := second.closeCalls.Load(); calls != 0 {
		t.Fatalf("取消第一个请求时关闭了第二个会话 %d 次", calls)
	}

	close(second.release)
	select {
	case result := <-secondResult:
		if !result.Success {
			t.Fatalf("并发请求被无关取消影响：%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("第二个请求未完成")
	}
	waitForMetadataSignal(t, second.closeDone, "第二个会话未释放")
}

func TestRedisMetadataContextCancellationReachesScan(t *testing.T) {
	originalNewRedisClientFunc := newRedisClientFunc
	t.Cleanup(func() { newRedisClientFunc = originalNewRedisClientFunc })
	client := newContextAwareMetadataRedisClient()
	newRedisClientFunc = func() redisbackend.RedisClient { return client }
	application := newDatabaseCacheConcurrencyTestApp()
	config := connection.ConnectionConfig{Type: "redis", Host: "127.0.0.1", Port: 6379}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resultCh := make(chan connection.QueryResult, 1)
	go func() { resultCh <- application.DBGetTablesContext(ctx, config, "0") }()
	if got := waitForContext(t, client.started, "Redis 扫描未启动"); got != ctx {
		t.Fatal("Redis 扫描未接收请求上下文")
	}
	cancel()

	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("取消的 Redis 元数据请求意外成功：%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("取消的 Redis 元数据请求未及时返回")
	}
	waitForMetadataSignal(t, client.done, "Redis 扫描未因上下文取消而退出")
	waitForMetadataSignal(t, client.closeDone, "Redis 扫描退出后未关闭隔离客户端")
}
