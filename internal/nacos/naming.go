package nacos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultServicePageSize = 100
	maxServicePageSize     = 500
	maxInstancePageSize    = 500
	defaultServiceGroup    = "DEFAULT_GROUP"
)

type nacosServiceItem struct {
	Name      string `json:"name"`
	GroupName string `json:"groupName"`
}

type nacosV3ServicePage struct {
	TotalCount     int64              `json:"totalCount"`
	PageNumber     int                `json:"pageNumber"`
	PagesAvailable int                `json:"pagesAvailable"`
	PageItems      []nacosServiceItem `json:"pageItems"`
}

// ListServices lists service names under a namespace.
func (c *ClientImpl) ListServices(ctx context.Context, query ServiceQuery) (*ServicePage, error) {
	family := c.currentAPIFamily()
	pageNo := query.PageNo
	if pageNo <= 0 {
		pageNo = 1
	}
	pageSize := query.PageSize
	if pageSize <= 0 {
		pageSize = defaultServicePageSize
	}
	if pageSize > maxServicePageSize {
		pageSize = maxServicePageSize
	}

	groupName := strings.TrimSpace(query.GroupName)
	if family == nacosAPIV3 && groupName != "" {
		return c.listV3ServicesByExactGroup(ctx, query.NamespaceID, groupName, pageNo, pageSize)
	}

	params := url.Values{}
	params.Set("pageNo", strconv.Itoa(pageNo))
	params.Set("pageSize", strconv.Itoa(pageSize))
	params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
	routes := c.currentAPIRoutes()
	apiPath := routes.serviceList
	if (family == nacosAPIV1 || family == nacosAPIV2) && groupName == "" {
		// Nacos 2.x has no cross-group v2 service list, but retains v1 Catalog.
		apiPath = routesForNacosAPI(nacosAPIV1).serviceList
		params.Set("serviceNameParam", "")
		params.Set("groupNameParam", "")
	} else if family == nacosAPIV1 || family == nacosAPIV2 {
		apiPath = routes.serviceListByGroup
		params.Set("groupName", normalizeServiceGroup(groupName))
	} else {
		params.Set("serviceNameParam", "")
		params.Set("groupNameParam", groupName)
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, apiPath, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var count int64
	var services []nacosServiceItem
	if family == nacosAPIV3 {
		var payload nacosV3ServicePage
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, localizedNacosBackendError("nacos.backend.error.parse_services", map[string]any{
				"detail": err.Error(),
			})
		}
		count = payload.TotalCount
		services = payload.PageItems
	} else if family == nacosAPIV1 && groupName != "" {
		var payload struct {
			Count int64    `json:"count"`
			Doms  []string `json:"doms"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, localizedNacosBackendError("nacos.backend.error.parse_services", map[string]any{
				"detail": err.Error(),
			})
		}
		count = payload.Count
		services = make([]nacosServiceItem, 0, len(payload.Doms))
		for _, name := range payload.Doms {
			services = append(services, nacosServiceItem{Name: name, GroupName: normalizeServiceGroup(groupName)})
		}
	} else if family == nacosAPIV2 && groupName != "" {
		var payload struct {
			Count    int64    `json:"count"`
			Services []string `json:"services"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, localizedNacosBackendError("nacos.backend.error.parse_services", map[string]any{
				"detail": err.Error(),
			})
		}
		count = payload.Count
		services = make([]nacosServiceItem, 0, len(payload.Services))
		for _, name := range payload.Services {
			services = append(services, nacosServiceItem{Name: name, GroupName: normalizeServiceGroup(groupName)})
		}
	} else {
		var payload struct {
			Count       int64              `json:"count"`
			ServiceList []nacosServiceItem `json:"serviceList"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, localizedNacosBackendError("nacos.backend.error.parse_services", map[string]any{
				"detail": err.Error(),
			})
		}
		count = payload.Count
		services = payload.ServiceList
	}

	names := make([]string, 0, len(services))
	for _, service := range services {
		name := qualifyServiceName(service.Name, service.GroupName)
		if name != "" {
			names = append(names, name)
		}
	}
	return &ServicePage{
		Count:        count,
		ServiceNames: names,
		PageNo:       pageNo,
		PageSize:     pageSize,
	}, nil
}

func (c *ClientImpl) listV3ServicesByExactGroup(
	ctx context.Context,
	namespaceID string,
	groupName string,
	pageNo int,
	pageSize int,
) (*ServicePage, error) {
	groupName = normalizeServiceGroup(groupName)
	matched := make([]nacosServiceItem, 0)
	for remotePageNo := 1; ; remotePageNo++ {
		params := url.Values{}
		params.Set("pageNo", strconv.Itoa(remotePageNo))
		params.Set("pageSize", strconv.Itoa(maxServicePageSize))
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
		params.Set("serviceNameParam", "")
		params.Set("groupNameParam", regexp.QuoteMeta(groupName))

		body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().serviceListByGroup, params, nil)
		if err != nil {
			return nil, err
		}
		if status < 200 || status >= 300 {
			return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
				"status": status,
				"body":   truncateForError(string(body)),
			})
		}
		data, err := unwrapNacosResult(body)
		if err != nil {
			return nil, err
		}
		var payload nacosV3ServicePage
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, localizedNacosBackendError("nacos.backend.error.parse_services", map[string]any{
				"detail": err.Error(),
			})
		}
		for _, service := range payload.PageItems {
			if strings.TrimSpace(service.GroupName) == groupName {
				matched = append(matched, service)
			}
		}
		if payload.PagesAvailable <= remotePageNo {
			break
		}
	}

	start := (pageNo - 1) * pageSize
	if start > len(matched) {
		start = len(matched)
	}
	end := start + pageSize
	if end > len(matched) {
		end = len(matched)
	}
	names := make([]string, 0, end-start)
	for _, service := range matched[start:end] {
		if name := qualifyServiceName(service.Name, service.GroupName); name != "" {
			names = append(names, name)
		}
	}
	return &ServicePage{
		Count:        int64(len(matched)),
		ServiceNames: names,
		PageNo:       pageNo,
		PageSize:     pageSize,
	}, nil
}

// GetService loads service detail.
func (c *ClientImpl) GetService(ctx context.Context, namespaceID, serviceName, groupName string) (*ServiceDetail, error) {
	family := c.currentAPIFamily()
	serviceName = strings.TrimSpace(serviceName)
	if serviceName == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.service_name_required", nil)
	}
	plainServiceName, groupName := splitServiceName(serviceName, groupName)
	qualifiedServiceName := qualifyServiceName(plainServiceName, groupName)

	params := url.Values{}
	if family == nacosAPIV1 {
		params.Set("serviceName", qualifiedServiceName)
	} else {
		params.Set("serviceName", plainServiceName)
	}
	params.Set("groupName", groupName)
	params.Set("namespaceId", normalizeNamespaceID(namespaceID))

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().service, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Name             string            `json:"name"`
		ServiceName      string            `json:"serviceName"`
		GroupName        string            `json:"groupName"`
		NamespaceID      string            `json:"namespaceId"`
		Namespace        string            `json:"namespace"`
		Ephemeral        bool              `json:"ephemeral"`
		ProtectThreshold float64           `json:"protectThreshold"`
		Metadata         map[string]string `json:"metadata"`
		Selector         map[string]any    `json:"selector"`
		Clusters         []struct {
			Name          string            `json:"name"`
			Metadata      map[string]string `json:"metadata"`
			HealthChecker map[string]any    `json:"healthChecker"`
		} `json:"clusters"`
		ClusterMap map[string]struct {
			ClusterName   string            `json:"clusterName"`
			Metadata      map[string]string `json:"metadata"`
			HealthChecker map[string]any    `json:"healthChecker"`
		} `json:"clusterMap"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_service", map[string]any{
			"detail": err.Error(),
		})
	}

	clusters := make([]ServiceCluster, 0, len(payload.Clusters))
	for _, cluster := range payload.Clusters {
		clusters = append(clusters, ServiceCluster{
			Name:          strings.TrimSpace(cluster.Name),
			Metadata:      cluster.Metadata,
			HealthChecker: cluster.HealthChecker,
		})
	}
	clusterKeys := make([]string, 0, len(payload.ClusterMap))
	for key := range payload.ClusterMap {
		clusterKeys = append(clusterKeys, key)
	}
	sort.Strings(clusterKeys)
	for _, key := range clusterKeys {
		cluster := payload.ClusterMap[key]
		clusters = append(clusters, ServiceCluster{
			Name:          firstNonEmpty(strings.TrimSpace(cluster.ClusterName), strings.TrimSpace(key)),
			Metadata:      cluster.Metadata,
			HealthChecker: cluster.HealthChecker,
		})
	}
	return &ServiceDetail{
		Name:             firstNonEmpty(strings.TrimSpace(payload.Name), strings.TrimSpace(payload.ServiceName), plainServiceName),
		GroupName:        firstNonEmpty(strings.TrimSpace(payload.GroupName), groupName),
		NamespaceID:      normalizeNamespaceID(firstNonEmpty(payload.NamespaceID, payload.Namespace, namespaceID)),
		Ephemeral:        payload.Ephemeral,
		ProtectThreshold: payload.ProtectThreshold,
		Metadata:         payload.Metadata,
		Selector:         payload.Selector,
		Clusters:         clusters,
	}, nil
}

