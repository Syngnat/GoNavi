package plugin

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The SDK guide is published by the market website. The cross-repository check
// runs only when GoNavi-Plugin-Market is checked out beside GoNavi.
func TestExportedIdentifiersAreDocumented(t *testing.T) {
	guidePath := filepath.Join("..", "..", "..", "GoNavi-Plugin-Market", "docs", "plugins", "sdk.md")
	doc, err := os.ReadFile(guidePath)
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("GoNavi-Plugin-Market checkout is not available beside GoNavi")
	}
	if err != nil {
		t.Fatal(err)
	}
	guide := string(doc)
	names, err := exportedIdentifiers(".")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) < 70 {
		t.Fatalf("scanned only %d exported identifiers; the parser probably stopped working", len(names))
	}
	var missing []string
	for _, name := range names {
		if !strings.Contains(guide, name) {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("undocumented exported identifiers: %v", missing)
	}
}

func exportedIdentifiers(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), filepath.Join(directory, name), nil, 0)
		if err != nil {
			return nil, err
		}
		for _, declaration := range file.Decls {
			switch node := declaration.(type) {
			case *ast.FuncDecl:
				if node.Recv == nil && node.Name.IsExported() {
					seen[node.Name.Name] = true
				}
			case *ast.GenDecl:
				for _, spec := range node.Specs {
					switch item := spec.(type) {
					case *ast.TypeSpec:
						if item.Name.IsExported() {
							seen[item.Name.Name] = true
						}
					case *ast.ValueSpec:
						for _, identifier := range item.Names {
							if identifier.IsExported() {
								seen[identifier.Name] = true
							}
						}
					}
				}
			}
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
