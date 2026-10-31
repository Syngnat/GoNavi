package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

// pluginConnectionActionContext is the only launch context a connection action
// receives. Credentials are included only when the package declared
// host.connections.credentials; the window is a trusted native plugin surface,
// not a sandboxed page.
type pluginConnectionActionContext struct {
	Kind            string                       `json:"kind"`
	ActionID        string                       `json:"actionId"`
	ConnectionID    string                       `json:"connectionId"`
	ConnectionName  string                       `json:"connectionName"`
	ConnectionType  string                       `json:"connectionType"`
	Database        string                       `json:"database,omitempty"`
	Collection      string                       `json:"collection,omitempty"`
	EnvironmentType string                       `json:"environmentType,omitempty"`
	ReadOnly        bool                         `json:"readOnly"`
	Config          *connection.ConnectionConfig `json:"config,omitempty"`
}

// PluginRunConnectionAction is the generic host entry for a package-declared
// connection, database or collection action. The host owns the launch context;
// the frontend only supplies node identity.
func (a *App) PluginRunConnectionAction(pluginID, actionID, connectionID, database, collection string) connection.QueryResult {
	if a == nil || !a.pluginManagementAllowed() || a.headlessRuntime {
		return a.pluginFailure("window_unavailable")
	}
	pluginID = strings.TrimSpace(pluginID)
	actionID = strings.TrimSpace(actionID)
	connectionID = strings.TrimSpace(connectionID)
	database = strings.TrimSpace(database)
	collection = strings.TrimSpace(collection)
	if pluginID == "" || actionID == "" || connectionID == "" {
		return a.pluginFailure("invalid_request")
	}
	manager, err := a.pluginManager(a.pluginContext())
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	var status plugin.Status
	found := false
	for _, candidate := range manager.List() {
		if candidate.Manifest.ID != pluginID {
			continue
		}
		status = candidate
		found = true
		break
	}
	if !found {
		return a.pluginFailure("not_found")
	}
	if !status.DesiredEnabled || status.State != plugin.StateRunning {
		return a.pluginFailure("plugin_disabled")
	}
	action, ok := resolvePluginConnectionAction(status.Manifest, actionID)
	if !ok {
		return a.pluginFailure("invalid_request")
	}
	if action.Target.Type != "window" && action.Target.Type != "page" {
		return a.pluginFailure("invalid_request")
	}
	scope := "connection"
	if database != "" {
		scope = "database"
	}
	if collection != "" {
		scope = "collection"
	}
	if !pluginConnectionActionAllowsScope(action, scope) {
		return a.pluginFailure("invalid_request")
	}
	repository := a.savedConnectionRepository()
	view, err := repository.Find(connectionID)
	if err != nil {
		return a.pluginFailure("not_found")
	}
	connectionType := strings.ToLower(strings.TrimSpace(view.Config.Type))
	if !pluginConnectionActionAllowsType(action, connectionType) {
		return a.pluginFailure("invalid_request")
	}
	launch, code := a.pluginConnectionActionLaunch(status, action, view, connectionType, database, collection, action.Target.Type == "window")
	if code != "" {
		return a.pluginFailure(code)
	}
	if action.Target.Type == "page" {
		page, ok := pluginConnectionActionPage(status.Manifest, action.Target.Page)
		if !ok {
			return a.pluginFailure("invalid_request")
		}
		// includeConfig is false for page targets, so credentials were never resolved.
		return a.pluginResult(map[string]any{
			"kind":     "page",
			"pluginId": status.Manifest.ID,
			"pageId":   page.ID,
			"title":    page.Title,
			"launch":   launch,
		}, nil)
	}
	contextJSON, err := json.Marshal(launch)
	if err != nil {
		return a.pluginFailure("operation_failed")
	}
	a.plugins.mu.Lock()
	windows := a.plugins.windows
	a.plugins.mu.Unlock()
	if windows == nil {
		return a.pluginFailure("window_unavailable")
	}
	windowKey := fmt.Sprintf("%s:%s:%s:%s:%s:%s", status.Manifest.ID, action.ID, scope, view.ID, database, collection)
	// 连接动作由后端自行发起，调用方没有携带宿主外观；留空让子进程沿用插件自身默认值。
	value, err := windows.Open(a.pluginContext(), status.Manifest.ID, windowKey, contextJSON, "", "")
	if err == context.Canceled {
		return a.pluginFailure("window_unavailable")
	}
	if err != nil {
		return a.pluginResult(nil, err)
	}
	return a.pluginResult(value, nil)
}

func resolvePluginConnectionAction(manifest plugin.Manifest, actionID string) (plugin.ConnectionAction, bool) {
	for _, action := range manifest.Contributes.ConnectionActions {
		if action.ID == actionID {
			return action, true
		}
	}
	return plugin.ConnectionAction{}, false
}

func pluginConnectionActionAllowsType(action plugin.ConnectionAction, connectionType string) bool {
	for _, candidate := range action.ConnectionTypes {
		if strings.EqualFold(strings.TrimSpace(candidate), connectionType) {
			return true
		}
	}
	return false
}

func pluginConnectionActionAllowsScope(action plugin.ConnectionAction, scope string) bool {
	if len(action.Scopes) == 0 {
		return scope == "connection"
	}
	for _, candidate := range action.Scopes {
		if candidate == scope {
			return true
		}
	}
	return false
}

func (a *App) pluginConnectionActionLaunch(status plugin.Status, action plugin.ConnectionAction, view connection.SavedConnectionView, connectionType, database, collection string, includeConfig bool) (pluginConnectionActionContext, string) {
	launch := pluginConnectionActionContext{
		Kind:            "connectionAction",
		ActionID:        action.ID,
		ConnectionID:    view.ID,
		ConnectionName:  view.Name,
		ConnectionType:  connectionType,
		Database:        database,
		Collection:      collection,
		EnvironmentType: view.EnvironmentType,
		ReadOnly:        pluginPageConnectionReadOnly(view.Config),
	}
	if !includeConfig || !pluginPageHasPermission(status.Manifest, plugin.ConnectionsCredentialsPermission) {
		return launch, ""
	}
	config, code := a.pluginPageConnectionConfig(view.ID)
	if code != "" {
		return pluginConnectionActionContext{}, code
	}
	launch.Config = &config
	return launch, ""
}

func pluginConnectionActionPage(manifest plugin.Manifest, pageID string) (plugin.Page, bool) {
	for _, page := range manifest.Contributes.Pages {
		if page.ID == pageID {
			return page, true
		}
	}
	return plugin.Page{}, false
}
