package sync

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func hiveWatermarkRequest(mode string) WatermarkSyncRequest {
	config := hiveTestConfig(mode)
	config.Mappings = hiveLogicalKeyMapping()
	return WatermarkSyncRequest{Sync: config, Table: "events", WatermarkColumn: "updated_at", TieBreakerColumns: []string{"id"}, BatchSize: 2, DeliverySemantics: WatermarkDeliveryAtLeastOnce}
}

func hiveWatermarkFields() []connection.ColumnDefinition {
	return []connection.ColumnDefinition{{Name: "updated_at", Type: "bigint", Nullable: "YES"}, {Name: "id", Type: "bigint", Nullable: "YES"}, {Name: "name", Type: "string", Nullable: "YES"}}
}

func TestHiveWatermarkUsesBoundedCompositeKeysetWithoutMetadataPrimaryKey(t *testing.T) {
	fields := hiveWatermarkFields()
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	pages := 0
	source.streamFunc = func(query string) ([]map[string]interface{}, []connection.ColumnDefinition, error) {
		if strings.Contains(query, " DESC") {
			return []map[string]interface{}{{"updated_at": int64(20), "id": int64(3)}}, fields[:2], nil
		}
		pages++
		if pages == 1 {
			return []map[string]interface{}{{"updated_at": int64(19), "id": int64(1), "name": "one"}, {"updated_at": int64(19), "id": int64(2), "name": "two"}}, fields, nil
		}
		return []map[string]interface{}{{"updated_at": int64(20), "id": int64(3), "name": "three"}}, fields, nil
	}
	useHiveSyncTestDBs(t, source, target)
	checkpoints := 0
	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), hiveWatermarkRequest("insert_only"), func(_ context.Context, checkpoint WatermarkCheckpoint) error {
		checkpoints++
		if checkpoint.Cursor.TieBreakers[0].Type != "int64" {
			t.Fatalf("typed cursor = %+v", checkpoint.Cursor)
		}
		return nil
	})
	if !result.Success || result.RowsInserted != 3 || result.Checkpoints != 2 || checkpoints != 2 {
		t.Fatalf("watermark copy = %+v", result)
	}
	if len(source.queries) != 2 || len(source.streamQueries) != 3 {
		t.Fatalf("logical-key and streaming queries = %v / %v", source.queries, source.streamQueries)
	}
	for _, query := range source.streamQueries {
		if strings.Contains(strings.ToUpper(query), "OFFSET") {
			t.Fatalf("Hive OFFSET = %s", query)
		}
	}
	if !strings.Contains(source.streamQueries[2], ">") || !strings.Contains(source.streamQueries[2], " <= ") {
		t.Fatalf("missing bounded keyset = %s", source.streamQueries[2])
	}
}

func TestHiveWatermarkRejectsDuplicateAndNullLogicalKeysBeforeWrites(t *testing.T) {
	for _, issue := range []string{"HAVING COUNT(*) > 1", " IS NULL"} {
		t.Run(issue, func(t *testing.T) {
			fields := hiveWatermarkFields()
			source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
			source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
				if strings.Contains(query, issue) {
					return []map[string]interface{}{{"id": int64(1)}}, []string{"id"}, nil
				}
				return nil, nil, nil
			}
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), hiveWatermarkRequest("insert_only"), nil)
			if result.Success || result.Checkpoints != 0 {
				t.Fatalf("invalid logical key = %+v", result)
			}
			assertHiveNoWrites(t, target)
			if len(source.streamQueries) != 0 {
				t.Fatal("streamed rows before key validation")
			}
		})
	}
}

func TestHiveWatermarkOrdinaryUpdateModeFailsBeforeRows(t *testing.T) {
	fields := hiveWatermarkFields()
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), hiveWatermarkRequest("insert_update"), nil)
	if result.Success || len(source.streamQueries) != 0 {
		t.Fatalf("ordinary update should be rejected before reads: %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveCursorLiteralsPreserveBinaryAndNanoseconds(t *testing.T) {
	for _, test := range []struct {
		value WatermarkCursorValue
		want  string
	}{
		{WatermarkCursorValue{Type: "bytes", Value: "AP8="}, "unhex('00ff')"},
		{WatermarkCursorValue{Type: "timestamp", Value: "2026-10-25T01:02:03.123456789Z"}, "'2026-10-25 01:02:03.123456789'"},
		{WatermarkCursorValue{Type: "decimal", Value: "12345678901234567890.123456789012345678"}, "12345678901234567890.123456789012345678"},
	} {
		got, err := watermarkCursorSQLLiteral("hive", test.value)
		if err != nil || got != test.want {
			t.Fatalf("literal = %q, %v; want %q", got, err, test.want)
		}
	}
}
