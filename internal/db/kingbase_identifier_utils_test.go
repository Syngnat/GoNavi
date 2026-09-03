package db

import "testing"

func TestNormalizeKingbaseIdentCommon(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "ldf_server", want: "ldf_server"},
		{name: "quoted", in: `"ldf_server"`, want: "ldf_server"},
		{name: "escaped quoted", in: `\"ldf_server\"`, want: "ldf_server"},
		{name: "double escaped quoted", in: `\\\"ldf_server\\\"`, want: "ldf_server"},
		{name: "double quoted", in: `""ldf_server""`, want: "ldf_server"},
		{name: "backtick quoted", in: "`ldf_server`", want: "ldf_server"},
		{name: "bracket quoted", in: "[ldf_server]", want: "ldf_server"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeKingbaseIdentCommon(tt.in); got != tt.want {
				t.Fatalf("normalizeKingbaseIdentCommon(%q)=%q,want=%q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSplitKingbaseQualifiedNameCommon(t *testing.T) {
	tests := []struct {
		name       string
		in         string
		wantSchema string
		wantTable  string
	}{
		{name: "plain", in: "ldf_server.andon_events", wantSchema: "ldf_server", wantTable: "andon_events"},
		{name: "quoted", in: `"ldf_server"."andon_events"`, wantSchema: "ldf_server", wantTable: "andon_events"},
		{name: "escaped quoted", in: `\"ldf_server\".\"andon_events\"`, wantSchema: "ldf_server", wantTable: "andon_events"},
		{name: "double escaped quoted", in: `\\\"ldf_server\\\".\\\"andon_events\\\"`, wantSchema: "ldf_server", wantTable: "andon_events"},
		{name: "space around dot", in: ` "ldf_server" . "andon_events" `, wantSchema: "ldf_server", wantTable: "andon_events"},
		{name: "table only", in: "andon_events", wantSchema: "", wantTable: "andon_events"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotSchema, gotTable := splitKingbaseQualifiedNameCommon(tt.in)
			if gotSchema != tt.wantSchema || gotTable != tt.wantTable {
				t.Fatalf("splitKingbaseQualifiedNameCommon(%q)=(%q,%q),want=(%q,%q)", tt.in, gotSchema, gotTable, tt.wantSchema, tt.wantTable)
			}
		})
	}
}

func TestSplitSQLQualifiedName(t *testing.T) {
	tests := []struct {
		name       string
		in         string
		wantSchema string
		wantTable  string
	}{
		{name: "plain", in: "sales.orders", wantSchema: "sales", wantTable: "orders"},
		{name: "quoted dots", in: `"sales.schema"."order.items"`, wantSchema: "sales.schema", wantTable: "order.items"},
		{name: "escaped quoted dots", in: `\"sales.schema\".\"order.items\"`, wantSchema: "sales.schema", wantTable: "order.items"},
		{name: "quoted table only with dot", in: `"order.items"`, wantSchema: "", wantTable: "order.items"},
		{name: "backtick escaped delimiter", in: "`sales``schema`.`order``items`", wantSchema: "sales`schema", wantTable: "order`items"},
		{name: "bracket escaped delimiter", in: "[sales]]schema].[order]]items]", wantSchema: "sales]schema", wantTable: "order]items"},
		{name: "escaped quoted", in: `\"sales\".\"orders\"`, wantSchema: "sales", wantTable: "orders"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotSchema, gotTable := SplitSQLQualifiedName(tt.in)
			if gotSchema != tt.wantSchema || gotTable != tt.wantTable {
				t.Fatalf("SplitSQLQualifiedName(%q)=(%q,%q),want=(%q,%q)", tt.in, gotSchema, gotTable, tt.wantSchema, tt.wantTable)
			}
		})
	}
}

func TestSplitSQLQualifiedNamePreserveTableQuote(t *testing.T) {
	tests := []struct {
		name       string
		in         string
		wantSchema string
		wantTable  string
	}{
		{name: "quoted table only", in: "`order.items`", wantSchema: "", wantTable: "`order.items`"},
		{name: "qualified quoted table", in: "main.`order.items`", wantSchema: "main", wantTable: "`order.items`"},
		{name: "quoted schema and table", in: `"audit.schema"."order.items"`, wantSchema: "audit.schema", wantTable: `"order.items"`},
		{name: "plain qualified", in: "main.orders", wantSchema: "main", wantTable: "orders"},
		{name: "three-part quoted path", in: "`a`.`b`.`c.d`", wantSchema: "a.b", wantTable: "`c.d`"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotSchema, gotTable := SplitSQLQualifiedNamePreserveTableQuote(tt.in)
			if gotSchema != tt.wantSchema || gotTable != tt.wantTable {
				t.Fatalf("SplitSQLQualifiedNamePreserveTableQuote(%q)=(%q,%q),want=(%q,%q)", tt.in, gotSchema, gotTable, tt.wantSchema, tt.wantTable)
			}
		})
	}
}

