package nacos

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type recordedNacosAPIRequest struct {
	method string
	path   string
	values url.Values
	header http.Header
}

type nacosAPIRequestRecorder struct {
	mu       sync.Mutex
	requests []recordedNacosAPIRequest
}

func (r *nacosAPIRequestRecorder) record(request *http.Request) {
	_ = request.ParseForm()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests = append(r.requests, recordedNacosAPIRequest{
		method: request.Method,
		path:   request.URL.Path,
		values: cloneNacosAPIValues(request.Form),
		header: request.Header.Clone(),
	})
}

func cloneNacosAPIValues(values url.Values) url.Values {
	cloned := make(url.Values, len(values))
	for key, entries := range values {
		cloned[key] = append([]string(nil), entries...)
	}
	return cloned
}

func (r *nacosAPIRequestRecorder) countPath(path string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, request := range r.requests {
		if request.path == path {
			count++
		}
	}
	return count
}

func (r *nacosAPIRequestRecorder) last(method, path string) (recordedNacosAPIRequest, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.requests) - 1; i >= 0; i-- {
		if r.requests[i].method == method && r.requests[i].path == path {
			return r.requests[i], true
		}
	}
	return recordedNacosAPIRequest{}, false
}

func TestClientAPIFamilyMatrix(t *testing.T) {
	tests := []struct {
		name                   string
		family                 nacosAPIFamily
		configListGroupKey     string
		configListNamespaceKey string
		configGroupKey         string
		configNamespaceKey     string
		serviceListGroupKey    string
		qualifiedNaming        bool
	}{
		{
			name:                   "v3 admin API",
			family:                 nacosAPIV3,
			configListGroupKey:     "groupName",
			configListNamespaceKey: "namespaceId",
			configGroupKey:         "groupName",
			configNamespaceKey:     "namespaceId",
			serviceListGroupKey:    "groupNameParam",
		},
		{
			name:                   "v2 API after v3 returns 404",
			family:                 nacosAPIV2,
			configListGroupKey:     "group",
			configListNamespaceKey: "tenant",
			configGroupKey:         "group",
			configNamespaceKey:     "namespaceId",
			serviceListGroupKey:    "groupName",
		},
		{
			name:                   "v1 API after v3 and v2 return 404",
			family:                 nacosAPIV1,
			configListGroupKey:     "group",
			configListNamespaceKey: "tenant",
			configGroupKey:         "group",
			configNamespaceKey:     "tenant",
			serviceListGroupKey:    "groupName",
			qualifiedNaming:        true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &nacosAPIRequestRecorder{}
			server := httptest.NewServer(nacosAPIMatrixHandler(test.family, recorder))
			defer server.Close()

			client := connectAPIVersionTestClient(t, server)
			defer client.Close()
			if client.apiFamily != test.family {
				t.Fatalf("detected API family = %d, want %d", client.apiFamily, test.family)
			}

			assertProbeSequenceAndCache(t, client, recorder, test.family)
			exerciseNacosAPIFamily(t, client, recorder, test)
		})
	}
}

