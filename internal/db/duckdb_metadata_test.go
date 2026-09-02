package db

import (
	"strings"
	"testing"
)

func TestBuildDuckDBConstraintMetadataQuery_UsesDuckDBConstraints(t *testing.T) {
	t.Parallel()

	query := buildDuckDBConstraintMetadataQuery(duckDBObjectPath{
		Catalog: "analytics",
		Schema:  "main",
		Object:  "events",
	}, true)

	if !containsAll(query,
		"FROM duckdb_constraints()",
		"constraint_type IN ('PRIMARY KEY', 'UNIQUE')",
		"database_name = 'analytics'",
		"schema_name = 'main'",
		"table_name = 'events'",
	) {
		t.Fatalf("DuckDB 约束查询未正确包含 catalog/schema/table 过滤: %s", query)
	}
}

func TestBuildDuckDBIndexMetadataQuery_UsesDuckDBIndexes(t *testing.T) {
	t.Parallel()

	query := buildDuckDBIndexMetadataQuery(duckDBObjectPath{
		Catalog: "analytics",
		Schema:  "main",
		Object:  "events",
	}, true)

	if !containsAll(query,
		"FROM duckdb_indexes()",
		"database_name = 'analytics'",
		"schema_name = 'main'",
		"table_name = 'events'",
	) {
		t.Fatalf("DuckDB 索引查询未正确包含 catalog/schema/table 过滤: %s", query)
	}
}

func TestBuildDuckDBColumnDefinitions_MarksPrimaryAndUniqueColumns(t *testing.T) {
	t.Parallel()

	columns := buildDuckDBColumnDefinitions(
		[]map[string]interface{}{
			{
				"column_name":    "id",
				"data_type":      "BIGINT",
				"is_nullable":    "NO",
				"column_default": nil,
			},
			{
				"column_name":    "email",
				"data_type":      "VARCHAR",
				"is_nullable":    "YES",
				"column_default": "'guest@example.com'",
			},
		},
		[]map[string]interface{}{
			{
				"constraint_name":         "events_pkey",
				"constraint_type":         "PRIMARY KEY",
				"constraint_column_names": "[id]",
			},
			{
				"constraint_name":         "events_email_key",
				"constraint_type":         "UNIQUE",
				"constraint_column_names": "[email]",
			},
		},
	)

	if len(columns) != 2 {
		t.Fatalf("unexpected column count: %d", len(columns))
	}
	if columns[0].Name != "id" || columns[0].Key != "PRI" {
		t.Fatalf("主键列未正确标记: %+v", columns[0])
	}
	if columns[1].Name != "email" || columns[1].Key != "UNI" {
		t.Fatalf("唯一键列未正确标记: %+v", columns[1])
	}
	if columns[1].Default == nil || *columns[1].Default != "'guest@example.com'" {
		t.Fatalf("默认值未保留: %+v", columns[1])
	}
}

func TestBuildDuckDBColumnDefinitions_SupportsArrayConstraintColumns(t *testing.T) {
	t.Parallel()

	columns := buildDuckDBColumnDefinitions(
		[]map[string]interface{}{
			{
				"column_name": "id",
				"data_type":   "BIGINT",
				"is_nullable": "NO",
			},
			{
				"column_name": "tenant_id",
				"data_type":   "BIGINT",
				"is_nullable": "NO",
			},
			{
				"column_name": "slug",
				"data_type":   "VARCHAR",
				"is_nullable": "NO",
			},
		},
		[]map[string]interface{}{
			{
				"constraint_name":         "events_pkey",
				"constraint_type":         "PRIMARY KEY",
				"constraint_column_names": []interface{}{"id", "tenant_id"},
			},
			{
				"constraint_name":         "events_slug_key",
				"constraint_type":         "UNIQUE",
				"constraint_column_names": []string{"slug"},
			},
		},
	)

	if len(columns) != 3 {
		t.Fatalf("unexpected column count: %d", len(columns))
	}
	if columns[0].Key != "PRI" || columns[1].Key != "PRI" {
		t.Fatalf("复合主键列未正确标记: %+v", columns)
	}
	if columns[2].Key != "UNI" {
		t.Fatalf("唯一键列未正确标记: %+v", columns[2])
	}
}

