package db

import "testing"

func TestIsTypesenseReadCommand(t *testing.T) {
	reads := []string{
		`SELECT * FROM "books" WHERE "year" > '2000' LIMIT 10`,
		"GET /collections",
		"GET /collections/books/documents/search?q=*&filter_by=year:>2000",
		"GET /collections/books/documents/export",
		"POST /multi_search\n{\"searches\": []}",
	}
	for _, statement := range reads {
		if !IsTypesenseReadCommand(statement) {
			t.Errorf("%q must be read-only", statement)
		}
	}
	writes := []string{
		"POST /collections/books/documents\n{\"id\": \"1\"}",
		"POST /collections/books/documents/import?action=upsert\n{\"id\": \"1\"}\n{\"id\": \"2\"}",
		"PATCH /collections/books\n{\"fields\": []}",
		"DELETE /collections/books/documents?filter_by=year:<2000",
		"GET /collections/books\nDELETE /collections/books",
		`DROP TABLE "books"`,
		`TRUNCATE TABLE "books"`,
	}
	for _, statement := range writes {
		if IsTypesenseReadCommand(statement) {
			t.Errorf("%q must be classified as a write", statement)
		}
	}
}
