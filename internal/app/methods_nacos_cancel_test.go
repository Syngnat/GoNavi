package app

import (
	"context"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/nacos"
)

type cancellableNacosTestClient struct {
	nacos.Client
	started chan struct{}
	closed  chan struct{}
}

func (client *cancellableNacosTestClient) Connect(connection.ConnectionConfig) error {
	return nil
}

func (client *cancellableNacosTestClient) ConnectContext(ctx context.Context, _ connection.ConnectionConfig) error {
	close(client.started)
	<-ctx.Done()
	return ctx.Err()
}

func (client *cancellableNacosTestClient) Close() error {
	select {
	case <-client.closed:
	default:
		close(client.closed)
	}
	return nil
}

func TestNacosTestConnectionCanBeCancelled(t *testing.T) {
	installNacosCacheTestHooks(t)

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	client := &cancellableNacosTestClient{
		started: make(chan struct{}),
		closed:  make(chan struct{}),
	}
	newNacosClientFunc = func() nacos.Client { return client }

	const runID = "nacos-test-cancellable"
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- application.NacosTestConnectionWithProgress(connection.ConnectionConfig{
			Type: "nacos",
			Host: "nacos.example.com",
			Port: 8848,
		}, runID)
	}()

	select {
	case <-client.started:
	case <-time.After(time.Second):
		t.Fatal("Nacos test did not start")
	}

	if cancelResult := application.CancelConnectionTest(runID); !cancelResult.Success {
		t.Fatalf("CancelConnectionTest result = %#v, want success", cancelResult)
	}

	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("cancelled Nacos test result = %#v, want failure", result)
		}
		data, ok := result.Data.(map[string]any)
		if !ok || data["cancelled"] != true {
			t.Fatalf("cancelled Nacos test data = %#v, want cancelled=true", result.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled Nacos test did not return")
	}

	select {
	case <-client.closed:
	case <-time.After(time.Second):
		t.Fatal("cancelled isolated Nacos client was not closed")
	}
}
