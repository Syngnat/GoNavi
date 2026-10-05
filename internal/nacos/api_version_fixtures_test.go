package nacos

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func nacosAPIMatrixHandler(family nacosAPIFamily, recorder *nacosAPIRequestRecorder) http.Handler {
	routes := routesForNacosAPI(family)
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		values := request.Form
		switch {
		case request.Method == http.MethodGet && request.URL.Path == nacosV3ReadinessPath:
			if family == nacosAPIV3 {
				writeNacosResult(w, nacosAPIV3, "ok")
			} else {
				http.NotFound(w, request)
			}
		case request.Method == http.MethodGet && request.URL.Path == routes.namespaceList:
			writeNacosResult(w, family, []map[string]any{{
				"namespace":         "dev-id",
				"namespaceShowName": "Development",
				"namespaceDesc":     "test namespace",
			}})
		case (request.Method == http.MethodPost || request.Method == http.MethodPut || request.Method == http.MethodDelete) &&
			request.URL.Path == routes.namespace:
			writeNacosMutationResult(w, family, true)
		case request.Method == http.MethodGet && request.URL.Path == routes.configList && values.Get("search") != "":
			writeNacosConfigList(w, family)
		case request.Method == http.MethodGet && request.URL.Path == routes.beta && isNacosBetaRequest(family, values):
			writeNacosBeta(w, family)
		case request.Method == http.MethodDelete && request.URL.Path == routes.beta && isNacosBetaRequest(family, values):
			writeNacosMutationResult(w, family, true)
		case request.Method == http.MethodGet && request.URL.Path == routes.config && values.Get("dataId") != "":
			writeNacosConfigDetail(w, family)
		case request.Method == http.MethodPost && request.URL.Path == routes.config:
			writeNacosMutationResult(w, family, true)
		case request.Method == http.MethodDelete && request.URL.Path == routes.config:
			writeNacosMutationResult(w, family, true)
		case request.Method == http.MethodGet && request.URL.Path == routes.historyList && isNacosHistoryListRequest(family, values):
			writeNacosHistory(w, family, false)
		case request.Method == http.MethodGet && request.URL.Path == routes.configHistory && values.Get("nid") != "":
			writeNacosHistory(w, family, true)
		case request.Method == http.MethodGet && request.URL.Path == routes.serviceListByGroup && nacosServiceGroupValue(family, values) != "":
			writeNacosGroupedServiceList(w, family)
		case request.Method == http.MethodGet && request.URL.Path == routes.serviceList:
			writeNacosServiceList(w, family)
		case request.Method == http.MethodGet && request.URL.Path == routes.service:
			writeNacosFamilyData(w, family, map[string]any{
				"name":             "orders",
				"groupName":        "MKEFU",
				"namespaceId":      "dev-id",
				"ephemeral":        true,
				"protectThreshold": 0.5,
				"metadata":         map[string]string{"owner": "team-a"},
				"clusters":         []any{},
			})
		case (request.Method == http.MethodPost || request.Method == http.MethodPut || request.Method == http.MethodDelete) &&
			request.URL.Path == routes.service:
			writeNacosMutationResult(w, family, "ok")
		case request.Method == http.MethodGet && request.URL.Path == routes.instanceList:
			if family == nacosAPIV1 {
				writeNacosCatalogInstanceList(w, family)
			} else if family == nacosAPIV2 {
				writeNacosCatalogInstanceList(w, family)
			} else {
				writeNacosDisabledInstanceList(w, family)
			}
		case request.Method == http.MethodGet && request.URL.Path == routes.instance:
			writeNacosFamilyData(w, family, nacosAPIInstanceFixture())
		case (request.Method == http.MethodPost || request.Method == http.MethodPut || request.Method == http.MethodDelete) &&
			request.URL.Path == routes.instance:
			writeNacosMutationResult(w, family, "ok")
		case request.Method == http.MethodPut && request.URL.Path == routes.health:
			writeNacosMutationResult(w, family, "ok")
		default:
			http.NotFound(w, request)
		}
	})
}

func isNacosHistoryListRequest(family nacosAPIFamily, values url.Values) bool {
	if family == nacosAPIV1 {
		return values.Get("search") == "accurate"
	}
	return values.Get("nid") == ""
}

func isNacosBetaRequest(family nacosAPIFamily, values url.Values) bool {
	return family == nacosAPIV3 || values.Get("beta") == "true"
}