func TestBuildDuckDBIndexDefinitions_MergesConstraintsAndUniqueIndexes(t *testing.T) {
	t.Parallel()

	indexes := buildDuckDBIndexDefinitions(
		[]map[string]interface{}{
			{
				"constraint_name":         "events_pkey",
				"constraint_type":         "PRIMARY KEY",
				"constraint_column_names": "[id]",
			},
			{
				"constraint_name":         "events_business_key",
				"constraint_type":         "UNIQUE",
				"constraint_column_names": "[email, region]",
			},
		},
		[]map[string]interface{}{
			{
				"index_name":  "idx_events_slug",
				"is_unique":   true,
				"expressions": "[slug]",
			},
		},
	)

	if len(indexes) != 4 {
		t.Fatalf("unexpected index row count: %d", len(indexes))
	}
	if indexes[0].Name != "events_pkey" || indexes[0].ColumnName != "id" || indexes[0].NonUnique != 0 {
		t.Fatalf("主键索引映射异常: %+v", indexes[0])
	}
	if indexes[1].Name != "events_business_key" || indexes[1].ColumnName != "email" || indexes[1].SeqInIndex != 1 {
		t.Fatalf("约束唯一索引首列映射异常: %+v", indexes[1])
	}
	if indexes[2].Name != "events_business_key" || indexes[2].ColumnName != "region" || indexes[2].SeqInIndex != 2 {
		t.Fatalf("约束唯一索引次列映射异常: %+v", indexes[2])
	}
	if indexes[3].Name != "idx_events_slug" || indexes[3].ColumnName != "slug" || indexes[3].NonUnique != 0 || indexes[3].IndexType != "INDEX" {
		t.Fatalf("显式唯一索引映射异常: %+v", indexes[3])
	}
}

func TestBuildDuckDBIndexDefinitions_SupportsArrayMetadataRows(t *testing.T) {
	t.Parallel()

	indexes := buildDuckDBIndexDefinitions(
		[]map[string]interface{}{
			{
				"constraint_name":         "events_business_key",
				"constraint_type":         "UNIQUE",
				"constraint_column_names": []interface{}{"tenant_id", "slug"},
			},
		},
		[]map[string]interface{}{
			{
				"index_name":  "idx_events_expr",
				"is_unique":   true,
				"expressions": []string{`lower("slug")`},
			},
		},
	)

	if len(indexes) != 3 {
		t.Fatalf("unexpected index row count: %d", len(indexes))
	}
	if indexes[0].Name != "events_business_key" || indexes[0].ColumnName != "tenant_id" || indexes[0].SeqInIndex != 1 {
		t.Fatalf("约束唯一索引首列映射异常: %+v", indexes[0])
	}
	if indexes[1].Name != "events_business_key" || indexes[1].ColumnName != "slug" || indexes[1].SeqInIndex != 2 {
		t.Fatalf("约束唯一索引次列映射异常: %+v", indexes[1])
	}
	if indexes[2].Name != "idx_events_expr" || indexes[2].ColumnName != `lower("slug")` || indexes[2].NonUnique != 0 {
		t.Fatalf("表达式唯一索引映射异常: %+v", indexes[2])
	}
}

func TestNormalizeDuckDBObjectPath_PreservesCatalogSchemaAndQuotedDots(t *testing.T) {
	t.Parallel()

	path := normalizeDuckDBObjectPath(`"analytics.catalog"."main.schema"`, `"daily.events"."2026.06"`)
	if path.Catalog != "analytics.catalog" || path.Schema != "daily.events" || path.Object != "2026.06" {
		t.Fatalf("unexpected duckdb path: %+v", path)
	}

	qualified := normalizeDuckDBObjectPath(`analytics`, `"main.schema"."daily.events"`)
	if qualified.Catalog != "analytics" || qualified.Schema != "main.schema" || qualified.Object != "daily.events" {
		t.Fatalf("unexpected duckdb qualified path without catalog: %+v", qualified)
	}
}

func TestNormalizeDuckDBObjectPath_DoesNotTreatMainDatabaseAsExternalCatalog(t *testing.T) {
	t.Parallel()

	path := normalizeDuckDBObjectPath("main", "main.events")
	if path.Catalog != "" || path.Schema != "main" || path.Object != "events" {
		t.Fatalf("unexpected duckdb main path: %+v", path)
	}

	memoryPath := normalizeDuckDBObjectPath("memory", "main.events")
	if memoryPath.Catalog != "" || memoryPath.Schema != "main" || memoryPath.Object != "events" {
		t.Fatalf("unexpected duckdb memory path: %+v", memoryPath)
	}
}

func TestNormalizeDuckDBObjectPath_TracksExplicitQualification(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		dbName    string
		tableName string
		explicit  bool
	}{
		{name: "plain table", tableName: "events", explicit: false},
		{name: "schema argument", dbName: "main", tableName: "events", explicit: true},
		{name: "qualified schema", tableName: "analytics.events", explicit: true},
		{name: "catalog and schema", dbName: "analytics", tableName: "main.events", explicit: true},
		{name: "quoted qualified name", tableName: `"analytics.schema"."daily.events"`, explicit: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			path := normalizeDuckDBObjectPath(tc.dbName, tc.tableName)
			if path.ExplicitlyQualified != tc.explicit {
				t.Fatalf("normalizeDuckDBObjectPath(%q, %q) explicit=%v, want %v: %+v", tc.dbName, tc.tableName, path.ExplicitlyQualified, tc.explicit, path)
			}
		})
	}
}

