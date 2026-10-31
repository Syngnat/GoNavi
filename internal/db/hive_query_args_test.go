//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func TestHiveBindArgsSkipsLiteralsAndComments(t *testing.T) {
	query := "/* comment ? */ SELECT * FROM `t?` WHERE note = '?' AND id = ? AND active = ? AND tag = ?"
	args := []any{42, true, "O'Reilly"}
	want := "/* comment ? */ SELECT * FROM " + "`t?`" + ` WHERE note = '?' AND id = 42 AND active = TRUE AND tag = 'O\'Reilly'`
	got, err := hiveBindArgs(query, args)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("hiveBindArgs = %q, want %q", got, want)
	}
}

func TestHiveArgLiteralTypes(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  string
	}{
		{name: "nil", value: nil, want: "NULL"},
		{name: "bool", value: true, want: "TRUE"},
		{name: "int", value: int64(42), want: "42"},
		{name: "unsigned", value: uint64(7), want: "7"},
		{name: "float", value: 1.5, want: "1.5"},
		{name: "json number", value: json.Number("9007199254740993"), want: "9007199254740993"},
		{name: "bytes", value: []byte{0x00, 0xff}, want: "unhex('00ff')"},
		{name: "time", value: time.Date(2026, 10, 26, 12, 34, 56, 0, time.UTC), want: "CAST('2026-10-26 12:34:56' AS TIMESTAMP)"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := hiveArgLiteral(test.value)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("hiveArgLiteral(%#v) = %q, want %q", test.value, got, test.want)
			}
		})
	}
}

func TestHiveArgLiteralRejectsUnsafeValues(t *testing.T) {
	if _, err := hiveArgLiteral(math.NaN()); err == nil {
		t.Fatal("NaN argument accepted")
	}
	if _, err := hiveArgLiteral(math.Inf(1)); err == nil {
		t.Fatal("Inf argument accepted")
	}
	if _, err := hiveArgLiteral(json.Number("1; DROP TABLE x")); err == nil {
		t.Fatal("non-numeric json.Number accepted")
	}
	if _, err := hiveArgLiteral(struct{}{}); err == nil {
		t.Fatal("unsupported argument type accepted")
	}
	text, err := hiveArgLiteral("a${b}")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "decode(unhex(") || strings.Contains(text, "${b}") {
		t.Fatalf("variable substitution was not neutralized: %q", text)
	}
}

func TestHiveBindArgsRejectsPlaceholderMismatch(t *testing.T) {
	if _, err := hiveBindArgs("SELECT ?, ?", []any{1}); err == nil {
		t.Fatal("too few arguments accepted")
	}
	if _, err := hiveBindArgs("SELECT ?", []any{1, 2}); err == nil {
		t.Fatal("too many arguments accepted")
	}
}

func TestNormalizeHiveStatementTrimsTrailingTerminator(t *testing.T) {
	if got := normalizeHiveStatement("  SELECT 1; \t\r\n"); got != "SELECT 1" {
		t.Fatalf("normalizeHiveStatement = %q", got)
	}
	if got := normalizeHiveStatement("SELECT ';'"); got != "SELECT ';'" {
		t.Fatalf("string literal terminator was trimmed: %q", got)
	}
}
