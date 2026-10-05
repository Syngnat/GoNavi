//go:build gonavi_full_drivers || gonavi_zookeeper_driver

package db

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	"github.com/go-zookeeper/zk"
)

func TestResolveZooKeeperTarget(t *testing.T) {
	cases := []struct {
		name    string
		config  connection.ConnectionConfig
		servers []string
		chroot  string
		user    string
	}{
		{
			name:    "uri with chroot, credentials and extra servers",
			config:  connection.ConnectionConfig{URI: "zk://admin:p%40ss@h1:2181,h2/app/conf?servers=h3:2182", Host: "ignored", Port: 2181},
			servers: []string{"h1:2181", "h2:2181", "h3:2182"},
			chroot:  "/app/conf",
			user:    "admin",
		},
		{
			name:    "native connect string",
			config:  connection.ConnectionConfig{URI: "10.0.0.1:2181,10.0.0.2:2181/kafka", Port: 2181},
			servers: []string{"10.0.0.1:2181", "10.0.0.2:2181"},
			chroot:  "/kafka",
		},
		{
			name: "form fields",
			config: connection.ConnectionConfig{
				Host: "zk1", Port: 2182, Database: "dubbo", ConnectionParams: "servers=zk2,zk3:2183,zk1:2182",
			},
			servers: []string{"zk1:2182", "zk2:2182", "zk3:2183"},
			chroot:  "/dubbo",
		},
		{
			name:    "defaults",
			config:  connection.ConnectionConfig{},
			servers: []string{"localhost:2181"},
			chroot:  "/",
		},
	}
	for _, tc := range cases {
		target := resolveZooKeeperTarget(tc.config)
		if !reflect.DeepEqual(target.servers, tc.servers) || target.chroot != tc.chroot || target.user != tc.user {
			t.Fatalf("%s: %+v", tc.name, target)
		}
	}
	if target := resolveZooKeeperTarget(connection.ConnectionConfig{URI: "zk://h1/app", User: "form", Password: "secret"}); target.user != "form" || target.password != "secret" {
		t.Fatalf("form credentials must win over the URI: %+v", target)
	}
	if target := resolveZooKeeperTarget(connection.ConnectionConfig{URI: "zk://u:p%40ss@h1/"}); target.password != "p@ss" {
		t.Fatalf("URI password must be decoded: %+v", target)
	}
}

func TestNormalizeZooKeeperPath(t *testing.T) {
	for input, want := range map[string]string{"": "", "/": "/", "app": "/app", "/app/": "/app", " /a/b// ": "/a/b", "///": "/"} {
		if got := normalizeZooKeeperPath(input); got != want {
			t.Fatalf("normalizeZooKeeperPath(%q) = %q, want %q", input, got, want)
		}
	}
	if got := zookeeperResolvePath("child", "/app"); got != "/app/child" {
		t.Fatalf("relative path resolved to %q", got)
	}
	if got := zookeeperResolvePath("child", "/"); got != "/child" {
		t.Fatalf("relative path under root resolved to %q", got)
	}
	if got := zookeeperParent("/app/a"); got != "/app" || zookeeperParent("/app") != "/" || zookeeperParent("/") != "" {
		t.Fatalf("parent of /app/a = %q", got)
	}
}

func TestZooKeeperNodeType(t *testing.T) {
	for owner, want := range map[int64]string{
		0:             "persistent",
		math.MinInt64: "container",
		0x100000abc12: "ephemeral",
	} {
		if got := zookeeperNodeType(owner); got != want {
			t.Fatalf("zookeeperNodeType(%#x) = %q, want %q", owner, got, want)
		}
	}
}

func TestZooKeeperTreeOrder(t *testing.T) {
	nodes := []zookeeperNode{{path: "/a-x"}, {path: "/a/b"}, {path: "/a"}, {path: "/a/b/c"}, {path: "/b"}}
	sortZooKeeperNodes(nodes, false)
	var paths []string
	for _, node := range nodes {
		paths = append(paths, node.path)
	}
	if strings.Join(paths, ",") != "/a,/a/b,/a/b/c,/a-x,/b" {
		t.Fatalf("tree order %v", paths)
	}
}

