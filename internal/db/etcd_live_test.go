//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func etcdLiveKeys(t *testing.T, client *EtcdDB, query string) []string {
	t.Helper()
	rows, _, err := client.Query(query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row["key"].(string))
	}
	return keys
}

// TestEtcdLiveSmoke 连真实 etcd（v3 API，匿名访问），覆盖库表列表、网格分页 / 计数 / 过滤、网格增删改与冲突检测、
// 控制台命令。地址来自 GONAVI_ETCD_TEST_ADDRS（host:port，逗号分隔）。
func TestEtcdLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_ETCD_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := &EtcdDB{}
			if err := client.Connect(liveConfig(t, "etcd", addr, "", "")); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			if variant != "v3" {
				t.Fatalf("3.x servers must use the v3 API, got %s", variant)
			}
			_, _ = client.Exec("del /gonavi-live --prefix")
			defer client.Exec("del /gonavi-live --prefix")
			for _, statement := range []string{
				"put /gonavi-live/app1/db/url 'jdbc:mysql://db:3306/app'",
				"put /gonavi-live/app1/db/user gonavi",
				"put /gonavi-live/app1/name 'App One'",
				"put /gonavi-live/app2/x 1",
				"put /gonavi-live-leaf leaf",
			} {
				mustExec(t, client, statement)
			}

			databases, err := client.GetDatabases()
			if err != nil || !slices.Contains(databases, "/gonavi-live") || !slices.Contains(databases, "/gonavi-live-leaf") {
				t.Fatalf("databases %v: %v", databases, err)
			}
			tables, err := client.GetTables("/gonavi-live")
			if err != nil || strings.Join(tables, ",") != "/gonavi-live,/gonavi-live/app1,/gonavi-live/app2" {
				t.Fatalf("tables %v: %v", tables, err)
			}
			if leaf, err := client.GetTables("/gonavi-live-leaf"); err != nil || len(leaf) != 1 {
				t.Fatalf("leaf database tables %v: %v", leaf, err)
			}

			if keys := etcdLiveKeys(t, client, `SELECT * FROM "/gonavi-live/app1" ORDER BY "key" ASC LIMIT 2 OFFSET 1`); strings.Join(keys, ",") != "/gonavi-live/app1/db/user,/gonavi-live/app1/name" {
				t.Fatalf("paged keys %v", keys)
			}
			if keys := etcdLiveKeys(t, client, `SELECT * FROM "/gonavi-live" ORDER BY "key" DESC LIMIT 2`); strings.Join(keys, ",") != "/gonavi-live/app2/x,/gonavi-live/app1/name" {
				t.Fatalf("descending keys %v", keys)
			}
			for query, want := range map[string]int64{
				`SELECT COUNT(*) FROM "/gonavi-live"`:                                                             5 - 1,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "key" LIKE '/gonavi-live/app1/db/%'`:                   2,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "value" LIKE '%gonavi%'`:                               1,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "version" = 1 AND "key" > '/gonavi-live/app1/db/user'`: 2,
			} {
				rows, _, err := client.Query(query)
				if err != nil || rows[0]["total"] != want {
					t.Fatalf("%s = %v (%v), want %d", query, rows, err, want)
				}
			}

			gridChanges := connection.ChangeSet{
				Inserts: []map[string]interface{}{{"key": "/gonavi-live/app1/new", "value": "fresh", "ttl": "120"}},
				Updates: []connection.UpdateRow{
					{Keys: map[string]interface{}{"key": "/gonavi-live/app1/db/url"}, Values: map[string]interface{}{"value": "jdbc:mysql://db2:3306/app"}},
					{Keys: map[string]interface{}{"key": "/gonavi-live/app1/db/user"}, Values: map[string]interface{}{"key": "/gonavi-live/app1/db/username"}},
				},
				Deletes: []map[string]interface{}{{"key": "/gonavi-live/app1/name"}},
			}
			previewDeletes, previewUpdates, previewInserts := client.PreviewChanges("/gonavi-live/app1", gridChanges)
			if strings.Join(previewDeletes, "|") != "del /gonavi-live/app1/name" ||
				previewUpdates[0] != "put /gonavi-live/app1/db/url jdbc:mysql://db2:3306/app" ||
				previewUpdates[1] != "put /gonavi-live/app1/db/username gonavi\ndel /gonavi-live/app1/db/user" ||
				previewInserts[0] != "lease grant 120\nput /gonavi-live/app1/new fresh --lease=<lease-id>" {
				t.Fatalf("preview deletes=%q updates=%q inserts=%q", previewDeletes, previewUpdates, previewInserts)
			}
			if err := client.ApplyChanges("/gonavi-live/app1", gridChanges); err != nil {
				t.Fatalf("apply changes: %v", err)
			}
			rows, _, err := client.Query(`SELECT * FROM "/gonavi-live/app1" ORDER BY "key"`)
			if err != nil || len(rows) != 3 {
				t.Fatalf("rows after changes %v: %v", rows, err)
			}
			if rows[0]["value"] != "jdbc:mysql://db2:3306/app" || rows[1]["key"] != "/gonavi-live/app1/db/username" || rows[1]["value"] != "gonavi" || rows[2]["lease"] == nil || rows[2]["ttl"] == nil {
				t.Fatalf("changed rows %v", rows)
			}
			if err := client.ApplyChanges("/gonavi-live/app1", connection.ChangeSet{Inserts: []map[string]interface{}{{"key": "/gonavi-live/app1/new", "value": "dup"}}}); err == nil {
				t.Fatal("inserting an existing key must fail")
			}

			for _, command := range []string{"get /gonavi-live --prefix --keys-only", "get /gonavi-live --prefix --count-only", "member list", "endpoint status", "endpoint health", "alarm list", "version"} {
				if _, _, err := client.Query(command); err != nil {
					t.Fatalf("%s: %v", command, err)
				}
			}
			rows, _, err = client.Query("put /gonavi-live/k 'v 1' --prev-kv")
			if err != nil || rows[0]["prev_value"] != nil {
				t.Fatalf("put: %v %v", rows, err)
			}
			rows, _, err = client.Query("lease grant 30")
			if err != nil {
				t.Fatal(err)
			}
			lease := rows[0]["lease"].(string)
			if _, _, err := client.Query("put /gonavi-live/k v2 --lease=" + lease); err != nil {
				t.Fatal(err)
			}
			rows, _, err = client.Query("lease timetolive " + lease + " --keys")
			if err != nil || !strings.Contains(rows[0]["keys"].(string), "/gonavi-live/k") {
				t.Fatalf("timetolive %v: %v", rows, err)
			}
			if client.atLeast("3.3") {
				if rows, _, err := client.Query("lease list"); err != nil || len(rows) == 0 {
					t.Fatalf("lease list %v: %v", rows, err)
				}
			} else if _, _, err := client.Query("lease list"); err == nil {
				t.Fatal("lease list must be reported as unsupported before 3.3")
			}
			// --prefix 是字节前缀：带结尾分隔符才不会连带删除 /gonavi-live-leaf。
			// watch 是有界的：另一个协程写入后应收到 PUT 与 DELETE 事件。
			go func() {
				time.Sleep(300 * time.Millisecond)
				_, _ = client.Exec("put /gonavi-live/watched 1")
				_, _ = client.Exec("del /gonavi-live/watched")
			}()
			rows, _, err = client.Query("watch /gonavi-live/watched --timeout=3 --limit=2")
			if err != nil || len(rows) != 2 || rows[0]["event"] != "PUT" || rows[1]["event"] != "DELETE" {
				t.Fatalf("watch %v: %v", rows, err)
			}
			if affected, err := client.Exec("del /gonavi-live/ --prefix"); err != nil || affected != 5 {
				t.Fatalf("delete prefix affected %d: %v", affected, err)
			}
			mustExec(t, client, "del /gonavi-live-leaf")
		})
	}
}

// TestEtcdV2LiveSmoke 用 v2 档位连接（etcd 2.x 或开启 --enable-v2 的 3.x），覆盖目录浏览、网格读写与控制台命令。
// 地址来自 GONAVI_ETCD_V2_TEST_ADDRS。
func TestEtcdV2LiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_ETCD_V2_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			config := liveConfig(t, "etcd", addr, "", "")
			config.DriverVariant = "v2"
			client := &EtcdDB{}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s using variant %s", version, variant)
			_, _ = client.Exec("rm /gonavi-v2 --recursive")
			defer client.Exec("rm /gonavi-v2 --recursive")
			for _, statement := range []string{"set /gonavi-v2/app/name 'App V2'", "set /gonavi-v2/app/port 8080 --ttl=600", "mkdir /gonavi-v2/empty"} {
				mustExec(t, client, statement)
			}
			if databases, err := client.GetDatabases(); err != nil || !slices.Contains(databases, "/gonavi-v2") {
				t.Fatalf("databases %v: %v", databases, err)
			}
			if tables, err := client.GetTables("/gonavi-v2"); err != nil || strings.Join(tables, ",") != "/gonavi-v2,/gonavi-v2/app,/gonavi-v2/empty" {
				t.Fatalf("tables %v: %v", tables, err)
			}
			rows, _, err := client.Query(`SELECT * FROM "/gonavi-v2/app" ORDER BY "key" LIMIT 10`)
			if err != nil || len(rows) != 2 || rows[1]["ttl"] == nil {
				t.Fatalf("rows %v: %v", rows, err)
			}
			v2Changes := connection.ChangeSet{
				Inserts: []map[string]interface{}{{"key": "/gonavi-v2/app/env", "value": "prod"}},
				Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"key": "/gonavi-v2/app/name"}, Values: map[string]interface{}{"value": "App V2b"}}},
			}
			if _, previewUpdates, previewInserts := client.PreviewChanges("/gonavi-v2/app", v2Changes); previewUpdates[0] != "set /gonavi-v2/app/name 'App V2b'" || previewInserts[0] != "set /gonavi-v2/app/env prod" {
				t.Fatalf("v2 preview updates=%q inserts=%q", previewUpdates, previewInserts)
			}
			if err := client.ApplyChanges("/gonavi-v2/app", v2Changes); err != nil {
				t.Fatalf("apply changes: %v", err)
			}
			if keys := etcdLiveKeys(t, client, `SELECT * FROM "/gonavi-v2/app" WHERE "value" = 'App V2b'`); strings.Join(keys, ",") != "/gonavi-v2/app/name" {
				t.Fatalf("updated rows %v", keys)
			}
			if rows, _, err := client.Query("ls /gonavi-v2 --recursive"); err != nil || len(rows) != 5 {
				t.Fatalf("ls %v: %v", rows, err)
			}
		})
	}
}

// TestEtcdAuthLiveSmoke 连开启认证的 etcd：GONAVI_ETCD_AUTH_TEST_ADDR 与 root 密码 GONAVI_ETCD_AUTH_TEST_PASSWORD，
// 以及只能读 /app/ 前缀的 reader 用户密码 GONAVI_ETCD_AUTH_READER_PASSWORD。
func TestEtcdAuthLiveSmoke(t *testing.T) {
	addrs := liveAddrs(t, "GONAVI_ETCD_AUTH_TEST_ADDR")
	config := liveConfig(t, "etcd", addrs[0], "", "")
	if err := (&EtcdDB{}).Connect(config); err == nil || strings.Contains(err.Error(), "etcdserver") {
		t.Fatalf("anonymous access must be rejected with an actionable message, got %v", err)
	} else {
		t.Logf("anonymous: %v", err)
	}
	config.User, config.Password = "root", "wrong-password"
	if err := (&EtcdDB{}).Connect(config); err == nil || strings.Contains(err.Error(), "etcdserver") {
		t.Fatalf("a wrong password must be rejected with an actionable message, got %v", err)
	} else {
		t.Logf("wrong password: %v", err)
	}

	config.User, config.Password = "root", os.Getenv("GONAVI_ETCD_AUTH_TEST_PASSWORD")
	root := &EtcdDB{}
	if err := root.Connect(config); err != nil {
		t.Fatalf("root connect: %v", err)
	}
	defer root.Close()
	if databases, err := root.GetDatabases(); err != nil || !slices.Contains(databases, "/app") {
		t.Fatalf("root databases %v: %v", databases, err)
	}

	config.User, config.Password = "reader", os.Getenv("GONAVI_ETCD_AUTH_READER_PASSWORD")
	reader := &EtcdDB{}
	if err := reader.Connect(config); err != nil {
		t.Fatalf("reader connect: %v", err)
	}
	defer reader.Close()
	if _, err := reader.GetDatabases(); err == nil || !strings.Contains(err.Error(), "prefix") {
		t.Fatalf("a restricted user listing the whole keyspace must get a prefix hint, got %v", err)
	}
	config.ConnectionParams = "prefix=/app"
	scoped := &EtcdDB{}
	if err := scoped.Connect(config); err != nil {
		t.Fatalf("scoped connect: %v", err)
	}
	defer scoped.Close()
	if databases, err := scoped.GetDatabases(); err != nil || !slices.Contains(databases, "/app/name") {
		t.Fatalf("scoped databases %v: %v", databases, err)
	}
	if _, err := scoped.Exec("put /app/name changed"); err == nil {
		t.Fatal("a read-only role must not write")
	}
}
