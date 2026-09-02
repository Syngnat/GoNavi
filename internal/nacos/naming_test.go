package nacos

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestNamingServiceAndInstanceFlow(t *testing.T) {
	var (
		createServiceForm url.Values
		registerForm      url.Values
		healthForm        url.Values
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": []any{}})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/catalog/services"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"count": 2,
				"serviceList": []map[string]any{
					{"name": "orders", "groupName": "DEFAULT_GROUP"},
					{"name": "payments", "groupName": "DEFAULT_GROUP"},
				},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/service"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":             "orders",
				"groupName":        "DEFAULT_GROUP",
				"namespaceId":      "dev",
				"ephemeral":        true,
				"protectThreshold": 0.5,
				"metadata":         map[string]string{"owner": "team-a"},
				"clusters": []map[string]any{
					{"name": "DEFAULT"},
				},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/ns/service"):
			_ = r.ParseForm()
			createServiceForm = r.Form
			_, _ = io.WriteString(w, "ok")
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/v1/ns/service"):
			_, _ = io.WriteString(w, "ok")
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/catalog/instances"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"count": 1,
				"list": []map[string]any{
					{
						"ip":          "10.0.0.1",
						"port":        8080,
						"weight":      1,
						"healthy":     true,
						"enabled":     true,
						"ephemeral":   true,
						"clusterName": "DEFAULT",
					},
				},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/ns/instance"):
			_ = r.ParseForm()
			registerForm = r.Form
			_, _ = io.WriteString(w, "ok")
		case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/v1/ns/health/instance"):
			_ = r.ParseForm()
			healthForm = r.Form
			_, _ = io.WriteString(w, "ok")
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/v1/ns/instance"):
			_, _ = io.WriteString(w, "ok")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}

	client := NewClient()
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             u.Hostname(),
		Port:             port,
		Timeout:          5,
		ConnectionParams: "contextPath=/",
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	ctx := context.Background()
	page, err := client.ListServices(ctx, ServiceQuery{NamespaceID: "dev", PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListServices: %v", err)
	}
	if page.Count != 2 || len(page.ServiceNames) != 2 {
		t.Fatalf("service page = %#v", page)
	}

	detail, err := client.GetService(ctx, "dev", "orders", "DEFAULT_GROUP")
	if err != nil {
		t.Fatalf("GetService: %v", err)
	}
	if detail.Name != "orders" || !detail.Ephemeral || detail.ProtectThreshold != 0.5 {
		t.Fatalf("service detail = %#v", detail)
	}

	if err := client.CreateService(ctx, CreateServiceRequest{
		NamespaceID: "dev",
		ServiceName: "cart",
		GroupName:   "DEFAULT_GROUP",
		Metadata:    map[string]string{"env": "dev"},
	}); err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	if createServiceForm.Get("serviceName") != "DEFAULT_GROUP@@cart" {
		t.Fatalf("create form = %#v", createServiceForm)
	}

	list, err := client.ListInstances(ctx, InstanceQuery{
		NamespaceID: "dev",
		ServiceName: "orders",
		GroupName:   "DEFAULT_GROUP",
	})
	if err != nil {
		t.Fatalf("ListInstances: %v", err)
	}
	if len(list.Hosts) != 1 || list.Hosts[0].IP != "10.0.0.1" {
		t.Fatalf("instances = %#v", list)
	}

	ephemeral := true
	enabled := true
	weight := 1.0
	if err := client.RegisterInstance(ctx, InstanceRequest{
		NamespaceID: "dev",
		ServiceName: "orders",
		GroupName:   "DEFAULT_GROUP",
		IP:          "10.0.0.2",
		Port:        8081,
		Weight:      &weight,
		Enabled:     &enabled,
		Ephemeral:   &ephemeral,
		ClusterName: "DEFAULT",
	}); err != nil {
		t.Fatalf("RegisterInstance: %v", err)
	}
	if registerForm.Get("ip") != "10.0.0.2" || registerForm.Get("port") != "8081" {
		t.Fatalf("register form = %#v", registerForm)
	}

	healthy := false
	if err := client.UpdateInstanceHealth(ctx, InstanceRequest{
		NamespaceID: "dev",
		ServiceName: "orders",
		IP:          "10.0.0.1",
		Port:        8080,
		Healthy:     &healthy,
	}); err != nil {
		t.Fatalf("UpdateInstanceHealth: %v", err)
	}
	if healthForm.Get("healthy") != "false" {
		t.Fatalf("health form = %#v", healthForm)
	}

	if err := client.DeregisterInstance(ctx, InstanceRequest{
		NamespaceID: "dev",
		ServiceName: "orders",
		IP:          "10.0.0.2",
		Port:        8081,
	}); err != nil {
		t.Fatalf("DeregisterInstance: %v", err)
	}

	if err := client.DeleteService(ctx, "dev", "cart", "DEFAULT_GROUP"); err != nil {
		t.Fatalf("DeleteService: %v", err)
	}
}

func TestListServicesUsesCatalogAcrossGroups(t *testing.T) {
	var catalogQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": []any{}})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/catalog/services"):
			catalogQuery = r.URL.Query()
			if catalogQuery.Get("groupNameParam") == "^MKEFU_SERVICE$" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"count": 2,
					"serviceList": []map[string]any{
						{"name": "orders", "groupName": "MKEFU_SERVICE"},
						{"name": "other", "groupName": "MKEFU_SERVICE_ARCHIVE"},
					},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"count": 2,
				"serviceList": []map[string]any{
					{"name": "orders", "groupName": "MKEFU_SERVICE"},
					{"name": "payments", "groupName": "DEFAULT_GROUP"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := connectNamingTestClient(t, server)
	defer client.Close()

	page, err := client.ListServices(context.Background(), ServiceQuery{
		NamespaceID: "mkefu-dev",
		ServiceName: "order",
		PageNo:      1,
		PageSize:    50,
	})
	if err != nil {
		t.Fatalf("ListServices: %v", err)
	}
	groupValues, hasGroupParam := catalogQuery["groupNameParam"]
	if catalogQuery.Get("namespaceId") != "mkefu-dev" || !hasGroupParam || len(groupValues) != 1 || groupValues[0] != "" {
		t.Fatalf("catalog query = %#v", catalogQuery)
	}
	if catalogQuery.Get("serviceNameParam") != "order" {
		t.Fatalf("catalog serviceNameParam = %q, want order", catalogQuery.Get("serviceNameParam"))
	}
	want := []string{"MKEFU_SERVICE@@orders", "DEFAULT_GROUP@@payments"}
	if page.Count != 2 || len(page.ServiceNames) != len(want) {
		t.Fatalf("service page = %#v", page)
	}
	for i := range want {
		if page.ServiceNames[i] != want[i] {
			t.Fatalf("serviceNames[%d] = %q, want %q", i, page.ServiceNames[i], want[i])
		}
	}

	groupPage, err := client.ListServices(context.Background(), ServiceQuery{
		NamespaceID: "mkefu-dev",
		ServiceName: "order",
		GroupName:   "MKEFU_SERVICE",
		PageNo:      1,
		PageSize:    50,
	})
	if err != nil {
		t.Fatalf("ListServices with group: %v", err)
	}
	if catalogQuery.Get("groupNameParam") != "MKEFU_SERVICE" || catalogQuery.Get("namespaceId") != "mkefu-dev" {
		t.Fatalf("exact group query = %#v", catalogQuery)
	}
	if catalogQuery.Get("serviceNameParam") != "order" {
		t.Fatalf("exact group serviceNameParam = %q, want order", catalogQuery.Get("serviceNameParam"))
	}
	if groupPage.Count != 1 || len(groupPage.ServiceNames) != 1 || groupPage.ServiceNames[0] != "MKEFU_SERVICE@@orders" {
		t.Fatalf("exact group page = %#v", groupPage)
	}
}

func TestListInstancesV1CatalogKeepsDisabledInstancesAcrossClustersAndPages(t *testing.T) {
	const pageSize = maxInstancePageSize
	requests := make(map[string][]int)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v3/console/health/readiness"):
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v2/console/health/readiness"):
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v2/console/namespace/list"):
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/console/health/readiness"):
			_, _ = io.WriteString(w, "OK")
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/service"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":      "orders",
				"groupName": "MKEFU_SERVICE",
				"clusters": []map[string]any{
					{"name": "DEFAULT"},
					{"name": "EDGE"},
				},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/catalog/instances"):
			cluster := r.URL.Query().Get("clusterName")
			pageNo, _ := strconv.Atoi(r.URL.Query().Get("pageNo"))
			requests[cluster] = append(requests[cluster], pageNo)
			if r.URL.Query().Get("serviceName") != "MKEFU_SERVICE@@orders" {
				t.Errorf("catalog serviceName = %q", r.URL.Query().Get("serviceName"))
			}
			count := pageSize + 1
			start := (pageNo - 1) * pageSize
			end := min(start+pageSize, count)
			instances := make([]map[string]any, 0, max(0, end-start))
			for index := start; index < end; index++ {
				instances = append(instances, map[string]any{
					"ip":          fmt.Sprintf("10.%d.%d.%d", len(cluster), index/256, index%256),
					"port":        8000 + index,
					"weight":      1,
					"healthy":     true,
					"enabled":     index != count-1,
					"ephemeral":   false,
					"clusterName": cluster,
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"count": count,
				"list":  instances,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := connectNamingTestClient(t, server)
	defer client.Close()
	instances, err := client.ListInstances(context.Background(), InstanceQuery{
		NamespaceID: "mkefu-dev",
		ServiceName: "orders",
		GroupName:   "MKEFU_SERVICE",
	})
	if err != nil {
		t.Fatalf("ListInstances: %v", err)
	}
	if got, want := len(instances.Hosts), 2*(pageSize+1); got != want {
		t.Fatalf("hosts = %d, want %d", got, want)
	}
	if got, want := requests["DEFAULT"], []int{1, 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("DEFAULT pages = %v, want %v", got, want)
	}
	if got, want := requests["EDGE"], []int{1, 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("EDGE pages = %v, want %v", got, want)
	}
	disabled := 0
	for _, instance := range instances.Hosts {
		if !instance.Enabled {
			disabled++
		}
	}
	if disabled != 2 {
		t.Fatalf("disabled instances = %d, want 2", disabled)
	}
}

func TestListInstancesV1CatalogQueriesUnscopedWhenServiceDoesNotDeclareClusters(t *testing.T) {
	catalogRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV3ReadinessPath):
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV2ReadinessPath):
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, routesForNacosAPI(nacosAPIV2).namespaceList):
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV1ReadinessPath):
			_, _ = io.WriteString(w, "OK")
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/service"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":       "orders",
				"groupName":  "MKEFU_SERVICE",
				"clusterMap": map[string]any{},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/catalog/instances"):
			catalogRequests++
			if cluster := r.URL.Query().Get("clusterName"); cluster != "" {
				t.Errorf("catalog clusterName = %q, want empty", cluster)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"count": 1,
				"list": []map[string]any{{
					"ip":          "10.0.0.1",
					"port":        8080,
					"healthy":     true,
					"enabled":     false,
					"clusterName": "DEFAULT",
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := connectNamingTestClient(t, server)
	defer client.Close()
	instances, err := client.ListInstances(context.Background(), InstanceQuery{
		NamespaceID: "mkefu-dev",
		ServiceName: "orders",
		GroupName:   "MKEFU_SERVICE",
	})
	if err != nil {
		t.Fatalf("ListInstances: %v", err)
	}
	if len(instances.Hosts) != 1 || instances.Hosts[0].Enabled {
		t.Fatalf("hosts = %#v, want one disabled instance", instances.Hosts)
	}
	if catalogRequests != 1 {
		t.Fatalf("catalog requests = %d, want 1", catalogRequests)
	}
}

func TestParseNacosCatalogInstancesKeepsDisabledInstancesAcrossSupportedPageShapes(t *testing.T) {
	for _, raw := range []string{
		`{"count":1,"instances":[{"ip":"10.0.0.1","port":8080,"enabled":false}]}`,
		`{"count":1,"list":[{"ip":"10.0.0.1","port":8080,"enabled":false}]}`,
		`{"count":1,"pageItems":[{"ip":"10.0.0.1","port":8080,"enabled":false}]}`,
	} {
		page, err := parseNacosCatalogInstances([]byte(raw))
		if err != nil {
			t.Fatalf("parseNacosCatalogInstances(%s): %v", raw, err)
		}
		instances := normalizeNacosInstances(page.items(), "MKEFU_SERVICE@@orders")
		if len(instances) != 1 || instances[0].Enabled {
			t.Fatalf("instances = %#v, want one disabled instance", instances)
		}
	}
}

func TestListInstancesV2FallsBackToV1CatalogWhenV2CatalogIsUnavailable(t *testing.T) {
	var (
		v2CatalogRequests int
		v1CatalogClusters []string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV3ReadinessPath):
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV2ReadinessPath):
			writeNacosResult(w, nacosAPIV2, "ok")
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v2/ns/catalog/instances"):
			v2CatalogRequests++
			http.NotFound(w, r)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v2/ns/service"):
			writeNacosResult(w, nacosAPIV2, map[string]any{
				"name":      "orders",
				"groupName": "MKEFU_SERVICE",
				"clusters": []map[string]any{
					{"name": "DEFAULT"},
					{"name": "EDGE"},
				},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/catalog/instances"):
			cluster := r.URL.Query().Get("clusterName")
			v1CatalogClusters = append(v1CatalogClusters, cluster)
			if got := r.URL.Query().Get("serviceName"); got != "MKEFU_SERVICE@@orders" {
				t.Errorf("v1 catalog serviceName = %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"count": 1,
				"list": []map[string]any{{
					"ip":          "10.0.0.1",
					"port":        8080,
					"healthy":     true,
					"enabled":     false,
					"clusterName": cluster,
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := connectNamingTestClient(t, server)
	defer client.Close()
	instances, err := client.ListInstances(context.Background(), InstanceQuery{
		NamespaceID: "mkefu-dev",
		ServiceName: "orders",
		GroupName:   "MKEFU_SERVICE",
	})
	if err != nil {
		t.Fatalf("ListInstances: %v", err)
	}
	if v2CatalogRequests != 1 {
		t.Fatalf("v2 catalog requests = %d, want 1", v2CatalogRequests)
	}
	if want := []string{"DEFAULT", "EDGE"}; !reflect.DeepEqual(v1CatalogClusters, want) {
		t.Fatalf("v1 catalog clusters = %v, want %v", v1CatalogClusters, want)
	}
	if len(instances.Hosts) != 2 {
		t.Fatalf("hosts = %#v, want 2", instances.Hosts)
	}
	for _, instance := range instances.Hosts {
		if instance.Enabled {
			t.Fatalf("disabled instance was not preserved: %#v", instance)
		}
	}
}

func TestNamingOperationsQualifyNonDefaultGroup(t *testing.T) {
	var requests []struct {
		method           string
		path             string
		serviceName      string
		protectThreshold string
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && (strings.HasSuffix(r.URL.Path, nacosV3ReadinessPath) ||
			strings.HasSuffix(r.URL.Path, nacosV2ReadinessPath) ||
			strings.HasSuffix(r.URL.Path, "/v2/console/namespace/list")) {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV1ReadinessPath) {
			_, _ = io.WriteString(w, "OK")
			return
		}
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces") {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": []any{}})
			return
		}
		_ = r.ParseForm()
		requests = append(requests, struct {
			method           string
			path             string
			serviceName      string
			protectThreshold string
		}{
			method:           r.Method,
			path:             r.URL.Path,
			serviceName:      r.Form.Get("serviceName"),
			protectThreshold: r.Form.Get("protectThreshold"),
		})

		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/service"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":        "orders",
				"groupName":   "MKEFU_SERVICE",
				"namespaceId": "mkefu-dev",
				"clusters": []map[string]any{
					{"name": "DEFAULT"},
				},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/catalog/instances"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"count": 0,
				"list":  []any{},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/ns/instance"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ip":          "10.0.0.1",
				"port":        8080,
				"serviceName": "MKEFU_SERVICE@@orders",
			})
		default:
			_, _ = io.WriteString(w, "ok")
		}
	}))
	defer server.Close()

	client := connectNamingTestClient(t, server)
	defer client.Close()
	ctx := context.Background()
	const group = "MKEFU_SERVICE"

	if _, err := client.GetService(ctx, "mkefu-dev", "orders", group); err != nil {
		t.Fatalf("GetService: %v", err)
	}
	if err := client.CreateService(ctx, CreateServiceRequest{
		NamespaceID: "mkefu-dev", ServiceName: "orders", GroupName: group,
	}); err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	if err := client.UpdateService(ctx, UpdateServiceRequest{
		NamespaceID: "mkefu-dev", ServiceName: "orders", GroupName: group, ProtectThreshold: 0,
	}); err != nil {
		t.Fatalf("UpdateService: %v", err)
	}
	if err := client.DeleteService(ctx, "mkefu-dev", "orders", group); err != nil {
		t.Fatalf("DeleteService: %v", err)
	}
	if _, err := client.ListInstances(ctx, InstanceQuery{
		NamespaceID: "mkefu-dev", ServiceName: "orders", GroupName: group,
	}); err != nil {
		t.Fatalf("ListInstances: %v", err)
	}

	ephemeral := true
	enabled := true
	healthy := false
	instance := InstanceRequest{
		NamespaceID: "mkefu-dev",
		ServiceName: "orders",
		GroupName:   group,
		IP:          "10.0.0.1",
		Port:        8080,
		Ephemeral:   &ephemeral,
		Enabled:     &enabled,
		Healthy:     &healthy,
	}
	if _, err := client.GetInstance(ctx, instance); err != nil {
		t.Fatalf("GetInstance: %v", err)
	}
	if err := client.RegisterInstance(ctx, instance); err != nil {
		t.Fatalf("RegisterInstance: %v", err)
	}
	if err := client.UpdateInstance(ctx, instance); err != nil {
		t.Fatalf("UpdateInstance: %v", err)
	}
	if err := client.DeregisterInstance(ctx, instance); err != nil {
		t.Fatalf("DeregisterInstance: %v", err)
	}
	if err := client.UpdateInstanceHealth(ctx, instance); err != nil {
		t.Fatalf("UpdateInstanceHealth: %v", err)
	}

	if len(requests) != 11 {
		t.Fatalf("captured requests = %d, want 11", len(requests))
	}
	for _, req := range requests {
		if req.serviceName != "MKEFU_SERVICE@@orders" {
			t.Errorf("%s %s serviceName = %q", req.method, req.path, req.serviceName)
		}
		if req.method == http.MethodPut && strings.HasSuffix(req.path, "/v1/ns/service") && req.protectThreshold != "0" {
			t.Errorf("update protectThreshold = %q, want 0", req.protectThreshold)
		}
	}
}

func connectNamingTestClient(t *testing.T, server *httptest.Server) Client {
	t.Helper()
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	client := NewClient()
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             u.Hostname(),
		Port:             port,
		Timeout:          5,
		ConnectionParams: "contextPath=/",
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	return client
}
