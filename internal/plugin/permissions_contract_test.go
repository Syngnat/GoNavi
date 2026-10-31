package plugin

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var permissionLiteral = regexp.MustCompile(`"(ai\.(?:skills|providers|tools)|data\.(?:sources|export)|host\.(?:log|describe|connections\.read|connections\.credentials|metadata\.read|query\.read|schema\.write)|system\.open-external|ui\.(?:html-panel|pages))"`)

// Public permissions are published at https://plugin.gonavi.org/docs/permissions.
// A local checkout of the market repo enables the cross-repository lockstep check.
func TestEnforcedPermissionsMatchTheReference(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "..", "GoNavi-Plugin-Market", "docs", "plugins", "permissions.md"))
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("GoNavi-Plugin-Market checkout is not available beside GoNavi")
	}
	if err != nil {
		t.Fatal(err)
	}
	documented := map[string]bool{}
	for _, line := range strings.Split(string(doc), "\n") {
		if !strings.HasPrefix(line, "| `") {
			continue
		}
		name := strings.SplitN(strings.TrimPrefix(line, "| `"), "`", 2)[0]
		documented[name] = true
	}
	if len(documented) < 7 {
		t.Fatalf("parsed only %d documented permissions", len(documented))
	}
	enforced := map[string]bool{}
	for _, directory := range []string{".", filepath.Join("..", "mcpserver"), filepath.Join("..", "app"), filepath.Join("..", "dataexport"), filepath.Join("..", "..", "sdk", "go")} {
		entries, err := os.ReadDir(directory)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			body, err := os.ReadFile(filepath.Join(directory, name))
			if err != nil {
				t.Fatal(err)
			}
			for _, match := range permissionLiteral.FindAllStringSubmatch(string(body), -1) {
				enforced[match[1]] = true
			}
		}
	}
	var missingFromDoc, missingFromCode []string
	for name := range enforced {
		if !documented[name] {
			missingFromDoc = append(missingFromDoc, name)
		}
	}
	for name := range documented {
		if !enforced[name] {
			missingFromCode = append(missingFromCode, name)
		}
	}
	sort.Strings(missingFromDoc)
	sort.Strings(missingFromCode)
	if len(missingFromDoc) > 0 || len(missingFromCode) > 0 {
		t.Fatalf("undocumented permissions %v; documented but unenforced %v", missingFromDoc, missingFromCode)
	}
}