func TestSplitSQLIdentifierPathKeepsQuotedDotsAndEscapes(t *testing.T) {
	segments := SplitSQLIdentifierPath(`"sales.schema"."order""items"`)
	if len(segments) != 2 {
		t.Fatalf("expected two identifier segments, got %#v", segments)
	}
	if segments[0].Value != "sales.schema" || !segments[0].Quoted {
		t.Fatalf("unexpected quoted schema segment: %#v", segments[0])
	}
	if segments[1].Value != `order"items` || !segments[1].Quoted {
		t.Fatalf("unexpected quoted table segment: %#v", segments[1])
	}

	segments = SplitSQLIdentifierPathForDialect(`[audit].[ id ]`, "sqlserver")
	if len(segments) != 2 || segments[1].Value != " id " || !segments[1].Quoted {
		t.Fatalf("quoted identifier whitespace was not preserved: %#v", segments)
	}
}

func TestSplitSQLIdentifierPathForDialectOnlyTreatsBracketsAsSQLServerQuotes(t *testing.T) {
	mysqlSegments := SplitSQLIdentifierPathForDialect(`[weird]]name]`, "mysql")
	if len(mysqlSegments) != 1 || mysqlSegments[0].Value != `[weird]]name]` || mysqlSegments[0].Quoted {
		t.Fatalf("mysql bracket literal parsed as %#v", mysqlSegments)
	}

	sqlServerSegments := SplitSQLIdentifierPathForDialect(`[weird]]name]`, "sqlserver")
	if len(sqlServerSegments) != 1 || sqlServerSegments[0].Value != `weird]name` || !sqlServerSegments[0].Quoted {
		t.Fatalf("sqlserver bracket identifier parsed as %#v", sqlServerSegments)
	}
}

func TestSplitSQLIdentifierPathForDialectUsesSQLiteFirstBracketClosure(t *testing.T) {
	t.Parallel()

	segments := SplitSQLIdentifierPathForDialect(`[order.items]`, "sqlite")
	if len(segments) != 1 || segments[0].Value != "order.items" || !segments[0].Quoted {
		t.Fatalf("sqlite bracketed dotted table parsed as %#v", segments)
	}

	segments = SplitSQLIdentifierPathForDialect(`main.[order.items]`, "sqlite")
	if len(segments) != 2 || segments[0].Value != "main" || segments[1].Value != "order.items" || !segments[1].Quoted {
		t.Fatalf("sqlite qualified bracketed table parsed as %#v", segments)
	}
}

func TestNormalizeSQLiteSchemaAndTableHandlesLegacySchemaPrefix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		raw        string
		wantSchema string
		wantTable  string
	}{
		{name: "bare dotted catalog name", raw: "order.items", wantSchema: "main", wantTable: "order.items"},
		{name: "bracketed catalog name", raw: "[order.items]", wantSchema: "main", wantTable: "order.items"},
		{name: "legacy schema prefix", raw: "order.[order.items]", wantSchema: "main", wantTable: "order.items"},
		{name: "explicit database prefix", raw: "main.[order.items]", wantSchema: "main", wantTable: "order.items"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			schema, table := NormalizeSQLiteSchemaAndTable("main", test.raw)
			if schema != test.wantSchema || table != test.wantTable {
				t.Fatalf("NormalizeSQLiteSchemaAndTable(%q)=(%q,%q), want (%q,%q)", test.raw, schema, table, test.wantSchema, test.wantTable)
			}
		})
	}
}

func TestIsSQLDelimitedIdentifierRejectsQualifiedPaths(t *testing.T) {
	if !IsSQLDelimitedIdentifier(`"order.items"`) {
		t.Fatal("expected one quoted dotted identifier to be delimited")
	}
	if IsSQLDelimitedIdentifier(`"main"."order.items"`) {
		t.Fatal("expected a qualified path to contain two delimited identifiers")
	}
}

func TestBuildKingbaseSearchPathCommon(t *testing.T) {
	tests := []struct {
		name    string
		in      []string
		want    string
		wantLen int
	}{
		{
			name:    "normal schemas",
			in:      []string{"ldf_server", "public"},
			want:    `"ldf_server", "public"`,
			wantLen: 2,
		},
		{
			name:    "quoted and escaped schemas should not be double quoted",
			in:      []string{`"ldf_server"`, `""bcs_barcode""`, `\"public\"`},
			want:    `"ldf_server", "bcs_barcode", "public"`,
			wantLen: 3,
		},
		{
			name:    "dedupe ignoring case and keep public fallback",
			in:      []string{"LDF_SERVER", "ldf_server", "PUBLIC"},
			want:    `"LDF_SERVER", "public"`,
			wantLen: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, parts := buildKingbaseSearchPathCommon(tt.in)
			if got != tt.want {
				t.Fatalf("buildKingbaseSearchPathCommon(%v)=%q,want=%q", tt.in, got, tt.want)
			}
			if len(parts) != tt.wantLen {
				t.Fatalf("buildKingbaseSearchPathCommon(%v) parts=%v, len=%d, wantLen=%d", tt.in, parts, len(parts), tt.wantLen)
			}
		})
	}
}
