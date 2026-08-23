package db

import (
	"net/http"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHTTPDataSourceClientsDoNotUseConnectTimeoutAsRequestTimeout(t *testing.T) {
	config := connection.ConnectionConfig{Timeout: 1}
	tests := []struct {
		name  string
		build func(connection.ConnectionConfig) *http.Client
	}{
		{name: "chroma", build: buildChromaHTTPClient},
		{name: "qdrant", build: buildQdrantHTTPClient},
		{name: "milvus", build: buildMilvusHTTPClient},
		{name: "rabbitmq", build: buildRabbitMQHTTPClient},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := tt.build(config)
			if client.Timeout != 0 {
				t.Fatalf("connection timeout leaked into HTTP request timeout: %s", client.Timeout)
			}
			transport, ok := client.Transport.(*http.Transport)
			if !ok || transport.DialContext == nil {
				t.Fatal("expected HTTP transport to retain a bounded connection dial")
			}
		})
	}
}
