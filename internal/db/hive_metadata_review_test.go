//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	hs "github.com/beltran/gohive/hiveserver"
)

func TestHiveTemporarySourceTypesUseOwningSession(t *testing.T) {
	service := newHiveFakeService()
	service.columnRows = [][]any{{"id", "bigint", ""}, {"payload", "map<string,binary>", "permanent"}}
	service.queryResult = &hiveFakeOperation{columns: []string{"id", "payload"}, types: []hs.TTypeId{hs.TTypeId_BIGINT_TYPE, hs.TTypeId_ARRAY_TYPE}, rows: [][]any{{int64(1), "[\"safe\"]"}}}
	driver := &HiveDB{}
	if err := driver.Connect(hiveFakeBinary(t, service, true)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	main, err := driver.session(false)
	if err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	service.sessionColumnRows = map[string][][]any{string(main.handle.SessionId.GUID): {{"id", "bigint", ""}, {"payload", "array<string>", "temporary"}}}
	service.mu.Unlock()
	consumer := &hiveSourceTypedConsumer{}
	if err := driver.StreamQueryContext(context.Background(), "SELECT id,payload FROM default.shadowed", consumer); err != nil {
		t.Fatalf("temporary source incorrectly resolved to permanent metadata: %v", err)
	}
	if consumer.columns[1].Type != "array<string>" || consumer.columns[1].Comment != "temporary" {
		t.Fatalf("owning source metadata=%+v", consumer.columns)
	}
	permanent, err := driver.GetColumns("default", "shadowed")
	if err != nil || permanent[1].Type != "map<string,binary>" {
		t.Fatalf("background catalog lost isolation: %+v %v", permanent, err)
	}
}

func TestHiveEnforcedNotNullMetadataIsMergedBeforePlanning(t *testing.T) {
	service := newHiveFakeService()
	service.columnRows = [][]any{{"id", "int", ""}, {"required", "string", ""}}
	service.formattedRows = [][]any{{"Table Type:", "MANAGED_TABLE", nil}, {"InputFormat:", "OrcInputFormat", nil}, {"# Primary Key Constraints", nil, nil}, {"Column Name:", "id", nil}, {"# Not Null Constraints", nil, nil}, {"Constraint Name:", "nn", nil}, {"Column Name:", "required", nil}}
	service.createDDL = "CREATE TABLE base (id INT, required STRING); ALTER TABLE default.base CHANGE COLUMN required required STRING CONSTRAINT nn NOT NULL ENABLE NOVALIDATE RELY;"
	driver := &HiveDB{}
	if err := driver.Connect(hiveFakeBinary(t, service, true)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	columns, err := driver.GetColumns("default", "base")
	if err != nil || len(columns) != 2 || columns[0].Nullable != "YES" || columns[1].Nullable != "NO" {
		t.Fatalf("enforced nullability metadata=%+v error=%v", columns, err)
	}
	if err := driver.ApplyChangesContext(context.Background(), "default.base", connection.ChangeSet{Inserts: []map[string]interface{}{{"id": 1}}}); err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("missing NOTNULL value accepted before write: %v", err)
	}
	if mutations := hiveFakeMutationStatements(service); len(mutations) != 0 {
		t.Fatalf("required-column rejection happened after write: %v", mutations)
	}
}

func TestImpalaPartitionsAndSparkStorageKinds(t *testing.T) {
	rows := []map[string]interface{}{{"name": "# Partition Information", "type": ""}, {"name": "# col_name", "type": "data_type"}, {"name": "year", "type": "int"}, {"name": "month", "type": "string"}, {"name": "# Detailed Table Information", "type": ""}, {"name": "Location:", "type": "hdfs://example"}}
	partitions, found, err := hiveFormattedPartitionNames(rows, []string{"name", "type"})
	if err != nil || !found || strings.Join(partitions, ",") != "year,month" {
		t.Fatalf("Impala partitions=%v found=%v err=%v", partitions, found, err)
	}
	for _, kind := range []string{"MANAGED", "EXTERNAL"} {
		caps := hiveDeriveWriteCapabilities("spark", map[string]string{"type": kind}, map[string]string{}, nil)
		if !caps.Insert || caps.Update || caps.Delete || caps.AtomicBatch {
			t.Fatalf("Spark %s capability=%+v", kind, caps)
		}
	}
}

func TestHiveUnsupportedRelationalMetadataIsEmptyNotError(t *testing.T) {
	driver := &HiveDB{}
	indexes, err := driver.GetIndexes("default", "customers")
	if err != nil || len(indexes) != 0 {
		t.Fatalf("indexes=%v error=%v", indexes, err)
	}
	foreignKeys, err := driver.GetForeignKeys("default", "customers")
	if err != nil || len(foreignKeys) != 0 {
		t.Fatalf("foreignKeys=%v error=%v", foreignKeys, err)
	}
	triggers, err := driver.GetTriggers("default", "customers")
	if err != nil || len(triggers) != 0 {
		t.Fatalf("triggers=%v error=%v", triggers, err)
	}
}

func TestHiveDescribeColumnsStripsSyntheticCommentsAndEndsPartitionBlock(t *testing.T) {
	rows := []map[string]interface{}{
		{"col_name": "id", "data_type": "bigint", "comment": "from deserializer"},
		{"col_name": "name", "data_type": "string", "comment": "NULL"},
		{"col_name": "dt", "data_type": "string", "comment": "day"},
		{"col_name": "# Partition Information", "data_type": nil, "comment": nil},
		{"col_name": "dt", "data_type": "string", "comment": "day"},
		{"col_name": "# Detailed Table Information", "data_type": nil, "comment": nil},
		{"col_name": "extra", "data_type": "string", "comment": "real"},
	}
	columns, err := hiveDescribeColumns(rows, []string{"col_name", "data_type", "comment"})
	if err != nil {
		t.Fatal(err)
	}
	if len(columns) != 4 {
		t.Fatalf("columns=%+v", columns)
	}
	if columns[0].Comment != "" || columns[1].Comment != "" || columns[3].Comment != "real" {
		t.Fatalf("synthetic comments leaked: %+v", columns)
	}
	if columns[2].Extra != "partition" || columns[3].Extra != "" {
		t.Fatalf("partition block leaked past detail section: %+v", columns)
	}
}
