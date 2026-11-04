package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

// One sidebar group's runtime node tree is bounded before it reaches the tree.
const (
	pluginSidebarMaxNodes      = 500
	pluginSidebarMaxDepth      = 4
	pluginSidebarMaxIDBytes    = 256
	pluginSidebarMaxTextBytes  = 256
	pluginSidebarMaxArguments  = 4 << 10
	pluginSidebarMaxResultSize = 256 << 10
	pluginSidebarCallTimeout   = 10 * time.Second
)

// pluginSidebarNode is one host-rendered tree entry. Labels are always text;
// the plugin never supplies markup, styles or host paths.
type pluginSidebarNode struct {
	ID          string              `json:"id"`
	Label       string              `json:"label"`
	Description string              `json:"description,omitempty"`
	Badge       string              `json:"badge,omitempty"`
	Children    []pluginSidebarNode `json:"children,omitempty"`
	Open        *pluginSidebarOpen  `json:"open,omitempty"`
}

type pluginSidebarOpen struct {
	Type      string          `json:"type"`
	Page      string          `json:"page,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// PluginSidebarNodes returns one declared group's bounded node tree for the
// left connection tree. Node data is produced by the group's listCommand and
// validated here; the frontend only renders it.
func (a *App) PluginSidebarNodes(pluginID, groupID string) connection.QueryResult {
	return a.pluginSidebarNodesContext(a.pluginContext(), pluginID, groupID)
}

func (a *App) pluginSidebarNodesContext(parent context.Context, pluginID, groupID string) connection.QueryResult {
	if a == nil || !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	if parent == nil {
		return a.pluginFailure("sidebar_internal")
	}
	pluginID = strings.TrimSpace(pluginID)
	groupID = strings.TrimSpace(groupID)
	if !pluginPageIdentityValid(pluginID) || !pluginPageIdentityValid(groupID) {
		return a.pluginFailure("sidebar_invalid_identity")
	}
	ctx, cancel := context.WithTimeout(parent, pluginSidebarCallTimeout)
	defer cancel()
	status, code := a.pluginPageStatus(ctx, pluginID)
	if code != "" {
		return a.pluginFailure("sidebar_" + code)
	}
	group, ok := resolvePluginSidebarGroup(status.Manifest, groupID)
	if !ok {
		return a.pluginFailure("sidebar_not_declared")
	}
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("sidebar_internal")
	}
	raw, err := manager.InvokeGeneration(ctx, status.Manifest.ID, status.Generation, group.ListCommand, json.RawMessage(`{}`))
	if err != nil {
		return a.pluginSidebarError(err)
	}
	if len(raw) > pluginSidebarMaxResultSize {
		return a.pluginFailure("sidebar_result_too_large")
	}
	items, err := decodePluginSidebarNodes(status.Manifest, raw)
	if err != nil {
		return a.pluginFailure("sidebar_invalid_result")
	}
	return connection.QueryResult{Success: true, Data: map[string]any{"items": items}}
}

// PluginOpenSidebarWindow opens the plugin's own window for one sidebar node.
// The host owns the launch context; the frontend only supplies node identity
// and the bounded arguments the plugin itself returned.
func (a *App) PluginOpenSidebarWindow(pluginID, groupID, nodeID, argumentsJSON string) connection.QueryResult {
	if a == nil || !a.pluginManagementAllowed() || a.headlessRuntime {
		return a.pluginFailure("window_unavailable")
	}
	pluginID = strings.TrimSpace(pluginID)
	groupID = strings.TrimSpace(groupID)
	nodeID = strings.TrimSpace(nodeID)
	if !pluginPageIdentityValid(pluginID) || !pluginPageIdentityValid(groupID) || !pluginPageIdentityValid(nodeID) {
		return a.pluginFailure("sidebar_invalid_identity")
	}
	arguments := json.RawMessage(strings.TrimSpace(argumentsJSON))
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	if len(arguments) > pluginSidebarMaxArguments || !json.Valid(arguments) || !jsonObject(arguments) {
		return a.pluginFailure("sidebar_invalid_arguments")
	}
	ctx := a.pluginContext()
	status, code := a.pluginPageStatus(ctx, pluginID)
	if code != "" {
		return a.pluginFailure("sidebar_" + code)
	}
	if _, ok := resolvePluginSidebarGroup(status.Manifest, groupID); !ok {
		return a.pluginFailure("sidebar_not_declared")
	}
	if status.Manifest.Window == nil {
		return a.pluginFailure("window_unavailable")
	}
	launch, err := json.Marshal(map[string]any{
		"kind": "sidebar", "pluginId": status.Manifest.ID, "groupId": groupID, "nodeId": nodeID, "arguments": arguments,
	})
	if err != nil {
		return a.pluginFailure("sidebar_internal")
	}
	a.plugins.mu.Lock()
	windows := a.plugins.windows
	a.plugins.mu.Unlock()
	if windows == nil {
		return a.pluginFailure("window_unavailable")
	}
	windowKey := fmt.Sprintf("%s:sidebar:%s:%s", status.Manifest.ID, groupID, nodeID)
	value, err := windows.Open(ctx, status.Manifest.ID, windowKey, launch, "", "")
	if errors.Is(err, context.Canceled) {
		return a.pluginFailure("window_unavailable")
	}
	if err != nil {
		return a.pluginResult(nil, err)
	}
	return a.pluginResult(value, nil)
}

func resolvePluginSidebarGroup(manifest plugin.Manifest, groupID string) (plugin.SidebarGroup, bool) {
	for _, group := range manifest.Contributes.Sidebar {
		if group.ID == groupID {
			return group, true
		}
	}
	return plugin.SidebarGroup{}, false
}

func (a *App) pluginSidebarError(err error) connection.QueryResult {
	if errors.Is(err, plugin.ErrDisabled) {
		return a.pluginFailure("sidebar_not_running")
	}
	return a.pluginFailure("sidebar_unavailable")
}

// decodePluginSidebarNodes parses the listCommand result and re-checks every
// bound before the host renders it. Unknown fields and duplicate ids fail the
// whole group rather than rendering a partial tree.
func decodePluginSidebarNodes(manifest plugin.Manifest, raw []byte) ([]pluginSidebarNode, error) {
	var payload struct {
		Items []pluginSidebarNode `json:"items"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, fmt.Errorf("trailing sidebar data")
	}
	count := 0
	seen := make(map[string]bool, len(payload.Items))
	if err := validatePluginSidebarNodes(payload.Items, manifest, 0, &count, seen); err != nil {
		return nil, err
	}
	return payload.Items, nil
}

