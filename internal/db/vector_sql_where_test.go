package db

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

type vectorWhereRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn vectorWhereRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestVectorSQLWhereConversion(t *testing.T) {
	expr, found, err := parseVectorSQLWhere(`SELECT * FROM products WHERE (category = 'book' OR price < 5) AND active != false LIMIT 10;`)
	if err != nil || !found {
		t.Fatalf("parseVectorSQLWhere() = (%#v, %v, %v)", expr, found, err)
	}

	chromaJSON, _ := json.Marshal(chromaWhereFromExpr(expr))
	for _, fragment := range []string{`"$and"`, `"$or"`, `"category":{"$eq":"book"}`, `"price":{"$lt":5}`, `"active":{"$ne":false}`} {
		if !strings.Contains(string(chromaJSON), fragment) {
			t.Errorf("Chroma filter %s missing %s", chromaJSON, fragment)
		}
	}

	qdrantJSON, _ := json.Marshal(qdrantFilterFromExpr(expr))
	for _, fragment := range []string{`"must"`, `"should"`, `"key":"category"`, `"match":{"value":"book"}`, `"range":{"lt":5}`, `"must_not"`} {
		if !strings.Contains(string(qdrantJSON), fragment) {
			t.Errorf("Qdrant filter %s missing %s", qdrantJSON, fragment)
		}
	}
}

func TestVectorSQLWhereRejectsUnsupportedSyntax(t *testing.T) {
	queries := []string{
		`SELECT * FROM products WHERE category LIKE 'book%'`,
		`SELECT * FROM products WHERE price BETWEEN 1 AND 5`,
		`SELECT * FROM products WHERE id IN (1, 2)`,
		`SELECT * FROM products WHERE category = NULL`,
		`SELECT * FROM products WHERE (active = true`,
	}
	for _, query := range queries {
		if _, found, err := parseVectorSQLWhere(query); !found || err == nil {
			t.Errorf("parseVectorSQLWhere(%q) found=%v err=%v, want explicit error", query, found, err)
		}
	}
}

func TestVectorSQLWhereStopsBeforeOrderBy(t *testing.T) {
	expr, found, err := parseVectorSQLWhere(`SELECT * FROM products WHERE category = 'book' ORDER BY id LIMIT 10`)
	if err != nil || !found {
		t.Fatalf("parseVectorSQLWhere() = (%#v, %v, %v)", expr, found, err)
	}
	want := map[string]interface{}{"category": map[string]interface{}{"$eq": "book"}}
	if got := chromaWhereFromExpr(expr); !reflect.DeepEqual(got, want) {
		t.Fatalf("where = %#v, want %#v", got, want)
	}
}

func TestVectorSQLWhereDoesNotTreatOrderFieldAsOrderBy(t *testing.T) {
	expr, found, err := parseVectorSQLWhere(`SELECT * FROM products WHERE order = 3 LIMIT 10`)
	if err != nil || !found {
		t.Fatalf("parseVectorSQLWhere() = (%#v, %v, %v)", expr, found, err)
	}
	want := map[string]interface{}{"order": map[string]interface{}{"$eq": int64(3)}}
	if got := chromaWhereFromExpr(expr); !reflect.DeepEqual(got, want) {
		t.Fatalf("where = %#v, want %#v", got, want)
	}
}

func TestVectorSQLWhereAcceptsDoubledSingleQuote(t *testing.T) {
	expr, found, err := parseVectorSQLWhere(`SELECT * FROM products WHERE name = 'O''Reilly'`)
	if err != nil || !found {
		t.Fatalf("parseVectorSQLWhere() = (%#v, %v, %v)", expr, found, err)
	}
	want := map[string]interface{}{"name": map[string]interface{}{"$eq": "O'Reilly"}}
	if got := chromaWhereFromExpr(expr); !reflect.DeepEqual(got, want) {
		t.Fatalf("where = %#v, want %#v", got, want)
	}
}

func TestQdrantIDRangePredicateIsRejected(t *testing.T) {
	parsed, ok := parseQdrantSQL(`SELECT * FROM products WHERE id > 42`)
	if !ok || parsed.WhereError == nil || !strings.Contains(parsed.WhereError.Error(), "仅支持") {
		t.Fatalf("parseQdrantSQL() = (%#v, %v), want explicit point ID range error", parsed, ok)
	}
}

func TestQdrantIDPredicatesUsePointIDFilter(t *testing.T) {
	tests := []struct {
		query string
		want  interface{}
	}{
		{`SELECT * FROM products WHERE id = 42`, map[string]interface{}{"must": []interface{}{map[string]interface{}{"has_id": []interface{}{int64(42)}}}}},
		{`SELECT * FROM products WHERE id != 'point-1'`, map[string]interface{}{"must_not": []interface{}{map[string]interface{}{"has_id": []interface{}{"point-1"}}}}},
	}
	for _, test := range tests {
		expr, _, err := parseVectorSQLWhere(test.query)
		if err != nil {
			t.Fatalf("parseVectorSQLWhere(%q): %v", test.query, err)
		}
		got := qdrantFilterFromExpr(expr)
		assertOfficialQdrantFilter(t, got)
		if !reflect.DeepEqual(got, test.want) {
			t.Errorf("qdrantFilterFromExpr(%q) = %#v, want %#v", test.query, got, test.want)
		}
	}
}

