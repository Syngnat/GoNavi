package sync

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveFamilyFromURIUsesDriverPrecedenceAndPrecisionGuards(t *testing.T) {
	for _, test := range []struct{ name, uri, params, family string }{
		{"JDBC Spark", "jdbc:hive2://host/default;hiveFamily=spark", "", "spark"},
		{"explicit params override URI", "jdbc:hive2://host/default;hiveFamily=spark", "hiveFamily=hive", "hive"},
		{"query family", "hive2://host/default?hiveFamily=impala", "", "impala"},
		{"invalid family", "jdbc:hive2://host/default;hiveFamily=unknown", "", "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := connection.ConnectionConfig{Type: "hive", URI: test.uri, ConnectionParams: test.params}
			if family := hiveSyncFamily(config); family != test.family {
				t.Fatalf("family = %s; want %s", family, test.family)
			}
			if test.family == "spark" {
				capability := ResolveMigrationCapability(connection.ConnectionConfig{Type: "hive"}, config)
				if capability.SupportsMutations {
					t.Fatal("URI-only Spark incorrectly advertises mutation candidacy")
				}
				err := validateHivePairTypeSemantics(SyncConfig{SourceConfig: connection.ConnectionConfig{Type: "hive"}, TargetConfig: config}, []connection.ColumnDefinition{{Name: "stamp", Type: "timestamp"}})
				if err == nil {
					t.Fatal("URI-only Spark would silently truncate nanoseconds")
				}
			}
		})
	}
}

func TestHiveURIOnlyEndpointsNeverStreamIntoTheirOwnLiveSource(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "value", Type: "string"}}
	for _, mode := range []string{"insert_only", "full_overwrite"} {
		t.Run(mode, func(t *testing.T) {
			config := hiveTestConfig(mode)
			config.SourceConfig.Host, config.TargetConfig.Host = "", ""
			config.SourceConfig.Database, config.TargetConfig.Database = "", ""
			config.SourceConfig.URI, config.TargetConfig.URI = "jdbc:hive2://server/default", "jdbc:hive2://server/default"
			plan := SchemaMigrationPlan{SourceQueryTable: "events", TargetQueryTable: "events", TargetTableExists: true}
			source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
			if !isSamePhysicalSyncTable(config, plan, "hive", "hive") {
				t.Fatal("URI-only endpoint was incorrectly treated as a different physical table")
			}
			engine := NewSyncEngine(Reporter{})
			handled, _, err := engine.tryApplyHiveTableStream(config, &SyncResult{}, "events", "events", source, target, plan, fields, fields, TableOptions{Insert: true}, "hive", "hive")
			if handled || err != nil || len(source.streamQueries) != 0 {
				t.Fatalf("same URI table must use snapshot-before-write: handled=%t err=%v", handled, err)
			}
			config.SourceQuery = "SELECT value FROM events"
			handledQuery, _, err := engine.tryApplyHiveQueryStream(config, &SyncResult{}, "events", source, target, sourceQuerySyncContext{TargetType: "hive"}, TableOptions{Insert: true}, mode, "events")
			if handledQuery || err != nil {
				t.Fatalf("same URI query must use snapshot-before-write: handled=%t err=%v", handledQuery, err)
			}
		})
	}
}
