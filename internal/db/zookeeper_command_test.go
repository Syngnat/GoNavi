package db

import (
	"reflect"
	"testing"
)

func TestParseZooKeeperCommandOptions(t *testing.T) {
	cases := []struct {
		text    string
		name    string
		args    []string
		options map[string]string
	}{
		{"create -s -e /app/lock 'a b'", "create", []string{"/app/lock", "a b"}, map[string]string{"s": "true", "e": "true"}},
		{"create -es /app/lock", "create", []string{"/app/lock"}, map[string]string{"e": "true", "s": "true"}},
		{"create -t 60000 /app/ttl data", "create", []string{"/app/ttl", "data"}, map[string]string{"t": "60000"}},
		{"create -t60000 /app/ttl", "create", []string{"/app/ttl"}, map[string]string{"t": "60000"}},
		{"set -v 3 /app/x -1;", "set", []string{"/app/x", "-1"}, map[string]string{"v": "3"}},
		{`set /app/x "-s"`, "set", []string{"/app/x", "-s"}, map[string]string{}},
		{"set /app/x -- -abc", "set", []string{"/app/x", "-abc"}, map[string]string{}},
		{"LS -R /", "ls", []string{"/"}, map[string]string{"R": "true"}},
		{`setAcl -R /app digest:admin:abc=:cdrwa`, "setacl", []string{"/app", "digest:admin:abc=:cdrwa"}, map[string]string{"R": "true"}},
	}
	for _, tc := range cases {
		command, err := parseZooKeeperCommand(tc.text)
		if err != nil {
			t.Fatalf("%s: %v", tc.text, err)
		}
		if command.name != tc.name || !reflect.DeepEqual(command.args, tc.args) || !reflect.DeepEqual(command.options, tc.options) {
			t.Fatalf("%s parsed as %+v", tc.text, command)
		}
	}
	if _, err := parseZooKeeperCommand("set /x 'unclosed"); err == nil {
		t.Fatal("unclosed quotes must be rejected")
	}
	if _, err := parseZooKeeperCommand("  ;  "); err == nil {
		t.Fatal("empty commands must be rejected")
	}
}

func TestIsZooKeeperReadCommand(t *testing.T) {
	reads := []string{
		"ls /", "ls -s /app", "ls2 /app", "get -s /app", "stat /app", "stat", "getAcl /app", "sync /app",
		"addauth digest user:pass", "version", "config", "getAllChildrenNumber /app", "getEphemerals", "listquota /app",
		"srvr", "ruok", "mntr", "conf", "4lw envi", `SELECT * FROM "/app" LIMIT 10`,
	}
	for _, text := range reads {
		if !IsZooKeeperReadCommand(text) {
			t.Fatalf("%q must be read-only", text)
		}
	}
	writes := []string{
		"create /app", "set /app x", "delete /app", "deleteall /app", "rmr /app", "setAcl /app world:anyone:r",
		"crst", "4lw srst", "4lw", "unknown /app", "get 'unclosed",
	}
	for _, text := range writes {
		if IsZooKeeperReadCommand(text) {
			t.Fatalf("%q must be treated as a write", text)
		}
	}
}
