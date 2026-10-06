//go:build gonavi_lockwait_live

package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	_ "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
	_ "github.com/microsoft/go-mssqldb"
)

// The lock-wait live tests stage a real blocking chain on a scratch server:
//
//	holder  BEGIN; UPDATE row 1; (then sits idle, transaction open)
//	writer  UPDATE row 1          -> waits for the holder's row lock
//	ddl     ALTER TABLE ...       -> waits behind both on the table lock
//
// and assert that the inspector reports who waits for whom. Addresses come
// from GONAVI_LOCKWAIT_MYSQL_ADDRS / GONAVI_LOCKWAIT_POSTGRES_ADDRS, the
// password from GONAVI_LOCKWAIT_PASSWORD (user root / postgres).

type lockWaitStage struct {
	holder *sql.Conn
	cancel context.CancelFunc
	done   chan error
}

func stageLockWaitChain(t *testing.T, pool *sql.DB, setup []string, hold string, waiters []string) *lockWaitStage {
	return stageLockWaitChainWith(t, pool, "BEGIN", setup, hold, waiters)
}

func stageLockWaitChainWith(t *testing.T, pool *sql.DB, begin string, setup []string, hold string, waiters []string) *lockWaitStage {
	t.Helper()
	ctx := context.Background()
	for _, statement := range setup {
		if _, err := pool.ExecContext(ctx, statement); err != nil {
			t.Fatalf("setup %q: %v", statement, err)
		}
	}
	holder, err := pool.Conn(ctx)
	if err != nil {
		t.Fatalf("holder conn: %v", err)
	}
	for _, statement := range []string{begin, hold} {
		if _, err := holder.ExecContext(ctx, statement); err != nil {
			t.Fatalf("holder %q: %v", statement, err)
		}
	}
	waitCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
	done := make(chan error, len(waiters))
	for _, statement := range waiters {
		statement := statement
		conn, err := pool.Conn(ctx)
		if err != nil {
			t.Fatalf("waiter conn: %v", err)
		}
		go func() {
			defer conn.Close()
			_, err := conn.ExecContext(waitCtx, statement)
			done <- err
		}()
		// Queue the waiters in a stable order.
		time.Sleep(400 * time.Millisecond)
	}
	time.Sleep(time.Second)
	return &lockWaitStage{holder: holder, cancel: cancel, done: done}
}

func (s *lockWaitStage) release(t *testing.T, waiters int) {
	t.Helper()
	_, _ = s.holder.ExecContext(context.Background(), "ROLLBACK")
	_ = s.holder.Close()
	for i := 0; i < waiters; i++ {
		select {
		case err := <-s.done:
			if err != nil {
				t.Logf("waiter finished with: %v", err)
			}
		case <-time.After(45 * time.Second):
			t.Log("a waiter did not finish after the holder rolled back")
		}
	}
	s.cancel()
}

func logLockWaits(t *testing.T, waits []connection.DatabaseLockWait) {
	t.Helper()
	for _, wait := range waits {
		t.Logf("%s waits %s for %s on %s (%s/%s held %s) waited=%dms holder[%s] %q open=%dms",
			wait.WaitingSessionID, wait.BlockingSessionID, wait.LockType, wait.ObjectName, wait.LockMode,
			wait.IndexName, wait.BlockingLockMode, wait.WaitDurationMs, wait.BlockingState,
			wait.BlockingStatement, wait.BlockingDurationMs)
	}
}

// assertLongTransactionLive checks that the staged idle holder is listed as an
// open transaction with its age and the statement that took the lock.
func assertLongTransactionLive(t *testing.T, client Database, config connection.ConnectionConfig, heldMarker string) {
	t.Helper()
	payload, err := NewLongTransactionInspector(client, config).ListLongTransactions(context.Background())
	if err != nil {
		t.Fatalf("ListLongTransactions: %v", err)
	}
	for _, trx := range payload.Transactions {
		t.Logf("open transaction: session %s %s/%s age=%dms %q", trx.SessionID, trx.User, trx.State, trx.DurationMs, trx.Statement)
	}
	for _, trx := range payload.Transactions {
		if strings.Contains(trx.Statement, heldMarker) && trx.DurationMs >= 500 {
			return
		}
	}
	t.Fatalf("the idle holder is missing from the open transactions: %+v", payload.Transactions)
}

func findLockWait(waits []connection.DatabaseLockWait, match func(connection.DatabaseLockWait) bool) bool {
	for _, wait := range waits {
		if match(wait) {
			return true
		}
	}
	return false
}

func TestLockWaitsLiveMySQL(t *testing.T) {
	runMySQLFamilyLockWaitsLive(t, "GONAVI_LOCKWAIT_MYSQL_ADDRS", mysqlLockWaitSpec(), true)
}

