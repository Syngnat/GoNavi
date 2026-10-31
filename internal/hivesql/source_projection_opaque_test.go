package hivesql

import "testing"

func TestDirectSourceProjectionKeepsOpaqueScalarPositions(t *testing.T) {
	projection, ok := DirectSourceProjection("SELECT id AS verified_id, hex(bytes) AS verified_hex, payload AS verified_payload FROM analytics.events ORDER BY id")
	if !ok || projection.Database != "analytics" || projection.Table != "events" || len(projection.Columns) != 3 {
		t.Fatalf("mixed scalar/complex projection rejected: %+v %v", projection, ok)
	}
	if projection.Columns[0].Opaque || projection.Columns[0].Name != "id" || projection.Columns[0].Alias != "verified_id" {
		t.Fatalf("direct column lost: %+v", projection.Columns[0])
	}
	if !projection.Columns[1].Opaque || projection.Columns[1].Alias != "verified_hex" {
		t.Fatalf("scalar expression not recorded as opaque: %+v", projection.Columns[1])
	}
	if projection.Columns[2].Opaque || projection.Columns[2].Name != "payload" {
		t.Fatalf("complex source column lost: %+v", projection.Columns[2])
	}
}

func TestDirectSourceProjectionAcceptsAggregatesButNotMixedWildcards(t *testing.T) {
	if _, ok := DirectSourceProjection("SELECT count(*) AS c, payload FROM events"); !ok {
		t.Fatal("aggregate over the single base table must stay provable")
	}
	for _, query := range []string{
		"SELECT payload, FROM events",
		"SELECT map('x', 1) AS payload FROM events",
	} {
		if _, ok := DirectSourceProjection(query); ok {
			t.Fatalf("unprovable projection accepted: %s", query)
		}
	}
}
