//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func TestHiveOpaqueExpressionKeepsScalarColumnsButFailsClosedForComplex(t *testing.T) {
	projection, ok := hivesql.DirectSourceProjection("SELECT id AS verified_id, hex(bytes) AS verified_hex, payload AS verified_payload FROM analytics.events")
	if !ok {
		t.Fatal("expected a provable single-table projection")
	}
	raw := []connection.ColumnDefinition{
		{Name: "verified_id", Type: "bigint"},
		{Name: "verified_hex", Type: "string"},
		{Name: "verified_payload", Type: "ARRAY"},
	}
	full := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint"},
		{Name: "bytes", Type: "binary"},
		{Name: "payload", Type: "array<int>"},
	}
	enriched, err := hiveBindSourceColumns(projection, raw, full)
	if err != nil || enriched[2].Type != "array<int>" || enriched[0].Type != "bigint" || enriched[1].Type != "string" {
		t.Fatalf("scalar expression blocked complex enrichment: %+v %v", enriched, err)
	}

	raw[2] = connection.ColumnDefinition{Name: "computed_payload", Type: "ARRAY"}
	projection.Columns[2] = hivesql.SourceColumn{Opaque: true, Alias: "computed_payload"}
	if _, err := hiveBindSourceColumns(projection, raw, full); err == nil || !strings.Contains(err.Error(), "computed expression") {
		t.Fatalf("computed complex output must fail closed: %v", err)
	}
}