func TestClientAPIFamilyDetectionDoesNotFallbackOnForbidden(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath:
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"code":403,"message":"no such api for this account"}`)
		case routesForNacosAPI(nacosAPIV2).namespaceList, routesForNacosAPI(nacosAPIV1).namespaceList:
			writeNacosResult(w, nacosAPIV2, []any{})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := &ClientImpl{}
	err := client.Connect(nacosAPITestConnectionConfig(t, server))
	if err == nil {
		t.Fatal("Connect unexpectedly succeeded after v3 returned 403")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("Connect error = %q, want HTTP 403", err)
	}
	if got := recorder.countPath(nacosV3ReadinessPath); got == 0 {
		t.Fatal("v3 probe was not requested")
	}
	if got := recorder.countPath(routesForNacosAPI(nacosAPIV2).namespaceList); got != 0 {
		t.Fatalf("v2 probe count = %d, want 0 after forbidden", got)
	}
	if got := recorder.countPath(routesForNacosAPI(nacosAPIV1).namespaceList); got != 0 {
		t.Fatalf("v1 probe count = %d, want 0 after forbidden", got)
	}
}

func TestClientAPIFamilyDetectionUsesV2ReadinessWithoutNamespacePermission(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath:
			http.NotFound(w, request)
		case nacosV2ReadinessPath:
			writeNacosResult(w, nacosAPIV2, "ok")
		case routesForNacosAPI(nacosAPIV2).namespaceList:
			http.Error(w, "namespace permission denied", http.StatusForbidden)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := connectAPIVersionTestClient(t, server)
	defer client.Close()
	if client.apiFamily != nacosAPIV2 {
		t.Fatalf("detected API family = %d, want v2", client.apiFamily)
	}
	if got := recorder.countPath(nacosV2ReadinessPath); got != 2 {
		t.Fatalf("v2 readiness probe count = %d, want 2 for detection and ping", got)
	}
	if got := recorder.countPath(routesForNacosAPI(nacosAPIV2).namespaceList); got != 0 {
		t.Fatalf("v2 namespace probe count = %d, want 0", got)
	}
}

func TestClientAPIFamilyDetectionUsesV1ReadinessWithoutNamespacePermission(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath, nacosV2ReadinessPath, routesForNacosAPI(nacosAPIV2).namespaceList:
			http.NotFound(w, request)
		case nacosV1ReadinessPath:
			_, _ = io.WriteString(w, "OK")
		case routesForNacosAPI(nacosAPIV1).namespaceList:
			http.Error(w, "namespace permission denied", http.StatusForbidden)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := connectAPIVersionTestClient(t, server)
	defer client.Close()
	if client.apiFamily != nacosAPIV1 {
		t.Fatalf("detected API family = %d, want v1", client.apiFamily)
	}
	if got := recorder.countPath(nacosV1ReadinessPath); got != 2 {
		t.Fatalf("v1 readiness probe count = %d, want 2 for detection and ping", got)
	}
	if got := recorder.countPath(routesForNacosAPI(nacosAPIV1).namespaceList); got != 0 {
		t.Fatalf("v1 namespace probe count = %d, want 0", got)
	}
}

func TestClientAPIFamilyDetectionKeepsNacos22NamespaceFallback(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath, nacosV2ReadinessPath:
			http.NotFound(w, request)
		case routesForNacosAPI(nacosAPIV2).namespaceList:
			writeNacosResult(w, nacosAPIV2, []any{})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := connectAPIVersionTestClient(t, server)
	defer client.Close()
	if client.apiFamily != nacosAPIV2 {
		t.Fatalf("detected API family = %d, want v2", client.apiFamily)
	}
	if got := recorder.countPath(nacosV2ReadinessPath); got != 2 {
		t.Fatalf("v2 readiness probe count = %d, want 2 for detection and ping", got)
	}
	if got := recorder.countPath(routesForNacosAPI(nacosAPIV2).namespaceList); got != 2 {
		t.Fatalf("v2 namespace probe count = %d, want 2 for detection and ping fallback", got)
	}
}

func TestValidateNacosV1ReadinessProbe(t *testing.T) {
	for _, body := range []string{"OK", " ok\r\n"} {
		if err := validateNacosV1ReadinessProbe([]byte(body)); err != nil {
			t.Fatalf("validate v1 readiness body %q: %v", body, err)
		}
	}
	for _, body := range []string{"", "<html>console</html>", `{"code":200,"data":"OK"}`} {
		if err := validateNacosV1ReadinessProbe([]byte(body)); err == nil {
			t.Fatalf("validate v1 readiness body %q unexpectedly succeeded", body)
		}
	}
}

func TestValidateNacosAPIReadinessProbe(t *testing.T) {
	for _, body := range []string{
		`{"code":0,"message":"success","data":"ok"}`,
		`{"code":200,"message":"success","data":" OK "}`,
	} {
		if err := validateNacosAPIReadinessProbe([]byte(body)); err != nil {
			t.Fatalf("validate readiness body %q: %v", body, err)
		}
	}
	for _, body := range []string{
		`{"code":0,"message":"success","data":true}`,
		`{"code":0,"message":"success","data":"ready"}`,
		`{"code":0,"message":"success","data":null}`,
		`{"code":0,"message":"success"}`,
	} {
		if err := validateNacosAPIReadinessProbe([]byte(body)); err == nil {
			t.Fatalf("validate readiness body %q unexpectedly succeeded", body)
		}
	}
}

func TestClientReadinessRejectsNonOfficialSuccessPayload(t *testing.T) {
	tests := []struct {
		name          string
		invalidOnCall int
	}{
		{name: "detection", invalidOnCall: 1},
		{name: "connect ping", invalidOnCall: 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var readinessRequests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case nacosV3ReadinessPath:
					requestNumber := int(readinessRequests.Add(1))
					data := any("ok")
					if requestNumber == test.invalidOnCall {
						data = true
					}
					writeNacosResult(w, nacosAPIV3, data)
				case routesForNacosAPI(nacosAPIV2).namespaceList:
					writeNacosResult(w, nacosAPIV2, []any{})
				default:
					http.NotFound(w, request)
				}
			}))
			defer server.Close()

			client := &ClientImpl{}
			err := client.Connect(nacosAPITestConnectionConfig(t, server))
			if err == nil {
				_ = client.Close()
				t.Fatal("Connect unexpectedly accepted non-official readiness data")
			}
			if got := int(readinessRequests.Load()); got != test.invalidOnCall {
				t.Fatalf("readiness requests = %d, want %d", got, test.invalidOnCall)
			}
		})
	}
}

func TestClientPublicReadinessOmitsAccessToken(t *testing.T) {
	const accessToken = "public-readiness-token"
	var readinessMu sync.Mutex
	var readinessTokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v3/auth/user/login":
			writeNacosJSON(w, map[string]any{"accessToken": accessToken, "tokenTtl": 3600})
		case nacosV3ReadinessPath:
			readinessMu.Lock()
			readinessTokens = append(readinessTokens, request.URL.Query().Get("accessToken"))
			readinessMu.Unlock()
			writeNacosResult(w, nacosAPIV3, "ok")
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := nacosAPITestConnectionConfig(t, server)
	config.User = "nacos"
	config.Password = "secret"
	client := &ClientImpl{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	readinessMu.Lock()
	gotReadinessTokens := append([]string(nil), readinessTokens...)
	readinessMu.Unlock()
	if len(gotReadinessTokens) != 2 {
		t.Fatalf("readiness requests = %d, want 2", len(gotReadinessTokens))
	}
	for index, token := range gotReadinessTokens {
		if token != "" {
			t.Fatalf("readiness request %d sent accessToken %q", index+1, token)
		}
	}
}

func TestClientReadinessRetriesWithTokenForAuthGatedProxy(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	var readinessMu sync.Mutex
	var readinessTokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case "/v3/auth/user/login":
			if request.Form.Get("username") != "nacos" || request.Form.Get("password") != "secret" {
				http.Error(w, "unexpected credentials", http.StatusBadRequest)
				return
			}
			writeNacosJSON(w, map[string]any{"accessToken": "v3-token", "tokenTtl": 3600})
		case "/v1/auth/users/login":
			http.Error(w, "unexpected legacy login", http.StatusInternalServerError)
		case nacosV3ReadinessPath:
			token := request.URL.Query().Get("accessToken")
			readinessMu.Lock()
			readinessTokens = append(readinessTokens, token)
			readinessMu.Unlock()
			if token != "v3-token" {
				http.Error(w, "missing token", http.StatusForbidden)
				return
			}
			writeNacosResult(w, nacosAPIV3, "ok")
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := nacosAPITestConnectionConfig(t, server)
	config.User = "nacos"
	config.Password = "secret"
	client := &ClientImpl{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	if got := recorder.countPath("/v3/auth/user/login"); got != 1 {
		t.Fatalf("v3 login count = %d, want 1", got)
	}
	if got := recorder.countPath("/v1/auth/users/login"); got != 0 {
		t.Fatalf("legacy login count = %d, want 0", got)
	}
	wantReadinessTokens := []string{"", "v3-token", "", "v3-token"}
	readinessMu.Lock()
	gotReadinessTokens := append([]string(nil), readinessTokens...)
	readinessMu.Unlock()
	if len(gotReadinessTokens) != len(wantReadinessTokens) {
		t.Fatalf("readiness tokens = %#v, want %#v", gotReadinessTokens, wantReadinessTokens)
	}
	for index := range wantReadinessTokens {
		if gotReadinessTokens[index] != wantReadinessTokens[index] {
			t.Fatalf("readiness tokens = %#v, want %#v", gotReadinessTokens, wantReadinessTokens)
		}
	}
}

func TestClientAuthDoesNotFallbackAfterV3LoginForbidden(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case "/v3/auth/user/login":
			http.Error(w, "invalid credentials", http.StatusForbidden)
		case "/v1/auth/users/login":
			writeNacosJSON(w, map[string]any{"accessToken": "legacy-token", "tokenTtl": 3600})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := nacosAPITestConnectionConfig(t, server)
	config.User = "nacos"
	config.Password = "wrong"
	client := &ClientImpl{}
	err := client.Connect(config)
	if err == nil {
		t.Fatal("Connect unexpectedly succeeded after v3 login returned 403")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("Connect error = %q, want HTTP 403", err)
	}
	if got := recorder.countPath("/v1/auth/users/login"); got != 0 {
		t.Fatalf("legacy login count = %d, want 0 after forbidden", got)
	}
}

func TestNacosV2ListServicesWithoutGroupUsesV1Catalog(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath:
			http.NotFound(w, request)
		case routesForNacosAPI(nacosAPIV2).namespaceList:
			writeNacosResult(w, nacosAPIV2, []any{})
		case routesForNacosAPI(nacosAPIV1).serviceList:
			writeNacosJSON(w, map[string]any{
				"count": 2,
				"serviceList": []any{
					map[string]any{"name": "orders", "groupName": "MKEFU"},
					map[string]any{"name": "billing", "groupName": "FINANCE"},
				},
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := connectAPIVersionTestClient(t, server)
	defer client.Close()
	page, err := client.ListServices(context.Background(), ServiceQuery{
		NamespaceID: "dev-id", PageNo: 1, PageSize: 20,
	})
	if err != nil {
		t.Fatalf("ListServices: %v", err)
	}
	want := []string{"MKEFU@@orders", "FINANCE@@billing"}
	if page.Count != 2 || len(page.ServiceNames) != len(want) {
		t.Fatalf("services = %#v", page)
	}
	for index := range want {
		if page.ServiceNames[index] != want[index] {
			t.Fatalf("serviceNames[%d] = %q, want %q", index, page.ServiceNames[index], want[index])
		}
	}
	if got := recorder.countPath(routesForNacosAPI(nacosAPIV2).serviceList); got != 0 {
		t.Fatalf("v2 single-group service list requests = %d, want 0", got)
	}
	request := mustLastNacosAPIRequest(t, recorder, http.MethodGet, routesForNacosAPI(nacosAPIV1).serviceList)
	assertNacosAPIKeyPresent(t, request.values, "groupNameParam")
	if request.values.Get("groupNameParam") != "" {
		t.Fatalf("groupNameParam = %q, want empty", request.values.Get("groupNameParam"))
	}
}

func TestNacosV3ListServicesFiltersExactGroupAcrossPages(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath:
			writeNacosResult(w, nacosAPIV3, "ok")
		case routesForNacosAPI(nacosAPIV3).serviceList:
			pageNumber, _ := strconv.Atoi(request.Form.Get("pageNo"))
			pageItems := []any{
				map[string]any{"name": "checkout", "groupName": "PAY"},
				map[string]any{"name": "billing", "groupName": "PAYMENT"},
			}
			if request.Form.Get("pageNo") == "2" {
				pageItems = []any{
					map[string]any{"name": "refund", "groupName": "PAY"},
					map[string]any{"name": "payroll", "groupName": "PAYROLL"},
				}
			}
			writeNacosResult(w, nacosAPIV3, map[string]any{
				"totalCount":     4,
				"pageNumber":     pageNumber,
				"pagesAvailable": 2,
				"pageItems":      pageItems,
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := connectAPIVersionTestClient(t, server)
	defer client.Close()
	page, err := client.ListServices(context.Background(), ServiceQuery{
		NamespaceID: "dev-id",
		GroupName:   "PAY",
		PageNo:      2,
		PageSize:    1,
	})
	if err != nil {
		t.Fatalf("ListServices: %v", err)
	}
	if page.Count != 2 || len(page.ServiceNames) != 1 || page.ServiceNames[0] != "PAY@@refund" {
		t.Fatalf("exact group page = %#v", page)
	}

	recorder.mu.Lock()
	requests := append([]recordedNacosAPIRequest(nil), recorder.requests...)
	recorder.mu.Unlock()
	serviceRequests := make([]recordedNacosAPIRequest, 0, 2)
	for _, request := range requests {
		if request.path == routesForNacosAPI(nacosAPIV3).serviceList {
			serviceRequests = append(serviceRequests, request)
		}
	}
	if len(serviceRequests) != 2 {
		t.Fatalf("service list requests = %d, want 2", len(serviceRequests))
	}
	for index, request := range serviceRequests {
		assertNacosAPIValues(t, request.values, map[string]string{
			"namespaceId":    "dev-id",
			"groupNameParam": "PAY",
			"pageNo":         strconv.Itoa(index + 1),
			"pageSize":       strconv.Itoa(maxServicePageSize),
		})
	}
}

func TestNacosV3ListServicesEscapesExactGroupPattern(t *testing.T) {
	const targetGroup = "PAY[1]"

	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath:
			writeNacosResult(w, nacosAPIV3, "ok")
		case routesForNacosAPI(nacosAPIV3).serviceList:
			groupPattern, err := regexp.Compile(request.Form.Get("groupNameParam"))
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			candidates := []nacosServiceItem{
				{Name: "literal", GroupName: targetGroup},
				{Name: "regex-lookalike", GroupName: "PAY1"},
				{Name: "prefix", GroupName: targetGroup + "-ARCHIVE"},
			}
			pageItems := make([]nacosServiceItem, 0, len(candidates))
			for _, candidate := range candidates {
				if groupPattern.MatchString(candidate.GroupName) {
					pageItems = append(pageItems, candidate)
				}
			}
			writeNacosResult(w, nacosAPIV3, map[string]any{
				"totalCount":     len(pageItems),
				"pageNumber":     1,
				"pagesAvailable": 1,
				"pageItems":      pageItems,
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := connectAPIVersionTestClient(t, server)
	defer client.Close()
	page, err := client.ListServices(context.Background(), ServiceQuery{
		NamespaceID: "dev-id",
		GroupName:   targetGroup,
		PageNo:      1,
		PageSize:    20,
	})
	if err != nil {
		t.Fatalf("ListServices: %v", err)
	}
	if page.Count != 1 || len(page.ServiceNames) != 1 || page.ServiceNames[0] != targetGroup+"@@literal" {
		t.Fatalf("exact group page = %#v", page)
	}

	request := mustLastNacosAPIRequest(t, recorder, http.MethodGet, routesForNacosAPI(nacosAPIV3).serviceList)
	if got, want := request.values.Get("groupNameParam"), regexp.QuoteMeta(targetGroup); got != want {
		t.Fatalf("groupNameParam = %q, want %q", got, want)
	}
}

func TestCreateEphemeralServiceAPIVersionBoundary(t *testing.T) {
	tests := []struct {
		name   string
		family nacosAPIFamily
	}{
		{name: "v1 rejects before request", family: nacosAPIV1},
		{name: "v2 forwards ephemeral", family: nacosAPIV2},
		{name: "v3 forwards ephemeral", family: nacosAPIV3},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &nacosAPIRequestRecorder{}
			server := httptest.NewServer(nacosAPIMatrixHandler(test.family, recorder))
			defer server.Close()

			client := connectAPIVersionTestClient(t, server)
			defer client.Close()
			ephemeral := true
			err := client.CreateService(context.Background(), CreateServiceRequest{
				NamespaceID: "dev-id",
				ServiceName: "orders",
				GroupName:   "MKEFU",
				Ephemeral:   &ephemeral,
			})
			routes := routesForNacosAPI(test.family)
			if test.family == nacosAPIV1 {
				if err == nil {
					t.Fatal("expected v1 ephemeral service creation to fail")
				}
				if !strings.Contains(err.Error(), "Nacos v1") {
					t.Fatalf("CreateService error = %q, want explicit Nacos v1 boundary", err)
				}
				if _, ok := recorder.last(http.MethodPost, routes.service); ok {
					t.Fatal("v1 ephemeral service creation sent an HTTP request")
				}
				return
			}
			if err != nil {
				t.Fatalf("CreateService: %v", err)
			}
			request := mustLastNacosAPIRequest(t, recorder, http.MethodPost, routes.service)
			assertNacosAPIValues(t, request.values, map[string]string{"ephemeral": "true"})
		})
	}
}

func TestNacosV2GetConfigPreservesJSONContent(t *testing.T) {
	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath:
			http.NotFound(w, request)
		case routesForNacosAPI(nacosAPIV2).namespaceList:
			writeNacosResult(w, nacosAPIV2, []any{})
		case routesForNacosAPI(nacosAPIV2).config:
			writeNacosResult(w, nacosAPIV2, `{"dataId":"inside-document","content":"literal-value"}`)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	client := connectAPIVersionTestClient(t, server)
	defer client.Close()
	detail, err := client.GetConfig(context.Background(), "dev-id", "MKEFU", "app.json")
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	want := `{"dataId":"inside-document","content":"literal-value"}`
	if detail.Content != want || detail.DataID != "app.json" {
		t.Fatalf("config detail = %#v, want content %q for app.json", detail, want)
	}
}

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
