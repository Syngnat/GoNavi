package app

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/nacos"
)

func TestNacosListNamespacesReturnsStableForbiddenCodeOnlyForForbidden(t *testing.T) {
	tests := []struct {
		name          string
		status        int
		wantErrorCode bool
	}{
		{name: "forbidden", status: http.StatusForbidden, wantErrorCode: true},
		{name: "unauthorized", status: http.StatusUnauthorized},
		{name: "server error", status: http.StatusInternalServerError},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			installNacosCacheTestHooks(t)
			newNacosClientFunc = nacos.NewClient

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch request.URL.Path {
				case "/v3/admin/core/state/readiness":
					_, _ = fmt.Fprint(w, `{"code":0,"message":"success","data":"ok"}`)
				case "/v3/admin/core/namespace/list":
					w.WriteHeader(test.status)
					_, _ = fmt.Fprintf(w, `{"code":%d,"message":"denied"}`, test.status)
				default:
					http.NotFound(w, request)
				}
			}))
			defer server.Close()

			serverURL, err := url.Parse(server.URL)
			if err != nil {
				t.Fatalf("parse server URL: %v", err)
			}
			host, portText, err := net.SplitHostPort(serverURL.Host)
			if err != nil {
				t.Fatalf("split server address: %v", err)
			}
			port, err := strconv.Atoi(portText)
			if err != nil {
				t.Fatalf("parse server port: %v", err)
			}

			result := (&App{}).NacosListNamespaces(connection.ConnectionConfig{
				Type:             "nacos",
				Host:             host,
				Port:             port,
				ConnectionParams: "contextPath=/",
				Timeout:          2,
			})
			if result.Success {
				t.Fatal("NacosListNamespaces unexpectedly succeeded")
			}
			if !strings.Contains(result.Message, strconv.Itoa(test.status)) {
				t.Fatalf("message = %q, want HTTP status %d", result.Message, test.status)
			}

			data, hasData := result.Data.(map[string]any)
			if test.wantErrorCode {
				if !hasData {
					t.Fatalf("data = %#v, want stable forbidden error code", result.Data)
				}
				if got := data["errorCode"]; got != nacosNamespaceListForbiddenErrorCode {
					t.Fatalf("errorCode = %#v, want %q", got, nacosNamespaceListForbiddenErrorCode)
				}
				return
			}
			if hasData {
				if _, exists := data["errorCode"]; exists {
					t.Fatalf("non-forbidden status exposed fallback error code: %#v", data)
				}
			} else if result.Data != nil {
				t.Fatalf("non-forbidden data = %#v, want nil", result.Data)
			}
		})
	}
}