// MariaDB ships with performance_schema off, so neither metadata-lock waits
// nor an idle holder's last statement are available there.
func TestLockWaitsLiveMariaDB(t *testing.T) {
	runMySQLFamilyLockWaitsLive(t, "GONAVI_LOCKWAIT_MARIADB_ADDRS", mariaDBLockWaitSpec(), false)
}

func runMySQLFamilyLockWaitsLive(t *testing.T, env string, spec lockWaitSpec, performanceSchema bool) {
	password := os.Getenv("GONAVI_LOCKWAIT_PASSWORD")
	for _, addr := range liveAddrs(t, env) {
		t.Run(addr, func(t *testing.T) {
			pool, err := sql.Open("mysql", fmt.Sprintf("root:%s@tcp(%s)/?timeout=10s", password, addr))
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			stage := stageLockWaitChain(t, pool,
				[]string{
					"DROP DATABASE IF EXISTS gonavi_lockwait",
					"CREATE DATABASE gonavi_lockwait",
					"CREATE TABLE gonavi_lockwait.orders (id INT PRIMARY KEY, status VARCHAR(20))",
					"INSERT INTO gonavi_lockwait.orders VALUES (1, 'new'), (2, 'new')",
				},
				"UPDATE gonavi_lockwait.orders SET status = 'held' WHERE id = 1",
				[]string{
					"UPDATE gonavi_lockwait.orders SET status = 'waiting' WHERE id = 1",
					"ALTER TABLE gonavi_lockwait.orders ADD COLUMN note INT",
				},
			)
			defer pool.ExecContext(context.Background(), "DROP DATABASE IF EXISTS gonavi_lockwait")
			defer stage.release(t, 2)

			config := liveConfig(t, "mysql", addr, "root", "")
			config.Password = password
			client := &MySQLDB{}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			inspector := &databaseLockWaitInspector{database: client, config: config, spec: spec}
			payload, err := inspector.ListLockWaits(context.Background())
			if err != nil {
				t.Fatalf("ListLockWaits: %v", err)
			}
			logLockWaits(t, payload.Waits)

			if !findLockWait(payload.Waits, func(wait connection.DatabaseLockWait) bool {
				return wait.LockType == "RECORD" && wait.ObjectName == "gonavi_lockwait.orders" &&
					strings.Contains(wait.WaitingStatement, "'waiting'") &&
					// The holder is idle; its last statement still identifies it.
					(!performanceSchema || strings.Contains(wait.BlockingStatement, "'held'")) && wait.BlockingState == "Sleep"
			}) {
				t.Fatal("missing the row-lock edge from the writer to the idle holder")
			}
			if performanceSchema && !findLockWait(payload.Waits, func(wait connection.DatabaseLockWait) bool {
				return wait.LockType == "METADATA" && strings.HasPrefix(wait.WaitingStatement, "ALTER TABLE") &&
					strings.Contains(wait.BlockingStatement, "'held'")
			}) {
				t.Fatal("missing the metadata-lock edge from ALTER TABLE to the holder")
			}
			if performanceSchema {
				assertLongTransactionLive(t, client, config, "'held'")
			} else {
				// Without performance_schema an idle holder has no statement to show.
				assertLongTransactionLive(t, client, config, "")
			}
		})
	}
}

