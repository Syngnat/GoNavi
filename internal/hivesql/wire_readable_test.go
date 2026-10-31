package hivesql

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeReadableValuePrimitiveMapKeys(t *testing.T) {
	for _, test := range []struct{ name, typ, raw, want, sqlFragment string }{
		{"integer", "MAP<INT,STRING>", `{1:"x",-2:"y"}`, `{"-2":"y","1":"x"}`, "CAST(1 AS INT), 'x'"},
		{"bigint", "MAP<BIGINT,STRING>", `{9223372036854775807:"max",-9223372036854775808:null}`, `{"-9223372036854775808":null,"9223372036854775807":"max"}`, "CAST(9223372036854775807 AS BIGINT), 'max'"},
		{"boolean", "MAP<BOOLEAN,INT>", `{true:1,false:null}`, `{"false":null,"true":1}`, "TRUE, CAST(1 AS INT)"},
		{"decimal", "MAP<DECIMAL(38,4),STRING>", `{123456789012345678901234567890.1234:"precise",1.2000:null}`, `{"1.2":null,"123456789012345678901234567890.1234":"precise"}`, "CAST('123456789012345678901234567890.1234' AS DECIMAL(38,4))"},
		{"double", "MAP<DOUBLE,STRING>", `{1.25:"fraction",1e-10:"small"}`, `{"1.25":"fraction","1e-10":"small"}`, "CAST(1.25 AS DOUBLE), 'fraction'"},
		{"date", "MAP<DATE,STRING>", `{"2026-10-25":"day"}`, `{"2026-10-25":"day"}`, "CAST('2026-10-25' AS DATE), 'day'"},
		{"timestamp", "MAP<TIMESTAMP,INT>", `{"2026-10-25 10:00:00.123456789":1}`, `{"2026-10-25 10:00:00.123456789":1}`, "CAST('2026-10-25 10:00:00.123456789' AS TIMESTAMP)"},
		{"timestampTZ", "MAP<TIMESTAMP WITH LOCAL TIME ZONE,INT>", `{"2026-10-25 10:00:00.123 UTC":1}`, `{"2026-10-25 10:00:00.123 UTC":1}`, "CAST('2026-10-25 10:00:00.123 UTC' AS TIMESTAMP WITH LOCAL TIME ZONE)"},
		{"yearMonth", "MAP<INTERVAL YEAR TO MONTH,STRING>", `{"-2-11":"interval"}`, `{"-2-11":"interval"}`, "INTERVAL '-2-11' YEAR TO MONTH"},
		{"dayTime", "MAP<INTERVAL DAY TO SECOND,STRING>", `{"3 04:05:06.123456789":"interval"}`, `{"3 04:05:06.123456789":"interval"}`, "INTERVAL '3 04:05:06.123456789' DAY TO SECOND"},
		{"stringDigits", "MAP<STRING,STRING>", `{"01":"null","true":"NULL","null":null}`, `{"01":"null","null":null,"true":"NULL"}`, "'01', 'null'"},
		{"quotedInteger", "MAP<INT,STRING>", `{"1":"x"}`, `{"1":"x"}`, "CAST(1 AS INT), 'x'"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeReadableValue(test.typ, test.raw)
			if err != nil || got != test.want || !json.Valid([]byte(got)) {
				t.Fatalf("typed normalize=%q, %v; want %q", got, err, test.want)
			}
			literal, err := Value(test.typ, got)
			if err != nil || !strings.Contains(literal, test.sqlFragment) {
				t.Fatalf("typed SQL round trip=%q, %v; want fragment %q", literal, err, test.sqlFragment)
			}
			again, err := NormalizeReadableValue(test.typ, got)
			if err != nil || again != got {
				t.Fatalf("normalization is not idempotent: %q, %v", again, err)
			}
		})
	}
}

func TestNormalizeReadableValueNestedCollections(t *testing.T) {
	for _, test := range []struct{ name, typ, raw, want string }{
		{"arrayMap", "ARRAY<MAP<INT,STRING>>", `[ {1:"x"}, null, {} ]`, `[{"1":"x"},null,{}]`},
		{"structMap", "STRUCT<label:STRING,m:MAP<BOOLEAN,ARRAY<DECIMAL(38,4)>>>", `{"label":"null","m":{true:[123456789012345678901234567890.1234,1.2300,null],false:[]}}`, `{"label":"null","m":{"false":[],"true":[123456789012345678901234567890.1234,1.2300,null]}}`},
		{"mapStruct", "MAP<INT,STRUCT<m:MAP<INT,STRING>>>", `{1:{"m":{2:"x"}}}`, `{"1":{"m":{"2":"x"}}}`},
		{"unionMap", "UNIONTYPE<STRING,MAP<INT,STRING>>", `{1:{2:"x"}}`, `{"1":{"2":"x"}}`},
		{"arrayUnion", "ARRAY<UNIONTYPE<MAP<BOOLEAN,INT>,STRING>>", `[{0:{true:1}},{1:"literal {2:3}"},null]`, `[{"0":{"true":1}},{"1":"literal {2:3}"},null]`},
		{"literalSyntax", "MAP<STRING,STRING>", `{"{1:\"x\"}":"literal [0:\"y\"] {true:null} \\ \n \u0000"}`, `{"{1:\"x\"}":"literal [0:\"y\"] {true:null} \\ \n \u0000"}`},
		{"unicode", "MAP<STRING,STRING>", `{"\ud83d\ude00":"漢字�"}`, `{"😀":"漢字�"}`},
		{"null", "ARRAY<MAP<INT,STRING>>", "null", "null"},
		{"nullStructMembers", "STRUCT<m:MAP<INT,STRING>,n:STRING>", `{"m":null,"n":null}`, `{"m":null,"n":null}`},
		{"empty", "MAP<INT,ARRAY<STRING>>", "{}", "{}"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeReadableValue(test.typ, test.raw)
			if err != nil || got != test.want {
				t.Fatalf("normalize=%q, %v; want %q", got, err, test.want)
			}
			if _, err := Value(test.typ, got); err != nil {
				t.Fatalf("typed collection is not reusable: %v", err)
			}
		})
	}
}

