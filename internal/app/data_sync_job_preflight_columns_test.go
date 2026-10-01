//go:build gonavi_full_drivers || gonavi_sqlite_driver

package app

import (
	"context"
	"database/sql"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/syncjob"
)

// batchCounter 跨驱动实例共享的计数器。
//
// 预检会为源端/目标端分别建连接，每次新建都产生新的驱动实例，所以计数器必须
// 独立于实例存储，否则断言读到的是另一个实例上的零值。
type batchCounter struct {
	mu          sync.Mutex
	batchCalls  int
	singleCalls int
}

func (c *batchCounter) recordBatch() {
	c.mu.Lock()
	c.batchCalls++
	c.mu.Unlock()
}

func (c *batchCounter) recordSingle() {
	c.mu.Lock()
	c.singleCalls++
	c.mu.Unlock()
}

func (c *batchCounter) counts() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.batchCalls, c.singleCalls
}

// batchCountingDriver 统计批量与逐表两种列读取各自被调用多少次。
//
// 预取的收益必须被证明，而不是假设：如果预取算出的缓存键与逐表读取的键不一致，
// 缓存会永远不命中 —— 批量查询白发一轮，功能看起来正常，性能却没变。这个计数器
// 正是用来抓这种静默失效。
type batchCountingDriver struct {
	db.SQLiteDB
	counter *batchCounter
}

func (driver *batchCountingDriver) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	driver.counter.recordSingle()
	return driver.SQLiteDB.GetColumns(dbName, tableName)
}

func (driver *batchCountingDriver) GetColumnsBatch(dbName string, tableNames []string) (map[string][]connection.ColumnDefinition, error) {
	driver.counter.recordBatch()
	result := make(map[string][]connection.ColumnDefinition, len(tableNames))
	for _, tableName := range tableNames {
		columns, err := driver.SQLiteDB.GetColumns(dbName, tableName)
		if err != nil || len(columns) == 0 {
			continue
		}
		result[tableName] = columns
	}
	return result, nil
}

// allowOptionalDriversForTest 让本用例不依赖本机是否安装可选驱动。
//
// sqlite 属于「可选纯 Go 驱动」：运行时支持判定会去驱动目录查找安装产物，CI 与
// 开发机上是否安装并不一致。本用例要验证的是预取是否减少查询次数，与驱动是否
// 已安装无关，因此按本包既有做法替换这两处判定 seam。
func allowOptionalDriversForTest(t *testing.T) {
	t.Helper()
	previousSupport := driverRuntimeSupportStatusFunc
	previousRevision := verifyDriverAgentRevisionFunc
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }
	t.Cleanup(func() {
		driverRuntimeSupportStatusFunc = previousSupport
		verifyDriverAgentRevisionFunc = previousRevision
	})
}

func setupBatchCountingApp(t *testing.T) (*App, *batchCounter) {
	t.Helper()
	allowOptionalDriversForTest(t)
	counter := &batchCounter{}
	previousFactory := newDatabaseFunc
	newDatabaseFunc = func(kind string) (db.Database, error) {
		if kind != "sqlite" {
			return previousFactory(kind)
		}
		return &batchCountingDriver{counter: counter}, nil
	}
	t.Cleanup(func() { newDatabaseFunc = previousFactory })
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	t.Cleanup(application.Shutdown)
	return application, counter
}

