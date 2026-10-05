package nacos

import (
	"context"
	"net/http"
	"strconv"
	"testing"
)

func assertProbeSequenceAndCache(
	t *testing.T,
	client *ClientImpl,
	recorder *nacosAPIRequestRecorder,
	family nacosAPIFamily,
) {
	t.Helper()
	readinessPath := nacosV3ReadinessPath
	v3Path := routesForNacosAPI(nacosAPIV3).namespaceList
	v2Path := routesForNacosAPI(nacosAPIV2).namespaceList
	v1Path := routesForNacosAPI(nacosAPIV1).namespaceList

	wantBefore := map[nacosAPIFamily]map[string]int{
		nacosAPIV3: {readinessPath: 2, v3Path: 0, v2Path: 0, v1Path: 0},
		nacosAPIV2: {readinessPath: 1, v3Path: 0, v2Path: 2, v1Path: 0},
		nacosAPIV1: {readinessPath: 1, v3Path: 0, v2Path: 1, v1Path: 2},
	}[family]
	for path, want := range wantBefore {
		if got := recorder.countPath(path); got != want {
			t.Fatalf("probe request count for %s = %d, want %d", path, got, want)
		}
	}

	namespaces, err := client.ListNamespaces(context.Background())
	if err != nil {
		t.Fatalf("ListNamespaces with cached family: %v", err)
	}
	if len(namespaces) != 1 || namespaces[0].ID != "dev-id" || namespaces[0].ShowName != "Development" {
		t.Fatalf("namespaces = %#v", namespaces)
	}

	selectedPath := routesForNacosAPI(family).namespaceList
	for path, before := range wantBefore {
		want := before
		if path == selectedPath {
			want++
		}
		if got := recorder.countPath(path); got != want {
			t.Fatalf("cached namespace request count for %s = %d, want %d", path, got, want)
		}
	}
}

