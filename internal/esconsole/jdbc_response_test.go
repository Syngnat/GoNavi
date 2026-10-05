package esconsole_test

import (
	"reflect"
	"testing"

	"GoNavi-Wails/internal/esconsole"
)

func TestParseJDBCResponse(t *testing.T) {
	body := []byte(`{
  "schema": [{"name": "sku", "type": "keyword"}, {"name": "qty", "alias": "quantity", "type": "integer"}, {"name": "sku", "type": "keyword"}, {"name": "price", "type": "double"}],
  "datarows": [["A-1", 3, "A-1", 9.5], ["B-2", 5, "B-2"]],
  "total": 2, "size": 2, "status": 200
}`)
	rows, columns, ok := esconsole.ParseJDBCResponse(body)
	if !ok {
		t.Fatal("jdbc response must be parsed")
	}
	if want := []string{"sku", "quantity", "sku_2", "price"}; !reflect.DeepEqual(columns, want) {
		t.Fatalf("columns = %v, want %v", columns, want)
	}
	if len(rows) != 2 || rows[0]["quantity"] != int64(3) || rows[0]["price"] != 9.5 || rows[1]["price"] != nil {
		t.Fatalf("rows = %#v", rows)
	}
	if !esconsole.IsQueryPluginRoute("/_plugins/_ppl") || esconsole.IsQueryPluginRoute("/_plugins/_sql/_explain") {
		t.Fatal("only SQL / PPL query routes are tabular")
	}
}

func TestParseJDBCResponseRejectsOtherPayloads(t *testing.T) {
	for _, body := range []string{`{"took": 1, "hits": {"hits": []}}`, `[1, 2]`, `not json`} {
		if _, _, ok := esconsole.ParseJDBCResponse([]byte(body)); ok {
			t.Fatalf("%s must fall back to raw JSON", body)
		}
	}
}
