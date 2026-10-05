package db

import (
	"reflect"
	"testing"
)

func TestParseEtcdCommandHandlesQuotesAndFlags(t *testing.T) {
	command, err := parseEtcdCommand(`put /cfg/app '{"name": "gonavi", "port": 8080}' --lease 694d81 --prev-kv`)
	if err != nil {
		t.Fatal(err)
	}
	if command.name != "put" || !reflect.DeepEqual(command.args, []string{"/cfg/app", `{"name": "gonavi", "port": 8080}`}) {
		t.Fatalf("command %+v", command)
	}
	if lease, _ := command.flag("lease"); lease != "694d81" || !command.boolFlag("prev-kv") {
		t.Fatalf("flags %+v", command.flags)
	}

	command, err = parseEtcdCommand("GET \"/a b\" --prefix --limit=10 --sort-by MODIFY --order=DESCEND --keys-only=false")
	if err != nil {
		t.Fatal(err)
	}
	if command.name != "get" || command.args[0] != "/a b" || !command.boolFlag("prefix") || command.boolFlag("keys-only") {
		t.Fatalf("command %+v", command)
	}
	if limit, _ := command.flag("limit"); limit != "10" {
		t.Fatalf("limit %q", limit)
	}
	if sortBy, _ := command.flag("sort-by"); sortBy != "MODIFY" {
		t.Fatalf("sort-by %q", sortBy)
	}

	// 引号里的 -- 开头文本是值，不是选项；双引号支持转义。
	command, err = parseEtcdCommand(`put k "--not-a-flag" `)
	if err != nil || len(command.args) != 2 || command.args[1] != "--not-a-flag" || len(command.flags) != 0 {
		t.Fatalf("quoted dash value: %+v %v", command, err)
	}
	command, err = parseEtcdCommand(`put k "line1\nline2 \"q\""`)
	if err != nil || command.args[1] != "line1\nline2 \"q\"" {
		t.Fatalf("escapes: %+v %v", command, err)
	}
	for _, text := range []string{"", "   ", `put k "unclosed`, "put k 'unclosed"} {
		if _, err := parseEtcdCommand(text); err == nil {
			t.Errorf("parse %q must fail", text)
		}
	}
}

func TestIsEtcdReadCommand(t *testing.T) {
	for _, text := range []string{"get /a --prefix", "ls /dir --recursive", "lease list", "lease timetolive 694d81 --keys", "member list", "endpoint status", "alarm list", "user get root", "role list", "version"} {
		if !IsEtcdReadCommand(text) {
			t.Errorf("%q must be read-only", text)
		}
	}
	for _, text := range []string{"put /a 1", "del /a --prefix", "set /a 1", "rm /a --recursive", "lease grant 60", "lease revoke 694d81", "compaction 100", "user add bob", "alarm disarm", "get 'unclosed"} {
		if IsEtcdReadCommand(text) {
			t.Errorf("%q must be treated as a write", text)
		}
	}
}

func TestEtcdPrefixEnd(t *testing.T) {
	for prefix, want := range map[string]string{"/a/": "/a0", "a": "b", "a\xff": "b", "\xff\xff": "\x00"} {
		if got := etcdPrefixEnd(prefix); got != want {
			t.Errorf("etcdPrefixEnd(%q) = %q, want %q", prefix, got, want)
		}
	}
}

func TestParseEtcdCommandIgnoresStatementTerminator(t *testing.T) {
	for text, want := range map[string][]string{
		"put /a 1;":           {"/a", "1"},
		"put /a 'v;' ;":       {"/a", "v;"},
		`put /a "x\"; y";;`:   {"/a", `x"; y`},
		"get /a --prefix ;":   {"/a"},
		"put /a 'unclosed; ;": nil,
	} {
		command, err := parseEtcdCommand(text)
		if want == nil {
			if err == nil {
				t.Errorf("%q must fail", text)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(command.args, want) {
			t.Errorf("parse %q = %v (%v), want %v", text, command.args, err, want)
		}
	}
}
