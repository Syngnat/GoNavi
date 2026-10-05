package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// fakeTimescaleDB 按查询里引用的系统视图返回固定行，并回报服务端版本。
type fakeTimescaleDB struct {
	db.Database
	version     string
	dimensions  []map[string]interface{}
	compression []map[string]interface{}
}

func (f fakeTimescaleDB) DriverVariantInfo() (string, string) { return "", f.version }

func (f fakeTimescaleDB) Query(query string) ([]map[string]interface{}, []string, error) {
	switch {
	case strings.Contains(query, "dimension"):
		return f.dimensions, nil, nil
	case strings.Contains(query, "compression"):
		return f.compression, nil, nil
	}
	return nil, nil, nil
}

func TestTimescaleSupplementUsesModernDimensionBuilders(t *testing.T) {
	fake := fakeTimescaleDB{
		version: "2.17.2",
		dimensions: []map[string]interface{}{
			{"column_name": "time", "dimension_type": "Time", "time_interval": "1 day"},
			{"column_name": "device", "dimension_type": "Space", "num_partitions": "4"},
		},
		compression: []map[string]interface{}{
			{"attname": "device", "segmentby_column_index": "1"},
			{"attname": "time", "orderby_column_index": "1", "orderby_asc": false, "orderby_nullsfirst": true},
		},
	}
	ddl := appendRegistryCreateStatementSupplement(fake, connection.ConnectionConfig{Type: "timescaledb"}, "public", "conditions", "CREATE TABLE \"public\".\"conditions\" ();")
	for _, want := range []string{
		`SELECT create_hypertable('"public"."conditions"', by_range('time', INTERVAL '1 day'));`,
		`SELECT add_dimension('"public"."conditions"', by_hash('device', 4));`,
		`ALTER TABLE "public"."conditions" SET (timescaledb.compress, timescaledb.compress_segmentby = 'device', timescaledb.compress_orderby = 'time DESC');`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("ddl misses %s:\n%s", want, ddl)
		}
	}
}

func TestTimescaleSupplementUsesLegacySyntaxBefore213(t *testing.T) {
	fake := fakeTimescaleDB{
		version: "1.7.5",
		dimensions: []map[string]interface{}{
			{"column_name": "time", "dimension_type": "Time", "time_interval": "1 day"},
			{"column_name": "device", "dimension_type": "Space", "num_partitions": "2"},
		},
	}
	ddl := appendRegistryCreateStatementSupplement(fake, connection.ConnectionConfig{Type: "timescaledb"}, "", "conditions", "CREATE TABLE conditions ();")
	if !strings.Contains(ddl, `SELECT create_hypertable('"public"."conditions"', 'time', chunk_time_interval => INTERVAL '1 day');`) ||
		!strings.Contains(ddl, `SELECT add_dimension('"public"."conditions"', 'device', number_partitions => 2);`) {
		t.Fatalf("legacy ddl:\n%s", ddl)
	}
	if strings.Contains(ddl, "timescaledb.compress") {
		t.Fatalf("tables without compression settings must not get an ALTER TABLE: %s", ddl)
	}
}

func TestTimescaleSupplementLeavesPlainTablesAndOtherTypesAlone(t *testing.T) {
	plain := fakeTimescaleDB{version: "2.17.2"}
	if ddl := appendRegistryCreateStatementSupplement(plain, connection.ConnectionConfig{Type: "timescaledb"}, "public", "devices", "CREATE TABLE devices ();"); ddl != "CREATE TABLE devices ();" {
		t.Fatalf("plain table ddl changed: %s", ddl)
	}
	hyper := fakeTimescaleDB{version: "2.17.2", dimensions: []map[string]interface{}{{"column_name": "time", "time_interval": "1 day"}}}
	if ddl := appendRegistryCreateStatementSupplement(hyper, connection.ConnectionConfig{Type: "postgres"}, "public", "t", "CREATE TABLE t ();"); ddl != "CREATE TABLE t ();" {
		t.Fatalf("non-TimescaleDB types must not be supplemented: %s", ddl)
	}
}
