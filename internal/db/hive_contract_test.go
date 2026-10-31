package db

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func TestHiveSourceSizeLimits(t *testing.T) {
	patterns := []string{"hive*.go", "../hivesql/*.go", "../../cmd/optional-driver-agent/hive*.go"}
	for _, pattern := range patterns {
		files, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range files {
			if strings.HasSuffix(path, "_test.go") {
				continue
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if lines := strings.Count(string(raw), "\n") + 1; lines > 800 {
				t.Errorf("%s has %d lines", path, lines)
			}
			set := token.NewFileSet()
			file, err := parser.ParseFile(set, path, raw, 0)
			if err != nil {
				t.Fatal(err)
			}
			for _, decl := range file.Decls {
				function, ok := decl.(*ast.FuncDecl)
				if !ok || function.Body == nil {
					continue
				}
				lines := set.Position(function.Body.End()).Line - set.Position(function.Body.Pos()).Line + 1
				if lines > 120 {
					t.Errorf("%s %s has %d lines", path, function.Name.Name, lines)
				}
			}
		}
	}
}

func TestHiveAgentBinaryCellNormalization(t *testing.T) {
	for _, test := range []struct {
		typ   string
		value any
		want  any
	}{{"BINARY", []byte{0, 255}, "0x00ff"}, {"STRING", []byte("abc"), "abc"}} {
		typ, err := hivesql.ParseType(test.typ)
		if err != nil {
			t.Fatal(err)
		}
		got, err := hiveAgentCell(typ, test.value)
		if err != nil || got != test.want {
			t.Fatalf("IPC %s=%v err=%v", test.typ, got, err)
		}
	}
	typ, err := hivesql.ParseType("STRUCT<b:BINARY>")
	if err != nil {
		t.Fatal(err)
	}
	got, err := hiveAgentCell(typ, map[string]any{"b": []byte{0, 255}})
	if err != nil {
		t.Fatal(err)
	}
	fields, ok := got.(map[string]any)
	if !ok || fields["b"] != "0x00ff" {
		t.Fatalf("nested IPC=%v", got)
	}
	if !hiveHasBytes([]map[string]any{{"x": []byte{1}}}) || hiveHasBytes([]map[string]any{{"x": "text"}}) {
		t.Fatal("native binary detection mismatch")
	}
}

func TestHiveJDBCSessionConfigurationAndVariables(t *testing.T) {
	cfg, err := normalizeHiveConfig(connection.ConnectionConfig{URI: "jdbc:hive2://server/default?tez.queue.name=analytics;hive.execution.engine=mr#CaseVar=value%2Bplus"})
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"set:hiveconf:tez.queue.name": "analytics", "set:hiveconf:hive.execution.engine": "mr", "set:hivevar:CaseVar": "value+plus"} {
		if cfg.session[name] != want {
			t.Fatalf("session %s=%q want=%q", name, cfg.session[name], want)
		}
	}
	for _, params := range []string{"initFile=file.sql", "init_sql=SELECT+1", "session.initFile=x"} {
		if _, err := normalizeHiveConfig(connection.ConnectionConfig{ConnectionParams: params}); err == nil {
			t.Fatalf("accepted auto-executed script %s", params)
		}
	}
}
