package app

import "testing"

func TestHiveSettingsReadsReturnResultSetsWithoutAuthorizingAssignments(t *testing.T) {
	for _, query := range []string{"SET", "SET;", "SET -v", "SET hive.exec.dynamic.partition", "SET hivevar:task_id"} {
		t.Run(query, func(t *testing.T) {
			if !isHiveSettingReadQuery(query) || !isReadOnlySQLQuery("hive", query) || !shouldTryQueryResultFirst("hive", query) {
				t.Fatalf("Hive setting inspection must return rows: %q", query)
			}
		})
	}
	for _, query := range []string{"SET hive.exec.dynamic.partition=true", "SET x = 'y'", "SET -v; DROP TABLE events", "SET x /* hidden */ = 1"} {
		t.Run(query, func(t *testing.T) {
			if isHiveSettingReadQuery(query) || isReadOnlySQLQuery("hive", query) {
				t.Fatalf("Hive setting assignment or mixed SQL must not become read-only: %q", query)
			}
		})
	}
	for _, query := range []string{"SELECT * FROM events", "SHOW DATABASES", "SHOW CREATE TABLE events", "DESCRIBE FORMATTED events"} {
		t.Run(query, func(t *testing.T) {
			if !isReadOnlySQLQuery("hive", query) {
				t.Fatalf("native metadata query blocked: %s", query)
			}
		})
	}
}
