package nacos

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
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

func TestNacosV3ListServicesFiltersExactGroupWithoutRegex(t *testing.T) {
	const targetGroup = "PAY[1]"

	recorder := &nacosAPIRequestRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		switch request.URL.Path {
		case nacosV3ReadinessPath:
			writeNacosResult(w, nacosAPIV3, "ok")
		case routesForNacosAPI(nacosAPIV3).serviceList:
			candidates := []nacosServiceItem{
				{Name: "literal", GroupName: targetGroup},
				{Name: "regex-lookalike", GroupName: "PAY1"},
				{Name: "prefix", GroupName: targetGroup + "-ARCHIVE"},
			}
			pageItems := make([]nacosServiceItem, 0, len(candidates))
			for _, candidate := range candidates {
				pageItems = append(pageItems, candidate)
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
	if got, want := request.values.Get("groupNameParam"), targetGroup; got != want {
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