// CreateService creates a service.
func (c *ClientImpl) CreateService(ctx context.Context, req CreateServiceRequest) error {
	family := c.currentAPIFamily()
	serviceName := strings.TrimSpace(req.ServiceName)
	if serviceName == "" {
		return localizedNacosBackendError("nacos.backend.error.service_name_required", nil)
	}
	if family == nacosAPIV1 && req.Ephemeral != nil && *req.Ephemeral {
		return localizedNacosBackendError("nacos.backend.error.ephemeral_service_unsupported_v1", nil)
	}
	serviceName, groupName := splitServiceName(serviceName, req.GroupName)
	form := url.Values{}
	if family == nacosAPIV1 {
		form.Set("serviceName", qualifyServiceName(serviceName, groupName))
	} else {
		form.Set("serviceName", serviceName)
	}
	form.Set("groupName", groupName)
	form.Set("namespaceId", normalizeNamespaceID(req.NamespaceID))
	if family != nacosAPIV1 && req.Ephemeral != nil {
		form.Set("ephemeral", strconv.FormatBool(*req.Ephemeral))
	}
	form.Set("protectThreshold", strconv.FormatFloat(req.ProtectThreshold, 'f', -1, 64))
	if meta := encodeMetadata(req.Metadata); meta != "" {
		form.Set("metadata", meta)
	}
	body, status, err := c.doRequest(ctx, http.MethodPost, c.currentAPIRoutes().service, nil, form)
	if err != nil {
		return err
	}
	return parseNamingOKResult(body, status, "nacos.backend.error.service_create_failed")
}

