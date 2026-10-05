package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestAdaptCockroachDefaultForPostgresTargets(t *testing.T) {
	text := func(value string) *string { return &value }

	col, warning := adaptCockroachDefault(connection.ColumnDefinition{Name: "id", Default: text("unique_rowid()")}, false)
	if col.Default != nil || !strings.Contains(warning, "unique_rowid") {
		t.Fatalf("unique_rowid should be dropped with a warning: %+v %q", col.Default, warning)
	}
	col, warning = adaptCockroachDefault(connection.ColumnDefinition{Name: "name", Default: text("'n/a':::STRING")}, false)
	if warning != "" || col.Default == nil || *col.Default != "'n/a'" {
		t.Fatalf("type annotation should be stripped: %v %q", col.Default, warning)
	}
	col, _ = adaptCockroachDefault(connection.ColumnDefinition{Name: "at", Default: text("now():::TIMESTAMPTZ")}, false)
	if col.Default == nil || *col.Default != "now()" {
		t.Fatalf("now() annotation should be stripped: %v", col.Default)
	}
	col, warning = adaptCockroachDefault(connection.ColumnDefinition{Name: "id", Default: text("unique_rowid()")}, true)
	if warning != "" || col.Default == nil || *col.Default != "unique_rowid()" {
		t.Fatalf("CockroachDB targets keep unique_rowid: %v %q", col.Default, warning)
	}
}

func TestBuildPGLikeColumnDefinitionsDropCockroachOnlyDefaults(t *testing.T) {
	rowid := "unique_rowid()"
	def, warnings := buildPGLikeToPGLikeColumnDefinition(connection.ColumnDefinition{Name: "id", Type: "bigint", Nullable: "NO", Default: &rowid}, false)
	if strings.Contains(def, "unique_rowid") || len(warnings) == 0 {
		t.Fatalf("PostgreSQL target must not reference unique_rowid: %q %v", def, warnings)
	}
	def, _ = buildPGLikeToMySQLColumnDefinition(connection.ColumnDefinition{Name: "id", Type: "bigint", Nullable: "NO", Default: &rowid})
	if strings.Contains(def, "unique_rowid") {
		t.Fatalf("MySQL target must not reference unique_rowid: %q", def)
	}
}

func TestIsExtensionInternalTrigger(t *testing.T) {
	if !isExtensionInternalTrigger("EXECUTE FUNCTION _timescaledb_functions.insert_blocker()") {
		t.Fatal("TimescaleDB insert blocker should be treated as extension internal")
	}
	if isExtensionInternalTrigger("EXECUTE FUNCTION public.audit_row()") {
		t.Fatal("user triggers must still be migrated")
	}
}

func TestIsCockroachFamilyEndpoint(t *testing.T) {
	for _, kind := range []string{"cockroachdb", "kwdb"} {
		if !isCockroachFamilyEndpoint(connection.ConnectionConfig{Type: kind}) {
			t.Fatalf("%s should be CockroachDB family", kind)
		}
	}
	if isCockroachFamilyEndpoint(connection.ConnectionConfig{Type: "postgres"}) {
		t.Fatal("postgres is not CockroachDB family")
	}
}

func TestAdaptCockroachColumnType(t *testing.T) {
	cases := map[string]string{
		"STRING":       "text",
		"string(32)":   "varchar(32)",
		"STRING[]":     "text[]",
		"BYTES":        "bytea",
		"VARBYTES(64)": "bytea",
		"INT8":         "INT8",
		"TIMESTAMPTZ":  "TIMESTAMPTZ",
	}
	for source, want := range cases {
		if got := adaptCockroachColumnType(source); got != want {
			t.Errorf("%s: got %q, want %q", source, got, want)
		}
	}
	def, _ := buildPGLikeToMySQLColumnDefinition(connection.ColumnDefinition{Name: "note", Type: "STRING"})
	if def != "text" {
		t.Fatalf("STRING should map to MySQL text, got %q", def)
	}
}