func exerciseNacosAPIFamily(
	t *testing.T,
	client *ClientImpl,
	recorder *nacosAPIRequestRecorder,
	test struct {
		name                   string
		family                 nacosAPIFamily
		configListGroupKey     string
		configListNamespaceKey string
		configGroupKey         string
		configNamespaceKey     string
		serviceListGroupKey    string
		qualifiedNaming        bool
	},
) {
	t.Helper()
	ctx := context.Background()
	routes := routesForNacosAPI(test.family)

	if err := client.CreateNamespace(ctx, CreateNamespaceRequest{
		ID: "qa-id", ShowName: "QA", Description: "quality",
	}); err != nil {
		t.Fatalf("CreateNamespace: %v", err)
	}
	request := mustLastNacosAPIRequest(t, recorder, http.MethodPost, routes.namespace)
	if test.family == nacosAPIV1 {
		assertNacosAPIValues(t, request.values, map[string]string{
			"customNamespaceId": "qa-id", "namespaceName": "QA", "namespaceDesc": "quality",
		})
	} else {
		assertNacosAPIValues(t, request.values, map[string]string{
			"namespaceId": "qa-id", "namespaceName": "QA", "namespaceDesc": "quality",
		})
	}

	if err := client.UpdateNamespace(ctx, UpdateNamespaceRequest{
		ID: "qa-id", ShowName: "QA 2", Description: "updated",
	}); err != nil {
		t.Fatalf("UpdateNamespace: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodPut, routes.namespace)
	if test.family == nacosAPIV1 {
		assertNacosAPIValues(t, request.values, map[string]string{
			"namespace": "qa-id", "namespaceShowName": "QA 2", "namespaceDesc": "updated",
		})
	} else {
		assertNacosAPIValues(t, request.values, map[string]string{
			"namespaceId": "qa-id", "namespaceName": "QA 2", "namespaceDesc": "updated",
		})
	}

	if err := client.DeleteNamespace(ctx, "qa-id"); err != nil {
		t.Fatalf("DeleteNamespace: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodDelete, routes.namespace)
	assertNacosAPIValues(t, request.values, map[string]string{"namespaceId": "qa-id"})

	page, err := client.SearchConfigs(ctx, ConfigQuery{
		NamespaceID: "dev-id",
		DataID:      "app",
		Group:       "MKEFU",
		PageNo:      2,
		PageSize:    15,
		Search:      "blur",
	})
	if err != nil {
		t.Fatalf("SearchConfigs: %v", err)
	}
	if page.TotalCount != 1 || len(page.PageItems) != 1 || page.PageItems[0].DataID != "app.yaml" ||
		page.PageItems[0].Group != "MKEFU" || page.PageItems[0].NamespaceID != "dev-id" {
		t.Fatalf("config page = %#v", page)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, routes.configList)
	assertNacosAPIValues(t, request.values, map[string]string{
		"dataId":                    "app",
		test.configListGroupKey:     "MKEFU",
		test.configListNamespaceKey: "dev-id",
		"pageNo":                    "2",
		"pageSize":                  "15",
	})
	if test.family == nacosAPIV2 {
		assertNacosAPIKeyPresent(t, request.values, "config_detail")
	}
	assertNacosAPIKeysAbsent(t, request.values,
		otherNacosConfigGroupKey(test.configListGroupKey),
		otherNacosConfigNamespaceKey(test.configListNamespaceKey),
	)

	detail, err := client.GetConfig(ctx, "dev-id", "MKEFU", "app.yaml")
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if detail.Content != "versioned-content" || detail.Group != "MKEFU" || detail.NamespaceID != "dev-id" {
		t.Fatalf("config detail = %#v", detail)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, routes.config)
	assertNacosAPIValues(t, request.values, map[string]string{
		"dataId":                "app.yaml",
		test.configGroupKey:     "MKEFU",
		test.configNamespaceKey: "dev-id",
	})
	assertNacosAPIKeysAbsent(t, request.values,
		otherNacosConfigGroupKey(test.configGroupKey),
		otherNacosConfigNamespaceKey(test.configNamespaceKey),
	)

	if err := client.PublishConfig(ctx, PublishRequest{
		NamespaceID: "dev-id",
		DataID:      "app.yaml",
		Group:       "MKEFU",
		Content:     "new-content",
		Type:        "yaml",
		BetaIPs:     "10.0.0.10",
	}); err != nil {
		t.Fatalf("PublishConfig: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodPost, routes.config)
	assertNacosAPIValues(t, request.values, map[string]string{
		"dataId":                "app.yaml",
		test.configGroupKey:     "MKEFU",
		test.configNamespaceKey: "dev-id",
		"content":               "new-content",
		"type":                  "yaml",
	})
	if got := request.header.Get("betaIps"); got != "10.0.0.10" {
		t.Fatalf("betaIps header = %q, want %q", got, "10.0.0.10")
	}

	if err := client.DeleteConfig(ctx, "dev-id", "MKEFU", "app.yaml"); err != nil {
		t.Fatalf("DeleteConfig: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodDelete, routes.config)
	assertNacosAPIValues(t, request.values, map[string]string{
		"dataId":                "app.yaml",
		test.configGroupKey:     "MKEFU",
		test.configNamespaceKey: "dev-id",
	})

	beta, err := client.GetBetaConfig(ctx, "dev-id", "MKEFU", "app.yaml")
	if err != nil {
		t.Fatalf("GetBetaConfig: %v", err)
	}
	if !beta.Exists || beta.Content != "beta-content" || beta.BetaIPs != "10.0.0.10" {
		t.Fatalf("beta config = %#v", beta)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, routes.beta)
	if test.family == nacosAPIV3 {
		assertNacosAPIValues(t, request.values, map[string]string{
			"dataId": "app.yaml", "groupName": "MKEFU", "namespaceId": "dev-id",
		})
	} else {
		assertNacosAPIValues(t, request.values, map[string]string{
			"dataId": "app.yaml", "group": "MKEFU", "tenant": "dev-id", "beta": "true",
		})
	}
	if err := client.StopBetaConfig(ctx, "dev-id", "MKEFU", "app.yaml"); err != nil {
		t.Fatalf("StopBetaConfig: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodDelete, routes.beta)
	if test.family == nacosAPIV3 {
		assertNacosAPIValues(t, request.values, map[string]string{
			"dataId": "app.yaml", "groupName": "MKEFU", "namespaceId": "dev-id",
		})
	} else {
		assertNacosAPIValues(t, request.values, map[string]string{
			"dataId": "app.yaml", "group": "MKEFU", "tenant": "dev-id", "beta": "true",
		})
	}

	history, err := client.ListConfigHistory(ctx, HistoryQuery{
		NamespaceID: "dev-id",
		DataID:      "app.yaml",
		Group:       "MKEFU",
		PageNo:      1,
		PageSize:    10,
	})
	if err != nil {
		t.Fatalf("ListConfigHistory: %v", err)
	}
	if history.TotalCount != 1 || len(history.PageItems) != 1 || history.PageItems[0].ID != "203" {
		t.Fatalf("history page = %#v", history)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, routes.historyList)
	assertNacosAPIValues(t, request.values, map[string]string{
		"dataId":                "app.yaml",
		test.configGroupKey:     "MKEFU",
		test.configNamespaceKey: "dev-id",
		"pageNo":                "1",
		"pageSize":              "10",
	})

	historyDetail, err := client.GetConfigHistory(ctx, "dev-id", "MKEFU", "app.yaml", "203")
	if err != nil {
		t.Fatalf("GetConfigHistory: %v", err)
	}
	if historyDetail.ID != "203" || historyDetail.Content != "old-content" {
		t.Fatalf("history detail = %#v", historyDetail)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, routes.configHistory)
	assertNacosAPIValues(t, request.values, map[string]string{
		"dataId":                "app.yaml",
		test.configGroupKey:     "MKEFU",
		test.configNamespaceKey: "dev-id",
		"nid":                   "203",
	})

	services, err := client.ListServices(ctx, ServiceQuery{
		NamespaceID: "dev-id",
		GroupName:   "MKEFU",
		PageNo:      1,
		PageSize:    20,
	})
	if err != nil {
		t.Fatalf("ListServices: %v", err)
	}
	if services.Count != 1 || len(services.ServiceNames) != 1 || services.ServiceNames[0] != "MKEFU@@orders" {
		t.Fatalf("service page = %#v", services)
	}
	serviceListPath := routes.serviceListByGroup
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, serviceListPath)
	servicePageSize := "20"
	if test.family == nacosAPIV3 {
		servicePageSize = strconv.Itoa(maxServicePageSize)
	}
	assertNacosAPIValues(t, request.values, map[string]string{
		"namespaceId":            "dev-id",
		test.serviceListGroupKey: "MKEFU",
		"pageNo":                 "1",
		"pageSize":               servicePageSize,
	})

	service, err := client.GetService(ctx, "dev-id", "orders", "MKEFU")
	if err != nil {
		t.Fatalf("GetService: %v", err)
	}
	if service.Name != "orders" || service.GroupName != "MKEFU" || service.NamespaceID != "dev-id" || !service.Ephemeral {
		t.Fatalf("service detail = %#v", service)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, routes.service)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)

	serviceEphemeral := false
	if err := client.CreateService(ctx, CreateServiceRequest{
		NamespaceID: "dev-id", ServiceName: "orders", GroupName: "MKEFU", ProtectThreshold: 0.5,
		Ephemeral: &serviceEphemeral,
	}); err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodPost, routes.service)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)
	if test.family == nacosAPIV1 {
		if _, ok := request.values["ephemeral"]; ok {
			t.Fatalf("v1 CreateService unexpectedly sent ephemeral=%q", request.values.Get("ephemeral"))
		}
	} else {
		assertNacosAPIValues(t, request.values, map[string]string{"ephemeral": "false"})
	}
	if err := client.UpdateService(ctx, UpdateServiceRequest{
		NamespaceID: "dev-id", ServiceName: "orders", GroupName: "MKEFU", ProtectThreshold: 0.25,
	}); err != nil {
		t.Fatalf("UpdateService: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodPut, routes.service)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)
	if err := client.DeleteService(ctx, "dev-id", "orders", "MKEFU"); err != nil {
		t.Fatalf("DeleteService: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodDelete, routes.service)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)

	instances, err := client.ListInstances(ctx, InstanceQuery{
		NamespaceID: "dev-id",
		ServiceName: "orders",
		GroupName:   "MKEFU",
		Clusters:    "DEFAULT",
		HealthyOnly: true,
	})
	if err != nil {
		t.Fatalf("ListInstances: %v", err)
	}
	if len(instances.Hosts) != 1 || instances.Hosts[0].IP != "10.0.0.1" || instances.Hosts[0].Port != 8080 {
		t.Fatalf("instances = %#v", instances)
	}
	if instances.Hosts[0].Enabled {
		t.Fatalf("disabled instance was not preserved: %#v", instances.Hosts[0])
	}
	instanceListPath := map[nacosAPIFamily]string{
		nacosAPIV1: "/v1/ns/catalog/instances",
		nacosAPIV2: "/v2/ns/catalog/instances",
		nacosAPIV3: "/v3/admin/ns/instance/list",
	}[test.family]
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, instanceListPath)
	if test.family == nacosAPIV2 {
		assertNacosAPIValues(t, request.values, map[string]string{
			"namespaceId": "dev-id",
			"serviceName": "MKEFU@@orders",
		})
		assertNacosAPIKeysAbsent(t, request.values, "groupName")
	} else {
		assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)
	}
	assertNacosAPIKeysAbsent(t, request.values, "enabledOnly")

	zeroWeight := 0.0
	instanceRequest := InstanceRequest{
		NamespaceID: "dev-id",
		ServiceName: "orders",
		GroupName:   "MKEFU",
		IP:          "10.0.0.1",
		Port:        8080,
		ClusterName: "DEFAULT",
		Weight:      &zeroWeight,
	}
	instance, err := client.GetInstance(ctx, instanceRequest)
	if err != nil {
		t.Fatalf("GetInstance: %v", err)
	}
	if instance.IP != "10.0.0.1" || instance.Port != 8080 {
		t.Fatalf("instance detail = %#v", instance)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodGet, routes.instance)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)

	ephemeral := false
	enabled := true
	instanceRequest.Ephemeral = &ephemeral
	instanceRequest.Enabled = &enabled
	if err := client.RegisterInstance(ctx, instanceRequest); err != nil {
		t.Fatalf("RegisterInstance: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodPost, routes.instance)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)
	assertNacosAPIValues(t, request.values, map[string]string{
		"ephemeral": "false",
		"weight":    "0",
	})
	if err := client.UpdateInstance(ctx, instanceRequest); err != nil {
		t.Fatalf("UpdateInstance: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodPut, routes.instance)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)
	assertNacosAPIValues(t, request.values, map[string]string{
		"ephemeral": "false",
		"weight":    "0",
	})
	if err := client.DeregisterInstance(ctx, instanceRequest); err != nil {
		t.Fatalf("DeregisterInstance: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodDelete, routes.instance)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)

	healthy := false
	instanceRequest.Healthy = &healthy
	if err := client.UpdateInstanceHealth(ctx, instanceRequest); err != nil {
		t.Fatalf("UpdateInstanceHealth: %v", err)
	}
	request = mustLastNacosAPIRequest(t, recorder, http.MethodPut, routes.health)
	assertNacosNamingIdentity(t, request.values, test.qualifiedNaming)
	assertNacosAPIValues(t, request.values, map[string]string{"healthy": "false"})
}