// UpdateService updates a service.
func (c *ClientImpl) UpdateService(ctx context.Context, req UpdateServiceRequest) error {
	family := c.currentAPIFamily()
	serviceName := strings.TrimSpace(req.ServiceName)
	if serviceName == "" {
		return localizedNacosBackendError("nacos.backend.error.service_name_required", nil)
	}
	serviceName, groupName := splitServiceName(serviceName, req.GroupName)
	form := url.Values{}
	if family == nacosAPIV1 {
		form.Set("serviceName", qualifyServiceName(serviceName, groupName))
	} else {
		form.Set("serviceName", serviceName)
	}
	form.Set("groupName", groupName)
	form.Set("namespaceId", normalizeNamespaceID(req.NamespaceID))
	form.Set("protectThreshold", strconv.FormatFloat(req.ProtectThreshold, 'f', -1, 64))
	if meta := encodeMetadata(req.Metadata); meta != "" {
		form.Set("metadata", meta)
	}
	body, status, err := c.doRequest(ctx, http.MethodPut, c.currentAPIRoutes().service, nil, form)
	if err != nil {
		return err
	}
	return parseNamingOKResult(body, status, "nacos.backend.error.service_update_failed")
}

// DeleteService deletes a service (only when instance count is 0 on server side).
func (c *ClientImpl) DeleteService(ctx context.Context, namespaceID, serviceName, groupName string) error {
	family := c.currentAPIFamily()
	serviceName = strings.TrimSpace(serviceName)
	if serviceName == "" {
		return localizedNacosBackendError("nacos.backend.error.service_name_required", nil)
	}
	serviceName, groupName = splitServiceName(serviceName, groupName)
	params := url.Values{}
	if family == nacosAPIV1 {
		params.Set("serviceName", qualifyServiceName(serviceName, groupName))
	} else {
		params.Set("serviceName", serviceName)
	}
	params.Set("groupName", groupName)
	params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().service, params, nil)
	if err != nil {
		return err
	}
	return parseNamingOKResult(body, status, "nacos.backend.error.service_delete_failed")
}

