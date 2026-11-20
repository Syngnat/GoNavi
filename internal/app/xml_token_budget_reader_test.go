package app

import (
	"io"
	"strings"
	"testing"
)

func TestXMLTokenBudgetReaderRejectsOversizedTextBeforeTokenMaterialization(t *testing.T) {
	reader := newXMLTokenBudgetReader(strings.NewReader("<v>123456789</v>"), 8, 64, "XML")
	_, err := io.ReadAll(reader)
	if err == nil || !strings.Contains(err.Error(), "text token") {
		t.Fatalf("oversized text error = %v", err)
	}
}

func TestXMLTokenBudgetReaderAllowsQuotedGreaterThan(t *testing.T) {
	reader := newXMLTokenBudgetReader(strings.NewReader(`<c r="A>1"><v>1</v></c>`), 8, 64, "XML")
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read quoted attribute: %v", err)
	}
	if string(data) != `<c r="A>1"><v>1</v></c>` {
		t.Fatalf("data = %q", data)
	}
}
