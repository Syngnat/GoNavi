package db

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestRabbitMQConnectRejectsAMQPPortsBeforeDial(t *testing.T) {
	originalTransport := http.DefaultTransport
	dialAttempts := 0
	http.DefaultTransport = &http.Transport{
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			dialAttempts++
			return nil, errors.New("unexpected network dial")
		},
	}
	t.Cleanup(func() {
		http.DefaultTransport = originalTransport
	})

	testCases := []struct {
		name               string
		port               int
		useSSL             bool
		uri                string
		wantProtocol       string
		wantManagementPort string
	}{
		{name: "AMQP", port: 5672, wantProtocol: "AMQP", wantManagementPort: "15672"},
		{name: "AMQPS", port: 5671, useSSL: true, wantProtocol: "AMQPS", wantManagementPort: "15671"},
		{name: "rabbitmq URI", port: 5672, uri: "rabbitmq://rabbitmq.local:5672/%2F", wantProtocol: "AMQP", wantManagementPort: "15672"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			client := &RabbitMQDB{}
			err := client.Connect(connection.ConnectionConfig{
				Type:   "rabbitmq",
				Host:   "rabbitmq.local",
				Port:   testCase.port,
				UseSSL: testCase.useSSL,
				URI:    testCase.uri,
			})
			if err == nil {
				t.Fatal("expected RabbitMQ AMQP port validation error")
			}
			for _, want := range []string{"Management API", testCase.wantProtocol, testCase.wantManagementPort} {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("expected error to contain %q, got %q", want, err)
				}
			}
		})
	}

	if dialAttempts != 0 {
		t.Fatalf("RabbitMQ AMQP port validation must fail before network dial, attempts=%d", dialAttempts)
	}
}

func TestValidateRabbitMQManagementPortAllowsExplicitHTTPURI(t *testing.T) {
	testCases := []struct {
		name string
		port int
		uri  string
	}{
		{name: "HTTP on AMQP default port", port: 5672, uri: "http://rabbitmq.local:5672"},
		{name: "HTTPS on AMQPS default port", port: 5671, uri: "https://rabbitmq.local:5671"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if err := validateRabbitMQManagementPort(testCase.port, testCase.uri); err != nil {
				t.Fatalf("explicit Management API URI should allow custom port: %v", err)
			}
		})
	}
}

func TestNormalizeRabbitMQConfigParsesURIAndParams(t *testing.T) {
	config := normalizeRabbitMQConfig(connection.ConnectionConfig{
		URI:              "rabbitmq://guest:secret@127.0.0.1:15672/%2F?tls=true&skip_verify=true",
		ConnectionParams: "defaultQueue=orders.events&exchange=events.topic&pageSize=500",
	})

	if config.Host != "127.0.0.1" || config.Port != 15672 {
		t.Fatalf("unexpected rabbitmq host/port: %#v", config)
	}
	if config.User != "guest" || config.Password != "secret" {
		t.Fatalf("unexpected rabbitmq credentials: %#v", config)
	}
	if config.Database != "/" {
		t.Fatalf("expected default vhost '/', got %q", config.Database)
	}
	if !config.UseSSL || config.SSLMode != "skip-verify" {
		t.Fatalf("unexpected rabbitmq tls settings: %#v", config)
	}

	params := rabbitmqConnectionParams(config)
	if params.Get("defaultQueue") != "orders.events" || params.Get("exchange") != "events.topic" {
		t.Fatalf("unexpected rabbitmq params: %#v", params)
	}
}

