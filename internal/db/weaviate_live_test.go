//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestWeaviateLiveSmoke 连真实 Weaviate（匿名访问），覆盖建集合、网格增删改、SQL / GraphQL / REST 查询、
// 1.20 起的多租户与 1.24 起的命名向量。地址来自 GONAVI_WEAVIATE_TEST_ADDRS。
func TestWeaviateLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_WEAVIATE_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := &WeaviateDB{}
			if err := client.Connect(liveConfig(t, "weaviate", addr, "", "")); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)

			_, _ = client.Exec("DELETE /v1/schema/GonaviArticle")
			mustExec(t, client, `POST /v1/schema
{"class": "GonaviArticle", "vectorizer": "none", "properties": [
  {"name": "title", "dataType": ["text"]}, {"name": "views", "dataType": ["int"]},
  {"name": "score", "dataType": ["number"]}, {"name": "published", "dataType": ["date"]},
  {"name": "tags", "dataType": ["text[]"]}]}`)
			defer client.Exec("DELETE /v1/schema/GonaviArticle")

			ids := []string{"00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003"}
			if err := client.ApplyChanges("GonaviArticle", connection.ChangeSet{Inserts: []map[string]interface{}{
				{"_id": ids[0], "title": "Hello", "views": "10", "score": "1.5", "published": "2026-01-02", "tags": `["a","b"]`, "_vector": "[0.1, 0.2]"},
				{"_id": ids[1], "title": "World", "views": "3", "score": "2", "published": "2026-03-04T05:06:07Z", "_vector": "[0.3, 0.1]"},
				{"_id": ids[2], "title": "Help", "views": "7", "_vector": "[0.2, 0.2]"},
			}}); err != nil {
				t.Fatalf("grid insert: %v", err)
			}

			if tables, err := client.GetTables("default"); err != nil || !slices.Contains(tables, "GonaviArticle") {
				t.Fatalf("tables %v: %v", tables, err)
			}
			if columns, err := client.GetColumns("default", "GonaviArticle"); err != nil || len(columns) < 8 || columns[0].Key != "PRI" {
				t.Fatalf("columns %v: %v", columns, err)
			}
			if ddl, err := client.GetCreateStatement("default", "GonaviArticle"); err != nil || !strings.Contains(ddl, `"class": "GonaviArticle"`) {
				t.Fatalf("ddl %q: %v", ddl, err)
			}

			rows, columns, err := client.Query(`SELECT * FROM "GonaviArticle" WHERE ("views" > '5') AND ("title" LIKE 'Hel%') ORDER BY "views" DESC LIMIT 10 OFFSET 0`)
			if err != nil || len(rows) != 2 || rows[0]["_id"] != ids[0] || rows[1]["views"] != int64(7) || columns[0] != "_id" {
				t.Fatalf("filtered rows %v columns %v: %v", rows, columns, err)
			}
			for query, want := range map[string]int64{
				`SELECT COUNT(*) FROM "GonaviArticle"`:                                       3,
				`SELECT COUNT(*) FROM "GonaviArticle" WHERE "views" IN ('3', '7')`:           2,
				`SELECT COUNT(*) FROM "GonaviArticle" WHERE "score" BETWEEN '1' AND '1.9'`:   1,
				`SELECT COUNT(*) FROM "GonaviArticle" WHERE "published" >= '2026-02-01'`:     1,
				`SELECT COUNT(*) FROM "GonaviArticle" WHERE "views" NOT BETWEEN '4' AND '8'`: 2,
			} {
				rows, _, err := client.Query(query)
				if err != nil || rows[0]["total"] != want {
					t.Fatalf("%s = %v: %v", query, rows, err)
				}
			}
			if rows, _, err := client.Query(`SELECT title, _vector FROM "GonaviArticle" WHERE _id = '` + ids[1] + `'`); err != nil || len(rows) != 1 || rows[0]["title"] != "World" || rows[0]["_vector"] == nil {
				t.Fatalf("vector rows %v: %v", rows, err)
			}
			if rows, _, err := client.Query(`{ Get { GonaviArticle(where: {path: ["title"], operator: Equal, valueText: "World"}) { title _additional { id } } } }`); err != nil || len(rows) != 1 || rows[0]["_id"] != ids[1] {
				t.Fatalf("graphql rows %v: %v", rows, err)
			}
			if rows, _, err := client.Query("GET /v1/objects?class=GonaviArticle&limit=5"); err != nil || len(rows) != 3 {
				t.Fatalf("rest rows %v: %v", rows, err)
			}

			if err := client.ApplyChanges("GonaviArticle", connection.ChangeSet{Updates: []connection.UpdateRow{
				{Keys: map[string]interface{}{"_id": ids[0]}, Values: map[string]interface{}{"views": "42"}},
				{Keys: map[string]interface{}{"_id": ids[1]}, Values: map[string]interface{}{"score": nil}},
			}}); err != nil {
				t.Fatalf("grid update: %v", err)
			}
			rows, _, err = client.Query(`SELECT views, score, _vector FROM "GonaviArticle" ORDER BY "views" DESC`)
			if err != nil || rows[0]["views"] != int64(42) {
				t.Fatalf("updated rows %v: %v", rows, err)
			}
			for _, row := range rows {
				if row["views"] == int64(3) && (row["score"] != nil || row["_vector"] == nil) {
					t.Fatalf("clearing score must drop it and keep the vector: %v", row)
				}
			}
			if err := client.ApplyChanges("GonaviArticle", connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": ids[2]}}}); err != nil {
				t.Fatalf("grid delete: %v", err)
			}
			if rows, _, err := client.Query(`SELECT COUNT(*) FROM "GonaviArticle"`); err != nil || rows[0]["total"] != int64(2) {
				t.Fatalf("count after delete %v: %v", rows, err)
			}

			if client.supportsTenants() {
				liveWeaviateTenants(t, client, addr)
			}
			if client.supportsNamedVectors() {
				liveWeaviateNamedVectors(t, client)
			}
		})
	}
}