func TestQdrantWhereSingleComparisonFiltersUseMust(t *testing.T) {
	tests := []struct {
		query string
		want  interface{}
	}{
		{
			`SELECT * FROM products WHERE category = 'book'`,
			map[string]interface{}{"must": []interface{}{map[string]interface{}{"key": "category", "match": map[string]interface{}{"value": "book"}}}},
		},
		{
			`SELECT * FROM products WHERE payload.price > 10`,
			map[string]interface{}{"must": []interface{}{map[string]interface{}{"key": "price", "range": map[string]interface{}{"gt": int64(10)}}}},
		},
		{
			`SELECT * FROM products WHERE price >= 10`,
			map[string]interface{}{"must": []interface{}{map[string]interface{}{"key": "price", "range": map[string]interface{}{"gte": int64(10)}}}},
		},
		{
			`SELECT * FROM products WHERE price < 5`,
			map[string]interface{}{"must": []interface{}{map[string]interface{}{"key": "price", "range": map[string]interface{}{"lt": int64(5)}}}},
		},
		{
			`SELECT * FROM products WHERE price <= 5`,
			map[string]interface{}{"must": []interface{}{map[string]interface{}{"key": "price", "range": map[string]interface{}{"lte": int64(5)}}}},
		},
		{
			`SELECT COUNT(*) FROM products WHERE id = 1`,
			map[string]interface{}{"must": []interface{}{map[string]interface{}{"has_id": []interface{}{int64(1)}}}},
		},
		{
			`SELECT * FROM products WHERE active != false`,
			map[string]interface{}{"must_not": []interface{}{map[string]interface{}{"key": "active", "match": map[string]interface{}{"value": false}}}},
		},
	}
	for _, test := range tests {
		expr, _, err := parseVectorSQLWhere(test.query)
		if err != nil {
			t.Fatalf("parseVectorSQLWhere(%q): %v", test.query, err)
		}
		got := qdrantFilterFromExpr(expr)
		assertOfficialQdrantFilter(t, got)
		if !reflect.DeepEqual(got, test.want) {
			t.Errorf("qdrantFilterFromExpr(%q) = %#v, want %#v", test.query, got, test.want)
		}
	}
}

func TestQdrantWhereNestedMustShouldLogicIsPreserved(t *testing.T) {
	expr, found, err := parseVectorSQLWhere(`SELECT * FROM products WHERE (category = 'book' OR price < 5) AND active != false`)
	if err != nil || !found {
		t.Fatalf("parseVectorSQLWhere() = (%#v, %v, %v)", expr, found, err)
	}
	got := qdrantFilterFromExpr(expr)
	assertOfficialQdrantFilter(t, got)
	want := map[string]interface{}{
		"must": []interface{}{
			map[string]interface{}{
				"should": []interface{}{
					map[string]interface{}{"key": "category", "match": map[string]interface{}{"value": "book"}},
					map[string]interface{}{"key": "price", "range": map[string]interface{}{"lt": int64(5)}},
				},
			},
			map[string]interface{}{
				"must_not": []interface{}{
					map[string]interface{}{"key": "active", "match": map[string]interface{}{"value": false}},
				},
			},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("qdrantFilterFromExpr() = %#v, want %#v", got, want)
	}
}

func TestQdrantWhereScrollAndCountFiltersMatch(t *testing.T) {
	predicates := []string{
		`category = 'book'`,
		`price >= 10`,
		`id = 1`,
		`active != false`,
		`category = 'book' AND price < 5`,
		`active != false OR price < 5`,
	}
	for _, predicate := range predicates {
		scroll, scrollOK := parseQdrantSQL(`SELECT * FROM products WHERE ` + predicate)
		count, countOK := parseQdrantSQL(`SELECT COUNT(*) FROM products WHERE ` + predicate)
		if !scrollOK || !countOK || scroll.WhereError != nil || count.WhereError != nil {
			t.Fatalf("parseQdrantSQL(%q) scroll=(%#v, %v) count=(%#v, %v)", predicate, scroll, scrollOK, count, countOK)
		}
		assertOfficialQdrantFilter(t, scroll.Filter)
		assertOfficialQdrantFilter(t, count.Filter)
		if !reflect.DeepEqual(scroll.Filter, count.Filter) {
			t.Errorf("scroll/count filter mismatch for %q: scroll=%#v count=%#v", predicate, scroll.Filter, count.Filter)
		}
	}
}

func TestQdrantWhereFilterFromExprCoversNonConditionRoots(t *testing.T) {
	if got := qdrantFilterFromExpr(nil); got != nil {
		t.Fatalf("qdrantFilterFromExpr(nil) = %#v, want nil", got)
	}
	if got := qdrantEnsureRootFilter("not-a-filter"); got != "not-a-filter" {
		t.Fatalf("qdrantEnsureRootFilter(non-map) = %#v", got)
	}
	already := map[string]interface{}{"should": []interface{}{map[string]interface{}{"key": "category", "match": map[string]interface{}{"value": "book"}}}}
	if got := qdrantEnsureRootFilter(already); !reflect.DeepEqual(got, already) {
		t.Fatalf("qdrantEnsureRootFilter(should) = %#v, want original filter", got)
	}
	got := qdrantFilterFromExpr(vectorWhereComparison{Field: "ID", Op: ">", Value: int64(42)})
	want := map[string]interface{}{"must": []interface{}{map[string]interface{}{"key": "ID", "range": map[string]interface{}{"gt": int64(42)}}}}
	assertOfficialQdrantFilter(t, got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("id range comparison = %#v, want %#v", got, want)
	}
}

func assertOfficialQdrantFilter(t *testing.T, filter interface{}) {
	t.Helper()
	m, ok := filter.(map[string]interface{})
	if !ok {
		t.Fatalf("filter is not an object: %#v", filter)
	}
	allowed := map[string]struct{}{"must": {}, "should": {}, "must_not": {}, "min_should": {}}
	if len(m) == 0 {
		t.Fatalf("official Filter must not be empty: %#v", filter)
	}
	for key := range m {
		if _, ok := allowed[key]; !ok {
			t.Fatalf("illegal Filter root key %q in %#v", key, filter)
		}
	}
}
