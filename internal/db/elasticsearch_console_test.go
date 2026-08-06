//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

package db

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/connection"
	"github.com/elastic/go-elasticsearch/v8/esapi"
)

func TestElasticsearchConsoleExecutorReturnsRawHTTPResponse(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("expected PUT request, got %s", r.Method)
		}
		if got := r.URL.RequestURI(); got != "/orders/_doc/1?refresh=true" {
			t.Fatalf("unexpected request URI: %s", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("unexpected Content-Type: %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if got := string(body); got != `{"name":"order-1"}` {
			t.Fatalf("unexpected request body: %q", got)
		}

		w.Header().Set("Content-Type", "application/json; charset=UTF-8")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"result":"created"}`))
	})

	database := newTestESDB(t, server.URL, "orders")
	var executor ElasticsearchConsoleExecutor = database
	response, err := executor.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
		Method:   http.MethodPut,
		Path:     "/orders/_doc/1?refresh=true",
		Body:     `{"name":"order-1"}`,
		BodyKind: ElasticsearchConsoleBodyKindJSON,
	})
	if err != nil {
		t.Fatalf("execute console request: %v", err)
	}
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("unexpected status code: %d", response.StatusCode)
	}
	if response.ContentType != "application/json; charset=UTF-8" {
		t.Fatalf("unexpected response content type: %q", response.ContentType)
	}
	if response.RawBody != `{"result":"created"}` {
		t.Fatalf("unexpected raw response: %q", response.RawBody)
	}
}

func TestElasticsearchConsoleExecutorReturnsStructuredHTTPErrorResponse(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"type":"parsing_exception","reason":"bad query"},"status":400}`))
	})

	database := newTestESDB(t, server.URL, "orders")
	response, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
		Method:   http.MethodPost,
		Path:     "/orders/_search",
		Body:     `{"query":{"unknown_query":{}}}`,
		BodyKind: ElasticsearchConsoleBodyKindJSON,
	})
	if err != nil {
		t.Fatalf("structured HTTP error must remain a response: %v", err)
	}
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unexpected status code: %d", response.StatusCode)
	}
	if response.RawBody != `{"error":{"type":"parsing_exception","reason":"bad query"},"status":400}` {
		t.Fatalf("unexpected raw response: %q", response.RawBody)
	}
}

func TestElasticsearchConsoleExecutorRejectsOversizedResponse(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, strings.Repeat("x", (32<<20)+1))
	})

	database := newTestESDB(t, server.URL, "orders")
	response, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
		Method:   http.MethodGet,
		Path:     "/orders/_search",
		BodyKind: ElasticsearchConsoleBodyKindNone,
	})
	if err == nil {
		t.Fatalf("expected oversized response error, got response length %d", len(response.RawBody))
	}
	if !strings.Contains(err.Error(), "32 MiB") {
		t.Fatalf("unexpected oversized response error: %v", err)
	}
}

func TestElasticsearchConsoleExecutorNormalizesNDJSONOnTheWire(t *testing.T) {
	requestBody := "{\"index\":{\"_index\":\"orders\",\"_id\":\"1\"}}\n{\"name\":\"order-1\"}"
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "application/x-ndjson" {
			t.Fatalf("unexpected Content-Type: %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if got := string(body); got != requestBody+"\n" {
			t.Fatalf("NDJSON body must end with one newline: %q", got)
		}
		writeJSON(w, map[string]interface{}{"errors": false})
	})

	database := newTestESDB(t, server.URL, "orders")
	response, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
		Method:   http.MethodPost,
		Path:     "/_bulk",
		Body:     requestBody,
		BodyKind: ElasticsearchConsoleBodyKindNDJSON,
	})
	if err != nil {
		t.Fatalf("execute NDJSON request: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status code: %d", response.StatusCode)
	}
}

func TestElasticsearchConsoleExecutorDoesNotRetryWriteRequests(t *testing.T) {
	var writeCalls atomic.Int32
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodHead && r.URL.Path == "/":
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet && r.URL.Path == "/":
			writeJSON(w, map[string]interface{}{"version": map[string]interface{}{"number": "8.19.0"}})
		case r.Method == http.MethodPut && r.URL.Path == "/orders/_doc/1":
			writeCalls.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"type":"unavailable_shards_exception"},"status":503}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	database := &ElasticsearchDB{}
	if err := database.Connect(connection.ConnectionConfig{
		Type:    "elasticsearch",
		URI:     server.URL,
		Timeout: 2,
	}); err != nil {
		t.Fatalf("connect Elasticsearch: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	response, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
		Method:   http.MethodPut,
		Path:     "/orders/_doc/1",
		Body:     `{"name":"order-1"}`,
		BodyKind: ElasticsearchConsoleBodyKindJSON,
	})
	if err != nil {
		t.Fatalf("HTTP error response should not become a transport error: %v", err)
	}
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unexpected status code: %d", response.StatusCode)
	}
	if got := writeCalls.Load(); got != 1 {
		t.Fatalf("write request must not be retried, got %d attempts", got)
	}
	database.consoleClient = nil
	_, err = database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
		Method:   http.MethodPut,
		Path:     "/orders/_doc/1",
		Body:     `{"name":"order-2"}`,
		BodyKind: ElasticsearchConsoleBodyKindJSON,
	})
	if err == nil || !strings.Contains(err.Error(), "retry-disabled") {
		t.Fatalf("missing retry-disabled transport must fail closed, got %v", err)
	}
	if got := writeCalls.Load(); got != 1 {
		t.Fatalf("fallback client sent a write request, got %d attempts", got)
	}
}

