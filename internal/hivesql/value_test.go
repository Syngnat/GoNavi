package hivesql

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHiveTypeParsing(t *testing.T) {
	cases := []struct{ input, want string }{{" string ", "STRING"}, {"decimal(38,18)", "DECIMAL(38,18)"}, {"array<map<string,struct<x:int,y:decimal(10,2)>>>", "ARRAY<MAP<STRING,STRUCT<" + QuoteIdentifier("x") + ":INT," + QuoteIdentifier("y") + ":DECIMAL(10,2)>>>"}, {"timestamp with local time zone", "TIMESTAMP WITH LOCAL TIME ZONE"}}
	for _, test := range cases {
		t.Run(test.input, func(t *testing.T) {
			got, err := NormalizeType(test.input)
			if err != nil || got != test.want {
				t.Fatalf("NormalizeType = %q, %v; want %q", got, err, test.want)
			}
		})
	}
	for _, input := range []string{"string);DROP TABLE t", "decimal(39,1)", "decimal(2,3)", "char(256)", "varchar(0)", "array<string", "struct<x:int,X:bigint>", "map<array<int>,string>", strings.Repeat("array<", 34) + "int" + strings.Repeat(">", 34)} {
		t.Run("reject/"+input, func(t *testing.T) {
			if _, err := ParseType(input); err == nil {
				t.Fatal("expected invalid type")
			}
		})
	}
}

func TestHiveValueScalars(t *testing.T) {
	cases := []struct {
		name, kind string
		value      any
		want       string
	}{
		{"quoted", "string", "a'\\\n\x00", "'a\\'\\\\\\n\\0'"},
		{"binary", "binary", []byte{0, 255}, "unhex('00ff')"},
		{"hex", "binary", "0x00ff", "unhex('00ff')"},
		{"bigint", "bigint", json.Number("9223372036854775807"), "CAST(9223372036854775807 AS BIGINT)"},
		{"decimal", "decimal(38,4)", json.Number("123456789012345678901234567890.1234"), "CAST('123456789012345678901234567890.1234' AS DECIMAL(38,4))"},
		{"exponent", "decimal(10,4)", "1.23e-2", "CAST('0.0123' AS DECIMAL(10,4))"},
		{"boolean", "boolean", false, "FALSE"},
		{"null", "array<int>", nil, "CAST(NULL AS ARRAY<INT>)"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := Value(test.kind, test.value)
			if err != nil || got != test.want {
				t.Fatalf("Value=%q,%v want=%q", got, err, test.want)
			}
		})
	}
	rejects := []struct {
		kind  string
		value any
	}{{"bigint", "9223372036854775808"}, {"int", "1 OR 1=1"}, {"tinyint", 128}, {"decimal(4,2)", "123.45"}, {"decimal(8,2)", 0.1}, {"boolean", "maybe"}, {"binary", "0xz1"}, {"date", "2025-02-30"}, {"array<int>", "[1] trailing"}, {"struct<x:int>", "{}"}, {"string", map[string]any{"x": 1}}}
	for _, test := range rejects {
		t.Run("reject/"+test.kind, func(t *testing.T) {
			if _, err := Value(test.kind, test.value); err == nil {
				t.Fatal("expected invalid value")
			}
		})
	}
}

func TestHiveValueCollections(t *testing.T) {
	cases := []struct {
		kind  string
		value any
		want  string
	}{
		{"array<bigint>", "[9223372036854775807,null]", "CAST(array(CAST(9223372036854775807 AS BIGINT), CAST(NULL AS BIGINT)) AS ARRAY<BIGINT>)"},
		{"map<string,decimal(5,2)>", "{\"b\":\"2.20\",\"a\":\"1.10\"}", "CAST(map('a', CAST('1.10' AS DECIMAL(5,2)), 'b', CAST('2.20' AS DECIMAL(5,2))) AS MAP<STRING,DECIMAL(5,2)>)"},
		{"struct<x:int>", "{\"x\":1}", "CAST(named_struct('x', CAST(1 AS INT)) AS STRUCT<" + QuoteIdentifier("x") + ":INT>)"},
		{"array<string>", "[]", "CAST(array() AS ARRAY<STRING>)"},
	}
	for _, test := range cases {
		t.Run(test.kind, func(t *testing.T) {
			got, err := Value(test.kind, test.value)
			if err != nil || got != test.want {
				t.Fatalf("Value=%q,%v want=%q", got, err, test.want)
			}
		})
	}
}

func TestHiveIdentifierQuoting(t *testing.T) {
	quotedName := QuoteIdentifier("t" + string(rune(96)) + "name")
	got := QuoteTable(QuoteIdentifier("db.with.dot") + "." + quotedName)
	want := QuoteIdentifier("db.with.dot") + "." + quotedName
	if got != want {
		t.Fatalf("quote=%q want=%q", got, want)
	}
	for _, name := range []string{"a.b.c", "a;drop", "a.", ""} {
		if _, err := SplitTable(name); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
}
