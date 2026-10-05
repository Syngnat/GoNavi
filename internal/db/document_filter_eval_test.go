package db

import (
	"reflect"
	"testing"
)

func documentFixtures() []map[string]interface{} {
	return []map[string]interface{}{
		{"id": int64(1), "title": "Alpha", "year": int64(1999), "tags": []interface{}{"a", "b"}, "price": 9.5, "ok": true, "meta": map[string]interface{}{"x": int64(1)}},
		{"id": int64(2), "title": "Beta 中文", "year": int64(2005), "tags": []interface{}{}, "price": int64(1), "ok": false, "meta": nil},
		{"id": "3", "title": "Gamma", "year": int64(2010)},
	}
}

func matchingDocumentIDs(t *testing.T, where string) []string {
	t.Helper()
	node, err := parseRegistryWhere(where)
	if err != nil {
		t.Fatalf("parseRegistryWhere(%q) error = %v", where, err)
	}
	ids := []string{}
	for _, document := range documentFixtures() {
		if evaluateDocumentWhere(node, document) {
			ids = append(ids, meilisearchFixtureID(document["id"]))
		}
	}
	return ids
}

func meilisearchFixtureID(value interface{}) string {
	if text, ok := value.(string); ok {
		return text
	}
	return documentText(value)
}

func TestEvaluateDocumentWhereFollowsSearchEngineSemantics(t *testing.T) {
	cases := map[string][]string{
		`"year" > '2000'`:                       {"2", "3"},
		`"title" = 'alpha'`:                     {"1"},
		`"title" LIKE '%ET%'`:                   {"2"},
		`"title" NOT LIKE 'G%'`:                 {"1", "2"},
		`"tags" = 'b'`:                          {"1"},
		`"tags" != 'b'`:                         {"2", "3"},
		`"meta" IS NULL`:                        {"2", "3"},
		`"meta.x" = '1'`:                        {"1"},
		`"ok" = 'true'`:                         {"1"},
		`"price" BETWEEN '1' AND '9.5'`:         {"1", "2"},
		`"year" IN ('1999', '2010')`:            {"1", "3"},
		`"year" NOT IN ('1999')`:                {"2", "3"},
		`"id" = '3'`:                            {"3"},
		`("year" < '2000') OR ("ok" = 'false')`: {"1", "2"},
		`NOT ("year" >= '2005')`:                {"1"},
	}
	for where, want := range cases {
		if got := matchingDocumentIDs(t, where); !reflect.DeepEqual(got, want) {
			t.Errorf("%s matched %v, want %v", where, got, want)
		}
	}
}

func TestSortDocumentsKeepsMissingValuesLast(t *testing.T) {
	documents := documentFixtures()
	keys, err := parseDocumentOrderBy(`"price" DESC, "id"`)
	if err != nil {
		t.Fatalf("parseDocumentOrderBy() error = %v", err)
	}
	sortDocuments(documents, keys)
	got := []string{}
	for _, document := range documents {
		got = append(got, meilisearchFixtureID(document["id"]))
	}
	if want := []string{"1", "2", "3"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	keys, _ = parseDocumentOrderBy(`"price" ASC`)
	sortDocuments(documents, keys)
	if first := meilisearchFixtureID(documents[0]["id"]); first != "2" || meilisearchFixtureID(documents[2]["id"]) != "3" {
		t.Fatalf("ascending order starts with %s and must keep the document without price last: %v", first, documents)
	}
}

func TestParseDocumentProjectionAndOrderBy(t *testing.T) {
	fields, all := parseDocumentProjection(`"id", title, "release date"`)
	if all || !reflect.DeepEqual(fields, []string{"id", "title", "release date"}) {
		t.Fatalf("projection = %v (all=%v)", fields, all)
	}
	if _, all := parseDocumentProjection("*"); !all {
		t.Fatal("* must select all fields")
	}
	keys, err := parseDocumentOrderBy("\"release date\" DESC, year")
	if err != nil || !reflect.DeepEqual(keys, []documentSortKey{{field: "release date", desc: true}, {field: "year"}}) {
		t.Fatalf("order by = %#v, err = %v", keys, err)
	}
	if _, err := parseDocumentOrderBy("year SIDEWAYS"); err == nil {
		t.Fatal("unknown sort direction must be rejected")
	}
}
