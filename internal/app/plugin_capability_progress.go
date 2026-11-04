package app

import (
	"context"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/uievents"
)

const (
	pluginProgressPermission = "ui.progress"
	pluginProgressEventName  = "plugin:progress"
	pluginProgressMaxID      = 64
	pluginProgressMaxTitle   = 128
	pluginProgressMaxDetail  = 256
)

type pluginProgressArguments struct {
	ID      string `json:"id"`
	Action  string `json:"action"`
	Title   string `json:"title,omitempty"`
	Detail  string `json:"detail,omitempty"`
	Percent *int   `json:"percent,omitempty"`
}

// pluginCapabilityProgress publishes one bounded progress update to the host
// UI. The host renders it as a notification; the plugin never touches the DOM.
func pluginCapabilityProgress(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginProgressArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if a == nil || a.webRuntime || a.headlessRuntime || a.ctx == nil || !uievents.CanEmit(a.ctx) {
		return nil, "unsupported"
	}
	id := strings.TrimSpace(arguments.ID)
	if id == "" || len(id) > pluginProgressMaxID {
		return nil, "invalid_arguments"
	}
	action := strings.TrimSpace(arguments.Action)
	switch action {
	case "open", "update":
	case "close":
		uievents.Emit(a.ctx, pluginProgressEventName, map[string]any{
			"pluginId": request.Status.Manifest.ID, "id": id, "action": action,
		})
		return map[string]any{"accepted": true}, ""
	default:
		return nil, "invalid_arguments"
	}
	title := strings.TrimSpace(arguments.Title)
	if action == "open" && (title == "" || len(title) > pluginProgressMaxTitle || !utf8.ValidString(title)) {
		return nil, "invalid_arguments"
	}
	detail := strings.TrimSpace(arguments.Detail)
	if len(detail) > pluginProgressMaxDetail || !utf8.ValidString(detail) {
		return nil, "invalid_arguments"
	}
	percent := 0
	if arguments.Percent != nil {
		percent = *arguments.Percent
		if percent < 0 || percent > 100 {
			return nil, "invalid_arguments"
		}
	}
	uievents.Emit(a.ctx, pluginProgressEventName, map[string]any{
		"pluginId": request.Status.Manifest.ID, "id": id, "action": action,
		"title": title, "detail": detail, "percent": percent,
	})
	return map[string]any{"accepted": true}, ""
}