func validatePluginSidebarNodes(nodes []pluginSidebarNode, manifest plugin.Manifest, depth int, count *int, seen map[string]bool) error {
	if depth > pluginSidebarMaxDepth {
		return fmt.Errorf("sidebar node depth exceeded")
	}
	for _, node := range nodes {
		*count++
		if *count > pluginSidebarMaxNodes {
			return fmt.Errorf("sidebar node count exceeded")
		}
		id := strings.TrimSpace(node.ID)
		if id == "" || len(id) > pluginSidebarMaxIDBytes || seen[id] {
			return fmt.Errorf("invalid or duplicate sidebar node")
		}
		seen[id] = true
		if strings.TrimSpace(node.Label) == "" || len(node.Label) > pluginSidebarMaxTextBytes ||
			len(node.Description) > pluginSidebarMaxTextBytes || len(node.Badge) > pluginSidebarMaxTextBytes {
			return fmt.Errorf("invalid sidebar node text")
		}
		if node.Open != nil {
			if err := validatePluginSidebarOpen(manifest, *node.Open); err != nil {
				return err
			}
		}
		if err := validatePluginSidebarNodes(node.Children, manifest, depth+1, count, seen); err != nil {
			return err
		}
	}
	return nil
}

func validatePluginSidebarOpen(manifest plugin.Manifest, open pluginSidebarOpen) error {
	switch open.Type {
	case "window":
		if manifest.Window == nil {
			return fmt.Errorf("window sidebar node requires a window")
		}
	case "page":
		found := false
		for _, page := range manifest.Contributes.Pages {
			if page.ID == open.Page {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("sidebar node references an undeclared page")
		}
	default:
		return fmt.Errorf("unsupported sidebar node target")
	}
	if len(open.Arguments) > pluginSidebarMaxArguments || (len(open.Arguments) > 0 && (!json.Valid(open.Arguments) || !jsonObject(open.Arguments))) {
		return fmt.Errorf("invalid sidebar node arguments")
	}
	return nil
}

func jsonObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}
