package hivesql

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

type wireNamedInteger int64
type wireNamedFloat float64
type wireNamedString string

func TestNormalizePrimitiveMapKeyTypedScalars(t *testing.T) {
	for _, test := range []struct {
		name, typ string
		key       any
		want      string
	}{
		{"namedInteger", "BIGINT", wireNamedInteger(math.MaxInt64), "9223372036854775807"},
		{"namedString", "STRING", wireNamedString("01"), "01"},
		{"literalNull", "STRING", "null", "null"},
		{"unicodeReplacementLiteral", "STRING", "漢字�", "漢字�"},
		{"integerZero", "INT", "-0", "0"},
		{"negativeDecimalZero", "DECIMAL(8,2)", json.Number("-0.00"), "0"},
		{"decimalExponent", "DECIMAL(8,4)", json.Number("1.2e-2"), "0.012"},
		{"boolean", "BOOLEAN", false, "false"},
		{"timestampTZ", "TIMESTAMP WITH LOCAL TIME ZONE", "2026-10-25 10:00:00.123456789 Asia/Shanghai", "2026-10-25 10:00:00.123456789 Asia/Shanghai"},
		{"timestampNative", "TIMESTAMP", time.Date(2026, 10, 25, 10, 0, 0, 1, time.UTC), "2026-10-25 10:00:00.000000001"},
	} {
		t.Run(test.name, func(t *testing.T) {
			typ, err := ParseType(test.typ)
			if err != nil {
				t.Fatal(err)
			}
			got, err := NormalizePrimitiveMapKey(typ, test.key)
			if err != nil || got != test.want {
				t.Fatalf("key=%q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestNormalizePrimitiveMapKeyRejectsNonPrimitiveAndLossyInput(t *testing.T) {
	for _, test := range []struct {
		name, typ string
		key       any
	}{
		{"invalidUTF8", "STRING", wireNamedString(string([]byte{255}))},
		{"nonPrimitive", "STRING", struct{ Value int }{Value: 1}},
		{"namedFloatForExact", "DECIMAL(38,4)", wireNamedFloat(0.1)},
		{"fractionalInteger", "INT", json.Number("1.5")},
		{"integerOverflow", "INT", int64(math.MaxInt64)},
		{"floatOverflow", "FLOAT", "1e39"},
		{"inf", "DOUBLE", math.Inf(1)},
		{"nil", "STRING", nil},
		{"binary", "BINARY", "0x00ff"},
		{"charTooLong", "CHAR(2)", "漢字語"},
	} {
		t.Run(test.name, func(t *testing.T) {
			typ, err := ParseType(test.typ)
			if err != nil {
				t.Fatal(err)
			}
			if got, err := NormalizePrimitiveMapKey(typ, test.key); err == nil || got != "" {
				t.Fatalf("accepted lossy key: %q, %v", got, err)
			}
		})
	}
}
