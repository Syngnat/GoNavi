//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 实测需要真实服务：GONAVI_TYPESENSE_TEST_URLS=http://127.0.0.1:8108,…（逗号分隔，可混合多个版本），
// GONAVI_TYPESENSE_TEST_KEY 为 admin API key。

const typesenseLiveCollection = "gonavi_books"

type typesenseLiveDoc struct {
	id     int
	year   int
	genre  string
	title  string
	rated  bool
	stored bool
}

func typesenseLiveDocuments(count int) (string, []typesenseLiveDoc) {
	var lines strings.Builder
	facts := make([]typesenseLiveDoc, 0, count)
	genres := []string{"a", "b", "c"}
	for i := 1; i <= count; i++ {
		document := map[string]interface{}{"id": strconv.Itoa(i), "title": fmt.Sprintf("书 %d 标题", i), "year": 1990 + i%35, "genre": genres[i%3]}
		fact := typesenseLiveDoc{id: i, year: 1990 + i%35, genre: genres[i%3], title: document["title"].(string)}
		if i%7 != 0 {
			document["rating"] = float64(i%10) + 0.5
			fact.rated = true
		}
		if i%5 == 0 {
			document["tags"] = []string{}
		} else {
			document["tags"] = []string{"t" + strconv.Itoa(i%4)}
		}
		if i%11 == 0 {
			document["note"] = "stored"
			fact.stored = true
		}
		line, _ := json.Marshal(document)
		lines.Write(line)
		lines.WriteByte('\n')
		facts = append(facts, fact)
	}
	return lines.String(), facts
}

