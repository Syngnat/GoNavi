package db

import "testing"

func TestIsMeilisearchReadCommand(t *testing.T) {
	reads := []string{
		`SELECT * FROM "movies" WHERE "year" > '2000' LIMIT 10`,
		"GET /indexes",
		"POST /indexes/movies/search\n{\"q\": \"batman\"}",
		"POST /indexes/movies/documents/fetch\n{\"filter\": \"year > 2000\"}",
		"POST /multi-search\n{\"queries\": []}",
		"GET /indexes/movies/settings\nGET /indexes/movies/stats",
	}
	for _, statement := range reads {
		if !IsMeilisearchReadCommand(statement) {
			t.Errorf("%q must be read-only", statement)
		}
	}
	writes := []string{
		"POST /indexes/movies/documents\n[{\"id\": 1}]",
		"PATCH /indexes/movies/settings\n{\"filterableAttributes\": [\"year\"]}",
		"DELETE /indexes/movies",
		"GET /indexes/movies\nDELETE /indexes/movies/documents",
		`DROP TABLE "movies"`,
		`DELETE FROM "movies" WHERE "year" < '2000'`,
	}
	for _, statement := range writes {
		if IsMeilisearchReadCommand(statement) {
			t.Errorf("%q must be classified as a write", statement)
		}
	}
}