func TestElasticsearchConnectCachesServerMajorForConsoleResponses(t *testing.T) {
	for _, testCase := range []struct {
		name          string
		versionNumber string
		wantMajor     int
	}{
		{name: "Elasticsearch 6", versionNumber: "6.8.23", wantMajor: 6},
		{name: "Elasticsearch 7", versionNumber: "7.17.28", wantMajor: 7},
		{name: "Elasticsearch 8", versionNumber: "8.19.0", wantMajor: 8},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var versionProbeCalls atomic.Int32
			server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodHead && r.URL.Path == "/":
					w.WriteHeader(http.StatusOK)
				case r.Method == http.MethodGet && r.URL.Path == "/":
					versionProbeCalls.Add(1)
					writeJSON(w, map[string]interface{}{
						"version": map[string]interface{}{"number": testCase.versionNumber},
					})
				case r.Method == http.MethodGet && r.URL.Path == "/_cluster/health":
					writeJSON(w, map[string]interface{}{"status": "green"})
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})

			database := &ElasticsearchDB{}
			if err := database.Connect(connection.ConnectionConfig{
				Type:    "elasticsearch",
				URI:     server.URL,
				Timeout: 2,
			}); err != nil {
				t.Fatalf("connect Elasticsearch: %v", err)
			}
			t.Cleanup(func() { _ = database.Close() })
			var versionProvider ElasticsearchServerVersionProvider = database
			if got := versionProvider.ElasticsearchServerMajor(); got != testCase.wantMajor {
				t.Fatalf("unexpected cached server major: want %d, got %d", testCase.wantMajor, got)
			}

			response, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
				Method:   http.MethodGet,
				Path:     "/_cluster/health",
				BodyKind: ElasticsearchConsoleBodyKindNone,
			})
			if err != nil {
				t.Fatalf("execute console request: %v", err)
			}
			if response.ServerMajor != testCase.wantMajor {
				t.Fatalf("unexpected server major: want %d, got %d", testCase.wantMajor, response.ServerMajor)
			}
			if got := versionProbeCalls.Load(); got != 1 {
				t.Fatalf("expected one version probe, got %d", got)
			}
		})
	}
}

func TestElasticsearchConsoleExecutorRejectsPolicyBypass(t *testing.T) {
	var calls atomic.Int32
	server := newMockESServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(w, map[string]interface{}{"username": "elastic"})
	})
	database := newTestESDB(t, server.URL, "orders")

	_, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
		Method:   http.MethodGet,
		Path:     "/_security/_authenticate",
		BodyKind: ElasticsearchConsoleBodyKindNone,
	})
	if err == nil {
		t.Fatal("privileged endpoint must be rejected at the driver boundary")
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("blocked request reached Elasticsearch %d times", got)
	}
}

func TestElasticsearchConsoleSupportsLegacyServersWithoutProductHeader(t *testing.T) {
	for _, testCase := range []struct {
		version string
		major   int
	}{
		{version: "6.8.23", major: 6},
		{version: "7.10.2", major: 7},
	} {
		t.Run(testCase.version, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodHead && r.URL.Path == "/":
					w.WriteHeader(http.StatusOK)
				case r.Method == http.MethodGet && r.URL.Path == "/":
					writeJSON(w, map[string]interface{}{"version": map[string]interface{}{"number": testCase.version}})
				case r.Method == http.MethodGet && r.URL.Path == "/_cluster/health":
					writeJSON(w, map[string]interface{}{"status": "green"})
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			t.Cleanup(server.Close)

			database := &ElasticsearchDB{}
			if err := database.Connect(connection.ConnectionConfig{Type: "elasticsearch", URI: server.URL, Timeout: 2}); err != nil {
				t.Fatalf("connect legacy Elasticsearch: %v", err)
			}
			t.Cleanup(func() { _ = database.Close() })

			response, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{
				Method:   http.MethodGet,
				Path:     "/_cluster/health",
				BodyKind: ElasticsearchConsoleBodyKindNone,
			})
			if err != nil {
				t.Fatalf("execute legacy Elasticsearch request: %v", err)
			}
			if response.StatusCode != http.StatusOK || response.ServerMajor != testCase.major {
				t.Fatalf("unexpected legacy response: %#v", response)
			}
		})
	}
}

func TestLegacyElasticsearchQueryResponseLimits(t *testing.T) {
	_, err := readElasticsearchQueryResponseBody(strings.NewReader(strings.Repeat("x", maxElasticsearchConsoleResponseBytes+1)))
	if err == nil || !strings.Contains(err.Error(), "32 MiB") {
		t.Fatalf("oversized legacy response error = %v", err)
	}

	response := &esapi.Response{
		StatusCode: http.StatusBadRequest,
		Body:       io.NopCloser(strings.NewReader(strings.Repeat("sensitive-error-", 6000))),
	}
	_, _, err = (&ElasticsearchDB{}).parseSearchResponse(response)
	if err == nil || !strings.Contains(err.Error(), "[truncated]") {
		t.Fatalf("legacy error response was not truncated: %v", err)
	}
	if len(err.Error()) > (64<<10)+256 {
		t.Fatalf("legacy error response exceeded display limit: %d bytes", len(err.Error()))
	}
}