func TestZooKeeperPushdown(t *testing.T) {
	parse := func(text string) interface{} {
		node, err := parseRegistryWhere(text)
		if err != nil {
			t.Fatalf("%s: %v", text, err)
		}
		return node
	}
	cases := []struct {
		where string
		exact []string
		root  string
	}{
		{`"path" = '/app/db'`, []string{"/app/db"}, "/app"},
		{`"path" IN ('/app/a', '/other/b') AND "version" > 1`, []string{"/app/a"}, "/app"},
		{`"path" LIKE '/app/config/%'`, nil, "/app/config"},
		{`"path" LIKE '/app/con%'`, nil, "/app"},
		{`"path" LIKE '/%'`, nil, "/app"},
		{`"path" LIKE '/other/%'`, []string{}, "/app"},
		{`"path" = '/app' OR "data" = 'x'`, nil, "/app"},
		{`"data" LIKE '%x%'`, nil, "/app"},
	}
	for _, tc := range cases {
		exact, root := zookeeperPushdown("/app", parse(tc.where))
		if !reflect.DeepEqual(exact, tc.exact) || root != tc.root {
			t.Fatalf("%s: exact %#v root %q", tc.where, exact, root)
		}
	}
}

func TestZooKeeperACL(t *testing.T) {
	acls, err := parseZooKeeperACL("world:anyone:r, digest:admin:x1nq8J5GOJVPY6zgBe3SBdRKu6k=:cdrwa,auth::CDRWA")
	if err != nil {
		t.Fatal(err)
	}
	want := []zk.ACL{
		{Scheme: "world", ID: "anyone", Perms: zk.PermRead},
		{Scheme: "digest", ID: "admin:x1nq8J5GOJVPY6zgBe3SBdRKu6k=", Perms: zk.PermAll},
		{Scheme: "auth", ID: "", Perms: zk.PermAll},
	}
	if !reflect.DeepEqual(acls, want) {
		t.Fatalf("acls %+v", acls)
	}
	if text := formatZooKeeperACL(acls); text != "world:anyone:r,digest:admin:x1nq8J5GOJVPY6zgBe3SBdRKu6k=:cdrwa,auth::cdrwa" {
		t.Fatalf("formatted %q", text)
	}
	for _, invalid := range []string{"world:anyone", "world:anyone:rx", ":id:r", "anyone"} {
		if _, err := parseZooKeeperACL(invalid); err == nil {
			t.Fatalf("%q must be rejected", invalid)
		}
	}
}

func TestZooKeeperCreateCommand(t *testing.T) {
	world := zk.WorldACL(zk.PermAll)
	cases := []struct {
		node zookeeperNode
		acl  []zk.ACL
		want string
	}{
		{zookeeperNode{path: "/app"}, world, "create /app"},
		{zookeeperNode{path: "/app/x", data: []byte("a b")}, world, "create /app/x 'a b'"},
		{zookeeperNode{path: "/app/e", data: []byte{}, stat: zk.Stat{EphemeralOwner: 0x100000abc}}, world, "create -e /app/e ''"},
		{zookeeperNode{path: "/app/c", stat: zk.Stat{EphemeralOwner: math.MinInt64}}, world, "create -c /app/c"},
		{zookeeperNode{path: "/app/s"}, zk.WorldACL(zk.PermRead), "create /app/s '' world:anyone:r"},
	}
	for _, tc := range cases {
		if got := zookeeperCreateCommand(tc.node, tc.acl); got != tc.want {
			t.Fatalf("got %q, want %q", got, tc.want)
		}
		command, err := parseZooKeeperCommand(tc.want)
		if err != nil || command.name != "create" || command.args[0] != tc.node.path {
			t.Fatalf("%q must parse back: %+v %v", tc.want, command, err)
		}
	}
}

func TestZooKeeperKeyValueRows(t *testing.T) {
	rows, columns := zookeeperKeyValueRows("zk_version\t3.9.5-abc, built on 2024\nzk_avg_latency\t0\n", "\t")
	if len(rows) != 2 || rows[0]["key"] != "zk_version" || rows[0]["value"] != "3.9.5-abc, built on 2024" || columns[1] != "value" {
		t.Fatalf("mntr rows %v", rows)
	}
	rows, _ = zookeeperKeyValueRows("Zookeeper version: 3.4.14-4c25d48, built on 03/06/2019 16:18 GMT\r\nMode: standalone\r\n", ":")
	if rows[0]["key"] != "Zookeeper version" || !strings.HasPrefix(rows[0]["value"].(string), "3.4.14") || rows[1]["value"] != "standalone" {
		t.Fatalf("srvr rows %v", rows)
	}
	if match := zookeeperVersionPattern.FindStringSubmatch("Zookeeper version: 3.4.14-4c25d48, built on"); match == nil || match[1] != "3.4.14" {
		t.Fatalf("version match %v", match)
	}
}
