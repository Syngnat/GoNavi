package app

import (
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/nacos"
)

// NacosListServices lists services under a namespace.
func (a *App) NacosListServices(config connection.ConnectionConfig, query NacosServiceQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	page, err := client.ListServices(ctx, nacos.ServiceQuery{
		NamespaceID:    query.NamespaceID,
		ServiceName:    query.ServiceName,
		GroupName:      query.GroupName,
		PageNo:         query.PageNo,
		PageSize:       query.PageSize,
		WithStatistics: query.WithStatistics,
	})
	if err != nil {
		logger.Error(err, "NacosListServices 失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

// NacosGetService loads service detail.
func (a *App) NacosGetService(config connection.ConnectionConfig, namespaceID, serviceName, groupName string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	detail, err := client.GetService(ctx, namespaceID, serviceName, groupName)
	if err != nil {
		logger.Error(err, "NacosGetService 失败：service=%s", serviceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: detail}
}

// NacosCreateService creates a service.
func (a *App) NacosCreateService(config connection.ConnectionConfig, payload NacosServicePayload) connection.QueryResult {
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
	if err := client.CreateService(ctx, nacos.CreateServiceRequest{
		NamespaceID:      payload.NamespaceID,
		ServiceName:      payload.ServiceName,
		GroupName:        payload.GroupName,
		Ephemeral:        payload.Ephemeral,
		ProtectThreshold: payload.ProtectThreshold,
		Metadata:         payload.Metadata,
	}); err != nil {
		logger.Error(err, "NacosCreateService 失败：service=%s", payload.ServiceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.service_create_success", nil)}
}

// NacosUpdateService updates a service.
func (a *App) NacosUpdateService(config connection.ConnectionConfig, payload NacosServicePayload) connection.QueryResult {
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
	if err := client.UpdateService(ctx, nacos.UpdateServiceRequest{
		NamespaceID:      payload.NamespaceID,
		ServiceName:      payload.ServiceName,
		GroupName:        payload.GroupName,
		ProtectThreshold: payload.ProtectThreshold,
		Metadata:         payload.Metadata,
	}); err != nil {
		logger.Error(err, "NacosUpdateService 失败：service=%s", payload.ServiceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.service_update_success", nil)}
}

// NacosDeleteService deletes a service.
func (a *App) NacosDeleteService(config connection.ConnectionConfig, namespaceID, serviceName, groupName string) connection.QueryResult {
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
	if err := client.DeleteService(ctx, namespaceID, serviceName, groupName); err != nil {
		logger.Error(err, "NacosDeleteService 失败：service=%s", serviceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.service_delete_success", nil)}
}

// NacosListInstances lists instances of a service.
func (a *App) NacosListInstances(config connection.ConnectionConfig, query NacosInstanceQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	list, err := client.ListInstances(ctx, nacos.InstanceQuery{
		NamespaceID: query.NamespaceID,
		ServiceName: query.ServiceName,
		GroupName:   query.GroupName,
		Clusters:    query.Clusters,
		HealthyOnly: query.HealthyOnly,
	})
	if err != nil {
		logger.Error(err, "NacosListInstances 失败：service=%s", query.ServiceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: list}
}

// NacosGetInstance loads one instance.
func (a *App) NacosGetInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	inst, err := client.GetInstance(ctx, toNacosInstanceRequest(payload))
	if err != nil {
		logger.Error(err, "NacosGetInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: inst}
}

// NacosRegisterInstance registers an instance.
func (a *App) NacosRegisterInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
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
	if err := client.RegisterInstance(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosRegisterInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_register_success", nil)}
}

// NacosUpdateInstance updates an instance.
func (a *App) NacosUpdateInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
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
	if err := client.UpdateInstance(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosUpdateInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_update_success", nil)}
}

// NacosDeregisterInstance deregisters an instance.
func (a *App) NacosDeregisterInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
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
	if err := client.DeregisterInstance(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosDeregisterInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_deregister_success", nil)}
}

// NacosUpdateInstanceHealth updates instance health.
func (a *App) NacosUpdateInstanceHealth(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
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
	if err := client.UpdateInstanceHealth(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosUpdateInstanceHealth 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_health_success", nil)}
}

func toNacosInstanceRequest(payload NacosInstancePayload) nacos.InstanceRequest {
	return nacos.InstanceRequest{
		NamespaceID: payload.NamespaceID,
		ServiceName: payload.ServiceName,
		GroupName:   payload.GroupName,
		IP:          payload.IP,
		Port:        payload.Port,
		ClusterName: payload.ClusterName,
		Weight:      payload.Weight,
		Enabled:     payload.Enabled,
		Healthy:     payload.Healthy,
		Ephemeral:   payload.Ephemeral,
		Metadata:    payload.Metadata,
	}
}

func (a *App) ensureNacosDataEditAllowed(config connection.ConnectionConfig) error {
	// Keep the Nacos-specific message while honoring the shared production guard.
	if config.ReadOnly || config.Protection.RestrictDataEdit {
		return fmt.Errorf("%s", a.appText("nacos.backend.error.read_only", nil))
	}
	return nil
}

func (a *App) ensureNacosStructureEditAllowed(config connection.ConnectionConfig) error {
	if config.ReadOnly || config.Protection.RestrictStructureEdit {
		return fmt.Errorf("%s", a.appText("nacos.backend.error.read_only", nil))
	}
	return nil
}
