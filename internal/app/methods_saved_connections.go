package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (a *App) savedConnectionRepository() *savedConnectionRepository {
	return newSavedConnectionRepository(a.configDir, a.secretStore)
}

func (a *App) GetSavedConnections() ([]connection.SavedConnectionView, error) {
	repository := a.savedConnectionRepository()
	if err := repository.MigrateLegacyCreatedAt(); err != nil {
		return nil, err
	}
	items, err := repository.List()
	if err != nil {
		return nil, err
	}
	return sanitizeSavedConnectionViews(items), nil
}

func (a *App) GetEditableSavedConnection(id string) (connection.SavedConnectionView, error) {
	view, err := a.savedConnectionRepository().Find(id)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	// Editing relies on the Has* flags and explicit clear fields. Returning the
	// resolved bundle would expose every saved credential to the WebView.
	return sanitizeSavedConnectionView(view), nil
}

func (a *App) RevealSavedConnectionPrimaryPassword(id string) (string, error) {
	view, bundle, err := a.savedConnectionRepository().loadConnectionSnapshot(id)
	if err != nil {
		return "", err
	}
	if !view.HasPrimaryPassword || strings.TrimSpace(bundle.Password) == "" {
		return "", fmt.Errorf("saved connection has no stored primary password: %s", strings.TrimSpace(id))
	}
	return bundle.Password, nil
}

func (a *App) SaveConnection(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	view, err := a.savedConnectionRepository().Save(input)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	a.markCloudBackupDirty()
	return sanitizeSavedConnectionView(view), nil
}

func (a *App) UpdateConnectionVisibility(input connection.ConnectionVisibilityInput) (connection.SavedConnectionView, error) {
	view, err := a.savedConnectionRepository().UpdateVisibility(input)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	a.markCloudBackupDirty()
	return sanitizeSavedConnectionView(view), nil
}

func (a *App) DeleteConnection(id string) error {
	err := a.savedConnectionRepository().Delete(id)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return err
}

// DeleteConnections deletes saved connections and their credentials as one
// recoverable operation. It is used when a group tree is deleted from the UI.
func (a *App) DeleteConnections(ids []string) error {
	err := a.savedConnectionRepository().DeleteMany(ids)
	if err == nil && len(ids) > 0 {
		a.markCloudBackupDirty()
	}
	return err
}

func (a *App) DuplicateConnection(id string) (connection.SavedConnectionView, error) {
	view, err := a.savedConnectionRepository().Duplicate(
		id,
		a.appText("connection.unnamed", nil),
		a.appText("connection.copy_suffix", nil),
	)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	a.markCloudBackupDirty()
	return sanitizeSavedConnectionView(view), nil
}

func (a *App) ImportLegacyConnections(items []connection.LegacySavedConnection) ([]connection.SavedConnectionView, error) {
	inputs := make([]connection.SavedConnectionInput, 0, len(items))
	for _, item := range items {
		input := connection.SavedConnectionInput(item)
		input.ClearPrimaryPassword = strings.TrimSpace(item.Config.Password) == ""
		input.ClearSSHPassword = strings.TrimSpace(item.Config.SSH.Password) == ""
		input.ClearProxyPassword = strings.TrimSpace(item.Config.Proxy.Password) == ""
		input.ClearHTTPTunnelPassword = strings.TrimSpace(item.Config.HTTPTunnel.Password) == ""
		input.ClearMySQLReplicaPassword = strings.TrimSpace(item.Config.MySQLReplicaPassword) == ""
		input.ClearMongoReplicaPassword = strings.TrimSpace(item.Config.MongoReplicaPassword) == ""
		input.ClearRedisSentinelPassword = strings.TrimSpace(item.Config.RedisSentinelPassword) == ""
		input.ClearOpaqueURI = strings.TrimSpace(item.Config.URI) == ""
		input.ClearOpaqueDSN = strings.TrimSpace(item.Config.DSN) == ""
		input.ClearJVMJMXPassword = strings.TrimSpace(item.Config.JVM.JMX.Password) == ""
		input.ClearJVMEndpointAPIKey = strings.TrimSpace(item.Config.JVM.Endpoint.APIKey) == ""
		input.ClearJVMAgentAPIKey = strings.TrimSpace(item.Config.JVM.Agent.APIKey) == ""
		input.ClearJVMDiagnosticAPIKey = strings.TrimSpace(item.Config.JVM.Diagnostic.APIKey) == ""
		_, sensitiveParams := partitionConnectionParams(item.Config.ConnectionParams)
		input.ClearSensitiveParams = strings.TrimSpace(sensitiveParams) == ""
		inputs = append(inputs, input)
	}
	views, err := a.importSavedConnectionsAtomically(inputs)
	if err != nil {
		return nil, err
	}
	a.markCloudBackupDirty()
	return sanitizeSavedConnectionViews(views), nil
}

func (a *App) SaveGlobalProxy(input connection.SaveGlobalProxyInput) (connection.GlobalProxyView, error) {
	view, err := a.saveGlobalProxy(input)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return view, err
}

func (a *App) ImportLegacyGlobalProxy(input connection.LegacyGlobalProxyInput) (connection.GlobalProxyView, error) {
	return a.saveGlobalProxy(connection.SaveGlobalProxyInput(input))
}
