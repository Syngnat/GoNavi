package app

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHiveSourcesRespectRepositorySizeLimits(t *testing.T) {
	patterns := []string{
		"hive_*.go", "methods_file_*hive*.go", "import_pipeline_hive*.go", "sql_import_hive*.go", "explain_parse_hive*.go",
		"../db/hive*.go", "../db/table_info_hive*.go", "../db/data_source_hive*.go",
		"../hivesql/*.go", "../sync/hive*.go", "../../cmd/optional-driver-agent/*hive*.go",
	}
	for _, pattern := range patterns {
		paths, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			t.Run(filepath.ToSlash(path), func(t *testing.T) { checkHiveSourceLimits(t, path) })
		}
	}
}

func checkHiveSourceLimits(t *testing.T, path string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	limit := 800
	if strings.HasSuffix(path, "_test.go") {
		limit = 1500
	}
	lines := strings.Count(string(content), "\n")
	if len(content) > 0 && content[len(content)-1] != '\n' {
		lines++
	}
	if lines > limit {
		t.Errorf("%s has %d lines, repository maximum is %d", path, lines, limit)
	}
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, path, content, 0)
	if err != nil {
		t.Fatal(err)
	}
	ast.Inspect(file, func(node ast.Node) bool {
		var body *ast.BlockStmt
		var name string
		switch function := node.(type) {
		case *ast.FuncDecl:
			body, name = function.Body, function.Name.Name
		case *ast.FuncLit:
			body, name = function.Body, "closure"
		default:
			return true
		}
		if body == nil {
			return true
		}
		first := positions.Position(body.Lbrace).Line
		last := positions.Position(body.Rbrace).Line
		if last-first-1 > 120 {
			t.Errorf("%s:%d %s has %d body lines, maximum is 120", path, first, name, last-first-1)
		}
		return true
	})
}
