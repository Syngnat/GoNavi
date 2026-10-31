package provider

import (
	"context"
	"sort"

	"GoNavi-Wails/internal/plugin"
)

// maxPluginProviderIconBytes bounds one package-relative provider icon before it becomes
// a data URL in the metadata catalog. SVG and other non-raster files are rejected by sniffing.
// It matches the manifest icon limit so one declaration never passes one reader and fails another.
const maxPluginProviderIconBytes = 5 << 20

// PluginProviderSnapshot is a metadata-only host policy snapshot.
type PluginProviderSnapshot struct {
	Statuses []plugin.Status
	Owned    bool
	SafeMode bool
}

// PluginProviderView contains no secrets, credentials or executable data. Icon is an
// optional host-produced bounded raster data URL; all remaining fields are declarations.
type PluginProviderView struct {
	Type           string           `json:"type"`
	PluginID       string           `json:"pluginId"`
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Icon           string           `json:"icon,omitempty"`
	DefaultBaseURL string           `json:"defaultBaseUrl,omitempty"`
	Models         []plugin.AIModel `json:"models"`
	SupportsTools  bool             `json:"supportsTools"`
	SupportsImages bool             `json:"supportsImages"`
	Version        string           `json:"version"`
	Digest         string           `json:"digest"`
	Generation     uint64           `json:"generation"`
	Available      bool             `json:"available"`
	State          plugin.State     `json:"state"`
	Reason         string           `json:"reason,omitempty"`
}

// PluginFactory borrows host callbacks; it never owns or activates a runtime.
type PluginFactory struct {
	catalogSource func(context.Context) (PluginProviderSnapshot, error)
	managerSource func(context.Context) (*plugin.Manager, error)
}

// NewPluginFactory creates an isolated factory without global registration.
func NewPluginFactory(catalogSource func(context.Context) (PluginProviderSnapshot, error), managerSource func(context.Context) (*plugin.Manager, error)) *PluginFactory {
	return &PluginFactory{catalogSource: catalogSource, managerSource: managerSource}
}

// Catalog reads declaration metadata plus explicitly declared bounded icons and
// preserves disabled entries. It never starts a plugin or reads its executable.
func (f *PluginFactory) Catalog(ctx context.Context) ([]PluginProviderView, error) {
	if ctx == nil {
		return nil, ErrPluginProviderUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f == nil || f.catalogSource == nil {
		return nil, ErrPluginProviderUnavailable
	}
	snapshot, err := f.catalogSource(ctx)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, ErrPluginProviderUnavailable
	}
	var manager *plugin.Manager
	if f.managerSource != nil {
	scanIcons:
		for _, status := range snapshot.Statuses {
			for _, decl := range status.Manifest.Contributes.AIProviders {
				if decl.Icon != "" {
					manager, _ = f.managerSource(ctx)
					break scanIcons
				}
			}
		}
	}
	result := make([]PluginProviderView, 0)
	for _, status := range snapshot.Statuses {
		if !pluginProviderPermission(status.Manifest) || status.Generation > 1<<53-1 {
			continue
		}
		reason := pluginProviderReason(status, snapshot.Owned, snapshot.SafeMode)
		for _, decl := range status.Manifest.Contributes.AIProviders {
			typ := plugin.AIProviderType(status.Manifest.ID, decl)
			if typ == "" {
				continue
			}
			result = append(result, PluginProviderView{Type: typ, PluginID: status.Manifest.ID, ID: decl.ID, Name: decl.Name, DefaultBaseURL: decl.DefaultBaseURL,
				Icon: pluginProviderIcon(ctx, manager, status.Manifest.ID, decl.Icon), Models: append([]plugin.AIModel{}, decl.Models...),
				SupportsTools: decl.SupportsTools, SupportsImages: decl.SupportsImages, Version: status.Manifest.Version,
				Digest: status.Digest, Generation: status.Generation, Available: reason == "", State: status.State, Reason: reason})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Type < result[j].Type })
	return result, nil
}

// pluginProviderIcon turns one declared package-relative raster image into a bounded data URL.
// Missing, oversized, linked or non-raster files are omitted so the UI falls back to the label.
func pluginProviderIcon(ctx context.Context, manager *plugin.Manager, pluginID, icon string) string {
	if manager == nil || icon == "" || ctx.Err() != nil {
		return ""
	}
	data, err := manager.ReadPackageFile(pluginID, icon, maxPluginProviderIconBytes)
	if err != nil {
		return ""
	}
	return providerIconDataURL(data)
}

// providerIconDataURL reuses the host raster rule so plugin logos and provider icons cannot
// drift apart: sniff the content, refuse anything that is not a bounded raster image.
func providerIconDataURL(data []byte) string { return plugin.RasterIconDataURL(data) }

func pluginProviderPermission(m plugin.Manifest) bool {
	if m.Backend == nil {
		return false
	}
	for _, permission := range m.Permissions {
		if permission == "ai.providers" {
			return true
		}
	}
	return false
}
func pluginProviderReason(s plugin.Status, owned, safe bool) string {
	if safe {
		return "safe_mode"
	}
	if !s.DesiredEnabled {
		return "disabled"
	}
	switch s.State {
	case plugin.StateStarting:
		return "starting"
	case plugin.StateStopping:
		return "stopping"
	case plugin.StateFaulted:
		return "faulted"
	case plugin.StateBlocked:
		return "blocked"
	case plugin.StateRunning:
		if owned && s.Generation != 0 {
			return ""
		}
	}
	return "runtime_unavailable"
}
