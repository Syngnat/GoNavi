//go:build gonavi_full_drivers || gonavi_meilisearch_driver

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

// 实测需要真实服务：GONAVI_MEILISEARCH_TEST_URLS=http://127.0.0.1:7700,…（逗号分隔，可混合多个版本），
// GONAVI_MEILISEARCH_TEST_KEY 为 master key。

const meilisearchLiveIndex = "gonavi_movies"

type meilisearchLiveDoc struct {
	id     int
	year   int
	genre  string
	price  bool
	title  string
	hasTag bool
}

func meilisearchLiveDocuments(count int) ([]map[string]interface{}, []meilisearchLiveDoc) {
	documents := make([]map[string]interface{}, 0, count)
	facts := make([]meilisearchLiveDoc, 0, count)
	genres := []string{"a", "b", "c"}
	for i := 1; i <= count; i++ {
		document := map[string]interface{}{
			"id":    i,
			"title": fmt.Sprintf("title %d 标题", i),
			"year":  1990 + i%35,
			"genre": genres[i%3],
		}
		fact := meilisearchLiveDoc{id: i, year: 1990 + i%35, genre: genres[i%3], title: document["title"].(string)}
		if i%5 == 0 {
			document["tags"] = []string{}
		} else {
			document["tags"] = []string{"t" + strconv.Itoa(i%4)}
			fact.hasTag = true
		}
		if i%7 != 0 {
			document["price"] = float64(i) * 0.5
			fact.price = true
		}
		if i%11 == 0 {
			document["meta"] = nil
		} else {
			document["meta"] = map[string]interface{}{"rank": i % 10}
		}
		documents = append(documents, document)
		facts = append(facts, fact)
	}
	return documents, facts
}

