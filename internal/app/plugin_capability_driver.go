package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/db"
)

type pluginCapabilityDriverStatusItem struct {
	Type             string `json:"type"`
	Name             string `json:"name"`
	BuiltIn          bool   `json:"builtIn"`
	InstalledVersion string `json:"installedVersion,omitempty"`
	PackageInstalled bool   `json:"packageInstalled"`
	RuntimeAvailable bool   `json:"runtimeAvailable"`
	Connectable      bool   `json:"connectable"`
}

// pluginCapabilityDriverStatus returns only the local driver readiness summary.
// It never exposes install directories, package paths, executable paths or
// download URLs, and it does not resolve a remote manifest.
func pluginCapabilityDriverStatus(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if len(request.Arguments) > 0 {
		var arguments map[string]any
		if !decodePluginPageArguments(request.Arguments, &arguments) || len(arguments) > 0 {
			return nil, "invalid_arguments"
		}
	}
	directory, err := resolveDriverDownloadDirectory("")
	if err != nil {
		return nil, "internal"
	}
	definitions := allDriverDefinitionsWithPackages(nil)
	items := make([]pluginCapabilityDriverStatusItem, 0, len(definitions))
	for _, definition := range definitions {
		installed, packageInstalled := readInstalledDriverPackage(directory, definition.Type)
		runtimeAvailable, _ := db.DriverRuntimeSupportStatus(definition.Type)
		items = append(items, pluginCapabilityDriverStatusItem{
			Type:             definition.Type,
			Name:             definition.Name,
			BuiltIn:          definition.BuiltIn,
			InstalledVersion: strings.TrimSpace(installed.Version),
			PackageInstalled: packageInstalled,
			RuntimeAvailable: runtimeAvailable,
			Connectable:      runtimeAvailable,
		})
	}
	return items, ""
}
