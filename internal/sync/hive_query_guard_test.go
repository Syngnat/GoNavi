package sync

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/db"
)

func TestHiveSourceQueryGuardRejectsWritesScriptsAndSubstitutionBeforeConnect(t *testing.T) {
	macro := string(rune(36)) + "{hiveconf:statement}"
	queries := []string{
		"DROP TABLE events", "SELECT 1; INSERT INTO events VALUES (1)",
		"WITH src AS (SELECT 1) INSERT OVERWRITE TABLE events SELECT * FROM src",
		"SELECT TRANSFORM(id) USING 'sh' AS output FROM events",
		"ADD JAR '/tmp/code.jar'", "EXPORT TABLE events TO '/tmp/dump'",
		"SELECT '" + macro + "' AS value", "SELECT " + macro,
		"SELECT id INTO OUTFILE '/tmp/out' FROM events",
	}
	for _, query := range queries {
		t.Run(query, func(t *testing.T) {
			oldFactory := newSyncDatabase
			t.Cleanup(func() { newSyncDatabase = oldFactory })
			calls := 0
			newSyncDatabase = func(string) (db.Database, error) { calls++; return &fakeMigrationDB{}, nil }
			config := hiveTestConfig("insert_only")
			config.SourceQuery = query
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success || calls != 0 {
				t.Fatalf("unsafe Hive query was not rejected before opening a database: %+v calls=%d", result, calls)
			}
			analysis := NewSyncEngine(Reporter{}).AnalyzeContext(context.Background(), config)
			if analysis.Success || calls != 0 {
				t.Fatalf("analysis opened a database for unsafe SQL: %+v calls=%d", analysis, calls)
			}
			if _, err := NewSyncEngine(Reporter{}).PreviewContext(context.Background(), config, "events", 5); err == nil || calls != 0 {
				t.Fatalf("preview opened a database for unsafe SQL: err=%v calls=%d", err, calls)
			}
		})
	}
}

func TestHiveSourceQueryGuardAcceptsSelectCTEAndTypedProjections(t *testing.T) {
	for _, query := range []string{
		"SELECT id AS id FROM events", "WITH src AS (SELECT id FROM events) SELECT id FROM src",
		"SELECT hex(payload['bytes']) AS hex_value FROM events",
		"SELECT named_struct('key', array(1,2)) AS value",
		"SELECT 'DELETE; TRANSFORM' AS value", "SELECT 1 AS value;",
		"-- leading comment\nSELECT id FROM events",
	} {
		t.Run(query, func(t *testing.T) {
			config := hiveTestConfig("insert_only")
			config.SourceQuery = query
			if _, err := validateSourceQuerySyncConfig(config); err != nil {
				t.Fatalf("safe Hive source SQL rejected: %v", err)
			}
		})
	}
}