// ListInstances lists instances for a service.
func (c *ClientImpl) ListInstances(ctx context.Context, query InstanceQuery) (*InstanceList, error) {
	family := c.currentAPIFamily()
	serviceName := strings.TrimSpace(query.ServiceName)
	if serviceName == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.service_name_required", nil)
	}
	serviceName, groupName := splitServiceName(serviceName, query.GroupName)
	qualifiedServiceName := qualifyServiceName(serviceName, groupName)
	switch family {
	case nacosAPIV1:
		return c.listV1CatalogInstances(ctx, query, serviceName, groupName, qualifiedServiceName)
	case nacosAPIV2:
		return c.listV2CatalogInstances(ctx, query, serviceName, groupName, qualifiedServiceName)
	}

	params := url.Values{}
	params.Set("serviceName", serviceName)
	params.Set("groupName", groupName)
	params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
	if clusters := strings.TrimSpace(query.Clusters); clusters != "" {
		params.Set("clusterName", clusters)
	}
	if query.HealthyOnly {
		params.Set("healthyOnly", "true")
	}
	return c.listV3AdminInstances(ctx, params, qualifiedServiceName, groupName, query)
}

func (c *ClientImpl) listV1CatalogInstances(
	ctx context.Context,
	query InstanceQuery,
	serviceName, groupName, qualifiedServiceName string,
) (*InstanceList, error) {
	clusters := splitNacosClusterNames(query.Clusters)
	if len(clusters) == 0 {
		service, err := c.GetService(ctx, query.NamespaceID, serviceName, groupName)
		if err != nil {
			return nil, err
		}
		seen := make(map[string]struct{}, len(service.Clusters))
		for _, cluster := range service.Clusters {
			name := strings.TrimSpace(cluster.Name)
			if name == "" {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			clusters = append(clusters, name)
		}
	}

	result := &InstanceList{Name: qualifiedServiceName, GroupName: groupName}
	if len(clusters) == 0 {
		hosts, err := c.listV1CatalogInstancePages(ctx, query, qualifiedServiceName, groupName, "")
		if err != nil {
			return nil, err
		}
		result.Hosts = hosts
		return result, nil
	}
	for _, cluster := range clusters {
		hosts, err := c.listV1CatalogInstancePages(ctx, query, qualifiedServiceName, groupName, cluster)
		if err != nil {
			return nil, err
		}
		result.Hosts = append(result.Hosts, hosts...)
	}
	return result, nil
}

func (c *ClientImpl) listV1CatalogInstancePages(
	ctx context.Context,
	query InstanceQuery,
	qualifiedServiceName, groupName, cluster string,
) ([]Instance, error) {
	hosts := make([]Instance, 0)
	for pageNo := 1; ; pageNo++ {
		params := url.Values{}
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
		params.Set("serviceName", qualifiedServiceName)
		params.Set("groupName", groupName)
		if cluster != "" {
			params.Set("clusterName", cluster)
		}
		params.Set("pageNo", strconv.Itoa(pageNo))
		params.Set("pageSize", strconv.Itoa(maxInstancePageSize))
		body, status, err := c.doRequest(ctx, http.MethodGet, routesForNacosAPI(nacosAPIV1).instanceList, params, nil)
		if err != nil {
			return nil, err
		}
		if status < 200 || status >= 300 {
			return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
				"status": status,
				"body":   truncateForError(string(body)),
			})
		}
		data, err := unwrapNacosResult(body)
		if err != nil {
			return nil, err
		}
		page, err := parseNacosCatalogInstances(data)
		if err != nil {
			return nil, err
		}
		hosts = append(hosts, filterNacosInstances(
			normalizeNacosInstances(page.items(), qualifiedServiceName),
			"",
			query.HealthyOnly,
		)...)
		if len(page.items()) == 0 || int64(pageNo*maxInstancePageSize) >= page.Count {
			return hosts, nil
		}
	}
}

