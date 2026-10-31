package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type hiveVariantStub struct {
	db.Database
	version string
}

func (stub hiveVariantStub) DriverVariantInfo() (string, string) { return "hive3", stub.version }

func TestHiveMajorVersionParsesServerBanners(t *testing.T) {
	for input, want := range map[string]int{
		"4.0.1": 4, "Hive 3.1.3": 3, "2.3.9-ubuntu0": 2, "1.2.2": 1, "": 0, "unknown": 0,
	} {
		if got := hiveMajorVersion(input); got != want {
			t.Fatalf("hiveMajorVersion(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestHiveCreateTableUsesManagedFormOnlyForApacheHive4(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "BIGINT"}, {Name: "day", Type: "STRING", Extra: "partition"}}
	for _, test := range []struct {
		name     string
		params   string
		database db.Database
		want     string
	}{
		{"hive 4 defaults to external", "", hiveVariantStub{version: "4.0.1"}, "CREATE MANAGED TABLE "},
		{"hive 3 already managed", "", hiveVariantStub{version: "3.1.3"}, "CREATE TABLE "},
		{"unknown version stays conservative", "", hiveVariantStub{version: ""}, "CREATE TABLE "},
		{"no live target", "", nil, "CREATE TABLE "},
		{"spark 4 has no managed keyword", "hiveFamily=spark", hiveVariantStub{version: "4.0.0"}, "CREATE TABLE "},
		{"impala 4 has no managed keyword", "hiveFamily=impala", hiveVariantStub{version: "4.4.0"}, "CREATE TABLE "},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := connection.ConnectionConfig{Type: "hive", ConnectionParams: test.params}
			statement, err := buildHiveCreateTableSQLFor(config, test.database, "hive", "hive", "warehouse.events", columns)
			if err != nil || !strings.HasPrefix(statement, test.want) || !strings.Contains(statement, "PARTITIONED BY") {
				t.Fatalf("unexpected Hive DDL %q: %v", statement, err)
			}
		})
	}
}
