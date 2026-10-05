package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestTimescaleDBObjectListsSkipExtensionInternals(t *testing.T) {
	objects := []connection.DatabaseObject{
		{Schema: "public", Name: "conditions", Type: "table"},
		{Schema: "_timescaledb_functions", Name: "insert_blocker", Type: "function"},
		{Schema: "timescaledb_information", Name: "hypertables", Type: "view"},
		{Schema: "timescaledb_experimental", Name: "policies", Type: "view"},
	}
	visible := filterRegistryHiddenObjects("timescaledb", objects)
	if len(visible) != 1 || visible[0].Name != "conditions" {
		t.Fatalf("visible objects = %+v", visible)
	}
	if got := filterRegistryHiddenObjects("postgres", objects); len(got) != len(objects) {
		t.Fatalf("PostgreSQL connections must keep every schema, got %d", len(got))
	}
}

func TestTimescaleDBRoutineQueriesSkipExtensionMembers(t *testing.T) {
	if !registryHidesExtensionRoutines("timescaledb") || registryHidesExtensionRoutines("postgres") || registryHidesExtensionRoutines("cockroachdb") {
		t.Fatal("only TimescaleDB declares hideExtensionRoutines")
	}
	specs := pgObjectRoutineQueries(pgNotExtensionProcFilter, pgNotExtensionRoutineFilter)
	if len(specs) != 3 {
		t.Fatalf("routine queries = %d", len(specs))
	}
	for _, spec := range specs {
		filter := strings.Index(spec.sql, "deptype = 'e'")
		if filter < 0 || filter > strings.Index(spec.sql, "ORDER BY") {
			t.Fatalf("extension filter must precede ORDER BY: %s", spec.sql)
		}
	}
	for _, spec := range buildObjectRoutineMetadataQueries("postgres", "") {
		if strings.Contains(spec.sql, "pg_depend") {
			t.Fatalf("plain PostgreSQL keeps extension functions: %s", spec.sql)
		}
	}
}

func TestTimescaleDBViewListSkipsInformationViews(t *testing.T) {
	fake := &fakeExportQueryDB{data: []map[string]interface{}{
		{"schema_name": "public", "object_name": "conditions_hourly"},
		{"schema_name": "timescaledb_information", "object_name": "hypertables"},
		{"schema_name": "_timescaledb_internal", "object_name": "_direct_view_2"},
	}}
	views, err := listViewNameLookupWithStatus(fake, connection.ConnectionConfig{Type: "timescaledb"}, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	names := mapValuesSorted(views)
	if len(names) != 1 || names[0] != "public.conditions_hourly" {
		t.Fatalf("views = %v", names)
	}
}

func TestGBase8cObjectListsSkipInternalSchemasAndExtensionViews(t *testing.T) {
	objects := []connection.DatabaseObject{
		{Schema: "sales", Name: "orders", Type: "table"},
		{Schema: "public", Name: "metrics", Type: "table"},
		{Schema: "dbe_perf", Name: "session_stat", Type: "view"},
		{Schema: "dbms_output", Name: "put_line", Type: "function"},
		{Schema: "blockchain", Name: "gs_global_chain", Type: "table"},
		{Schema: "sys", Name: "dual", Type: "view"},
		{Schema: "system_data", Name: "kept", Type: "table"},
	}
	visible := filterRegistryHiddenObjects("gbase8c", objects)
	names := make([]string, 0, len(visible))
	for _, object := range visible {
		names = append(names, object.Schema+"."+object.Name)
	}
	if strings.Join(names, ",") != "sales.orders,public.metrics,system_data.kept" {
		t.Fatalf("visible objects = %v", names)
	}

	queries, ok := registryListViewQueries("gbase8c")
	if !ok || len(queries) != 1 || !strings.Contains(queries[0], "deptype = 'e'") {
		t.Fatalf("GBase 8c view list must skip extension views: %v", queries)
	}
	if _, ok := registryListViewQueries("timescaledb"); ok {
		t.Fatal("TimescaleDB keeps the borrowed PostgreSQL view query")
	}
	if got := buildListViewQueries(connection.ConnectionConfig{Type: "gbase8c"}, "postgres"); len(got) != 1 || got[0] != queries[0] {
		t.Fatalf("view list queries = %v", got)
	}
}
