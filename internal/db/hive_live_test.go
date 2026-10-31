//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func hiveLiveConfig(t *testing.T) connection.ConnectionConfig {
	t.Helper()
	host := os.Getenv("GONAVI_HIVE_LIVE_HOST")
	if host == "" {
		t.Skip("set GONAVI_HIVE_LIVE_HOST to run isolated Hive integration")
	}
	port := 10000
	if text := os.Getenv("GONAVI_HIVE_LIVE_PORT"); text != "" {
		var err error
		port, err = strconv.Atoi(text)
		if err != nil {
			t.Fatal(err)
		}
	}
	return connection.ConnectionConfig{Type: "hive", Host: host, Port: port, User: os.Getenv("GONAVI_HIVE_LIVE_USER"), Password: os.Getenv("GONAVI_HIVE_LIVE_PASSWORD"), Database: "default", Timeout: 30, QueryTimeout: 120, ConnectionParams: os.Getenv("GONAVI_HIVE_LIVE_PARAMS")}
}

func TestHiveLive(t *testing.T) {
	config := hiveLiveConfig(t)
	driver := &HiveDB{}
	if err := driver.Connect(config); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := driver.Close(); err != nil {
			t.Logf("close Hive: %v", err)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	database := fmt.Sprintf("gonavi_driver_%d", time.Now().UnixNano())
	quotedDB := hivesql.QuoteIdentifier(database)
	if _, err := driver.ExecContext(ctx, "CREATE DATABASE "+quotedDB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		session, err := driver.OpenSessionExecer(cleanup)
		if err != nil {
			t.Errorf("open cleanup session: %v", err)
			return
		}
		defer session.Close()
		if _, err = session.ExecContext(cleanup, "DROP DATABASE "+quotedDB+" CASCADE"); err != nil {
			t.Errorf("cleanup Hive database: %v", err)
		}
	})
	table := quotedDB + "." + hivesql.QuoteIdentifier("typed")
	ddl := "CREATE TABLE " + table + " (id BIGINT, note STRING COMMENT 'note comment', amount DECIMAL(38,4), payload BINARY, tags ARRAY<STRING>) PARTITIONED BY (part STRING COMMENT 'partition comment') STORED AS ORC TBLPROPERTIES ('comment'='table comment')"
	if _, err := driver.ExecContext(ctx, ddl); err != nil {
		t.Fatal(err)
	}
	if _, err := driver.ExecContext(ctx, "CREATE VIEW "+quotedDB+".v AS SELECT id FROM "+table); err != nil {
		t.Fatal(err)
	}
	tables, err := driver.GetTables(database)
	if err != nil || len(tables) != 1 || tables[0] != "typed" {
		t.Fatalf("tables=%v error=%v", tables, err)
	}
	views, err := driver.HiveViews(ctx, database)
	if err != nil || len(views) != 1 || views[0] != "v" {
		t.Fatalf("views=%v error=%v", views, err)
	}
	columns, err := driver.GetColumnsContext(ctx, database, "typed")
	if err != nil || len(columns) != 6 {
		t.Fatalf("columns=%v error=%v", columns, err)
	}
	if columns[5].Extra != "partition" || columns[1].Comment != "note comment" {
		t.Fatalf("column annotations=%v", columns)
	}
	statement, err := driver.GetCreateStatement(database, "typed")
	if err != nil || !strings.Contains(strings.ToUpper(statement), "PARTITIONED BY") {
		t.Fatalf("DDL=%s error=%v", statement, err)
	}
	caps, err := driver.HiveTableWriteCapabilities(ctx, table)
	if err != nil || !caps.Insert || caps.Update || caps.AtomicBatch || len(caps.PartitionColumns) != 1 {
		t.Fatalf("capabilities=%+v error=%v", caps, err)
	}
	amount := "123456789012345678901234567890.1234"
	changes := connection.ChangeSet{Inserts: []map[string]interface{}{{"id": json.Number("9223372036854775807"), "note": "a'\\line\nnext", "amount": amount, "payload": []byte{0, 255}, "tags": "[\"x\",null]", "part": "p1"}}}
	if err := driver.ApplyChangesContext(ctx, table, changes); err != nil {
		t.Fatal(err)
	}
	rows, fields, err := driver.QueryContext(ctx, "SELECT * FROM "+table)
	if err != nil || len(rows) != 1 {
		t.Fatalf("query rows=%v fields=%v error=%v", rows, fields, err)
	}
	row := rows[0]
	if fmt.Sprint(row[fields[0]]) != "9223372036854775807" || fmt.Sprint(row[fields[2]]) != amount || row[fields[3]] != "0x00ff" {
		t.Fatalf("precision/binary lost: %v", row)
	}
	consumer := &hiveLiveConsumer{}
	if err := driver.StreamQueryContext(ctx, "SELECT * FROM "+table, consumer); err != nil {
		t.Fatal(err)
	}
	if consumer.rows != 1 || len(consumer.definitions) != 6 {
		t.Fatalf("stream rows=%d defs=%v", consumer.rows, consumer.definitions)
	}
	acid := quotedDB + ".acid"
	if _, err := driver.ExecContext(ctx, "CREATE TABLE "+acid+" (id INT, note STRING) STORED AS ORC TBLPROPERTIES ('transactional'='true')"); err != nil {
		t.Fatal(err)
	}
	acidCaps, err := driver.HiveTableWriteCapabilities(ctx, acid)
	if err != nil || !acidCaps.Update || !acidCaps.Delete || acidCaps.AtomicBatch {
		t.Fatalf("ACID capabilities=%+v err=%v", acidCaps, err)
	}
	if err := driver.ApplyChangesContext(ctx, acid, connection.ChangeSet{Inserts: []map[string]interface{}{{"id": 1, "note": "before"}}}); err != nil {
		t.Fatal(err)
	}
	if err := driver.ApplyChangesContext(ctx, acid, connection.ChangeSet{Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": 1}, Values: map[string]interface{}{"note": "after"}}}}); err != nil {
		t.Fatal(err)
	}
	if err := driver.ApplyChangesContext(ctx, acid, connection.ChangeSet{Deletes: []map[string]interface{}{{"id": 1}}}); err != nil {
		t.Fatal(err)
	}
	cancelCtx, cancelQuery := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancelQuery()
	_, _, err = driver.QueryContext(cancelCtx, "SELECT count(*) FROM "+table+" a CROSS JOIN "+table+" b")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("query cancellation=%v", err)
	}
}

type hiveLiveConsumer struct {
	rows        int
	definitions []connection.ColumnDefinition
}

func (c *hiveLiveConsumer) SetColumns([]string) error { return nil }
func (c *hiveLiveConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	c.definitions = columns
	return nil
}
func (c *hiveLiveConsumer) ConsumeRow(map[string]interface{}) error { c.rows++; return nil }