func TestLockWaitsLivePostgres(t *testing.T) {
	password := os.Getenv("GONAVI_LOCKWAIT_PASSWORD")
	for _, addr := range liveAddrs(t, "GONAVI_LOCKWAIT_POSTGRES_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			host, port, _ := strings.Cut(addr, ":")
			pool, err := sql.Open("postgres", fmt.Sprintf("host=%s port=%s user=postgres password=%s dbname=postgres sslmode=disable", host, port, password))
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			stage := stageLockWaitChain(t, pool,
				[]string{
					"DROP TABLE IF EXISTS gonavi_lockwait_orders",
					"CREATE TABLE gonavi_lockwait_orders (id INT PRIMARY KEY, status VARCHAR(20))",
					"INSERT INTO gonavi_lockwait_orders VALUES (1, 'new'), (2, 'new')",
				},
				"UPDATE gonavi_lockwait_orders SET status = 'held' WHERE id = 1",
				[]string{
					"UPDATE gonavi_lockwait_orders SET status = 'waiting' WHERE id = 1",
					"ALTER TABLE gonavi_lockwait_orders ADD COLUMN note INT",
				},
			)
			defer pool.ExecContext(context.Background(), "DROP TABLE IF EXISTS gonavi_lockwait_orders")
			defer stage.release(t, 2)

			config := liveConfig(t, "postgres", addr, "postgres", "postgres")
			config.Password = password
			client := &PostgresDB{}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()

			for _, variant := range []struct {
				name string
				spec lockWaitSpec
			}{
				{name: "pg_blocking_pids", spec: postgresLockWaitSpec("postgres")},
				{name: "lock tag (openGauss lineage)", spec: openGaussLockWaitSpec("opengauss")},
			} {
				t.Run(variant.name, func(t *testing.T) {
					inspector := &databaseLockWaitInspector{database: client, config: config, spec: variant.spec}
					payload, err := inspector.ListLockWaits(context.Background())
					if err != nil {
						t.Fatalf("ListLockWaits: %v", err)
					}
					logLockWaits(t, payload.Waits)
					if !findLockWait(payload.Waits, func(wait connection.DatabaseLockWait) bool {
						return wait.LockType == "transactionid" && wait.ObjectName == "gonavi_lockwait_orders" &&
							strings.Contains(wait.WaitingStatement, "'waiting'") &&
							strings.Contains(wait.BlockingStatement, "'held'") && wait.BlockingState == "idle in transaction"
					}) {
						t.Fatal("missing the row-lock edge from the writer to the idle holder")
					}
					if !findLockWait(payload.Waits, func(wait connection.DatabaseLockWait) bool {
						return wait.LockType == "relation" && wait.ObjectName == "gonavi_lockwait_orders" &&
							wait.LockMode == "AccessExclusiveLock" && strings.Contains(wait.BlockingStatement, "'held'")
					}) {
						t.Fatal("missing the relation-lock edge from ALTER TABLE to the holder")
					}
				})
			}
			assertLongTransactionLive(t, client, config, "'held'")
		})
	}
}

func TestLockWaitsLiveSQLServer(t *testing.T) {
	password := os.Getenv("GONAVI_LOCKWAIT_MSSQL_PASSWORD")
	for _, addr := range liveAddrs(t, "GONAVI_LOCKWAIT_MSSQL_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			pool, err := sql.Open("sqlserver", fmt.Sprintf("sqlserver://sa:%s@%s?database=master", password, addr))
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			stage := stageLockWaitChainWith(t, pool, "BEGIN TRANSACTION",
				[]string{
					"IF OBJECT_ID('dbo.gonavi_lockwait_orders') IS NOT NULL DROP TABLE dbo.gonavi_lockwait_orders",
					"CREATE TABLE dbo.gonavi_lockwait_orders (id INT PRIMARY KEY, status VARCHAR(20))",
					"INSERT INTO dbo.gonavi_lockwait_orders VALUES (1, 'new'), (2, 'new')",
				},
				"UPDATE dbo.gonavi_lockwait_orders SET status = 'held' WHERE id = 1",
				[]string{
					"UPDATE dbo.gonavi_lockwait_orders SET status = 'waiting' WHERE id = 1",
					"ALTER TABLE dbo.gonavi_lockwait_orders ADD note INT",
				},
			)
			defer pool.ExecContext(context.Background(), "IF OBJECT_ID('dbo.gonavi_lockwait_orders') IS NOT NULL DROP TABLE dbo.gonavi_lockwait_orders")
			defer stage.release(t, 2)

			config := liveConfig(t, "sqlserver", addr, "sa", "master")
			config.Password = password
			client, err := NewDatabase("sqlserver")
			if err != nil {
				t.Fatal(err)
			}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			payload, err := NewLockWaitInspector(client, config).ListLockWaits(context.Background())
			if err != nil {
				t.Fatalf("ListLockWaits: %v", err)
			}
			logLockWaits(t, payload.Waits)
			if !findLockWait(payload.Waits, func(wait connection.DatabaseLockWait) bool {
				return wait.LockType == "KEY" && wait.ObjectName == "dbo.gonavi_lockwait_orders" && wait.LockMode == "X" &&
					// The running request shows its auto-parameterized text.
					strings.Contains(wait.WaitingStatement, "UPDATE") &&
					strings.Contains(wait.BlockingStatement, "'held'") && wait.BlockingState == "sleeping"
			}) {
				t.Fatal("missing the key-lock edge from the writer to the idle holder")
			}
			if !findLockWait(payload.Waits, func(wait connection.DatabaseLockWait) bool {
				return wait.LockType == "OBJECT" && wait.ObjectName == "dbo.gonavi_lockwait_orders" &&
					strings.HasPrefix(wait.WaitingStatement, "ALTER TABLE")
			}) {
				t.Fatal("missing the object-lock edge from ALTER TABLE")
			}
			assertLongTransactionLive(t, client, config, "'held'")
		})
	}
}
