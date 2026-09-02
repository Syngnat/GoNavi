package sync

import "testing"

func TestValidatePagedUniqueKeysMaintainsStateAcrossPages(t *testing.T) {
	seen := make(map[string]struct{})
	if err := validatePagedUniqueKeys([]map[string]interface{}{{"id": 1}}, "id", seen, "source query result"); err != nil {
		t.Fatal(err)
	}
	if err := validatePagedUniqueKeys([]map[string]interface{}{{"id": 1}}, "id", seen, "source query result"); err == nil {
		t.Fatal("duplicate key on a later page must be rejected")
	}
	if err := validatePagedUniqueKeys([]map[string]interface{}{{"id": nil}}, "id", seen, "source query result"); err == nil {
		t.Fatal("missing key on a page must be rejected")
	}
}
