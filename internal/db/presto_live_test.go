//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

type prestoCountingConsumer struct {
	columns []string
	rows    int
}

func (c *prestoCountingConsumer) SetColumns(columns []string) error {
	c.columns = columns
	return nil
}

func (c *prestoCountingConsumer) ConsumeRow(map[string]interface{}) error {
	c.rows++
	return nil
}

// TestPrestoLiveSmoke 连真实 Presto（需要 tpch 与 memory 两个 catalog，匿名访问），覆盖版本识别、
// 元数据、分页（原生或模拟 OFFSET）、类型转换、写入、参数化、独立会话、流式读取与取消。
// 地址来自 GONAVI_PRESTO_TEST_ADDRS（host:port，逗号分隔）。
func TestPrestoLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_PRESTO_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := &PrestoDB{}
			if err := client.Connect(liveConfig(t, "presto", addr, "gonavi", "tpch.tiny")); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s (offset mode %d)", version, variant, client.offsetMode)
			ctx := context.Background()

			databases, err := client.GetDatabases()
			if err != nil || !slices.Contains(databases, "tpch.tiny") || !slices.Contains(databases, "system.runtime") {
				t.Fatalf("databases %v: %v", databases, err)
			}
			if tables, err := client.GetTables("tpch.tiny"); err != nil || !slices.Contains(tables, "nation") {
				t.Fatalf("tables %v: %v", tables, err)
			}
			columns, err := client.GetColumns("tpch.tiny", "nation")
			if err != nil || len(columns) != 4 || columns[0].Name != "nationkey" || columns[0].Type != "bigint" {
				t.Fatalf("columns %+v: %v", columns, err)
			}
			if all, err := client.GetAllColumns("tpch.tiny"); err != nil || len(all) < 40 {
				t.Fatalf("all columns %d: %v", len(all), err)
			}
			if ddl, err := client.GetCreateStatement("tpch.tiny", "nation"); err != nil || !strings.Contains(ddl, "CREATE TABLE") {
				t.Fatalf("ddl %q: %v", ddl, err)
			}

			rows, _, err := client.QueryContext(ctx, `SELECT nationkey, name FROM "tpch"."tiny"."nation" ORDER BY "nationkey" OFFSET 5 LIMIT 3`)
			if err != nil || len(rows) != 3 || rows[0]["nationkey"] != int64(5) || rows[2]["nationkey"] != int64(7) {
				t.Fatalf("paged rows %v: %v", rows, err)
			}

			rows, names, err := client.QueryContext(ctx, `SELECT CAST(9007199254740993 AS bigint) AS big, X'68656c6c6f' AS bin, ARRAY[1, 2] AS arr,
  MAP(ARRAY['a'], ARRAY[1]) AS m, DECIMAL '12.50' AS d, TIMESTAMP '2026-01-02 03:04:05.123' AS ts, DATE '2026-01-02' AS dt,
  CAST(nan() AS double) AS n, 1.5E0 AS f, true AS b, CAST(NULL AS varchar) AS missing`)
			if err != nil || len(rows) != 1 {
				t.Fatalf("typed row %v: %v", rows, err)
			}
			row := rows[0]
			t.Logf("typed row %v (%v)", row, names)
			if arr, ok := row["arr"].([]interface{}); !ok || len(arr) != 2 || arr[1] != int64(2) {
				t.Fatalf("array value %#v", row["arr"])
			}
			if m, ok := row["m"].(map[string]interface{}); !ok || m["a"] != int64(1) {
				t.Fatalf("map value %#v", row["m"])
			}
			if row["big"] != "9007199254740993" || row["bin"] != "hello" || row["d"] != "12.50" || row["dt"] != "2026-01-02" ||
				!strings.HasPrefix(row["ts"].(string), "2026-01-02 03:04:05.123") || row["n"] != "NaN" || row["f"] != 1.5 || row["b"] != true || row["missing"] != nil {
				t.Fatalf("typed values %#v", row)
			}

			mustExec(t, client, "CREATE SCHEMA IF NOT EXISTS memory.gonavi")
			_, _ = client.Exec("DROP TABLE IF EXISTS memory.gonavi.items")
			mustExec(t, client, "CREATE TABLE memory.gonavi.items (id bigint, name varchar)")
			defer client.Exec("DROP TABLE IF EXISTS memory.gonavi.items")
			if affected, err := client.Exec("INSERT INTO memory.gonavi.items VALUES (1, 'a'), (2, 'b')"); err != nil || affected != 2 {
				t.Fatalf("insert affected %d: %v", affected, err)
			}
			if rows, _, err := client.QueryContextWithArgs(ctx, "SELECT name FROM memory.gonavi.items WHERE id = ? AND name <> ?", []any{int64(2), "it's"}); err != nil || len(rows) != 1 || rows[0]["name"] != "b" {
				t.Fatalf("parameterized rows %v: %v", rows, err)
			}

			session, err := client.OpenSessionExecer(ctx)
			if err != nil {
				t.Fatal(err)
			}
			sessionQuery := session.(StatementQueryExecer)
			if _, err := session.ExecContext(ctx, "USE tpch.sf1"); err != nil {
				t.Fatalf("use: %v", err)
			}
			if rows, _, err := sessionQuery.QueryContext(ctx, "SELECT count(*) AS c FROM customer"); err != nil || rows[0]["c"] != int64(150000) {
				t.Fatalf("session USE not kept: %v %v", rows, err)
			}
			if rows, _, err := client.QueryContext(ctx, "SELECT count(*) AS c FROM customer"); err != nil || rows[0]["c"] != int64(1500) {
				t.Fatalf("connection session must keep tpch.tiny: %v %v", rows, err)
			}
			_ = session.Close()

			consumer := &prestoCountingConsumer{}
			if err := client.StreamQueryContext(ctx, `SELECT * FROM "tpch"."tiny"."orders"`, consumer); err != nil || consumer.rows != 15000 || len(consumer.columns) != 9 {
				t.Fatalf("streamed %d rows %v: %v", consumer.rows, consumer.columns, err)
			}

			_, _, err = client.QueryContext(ctx, "SELECT * FROM tpch.tiny.no_such_table")
			var queryErr *prestoQueryError
			if !errors.As(err, &queryErr) {
				t.Fatalf("missing table error %v", err)
			}
			t.Logf("missing table error: %v", err)

			marker := "gonavi_cancel_" + strings.Map(func(r rune) rune {
				if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') {
					return r
				}
				return '_'
			}, strings.ToLower(version))
			cancelCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
			_, _, err = client.QueryContext(cancelCtx, "SELECT count(*) AS "+marker+" FROM tpch.sf1.lineitem a CROSS JOIN tpch.sf1.lineitem b")
			cancel()
			if err == nil {
				t.Fatal("long query must be cancelled by the context deadline")
			}
			deadline := time.Now().Add(15 * time.Second)
			for {
				rows, _, err := client.QueryContext(ctx, "SELECT state FROM system.runtime.queries WHERE query LIKE '%"+marker+" FROM%' AND query NOT LIKE '%system.runtime.queries%'")
				if err != nil {
					t.Fatal(err)
				}
				if len(rows) > 0 && rows[0]["state"] != "RUNNING" && rows[0]["state"] != "QUEUED" {
					t.Logf("cancelled query state %v", rows[0]["state"])
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("server query was not cancelled: %v", rows)
				}
				time.Sleep(300 * time.Millisecond)
			}
		})
	}
}
