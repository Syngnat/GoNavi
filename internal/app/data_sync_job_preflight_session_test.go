//go:build gonavi_full_drivers || gonavi_sqlite_driver

package app

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/syncjob"
)

// connectCountingDriver 统计每个实例的 Connect 次数，用于证明一次预检内的多个
// 映射复用同一批连接，而不是逐表重连。
type connectCountingDriver struct {
	db.SQLiteDB
	connects *int32
}

func (driver *connectCountingDriver) Connect(config connection.ConnectionConfig) error {
	*driver.connects++
	return driver.SQLiteDB.Connect(config)
}

func setupConnectCountingApp(t *testing.T) (*App, *int32) {
	t.Helper()
	var connects int32
	var mutex sync.Mutex
	previousFactory := newDatabaseFunc
	newDatabaseFunc = func(kind string) (db.Database, error) {
		if kind != "sqlite" {
			return previousFactory(kind)
		}
		mutex.Lock()
		defer mutex.Unlock()
		return &connectCountingDriver{connects: &connects}, nil
	}
	t.Cleanup(func() { newDatabaseFunc = previousFactory })
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	t.Cleanup(application.Shutdown)
	return application, &connects
}

func seedBackupSource(t *testing.T, application *App, tables ...string) (string, syncjob.JobDefinition) {
	t.Helper()
	file := t.TempDir() + "/source.db"
	database, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		if _, err := database.Exec("CREATE TABLE " + table + " (id INTEGER PRIMARY KEY, note TEXT)"); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{ID: "counting-source", Name: "source", Config: connection.ConnectionConfig{ID: "counting-source", Type: "sqlite", Database: file}}); err != nil {
		t.Fatal(err)
	}
	mappings := make([]syncjob.TableMapping, 0, len(tables))
	for _, table := range tables {
		mappings = append(mappings, syncjob.TableMapping{SourceTable: table, Enabled: true})
	}
	definition := syncjob.NormalizeDefinition(syncjob.JobDefinition{
		Name: "counting", Kind: syncjob.JobKindBackup, Lifecycle: syncjob.JobLifecycleReady,
		Source:   syncjob.EndpointRef{ConnectionID: "counting-source", Database: file},
		Backup:   &syncjob.BackupSpec{Directory: t.TempDir(), Content: "both"},
		Mappings: mappings,
	})
	return file, definition
}

// 预检的连接数必须与表数无关：逐表新建会话时 8 张表要建连 8 次，
// 共用会话后应稳定在 1 次。这正是「预检卡住」的回归护栏。
func TestBackupPreflightReusesOneConnectionPerSource(t *testing.T) {
	application, connects := setupConnectCountingApp(t)
	_, definition := seedBackupSource(t, application, "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8")

	result := application.preflightBackupJob(context.Background(), definition, time.Now())
	if !result.Success {
		t.Fatalf("preflight: %+v", result.Issues)
	}
	if *connects != 1 {
		t.Fatalf("preflight opened %d source connections for 8 tables, want 1", *connects)
	}
}

// 会话必须在预检返回后就关闭：连接绑定本次 ctx，泄漏会让后台 worker
// 长期持有一批空闲连接。
func TestBackupPreflightClosesSessionConnections(t *testing.T) {
	application, connects := setupConnectCountingApp(t)
	_, definition := seedBackupSource(t, application, "t1", "t2")

	result := application.preflightBackupJob(context.Background(), definition, time.Now())
	if !result.Success {
		t.Fatalf("preflight: %+v", result.Issues)
	}
	application.mu.RLock()
	cached := len(application.dbCache)
	application.mu.RUnlock()
	if cached != 0 {
		t.Fatalf("metadata session leaked %d cached connections", cached)
	}
	if *connects == 0 {
		t.Fatal("preflight never connected to the source")
	}
}