func writeNacosBeta(w http.ResponseWriter, family nacosAPIFamily) {
	data := map[string]any{
		"dataId":  "app.yaml",
		"content": "beta-content",
		"type":    "yaml",
		"md5":     ContentMD5("beta-content"),
	}
	if family == nacosAPIV3 {
		data["groupName"] = "MKEFU"
		data["namespaceId"] = "dev-id"
		data["grayRule"] = `{"type":"beta","version":"1.0.0","expr":"10.0.0.10","priority":2147483647}`
		writeNacosResult(w, family, data)
		return
	}
	data["group"] = "MKEFU"
	data["tenant"] = "dev-id"
	data["betaIps"] = "10.0.0.10"
	writeNacosJSON(w, map[string]any{
		"code": 200, "message": "success", "data": data,
	})
}

func writeNacosConfigList(w http.ResponseWriter, family nacosAPIFamily) {
	item := map[string]any{
		"id":      "10",
		"dataId":  "app.yaml",
		"content": "versioned-content",
		"type":    "yaml",
	}
	if family == nacosAPIV3 {
		item["groupName"] = "MKEFU"
		item["namespaceId"] = "dev-id"
		item["modifyTime"] = "2026-07-28T01:00:00Z"
	} else {
		item["group"] = "MKEFU"
		item["tenant"] = "dev-id"
		item["lastModifiedTime"] = "2026-07-28T01:00:00Z"
	}
	page := map[string]any{
		"totalCount":     1,
		"pageNumber":     2,
		"pagesAvailable": 2,
		"pageItems":      []any{item},
	}
	if family == nacosAPIV3 {
		writeNacosResult(w, family, page)
		return
	}
	writeNacosJSON(w, page)
}

func writeNacosConfigDetail(w http.ResponseWriter, family nacosAPIFamily) {
	switch family {
	case nacosAPIV2:
		writeNacosResult(w, family, "versioned-content")
	case nacosAPIV3:
		writeNacosResult(w, family, map[string]any{
			"dataId":      "app.yaml",
			"groupName":   "MKEFU",
			"namespaceId": "dev-id",
			"content":     "versioned-content",
			"type":        "yaml",
		})
	default:
		writeNacosJSON(w, map[string]any{
			"dataId":  "app.yaml",
			"group":   "MKEFU",
			"tenant":  "dev-id",
			"content": "versioned-content",
			"type":    "yaml",
		})
	}
}

func writeNacosHistory(w http.ResponseWriter, family nacosAPIFamily, detail bool) {
	item := map[string]any{
		"id":      "203",
		"dataId":  "app.yaml",
		"content": "old-content",
		"md5":     "old-md5",
		"opType":  "U",
	}
	if family == nacosAPIV3 {
		item["groupName"] = "MKEFU"
		item["namespaceId"] = "dev-id"
		item["modifyTime"] = "2026-07-28T00:00:00Z"
	} else {
		item["group"] = "MKEFU"
		item["tenant"] = "dev-id"
		item["lastModifiedTime"] = "2026-07-28T00:00:00Z"
	}
	data := any(item)
	if !detail {
		data = map[string]any{
			"totalCount":     1,
			"pageNumber":     1,
			"pagesAvailable": 1,
			"pageItems":      []any{item},
		}
	}
	writeNacosFamilyData(w, family, data)
}

func writeNacosServiceList(w http.ResponseWriter, family nacosAPIFamily) {
	switch family {
	case nacosAPIV1:
		writeNacosJSON(w, map[string]any{
			"count": 1,
			"serviceList": []any{
				map[string]any{"name": "orders", "groupName": "MKEFU"},
			},
		})
	case nacosAPIV2:
		writeNacosResult(w, family, map[string]any{
			"count":    1,
			"services": []string{"MKEFU@@orders"},
		})
	default:
		writeNacosResult(w, family, map[string]any{
			"totalCount":     1,
			"pageNumber":     1,
			"pagesAvailable": 1,
			"pageItems": []any{
				map[string]any{"name": "orders", "groupName": "MKEFU"},
			},
		})
	}
}

func nacosServiceGroupValue(family nacosAPIFamily, values url.Values) string {
	if family == nacosAPIV3 {
		return values.Get("groupNameParam")
	}
	return values.Get("groupName")
}

func writeNacosGroupedServiceList(w http.ResponseWriter, family nacosAPIFamily) {
	if family == nacosAPIV1 {
		writeNacosJSON(w, map[string]any{
			"count": 1,
			"doms":  []string{"orders"},
		})
		return
	}
	writeNacosServiceList(w, family)
}