func TestNormalizeReadableValueRejectsAmbiguity(t *testing.T) {
	for _, test := range []struct{ name, typ, raw string }{
		{"bareMap", "MAP", `{1:"x"}`},
		{"bareArray", "ARRAY", `[{1:"x"}]`},
		{"complexKey", "MAP<ARRAY<INT>,STRING>", `{[1]:"x"}`},
		{"nullKey", "MAP<STRING,INT>", `{null:1}`},
		{"unquotedStringKey", "MAP<STRING,INT>", `{1:1}`},
		{"quotedNumericValue", "ARRAY<INT>", `["1"]`},
		{"integerOverflow", "MAP<TINYINT,STRING>", `{128:"x"}`},
		{"decimalOverflow", "MAP<DECIMAL(4,2),INT>", `{123.45:1}`},
		{"decimalScale", "ARRAY<DECIMAL(4,2)>", `[1.234]`},
		{"nonFinite", "MAP<DOUBLE,INT>", `{NaN:1}`},
		{"invalidDate", "MAP<DATE,INT>", `{"2026-02-30":1}`},
		{"invalidBoolean", "MAP<BOOLEAN,INT>", `{1:1}`},
		{"duplicate", "MAP<INT,STRING>", `{1:"x",1:"y"}`},
		{"equivalentDecimalKeys", "MAP<DECIMAL(8,2),STRING>", `{1:"x",1.00:"y"}`},
		{"equivalentBooleanKeys", "MAP<BOOLEAN,INT>", `{true:1,"true":2}`},
		{"equivalentIntegerKeys", "MAP<INT,INT>", `{0:1,-0:2}`},
		{"duplicateStruct", "STRUCT<x:INT>", `{"x":1,"x":2}`},
		{"missingStruct", "STRUCT<x:INT>", `{}`},
		{"unknownStruct", "STRUCT<x:INT>", `{"y":1}`},
		{"invalidUnionTag", "UNIONTYPE<INT,STRING>", `{2:"x"}`},
		{"multipleUnion", "UNIONTYPE<INT,STRING>", `{0:1,1:"x"}`},
		{"trailingText", "MAP<INT,INT>", `{1:1} trailing`},
		{"trailingComma", "MAP<INT,INT>", `{1:1,}`},
		{"missingComma", "ARRAY<INT>", `[1 2]`},
		{"missingValue", "MAP<INT,INT>", `{1:}`},
		{"unpairedHighSurrogate", "MAP<STRING,INT>", `{"\ud800":1}`},
		{"unpairedLowSurrogate", "ARRAY<STRING>", `["\udfff"]`},
		{"wrongSurrogatePair", "MAP<STRING,INT>", `{"\ud800\u0041":1}`},
		{"invalidUTF8", "MAP<STRING,INT>", "{\"" + string([]byte{255}) + "\":1}"},
		{"rawControlByte", "ARRAY<STRING>", "[\"a\x00b\"]"},
		{"leadingZero", "MAP<INT,INT>", `{01:1}`},
		{"empty", "ARRAY<INT>", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got, err := NormalizeReadableValue(test.typ, test.raw); err == nil || got != "" {
				t.Fatalf("accepted ambiguous input: %q, %v", got, err)
			}
		})
	}
}

func TestNormalizeReadableValueNestedBinaryFailsClosed(t *testing.T) {
	for _, typ := range []string{"MAP<INT,BINARY>", "MAP<BINARY,STRING>", "ARRAY<BINARY>", "STRUCT<m:MAP<INT,BINARY>>", "UNIONTYPE<INT,BINARY>"} {
		for _, raw := range []string{"null", "{}", `{"1":"0x00ff"}`, `{"1":"�"}`} {
			if got, err := NormalizeReadableValue(typ, raw); err == nil || got != "" || !strings.Contains(err.Error(), "HEX/BASE64") {
				t.Fatalf("nested BINARY must fail before payload parsing: %s %q => %q, %v", typ, raw, got, err)
			}
		}
	}
	if _, err := NormalizeReadableValue("ARRAY<INT>", strings.Repeat(" ", 16<<20)+"[]"); err == nil {
		t.Fatal("accepted oversized SerDe payload")
	}
}
