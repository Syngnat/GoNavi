package sync

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveExtendedTypesArePreservedOrRejectedExplicitly(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"uniontype<int,string,array<bigint>>", "UNIONTYPE<INT,STRING,ARRAY<BIGINT>>"},
		{"interval_year_month", "INTERVAL YEAR TO MONTH"}, {"interval_day_time", "INTERVAL DAY TO SECOND"},
	} {
		t.Run(test.input, func(t *testing.T) {
			column := connection.ColumnDefinition{Name: "value", Type: test.input}
			got, err := mapHiveMigrationType("hive", "hive", column)
			if err != nil || got != test.want {
				t.Fatalf("extended type = %q, %v; want %q", got, err, test.want)
			}
			if _, err := mapHiveMigrationType("hive", "postgres", column); err == nil {
				t.Fatal("extended type was silently converted across engines")
			}
		})
	}
}

func TestHiveVersionAndProtocolFamiliesPreflightTypes(t *testing.T) {
	for _, test := range []struct {
		name, family, version, typ string
		creating, allowed          bool
	}{
		{"Hive1 scalar", "hive", "hive1", "string", true, true},
		{"Hive1 union", "hive", "hive1", "uniontype<int,string>", true, true},
		{"Hive1 unverified interval", "hive", "hive1", "interval year to month", true, false},
		{"Hive1 existing verified interval", "hive", "hive1", "interval year to month", false, true},
		{"Hive2 interval", "hive", "hive2", "interval day to second", true, true},
		{"Hive2 local timezone", "hive", "hive2", "timestamp with local time zone", true, false},
		{"Hive3 local timezone", "hive", "hive3", "timestamp with local time zone", true, true},
		{"Hive4 nested types", "hive", "hive4", "struct<a:uniontype<int,array<string>>>", true, true},
		{"Spark complex", "spark", "hive3", "array<struct<a:map<string,int>>>", false, true},
		{"Spark union", "spark", "hive3", "array<uniontype<int,string>>", false, false},
		{"Spark interval", "spark", "hive3", "interval day to second", false, false},
		{"Impala scalar", "impala", "hive3", "decimal(38,18)", false, true},
		{"Impala complex writes", "impala", "hive3", "array<int>", false, false},
		{"Impala union", "impala", "hive3", "uniontype<int,string>", false, false},
		{"VOID column", "hive", "hive4", "void", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := connection.ConnectionConfig{Type: "hive", DriverVariant: test.version, ConnectionParams: "hiveFamily=" + test.family}
			err := validateHiveTargetTypeSupport(config, []connection.ColumnDefinition{{Name: "value", Type: test.typ}}, test.creating)
			if (err == nil) != test.allowed {
				t.Fatalf("type preflight error = %v; allowed %t", err, test.allowed)
			}
		})
	}
}

func TestHiveSparkTimestampPreflightDoesNotLoseNanoseconds(t *testing.T) {
	for _, test := range []struct {
		source, sourceFamily, typ string
		allowed                   bool
	}{
		{"hive", "hive", "timestamp", false}, {"hive", "impala", "array<timestamp>", false},
		{"hive", "spark", "timestamp", true}, {"hive", "hive", "string", true},
		{"oracle", "", "timestamp(9)", false}, {"oracle", "", "timestamp(6)", true},
		{"mysql", "", "datetime(6)", true}, {"sqlserver", "", "datetime2(7)", false},
	} {
		t.Run(test.source+test.sourceFamily+test.typ, func(t *testing.T) {
			config := SyncConfig{SourceConfig: connection.ConnectionConfig{Type: test.source, ConnectionParams: "hiveFamily=" + test.sourceFamily}, TargetConfig: connection.ConnectionConfig{Type: "hive", ConnectionParams: "hiveFamily=spark"}}
			err := validateHivePairTypeSemantics(config, []connection.ColumnDefinition{{Name: "value", Type: test.typ}})
			if (err == nil) != test.allowed {
				t.Fatalf("Spark timestamp preflight = %v; allowed %t", err, test.allowed)
			}
		})
	}
}
