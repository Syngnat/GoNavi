package nacos

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

type closeIdleTrackingTransport struct {
	closed bool
}

type roundTripFunc func(*http.Request) (*http.Response, error)

type fakeNacosForwarderLease struct {
	address  string
	releases atomic.Int32
}

func (f *fakeNacosForwarderLease) LocalAddress() string {
	return f.address
}

func (f *fakeNacosForwarderLease) Release() error {
	f.releases.Add(1)
	return nil
}

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func (t *closeIdleTrackingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	panic("unexpected request")
}

func (t *closeIdleTrackingTransport) CloseIdleConnections() {
	t.closed = true
}

func TestNormalizeNamespaceID(t *testing.T) {
	t.Parallel()
	if got := normalizeNamespaceID("public"); got != "" {
		t.Fatalf("public should map to empty tenant, got %q", got)
	}
	if got := normalizeNamespaceID("  dev  "); got != "dev" {
		t.Fatalf("unexpected namespace id: %q", got)
	}
}

func TestResolveNacosContextPath(t *testing.T) {
	t.Parallel()
	if got := resolveNacosContextPath(connection.ConnectionConfig{}); got != "/nacos" {
		t.Fatalf("default context path = %q", got)
	}
	if got := resolveNacosContextPath(connection.ConnectionConfig{
		ConnectionParams: "contextPath=/custom-nacos",
	}); got != "/custom-nacos" {
		t.Fatalf("custom context path = %q", got)
	}
}

func TestClientCloseClosesIdleHTTPConnections(t *testing.T) {
	transport := &closeIdleTrackingTransport{}
	client := &ClientImpl{
		config: connection.ConnectionConfig{
			User:     "nacos-user",
			Password: "nacos-password",
			SSH: connection.SSHConfig{
				User:     "ssh-user",
				Password: "ssh-password",
			},
			Proxy: connection.ProxyConfig{
				User:     "proxy-user",
				Password: "proxy-password",
			},
		},
		httpClient: &http.Client{Transport: transport},
	}

	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !transport.closed {
		t.Fatal("Close did not release idle HTTP connections")
	}
	if !reflect.DeepEqual(client.config, connection.ConnectionConfig{}) {
		t.Fatalf("Close retained connection config: %#v", client.config)
	}
}

func TestClientSSHForwarderUsesRemoteTargetAndHostForRequests(t *testing.T) {
	const (
		remoteHost      = "nacos.internal.test"
		remotePort      = 8848
		remoteAuthority = "nacos.internal.test:8848"
	)
	var (
		ordinaryRequests atomic.Int32
		listenRequests   atomic.Int32
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Host != remoteAuthority {
			t.Errorf("request Host = %q, want %q", request.Host, remoteAuthority)
		}
		switch {
		case strings.HasSuffix(request.URL.Path, nacosV3ReadinessPath),
			strings.HasSuffix(request.URL.Path, "/v2/console/namespace/list"):
			http.NotFound(w, request)
		case strings.HasSuffix(request.URL.Path, "/v1/console/namespaces"):
			ordinaryRequests.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 200,
				"data": []any{},
			})
		case strings.HasSuffix(request.URL.Path, "/v1/cs/configs/listener"):
			listenRequests.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	lease := &fakeNacosForwarderLease{address: server.Listener.Addr().String()}
	var (
		acquiredHost string
		acquiredPort int
		acquiredSSH  connection.SSHConfig
	)
	client := &ClientImpl{
		acquireSSHForwarder: func(
			sshConfig connection.SSHConfig,
			host string,
			port int,
		) (nacosForwarderLease, error) {
			acquiredSSH = sshConfig
			acquiredHost = host
			acquiredPort = port
			return lease, nil
		},
	}
	sshConfig := connection.SSHConfig{
		Host:     "jump.internal.test",
		Port:     22,
		User:     "nacos-user",
		Password: "secret",
	}
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             remoteHost,
		Port:             remotePort,
		UseSSH:           true,
		SSH:              sshConfig,
		Timeout:          2,
		ConnectionParams: "contextPath=/",
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if acquiredHost != remoteHost || acquiredPort != remotePort {
		t.Fatalf("SSH target = %s:%d, want %s:%d", acquiredHost, acquiredPort, remoteHost, remotePort)
	}
	if acquiredSSH != sshConfig {
		t.Fatalf("SSH config = %#v, want %#v", acquiredSSH, sshConfig)
	}

	if _, err := client.ListenOnce(context.Background(), []ConfigListenTarget{{
		DataID:     "application.yaml",
		Group:      "DEFAULT_GROUP",
		ContentMD5: ContentMD5(""),
	}}, minListenTimeoutMs); err != nil {
		t.Fatalf("ListenOnce: %v", err)
	}
	if ordinaryRequests.Load() < 2 {
		t.Fatalf("ordinary Nacos requests = %d, want at least 2", ordinaryRequests.Load())
	}
	if listenRequests.Load() != 1 {
		t.Fatalf("listener requests = %d, want 1", listenRequests.Load())
	}

	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if got := lease.releases.Load(); got != 1 {
		t.Fatalf("forwarder Release calls = %d, want exactly 1", got)
	}
}

