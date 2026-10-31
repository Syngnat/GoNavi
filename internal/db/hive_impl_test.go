//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
	"github.com/apache/thrift/lib/go/thrift"
	hs "github.com/beltran/gohive/hiveserver"
)

func TestHiveBinaryQueryMetadataAndCleanup(t *testing.T) {
	for _, sasl := range []bool{false, true} {
		name := "NOSASL"
		if sasl {
			name = "PLAIN"
		}
		t.Run(name, func(t *testing.T) {
			service := newHiveFakeService()
			config := hiveFakeBinary(t, service, sasl)
			driver := &HiveDB{}
			if err := driver.Connect(config); err != nil {
				t.Fatal(err)
			}
			rows, fields, err := driver.QueryContext(context.Background(), "SELECT typed")
			if err != nil || len(rows) != 3 {
				t.Fatalf("rows=%v fields=%v err=%v", rows, fields, err)
			}
			if rows[0]["id"] != "9223372036854775807" || rows[0]["decimal"] != "12345678901234567890.001" || rows[0]["binary"] != "0x00ff" || rows[1]["decimal"] != nil {
				t.Fatalf("normalization=%v", rows)
			}
			budget := NewRowBudget(1)
			rows, _, err = driver.QueryContext(ContextWithRowBudget(context.Background(), budget), "SELECT budget")
			if err != nil || len(rows) != 1 || !budget.Truncated() {
				t.Fatalf("budget rows=%v truncated=%v err=%v", rows, budget.Truncated(), err)
			}
			databases, err := driver.GetDatabases()
			if err != nil || strings.Join(databases, ",") != "analytics,default" {
				t.Fatalf("databases=%v err=%v", databases, err)
			}
			tables, err := driver.GetTables("default")
			if err != nil || strings.Join(tables, ",") != "base" {
				t.Fatalf("tables=%v err=%v", tables, err)
			}
			views, err := driver.HiveViews(context.Background(), "default")
			if err != nil || strings.Join(views, ",") != "view" {
				t.Fatalf("views=%v err=%v", views, err)
			}
			columns, err := driver.GetColumns("default", "base")
			if err != nil || len(columns) != 2 || columns[1].Extra != "partition" {
				t.Fatalf("columns=%v err=%v", columns, err)
			}
			ddl, err := driver.GetCreateStatement("default", "base")
			if err != nil || !strings.Contains(ddl, "\nPARTITIONED BY") {
				t.Fatalf("DDL=%q err=%v", ddl, err)
			}
			caps, err := driver.HiveTableWriteCapabilities(context.Background(), "base")
			if err != nil || !caps.Update || !caps.Delete || caps.AtomicBatch {
				t.Fatalf("caps=%+v err=%v", caps, err)
			}
			consumer := &hiveLiveConsumer{}
			if err := driver.StreamQueryContext(context.Background(), "SELECT typed", consumer); err != nil || consumer.rows != 3 || len(consumer.definitions) != 3 {
				t.Fatalf("stream=%+v err=%v", consumer, err)
			}
			session, err := driver.OpenSessionExecer(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if _, err = session.Exec("SET test.flag=yes"); err != nil {
				t.Fatal(err)
			}
			if err = session.Close(); err != nil {
				t.Fatal(err)
			}
			if err = driver.Close(); err != nil {
				t.Fatal(err)
			}
			service.mu.Lock()
			defer service.mu.Unlock()
			if service.opened != service.closed || len(service.operations) != 0 {
				t.Fatalf("resource leak sessions=%d/%d ops=%d", service.opened, service.closed, len(service.operations))
			}
		})
	}
}

func TestHiveHTTPAndTLS(t *testing.T) {
	for _, tlsMode := range []bool{false, true} {
		name := "HTTP"
		if tlsMode {
			name = "HTTPS"
		}
		t.Run(name, func(t *testing.T) {
			service := newHiveFakeService()
			server := hiveFakeHTTP(t, service, tlsMode)
			config := connection.ConnectionConfig{Type: "hive", URI: server.URL + "/cliservice?authMode=NONE&fetchSize=2", User: "test", Timeout: 2}
			if tlsMode {
				path := filepath.Join(t.TempDir(), "ca.pem")
				certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.TLS.Certificates[0].Certificate[0]})
				if err := os.WriteFile(path, certificate, 0600); err != nil {
					t.Fatal(err)
				}
				config.SSLCAPath = path
				config.SSLMode = "required"
			}
			driver := &HiveDB{}
			if err := driver.Connect(config); err != nil {
				t.Fatal(err)
			}
			defer driver.Close()
			rows, _, err := driver.QueryContext(context.Background(), "SELECT typed")
			if err != nil || len(rows) != 3 {
				t.Fatalf("rows=%v err=%v", rows, err)
			}
		})
	}
}

func TestHiveCancellationKeepsSessionReusable(t *testing.T) {
	service := newHiveFakeService()
	config := hiveFakeBinary(t, service, true)
	driver := &HiveDB{}
	if err := driver.Connect(config); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, _, err := driver.QueryContext(ctx, "SELECT blocked")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
		t.Fatalf("cancel=%v duration=%s", err, time.Since(started))
	}
	service.mu.Lock()
	canceled := service.canceled
	service.mu.Unlock()
	if canceled != 1 {
		t.Fatalf("CancelOperation count=%d", canceled)
	}
	rows, _, err := driver.QueryContext(context.Background(), "SELECT reused")
	if err != nil || len(rows) != 3 {
		t.Fatalf("reuse rows=%v err=%v", rows, err)
	}
}