func TestRabbitMQQueryExecAndColumns(t *testing.T) {
	var lastGetCount int
	var lastPublishBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		escapedPath := req.URL.EscapedPath()
		switch {
		case req.Method == http.MethodGet && escapedPath == "/api/vhosts":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"items":      []map[string]interface{}{{"name": "/", "tracing": false}},
				"page":       1,
				"page_count": 1,
			})
		case req.Method == http.MethodGet && escapedPath == "/api/queues/%2F":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"items": []map[string]interface{}{
					{
						"vhost":                   "/",
						"name":                    "orders.events.v1",
						"durable":                 true,
						"messages":                8,
						"messages_ready":          5,
						"messages_unacknowledged": 3,
						"consumers":               2,
					},
				},
				"page":       1,
				"page_count": 1,
			})
		case req.Method == http.MethodGet && escapedPath == "/api/queues/%2F/orders.events.v1":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"vhost":                   "/",
				"name":                    "orders.events.v1",
				"durable":                 true,
				"messages":                8,
				"messages_ready":          5,
				"messages_unacknowledged": 3,
				"consumers":               2,
				"node":                    "rabbit@node1",
			})
		case req.Method == http.MethodGet && escapedPath == "/api/exchanges/%2F":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"items": []map[string]interface{}{
					{
						"vhost":    "/",
						"name":     "events.topic",
						"type":     "topic",
						"durable":  true,
						"internal": false,
					},
				},
				"page":       1,
				"page_count": 1,
			})
		case req.Method == http.MethodPost && escapedPath == "/api/queues/%2F/orders.events.v1/get":
			var body map[string]interface{}
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				t.Fatalf("decode get body failed: %v", err)
			}
			lastGetCount = intFromAny(body["count"], 0)
			_ = json.NewEncoder(w).Encode([]map[string]interface{}{
				{
					"exchange":         "events.topic",
					"routing_key":      "orders.events.v1",
					"payload":          `{"event":"created","meta":{"ip":"127.0.0.1"}}`,
					"payload_bytes":    46,
					"payload_encoding": "string",
					"redelivered":      false,
					"message_count":    7,
					"properties": map[string]interface{}{
						"content_type": "application/json",
						"headers": map[string]interface{}{
							"x-env": "dev",
						},
					},
				},
				{
					"exchange":         "events.topic",
					"routing_key":      "orders.events.v1",
					"payload":          "plain-text",
					"payload_bytes":    10,
					"payload_encoding": "string",
					"redelivered":      true,
					"message_count":    6,
					"properties": map[string]interface{}{
						"headers": map[string]interface{}{
							"x-env": "qa",
						},
					},
				},
			})
		case req.Method == http.MethodPut && escapedPath == "/api/exchanges/%2F/events.topic/publish":
			if err := json.NewDecoder(req.Body).Decode(&lastPublishBody); err != nil {
				t.Fatalf("decode publish body failed: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"routed": true})
		default:
			t.Fatalf("unexpected rabbitmq request: %s %s?%s", req.Method, escapedPath, req.URL.RawQuery)
		}
	}))
	defer server.Close()

	client := &RabbitMQDB{
		client:          server.Client(),
		baseURL:         server.URL,
		defaultVHost:    "/",
		defaultQueue:    "orders.events.v1",
		defaultExchange: "events.topic",
		pageSize:        50,
	}

	rows, columns, err := client.Query(`SHOW VHOSTS LIMIT 1`)
	if err != nil {
		t.Fatalf("SHOW VHOSTS failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["vhost"] != "/" {
		t.Fatalf("unexpected vhost rows: %#v", rows)
	}
	if !containsString(columns, "tracing") {
		t.Fatalf("expected tracing column, got %v", columns)
	}

	rows, columns, err = client.Query(`SHOW QUEUES LIMIT 1`)
	if err != nil {
		t.Fatalf("SHOW QUEUES failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["queue"] != "orders.events.v1" {
		t.Fatalf("unexpected queue rows: %#v", rows)
	}
	if !containsString(columns, "messages_ready") {
		t.Fatalf("expected messages_ready column, got %v", columns)
	}

	rows, _, err = client.Query(`DESCRIBE QUEUE "orders.events.v1"`)
	if err != nil {
		t.Fatalf("DESCRIBE QUEUE failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["node"] != "rabbit@node1" {
		t.Fatalf("unexpected describe queue rows: %#v", rows)
	}

	rows, columns, err = client.Query(`SHOW EXCHANGES LIMIT 1`)
	if err != nil {
		t.Fatalf("SHOW EXCHANGES failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["exchange"] != "events.topic" {
		t.Fatalf("unexpected exchange rows: %#v", rows)
	}
	if !containsString(columns, "type") {
		t.Fatalf("expected exchange type column, got %v", columns)
	}

	rows, columns, err = client.Query(`SELECT * FROM "orders.events.v1" LIMIT 1 OFFSET 1`)
	if err != nil {
		t.Fatalf("SELECT queue failed: %v", err)
	}
	if lastGetCount != 2 {
		t.Fatalf("expected fetch count 2 for offset emulation, got %d", lastGetCount)
	}
	if len(rows) != 1 || rows[0]["payload"] != "plain-text" || rows[0]["headers.x-env"] != "qa" {
		t.Fatalf("unexpected rabbitmq message rows: %#v", rows)
	}
	if !containsString(columns, "headers.x-env") {
		t.Fatalf("expected derived header column, got %v", columns)
	}

	affected, err := client.Exec(`{"queue":"orders.events.v1","exchange":"events.topic","routing_key":"orders.events.v1","payload":{"id":1},"headers":{"x-env":"dev"}}`)
	if err != nil {
		t.Fatalf("rabbitmq publish failed: %v", err)
	}
	if affected != 1 {
		t.Fatalf("unexpected affected rows: %d", affected)
	}
	if lastPublishBody["routing_key"] != "orders.events.v1" {
		t.Fatalf("unexpected publish routing key: %#v", lastPublishBody)
	}
	properties, ok := lastPublishBody["properties"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected publish properties object, got %#v", lastPublishBody["properties"])
	}
	headers, ok := properties["headers"].(map[string]interface{})
	if !ok || headers["x-env"] != "dev" {
		t.Fatalf("unexpected publish headers: %#v", properties["headers"])
	}
	if lastPublishBody["payload_encoding"] != "string" || !strings.Contains(lastPublishBody["payload"].(string), `"id":1`) {
		t.Fatalf("unexpected publish payload: %#v", lastPublishBody)
	}

	columnDefs, err := client.GetColumns("/", "orders.events.v1")
	if err != nil {
		t.Fatalf("GetColumns failed: %v", err)
	}
	names := make([]string, 0, len(columnDefs))
	for _, col := range columnDefs {
		names = append(names, col.Name)
	}
	joined := strings.Join(names, ",")
	for _, want := range []string{"queue", "payload.meta.ip", "headers.x-env", "properties.content_type"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected derived rabbitmq column %q in %s", want, joined)
		}
	}

	databases, err := client.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases failed: %v", err)
	}
	if !reflect.DeepEqual(databases, []string{"/"}) {
		t.Fatalf("unexpected vhost list: %#v", databases)
	}

	tables, err := client.GetTables("/")
	if err != nil {
		t.Fatalf("GetTables failed: %v", err)
	}
	if !reflect.DeepEqual(tables, []string{"orders.events.v1"}) {
		t.Fatalf("unexpected queue list: %#v", tables)
	}
}