func TestClientSSHForwarderPreservesRemoteTLSServerName(t *testing.T) {
	const (
		remoteHost      = "secure-nacos.internal.test"
		remotePort      = 8848
		remoteAuthority = "secure-nacos.internal.test:8848"
	)
	sniValues := make(chan string, 4)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Host != remoteAuthority {
			t.Errorf("request Host = %q, want %q", request.Host, remoteAuthority)
		}
		switch {
		case strings.HasSuffix(request.URL.Path, nacosV3ReadinessPath),
			strings.HasSuffix(request.URL.Path, "/v2/console/namespace/list"):
			http.NotFound(w, request)
		case strings.HasSuffix(request.URL.Path, "/v1/console/namespaces"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 200,
				"data": []any{},
			})
		default:
			http.NotFound(w, request)
		}
	}))
	server.TLS = &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			select {
			case sniValues <- hello.ServerName:
			default:
			}
			return nil, nil
		},
	}
	server.StartTLS()
	defer server.Close()

	lease := &fakeNacosForwarderLease{address: server.Listener.Addr().String()}
	client := &ClientImpl{
		acquireSSHForwarder: func(
			connection.SSHConfig,
			string,
			int,
		) (nacosForwarderLease, error) {
			return lease, nil
		},
	}
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             remoteHost,
		Port:             remotePort,
		UseSSL:           true,
		SSLMode:          "skip-verify",
		UseSSH:           true,
		Timeout:          2,
		ConnectionParams: "contextPath=/",
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	select {
	case got := <-sniValues:
		if got != remoteHost {
			t.Fatalf("TLS ServerName = %q, want %q", got, remoteHost)
		}
	default:
		t.Fatal("TLS handshake did not report a ServerName")
	}
}

