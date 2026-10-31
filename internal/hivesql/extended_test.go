package hivesql

import (
	"strings"
	"testing"
)

func TestHiveExtendedTypes(t *testing.T) {
	for raw, want := range map[string]string{"uniontype<int,string>": "UNIONTYPE<INT,STRING>", "interval_year_month": "INTERVAL YEAR TO MONTH", "interval day to second": "INTERVAL DAY TO SECOND"} {
		got, err := NormalizeType(raw)
		if err != nil || got != want {
			t.Fatalf("normalize(%q)=%q,%v", raw, got, err)
		}
	}
	for _, value := range []any{UnionValue{Tag: 1, Value: "x"}, "{\"tag\":1,\"value\":\"x\"}", "{1:\"x\"}"} {
		got, err := Value("uniontype<int,string>", value)
		if err != nil || got != "create_union(1, CAST(NULL AS INT), 'x')" {
			t.Fatalf("union=%q err=%v", got, err)
		}
	}
	for _, test := range []struct{ kind, value, want string }{{"interval_year_month", "-2-11", "INTERVAL '-2-11' YEAR TO MONTH"}, {"interval_day_time", "3 04:05:06.123456789", "INTERVAL '3 04:05:06.123456789' DAY TO SECOND"}} {
		got, err := Value(test.kind, test.value)
		if err != nil || got != test.want {
			t.Fatalf("interval=%q err=%v", got, err)
		}
	}
	for _, test := range []struct {
		kind  string
		value any
	}{{"uniontype<int,string>", "{\"2\":0}"}, {"interval_year_month", "1-12"}, {"interval_day_time", "0 24:00:00"}, {"interval_day_time", "0 00:00:00.1234567890"}} {
		if _, err := Value(test.kind, test.value); err == nil {
			t.Fatalf("accepted invalid %s value %v", test.kind, test.value)
		}
	}
}

func TestHiveValuesCannotExpandServerMacros(t *testing.T) {
	for _, kind := range []string{"STRING", "ARRAY<STRING>", "STRUCT<x:STRING>"} {
		var value any = "literal " + "$" + "{hiveconf:danger}"
		if kind == "ARRAY<STRING>" {
			value = []any{value}
		} else if kind == "STRUCT<x:STRING>" {
			value = map[string]any{"x": value}
		}
		got, err := Value(kind, value)
		if err != nil || strings.Contains(got, "$"+"{") || !strings.Contains(got, "decode(unhex(") {
			t.Fatalf("macro literal=%q err=%v", got, err)
		}
	}
}