func writeNacosDisabledInstanceList(w http.ResponseWriter, family nacosAPIFamily) {
	instance := nacosAPIInstanceFixture()
	instance["enabled"] = false
	writeNacosResult(w, family, []any{instance})
}

func writeNacosCatalogInstanceList(w http.ResponseWriter, family nacosAPIFamily) {
	instance := nacosAPIInstanceFixture()
	instance["enabled"] = false
	if family == nacosAPIV1 {
		writeNacosJSON(w, map[string]any{
			"count": 1,
			"list":  []any{instance},
		})
		return
	}
	writeNacosResult(w, family, map[string]any{
		"count":     1,
		"instances": []any{instance},
	})
}

func nacosAPIInstanceFixture() map[string]any {
	return map[string]any{
		"instanceId":  "instance-1",
		"ip":          "10.0.0.1",
		"port":        8080,
		"weight":      1,
		"healthy":     true,
		"enabled":     true,
		"ephemeral":   false,
		"clusterName": "DEFAULT",
		"serviceName": "MKEFU@@orders",
		"metadata":    map[string]string{"zone": "a"},
	}
}

func writeNacosFamilyData(w http.ResponseWriter, family nacosAPIFamily, data any) {
	if family == nacosAPIV1 {
		writeNacosJSON(w, data)
		return
	}
	writeNacosResult(w, family, data)
}

func writeNacosMutationResult(w http.ResponseWriter, family nacosAPIFamily, data any) {
	if family == nacosAPIV1 {
		switch value := data.(type) {
		case bool:
			_, _ = io.WriteString(w, strconv.FormatBool(value))
		case string:
			_, _ = io.WriteString(w, value)
		}
		return
	}
	writeNacosResult(w, family, data)
}

func writeNacosResult(w http.ResponseWriter, family nacosAPIFamily, data any) {
	code := 0
	if family == nacosAPIV1 {
		code = 200
	}
	writeNacosJSON(w, map[string]any{
		"code":    code,
		"message": "success",
		"data":    data,
	})
}

func writeNacosJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func connectAPIVersionTestClient(t *testing.T, server *httptest.Server) *ClientImpl {
	t.Helper()
	client := &ClientImpl{}
	if err := client.Connect(nacosAPITestConnectionConfig(t, server)); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	return client
}

func nacosAPITestConnectionConfig(t *testing.T, server *httptest.Server) connection.ConnectionConfig {
	t.Helper()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	return connection.ConnectionConfig{
		Type:             "nacos",
		Host:             parsed.Hostname(),
		Port:             port,
		Timeout:          5,
		ConnectionParams: "contextPath=/",
	}
}

func mustLastNacosAPIRequest(
	t *testing.T,
	recorder *nacosAPIRequestRecorder,
	method, path string,
) recordedNacosAPIRequest {
	t.Helper()
	request, ok := recorder.last(method, path)
	if !ok {
		t.Fatalf("request %s %s was not recorded", method, path)
	}
	return request
}

func assertNacosAPIValues(t *testing.T, values url.Values, expected map[string]string) {
	t.Helper()
	for key, want := range expected {
		if got := values.Get(key); got != want {
			t.Errorf("request parameter %s = %q, want %q; values=%#v", key, got, want, values)
		}
	}
}

func assertNacosAPIKeyPresent(t *testing.T, values url.Values, key string) {
	t.Helper()
	if _, ok := values[key]; !ok {
		t.Errorf("request parameter %s is absent; values=%#v", key, values)
	}
}

func assertNacosAPIKeysAbsent(t *testing.T, values url.Values, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if key == "" {
			continue
		}
		if _, ok := values[key]; ok {
			t.Errorf("unexpected request parameter %s; values=%#v", key, values)
		}
	}
}

func assertNacosNamingIdentity(t *testing.T, values url.Values, qualified bool) {
	t.Helper()
	wantServiceName := "orders"
	if qualified {
		wantServiceName = "MKEFU@@orders"
	}
	assertNacosAPIValues(t, values, map[string]string{
		"namespaceId": "dev-id",
		"groupName":   "MKEFU",
		"serviceName": wantServiceName,
	})
}

func otherNacosConfigGroupKey(key string) string {
	if key == "group" {
		return "groupName"
	}
	return "group"
}

func otherNacosConfigNamespaceKey(key string) string {
	if key == "tenant" {
		return "namespaceId"
	}
	return "tenant"
}
