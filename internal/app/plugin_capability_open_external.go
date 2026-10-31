package app

import (
	"context"
	"net/url"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// openPluginExternalURL is the only way a plugin can hand a URL to the system
// browser. It stays a variable so tests can observe the exact target without
// launching a real browser.
var openPluginExternalURL = wailsRuntime.BrowserOpenURL

// pluginExternalURLMaxBytes bounds the target so a page cannot push a data URL
// or a pathological query string through the bridge.
const pluginExternalURLMaxBytes = 2048

type pluginCapabilityOpenExternalArguments struct {
	URL string `json:"url"`
}

type pluginCapabilityOpenExternalResult struct {
	Opened bool `json:"opened"`
}

// pluginCapabilityOpenExternal asks the operating system to open one http(s)
// link. It never navigates a host WebView, so a plugin cannot turn the main
// window, a plugin page frame or a plugin window into an address bar: the page
// keeps its opaque origin and the user keeps the browser's own chrome.
func pluginCapabilityOpenExternal(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityOpenExternalArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	target, ok := pluginExternalURL(arguments.URL)
	if !ok {
		return nil, "invalid_arguments"
	}
	// Only the desktop host owns a local browser. A web session would open the
	// link on the server machine, so it declines instead of pretending.
	if a == nil || a.webRuntime || a.headlessRuntime || a.ctx == nil {
		return nil, "unsupported"
	}
	openPluginExternalURL(a.ctx, target)
	return pluginCapabilityOpenExternalResult{Opened: true}, ""
}

// pluginExternalURL accepts only absolute http(s) URLs without embedded
// credentials. Everything else (file:, javascript:, data:, mailto:, ftp:,
// user@host, control characters) is rejected before the OS sees it.
func pluginExternalURL(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > pluginExternalURLMaxBytes {
		return "", false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return "", false
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.User != nil || parsed.Host == "" {
		return "", false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		return parsed.String(), true
	default:
		return "", false
	}
}
