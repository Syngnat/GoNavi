//go:build gonavi_full_drivers || gonavi_gbase8c_driver

package db

import (
	"net/url"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestParseGBase8cVersion(t *testing.T) {
	cases := map[string]string{
		"PostgreSQL 9.2.4 (single_node GBase8cV5 S5.0.0B28 build 51dce1ce) compiled at 2024-06-21": "5.0.0",
		"PostgreSQL 9.2.4 (GBase8cV5 S3.0.0B76 build 1d4f1b7f) compiled at 2023-05-10":             "3.0.0",
		"GBase 8c V5 3.0.0":   "3.0.0",
		"PostgreSQL 9.2.4":    "",
		"openGauss 5.0.0 ...": "",
	}
	for banner, want := range cases {
		if got := parseGBase8cVersion(banner); got != want {
			t.Errorf("parseGBase8cVersion(%q) = %q, want %q", banner, got, want)
		}
	}
}

func TestGBase8cDSNUsesGaussDBDriverScheme(t *testing.T) {
	dsn := gbase8cDSN(connection.ConnectionConfig{Host: "10.0.0.8", Port: 15400, User: "gbase", Password: "p@ss:word", Database: "sales", ConnectionParams: "application_name=gonavi&bogus=1"})
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse %q: %v", dsn, err)
	}
	password, _ := parsed.User.Password()
	if parsed.Scheme != "gaussdb" || parsed.Host != "10.0.0.8:15400" || parsed.Path != "/sales" || password != "p@ss:word" {
		t.Fatalf("unexpected dsn %q", dsn)
	}
	query := parsed.Query()
	if query.Get("application_name") != "gonavi" || query.Has("bogus") || query.Get("sslmode") == "" {
		t.Fatalf("connection params not filtered by the PostgreSQL allowlist: %q", dsn)
	}
}

func TestGBase8cSearchPathKeepsServerDefaultsFirst(t *testing.T) {
	if got := gbase8cSearchPath([]string{"sales", `odd"name`}); got != `"$user", public, "sales", "odd""name"` {
		t.Fatalf("search path %s", got)
	}
}

func TestQualifyGBase8cTableDef(t *testing.T) {
	ddl := strings.Join([]string{
		"SET search_path = sales;",
		"CREATE TABLE customers (",
		"    id integer NOT NULL",
		")",
		"WITH (orientation=row, compression=no);",
		"COMMENT ON TABLE customers IS 'c';",
		"COMMENT ON COLUMN customers.id IS 'k';",
		"CREATE INDEX idx_name ON customers USING btree (name) TABLESPACE pg_default;",
		"CREATE UNIQUE INDEX idx_other ON sales.customers USING btree (id);",
		"ALTER TABLE customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);",
		"ALTER TABLE customers_log ADD CONSTRAINT x CHECK (true);",
	}, "\n")
	want := strings.Join([]string{
		"CREATE TABLE sales.customers (",
		"    id integer NOT NULL",
		")",
		"WITH (orientation=row, compression=no);",
		"COMMENT ON TABLE sales.customers IS 'c';",
		"COMMENT ON COLUMN sales.customers.id IS 'k';",
		"CREATE INDEX idx_name ON sales.customers USING btree (name) TABLESPACE pg_default;",
		"CREATE UNIQUE INDEX idx_other ON sales.customers USING btree (id);",
		"ALTER TABLE sales.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);",
		"ALTER TABLE customers_log ADD CONSTRAINT x CHECK (true);",
	}, "\n")
	if got := qualifyGBase8cTableDef(ddl, "sales", "customers"); got != want {
		t.Fatalf("qualified ddl:\n%s\nwant:\n%s", got, want)
	}
	if got := qualifyGBase8cTableDef("SET search_path = \"My Schema\";\nCREATE TABLE \"Orders\" (\n    id integer\n);", `"My Schema"`, `"Orders"`); got != "CREATE TABLE \"My Schema\".\"Orders\" (\n    id integer\n);" {
		t.Fatalf("quoted identifiers: %s", got)
	}
}

// GBase 8c 是 PostgreSQL 9.2 内核，元数据查询不能用 9.4+ 的语法。
func TestGBase8cMetadataQueriesAvoidModernPostgresSyntax(t *testing.T) {
	queries := []string{
		buildGBase8cColumnsQuery("sales", "customers"),
		buildGBase8cIndexesQuery("sales", "customers", "indnkeyatts"),
		gbase8cUserSchemasQuery,
	}
	for _, query := range queries {
		for _, unsupported := range []string{"to_jsonb", "WITH ORDINALITY", "LATERAL"} {
			if strings.Contains(query, unsupported) {
				t.Fatalf("query uses %s:\n%s", unsupported, query)
			}
		}
	}
	if !strings.Contains(buildGBase8cIndexesQuery("s", "t", "indnatts"), "generate_series(0, ix.indnatts - 1) AS pos") {
		t.Fatal("index query should expand the requested key count column")
	}
}
