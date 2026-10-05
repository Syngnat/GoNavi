//go:build gonavi_full_drivers || gonavi_zookeeper_driver

package db

import (
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func zookeeperLiveRows(t *testing.T, client *ZooKeeperDB, query string) []map[string]interface{} {
	t.Helper()
	rows, _, err := client.Query(query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return rows
}

func zookeeperLivePaths(t *testing.T, client *ZooKeeperDB, query string) []string {
	t.Helper()
	var paths []string
	for _, row := range zookeeperLiveRows(t, client, query) {
		paths = append(paths, row["path"].(string))
	}
	return paths
}

func zookeeperLiveCount(t *testing.T, client *ZooKeeperDB, query string) int64 {
	t.Helper()
	return zookeeperLiveRows(t, client, query)[0]["total"].(int64)
}

func expectZooKeeperError(t *testing.T, err error, key string, params map[string]any) {
	t.Helper()
	if err == nil || err.Error() != localizedDriverRuntimeText(key, params) {
		t.Fatalf("expected %s, got %v", key, err)
	}
}

func connectZooKeeperLive(t *testing.T, addr, user, password, params string) *ZooKeeperDB {
	t.Helper()
	config := liveConfig(t, "zookeeper", addr, user, "")
	config.Password, config.ConnectionParams = password, params
	client := &ZooKeeperDB{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("connect %s: %v", addr, err)
	}
	return client
}

// TestZooKeeperLiveSmoke 连真实 ZooKeeper（匿名访问，四字命令白名单需包含 srvr / ruok / mntr），覆盖库表列表、
// 网格分页 / 计数 / 过滤、网格增删改与原子性、控制台命令与 DDL 重放。地址来自 GONAVI_ZOOKEEPER_TEST_ADDRS。
func TestZooKeeperLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_ZOOKEEPER_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := connectZooKeeperLive(t, addr, "", "", "")
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			modern := strings.HasPrefix(version, "3.") && !strings.HasPrefix(version, "3.4")
			if wantVariant := map[bool]string{true: "v35", false: "v34"}[modern]; variant != wantVariant {
				t.Fatalf("server %s must use %s, got %s", version, wantVariant, variant)
			}
			_, _ = client.Exec("deleteall /gonavi-live")
			_, _ = client.Exec("deleteall /gonavi-live-leaf")
			defer client.Exec("deleteall /gonavi-live")
			defer client.Exec("deleteall /gonavi-live-leaf")
			for _, statement := range []string{
				"create /gonavi-live",
				"create /gonavi-live/app1 'App One'",
				"create /gonavi-live/app1/db",
				"create /gonavi-live/app1/db/url 'jdbc:mysql://db:3306/app'",
				"create /gonavi-live/app1/db/user gonavi",
				"create /gonavi-live/app2",
				"create /gonavi-live/app2/x 1",
				"create /gonavi-live-leaf leaf",
			} {
				mustExec(t, client, statement)
			}

			databases, err := client.GetDatabases()
			if err != nil || !slices.Contains(databases, "/gonavi-live") || !slices.Contains(databases, "/zookeeper") {
				t.Fatalf("databases %v: %v", databases, err)
			}
			tables, err := client.GetTables("/gonavi-live")
			if err != nil || strings.Join(tables, ",") != "/gonavi-live,/gonavi-live/app1,/gonavi-live/app2" {
				t.Fatalf("tables %v: %v", tables, err)
			}

			if paths := zookeeperLivePaths(t, client, `SELECT * FROM "/gonavi-live/app1" ORDER BY "path" ASC LIMIT 2 OFFSET 1`); strings.Join(paths, ",") != "/gonavi-live/app1/db,/gonavi-live/app1/db/url" {
				t.Fatalf("paged paths %v", paths)
			}
			if paths := zookeeperLivePaths(t, client, `SELECT * FROM "/gonavi-live" ORDER BY "path" DESC LIMIT 2`); strings.Join(paths, ",") != "/gonavi-live/app2/x,/gonavi-live/app2" {
				t.Fatalf("descending paths %v", paths)
			}
			for query, want := range map[string]int64{
				`SELECT COUNT(*) FROM "/gonavi-live"`:                                                    7,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "path" LIKE '/gonavi-live/app1/db/%'`:         2,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "data" LIKE '%gonavi%'`:                       1,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "num_children" = 0`:                           3,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "path" = '/gonavi-live/app2/x'`:               1,
				`SELECT COUNT(*) FROM "/gonavi-live/app2" WHERE "path" LIKE '/gonavi-live/app1/%'`:       0,
				`SELECT COUNT(*) FROM "/gonavi-live" WHERE "node_type" = 'persistent' AND "version" = 0`: 7,
			} {
				if got := zookeeperLiveCount(t, client, query); got != want {
					t.Fatalf("%s = %d, want %d", query, got, want)
				}
			}
			rows := zookeeperLiveRows(t, client, `SELECT "path", "data", "node_type" FROM "/gonavi-live/app1/db" WHERE "path" = '/gonavi-live/app1/db/url'`)
			if len(rows) != 1 || rows[0]["data"] != "jdbc:mysql://db:3306/app" || rows[0]["node_type"] != "persistent" || len(rows[0]) != 3 {
				t.Fatalf("projected row %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, `SELECT * FROM "/gonavi-live/app1" ORDER BY "data" DESC LIMIT 1`); rows[0]["path"] != "/gonavi-live/app1/db/url" {
				t.Fatalf("ordered by data %v", rows)
			}

			// 网格增删改：相对路径、自动创建父节点、改名、删除在同一个 multi 里提交；预览给出同样的 zkCli 命令。
			gridChanges := connection.ChangeSet{
				Inserts: []map[string]interface{}{{"path": "cache/redis/host", "data": "redis:6379"}},
				Updates: []connection.UpdateRow{
					{Keys: map[string]interface{}{"path": "/gonavi-live/app1/db/url"}, Values: map[string]interface{}{"data": "jdbc:mysql://db2:3306/app"}},
					{Keys: map[string]interface{}{"path": "/gonavi-live/app1/db/user"}, Values: map[string]interface{}{"path": "username"}},
				},
				Deletes: []map[string]interface{}{{"path": "/gonavi-live/app2/x"}},
			}
			previewDeletes, previewUpdates, previewInserts := client.PreviewChanges("/gonavi-live/app1", gridChanges)
			if strings.Join(previewDeletes, "|") != "delete /gonavi-live/app2/x" ||
				previewUpdates[0] != "set -v 0 /gonavi-live/app1/db/url jdbc:mysql://db2:3306/app" ||
				!strings.HasPrefix(previewUpdates[1], "create /gonavi-live/app1/db/username") || !strings.HasSuffix(previewUpdates[1], "delete -v 0 /gonavi-live/app1/db/user") ||
				previewInserts[0] != "create /gonavi-live/app1/cache\ncreate /gonavi-live/app1/cache/redis\ncreate /gonavi-live/app1/cache/redis/host redis:6379" {
				t.Fatalf("preview deletes=%q updates=%q inserts=%q", previewDeletes, previewUpdates, previewInserts)
			}
			if err := client.ApplyChanges("/gonavi-live/app1", gridChanges); err != nil {
				t.Fatalf("apply changes: %v", err)
			}
			if rows := zookeeperLiveRows(t, client, "get /gonavi-live/app1/db/url"); rows[0]["data"] != "jdbc:mysql://db2:3306/app" {
				t.Fatalf("updated data %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, "get /gonavi-live/app1/db/username"); rows[0]["data"] != "gonavi" {
				t.Fatalf("renamed node %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, "get /gonavi-live/app1/cache/redis/host"); rows[0]["data"] != "redis:6379" {
				t.Fatalf("inserted node %v", rows)
			}
			_, _, err = client.Query("get /gonavi-live/app1/db/user")
			expectZooKeeperError(t, err, "db.backend.error.zookeeper_node_missing", map[string]any{"path": "/gonavi-live/app1/db/user"})

			// 原子性：第二条插入冲突时第一条也不生效。
			err = client.ApplyChanges("/gonavi-live", connection.ChangeSet{Inserts: []map[string]interface{}{
				{"path": "/gonavi-live/fresh", "data": "x"}, {"path": "/gonavi-live/app2", "data": "dup"},
			}})
			expectZooKeeperError(t, err, "db.backend.error.zookeeper_node_exists", map[string]any{"path": "/gonavi-live/app2"})
			if got := zookeeperLiveCount(t, client, `SELECT COUNT(*) FROM "/gonavi-live" WHERE "path" = '/gonavi-live/fresh'`); got != 0 {
				t.Fatal("a failed multi must not apply any operation")
			}
			err = client.ApplyChanges("/gonavi-live", connection.ChangeSet{Updates: []connection.UpdateRow{
				{Keys: map[string]interface{}{"path": "/gonavi-live/app1/db"}, Values: map[string]interface{}{"path": "/gonavi-live/app1/database"}},
			}})
			expectZooKeeperError(t, err, "db.backend.error.zookeeper_rename_unsupported", map[string]any{"path": "/gonavi-live/app1/db"})
			err = client.ApplyChanges("/gonavi-live", connection.ChangeSet{Deletes: []map[string]interface{}{{"path": "/gonavi-live/app1/db"}}})
			expectZooKeeperError(t, err, "db.backend.error.zookeeper_node_not_empty", map[string]any{"path": "/gonavi-live/app1/db"})

			// 控制台命令。
			if rows := zookeeperLiveRows(t, client, "get -s /gonavi-live/app1/db/url"); rows[0]["version"] != int64(1) || rows[0]["data_length"] != int64(len("jdbc:mysql://db2:3306/app")) {
				t.Fatalf("get -s %v", rows)
			}
			_, err = client.Exec("set -v 0 /gonavi-live/app1/db/url stale")
			expectZooKeeperError(t, err, "db.backend.error.zookeeper_version_conflict", map[string]any{"path": "/gonavi-live/app1/db/url"})
			if rows := zookeeperLiveRows(t, client, "set -s -v 1 /gonavi-live/app1/db/url fresh"); rows[0]["version"] != int64(2) {
				t.Fatalf("set -s %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, "ls /gonavi-live"); len(rows) != 2 || rows[0]["name"] != "app1" || rows[1]["path"] != "/gonavi-live/app2" {
				t.Fatalf("ls %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, "ls -s /gonavi-live"); rows[0]["num_children"] != int64(2) {
				t.Fatalf("ls -s %v", rows)
			}
			if paths := zookeeperLivePaths(t, client, "ls -R /gonavi-live/app1/db"); strings.Join(paths, ",") != "/gonavi-live/app1/db,/gonavi-live/app1/db/url,/gonavi-live/app1/db/username" {
				t.Fatalf("ls -R %v", paths)
			}
			if rows := zookeeperLiveRows(t, client, "stat /gonavi-live"); rows[0]["num_children"] != int64(2) || rows[0]["node_type"] != "persistent" {
				t.Fatalf("stat %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, "getAcl /gonavi-live"); len(rows) != 1 || rows[0]["scheme"] != "world" || rows[0]["perms"] != "cdrwa" {
				t.Fatalf("getAcl %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, "create -s /gonavi-live/seq- s"); rows[0]["path"] != "/gonavi-live/seq-0000000002" {
				t.Fatalf("sequential create %v", rows)
			}
			mustExec(t, client, "create -e /gonavi-live/eph session-bound")
			if paths := zookeeperLivePaths(t, client, "getEphemerals /gonavi-live"); strings.Join(paths, ",") != "/gonavi-live/eph" {
				t.Fatalf("getEphemerals %v", paths)
			}
			if rows := zookeeperLiveRows(t, client, `SELECT "node_type" FROM "/gonavi-live" WHERE "path" = '/gonavi-live/eph'`); rows[0]["node_type"] != "ephemeral" {
				t.Fatalf("ephemeral node type %v", rows)
			}
			if rows := zookeeperLiveRows(t, client, "getAllChildrenNumber /gonavi-live/app1"); rows[0]["count"] != int64(6) {
				t.Fatalf("getAllChildrenNumber %v", rows)
			}
			mustExec(t, client, "sync /gonavi-live")
			if rows := zookeeperLiveRows(t, client, "version"); rows[0]["version"] != version || rows[0]["variant"] != variant {
				t.Fatalf("version %v", rows)
			}
			for _, word := range []string{"srvr", "ruok", "mntr", "4lw conf"} {
				if rows := zookeeperLiveRows(t, client, word); len(rows) == 0 {
					t.Fatalf("%s returned nothing", word)
				}
			}
			if modern {
				// 服务端对客户端隐藏容器 / TTL 编码，stat 与持久节点相同，这里只确认创建成功。
				if rows := zookeeperLiveRows(t, client, "create -c /gonavi-live/container"); rows[0]["path"] != "/gonavi-live/container" {
					t.Fatalf("container node %v", rows)
				}
				_, err := client.Exec("create -t 60000 /gonavi-live/ttl v")
				if err == nil {
					if rows := zookeeperLiveRows(t, client, "get /gonavi-live/ttl"); rows[0]["data"] != "v" {
						t.Fatalf("ttl node %v", rows)
					}
				} else {
					expectZooKeeperError(t, err, "db.backend.error.zookeeper_unimplemented", nil)
					t.Log("TTL nodes are disabled on this server (zookeeper.extendedTypesEnabled=false)")
				}
				// 单机模式下 /zookeeper/config 为空，集群模式下是 server.N= 与 version= 行。
				zookeeperLiveRows(t, client, "config")
			} else {
				_, err := client.Exec("create -c /gonavi-live/container")
				expectZooKeeperError(t, err, "db.backend.error.zookeeper_requires_version", map[string]any{"feature": "container", "version": "3.5.3"})
				_, _, err = client.Query("config")
				expectZooKeeperError(t, err, "db.backend.error.zookeeper_requires_version", map[string]any{"feature": "config", "version": "3.5"})
			}

			// DDL 脚本可整体重放。
			script, err := client.GetCreateStatement("", "/gonavi-live/app1")
			if err != nil || !strings.HasPrefix(script, "create /gonavi-live/app1 'App One';\n") {
				t.Fatalf("ddl %q: %v", script, err)
			}
			before := zookeeperLiveCount(t, client, `SELECT COUNT(*) FROM "/gonavi-live/app1"`)
			mustExec(t, client, "deleteall /gonavi-live/app1")
			for _, statement := range strings.Split(strings.TrimSpace(script), ";\n") {
				mustExec(t, client, statement)
			}
			if after := zookeeperLiveCount(t, client, `SELECT COUNT(*) FROM "/gonavi-live/app1"`); after != before {
				t.Fatalf("replayed %d nodes, want %d", after, before)
			}
			if rows := zookeeperLiveRows(t, client, "get /gonavi-live/app1/db/url"); rows[0]["data"] != "fresh" {
				t.Fatalf("replayed data %v", rows)
			}

			_, err = client.Exec("deleteall /zookeeper")
			expectZooKeeperError(t, err, "db.backend.error.zookeeper_delete_protected", map[string]any{"path": "/zookeeper"})
			if deleted, err := client.Exec("deleteall /gonavi-live"); err != nil || deleted < 10 {
				t.Fatalf("deleteall removed %d nodes: %v", deleted, err)
			}
		})
	}
}

// TestZooKeeperLiveDigestAuth 覆盖 digest 认证：带账号的会话建立受 ACL 保护的节点，匿名会话读取时提示认证，
// addauth 之后可读；acl 连接参数决定网格新建节点的 ACL。
func TestZooKeeperLiveDigestAuth(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_ZOOKEEPER_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			owner := connectZooKeeperLive(t, addr, "gonavi", "secret", "acl=auth::cdrwa")
			defer owner.Close()
			_, _ = owner.Exec("deleteall /gonavi-auth")
			defer owner.Exec("deleteall /gonavi-auth")
			mustExec(t, owner, "create /gonavi-auth")
			if err := owner.ApplyChanges("/gonavi-auth", connection.ChangeSet{Inserts: []map[string]interface{}{{"path": "secret", "data": "s3cr3t"}}}); err != nil {
				t.Fatalf("insert protected node: %v", err)
			}
			if rows := zookeeperLiveRows(t, owner, "getAcl /gonavi-auth/secret"); rows[0]["scheme"] != "digest" || !strings.HasPrefix(rows[0]["id"].(string), "gonavi:") {
				t.Fatalf("protected node acl %v", rows)
			}

			anonymous := connectZooKeeperLive(t, addr, "", "", "")
			defer anonymous.Close()
			_, _, err := anonymous.Query("get /gonavi-auth/secret")
			expectZooKeeperError(t, err, "db.backend.error.zookeeper_no_auth", map[string]any{"path": "/gonavi-auth/secret"})
			rows := zookeeperLiveRows(t, anonymous, `SELECT * FROM "/gonavi-auth" WHERE "path" = '/gonavi-auth/secret'`)
			if len(rows) != 1 || rows[0]["data"] != nil {
				t.Fatalf("unreadable node must be listed without data: %v", rows)
			}
			mustExec(t, anonymous, "addauth digest gonavi:secret")
			if rows := zookeeperLiveRows(t, anonymous, "get /gonavi-auth/secret"); rows[0]["data"] != "s3cr3t" {
				t.Fatalf("after addauth %v", rows)
			}
		})
	}
}

func TestZooKeeperConnectFailsFast(t *testing.T) {
	client := &ZooKeeperDB{}
	started := time.Now()
	err := client.Connect(connection.ConnectionConfig{Type: "zookeeper", Host: "127.0.0.1", Port: 1, Timeout: 2})
	if err == nil || !strings.Contains(err.Error(), "127.0.0.1:1") {
		t.Fatalf("expected a connect error naming the server, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 6*time.Second {
		t.Fatalf("connect took %s", elapsed)
	}
}
