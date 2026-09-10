package connection

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestQueryExecutionRecordJSONIncludesFalseDiagnosable(t *testing.T) {
	record := QueryExecutionRecord{
		SQLText:        "UPDATE users SET active = 1",
		Diagnosable:    false,
		StatementCount: 1,
	}

	payload, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	var fields map[string]any
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}
	diagnosable, ok := fields["diagnosable"]
	if !ok {
		t.Fatalf("diagnosable=false must be included in the frontend payload: %s", payload)
	}
	if value, ok := diagnosable.(bool); !ok || value {
		t.Fatalf("diagnosable must be the boolean false, got %#v", diagnosable)
	}
}

func TestQueryExecutionRecordExecutedAtHasWailsStringTSType(t *testing.T) {
	field, ok := reflect.TypeOf(QueryExecutionRecord{}).FieldByName("ExecutedAt")
	if !ok {
		t.Fatal("ExecutedAt field missing")
	}
	if field.Type != reflect.TypeOf(time.Time{}) {
		t.Fatalf("ExecutedAt type = %s, want time.Time", field.Type)
	}
	if field.Tag.Get("ts_type") != "string" {
		t.Fatalf("ExecutedAt ts_type = %q, want string so Wails does not log \"Not found: time.Time\"", field.Tag.Get("ts_type"))
	}
}
