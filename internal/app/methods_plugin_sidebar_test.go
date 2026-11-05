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

func TestDecodePluginSidebarNodesIgnoresUnknownFields(t *testing.T) {
	raw := []byte(`{"items":[{"id":"a","label":"A","icon":"ssh","meta":{"region":"eu"}}]}`)
	nodes, err := decodePluginSidebarNodes(sidebarTestManifest(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].ID != "a" {
		t.Fatalf("unknown fields must not drop the node: %#v", nodes)
	}
}

func TestDecodePluginSidebarNodesSkipsOnlyInvalidNodes(t *testing.T) {
	raw := []byte(`{"items":[{"label":"missing id"},{"id":"ok","label":"OK"},{"id":"bad-open","label":"Bad","open":{"type":"page","page":"missing"}}]}`)
	nodes, err := decodePluginSidebarNodes(sidebarTestManifest(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].ID != "ok" {
		t.Fatalf("invalid nodes should be skipped, got %#v", nodes)
	}
}

func TestDecodePluginSidebarNodesSanitizesActions(t *testing.T) {
	raw := []byte(`{"items":[{"id":"a","label":"A","actions":[{"id":"rename","title":"Rename","command":"rename","arguments":{"to":"x"}},{"id":"","title":"","command":""}]}]}`)
	nodes, err := decodePluginSidebarNodes(sidebarTestManifest(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || len(nodes[0].Actions) != 1 || nodes[0].Actions[0].Command != "rename" {
		t.Fatalf("unexpected actions: %#v", nodes)
	}
}

func TestDecodePluginSidebarNodesDropsInvalidEntries(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"missing id", `{"items":[{"label":"A"}]}`},
		{"empty label", `{"items":[{"id":"a","label":" "}]}`},
		{"long label", `{"items":[{"id":"a","label":"` + strings.Repeat("x", 300) + `"}]}`},
		{"undeclared page", `{"items":[{"id":"a","label":"A","open":{"type":"page","page":"missing"}}]}`},
		{"window without manifest window", `{"items":[{"id":"a","label":"A","open":{"type":"window"}}]}`},
		{"unsupported target", `{"items":[{"id":"a","label":"A","open":{"type":"panel"}}]}`},
		{"non object arguments", `{"items":[{"id":"a","label":"A","open":{"type":"page","page":"main","arguments":[1]}}]}`},
		{"oversized arguments", `{"items":[{"id":"a","label":"A","open":{"type":"page","page":"main","arguments":{"v":"` + strings.Repeat("x", pluginSidebarMaxArguments) + `"}}}]}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			nodes, err := decodePluginSidebarNodes(sidebarTestManifest(), []byte(test.raw))
			if err != nil {
				t.Fatalf("invalid entries must be skipped, not fail the group: %v", err)
			}
			if len(nodes) != 0 {
				t.Fatalf("invalid entry survived: %#v", nodes)
			}
		})
	}
}

func TestDecodePluginSidebarNodesKeepsTheFirstDuplicate(t *testing.T) {
	nodes, err := decodePluginSidebarNodes(sidebarTestManifest(), []byte(`{"items":[{"id":"a","label":"A"},{"id":"a","label":"B"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].Label != "A" {
		t.Fatalf("duplicate id must keep the first node: %#v", nodes)
	}
}

func TestDecodePluginSidebarNodesStillBoundsTrees(t *testing.T) {
	if _, err := decodePluginSidebarNodes(sidebarTestManifest(), []byte(manySidebarNodes(pluginSidebarMaxNodes+1))); err == nil {
		t.Fatal("node count limit was not enforced")
	}
	if _, err := decodePluginSidebarNodes(sidebarTestManifest(), []byte(deepSidebarTree(pluginSidebarMaxDepth+1))); err != nil {
		t.Fatalf("deep trees must be truncated, not rejected: %v", err)
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