func TestBuildDuckDBCreateStatementQueryCandidates_DoesNotDropExplicitSchema(t *testing.T) {
	t.Parallel()

	queries := buildDuckDBCreateStatementQueryCandidates(duckDBObjectPath{
		Schema:              "missing",
		Object:              "events",
		ExplicitlyQualified: true,
	})

	if len(queries) != 2 {
		t.Fatalf("explicit schema query count = %d, want 2: %#v", len(queries), queries)
	}
	if !duckDBTestContainsQuery(queries, "SELECT sql FROM duckdb_tables() WHERE table_name = 'events' AND schema_name = 'missing' LIMIT 1") {
		t.Fatalf("explicit schema query missing: %#v", queries)
	}
	if !duckDBTestContainsQuery(queries, `SHOW CREATE TABLE "missing"."events"`) {
		t.Fatalf("qualified SHOW CREATE query missing: %#v", queries)
	}
	if duckDBTestContainsQuery(queries, "SELECT sql FROM duckdb_tables() WHERE table_name = 'events' LIMIT 1") {
		t.Fatalf("explicit schema unexpectedly falls back to an unqualified query: %#v", queries)
	}
}

func TestBuildDuckDBCreateStatementQueryCandidates_DoesNotDropExplicitCatalog(t *testing.T) {
	t.Parallel()

	queries := buildDuckDBCreateStatementQueryCandidates(duckDBObjectPath{
		Catalog:             "missing_catalog",
		Schema:              "main",
		Object:              "events",
		ExplicitlyQualified: true,
	})

	if len(queries) != 2 {
		t.Fatalf("explicit catalog query count = %d, want 2: %#v", len(queries), queries)
	}
	if !duckDBTestContainsQuery(queries, `SHOW CREATE TABLE "missing_catalog"."main"."events"`) {
		t.Fatalf("qualified catalog SHOW CREATE query missing: %#v", queries)
	}
	if !duckDBTestContainsQuery(queries, "SELECT sql FROM duckdb_tables() WHERE table_name = 'events' AND schema_name = 'main' AND database_name = 'missing_catalog' LIMIT 1") {
		t.Fatalf("explicit catalog metadata query missing: %#v", queries)
	}
	for _, query := range queries {
		if query == "SELECT sql FROM duckdb_tables() WHERE table_name = 'events' LIMIT 1" || query == "SELECT sql FROM duckdb_tables() WHERE table_name = 'events' AND schema_name = 'main' LIMIT 1" || query == `SHOW CREATE TABLE "main"."events"` {
			t.Fatalf("explicit catalog unexpectedly drops its catalog: %#v", queries)
		}
	}
}

func TestBuildDuckDBCreateStatementQueryCandidates_PreservesUnqualifiedCompatibility(t *testing.T) {
	t.Parallel()

	queries := buildDuckDBCreateStatementQueryCandidates(duckDBObjectPath{
		Schema: "main",
		Object: "events",
	})

	if !duckDBTestContainsQuery(queries, "SELECT sql FROM duckdb_tables() WHERE table_name = 'events' LIMIT 1") {
		t.Fatalf("unqualified compatibility query missing: %#v", queries)
	}
}

func TestParseDuckDBExpressionList_KeepsQuotedExpressionsIntact(t *testing.T) {
	t.Parallel()

	parts := parseDuckDBExpressionList(`["slug", lower("name.with.dot")]`)
	if len(parts) != 2 || parts[0] != `slug` || parts[1] != `lower("name.with.dot")` {
		t.Fatalf("unexpected expression list: %#v", parts)
	}
}

func TestParseDuckDBExpressionList_UnwrapsIdentifierLiterals(t *testing.T) {
	t.Parallel()

	parts := parseDuckDBExpressionList(`['"name"', '"tenant.id"', 'slug']`)
	if len(parts) != 3 || parts[0] != "name" || parts[1] != "tenant.id" || parts[2] != "slug" {
		t.Fatalf("unexpected expression list: %#v", parts)
	}

	exprParts := parseDuckDBExpressionList(`['lower("name")']`)
	if len(exprParts) != 1 || exprParts[0] != `'lower("name")'` {
		t.Fatalf("expression literal should be preserved: %#v", exprParts)
	}
}

func containsAll(source string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(source, needle) {
			return false
		}
	}
	return true
}

func duckDBTestContainsQuery(queries []string, target string) bool {
	for _, query := range queries {
		if query == target {
			return true
		}
	}
	return false
}
