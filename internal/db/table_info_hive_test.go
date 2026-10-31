package db

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestHiveTableInfoReadsOnlyCatalogStatistics(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	queries := 0
	query := func(actual context.Context, sql string) ([]map[string]interface{}, error) {
		queries++
		if actual != ctx || !strings.HasPrefix(sql, "DESCRIBE FORMATTED ") || strings.Contains(sql, "COUNT(") {
			t.Fatalf("table info must use cancellable metadata only: %q", sql)
		}
		return []map[string]interface{}{
			{"col_name": "numRows", "data_type": "bigint"},
			{"col_name": "# Detailed Table Information", "data_type": nil},
			{"col_name": "InputFormat:", "data_type": "org.apache.hadoop.hive.ql.io.orc.OrcInputFormat"},
			{"col_name": "Table Type:", "data_type": "MANAGED_TABLE"},
			{"col_name": "", "data_type": " numRows ", "comment": "12"},
			{"col_name": "", "data_type": " totalSize ", "comment": "4096"},
			{"col_name": "comment", "data_type": "warehouse fixture"},
		}, nil
	}
	info, err := dispatchTableInfoQuery(ctx, "hive", "analytics", "", "orders", query)
	if err != nil || queries != 1 || info.Engine != "ORC" || info.RowFormat != "MANAGED_TABLE" || info.Comment != "warehouse fixture" {
		t.Fatalf("Hive table properties lost: %+v, %v", info, err)
	}
	if info.Rows == nil || *info.Rows != 12 || info.DataLength == nil || *info.DataLength != 4096 || info.IndexLength != nil {
		t.Fatalf("Hive statistics fabricated or lost: %+v", info)
	}
}

func TestHiveTableInfoDoesNotFabricateUnknownStatistics(t *testing.T) {
	for _, raw := range []string{"", "-1", "not collected"} {
		if hiveNonnegativeStat(raw) != nil {
			t.Fatalf("unknown Hive stats became zero: %q", raw)
		}
	}
	failure := errors.New("permission denied")
	_, err := getHiveTableInfo(context.Background(), func(context.Context, string) ([]map[string]interface{}, error) {
		return nil, failure
	}, "analytics", "", "orders")
	if !errors.Is(err, failure) {
		t.Fatalf("Hive metadata error lost: %v", err)
	}
}
