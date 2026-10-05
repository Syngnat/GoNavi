package db

import (
	"strings"
	"testing"
)

func TestParseDocumentRESTRequestsSplitsScripts(t *testing.T) {
	requests, ok := parseDocumentRESTRequests("POST /indexes\n{\n  \"uid\": \"movies\"\n}\n\nPATCH /indexes/movies/settings\n{\"sortableAttributes\": [\"year\"]}")
	if !ok || len(requests) != 2 {
		t.Fatalf("requests = %#v, ok = %v", requests, ok)
	}
	if requests[0].method != "POST" || string(requests[0].body) != "{\n  \"uid\": \"movies\"\n}" {
		t.Fatalf("first request = %#v", requests[0])
	}
	if requests[1].method != "PATCH" || requests[1].path != "/indexes/movies/settings" {
		t.Fatalf("second request = %#v", requests[1])
	}
	if _, ok := parseDocumentRESTRequests(`SELECT * FROM movies`); ok {
		t.Fatal("SELECT is not a REST request")
	}
}

func TestDocumentRESTRowsExpandsListsAndJSONLines(t *testing.T) {
	rows, columns := documentRESTRows([]byte(`{"results":[{"id":2,"title":"b","_score":1},{"id":1,"genre":"x"}],"total":2}`), []string{"title"}, nil, "results", "hits")
	if strings.Join(columns, ",") != "title,id,genre,_score" || len(rows) != 2 || rows[1]["title"] != nil {
		t.Fatalf("columns = %v rows = %v", columns, rows)
	}
	rows, columns = documentRESTRows([]byte(`{"id":"1","n":1}`+"\n"+`{"id":"2"}`+"\n"), nil, nil)
	if strings.Join(columns, ",") != "id,n" || len(rows) != 2 || rows[1]["n"] != nil {
		t.Fatalf("JSON Lines columns = %v rows = %v", columns, rows)
	}
	rows, columns = documentRESTRows([]byte("not json"), nil, nil)
	if len(columns) != 1 || rows[0]["response"] != "not json" {
		t.Fatalf("plain text = %v", rows)
	}
}