func (c *ClientImpl) listV2CatalogInstances(
	ctx context.Context,
	query InstanceQuery,
	serviceName, groupName, qualifiedServiceName string,
) (*InstanceList, error) {
	result := &InstanceList{Name: qualifiedServiceName, GroupName: groupName}
	for pageNo := 1; ; pageNo++ {
		params := url.Values{}
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
		params.Set("serviceName", qualifiedServiceName)
		params.Set("pageNo", strconv.Itoa(pageNo))
		params.Set("pageSize", strconv.Itoa(maxInstancePageSize))
		body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().instanceList, params, nil)
		if err != nil {
			return nil, err
		}
		if status < 200 || status >= 300 {
			if pageNo == 1 && isMissingNacosAPI(status, body) {
				return c.listV1CatalogInstances(ctx, query, serviceName, groupName, qualifiedServiceName)
			}
			return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
				"status": status,
				"body":   truncateForError(string(body)),
			})
		}
		data, err := unwrapNacosResult(body)
		if err != nil {
			return nil, err
		}
		page, err := parseNacosCatalogInstances(data)
		if err != nil {
			return nil, err
		}
		items := page.items()
		result.Hosts = append(result.Hosts, filterNacosInstances(
			normalizeNacosInstances(items, qualifiedServiceName),
			query.Clusters,
			query.HealthyOnly,
		)...)
		if len(items) == 0 || int64(pageNo*maxInstancePageSize) >= page.Count {
			return result, nil
		}
	}
}

func (c *ClientImpl) listV3AdminInstances(
	ctx context.Context,
	params url.Values,
	qualifiedServiceName, groupName string,
	query InstanceQuery,
) (*InstanceList, error) {
	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().instanceList, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload []instancePayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_instances", map[string]any{
			"detail": err.Error(),
		})
	}
	return &InstanceList{
		Name:      qualifiedServiceName,
		GroupName: groupName,
		Hosts:     filterNacosInstances(normalizeNacosInstances(payload, qualifiedServiceName), query.Clusters, query.HealthyOnly),
	}, nil
}

type instancePayload struct {
	InstanceID  string            `json:"instanceId"`
	IP          string            `json:"ip"`
	Port        int               `json:"port"`
	Weight      float64           `json:"weight"`
	Healthy     bool              `json:"healthy"`
	Enabled     bool              `json:"enabled"`
	Ephemeral   bool              `json:"ephemeral"`
	ClusterName string            `json:"clusterName"`
	ServiceName string            `json:"serviceName"`
	Metadata    map[string]string `json:"metadata"`
}

type nacosCatalogInstancePage struct {
	Count     int64             `json:"count"`
	Instances []instancePayload `json:"instances"`
	List      []instancePayload `json:"list"`
	PageItems []instancePayload `json:"pageItems"`
}

func (p nacosCatalogInstancePage) items() []instancePayload {
	if p.Instances != nil {
		return p.Instances
	}
	if p.List != nil {
		return p.List
	}
	return p.PageItems
}

func parseNacosCatalogInstances(data []byte) (*nacosCatalogInstancePage, error) {
	if len(data) == 0 {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_instances", map[string]any{
			"detail": "empty Nacos catalog response",
		})
	}
	var payload nacosCatalogInstancePage
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_instances", map[string]any{
			"detail": err.Error(),
		})
	}
	return &payload, nil
}

func splitNacosClusterNames(raw string) []string {
	clusters := make([]string, 0)
	seen := make(map[string]struct{})
	for _, part := range strings.Split(raw, ",") {
		cluster := strings.TrimSpace(part)
		if cluster == "" {
			continue
		}
		if _, exists := seen[cluster]; exists {
			continue
		}
		seen[cluster] = struct{}{}
		clusters = append(clusters, cluster)
	}
	return clusters
}

func filterNacosInstances(instances []Instance, clusters string, healthyOnly bool) []Instance {
	requestedClusters := splitNacosClusterNames(clusters)
	if len(requestedClusters) == 0 && !healthyOnly {
		return instances
	}
	clusterSet := make(map[string]struct{}, len(requestedClusters))
	for _, cluster := range requestedClusters {
		clusterSet[cluster] = struct{}{}
	}
	filtered := make([]Instance, 0, len(instances))
	for _, instance := range instances {
		if healthyOnly && !instance.Healthy {
			continue
		}
		if len(clusterSet) > 0 {
			if _, ok := clusterSet[strings.TrimSpace(instance.ClusterName)]; !ok {
				continue
			}
		}
		filtered = append(filtered, instance)
	}
	return filtered
}