func TestHiveFailedOpenDoesNotPanicOrLeak(t *testing.T) {
	service := newHiveFakeService()
	service.rejectOpen = true
	config := hiveFakeBinary(t, service, false)
	driver := &HiveDB{}
	if err := driver.Connect(config); err == nil {
		t.Fatal("rejected authentication accepted")
	}
	if err := driver.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestHiveWriteCapabilityFamilies(t *testing.T) {
	cases := []struct {
		name, family        string
		details, properties map[string]string
		update, insert      bool
	}{
		{name: "ordinary", family: "hive", details: map[string]string{"table type": "MANAGED_TABLE", "inputformat": "text"}, insert: true},
		{name: "full acid", family: "hive", details: map[string]string{"table type": "MANAGED_TABLE", "inputformat": "OrcInputFormat"}, properties: map[string]string{"transactional": "true"}, update: true, insert: true},
		{name: "insert only", family: "hive", details: map[string]string{"table type": "MANAGED_TABLE", "inputformat": "OrcInputFormat"}, properties: map[string]string{"transactional": "true", "transactional_properties": "insert_only"}, insert: true},
		{name: "spark not hive acid", family: "spark", details: map[string]string{"table type": "MANAGED_TABLE", "inputformat": "OrcInputFormat"}, properties: map[string]string{"transactional": "true"}},
		{name: "impala kudu", family: "impala", details: map[string]string{"table type": "EXTERNAL_TABLE"}, properties: map[string]string{"storage_handler": "KuduStorageHandler"}, update: true, insert: true},
		{name: "impala parquet", family: "impala", details: map[string]string{"table type": "MANAGED_TABLE", "inputformat": "parquet"}, insert: true},
		{name: "view", family: "hive", details: map[string]string{"table type": "VIRTUAL_VIEW"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := hiveDeriveWriteCapabilities(test.family, test.details, test.properties, nil)
			if got.Update != test.update || got.Delete != test.update || got.Insert != test.insert || got.AtomicBatch {
				t.Fatalf("capability=%+v", got)
			}
		})
	}
}

func TestHiveWritePlanningPrevalidatesAndPreservesPartitions(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "BIGINT", Nullable: "YES"}, {Name: "tags", Type: "ARRAY<STRING>", Nullable: "YES"}, {Name: "p", Type: "STRING", Extra: "partition", Nullable: "YES"}}
	caps := HiveTableWriteCapabilities{Insert: true, PartitionColumns: []string{"p"}}
	changes := connection.ChangeSet{Inserts: []map[string]interface{}{{"id": int64(1), "tags": "[\"x\"]", "p": "2026"}, {"id": int64(2), "tags": "[]", "p": "2026"}}}
	statements, err := hivePlanChanges(hivesql.QuoteTable("d.t"), columns, caps, changes)
	if err != nil || len(statements) != 1 || !strings.Contains(statements[0], "PARTITION (") || !strings.Contains(statements[0], " UNION ALL SELECT ") {
		t.Fatalf("statements=%v err=%v", statements, err)
	}
	changes.Inserts[1]["id"] = "1;DELETE"
	if statements, err := hivePlanChanges("t", columns, caps, changes); err == nil || statements != nil {
		t.Fatalf("bad batch accepted=%v err=%v", statements, err)
	}
	if _, err := hiveMutationPredicate(hiveColumnsByName(columns), nil); err == nil {
		t.Fatal("unbounded delete accepted")
	}
}

type hiveLostReplyAPI struct {
	hs.TCLIService
	loseExecute bool
	loseClose   bool
}

func (a *hiveLostReplyAPI) ExecuteStatement(ctx context.Context, req *hs.TExecuteStatementReq) (*hs.TExecuteStatementResp, error) {
	response, err := a.TCLIService.ExecuteStatement(ctx, req)
	if err == nil && a.loseExecute {
		return nil, thrift.NewTTransportException(thrift.END_OF_FILE, "simulated lost ExecuteStatement response")
	}
	return response, err
}
func (a *hiveLostReplyAPI) CloseOperation(ctx context.Context, req *hs.TCloseOperationReq) (*hs.TCloseOperationResp, error) {
	response, err := a.TCLIService.CloseOperation(ctx, req)
	if err == nil && a.loseClose {
		return nil, thrift.NewTTransportException(thrift.END_OF_FILE, "simulated lost CloseOperation response")
	}
	return response, err
}
func TestHiveLostWriteRepliesAreNeverRetried(t *testing.T) {
	for _, loseExecute := range []bool{true, false} {
		name := "CloseOperation"
		if loseExecute {
			name = "ExecuteStatement"
		}
		t.Run(name, func(t *testing.T) {
			service := newHiveFakeService()
			driver := &HiveDB{}
			config := hiveFakeBinary(t, service, false)
			if err := driver.Connect(config); err != nil {
				t.Fatal(err)
			}
			defer driver.Close()
			session, err := driver.session(false)
			if err != nil {
				t.Fatal(err)
			}
			if err = session.run(context.Background(), func(context.Context) error {
				session.wire.api = &hiveLostReplyAPI{TCLIService: session.wire.api, loseExecute: loseExecute, loseClose: !loseExecute}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			_, err = driver.ExecContext(context.Background(), "INSERT INTO t SELECT 1")
			if !IsWriteOutcomeUnknown(err) {
				t.Fatalf("lost response must be no-retry: %T %v", err, err)
			}
			service.mu.Lock()
			count := 0
			for _, statement := range service.statements {
				if statement == "INSERT INTO t SELECT 1" {
					count++
				}
			}
			service.mu.Unlock()
			if count != 1 {
				t.Fatalf("write dispatched %d times", count)
			}
		})
	}
}
