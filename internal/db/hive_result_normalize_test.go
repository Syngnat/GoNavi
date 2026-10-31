//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"testing"
)

func TestHiveNormalizePrimitiveMapResults(t *testing.T) {
	for _, test := range []struct{ name, typ, raw, want string }{
		{"integer", "MAP<INT,STRING>", `{1:"x"}`, `{"1":"x"}`},
		{"date", "MAP<DATE,STRING>", `{"2026-10-25":"day"}`, `{"2026-10-25":"day"}`},
		{"nullCell", "MAP<INT,STRING>", "null", "null"},
		{"literalString", "STRING", `{1:"x"}`, `{1:"x"}`},
		{"array", "ARRAY<MAP<INT,STRING>>", `[{1:"x"},null,{}]`, `[{"1":"x"},null,{}]`},
		{"struct", "STRUCT<m:MAP<BOOLEAN,DECIMAL(38,4)>>", `{"m":{true:123456789012345678901234567890.1234,false:null}}`, `{"m":{"false":null,"true":123456789012345678901234567890.1234}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := hiveNormalizeResultCell(test.raw, test.typ)
			if err != nil || got != test.want {
				t.Fatalf("normalize=%v, %v; want %s", got, err, test.want)
			}
		})
	}
}
