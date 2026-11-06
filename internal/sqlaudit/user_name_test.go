package sqlaudit

import (
	"testing"
	"time"
)

func TestAppendPersistsUserNameAndKeepsLegacyChainValid(t *testing.T) {
	store := openTestStore(t)

	legacy := sampleEvent("legacy-without-user", time.Now().UnixMilli())
	if err := store.Append(legacy); err != nil {
		t.Fatalf("append legacy event failed: %v", err)
	}
	attributed := sampleEvent("attributed-event", time.Now().UnixMilli()+1)
	attributed.UserName = "alice"
	if err := store.Append(attributed); err != nil {
		t.Fatalf("append attributed event failed: %v", err)
	}

	page, err := store.Query(Filter{PageSize: 10})
	if err != nil {
		t.Fatalf("query failed: %v", err)
	}
	byID := make(map[string]Event, len(page.Items))
	for _, event := range page.Items {
		byID[event.ID] = event
	}
	if got := byID["attributed-event"].UserName; got != "alice" {
		t.Fatalf("expected user name alice, got %q", got)
	}
	if got := byID["legacy-without-user"].UserName; got != "" {
		t.Fatalf("expected legacy event to keep empty user name, got %q", got)
	}

	report, err := store.VerifyIntegrity()
	if err != nil {
		t.Fatalf("VerifyIntegrity failed: %v", err)
	}
	if !report.Valid {
		t.Fatalf("expected mixed legacy/attributed chain to stay valid: %+v", report)
	}
}

func TestEventCSVIncludesUserName(t *testing.T) {
	event := sampleEvent("csv-user", 1)
	event.UserName = "bob"
	record := eventCSVRecord(event)
	header := exportCSVHeader
	if len(record) != len(header) {
		t.Fatalf("CSV record/header length mismatch: %d vs %d", len(record), len(header))
	}
	found := false
	for index, column := range header {
		if column == "userName" && record[index] == "bob" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected userName column to carry bob, header=%v record=%v", header, record)
	}
}