func TestClientProxyPreservesRemoteAuthorityAndTLSServerName(t *testing.T) {
	const (
		remoteHost      = "secure-nacos.internal.test"
		remotePort      = 8848
		remoteAuthority = "secure-nacos.internal.test:8848"
	)
	sniValues := make(chan string, 8)
	hostValues := make(chan string, 16)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		select {
		case hostValues <- request.Host:
		default:
		}
		switch {
		case strings.HasSuffix(request.URL.Path, nacosV3ReadinessPath),
			strings.HasSuffix(request.URL.Path, "/v2/console/namespace/list"):
			http.NotFound(w, request)
		case strings.HasSuffix(request.URL.Path, "/v1/console/namespaces"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 200,
				"data": []any{},
			})
		default:
			http.NotFound(w, request)
		}
	}))
	server.TLS = &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			select {
			case sniValues <- hello.ServerName:
			default:
			}
			return nil, nil
		},
	}
	server.StartTLS()
	defer server.Close()

	originalDialNacosProxyContext := dialNacosProxyContext
	t.Cleanup(func() {
		dialNacosProxyContext = originalDialNacosProxyContext
	})

	for _, proxyType := range []string{"http", "socks5"} {
		t.Run(proxyType, func(t *testing.T) {
			dialTargets := make(chan string, 4)
			dialProxyTypes := make(chan string, 4)
			dialNacosProxyContext = func(
				ctx context.Context,
				proxyConfig connection.ProxyConfig,
				network string,
				address string,
			) (net.Conn, error) {
				select {
				case dialTargets <- address:
				default:
				}
				select {
				case dialProxyTypes <- proxyConfig.Type:
				default:
				}
				var dialer net.Dialer
				return dialer.DialContext(ctx, network, server.Listener.Addr().String())
			}

			client := &ClientImpl{}
			if err := client.Connect(connection.ConnectionConfig{
				Type:             "nacos",
				Host:             remoteHost,
				Port:             remotePort,
				UseSSL:           true,
				SSLMode:          "skip-verify",
				UseProxy:         true,
				Proxy:            connection.ProxyConfig{Type: proxyType, Host: "proxy.invalid", Port: 1080},
				Timeout:          2,
				ConnectionParams: "contextPath=/",
			}); err != nil {
				t.Fatalf("Connect through %s proxy: %v", proxyType, err)
			}
			defer client.Close()

			select {
			case got := <-dialTargets:
				if got != remoteAuthority {
					t.Fatalf("proxy dial target = %q, want %q", got, remoteAuthority)
				}
			default:
				t.Fatal("proxy dial hook was not called")
			}
			select {
			case got := <-dialProxyTypes:
				if got != proxyType {
					t.Fatalf("proxy dial type = %q, want %q", got, proxyType)
				}
			default:
				t.Fatal("proxy dial hook did not receive proxy config")
			}
			select {
			case got := <-sniValues:
				if got != remoteHost {
					t.Fatalf("TLS ServerName = %q, want %q", got, remoteHost)
				}
			default:
				t.Fatal("TLS handshake did not report a ServerName")
			}
			select {
			case got := <-hostValues:
				if got != remoteAuthority {
					t.Fatalf("request Host = %q, want %q", got, remoteAuthority)
				}
			default:
				t.Fatal("server did not receive a request")
			}
		})
	}
}

func TestClientSSHForwarderReleasedWhenConnectFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "probe failed", http.StatusInternalServerError)
	}))
	defer server.Close()

	lease := &fakeNacosForwarderLease{address: server.Listener.Addr().String()}
	client := &ClientImpl{
		acquireSSHForwarder: func(
			connection.SSHConfig,
			string,
			int,
		) (nacosForwarderLease, error) {
			return lease, nil
		},
	}
	err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             "nacos.internal.test",
		Port:             8848,
		UseSSH:           true,
		Timeout:          2,
		ConnectionParams: "contextPath=/",
	})
	if err == nil {
		t.Fatal("expected Connect to fail")
	}
	if got := lease.releases.Load(); got != 1 {
		t.Fatalf("forwarder Release calls after failed Connect = %d, want exactly 1", got)
	}
	if closeErr := client.Close(); closeErr != nil {
		t.Fatalf("Close after failed Connect: %v", closeErr)
	}
	if got := lease.releases.Load(); got != 1 {
		t.Fatalf("forwarder Release calls after failed Connect cleanup = %d, want exactly 1", got)
	}
}

func TestClientSSHForwarderRejectsNilLease(t *testing.T) {
	client := &ClientImpl{
		acquireSSHForwarder: func(
			connection.SSHConfig,
			string,
			int,
		) (nacosForwarderLease, error) {
			return nil, nil
		},
	}
	err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             "nacos.internal.test",
		Port:             8848,
		UseSSH:           true,
		ConnectionParams: "contextPath=/",
	})
	if err == nil {
		t.Fatal("expected nil SSH forwarder lease to be rejected")
	}
}

func TestNacosHTTPClientReliesOnRequestContextDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}))
	defer server.Close()

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	httpClient, baseURL, err := buildNacosHTTPClient(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             parsed.Hostname(),
		Port:             port,
		Timeout:          1,
		ConnectionParams: "contextPath=/",
	})
	if err != nil {
		t.Fatalf("buildNacosHTTPClient: %v", err)
	}
	if httpClient.Timeout != 0 {
		t.Fatalf("http client timeout = %s, want 0", httpClient.Timeout)
	}

	client := &ClientImpl{
		httpClient: httpClient,
		baseURL:    baseURL,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, _, err = client.doRequestRaw(ctx, http.MethodGet, "/slow", nil, nil, false)
	if err == nil {
		t.Fatal("expected context deadline error")
	}
	if !strings.Contains(err.Error(), context.DeadlineExceeded.Error()) {
		t.Fatalf("request error = %q, want context deadline exceeded", err)
	}
}

