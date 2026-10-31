package sync

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func hiveQualifiedTestResult(prefix string, fields []connection.ColumnDefinition, rows []map[string]interface{}) ([]map[string]interface{}, []connection.ColumnDefinition) {
	qualified := append([]connection.ColumnDefinition(nil), fields...)
	for i := range qualified {
		qualified[i].Name = prefix + "." + qualified[i].Name
	}
	result := make([]map[string]interface{}, len(rows))
	for i, row := range rows {
		result[i] = make(map[string]interface{}, len(row))
		for name, value := range row {
			result[i][prefix+"."+name] = value
		}
	}
	return result, qualified
}

func TestHiveQualifiedTableLabelsDoNotBecomeNull(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "id", Type: "bigint"}, {Name: "name", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	source.streamFunc = func(string) ([]map[string]interface{}, []connection.ColumnDefinition, error) {
		rows, columns := hiveQualifiedTestResult("events", fields, []map[string]interface{}{{"id": int64(7), "name": "qualified"}})
		return rows, columns, nil
	}
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), hiveTestConfig("insert_only"))
	if !result.Success || result.RowsInserted != 1 {
		t.Fatalf("qualified table copy = %+v", result)
	}
	row := target.applied[0].Inserts[0]
	if row["id"] != int64(7) || row["name"] != "qualified" {
		t.Fatalf("qualified labels lost values: %#v", row)
	}
}

func TestHiveQualifiedSnapshotLabelsKeepLogicalKey(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "id", Type: "bigint"}, {Name: "name", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	for _, database := range []*hiveSyncTestDB{source, target} {
		current := database
		current.streamFunc = func(string) ([]map[string]interface{}, []connection.ColumnDefinition, error) {
			name := "new"
			if current == target {
				name = "old"
			}
			rows, columns := hiveQualifiedTestResult("events", fields, []map[string]interface{}{{"id": int64(7), "name": name}})
			return rows, columns, nil
		}
	}
	target.capabilities.Update = true
	config := hiveTestConfig("insert_update")
	config.Mappings = hiveLogicalKeyMapping()
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsUpdated != 1 || result.RowsInserted != 0 {
		t.Fatalf("qualified snapshot diff = %+v", result)
	}
	if target.applied[0].Updates[0].Keys["id"] != int64(7) {
		t.Fatalf("lost logical key: %+v", target.applied)
	}
}

func TestHiveQualifiedSimpleQueryAndExplicitDottedAlias(t *testing.T) {
	for _, test := range []struct{ name, query, raw, target string }{
		{"unaliased single table", "SELECT id FROM events WHERE id > 0", "events.id", "id"},
		{"table alias", "SELECT e.id FROM events AS e WHERE e.id > 0", "e.id", "id"},
		{"explicit alias", "SELECT id AS chosen FROM events", "chosen", "chosen"},
		{"literal dotted alias", "SELECT id AS " + string(rune(96)) + "events.id" + string(rune(96)) + " FROM events", "events.id", "events.id"},
	} {
		t.Run(test.name, func(t *testing.T) {
			sourceFields := []connection.ColumnDefinition{{Name: test.raw, Type: "bigint"}}
			source := newHiveSyncTestDB("src", sourceFields, []map[string]interface{}{{test.raw: int64(9)}})
			target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: test.target, Type: "bigint"}}, nil)
			config := hiveTestConfig("insert_only")
			config.SourceQuery = test.query
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if !result.Success || result.RowsInserted != 1 || target.applied[0].Inserts[0][test.target] != int64(9) {
				t.Fatalf("query label copy = %+v; writes=%v", result, target.applied)
			}
		})
	}
}

func TestHiveLabelCanonicalizationRejectsAmbiguity(t *testing.T) {
	for _, test := range []struct {
		name   string
		fields []connection.ColumnDefinition
		labels []string
	}{
		{"duplicate suffix", []connection.ColumnDefinition{{Name: "id"}}, []string{"id", "events.id"}},
		{"wrong table", []connection.ColumnDefinition{{Name: "id"}}, []string{"other.id"}},
		{"literal column ambiguity", []connection.ColumnDefinition{{Name: "id"}, {Name: "events.id"}}, []string{"events.id"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if names, err := canonicalHiveTableLabels("src.events", test.fields, nil, test.labels); err == nil {
				t.Fatalf("ambiguous labels accepted: %v", names)
			}
		})
	}
	for _, query := range []string{"SELECT a.id, b.id FROM a JOIN b ON a.id = b.id", "WITH x AS (SELECT a.id FROM a JOIN b ON a.id=b.id) SELECT * FROM x", "SELECT id FROM events WHERE id=" + string(rune(36)) + "{id}"} {
		if _, _, _, ok := hiveSimpleQueryLabelContext(query); ok {
			t.Fatalf("unproven query context accepted: %s", query)
		}
	}
}

func TestHiveJoinLabelsDoNotGuessSameSuffix(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "a.id", Type: "bigint"}, {Name: "b.id", Type: "bigint"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"a.id": int64(1), "b.id": int64(2)}})
	target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "id", Type: "bigint"}}, nil)
	config := hiveTestConfig("full_overwrite")
	config.SourceQuery = "SELECT a.id, b.id FROM a JOIN b ON a.id=b.id"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success {
		t.Fatalf("ambiguous JOIN copied: %+v", result)
	}
	assertHiveNoWrites(t, target)
}
