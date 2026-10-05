package app

import (
	"net/http"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/nacos"
)

// NacosListNamespaces lists namespaces for a connection.
func (a *App) NacosListNamespaces(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	namespaces, err := client.ListNamespaces(ctx)
	if err != nil {
		logger.Error(err, "NacosListNamespaces 失败：%s", formatNacosConnSummary(config))
		result := connection.QueryResult{Success: false, Message: err.Error()}
		if status, ok := nacos.HTTPStatusCode(err); ok && status == http.StatusForbidden {
			result.Data = map[string]any{
				"errorCode": nacosNamespaceListForbiddenErrorCode,
			}
		}
		return result
	}
	return connection.QueryResult{Success: true, Data: namespaces}
}

// NacosListConfigGroups lists unique config groups under a namespace.
func (a *App) NacosListConfigGroups(config connection.ConnectionConfig, namespaceID string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	groups, err := client.ListConfigGroups(ctx, namespaceID)
	if err != nil {
		logger.Error(err, "NacosListConfigGroups 失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: groups}
}

// NacosSearchConfigs searches configs under a namespace.
func (a *App) NacosSearchConfigs(config connection.ConnectionConfig, query NacosConfigQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	page, err := client.SearchConfigs(ctx, nacos.ConfigQuery{
		NamespaceID: query.NamespaceID,
		DataID:      query.DataID,
		Group:       query.Group,
		AppName:     query.AppName,
		PageNo:      query.PageNo,
		PageSize:    query.PageSize,
		Search:      query.Search,
	})
	if err != nil {
		logger.Error(err, "NacosSearchConfigs 失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

// NacosGetConfig loads one config.
func (a *App) NacosGetConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	detail, err := client.GetConfig(ctx, namespaceID, group, dataID)
	if err != nil {
		logger.Error(err, "NacosGetConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: detail}
}

// NacosPublishConfig creates or updates a config.
func (a *App) NacosPublishConfig(config connection.ConnectionConfig, payload NacosPublishConfigPayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.PublishConfig(ctx, nacos.PublishRequest{
		NamespaceID: payload.NamespaceID,
		DataID:      payload.DataID,
		Group:       payload.Group,
		Content:     payload.Content,
		Type:        payload.Type,
		AppName:     payload.AppName,
		Desc:        payload.Desc,
		BetaIPs:     payload.BetaIPs,
	}); err != nil {
		logger.Error(err, "NacosPublishConfig 失败：dataId=%s group=%s", payload.DataID, payload.Group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(payload.BetaIPs) != "" {
		return connection.QueryResult{
			Success: true,
			Message: a.appText("nacos.backend.message.beta_publish_success", nil),
		}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.publish_success", nil),
	}
}

// NacosGetBetaConfig loads beta config for one dataId/group.
func (a *App) NacosGetBetaConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	detail, err := client.GetBetaConfig(ctx, namespaceID, group, dataID)
	if err != nil {
		logger.Error(err, "NacosGetBetaConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: detail}
}

// NacosStopBetaConfig stops beta publish.
func (a *App) NacosStopBetaConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.StopBetaConfig(ctx, namespaceID, group, dataID); err != nil {
		logger.Error(err, "NacosStopBetaConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.beta_stop_success", nil),
	}
}

// NacosDeleteConfig deletes a config.
func (a *App) NacosDeleteConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.DeleteConfig(ctx, namespaceID, group, dataID); err != nil {
		logger.Error(err, "NacosDeleteConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.delete_success", nil),
	}
}

// NacosCreateNamespace creates a namespace.
func (a *App) NacosCreateNamespace(config connection.ConnectionConfig, payload NacosCreateNamespacePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.CreateNamespace(ctx, nacos.CreateNamespaceRequest{
		ID:          payload.ID,
		ShowName:    payload.ShowName,
		Description: payload.Description,
	}); err != nil {
		logger.Error(err, "NacosCreateNamespace 失败：id=%s name=%s", payload.ID, payload.ShowName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.namespace_create_success", nil),
	}
}

// NacosUpdateNamespace updates a namespace.
func (a *App) NacosUpdateNamespace(config connection.ConnectionConfig, payload NacosUpdateNamespacePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.UpdateNamespace(ctx, nacos.UpdateNamespaceRequest{
		ID:          payload.ID,
		ShowName:    payload.ShowName,
		Description: payload.Description,
	}); err != nil {
		logger.Error(err, "NacosUpdateNamespace 失败：id=%s", payload.ID)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.namespace_update_success", nil),
	}
}

// NacosDeleteNamespace deletes a namespace.
func (a *App) NacosDeleteNamespace(config connection.ConnectionConfig, namespaceID string) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.DeleteNamespace(ctx, namespaceID); err != nil {
		logger.Error(err, "NacosDeleteNamespace 失败：id=%s", namespaceID)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.namespace_delete_success", nil),
	}
}

// NacosListConfigHistory lists history for one config.
func (a *App) NacosListConfigHistory(config connection.ConnectionConfig, query NacosHistoryQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	page, err := client.ListConfigHistory(ctx, nacos.HistoryQuery{
		NamespaceID: query.NamespaceID,
		DataID:      query.DataID,
		Group:       query.Group,
		PageNo:      query.PageNo,
		PageSize:    query.PageSize,
	})
	if err != nil {
		logger.Error(err, "NacosListConfigHistory 失败：dataId=%s group=%s", query.DataID, query.Group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

// NacosGetConfigHistory loads one history detail.
func (a *App) NacosGetConfigHistory(config connection.ConnectionConfig, namespaceID, group, dataID, nid string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	item, err := client.GetConfigHistory(ctx, namespaceID, group, dataID, nid)
	if err != nil {
		logger.Error(err, "NacosGetConfigHistory 失败：nid=%s dataId=%s", nid, dataID)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: item}
}