func TestNacosRequestErrorRedactsAccessToken(t *testing.T) {
	const accessToken = "request-error-secret+/= token"
	baseURL, err := url.Parse("http://nacos.example.test/nacos")
	if err != nil {
		t.Fatal(err)
	}
	client := &ClientImpl{
		httpClient: &http.Client{
			Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New("dial failed")
			}),
		},
		baseURL:     baseURL,
		accessToken: accessToken,
	}

	_, _, err = client.doRequestRaw(context.Background(), http.MethodGet, "/v1/console/namespaces", nil, nil, true)
	if err == nil {
		t.Fatal("expected request failure")
	}
	if strings.Contains(err.Error(), accessToken) {
		t.Fatalf("request error exposed access token: %q", err)
	}
	if strings.Contains(err.Error(), url.QueryEscape(accessToken)) {
		t.Fatalf("request error exposed encoded access token: %q", err)
	}
}

func TestClientConfigFlow(t *testing.T) {
	var (
		gotLoginUser string
		gotPublish   url.Values
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v3/auth/user/login"):
			http.NotFound(w, r)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/auth/users/login"):
			_ = r.ParseForm()
			gotLoginUser = r.URL.Query().Get("username")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accessToken": "token-1",
				"tokenTtl":    3600,
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			if r.URL.Query().Get("accessToken") != "token-1" {
				http.Error(w, "missing token", http.StatusForbidden)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 200,
				"data": []map[string]any{
					{"namespace": "", "namespaceShowName": "public", "configCount": 2},
					{"namespace": "dev-id", "namespaceShowName": "dev", "configCount": 1},
				},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/cs/configs"):
			if r.URL.Query().Get("search") != "" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"totalCount":     1,
					"pageNumber":     1,
					"pagesAvailable": 1,
					"pageItems": []map[string]any{
						{
							"dataId": "app.yaml",
							"group":  "DEFAULT_GROUP",
							"type":   "yaml",
							"md5":    "abc",
							"tenant": "dev-id",
						},
					},
				})
				return
			}
			if r.URL.Query().Get("dataId") == "app.yaml" {
				_, _ = io.WriteString(w, "server:\n  port: 8080\n")
				return
			}
			http.NotFound(w, r)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/cs/configs"):
			_ = r.ParseForm()
			gotPublish = r.Form
			_, _ = io.WriteString(w, "true")
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/v1/cs/configs"):
			_, _ = io.WriteString(w, "true")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	host := u.Hostname()
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}

	client := NewClient()
	cfg := connection.ConnectionConfig{
		Type:             "nacos",
		Host:             host,
		Port:             port,
		User:             "nacos",
		Password:         "nacos",
		Timeout:          5,
		ConnectionParams: "contextPath=/",
	}
	if err := client.Connect(cfg); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	if gotLoginUser != "nacos" {
		t.Fatalf("login user = %q", gotLoginUser)
	}

	ctx := context.Background()
	namespaces, err := client.ListNamespaces(ctx)
	if err != nil {
		t.Fatalf("ListNamespaces: %v", err)
	}
	if len(namespaces) != 2 {
		t.Fatalf("namespaces len = %d", len(namespaces))
	}
	if namespaces[0].ShowName != "public" || namespaces[0].ID != "" {
		t.Fatalf("public namespace = %#v", namespaces[0])
	}

	page, err := client.SearchConfigs(ctx, ConfigQuery{
		NamespaceID: "dev-id",
		DataID:      "app",
		PageNo:      1,
		PageSize:    10,
	})
	if err != nil {
		t.Fatalf("SearchConfigs: %v", err)
	}
	if page.TotalCount != 1 || len(page.PageItems) != 1 || page.PageItems[0].DataID != "app.yaml" {
		t.Fatalf("unexpected page: %#v", page)
	}

	detail, err := client.GetConfig(ctx, "dev-id", "DEFAULT_GROUP", "app.yaml")
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if !strings.Contains(detail.Content, "port: 8080") {
		t.Fatalf("content = %q", detail.Content)
	}

	if err := client.PublishConfig(ctx, PublishRequest{
		NamespaceID: "dev-id",
		DataID:      "app.yaml",
		Group:       "DEFAULT_GROUP",
		Content:     "server:\n  port: 9090\n",
		Type:        "yaml",
	}); err != nil {
		t.Fatalf("PublishConfig: %v", err)
	}
	if gotPublish.Get("dataId") != "app.yaml" || gotPublish.Get("tenant") != "dev-id" {
		t.Fatalf("publish form = %#v", gotPublish)
	}

	if err := client.DeleteConfig(ctx, "dev-id", "DEFAULT_GROUP", "app.yaml"); err != nil {
		t.Fatalf("DeleteConfig: %v", err)
	}
}