func liveWeaviateTenants(t *testing.T, client *WeaviateDB, addr string) {
	t.Helper()
	_, _ = client.Exec("DELETE /v1/schema/GonaviTenantDoc")
	mustExec(t, client, `POST /v1/schema
{"class": "GonaviTenantDoc", "vectorizer": "none", "multiTenancyConfig": {"enabled": true}, "properties": [{"name": "body", "dataType": ["text"]}]}`)
	defer client.Exec("DELETE /v1/schema/GonaviTenantDoc")
	mustExec(t, client, "POST /v1/schema/GonaviTenantDoc/tenants\n[{\"name\": \"tenantA\"}, {\"name\": \"tenantB\"}]")

	if databases, err := client.GetDatabases(); err != nil || !slices.Contains(databases, "tenantA") || databases[0] != weaviateDefaultNamespace {
		t.Fatalf("databases %v: %v", databases, err)
	}
	if tables, err := client.GetTables("tenantB"); err != nil || !slices.Contains(tables, "GonaviTenantDoc") {
		t.Fatalf("tenant tables %v: %v", tables, err)
	}
	if _, _, err := client.Query(`SELECT COUNT(*) FROM "GonaviTenantDoc"`); err == nil {
		t.Fatal("a multi-tenant collection must require a tenant")
	}

	tenant := &WeaviateDB{}
	if err := tenant.Connect(liveConfig(t, "weaviate", addr, "", "tenantA")); err != nil {
		t.Fatalf("connect tenant: %v", err)
	}
	defer tenant.Close()
	if err := tenant.ApplyChanges("GonaviTenantDoc", connection.ChangeSet{Inserts: []map[string]interface{}{{"body": "only in A"}}}); err != nil {
		t.Fatalf("tenant insert: %v", err)
	}
	rows, _, err := tenant.Query(`SELECT * FROM "GonaviTenantDoc"`)
	if err != nil || len(rows) != 1 || rows[0]["body"] != "only in A" {
		t.Fatalf("tenant rows %v: %v", rows, err)
	}
	if err := tenant.ApplyChanges("GonaviTenantDoc", connection.ChangeSet{Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": rows[0]["_id"]}, Values: map[string]interface{}{"body": "edited"}}}}); err != nil {
		t.Fatalf("tenant update: %v", err)
	}
	if rows, _, err := tenant.Query(`SELECT COUNT(*) FROM "GonaviTenantDoc" WHERE "body" = 'edited'`); err != nil || rows[0]["total"] != int64(1) {
		t.Fatalf("tenant count %v: %v", rows, err)
	}
}

func liveWeaviateNamedVectors(t *testing.T, client *WeaviateDB) {
	t.Helper()
	_, _ = client.Exec("DELETE /v1/schema/GonaviNamed")
	mustExec(t, client, `POST /v1/schema
{"class": "GonaviNamed", "properties": [{"name": "title", "dataType": ["text"]}],
 "vectorConfig": {"title_vec": {"vectorizer": {"none": {}}, "vectorIndexType": "hnsw"}, "body_vec": {"vectorizer": {"none": {}}, "vectorIndexType": "flat"}}}`)
	defer client.Exec("DELETE /v1/schema/GonaviNamed")
	if err := client.ApplyChanges("GonaviNamed", connection.ChangeSet{Inserts: []map[string]interface{}{
		{"title": "nv", "_vectors": `{"title_vec": [1, 0, 0], "body_vec": [0, 1]}`},
	}}); err != nil {
		t.Fatalf("named vector insert: %v", err)
	}
	rows, columns, err := client.Query(`SELECT title, _vectors FROM "GonaviNamed"`)
	if err != nil || len(rows) != 1 || !slices.Contains(columns, weaviateVectorsColumn) {
		t.Fatalf("named vector rows %v columns %v: %v", rows, columns, err)
	}
	vectors, ok := rows[0][weaviateVectorsColumn].(map[string]interface{})
	if !ok || vectors["title_vec"] == nil || vectors["body_vec"] == nil {
		t.Fatalf("named vectors = %#v", rows[0][weaviateVectorsColumn])
	}
	if indexes, err := client.GetIndexes("default", "GonaviNamed"); err != nil || len(indexes) < 3 {
		t.Fatalf("named vector indexes %v: %v", indexes, err)
	}
}
