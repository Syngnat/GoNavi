package app

import (
	"strings"
	"testing"
)

func TestSQLFileStatementSnippetRedactsDataLiterals(t *testing.T) {
	got := sqlFileStatementSnippet("INSERT INTO users(email, token) VALUES ('alice@example.com', 'secret-token-123')", 200)
	for _, secret := range []string{"alice@example.com", "secret-token-123"} {
		if strings.Contains(got, secret) {
			t.Fatalf("statement snippet leaked %q: %s", secret, got)
		}
	}
	if !strings.Contains(got, "?") {
		t.Fatalf("redacted snippet should retain diagnostic structure: %s", got)
	}
}

func TestSQLFileErrorDetailRedactsDriverValues(t *testing.T) {
	got := sanitizeSQLFileExecutionError("duplicate key value is (alice@example.com); password=secret-token-123")
	for _, secret := range []string{"alice@example.com", "secret-token-123"} {
		if strings.Contains(got, secret) {
			t.Fatalf("driver error leaked %q: %s", secret, got)
		}
	}
}

func TestSQLFileExecutionPayloadCarriesStructuredOutcome(t *testing.T) {
	cancelled := buildSQLFileExecutionPayload(12, 1, "cancelled")
	if cancelled["outcome"] != "cancelled" || cancelled["cancelled"] != true || cancelled["completed"] != false {
		t.Fatalf("unexpected cancelled payload: %#v", cancelled)
	}
	partial := buildSQLFileExecutionPayload(12, 1, "partial")
	if partial["outcome"] != "partial" || partial["completed"] != true || partial["stoppedOnError"] != false {
		t.Fatalf("unexpected partial payload: %#v", partial)
	}
}
