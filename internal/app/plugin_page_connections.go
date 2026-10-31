package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const pluginPageMaxConnectionIDBytes = 256

// pluginPageConnectionSummary is the only connection shape a page receives.
// Credentials, SSH/proxy settings, DSN/URI and usernames stay on the host.
// Host and Port may be empty for multi-host specs (Hosts, replica sets or
// sentinel configurations), so pages must treat them as display hints only.
type pluginPageConnectionSummary struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Database        string `json:"database"`
	EnvironmentType string `json:"environmentType"`
	ReadOnly        bool   `json:"readOnly"`
}

func pluginPageConnectionsList(ctx context.Context, a *App, request pluginPageRequest) (any, string) {
	var arguments struct{}
	if !decodePluginPageArguments(request.arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if err := ctx.Err(); err != nil {
		return nil, "internal"
	}
	views, err := a.savedConnectionRepository().List()
	if err != nil {
		return nil, "internal"
	}
	items := make([]pluginPageConnectionSummary, 0, len(views))
	for _, view := range views {
		items = append(items, pluginPageConnectionSummary{
			ID:              view.ID,
			Name:            view.Name,
			Type:            view.Config.Type,
			Host:            view.Config.Host,
			Port:            view.Config.Port,
			Database:        view.Config.Database,
			EnvironmentType: view.EnvironmentType,
			ReadOnly:        pluginPageConnectionReadOnly(view.Config),
		})
	}
	return items, ""
}

// pluginPageConnectionReadOnly reports effective read-only intent. The driver
// must support the mode and every write-related protection must be on; a flag
// the host cannot enforce is not advertised to pages as read-only.
func pluginPageConnectionReadOnly(config connection.ConnectionConfig) bool {
	return supportsConnectionReadOnlyMode(config) && isConnectionForcedReadOnly(config)
}

// pluginPageConnectionConfig resolves a saved connection id on the host,
// including its secretstore bundle. Pages never supply credentials, and the
// resolved configuration never leaves this process.
func (a *App) pluginPageConnectionConfig(connectionID string) (connection.ConnectionConfig, string) {
	id := strings.TrimSpace(connectionID)
	if id == "" || len(id) > pluginPageMaxConnectionIDBytes {
		return connection.ConnectionConfig{}, "invalid_arguments"
	}
	repository := a.savedConnectionRepository()
	view, err := repository.Find(id)
	if err != nil {
		return connection.ConnectionConfig{}, "invalid_arguments"
	}
	config := view.Config
	config.ID = view.ID
	resolved, err := a.resolveConnectionSecrets(config)
	if err != nil {
		return connection.ConnectionConfig{}, "internal"
	}
	// SSH (and later proxy transports) belong to the host; the plugin receives a
	// direct local endpoint instead of unsupported transport fields.
	return a.pluginConnectionConfigForPlugin(resolved)
}
