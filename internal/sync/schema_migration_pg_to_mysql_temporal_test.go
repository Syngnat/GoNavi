package sync

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestMapPGLikeColumnToMySQLKeepsTimestampAsDatetime(t *testing.T) {
	cases := map[string]string{
		"timestamp without time zone":    "datetime",
		"timestamp(3) without time zone": "datetime(3)",
		"timestamp with time zone":       "datetime",
		"timestamptz":                    "datetime",
		"timestamp(9)":                   "datetime(6)",
		"time without time zone":         "time",
		"time(2) without time zone":      "time(2)",
		"date":                           "date",
	}
	for source, want := range cases {
		got, _ := mapPGLikeColumnToMySQL(connection.ColumnDefinition{Name: "c", Type: source})
		if got != want {
			t.Errorf("%s: got %q, want %q", source, got, want)
		}
	}
}