// 通用预检的映射校验按会话复用连接，连接数必须与表数无关。
//
// 修复前每张表的源列、目标表存在性与目标列三类查询各建一次连，8 张表要
// 22 次以上建连；SSH 转发下单次约 3.4 秒，这正是「预检长时间不返回」的来源。
func TestDataSyncPreflightConnectionCountIsIndependentOfMappings(t *testing.T) {
	measure := func(t *testing.T, tableCount int) int32 {
		t.Helper()
		application, connects := setupConnectCountingApp(t)
		tables := make([]string, 0, tableCount)
		for index := 0; index < tableCount; index++ {
			tables = append(tables, "t"+strconv.Itoa(index))
		}
		sourceFile, _ := seedBackupSource(t, application, tables...)
		targetFile := t.TempDir() + "/target.db"
		target, err := sql.Open("sqlite", targetFile)
		if err != nil {
			t.Fatal(err)
		}
		statements := ""
		for _, table := range tables {
			statements += "CREATE TABLE " + table + "_copy (id INTEGER PRIMARY KEY, note TEXT);"
		}
		if _, err := target.Exec(statements); err != nil {
			t.Fatal(err)
		}
		if err := target.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := application.SaveConnection(connection.SavedConnectionInput{ID: "counting-target", Name: "target", Config: connection.ConnectionConfig{ID: "counting-target", Type: "sqlite", Database: targetFile}}); err != nil {
			t.Fatal(err)
		}
		mappings := make([]syncjob.TableMapping, 0, tableCount)
		for _, table := range tables {
			mappings = append(mappings, syncjob.TableMapping{
				SourceTable: table, TargetTable: table + "_copy", Enabled: true,
				Columns: []syncjob.ColumnMapping{
					{Source: "id", Target: "id"},
					{Source: "note", Target: "note"},
				},
			})
		}
		definition := syncjob.NormalizeDefinition(syncjob.JobDefinition{
			Name: "mapping", Kind: syncjob.JobKindMigration, Lifecycle: syncjob.JobLifecycleReady,
			Source:   syncjob.EndpointRef{ConnectionID: "counting-source", Database: sourceFile},
			Target:   syncjob.EndpointRef{ConnectionID: "counting-target", Database: targetFile},
			Mappings: mappings,
		})

		result := application.preflightDataSyncJobContext(context.Background(), definition, time.Now())
		if !result.Success {
			t.Fatalf("preflight %d tables: %+v", tableCount, result.Issues)
		}
		return *connects
	}

	single := measure(t, 1)
	many := measure(t, 8)
	if many != single {
		t.Fatalf("connection count scales with mappings: 1 table=%d, 8 tables=%d", single, many)
	}
}

// blockingDriver 的 Connect 永不返回，用来模拟 SSH 转发下驱动卡死。
type blockingDriver struct {
	db.SQLiteDB
	release chan struct{}
}

func (driver *blockingDriver) Connect(config connection.ConnectionConfig) error {
	<-driver.release
	return errors.New("released")
}

// 桌面端的预检入口必须自带超时上界。
//
// Wails 绑定不携带 signal，驱动 Connect/Ping 阻塞时前端无法取消，界面只会
// 永久停在转圈状态（「确定启用任务吗？」确认后一直转圈）。web 端走
// dataSyncJobPreflightContext 已有超时，但桌面端走 preflightDataSyncJob，
// 此前是 context.Background()，没有任何上界。
func TestDesktopPreflightReturnsWhenTheDriverBlocks(t *testing.T) {
	release := make(chan struct{})
	previousFactory := newDatabaseFunc
	newDatabaseFunc = func(kind string) (db.Database, error) {
		if kind != "sqlite" {
			return previousFactory(kind)
		}
		return &blockingDriver{release: release}, nil
	}
	t.Cleanup(func() {
		newDatabaseFunc = previousFactory
		close(release)
	})
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	t.Cleanup(application.Shutdown)

	file := t.TempDir() + "/source.db"
	seed, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{ID: "blocked-source", Name: "blocked", Config: connection.ConnectionConfig{ID: "blocked-source", Type: "sqlite", Database: file}}); err != nil {
		t.Fatal(err)
	}
	definition := syncjob.NormalizeDefinition(syncjob.JobDefinition{
		Name: "blocked", Kind: syncjob.JobKindBackup, Lifecycle: syncjob.JobLifecycleReady,
		Source:   syncjob.EndpointRef{ConnectionID: "blocked-source", Database: file},
		Backup:   &syncjob.BackupSpec{Directory: t.TempDir(), Content: "both"},
		Mappings: []syncjob.TableMapping{{SourceTable: "t1", Enabled: true}},
	})

	done := make(chan DataSyncJobPreflightResult, 1)
	go func() {
		done <- application.preflightDataSyncJob(definition, time.Now())
	}()

	budget := dataSyncJobPreflightTimeoutFor(definition)
	select {
	case result := <-done:
		if result.Success {
			t.Fatal("preflight reported success while the driver never returned")
		}
	case <-time.After(budget + 10*time.Second):
		t.Fatalf("desktop preflight never returned within %s", budget)
	}
}
