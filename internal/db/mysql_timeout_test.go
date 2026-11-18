package db

import (
	"testing"
	"time"
)

func TestEffectiveMySQLPlanTimeout(t *testing.T) {
	fallback := 30 * time.Second
	tests := []struct {
		name string
		dsn  string
		want time.Duration
	}{
		{
			name: "dsn timeout overrides UI fallback",
			dsn:  "root:pass@tcp(127.0.0.1:3306)/app?timeout=5s",
			want: 5 * time.Second,
		},
		{
			name: "missing dsn timeout uses fallback",
			dsn:  "root:pass@tcp(127.0.0.1:3306)/app",
			want: fallback,
		},
		{
			name: "invalid dsn uses fallback",
			dsn:  "not a dsn",
			want: fallback,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := effectiveMySQLPlanTimeout(test.dsn, fallback); got != test.want {
				t.Fatalf("effectiveMySQLPlanTimeout() = %s, want %s", got, test.want)
			}
		})
	}
}
