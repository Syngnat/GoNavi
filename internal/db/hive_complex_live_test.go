//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestHiveLiveComplexWire locks down Hive's irreversible SerDe boundary: raw
// nested BINARY display cannot be repaired or silently called a successful read.
func TestHiveLiveComplexWire(t *testing.T) {
	cfg := hiveLiveConfig(t)
	driver := &HiveDB{}
	if err := driver.Connect(cfg); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	for _, query := range []string{"SELECT map('bytes',unhex('00ff')) AS mapping", "SELECT named_struct('payload',unhex('00222c7dff')) AS record", "SELECT array(unhex('00225dff')) AS items"} {
		rows, _, err := driver.QueryContext(ctx, query)
		if err == nil || !strings.Contains(err.Error(), "HEX/BASE64") || len(rows) != 0 {
			t.Fatalf("lossy complex result must fail without rows: query=%s rows=%v err=%v", query, rows, err)
		}
	}
	rows, fields, err := driver.QueryContext(ctx, "SELECT hex(map('bytes',unhex('00ff'))['bytes']) AS safe_payload")
	if err != nil || len(rows) != 1 || fmt.Sprint(rows[0][fields[0]]) != "00FF" {
		t.Fatalf("explicit lossless projection rows=%v err=%v", rows, err)
	}
}