// seedBatchPreflightTask 造一个源/目标各含若干张表的迁移任务。
func seedBatchPreflightTask(t *testing.T, application *App, tables []string) syncjob.JobDefinition {
	t.Helper()
	sourceFile := t.TempDir() + "/source.db"
	sourceConn, err := sql.Open("sqlite", sourceFile)
	if err != nil {
		t.Fatal(err)
	}
	targetFile := t.TempDir() + "/target.db"
	targetConn, err := sql.Open("sqlite", targetFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		statement := "CREATE TABLE " + table + " (id INTEGER PRIMARY KEY, note TEXT)"
		if _, err := sourceConn.Exec(statement); err != nil {
			t.Fatal(err)
		}
		if _, err := targetConn.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := sourceConn.Close(); err != nil {
		t.Fatal(err)
	}
	if err := targetConn.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{ID: "batch-source", Name: "source", Config: connection.ConnectionConfig{ID: "batch-source", Type: "sqlite", Database: sourceFile}}); err != nil {
		t.Fatal(err)
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{ID: "batch-target", Name: "target", Config: connection.ConnectionConfig{ID: "batch-target", Type: "sqlite", Database: targetFile}}); err != nil {
		t.Fatal(err)
	}
	mappings := make([]syncjob.TableMapping, 0, len(tables))
	for _, table := range tables {
		mappings = append(mappings, syncjob.TableMapping{
			SourceTable: table, TargetTable: table, Enabled: true,
			Columns: []syncjob.ColumnMapping{
				{Source: "id", Target: "id"},
				{Source: "note", Target: "note"},
			},
		})
	}
	return syncjob.NormalizeDefinition(syncjob.JobDefinition{
		Name: "batch", Kind: syncjob.JobKindMigration, Lifecycle: syncjob.JobLifecycleReady,
		Source:   syncjob.EndpointRef{ConnectionID: "batch-source", Database: sourceFile},
		Target:   syncjob.EndpointRef{ConnectionID: "batch-target", Database: targetFile},
		Mappings: mappings,
	})
}

// 支持批量的驱动：多张表的字段应由批量查询提供，逐表读取不再发生。
func TestDataSyncPreflightPrefetchesColumnsThroughBatch(t *testing.T) {
	application, driver := setupBatchCountingApp(t)
	definition := seedBatchPreflightTask(t, application, []string{"t1", "t2", "t3", "t4"})

	result := application.preflightDataSyncJobContext(context.Background(), definition, time.Now())
	if !result.Success {
		t.Fatalf("preflight: %+v", result.Issues)
	}
	batchCalls, singleCalls := driver.counts()
	if singleCalls != 0 {
		t.Fatalf("4 张表预取后不应再有逐表列读取, 实际 %d 次", singleCalls)
	}
	if batchCalls != 2 {
		// 源端、目标端各一批。
		t.Fatalf("期望源/目标各一次批量查询, 实际 %d 次", batchCalls)
	}
}

// 不支持批量的驱动：必须回退为逐表读取，行为与改动前一致。
//
// 这条断言的是「不变量」而不是「性能」：批量只是加速手段，任何驱动都不该因为它
// 而少读或多读元数据。
func TestDataSyncPreflightFallsBackWithoutBatchSupport(t *testing.T) {
	allowOptionalDriversForTest(t)
	var mu sync.Mutex
	singleCalls := 0
	previousFactory := newDatabaseFunc
	newDatabaseFunc = func(kind string) (db.Database, error) {
		if kind != "sqlite" {
			return previousFactory(kind)
		}
		return &plainCountingDriver{mu: &mu, singleCalls: &singleCalls}, nil
	}
	t.Cleanup(func() { newDatabaseFunc = previousFactory })
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	t.Cleanup(application.Shutdown)
	definition := seedBatchPreflightTask(t, application, []string{"t1", "t2"})

	result := application.preflightDataSyncJobContext(context.Background(), definition, time.Now())
	if !result.Success {
		t.Fatalf("preflight: %+v", result.Issues)
	}
	mu.Lock()
	got := singleCalls
	mu.Unlock()
	if got != 4 {
		// 2 张表 × 源/目标两侧。
		t.Fatalf("无批量能力时应逐表读取 4 次, 实际 %d 次", got)
	}
}

// plainCountingDriver 只统计逐表读取次数，不实现批量接口。
type plainCountingDriver struct {
	db.SQLiteDB
	mu          *sync.Mutex
	singleCalls *int
}

func (driver *plainCountingDriver) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	driver.mu.Lock()
	*driver.singleCalls++
	driver.mu.Unlock()
	return driver.SQLiteDB.GetColumns(dbName, tableName)
}
