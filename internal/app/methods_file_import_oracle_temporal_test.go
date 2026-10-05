package app

import (
	"testing"
	"time"
)

func TestFormatImportSQLValueWrapsOracleTemporals(t *testing.T) {
	at := time.Date(2020, 1, 15, 8, 30, 0, 0, time.UTC)
	cases := []struct {
		dbType, columnType string
		value              interface{}
		want               string
	}{
		{"oracle", "DATE", at, "TO_DATE('2020-01-15 08:30:00', 'YYYY-MM-DD HH24:MI:SS')"},
		{"oracle", "DATE", "2020-01-15 08:30:00", "TO_DATE('2020-01-15 08:30:00', 'YYYY-MM-DD HH24:MI:SS')"},
		{"oracle", "TIMESTAMP(6)", at, "TO_TIMESTAMP('2020-01-15 08:30:00', 'YYYY-MM-DD HH24:MI:SS')"},
		{"oracle", "TIMESTAMP(6)", at.Add(1500 * time.Microsecond), "TO_TIMESTAMP('2020-01-15 08:30:00.001500', 'YYYY-MM-DD HH24:MI:SS.FF6')"},
		{"postgres", "date", "2020-01-15", "'2020-01-15'"},
	}
	for _, tc := range cases {
		if got := formatImportSQLValue(tc.dbType, tc.columnType, tc.value); got != tc.want {
			t.Errorf("%s %s %v: got %q, want %q", tc.dbType, tc.columnType, tc.value, got, tc.want)
		}
	}
}
