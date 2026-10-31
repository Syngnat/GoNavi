//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"GoNavi-Wails/internal/hivesql"
)

func TestHiveLiveTemporarySourceMetadata(t *testing.T) {
	if os.Getenv("GONAVI_HIVE_METADATA_PROBE") == "" {
		t.Skip("set GONAVI_HIVE_METADATA_PROBE for no-MR owning-session metadata test")
	}
	cfg := hiveLiveConfig(t)
	driver := &HiveDB{}
	if err := driver.Connect(cfg); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	name := fmt.Sprintf("gonavi_temp_source_%d", time.Now().UnixNano())
	quoted := hivesql.QuoteIdentifier(name)
	if _, err := driver.ExecContext(ctx, "CREATE TABLE "+quoted+" (id INT, payload MAP<STRING,BINARY>) STORED AS ORC"); err != nil {
		t.Fatal(err)
	}
	defer driver.Exec("DROP TABLE " + quoted)
	pinned, err := driver.OpenSessionExecer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Close()
	if _, err := pinned.ExecContext(ctx, "CREATE TEMPORARY TABLE "+quoted+" (id INT, payload ARRAY<STRING>) STORED AS ORC"); err != nil {
		t.Fatal(err)
	}
	stream, ok := pinned.(StreamQueryExecer)
	if !ok {
		t.Fatal("pinned streaming missing")
	}
	consumer := &hiveSourceTypedConsumer{}
	query := "SELECT * FROM (SELECT id,payload FROM " + quoted + ") AS source_probe LIMIT 0"
	if err = stream.StreamQueryContext(ctx, query, consumer); err != nil {
		t.Fatal(err)
	}
	if len(consumer.columns) != 2 || consumer.columns[1].Type != "array<string>" || consumer.rows != 0 {
		t.Fatalf("temporary source type provenance=%+v rows=%d", consumer.columns, consumer.rows)
	}
	background, err := driver.GetColumns("default", name)
	if err != nil || len(background) != 2 || background[1].Type != "map<string,binary>" {
		t.Fatalf("background catalog did not remain isolated: %+v %v", background, err)
	}
}
