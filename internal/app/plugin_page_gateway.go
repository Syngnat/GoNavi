package app

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"time"

	"GoNavi-Wails/internal/plugin"
)

// The page bridge is intentionally tiny: one binding, an explicit method
// registry, bounded arguments/results and one timeout shared by every handler.
const (
	pluginPageMaxArgumentsBytes = 64 << 10
	pluginPageMaxResultBytes    = 256 << 10
	pluginPageCallTimeout       = 30 * time.Second
	pluginPageMaxIdentityBytes  = 128
)

// pluginPageRequest is the immutable context a capability handler receives.
// It never contains connection credentials: handlers resolve saved connections
// by id on the host side.
type pluginPageRequest struct {
	pluginID  string
	pageID    string
	method    string
	status    plugin.Status
	arguments json.RawMessage
}

// pluginPageHandler returns a JSON-serializable value or a stable failure code
// from the page error set. It must honor ctx and must not execute writes.
type pluginPageHandler func(ctx context.Context, a *App, request pluginPageRequest) (any, string)

// pluginPageCapability is one registered method. An empty permission means the
// method only requires a declared page (for example app.info).
type pluginPageCapability struct {
	permission string
	handle     pluginPageHandler
}

type pluginPageCapabilities map[string]pluginPageCapability

func pluginPageDeclared(manifest plugin.Manifest, pageID string) bool {
	if pageID == "" {
		return false
	}
	for _, page := range manifest.Contributes.Pages {
		if page.ID == pageID {
			return true
		}
	}
	return false
}

// Permission matching stays exact and case-sensitive so a typo in a manifest
// cannot silently acquire a host capability.
func pluginPageHasPermission(manifest plugin.Manifest, permission string) bool {
	for _, granted := range manifest.Permissions {
		if granted == permission {
			return true
		}
	}
	return false
}

func pluginPageArgumentsRaw(argumentsJSON string) json.RawMessage {
	raw := strings.TrimSpace(argumentsJSON)
	if raw == "" {
		return json.RawMessage("{}")
	}
	return json.RawMessage(raw)
}

// Arguments must be one bounded JSON object. Handlers still decode fields
// strictly; this only enforces the bridge-level contract.
func pluginPageArgumentsValid(arguments json.RawMessage) bool {
	if len(arguments) == 0 || len(arguments) > pluginPageMaxArgumentsBytes || !json.Valid(arguments) {
		return false
	}
	trimmed := bytes.TrimSpace(arguments)
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}

// pluginPageResultCode bounds the serialized capability result before it is
// handed to the WebView. Encoding failures are host bugs, not size failures.
func pluginPageResultCode(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "internal"
	}
	if len(encoded) > pluginPageMaxResultBytes {
		return "result_too_large"
	}
	return ""
}

func pluginPageIdentityValid(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= pluginPageMaxIdentityBytes
}