func normalizeNacosInstances(payload []instancePayload, qualifiedServiceName string) []Instance {
	instances := make([]Instance, 0, len(payload))
	for _, host := range payload {
		instances = append(instances, Instance{
			InstanceID:  strings.TrimSpace(host.InstanceID),
			IP:          strings.TrimSpace(host.IP),
			Port:        host.Port,
			Weight:      host.Weight,
			Healthy:     host.Healthy,
			Enabled:     host.Enabled,
			Ephemeral:   host.Ephemeral,
			ClusterName: strings.TrimSpace(host.ClusterName),
			ServiceName: firstNonEmpty(strings.TrimSpace(host.ServiceName), qualifiedServiceName),
			Metadata:    host.Metadata,
		})
	}
	return instances
}

// GetInstance loads one instance detail.
func (c *ClientImpl) GetInstance(ctx context.Context, req InstanceRequest) (*Instance, error) {
	if err := validateInstanceIdentity(req); err != nil {
		return nil, err
	}
	params := buildInstanceParams(req, false, c.currentAPIFamily())
	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().instance, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}
	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		InstanceID  string            `json:"instanceId"`
		IP          string            `json:"ip"`
		Port        int               `json:"port"`
		Weight      float64           `json:"weight"`
		Healthy     bool              `json:"healthy"`
		Enabled     bool              `json:"enabled"`
		Ephemeral   bool              `json:"ephemeral"`
		ClusterName string            `json:"clusterName"`
		Service     string            `json:"service"`
		ServiceName string            `json:"serviceName"`
		Metadata    map[string]string `json:"metadata"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_instance", map[string]any{
			"detail": err.Error(),
		})
	}
	return &Instance{
		InstanceID:  strings.TrimSpace(payload.InstanceID),
		IP:          firstNonEmpty(strings.TrimSpace(payload.IP), strings.TrimSpace(req.IP)),
		Port:        firstNonZeroPort(payload.Port, req.Port),
		Weight:      payload.Weight,
		Healthy:     payload.Healthy,
		Enabled:     payload.Enabled,
		Ephemeral:   payload.Ephemeral,
		ClusterName: firstNonEmpty(strings.TrimSpace(payload.ClusterName), strings.TrimSpace(req.ClusterName)),
		ServiceName: firstNonEmpty(strings.TrimSpace(payload.ServiceName), strings.TrimSpace(payload.Service), strings.TrimSpace(req.ServiceName)),
		Metadata:    payload.Metadata,
	}, nil
}

// RegisterInstance registers an instance.
func (c *ClientImpl) RegisterInstance(ctx context.Context, req InstanceRequest) error {
	if err := validateInstanceIdentity(req); err != nil {
		return err
	}
	form := buildInstanceForm(req, true, c.currentAPIFamily())
	body, status, err := c.doRequest(ctx, http.MethodPost, c.currentAPIRoutes().instance, nil, form)
	if err != nil {
		return err
	}
	return parseNamingOKResult(body, status, "nacos.backend.error.instance_register_failed")
}

// UpdateInstance updates an instance.
func (c *ClientImpl) UpdateInstance(ctx context.Context, req InstanceRequest) error {
	if err := validateInstanceIdentity(req); err != nil {
		return err
	}
	form := buildInstanceForm(req, true, c.currentAPIFamily())
	body, status, err := c.doRequest(ctx, http.MethodPut, c.currentAPIRoutes().instance, nil, form)
	if err != nil {
		return err
	}
	return parseNamingOKResult(body, status, "nacos.backend.error.instance_update_failed")
}

// DeregisterInstance removes an instance.
func (c *ClientImpl) DeregisterInstance(ctx context.Context, req InstanceRequest) error {
	if err := validateInstanceIdentity(req); err != nil {
		return err
	}
	params := buildInstanceParams(req, true, c.currentAPIFamily())
	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().instance, params, nil)
	if err != nil {
		return err
	}
	return parseNamingOKResult(body, status, "nacos.backend.error.instance_deregister_failed")
}

// UpdateInstanceHealth updates instance health (only when health checker is NONE).
func (c *ClientImpl) UpdateInstanceHealth(ctx context.Context, req InstanceRequest) error {
	if err := validateInstanceIdentity(req); err != nil {
		return err
	}
	if req.Healthy == nil {
		return localizedNacosBackendError("nacos.backend.error.instance_healthy_required", nil)
	}
	form := buildInstanceForm(req, false, c.currentAPIFamily())
	form.Set("healthy", strconv.FormatBool(*req.Healthy))
	body, status, err := c.doRequest(ctx, http.MethodPut, c.currentAPIRoutes().health, nil, form)
	if err != nil {
		return err
	}
	return parseNamingOKResult(body, status, "nacos.backend.error.instance_health_failed")
}

func validateInstanceIdentity(req InstanceRequest) error {
	if strings.TrimSpace(req.ServiceName) == "" {
		return localizedNacosBackendError("nacos.backend.error.service_name_required", nil)
	}
	if strings.TrimSpace(req.IP) == "" {
		return localizedNacosBackendError("nacos.backend.error.instance_ip_required", nil)
	}
	if req.Port <= 0 || req.Port > 65535 {
		return localizedNacosBackendError("nacos.backend.error.instance_port_invalid", nil)
	}
	return nil
}

func buildInstanceParams(req InstanceRequest, includeEphemeral bool, family nacosAPIFamily) url.Values {
	serviceName, groupName := splitServiceName(req.ServiceName, req.GroupName)
	params := url.Values{}
	if family == nacosAPIV1 {
		params.Set("serviceName", qualifyServiceName(serviceName, groupName))
	} else {
		params.Set("serviceName", serviceName)
	}
	params.Set("groupName", groupName)
	params.Set("namespaceId", normalizeNamespaceID(req.NamespaceID))
	params.Set("ip", strings.TrimSpace(req.IP))
	params.Set("port", strconv.Itoa(req.Port))
	if cluster := strings.TrimSpace(req.ClusterName); cluster != "" {
		params.Set("clusterName", cluster)
		if family == nacosAPIV1 {
			params.Set("cluster", cluster)
		}
	}
	if includeEphemeral && req.Ephemeral != nil {
		params.Set("ephemeral", strconv.FormatBool(*req.Ephemeral))
	}
	return params
}

func buildInstanceForm(req InstanceRequest, includeAttrs bool, family nacosAPIFamily) url.Values {
	form := buildInstanceParams(req, true, family)
	if includeAttrs {
		if req.Weight != nil {
			form.Set("weight", strconv.FormatFloat(*req.Weight, 'f', -1, 64))
		}
		if req.Enabled != nil {
			form.Set("enabled", strconv.FormatBool(*req.Enabled))
		}
		if req.Healthy != nil {
			form.Set("healthy", strconv.FormatBool(*req.Healthy))
		}
		if meta := encodeMetadata(req.Metadata); meta != "" {
			form.Set("metadata", meta)
		}
	}
	return form
}

func normalizeServiceGroup(group string) string {
	group = strings.TrimSpace(group)
	if group == "" {
		return defaultServiceGroup
	}
	return group
}

func splitServiceName(serviceName, groupName string) (string, string) {
	serviceName = strings.TrimSpace(serviceName)
	if separator := strings.Index(serviceName, "@@"); separator >= 0 {
		qualifiedGroup := strings.TrimSpace(serviceName[:separator])
		plainServiceName := strings.TrimSpace(serviceName[separator+2:])
		if plainServiceName != "" {
			return plainServiceName, normalizeServiceGroup(qualifiedGroup)
		}
	}
	return serviceName, normalizeServiceGroup(groupName)
}

func qualifyServiceName(serviceName, groupName string) string {
	serviceName, groupName = splitServiceName(serviceName, groupName)
	if serviceName == "" {
		return ""
	}
	return groupName + "@@" + serviceName
}

func encodeMetadata(metadata map[string]string) string {
	if len(metadata) == 0 {
		return ""
	}
	raw, err := json.Marshal(metadata)
	if err != nil {
		return ""
	}
	return string(raw)
}

func parseNamingOKResult(body []byte, status int, failKey string) error {
	if status < 200 || status >= 300 {
		return localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}
	data, err := unwrapNacosResult(body)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	text := strings.TrimSpace(string(data))
	if text == "" || strings.EqualFold(text, "ok") || text == "true" {
		return nil
	}
	var boolResult bool
	if err := json.Unmarshal(data, &boolResult); err == nil && boolResult {
		return nil
	}
	var stringResult string
	if err := json.Unmarshal(data, &stringResult); err == nil && strings.EqualFold(strings.TrimSpace(stringResult), "ok") {
		return nil
	}
	return localizedNacosBackendError(failKey, map[string]any{
		"body": truncateForError(text),
	})
}

func firstNonZeroPort(values ...int) int {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}
