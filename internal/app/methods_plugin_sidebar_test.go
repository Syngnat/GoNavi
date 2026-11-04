package app

import (
	"fmt"
	"strings"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func sidebarTestManifest() plugin.Manifest {
	return plugin.Manifest{
		Contributes: plugin.Contributions{
			Pages: []plugin.Page{{ID: "main"}},
			Sidebar: []plugin.SidebarGroup{{
				ID: "ssh", Title: "SSH", ListCommand: "list",
			}},
		},
	}
}

func TestDecodePluginSidebarNodesAcceptsBoundedTree(t *testing.T) {
	raw := []byte(`{"items":[{"id":"prod","label":"prod","description":"root@host","badge":"online","children":[{"id":"sftp","label":"SFTP","open":{"type":"page","page":"main","arguments":{"view":"sftp"}}}],"open":{"type":"page","page":"main","arguments":{"profileId":"prod"}}}]}`)
	nodes, err := decodePluginSidebarNodes(sidebarTestManifest(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].ID != "prod" || len(nodes[0].Children) != 1 || nodes[0].Children[0].ID != "sftp" {
		t.Fatalf("unexpected tree: %#v", nodes)
	}
}

func TestDecodePluginSidebarNodesRejectsUnsafeTrees(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"unknown node field", `{"items":[{"id":"a","label":"A","html":"<b>x</b>"}]}`},
		{"missing id", `{"items":[{"label":"A"}]}`},
		{"duplicate id", `{"items":[{"id":"a","label":"A"},{"id":"a","label":"B"}]}`},
		{"empty label", `{"items":[{"id":"a","label":" "}]}`},
		{"long label", `{"items":[{"id":"a","label":"` + strings.Repeat("x", 300) + `"}]}`},
		{"undeclared page", `{"items":[{"id":"a","label":"A","open":{"type":"page","page":"missing"}}]}`},
		{"window without manifest window", `{"items":[{"id":"a","label":"A","open":{"type":"window"}}]}`},
		{"unsupported target", `{"items":[{"id":"a","label":"A","open":{"type":"panel"}}]}`},
		{"non object arguments", `{"items":[{"id":"a","label":"A","open":{"type":"page","page":"main","arguments":[1]}}]}`},
		{"oversized arguments", `{"items":[{"id":"a","label":"A","open":{"type":"page","page":"main","arguments":{"v":"` + strings.Repeat("x", pluginSidebarMaxArguments) + `"}}}]}`},
		{"too deep", deepSidebarTree(pluginSidebarMaxDepth + 1)},
		{"too many nodes", manySidebarNodes(pluginSidebarMaxNodes + 1)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodePluginSidebarNodes(sidebarTestManifest(), []byte(test.raw)); err == nil {
				t.Fatal("unsafe sidebar tree was accepted")
			}
		})
	}
}

func deepSidebarTree(depth int) string {
	node := `{"id":"leaf","label":"Leaf"}`
	for index := depth - 1; index >= 0; index-- {
		node = fmt.Sprintf(`{"id":"n%d","label":"N","children":[%s]}`, index, node)
	}
	return `{"items":[` + node + `]}`
}

func manySidebarNodes(count int) string {
	items := make([]string, 0, count)
	for index := 0; index < count; index++ {
		items = append(items, fmt.Sprintf(`{"id":"n%d","label":"N"}`, index))
	}
	return `{"items":[` + strings.Join(items, ",") + `]}`
}
