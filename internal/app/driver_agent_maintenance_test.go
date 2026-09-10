package app

import (
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestBeginOptionalDriverReplacementReleasesOnlyMatchingDriverResources(t *testing.T) {
	application := NewApp()
	sqlserverMain := &releaseRecordingDB{}
	sqlserverCatalog := &releaseRecordingDB{}
	clickhouse := &releaseRecordingDB{}

	mainConfig := connection.ConnectionConfig{Type: "sqlserver", Host: "db.local", Port: 1433, Database: "main"}
	catalogConfig := mainConfig
	catalogConfig.Database = "catalog"
	clickhouseConfig := connection.ConnectionConfig{Type: "clickhouse", Host: "analytics.local", Port: 9000}
	application.dbCache[getCacheKey(mainConfig)] = cachedDatabase{inst: sqlserverMain, config: mainConfig}
	application.dbCache[getCacheKey(catalogConfig)] = cachedDatabase{inst: sqlserverCatalog, config: catalogConfig}
	application.dbCache[getCacheKey(clickhouseConfig)] = cachedDatabase{inst: clickhouse, config: clickhouseConfig}

	sqlserverTx := &fakeManagedTransactionFinisher{}
	clickhouseTx := &fakeManagedTransactionFinisher{}
	application.sqlTransactions["tx-sqlserver"] = &managedSQLTransaction{
		id:         "tx-sqlserver",
		execer:     sqlserverTx,
		transactor: sqlserverTx,
		config:     mainConfig,
		dbType:     "sqlserver",
	}
	application.sqlTransactions["tx-clickhouse"] = &managedSQLTransaction{
		id:         "tx-clickhouse",
		execer:     clickhouseTx,
		transactor: clickhouseTx,
		config:     clickhouseConfig,
		dbType:     "clickhouse",
	}

	counts := application.activeConnectionDriverUsageCounts()
	if counts["sqlserver"] != 2 || counts["clickhouse"] != 1 {
		t.Fatalf("active driver counts = %#v, want sqlserver=2 clickhouse=1", counts)
	}

	closed, finish, err := application.beginOptionalDriverReplacement("sqlserver", nil)
	if err != nil {
		t.Fatalf("beginOptionalDriverReplacement returned error: %v", err)
	}
	if closed != 2 {
		t.Fatalf("closed connections = %d, want 2", closed)
	}
	if !application.driverMaintenanceActive("sqlserver") {
		t.Fatal("SQL Server maintenance boundary ended before activation")
	}
	if sqlserverMain.closed != 1 || sqlserverCatalog.closed != 1 {
		t.Fatalf("SQL Server agents were not closed: main=%d catalog=%d", sqlserverMain.closed, sqlserverCatalog.closed)
	}
	if clickhouse.closed != 0 {
		t.Fatalf("unrelated ClickHouse connection was closed %d times", clickhouse.closed)
	}
	if sqlserverTx.rollbackCalls != 1 || sqlserverTx.closeCalls != 1 {
		t.Fatalf("SQL Server transaction was not rolled back and closed: rollback=%d close=%d", sqlserverTx.rollbackCalls, sqlserverTx.closeCalls)
	}
	if clickhouseTx.rollbackCalls != 0 || clickhouseTx.closeCalls != 0 {
		t.Fatalf("unrelated ClickHouse transaction was changed: rollback=%d close=%d", clickhouseTx.rollbackCalls, clickhouseTx.closeCalls)
	}
	if len(application.dbCache) != 1 {
		t.Fatalf("cache entries after maintenance = %d, want one unrelated entry", len(application.dbCache))
	}
	if len(application.sqlTransactions) != 1 {
		t.Fatalf("transactions after maintenance = %d, want one unrelated transaction", len(application.sqlTransactions))
	}

	finish()
	if application.driverMaintenanceActive("sqlserver") {
		t.Fatal("SQL Server maintenance boundary remained active after activation")
	}
}

func TestDriverMaintenanceRejectsNewMatchingConnectionFlight(t *testing.T) {
	application := NewApp()
	application.driverMaintenance["sqlserver"] = 1

	if _, err := application.beginDatabaseConnectFlight("sqlserver-key", connection.ConnectionConfig{Type: "sqlserver"}); err == nil {
		t.Fatal("SQL Server connection flight started during driver replacement")
	}
	flight, err := application.beginDatabaseConnectFlight("clickhouse-key", connection.ConnectionConfig{Type: "clickhouse"})
	if err != nil {
		t.Fatalf("unrelated ClickHouse connection flight was rejected: %v", err)
	}
	application.finishDatabaseConnectFlight(flight)
}

func TestBeginOptionalDriverReplacementCancelsOnlyMatchingDriverQueries(t *testing.T) {
	application := NewApp()
	sqlserverCanceled := 0
	clickhouseCanceled := 0
	cleanupSQLServer := application.registerRunningQuery("sqlserver-query", func() {
		sqlserverCanceled++
	}, true, "sqlserver")
	defer cleanupSQLServer()
	cleanupClickHouse := application.registerRunningQuery("clickhouse-query", func() {
		clickhouseCanceled++
	}, true, "clickhouse")
	defer cleanupClickHouse()

	_, finish, err := application.beginOptionalDriverReplacement("sqlserver", nil)
	if err != nil {
		t.Fatalf("beginOptionalDriverReplacement returned error: %v", err)
	}
	defer finish()

	if sqlserverCanceled != 1 {
		t.Fatalf("SQL Server query cancellations = %d, want 1", sqlserverCanceled)
	}
	if clickhouseCanceled != 0 {
		t.Fatalf("unrelated ClickHouse query cancellations = %d, want 0", clickhouseCanceled)
	}
}

func TestBeginOptionalDriverReplacementClosesOrphanedDriverAgentProcess(t *testing.T) {
	originalFind := updateFindOtherWindowsInstances
	originalClose := updateCloseWindowsInstances
	t.Cleanup(func() {
		updateFindOtherWindowsInstances = originalFind
		updateCloseWindowsInstances = originalClose
	})

	targets := []string{
		`D:\GoNaviData\drivers\sqlserver\sqlserver-driver-agent.exe`,
		`D:\GoNaviData\drivers\sqlserver\v1.9.6\sqlserver-driver-agent.exe`,
	}
	findCalls := 0
	updateFindOtherWindowsInstances = func(actualTargets []string, currentPID int) ([]windowsUpdateProcess, error) {
		if !reflect.DeepEqual(actualTargets, targets) {
			t.Fatalf("driver process targets = %#v, want %#v", actualTargets, targets)
		}
		if currentPID <= 0 {
			t.Fatalf("current process ID = %d, want positive", currentPID)
		}
		findCalls++
		if findCalls == 1 {
			return []windowsUpdateProcess{{PID: 4242, Executable: targets[0]}}, nil
		}
		return nil, nil
	}
	var closed []windowsUpdateProcess
	updateCloseWindowsInstances = func(processes []windowsUpdateProcess) error {
		closed = append(closed, processes...)
		return nil
	}

	application := NewApp()
	_, finish, err := application.beginOptionalDriverReplacement("sqlserver", targets)
	if err != nil {
		t.Fatalf("beginOptionalDriverReplacement returned error: %v", err)
	}
	defer finish()

	if findCalls != 2 {
		t.Fatalf("driver process scans = %d, want 2", findCalls)
	}
	if len(closed) != 1 || closed[0].PID != 4242 {
		t.Fatalf("closed driver processes = %#v, want PID 4242", closed)
	}
}
