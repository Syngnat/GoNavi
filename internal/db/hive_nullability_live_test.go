//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	hs "github.com/beltran/gohive/hiveserver"
)

func TestHiveLiveNullabilityMetadata(t *testing.T) {
	if os.Getenv("GONAVI_HIVE_NULLABILITY_PROBE") == "" {
		t.Skip("set GONAVI_HIVE_NULLABILITY_PROBE for metadata probe")
	}
	driver := &HiveDB{}
	if err := driver.Connect(hiveLiveConfig(t)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	name := fmt.Sprintf("gonavi_nullability_%d", time.Now().UnixNano())
	if _, err := driver.ExecContext(ctx, "CREATE TABLE "+name+" (id INT, required STRING NOT NULL, optional STRING DEFAULT 'fallback') STORED AS ORC"); err != nil {
		t.Fatal(err)
	}
	defer driver.Exec("DROP TABLE " + name)
	for _, query := range []string{"DESCRIBE FORMATTED " + name, "SHOW CREATE TABLE " + name} {
		rows, fields, err := driver.QueryContext(ctx, query)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("metadata query=%s fields=%v", query, fields)
		for _, row := range rows {
			text := fmt.Sprint(row)
			lower := strings.ToLower(text)
			if strings.Contains(lower, "null") || strings.Contains(lower, "constraint") || strings.Contains(lower, "required") || strings.Contains(lower, "default") {
				t.Logf("metadata %v", row)
			}
		}
	}
	columns, err := driver.GetColumns("default", name)
	if err != nil {
		t.Fatal(err)
	}
	if len(columns) != 3 || columns[1].Nullable != "NO" || columns[0].Nullable != "YES" {
		t.Fatalf("real enforced nullability was not preserved: %+v", columns)
	}
	session, err := driver.session(false)
	if err != nil {
		t.Fatal(err)
	}
	database := hs.TPatternOrIdentifier("default")
	table := hs.TPatternOrIdentifier(name)
	rows, fields, err := session.nativeMetadata(ctx, func(ctx context.Context) (*hs.TOperationHandle, error) {
		response, err := session.wire.api.GetColumns(ctx, &hs.TGetColumnsReq{SessionHandle: session.handle, SchemaName: &database, TableName: &table})
		if err != nil {
			return nil, err
		}
		if err = hiveCheckStatus(response.GetStatus()); err != nil {
			return nil, err
		}
		return response.OperationHandle, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("native columns fields=%v rows=%v", fields, rows)
}