func TestMeilisearchLiveSmoke(t *testing.T) {
	addresses := strings.TrimSpace(os.Getenv("GONAVI_MEILISEARCH_TEST_URLS"))
	if addresses == "" {
		t.Skip("GONAVI_MEILISEARCH_TEST_URLS not set")
	}
	for _, address := range strings.Split(addresses, ",") {
		address = strings.TrimSpace(address)
		t.Run(address, func(t *testing.T) {
			parsed, err := url.Parse(address)
			if err != nil {
				t.Fatalf("parse %s: %v", address, err)
			}
			port, _ := strconv.Atoi(parsed.Port())
			client := &MeilisearchDB{}
			config := connection.ConnectionConfig{Type: "meilisearch", Host: parsed.Hostname(), Port: port, Password: os.Getenv("GONAVI_MEILISEARCH_TEST_KEY")}
			if err := client.Connect(config); err != nil {
				t.Fatalf("Connect() error = %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("Meilisearch %s, variant %s", version, variant)

			_, _ = client.Exec(`DROP TABLE "` + meilisearchLiveIndex + `"`)
			_, _ = client.Exec(`DROP TABLE "` + meilisearchLiveIndex + `_copy"`)
			defer func() {
				for _, name := range []string{meilisearchLiveIndex, meilisearchLiveIndex + "_copy"} {
					if _, err := client.Exec(`DROP TABLE "` + name + `"`); err != nil {
						t.Errorf("drop %s: %v", name, err)
					}
				}
			}()
			if _, err := client.Exec("POST /indexes\n{\"uid\": \"" + meilisearchLiveIndex + "\", \"primaryKey\": \"id\"}"); err != nil {
				t.Fatalf("create index: %v", err)
			}
			documents, facts := meilisearchLiveDocuments(2500)
			payload, _ := json.Marshal(documents)
			if affected, err := client.Exec("POST /indexes/" + meilisearchLiveIndex + "/documents\n" + string(payload)); err != nil {
				t.Fatalf("add documents: %v", err)
			} else if client.paginatedLists() && affected != 2500 {
				t.Fatalf("indexed %d documents, want 2500", affected)
			}

			tables, err := client.GetTables("default")
			if err != nil || !strings.Contains(strings.Join(tables, ","), meilisearchLiveIndex) {
				t.Fatalf("GetTables() = %v, err = %v", tables, err)
			}
			columns, err := client.GetColumns("default", meilisearchLiveIndex)
			if err != nil || columns[0].Name != "id" || columns[0].Key != "PRI" || columns[0].Type != "number" {
				t.Fatalf("GetColumns() = %+v, err = %v", columns, err)
			}

			count := func(where string) int64 {
				t.Helper()
				query := `SELECT COUNT(*) FROM "` + meilisearchLiveIndex + `"`
				if where != "" {
					query += " WHERE " + where
				}
				rows, _, err := client.Query(query)
				if err != nil {
					t.Fatalf("%s: %v", query, err)
				}
				return rows[0]["total"].(int64)
			}
			expect := func(match func(meilisearchLiveDoc) bool) int64 {
				var total int64
				for _, fact := range facts {
					if match(fact) {
						total++
					}
				}
				return total
			}
			checkCounts := func(stage string) {
				t.Helper()
				cases := []struct {
					where string
					match func(meilisearchLiveDoc) bool
				}{
					{"", func(meilisearchLiveDoc) bool { return true }},
					{`"title" LIKE '%7%'`, func(f meilisearchLiveDoc) bool { return strings.Contains(f.title, "7") }},
					{`("year" >= '2000') AND ("genre" IN ('a', 'b'))`, func(f meilisearchLiveDoc) bool { return f.year >= 2000 && f.genre != "c" }},
					{`"price" IS NULL`, func(f meilisearchLiveDoc) bool { return !f.price }},
					{`NOT ("genre" = 'c') OR ("year" BETWEEN '1995' AND '1999')`, func(f meilisearchLiveDoc) bool { return f.genre != "c" || (f.year >= 1995 && f.year <= 1999) }},
				}
				for _, item := range cases {
					if got, want := count(item.where), expect(item.match); got != want {
						t.Fatalf("%s: COUNT where %q = %d, want %d", stage, item.where, got, want)
					}
				}
				// 第一页落在搜索接口的 maxTotalHits（1000）之内，第二页超出，旧版本要改在客户端排序。
				for _, query := range []string{
					`SELECT * FROM "` + meilisearchLiveIndex + `" WHERE "genre" = 'b' ORDER BY "year" DESC, "id" ASC LIMIT 20 OFFSET 790`,
					`SELECT * FROM "` + meilisearchLiveIndex + `" ORDER BY "year" DESC, "id" ASC LIMIT 20 OFFSET 1040`,
				} {
					rows, columns, err := client.Query(query)
					if err != nil {
						t.Fatalf("%s: %s: %v", stage, query, err)
					}
					if columns[0] != "id" || len(rows) != 20 {
						t.Fatalf("%s: %s: columns = %v, %d rows", stage, query, columns, len(rows))
					}
					for i := 1; i < len(rows); i++ {
						previous, current := rows[i-1]["year"].(int64), rows[i]["year"].(int64)
						if previous < current || (previous == current && rows[i-1]["id"].(int64) > rows[i]["id"].(int64)) {
							t.Fatalf("%s: %s: rows out of order at %d: %v then %v", stage, query, i, rows[i-1], rows[i])
						}
						if strings.Contains(query, "genre") && rows[i]["genre"] != "b" {
							t.Fatalf("%s: row %v does not match the filter", stage, rows[i])
						}
					}
				}
			}
			checkCounts("client-side")

			page, _, err := client.Query(`SELECT * FROM "` + meilisearchLiveIndex + `" LIMIT 50 OFFSET 2480`)
			if err != nil || len(page) != 20 {
				t.Fatalf("last page = %d rows, err = %v", len(page), err)
			}

			if client.supportsFilter() {
				method := "PATCH"
				if !client.paginatedLists() {
					method = "POST"
				}
				settings := `{"filterableAttributes": ["year", "genre", "price", "title", "id"]`
				if client.supportsSort() {
					settings += `, "sortableAttributes": ["year", "id"]`
				}
				if _, err := client.Exec(method + " /indexes/" + meilisearchLiveIndex + "/settings\n" + settings + "}"); err != nil {
					t.Fatalf("update settings: %v", err)
				}
				checkCounts("native")
			}

			rest, _, err := client.Query("POST /indexes/" + meilisearchLiveIndex + "/search\n{\"q\": \"title 1234\", \"limit\": 3}")
			if err != nil || len(rest) == 0 || rest[0]["id"] != int64(1234) {
				t.Fatalf("search = %v, err = %v", rest, err)
			}

			changes := connection.ChangeSet{
				Deletes: []map[string]interface{}{{"id": float64(1)}, {"id": float64(2)}},
				Updates: []connection.UpdateRow{
					{Keys: map[string]interface{}{"id": float64(3)}, Values: map[string]interface{}{"year": "2099", "title": "改过的"}},
					{Keys: map[string]interface{}{"id": float64(4)}, Values: map[string]interface{}{"id": "40004"}},
				},
				Inserts: []map[string]interface{}{{"id": "50000", "title": "新文档", "year": "2001", "tags": `["x", "y"]`, "meta": nil}},
			}
			if err := client.ApplyChanges(meilisearchLiveIndex, changes); err != nil {
				t.Fatalf("ApplyChanges() error = %v", err)
			}
			if got := count(""); got != 2500-2+1 {
				t.Fatalf("count after changes = %d", got)
			}
			check := func(where string, want int64) {
				t.Helper()
				if got := count(where); got != want {
					t.Fatalf("COUNT where %s = %d, want %d", where, got, want)
				}
			}
			check(`"year" = '2099'`, 1)
			check(`"id" IN ('40004', '50000')`, 2)
			check(`"id" = '4'`, 0)
			moved, err := client.getDocument(t.Context(), meilisearchLiveIndex, 40004)
			if err != nil || moved["title"] != "title 4 标题" {
				t.Fatalf("moved document = %v, err = %v", moved, err)
			}
			if err := client.ApplyChanges(meilisearchLiveIndex, connection.ChangeSet{Inserts: []map[string]interface{}{{"id": "50000", "title": "dup"}}}); err == nil {
				t.Fatal("inserting an existing primary key must fail")
			}

			deleted, err := client.Exec(`DELETE FROM "` + meilisearchLiveIndex + `" WHERE "year" = '1990'`)
			if err != nil || deleted != expect(func(f meilisearchLiveDoc) bool { return f.year == 1990 && f.id > 4 }) {
				t.Fatalf("DELETE FROM affected %d, err = %v", deleted, err)
			}

			ddl, err := client.GetCreateStatement("default", meilisearchLiveIndex)
			if err != nil {
				t.Fatalf("GetCreateStatement() error = %v", err)
			}
			copyScript := strings.ReplaceAll(ddl, meilisearchLiveIndex, meilisearchLiveIndex+"_copy")
			if _, err := client.Exec(copyScript); err != nil {
				t.Fatalf("replaying the DDL script failed: %v\n%s", err, copyScript)
			}
			indexes, err := client.GetIndexes("default", meilisearchLiveIndex+"_copy")
			if err != nil || len(indexes) == 0 || indexes[0].Name != "PRIMARY" {
				t.Fatalf("copied index = %+v, err = %v", indexes, err)
			}
			if client.supportsFilter() && len(indexes) < 6 {
				t.Fatalf("copied index lost its settings: %+v", indexes)
			}
		})
	}
}
