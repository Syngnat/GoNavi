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
		{`SELECT * FROM products WHERE id = 42`, map[string]interface{}{"has_id": []interface{}{int64(42)}}},
		{`SELECT * FROM products WHERE id != 'point-1'`, map[string]interface{}{"must_not": []interface{}{map[string]interface{}{"has_id": []interface{}{"point-1"}}}}},
	}
	for _, test := range tests {
		expr, _, err := parseVectorSQLWhere(test.query)
		if err != nil {
			t.Fatalf("parseVectorSQLWhere(%q): %v", test.query, err)
		}
		if got := qdrantFilterFromExpr(expr); !reflect.DeepEqual(got, test.want) {
			t.Errorf("qdrantFilterFromExpr(%q) = %#v, want %#v", test.query, got, test.want)
		}
	}
}
