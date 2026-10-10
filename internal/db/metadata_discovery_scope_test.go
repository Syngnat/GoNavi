package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type metadataScopeProbe struct {
	Database
	queries           []string
	rows              []map[string]interface{}
	firstErr          error
	nativeTableCalls  int
	nativeColumnCalls int
}

func (p *metadataScopeProbe) GetTables(string) ([]string, error) {
	p.nativeTableCalls++
	return []string{"native.table"}, nil
}
func (p *metadataScopeProbe) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	p.nativeColumnCalls++
	return nil, nil
}

func (p *metadataScopeProbe) Query(sql string) ([]map[string]interface{}, []string, error) {
	p.queries = append(p.queries, sql)
	if len(p.queries) == 1 && p.firstErr != nil {
		return nil, nil, p.firstErr
	}
	return p.rows, nil, nil
}

func TestMetadataLikeLiteralEscapesRegistryPrefixes(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"_timescaledb_", "|_timescaledb|_"}, {"100%", "100|%"}, {"pipe|x", "pipe||x"}, {`back\slash`, `back\slash`}, {"业务_", "业务|_"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			if got := metadataLikeLiteral(tc.input); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMetadataScopeLegacyFallbackRemainsScoped(t *testing.T) {
	probe := &metadataScopeProbe{firstErr: errors.New("catalog unavailable"), rows: []map[string]interface{}{{"schemaname": "Public", "tablename": "order.items"}}}
	scope := &connection.MetadataDiscoveryScope{Schemas: &connection.MetadataSchemaScope{Mode: "include", Names: []string{"Public", "ORDER BY"}, CaseSensitive: true}}
	names, err := DiscoverTables(context.Background(), probe, connection.ConnectionConfig{Type: "timescaledb"}, "app", scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != `Public."order.items"` {
		t.Fatal(names)
	}
	if len(probe.queries) != 2 {
		t.Fatal(probe.queries)
	}
	for _, sql := range probe.queries {
		if !strings.Contains(sql, "IN ('Public', 'ORDER BY')") {
			t.Fatal(sql)
		}
	}
	if !strings.Contains(probe.queries[1], "NOT LIKE '|_timescaledb|_%'") {
		t.Fatal(probe.queries[1])
	}
}

func TestMetadataScopePreservesSpecializedPGCatalogs(t *testing.T) {
	for _, source := range []string{"gbase8c", "cockroachdb", "kwdb"} {
		t.Run(source, func(t *testing.T) {
			probe := &metadataScopeProbe{}
			scope := &connection.MetadataDiscoveryScope{Schemas: &connection.MetadataSchemaScope{Mode: "exclude", Names: []string{"private"}, CaseSensitive: true}}
			config := connection.ConnectionConfig{Type: source}
			if _, err := DiscoverTables(context.Background(), probe, config, "app", scope); err != nil {
				t.Fatal(err)
			}
			if _, err := DiscoverColumns(context.Background(), probe, config, "app", scope); err != nil {
				t.Fatal(err)
			}
			for _, sql := range probe.queries {
				if !strings.Contains(sql, "NOT IN ('private')") {
					t.Fatal(sql)
				}
			}
			if source == "gbase8c" {
				if !strings.Contains(probe.queries[0], "c.relkind IN ('r', 'f')") || !strings.Contains(probe.queries[0], "pg_depend") || !strings.Contains(probe.queries[1], "format_type") {
					t.Fatal(probe.queries)
				}
			} else if !strings.Contains(probe.queries[0], "TIME SERIES TABLE") {
				t.Fatal(probe.queries[0])
			}
		})
	}
}

func TestMetadataScopedColumnsPreserveIdentifierWhitespaceAndUnicode(t *testing.T) {
	probe := &metadataScopeProbe{rows: []map[string]interface{}{{"SCHEMA_NAME": "业务", "TABLE_NAME": "order.items", "COLUMN_NAME": " id ", "DATA_TYPE": "int", "COMMENT": " comment "}}}
	scope := &connection.MetadataDiscoveryScope{Schemas: &connection.MetadataSchemaScope{Mode: "include", Names: []string{"业务"}}}
	cols, err := DiscoverColumns(context.Background(), probe, connection.ConnectionConfig{Type: "sqlserver"}, "app", scope)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(probe.queries[0], "LOWER(s.name) IN (N'业务')") {
		t.Fatal(probe.queries[0])
	}
	if len(cols) != 1 || cols[0].TableName != "[业务].[order.items]" || cols[0].Name != " id " || cols[0].Comment != " comment " {
		t.Fatal(cols)
	}
}

func TestMetadataScopedQueryHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	probe := &metadataScopeProbe{}
	scope := &connection.MetadataDiscoveryScope{Schemas: &connection.MetadataSchemaScope{Mode: "include", Names: []string{"public"}}}
	_, err := DiscoverTables(ctx, probe, connection.ConnectionConfig{Type: "postgres"}, "app", scope)
	if !errors.Is(err, context.Canceled) || len(probe.queries) != 0 {
		t.Fatalf("err=%v queries=%v", err, probe.queries)
	}
}

func TestMetadataScopeKeepsNativeDiscoveryForSpecializedConnections(t *testing.T) {
	scope := &connection.MetadataDiscoveryScope{Schemas: &connection.MetadataSchemaScope{Mode: "include", Names: []string{"app"}}}
	for _, source := range []string{"custom", "dameng", "mysql", "oracle"} {
		t.Run(source, func(t *testing.T) {
			probe := &metadataScopeProbe{}
			config := connection.ConnectionConfig{Type: source, Driver: "postgres"}
			if _, err := DiscoverTables(context.Background(), probe, config, "app", scope); err != nil {
				t.Fatal(err)
			}
			if _, err := DiscoverColumns(context.Background(), probe, config, "app", scope); err != nil {
				t.Fatal(err)
			}
			if probe.nativeTableCalls != 1 || probe.nativeColumnCalls != 1 || len(probe.queries) != 0 {
				t.Fatal("sources without a schema catalog must keep the driver's native discovery")
			}
		})
	}
	probe := &metadataScopeProbe{}
	config := connection.ConnectionConfig{Type: "postgres"}
	if _, err := DiscoverTables(context.Background(), probe, config, "app", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := DiscoverColumns(context.Background(), probe, config, "app", nil); err != nil {
		t.Fatal(err)
	}
	if probe.nativeTableCalls != 1 || probe.nativeColumnCalls != 1 || len(probe.queries) != 0 {
		t.Fatal("unrestricted connections must keep the original discovery")
	}
}

func TestMetadataScopedColumnsExcludeCockroachInternalSchemas(t *testing.T) {
	for source, internal := range map[string]string{"cockroachdb": "crdb_internal", "kwdb": "kwdb_internal"} {
		t.Run(source, func(t *testing.T) {
			probe := &metadataScopeProbe{}
			scope := &connection.MetadataDiscoveryScope{Schemas: &connection.MetadataSchemaScope{Mode: "exclude", Names: []string{"private"}, CaseSensitive: true}}
			if _, err := DiscoverColumns(context.Background(), probe, connection.ConnectionConfig{Type: source}, "app", scope); err != nil {
				t.Fatal(err)
			}
			if len(probe.queries) != 1 || !strings.Contains(probe.queries[0], "'"+internal+"'") || !strings.Contains(probe.queries[0], "'pg_extension'") {
				t.Fatalf("internal schemas must stay hidden in scoped completion columns: %v", probe.queries)
			}
		})
	}
}
