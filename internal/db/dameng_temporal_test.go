//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestNormalizeDamengTemporalWriteValue(t *testing.T) {
	tests := []struct {
		name  string
		value interface{}
		want  interface{}
	}{
		{
			name:  "RFC3339 with offset becomes time",
			value: "2026-11-11T14:36:20+08:00",
			want:  "2026-11-11T14:36:20+08:00",
		},
		{
			name:  "RFC3339 without offset keeps wall clock text",
			value: "2026-11-11T14:36:20",
			want:  "2026-11-11 14:36:20",
		},
		{
			name:  "driver-compatible text unchanged",
			value: "2026-11-11 14:36:20",
			want:  "2026-11-11 14:36:20",
		},
		{
			name:  "space separated offset becomes time",
			value: "2026-11-11 14:36:20 +08:00",
			want:  "2026-11-11T14:36:20+08:00",
		},
		{
			name:  "invalid temporal text unchanged",
			value: "not-a-timestamp",
			want:  "not-a-timestamp",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := normalizeDamengTemporalWriteValue(test.value)
			if parsed, ok := got.(time.Time); ok {
				got = parsed.Format(time.RFC3339)
			}
			if got != test.want {
				t.Fatalf("normalizeDamengTemporalWriteValue(%q) = %#v, want %#v", test.value, got, test.want)
			}
		})
	}
}

func TestNormalizeDamengWriteValueUsesColumnType(t *testing.T) {
	types := map[string]string{
		"indate": "TIMESTAMP(6)",
		"memo":   "VARCHAR2(64)",
	}

	if got, ok := normalizeDamengWriteValue("INDATE", "2026-11-11T14:36:20+08:00", types).(time.Time); !ok {
		t.Fatalf("TIMESTAMP value = %#v, want time.Time", got)
	}
	raw := "2026-11-11T14:36:20+08:00"
	if got := normalizeDamengWriteValue("MEMO", raw, types); got != raw {
		t.Fatalf("VARCHAR2 value = %#v, want original text", got)
	}
}

func TestDamengDeleteBindsNormalizedTemporalLocator(t *testing.T) {
	state := &damengTransactionRecordingState{}
	dbConn := sql.OpenDB(&damengTransactionConnector{state: state})
	t.Cleanup(func() { _ = dbConn.Close() })

	damengDB := &DamengDB{conn: dbConn}
	err := damengDB.applyDamengChangesTransaction(
		context.Background(),
		`"SYSDBA"."FLOWREC"`,
		connection.ChangeSet{Deletes: []map[string]interface{}{{
			"INDATE": "2026-11-11T14:36:20+08:00",
		}}},
		false,
		map[string]string{"indate": "TIMESTAMP(6)"},
	)
	if err != nil {
		t.Fatalf("applyDamengChangesTransaction returned error: %v", err)
	}

	execArgs := state.snapshotExecArgs()
	if len(execArgs) != 1 || len(execArgs[0]) != 1 {
		t.Fatalf("captured args = %#v, want one DELETE argument", execArgs)
	}
	value, ok := execArgs[0][0].Value.(time.Time)
	if !ok {
		t.Fatalf("DELETE INDATE arg = %#v, want time.Time", execArgs[0][0].Value)
	}
	if got := value.Format(time.RFC3339); got != "2026-11-11T14:36:20+08:00" {
		t.Fatalf("DELETE INDATE arg = %q, want preserved wall clock and offset", got)
	}
}