func TestClientNamespaceAndHistory(t *testing.T) {
	var (
		createdForm url.Values
		updatedForm url.Values
		deletedForm url.Values
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 200,
				"data": []map[string]any{
					{"namespace": "", "namespaceShowName": "public"},
				},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			_ = r.ParseForm()
			createdForm = r.Form
			_, _ = io.WriteString(w, "true")
		case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			_ = r.ParseForm()
			updatedForm = r.Form
			_, _ = io.WriteString(w, "true")
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			deletedForm = r.URL.Query()
			_, _ = io.WriteString(w, "true")
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/cs/history"):
			if r.URL.Query().Get("search") == "accurate" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"totalCount":     1,
					"pageNumber":     1,
					"pagesAvailable": 1,
					"pageItems": []map[string]any{
						{
							"id":               "203",
							"dataId":           "app.yaml",
							"group":            "DEFAULT_GROUP",
							"tenant":           "dev-id",
							"opType":           "U",
							"lastModifiedTime": "2026-07-28T01:00:00.000+0000",
						},
					},
				})
				return
			}
			if r.URL.Query().Get("nid") == "203" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"id":      "203",
					"dataId":  "app.yaml",
					"group":   "DEFAULT_GROUP",
					"tenant":  "dev-id",
					"content": "old-content",
					"md5":     "md5-old",
				})
				return
			}
			http.NotFound(w, r)
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
	if err := client.CreateNamespace(ctx, CreateNamespaceRequest{
		ID:          "dev-id",
		ShowName:    "dev",
		Description: "development",
	}); err != nil {
		t.Fatalf("CreateNamespace: %v", err)
	}
	if createdForm.Get("customNamespaceId") != "dev-id" || createdForm.Get("namespaceName") != "dev" {
		t.Fatalf("create form = %#v", createdForm)
	}

	if err := client.UpdateNamespace(ctx, UpdateNamespaceRequest{
		ID:          "dev-id",
		ShowName:    "dev2",
		Description: "updated",
	}); err != nil {
		t.Fatalf("UpdateNamespace: %v", err)
	}
	if updatedForm.Get("namespace") != "dev-id" || updatedForm.Get("namespaceShowName") != "dev2" {
		t.Fatalf("update form = %#v", updatedForm)
	}

	if err := client.DeleteNamespace(ctx, "public"); err == nil {
		t.Fatal("expected public delete to fail")
	}
	if err := client.DeleteNamespace(ctx, "dev-id"); err != nil {
		t.Fatalf("DeleteNamespace: %v", err)
	}
	if deletedForm.Get("namespaceId") != "dev-id" {
		t.Fatalf("delete form = %#v", deletedForm)
	}

	page, err := client.ListConfigHistory(ctx, HistoryQuery{
		NamespaceID: "dev-id",
		DataID:      "app.yaml",
		Group:       "DEFAULT_GROUP",
	})
	if err != nil {
		t.Fatalf("ListConfigHistory: %v", err)
	}
	if page.TotalCount != 1 || len(page.PageItems) != 1 || page.PageItems[0].ID != "203" {
		t.Fatalf("history page = %#v", page)
	}

	detail, err := client.GetConfigHistory(ctx, "dev-id", "DEFAULT_GROUP", "app.yaml", "203")
	if err != nil {
		t.Fatalf("GetConfigHistory: %v", err)
	}
	if detail.Content != "old-content" {
		t.Fatalf("history detail = %#v", detail)
	}
}
