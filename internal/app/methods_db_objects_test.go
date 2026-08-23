package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestDatabaseObjectFromRowPrefersTriggerNameOverTableName(t *testing.T) {
	object := databaseObjectFromRow("crm", "trigger", "", map[string]interface{}{
		"schema_name":  "audit",
		"table_name":   "orders",
		"trigger_name": "trg_orders_audit",
	})

	if object.Type != "trigger" {
		t.Fatalf("expected trigger object, got %#v", object)
	}
	if object.Schema != "audit" {
		t.Fatalf("expected schema audit, got %#v", object)
	}
	if object.Name != "trg_orders_audit" {
		t.Fatalf("expected trigger name, got %#v", object)
	}
	if object.Parent != "orders" {
		t.Fatalf("expected parent table orders, got %#v", object)
	}
}

func TestBuildNamedObjectsPreservesMessageQueueDottedNames(t *testing.T) {
	objects := buildNamedObjects("topics", "topic", []string{"orders.events.v1"})
	if len(objects) != 1 {
		t.Fatalf("expected one object, got %#v", objects)
	}
	if objects[0].Schema != "" {
		t.Fatalf("topic must not be split into schema, got %#v", objects[0])
	}
	if objects[0].Name != "orders.events.v1" {
		t.Fatalf("expected dotted topic name to be preserved, got %#v", objects[0])
	}
}

func TestDatabaseObjectFromRowReadsMySQLShowTriggerColumn(t *testing.T) {
	object := databaseObjectFromRow("crm", "trigger", "", map[string]interface{}{
		"Trigger": "trg_orders_audit",
		"Table":   "orders",
	})

	if object.Name != "trg_orders_audit" {
		t.Fatalf("expected MySQL SHOW TRIGGERS Trigger column to be used, got %#v", object)
	}
	if object.Parent != "orders" {
		t.Fatalf("expected MySQL SHOW TRIGGERS Table column to become parent, got %#v", object)
	}
}

func TestBuildListViewQueriesUsesCurrentMySQLDatabaseWhenDBNameEmpty(t *testing.T) {
	queries := buildListViewQueries(testConnectionConfig("mysql"), "")

	if len(queries) != 2 {
		t.Fatalf("expected information_schema and SHOW fallback queries, got %#v", queries)
	}
	if !strings.Contains(queries[0], "TABLE_SCHEMA = DATABASE()") {
		t.Fatalf("expected empty dbName to use current database, got %q", queries[0])
	}
	if queries[1] != "SHOW FULL TABLES WHERE Table_type = 'VIEW'" {
		t.Fatalf("expected SHOW FULL TABLES fallback for current database, got %q", queries[1])
	}
}

func TestBuildObjectRoutineQueriesUseCurrentMySQLDatabaseWhenDBNameEmpty(t *testing.T) {
	specs := buildObjectRoutineMetadataQueries("mysql", "")
	if len(specs) != 3 {
		t.Fatalf("expected routine metadata queries, got %#v", specs)
	}
	joined := strings.Join([]string{specs[0].sql, specs[1].sql, specs[2].sql}, "\n")
	if strings.Contains(joined, "''") {
		t.Fatalf("empty dbName must not generate empty schema predicates, got %q", joined)
	}
	if !strings.Contains(specs[0].sql, "ROUTINE_SCHEMA = DATABASE()") {
		t.Fatalf("expected information_schema routines to use current database, got %q", specs[0].sql)
	}
	if !strings.Contains(specs[1].sql, "Db = DATABASE()") || !strings.Contains(specs[2].sql, "Db = DATABASE()") {
		t.Fatalf("expected SHOW routine status queries to use current database, got %#v", specs)
	}
}

func TestBuildObjectTriggerQueriesDoNotEmitEmptyMySQLFromClause(t *testing.T) {
	specs := buildObjectTriggerMetadataQueries("mysql", "")
	if len(specs) != 2 {
		t.Fatalf("expected information_schema and SHOW fallback queries, got %#v", specs)
	}
	if strings.Contains(specs[1].sql, "FROM") {
		t.Fatalf("empty dbName must not generate SHOW TRIGGERS FROM without database, got %#v", specs)
	}
	if specs[1].sql != "SHOW TRIGGERS" {
		t.Fatalf("expected SHOW TRIGGERS fallback for current database, got %q", specs[1].sql)
	}
}

func TestBuildOracleObjectMetadataQueriesExposeCompileStatus(t *testing.T) {
	routineSpecs := buildObjectRoutineMetadataQueries("oracle", "APP")
	if len(routineSpecs) != 1 {
		t.Fatalf("expected one Oracle routine metadata query, got %#v", routineSpecs)
	}
	if !strings.Contains(routineSpecs[0].sql, "STATUS AS object_status") {
		t.Fatalf("expected Oracle routine query to expose compiler status, got %q", routineSpecs[0].sql)
	}

	triggerSpecs := buildObjectTriggerMetadataQueries("oracle", "APP")
	if len(triggerSpecs) != 1 {
		t.Fatalf("expected one Oracle trigger metadata query, got %#v", triggerSpecs)
	}
	if !strings.Contains(triggerSpecs[0].sql, "LEFT JOIN ALL_OBJECTS") || !strings.Contains(triggerSpecs[0].sql, "STATUS AS object_status") {
		t.Fatalf("expected Oracle trigger query to join object compiler status, got %q", triggerSpecs[0].sql)
	}
}

func testConnectionConfig(dbType string) connection.ConnectionConfig {
	return connection.ConnectionConfig{Type: dbType}
}
