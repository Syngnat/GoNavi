package sync

import "testing"

func TestValidateSourceQueryUniqueKeyRowsRejectsDuplicateAndIncompleteKeys(t *testing.T) {
	if err := validateSourceQueryUniqueKeyRows([]map[string]interface{}{{"id": 1}, {"id": 1}}, []string{"id"}, "source query result"); err == nil {
		t.Fatal("duplicate source query keys must be rejected before diffing")
	}
	if err := validateSourceQueryUniqueKeyRows([]map[string]interface{}{{"id": nil}}, []string{"id"}, "target table"); err == nil {
		t.Fatal("incomplete target keys must be rejected before diffing")
	}
	if err := validateSourceQueryUniqueKeyRows([]map[string]interface{}{{"id": 1}, {"id": 2}}, []string{"id"}, "source query result"); err != nil {
		t.Fatalf("unique keys rejected: %v", err)
	}
}
