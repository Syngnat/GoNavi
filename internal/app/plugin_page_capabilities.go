package app

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
)

// Capability method names are stable contract values: the front-end bridge and
// the published plugin pages contract refer to them verbatim.
const (
	pluginPageMethodAppInfo           = "app.info"
	pluginPageMethodConnectionsList   = "connections.list"
	pluginPageMethodMetadataDatabases = "metadata.databases"
	pluginPageMethodMetadataTables    = "metadata.tables"
	pluginPageMethodMetadataColumns   = "metadata.columns"
	pluginPageMethodQueryRead         = "query.read"
	pluginPageMethodNotify            = "ui.notify"
)

// pluginCapabilityAPIVersion is the capability catalogue generation exposed by
// app.info. It is independent from the package manifest apiVersion so older
// packages keep working while hosts add capabilities.
const pluginCapabilityAPIVersion = 2

// pluginPageAppInfoResult is the app.info payload. It exposes identity only;
// no host paths, configuration or connection details.
type pluginPageAppInfoResult struct {
	HostVersion         string `json:"hostVersion"`
	PluginID            string `json:"pluginId"`
	PluginVersion       string `json:"pluginVersion"`
	Locale              string `json:"locale"`
	Runtime             string `json:"runtime"`
	CapabilitiesVersion int    `json:"capabilitiesVersion"`
}

func pluginPageAppInfo(_ context.Context, a *App, request pluginPageRequest) (any, string) {
	var arguments struct{}
	if !decodePluginPageArguments(request.arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	runtimeName := "desktop"
	if a != nil && a.webRuntime {
		runtimeName = "web"
	}
	return pluginPageAppInfoResult{
		HostVersion:         CurrentVersion(),
		PluginID:            request.status.Manifest.ID,
		PluginVersion:       request.status.Manifest.Version,
		Locale:              a.pluginPageLocale(),
		Runtime:             runtimeName,
		CapabilitiesVersion: pluginCapabilityAPIVersion,
	}, ""
}

// pluginPageNotify is a declared no-op: v1 renders ui.notify in the page bridge
// itself, but the method stays registered so a page call never fails solely
// because the host did not implement a local UI affordance.
func pluginPageNotify(_ context.Context, _ *App, request pluginPageRequest) (any, string) {
	var arguments struct {
		Message string `json:"message"`
		Type    string `json:"type,omitempty"`
	}
	if !decodePluginPageArguments(request.arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.Message) == "" {
		return nil, "invalid_arguments"
	}
	return nil, ""
}

// decodePluginPageArguments rejects unknown fields so a page cannot smuggle
// connection credentials or host-only options through an ignored key.
func decodePluginPageArguments(arguments json.RawMessage, target any) bool {
	decoder := json.NewDecoder(bytes.NewReader(arguments))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target) == nil
}

// pluginPageLocale reports the language the host renders in. It falls back to
// the process default when the app has not created its localizer yet.
func (a *App) pluginPageLocale() string {
	if a != nil {
		a.i18nMu.RLock()
		localizer := a.localizer
		language := ""
		if localizer != nil {
			language = string(localizer.Language())
		}
		a.i18nMu.RUnlock()
		if language != "" {
			return language
		}
	}
	defaultAppTextMu.RLock()
	defer defaultAppTextMu.RUnlock()
	return string(defaultAppTextLanguage)
}
