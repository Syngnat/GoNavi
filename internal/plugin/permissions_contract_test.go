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

// 权限字面量的形状：宿主强制的权限全部落在 ai/data/host/system/ui 五个命名空间里。
//
// 这里曾经是一串**硬编码的权限名白名单**，于是新权限只要没被那位作者顺手加进白名单，
// 扫描就完全看不见它——门禁对「新增权限」恰好失效（host.ai.providers.write 就是这么漏进
// 公开词表的对不上的那一轮）。所以改成按命名空间泛化：新权限出现即被扫到。
var permissionLiteral = regexp.MustCompile(`"((?:ai|data|host|system|ui)\.[a-z][a-z0-9._:-]{0,127})"`)

// permissionContext 把「行内字面量」筛成「权限字面量」：只有在讲权限的那一行上才算
// （常量声明、capability 的 Permission: 字段、permission == "x" 判断、hasPermission(m, "x")）。
//
// 少了这一步就会误伤同名不同物的字符串：`host.capability` 是 JSON-RPC 方法名、
// `ai.providers.import` 是能力名（它的权限是 host.ai.providers.write），它们都出现在
// 与 permissions 无关的行上。
//
// 约定：新增权限要么声明成 `XxxPermission = "..."` 常量，要么在权限判断语句里出现字面量；
// 两者都带 "permission" 字样，因此都进得了这道门禁。
var permissionContext = regexp.MustCompile(`(?i)permission`)

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
	enforced := enforcedPermissions(t)
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

// enforcedPermissions 扫出宿主代码里真正在用的权限字面量。
func enforcedPermissions(t *testing.T) map[string]bool {
	t.Helper()
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
			for _, line := range strings.Split(string(body), "\n") {
				if !permissionContext.MatchString(line) {
					continue
				}
				for _, match := range permissionLiteral.FindAllStringSubmatch(line, -1) {
					enforced[match[1]] = true
				}
			}
		}
	}
	return enforced
}
