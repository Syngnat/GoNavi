package app

import (
	"context"
	"unicode/utf8"

	wailsRuntime "GoNavi-Wails/internal/desktop"
)

// Clipboard access stays replaceable so tests never touch the system clipboard.
var (
	clipboardGetText = wailsRuntime.ClipboardGetText
	clipboardSetText = wailsRuntime.ClipboardSetText
)

const (
	pluginClipboardPermission = "host.clipboard"
	pluginClipboardMaxRead    = 64 << 10
	pluginClipboardMaxWrite   = 256 << 10
)

type pluginClipboardWriteArguments struct {
	Text string `json:"text"`
}

type pluginClipboardReadResult struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

func pluginCapabilityClipboardRead(_ context.Context, a *App, _ pluginCapabilityRequest) (any, string) {
	if a == nil || a.webRuntime || a.headlessRuntime || a.ctx == nil {
		return nil, "unsupported"
	}
	text, err := clipboardGetText(a.ctx)
	if err != nil {
		return nil, "internal"
	}
	if !utf8.ValidString(text) {
		return nil, "internal"
	}
	if len(text) > pluginClipboardMaxRead {
		// Cut on a rune boundary so the caller never receives a broken string.
		cut := pluginClipboardMaxRead
		for cut > 0 && !utf8.ValidString(text[:cut]) {
			cut--
		}
		return pluginClipboardReadResult{Text: text[:cut], Truncated: true}, ""
	}
	return pluginClipboardReadResult{Text: text}, ""
}

func pluginCapabilityClipboardWrite(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginClipboardWriteArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if a == nil || a.webRuntime || a.headlessRuntime || a.ctx == nil {
		return nil, "unsupported"
	}
	if len(arguments.Text) > pluginClipboardMaxWrite || !utf8.ValidString(arguments.Text) {
		return nil, "invalid_arguments"
	}
	if err := clipboardSetText(a.ctx, arguments.Text); err != nil {
		return nil, "internal"
	}
	return map[string]any{"written": true}, ""
}
