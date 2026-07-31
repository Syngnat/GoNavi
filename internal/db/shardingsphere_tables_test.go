package db

import (
	"errors"
	"reflect"
	"testing"
)

func TestMergeShardingSphereLogicalTablesCollapsesNumericPhysicalTables(t *testing.T) {
	t.Parallel()

	tables := []string{
		"public.apply_or_report_file_0",
		"public.apply_or_report_file_1",
		"public.apply_or_report_filesystem",
		"public.ai_result_0",
		"public.ai_result_1",
	}
	rules := []map[string]interface{}{
		{"table": "apply_or_report_file"},
		{"table": "ai_result"},
	}

	got := mergeShardingSphereLogicalTables(tables, rules)
	want := []string{
		"public.apply_or_report_file",
		"public.apply_or_report_filesystem",
		"public.ai_result",
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged tables = %v, want %v", got, want)
	}
}

func TestMergeShardingSphereLogicalTablesPreservesQualifiedLogicalRule(t *testing.T) {
	t.Parallel()

	tables := []string{"public.orders_0", "public.orders_1", "archive.orders_0", "archive.orders_1"}
	rules := []map[string]interface{}{
		{"logical_table_name": "archive.orders"},
	}

	got := mergeShardingSphereLogicalTables(tables, rules)
	want := []string{"public.orders_0", "public.orders_1", "archive.orders"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged tables = %v, want %v", got, want)
	}
}

func TestResolveShardingSphereLogicalTablesSkipsDistSQLWithoutShardCandidates(t *testing.T) {
	t.Parallel()

	called := false
	tables := []string{"orders_0", "audit_log", "users"}

	got := resolveShardingSphereLogicalTables(tables, func(string) ([]map[string]interface{}, []string, error) {
		called = true
		return nil, nil, nil
	})

	if called {
		t.Fatalf("DistSQL should not run without multiple numeric shard candidates")
	}
	if !reflect.DeepEqual(got, tables) {
		t.Fatalf("tables = %v, want %v", got, tables)
	}
}

func TestResolveShardingSphereLogicalTablesUsesRulesOnlyWhenAvailable(t *testing.T) {
	t.Parallel()

	tables := []string{"orders_0", "orders_1"}
	got := resolveShardingSphereLogicalTables(tables, func(query string) ([]map[string]interface{}, []string, error) {
		if query != shardingSphereTableRulesQuery {
			t.Fatalf("query = %q, want %q", query, shardingSphereTableRulesQuery)
		}
		return nil, nil, errors.New("not a ShardingSphere proxy")
	})

	if !reflect.DeepEqual(got, tables) {
		t.Fatalf("tables should be preserved when DistSQL fails, got %v", got)
	}
}

func TestResolveShardingSphereLogicalTablesCollapsesFromDistSQL(t *testing.T) {
	t.Parallel()

	tables := []string{"orders_0", "orders_1", "users"}
	got := resolveShardingSphereLogicalTables(tables, func(query string) ([]map[string]interface{}, []string, error) {
		return []map[string]interface{}{
			{"TABLE": "orders"},
		}, []string{"TABLE"}, nil
	})

	want := []string{"orders", "users"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tables = %v, want %v", got, want)
	}
}

func TestParsePostgresTableNamesUsesCaseInsensitiveColumns(t *testing.T) {
	t.Parallel()

	got := parsePostgresTableNames([]map[string]interface{}{
		{"SCHEMANAME": "public", "TABLENAME": "orders"},
		{"schema_name": "archive", "table_name": "orders"},
		{"schema_name": "archive", "table_name": "orders"},
	})
	want := []string{"public.orders", "archive.orders"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tables = %v, want %v", got, want)
	}
}

func TestParsePostgresTableNamesPreservesDotsInsideTableIdentifiers(t *testing.T) {
	t.Parallel()

	got := parsePostgresTableNames([]map[string]interface{}{
		{"schemaname": "jmgc_db", "tablename": "副本.历史"},
	})
	want := []string{`jmgc_db."副本.历史"`}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tables = %v, want %v", got, want)
	}
}
