package hivesql

import (
	"testing"
	"time"
)

func TestHiveTimestampTZNativeRendering(t *testing.T) {
	for _, text := range []string{
		"2026-10-25 10:00:00.123 UTC",
		"2026-10-25 10:00:00.000000000 UTC",
		"2026-10-25 10:00:00.120000000 Europe/London",
		"2026-10-25 10:00:00.123456789 Europe/London",
		"2026-10-25 10:00:00 Asia/Shanghai",
		"2026-10-25 10:00:00.000000001 +08:00",
	} {
		t.Run(text, func(t *testing.T) {
			got, err := Value("timestamp with local time zone", text)
			want := "CAST(" + QuoteString(text) + " AS TIMESTAMP WITH LOCAL TIME ZONE)"
			if err != nil || got != want {
				t.Fatalf("native TimestampTZ=%q, %v; want %q", got, err, want)
			}
		})
	}
}

func TestHiveTimestampTZRejectsLossyOrInvalidClocks(t *testing.T) {
	for _, text := range []string{
		"2026-10-25 10:00:00.1234567890 UTC",
		"2026-10-25T10:00:00.1234567890Z",
		"2026-10-25 10:00:00 Unknown/Region",
		"2026-10-25 10:00:00 XYZ",
		"2026-02-30 10:00:00 UTC",
		"2026-10-25 25:00:00 UTC",
		"2026-03-29 01:30:00 Europe/London",
		"2026-10-25 10:00:00 +24:00",
		"2026-10-25T10:00:00+24:00",
		"2026-10-25 10:00:00 UTC trailing",
	} {
		t.Run(text, func(t *testing.T) {
			if got, err := Value("timestamp with local time zone", text); err == nil || got != "" {
				t.Fatalf("accepted invalid TimestampTZ %q => %q, %v", text, got, err)
			}
		})
	}
}

func TestHiveOrdinaryTimestampSemanticsUnchanged(t *testing.T) {
	for _, text := range []string{"2026-10-25 10:00:00.123 UTC", "2026-10-25 10:00:00 Europe/London", "2026-10-25T10:00:00+08:00"} {
		if _, err := Value("TIMESTAMP", text); err == nil {
			t.Fatalf("ordinary TIMESTAMP silently accepted a zone: %q", text)
		}
	}
	for _, text := range []string{"2026-10-25 10:00:00.123456789", "2026-10-25T10:00:00.123456789Z"} {
		got, err := Value("TIMESTAMP", text)
		if err != nil || got != "CAST('2026-10-25 10:00:00.123456789' AS TIMESTAMP)" {
			t.Fatalf("ordinary TIMESTAMP changed: %q, %v", got, err)
		}
	}
}

func TestHiveTimestampTZPreservesInstantAndNanoseconds(t *testing.T) {
	instant := time.Date(2026, 10, 25, 10, 0, 0, 123456789, time.FixedZone("custom", 8*3600))
	for _, value := range []any{instant, "2026-10-25T10:00:00.123456789+08:00"} {
		got, err := Value("timestamp with local time zone", value)
		want := "CAST('2026-10-25 10:00:00.123456789 +08:00' AS TIMESTAMP WITH LOCAL TIME ZONE)"
		if err != nil || got != want {
			t.Fatalf("TimestampTZ=%q, %v; want %q", got, err, want)
		}
	}
}