func TestTypesenseLiveSmoke(t *testing.T) {
	addresses := strings.TrimSpace(os.Getenv("GONAVI_TYPESENSE_TEST_URLS"))
	if addresses == "" {
		t.Skip("GONAVI_TYPESENSE_TEST_URLS not set")
	}
	for _, address := range strings.Split(addresses, ",") {
		address = strings.TrimSpace(address)
		t.Run(address, func(t *testing.T) {
			parsed, err := url.Parse(address)
			if err != nil {
				t.Fatalf("parse %s: %v", address, err)
			}
			port, _ := strconv.Atoi(parsed.Port())
			client := &TypesenseDB{}
			config := connection.ConnectionConfig{Type: "typesense", Host: parsed.Hostname(), Port: port, Password: os.Getenv("GONAVI_TYPESENSE_TEST_KEY")}
			if err := client.Connect(config); err != nil {
				t.Fatalf("Connect() error = %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("Typesense %s, variant %s", version, variant)

			for _, name := range []string{typesenseLiveCollection, typesenseLiveCollection + "_copy"} {
				_, _ = client.Exec(`DROP TABLE "` + name + `"`)
			}
			defer func() {
				for _, name := range []string{typesenseLiveCollection, typesenseLiveCollection + "_copy"} {
					if _, err := client.Exec(`DROP TABLE "` + name + `"`); err != nil {
						t.Errorf("drop %s: %v", name, err)
					}
				}
			}()
			schema := `{"name": "` + typesenseLiveCollection + `", "default_sorting_field": "year", "fields": [
				{"name": "title", "type": "string"}, {"name": "year", "type": "int32"}, {"name": "genre", "type": "string", "facet": true},
				{"name": "rating", "type": "float", "optional": true}, {"name": "tags", "type": "string[]", "optional": true}]}`
			if _, err := client.Exec("POST /collections\n" + schema); err != nil {
				t.Fatalf("create collection: %v", err)
			}
			lines, facts := typesenseLiveDocuments(2500)
			if affected, err := client.Exec("POST /collections/" + typesenseLiveCollection + "/documents/import?action=create\n" + lines); err != nil || affected != 2500 {
				t.Fatalf("import affected %d, err = %v", affected, err)
			}

			columns, err := client.GetColumns("default", typesenseLiveCollection)
			if err != nil || columns[0].Name != "id" || columns[0].Key != "PRI" || columns[len(columns)-1].Name != "note" {
				t.Fatalf("GetColumns() = %+v, err = %v", columns, err)
			}

			count := func(where string) int64 {
				t.Helper()
				query := `SELECT COUNT(*) FROM "` + typesenseLiveCollection + `"`
				if where != "" {
					query += " WHERE " + where
				}
				rows, _, err := client.Query(query)
				if err != nil {
					t.Fatalf("%s: %v", query, err)
				}
				return rows[0]["total"].(int64)
			}
			expect := func(match func(typesenseLiveDoc) bool) int64 {
				var total int64
				for _, fact := range facts {
					if match(fact) {
						total++
					}
				}
				return total
			}
			cases := []struct {
				where string
				match func(typesenseLiveDoc) bool
			}{
				{"", func(typesenseLiveDoc) bool { return true }},
				{`"genre" = 'a'`, func(f typesenseLiveDoc) bool { return f.genre == "a" }},
				{`("year" >= '2000') AND ("genre" IN ('a', 'b'))`, func(f typesenseLiveDoc) bool { return f.year >= 2000 && f.genre != "c" }},
				{`"year" != '2001'`, func(f typesenseLiveDoc) bool { return f.year != 2001 }},
				{`("year" BETWEEN '1995' AND '1999') OR ("genre" = 'c')`, func(f typesenseLiveDoc) bool { return (f.year >= 1995 && f.year <= 1999) || f.genre == "c" }},
				{`NOT ("genre" = 'c')`, func(f typesenseLiveDoc) bool { return f.genre != "c" }},
				{`"title" = '书 7 标题'`, func(f typesenseLiveDoc) bool { return f.id == 7 }},
				{`"title" LIKE '%77%'`, func(f typesenseLiveDoc) bool { return strings.Contains(f.title, "77") }},
				{`"rating" IS NULL`, func(f typesenseLiveDoc) bool { return !f.rated }},
				{`"note" = 'stored'`, func(f typesenseLiveDoc) bool { return f.stored }},
				{`"id" IN ('5', '6', '9999')`, func(f typesenseLiveDoc) bool { return f.id == 5 || f.id == 6 }},
			}
			for _, item := range cases {
				if got, want := count(item.where), expect(item.match); got != want {
					t.Fatalf("COUNT where %q = %d, want %d", item.where, got, want)
				}
			}
			for _, query := range []string{
				`SELECT * FROM "` + typesenseLiveCollection + `" WHERE "genre" = 'b' ORDER BY "year" DESC LIMIT 300 OFFSET 230`,
				`SELECT * FROM "` + typesenseLiveCollection + `" ORDER BY "year" ASC, "rating" DESC LIMIT 40 OFFSET 1030`,
				`SELECT * FROM "` + typesenseLiveCollection + `" WHERE "title" LIKE '书 1%' ORDER BY "title" DESC LIMIT 25 OFFSET 5`,
			} {
				rows, columns, err := client.Query(query)
				if err != nil {
					t.Fatalf("%s: %v", query, err)
				}
				if columns[0] != "id" || len(rows) == 0 {
					t.Fatalf("%s: columns = %v, %d rows", query, columns, len(rows))
				}
				for i := 1; i < len(rows); i++ {
					switch {
					case strings.Contains(query, `"title" DESC`):
						if rows[i-1]["title"].(string) < rows[i]["title"].(string) {
							t.Fatalf("%s: rows out of order at %d", query, i)
						}
					case strings.Contains(query, `"year" DESC`):
						if rows[i-1]["year"].(int64) < rows[i]["year"].(int64) || rows[i]["genre"] != "b" {
							t.Fatalf("%s: rows out of order or unfiltered at %d: %v %v", query, i, rows[i-1], rows[i])
						}
					default:
						if rows[i-1]["year"].(int64) > rows[i]["year"].(int64) {
							t.Fatalf("%s: rows out of order at %d", query, i)
						}
					}
				}
			}
			if rows, _, err := client.Query(`SELECT * FROM "` + typesenseLiveCollection + `" WHERE "genre" = 'b' ORDER BY "year" DESC LIMIT 300 OFFSET 230`); err != nil || len(rows) != 300 {
				t.Fatalf("multi-page window = %d rows, err = %v", len(rows), err)
			}

			search, _, err := client.Query("GET /collections/" + typesenseLiveCollection + "/documents/search?q=" + url.QueryEscape("书 1234") + "&query_by=title&per_page=3")
			if err != nil || len(search) == 0 || search[0]["id"] != "1234" {
				t.Fatalf("search = %v, err = %v", search, err)
			}

			changes := connection.ChangeSet{
				Deletes: []map[string]interface{}{{"id": "1"}, {"id": "2"}},
				Updates: []connection.UpdateRow{
					{Keys: map[string]interface{}{"id": "3"}, Values: map[string]interface{}{"year": "2099", "title": "改过的", "tags": `["x", "y"]`}},
					{Keys: map[string]interface{}{"id": "4"}, Values: map[string]interface{}{"id": "40004"}},
				},
				Inserts: []map[string]interface{}{{"id": "50000", "title": "新文档", "year": "2001", "genre": "a", "rating": nil}},
			}
			if client.nullRemovesOptional() {
				changes.Updates = append(changes.Updates, connection.UpdateRow{Keys: map[string]interface{}{"id": "6"}, Values: map[string]interface{}{"rating": nil}})
			}
			if err := client.ApplyChanges(typesenseLiveCollection, changes); err != nil {
				t.Fatalf("ApplyChanges() error = %v", err)
			}
			if got := count(""); got != 2500-2+1 {
				t.Fatalf("count after changes = %d", got)
			}
			if got := count(`"year" = '2099'`); got != 1 {
				t.Fatalf("updated rows = %d", got)
			}
			if got := count(`"id" IN ('40004', '50000', '4')`); got != 2 {
				t.Fatalf("moved / inserted rows = %d", got)
			}
			if client.nullRemovesOptional() {
				if got, want := count(`"rating" IS NULL`), expect(func(f typesenseLiveDoc) bool { return !f.rated && f.id > 2 })+2; got != want {
					t.Fatalf("rating IS NULL after clearing = %d, want %d", got, want)
				}
			}
			if err := client.ApplyChanges(typesenseLiveCollection, connection.ChangeSet{Inserts: []map[string]interface{}{{"id": "50000", "title": "dup", "year": "1", "genre": "a"}}}); err == nil {
				t.Fatal("inserting an existing id must fail")
			}

			deleted, err := client.Exec(`DELETE FROM "` + typesenseLiveCollection + `" WHERE "year" = '1990'`)
			if want := expect(func(f typesenseLiveDoc) bool { return f.year == 1990 && f.id > 4 }); err != nil || deleted != want {
				t.Fatalf("DELETE FROM affected %d, want %d, err = %v", deleted, want, err)
			}

			ddl, err := client.GetCreateStatement("default", typesenseLiveCollection)
			if err != nil {
				t.Fatalf("GetCreateStatement() error = %v", err)
			}
			copyScript := strings.ReplaceAll(ddl, typesenseLiveCollection, typesenseLiveCollection+"_copy")
			if _, err := client.Exec(copyScript); err != nil {
				t.Fatalf("replaying the DDL script failed: %v\n%s", err, copyScript)
			}
			if _, err := client.Exec("POST /collections/" + typesenseLiveCollection + "_copy/documents/import?action=create\n" + lines); err != nil {
				t.Fatalf("import into copy: %v", err)
			}
			if truncated, err := client.Exec(`TRUNCATE TABLE "` + typesenseLiveCollection + `_copy"`); err != nil || truncated != 2500 {
				t.Fatalf("TRUNCATE affected %d, err = %v", truncated, err)
			}
		})
	}
}
