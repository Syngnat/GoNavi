package app

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/nacos"
	"GoNavi-Wails/internal/uievents"
)

type nacosListenerBarrierTestClient struct {
	nacos.Client
	listenStarted chan struct{}
	listenOnce    sync.Once
	closed        atomic.Int32
}

func (client *nacosListenerBarrierTestClient) Connect(connection.ConnectionConfig) error {
	return nil
}

func (client *nacosListenerBarrierTestClient) ListenOnce(
	ctx context.Context,
	_ []nacos.ConfigListenTarget,
	_ int,
) ([]nacos.ConfigListenTarget, error) {
	client.listenOnce.Do(func() {
		close(client.listenStarted)
	})
	<-ctx.Done()
	return nil, ctx.Err()
}

func (client *nacosListenerBarrierTestClient) Close() error {
	client.closed.Add(1)
	return nil
}

type nacosBlockingCloseTestClient struct {
	nacos.Client
	closeStarted chan struct{}
	releaseClose chan struct{}
	closeOnce    sync.Once
}

type nacosRepeatingChangedTestClient struct {
	nacos.Client
	firstListen  chan struct{}
	secondListen chan struct{}
	firstOnce    sync.Once
	secondOnce   sync.Once
	listenCalls  atomic.Int32
}

type nacosNoopListenEventEmitter struct{}

func (nacosNoopListenEventEmitter) Emit(string, ...any) {}

func (client *nacosRepeatingChangedTestClient) Connect(connection.ConnectionConfig) error {
	return nil
}

func (client *nacosRepeatingChangedTestClient) ListenOnce(
	_ context.Context,
	targets []nacos.ConfigListenTarget,
	_ int,
) ([]nacos.ConfigListenTarget, error) {
	call := client.listenCalls.Add(1)
	if call == 1 {
		client.firstOnce.Do(func() {
			close(client.firstListen)
		})
	} else {
		client.secondOnce.Do(func() {
			close(client.secondListen)
		})
	}
	return targets, nil
}

func (client *nacosRepeatingChangedTestClient) Close() error {
	return nil
}

func (client *nacosBlockingCloseTestClient) Connect(connection.ConnectionConfig) error {
	return nil
}

func (client *nacosBlockingCloseTestClient) Close() error {
	client.closeOnce.Do(func() {
		close(client.closeStarted)
	})
	<-client.releaseClose
	return nil
}

func TestNacosConfigListenStopsAfterMatchingChange(t *testing.T) {
	installNacosCacheTestHooks(t)
	CloseAllNacosListeners()
	defer CloseAllNacosClients()

	client := &nacosRepeatingChangedTestClient{
		firstListen:  make(chan struct{}),
		secondListen: make(chan struct{}),
	}
	newNacosClientFunc = func() nacos.Client {
		return client
	}

	const watchID = "listener-one-shot"
	app := &App{
		ctx: uievents.WithEmitter(context.Background(), nacosNoopListenEventEmitter{}),
	}
	result := app.NacosStartConfigListen(connection.ConnectionConfig{
		Type:    "nacos",
		Host:    "listener-one-shot.nacos.local",
		Port:    8848,
		Timeout: 1,
	}, NacosStartConfigListenPayload{
		WatchID:     watchID,
		NamespaceID: "dev",
		DataID:      "application.yaml",
		Group:       "DEFAULT_GROUP",
		ContentMD5:  "original-md5",
	})
	if !result.Success {
		t.Fatalf("start Nacos listener: %s", result.Message)
	}

	select {
	case <-client.firstListen:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first Nacos listen request")
	}

	select {
	case <-client.secondListen:
		t.Fatal("listener polled again after emitting a matching change")
	case <-time.After(500 * time.Millisecond):
	}

	deadline := time.Now().Add(time.Second)
	for {
		nacosListenMu.Lock()
		_, exists := nacosListenSessions[watchID]
		nacosListenMu.Unlock()
		if !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("one-shot listener session was not removed after a matching change")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := client.listenCalls.Load(); got != 1 {
		t.Fatalf("Nacos listen calls = %d, want 1", got)
	}
}

func TestNacosStartConfigListenCannotRegisterAfterCloseAllReturns(t *testing.T) {
	installNacosCacheTestHooks(t)
	CloseAllNacosListeners()
	defer CloseAllNacosClients()

	startConnected := make(chan struct{})
	releaseRegistration := make(chan struct{})
	var startConnectedOnce sync.Once
	var releaseRegistrationOnce sync.Once
	releaseStartRegistration := func() {
		releaseRegistrationOnce.Do(func() {
			close(releaseRegistration)
		})
	}
	defer releaseStartRegistration()
	originalAfterConnectHook := nacosListenStartAfterConnectHook
	nacosListenStartAfterConnectHook = func() {
		startConnectedOnce.Do(func() {
			close(startConnected)
		})
		<-releaseRegistration
	}
	t.Cleanup(func() {
		nacosListenStartAfterConnectHook = originalAfterConnectHook
	})

	listenStarted := make(chan struct{})
	var factoryCalls atomic.Int32
	newNacosClientFunc = func() nacos.Client {
		if factoryCalls.Add(1) == 1 {
			return &nacosCacheTestClient{}
		}
		return &nacosListenerBarrierTestClient{
			listenStarted: listenStarted,
		}
	}

	app := &App{}
	config := connection.ConnectionConfig{
		Type:    "nacos",
		Host:    "listener-register-race.nacos.local",
		Port:    8848,
		Timeout: 1,
	}
	if _, err := app.getNacosClient(config); err != nil {
		t.Fatalf("prewarm Nacos client: %v", err)
	}

	startDone := make(chan connection.QueryResult, 1)
	go func() {
		startDone <- app.NacosStartConfigListen(config, NacosStartConfigListenPayload{
			WatchID: "listener-register-race",
			DataID:  "application.yaml",
			Group:   "DEFAULT_GROUP",
		})
	}()

	select {
	case <-startConnected:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for listener Start to acquire its client")
	}

	CloseAllNacosClients()
	if got := factoryCalls.Load(); got != 1 {
		t.Fatalf("client factory calls before releasing Start = %d, want 1", got)
	}

	releaseStartRegistration()
	var result connection.QueryResult
	select {
	case result = <-startDone:
	case <-time.After(time.Second):
		t.Fatal("listener Start did not return after CloseAll")
	}

	if result.Success {
		select {
		case <-listenStarted:
		case <-time.After(time.Second):
			t.Fatal("stale listener registered but did not expose its cache rebuild")
		}
	}

	nacosListenMu.Lock()
	sessionCount := len(nacosListenSessions)
	nacosListenMu.Unlock()
	nacosCacheMu.Lock()
	cachedClientCount := len(nacosCache)
	nacosCacheMu.Unlock()

	if result.Success {
		t.Fatal("listener Start unexpectedly succeeded after CloseAll returned")
	}
	if sessionCount != 0 {
		t.Fatalf("listener sessions after CloseAll = %d, want 0", sessionCount)
	}
	if got := factoryCalls.Load(); got != 1 {
		t.Fatalf("client factory calls after stale Start = %d, want 1", got)
	}
	if cachedClientCount != 0 {
		t.Fatalf("Nacos cache entries after stale Start = %d, want 0", cachedClientCount)
	}
}

func TestNacosStartConfigListenDoesNotWaitForCloseAllAndCanStartAfterItReturns(t *testing.T) {
	installNacosCacheTestHooks(t)
	CloseAllNacosListeners()
	defer CloseAllNacosClients()

	closeStarted := make(chan struct{})
	releaseClose := make(chan struct{})
	var releaseCloseOnce sync.Once
	releaseClientClose := func() {
		releaseCloseOnce.Do(func() {
			close(releaseClose)
		})
	}
	defer releaseClientClose()
	listenStarted := make(chan struct{})
	var factoryCalls atomic.Int32
	newNacosClientFunc = func() nacos.Client {
		if factoryCalls.Add(1) == 1 {
			return &nacosBlockingCloseTestClient{
				closeStarted: closeStarted,
				releaseClose: releaseClose,
			}
		}
		return &nacosListenerBarrierTestClient{
			listenStarted: listenStarted,
		}
	}

	app := &App{}
	config := connection.ConnectionConfig{
		Type:    "nacos",
		Host:    "listener-close-barrier.nacos.local",
		Port:    8848,
		Timeout: 1,
	}
	if _, err := app.getNacosClient(config); err != nil {
		t.Fatalf("prewarm Nacos client: %v", err)
	}

	closeDone := make(chan struct{})
	go func() {
		CloseAllNacosClients()
		close(closeDone)
	}()
	select {
	case <-closeStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for CloseAll client close")
	}

	blockedStartDone := make(chan connection.QueryResult, 1)
	go func() {
		blockedStartDone <- app.NacosStartConfigListen(config, NacosStartConfigListenPayload{
			WatchID: "listener-during-close",
			DataID:  "application.yaml",
			Group:   "DEFAULT_GROUP",
		})
	}()
	select {
	case result := <-blockedStartDone:
		if result.Success {
			t.Fatal("listener Start unexpectedly succeeded while CloseAll was active")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("listener Start waited for CloseAll instead of failing promptly")
	}
	if got := factoryCalls.Load(); got != 1 {
		t.Fatalf("client factory calls while CloseAll was active = %d, want 1", got)
	}

	releaseClientClose()
	select {
	case <-closeDone:
	case <-time.After(time.Second):
		t.Fatal("CloseAll did not return after client close was released")
	}

	freshResult := app.NacosStartConfigListen(config, NacosStartConfigListenPayload{
		WatchID: "listener-after-close",
		DataID:  "application.yaml",
		Group:   "DEFAULT_GROUP",
	})
	if !freshResult.Success {
		t.Fatalf("fresh listener Start after CloseAll failed: %s", freshResult.Message)
	}
	stopResult := app.NacosStopConfigListen("listener-after-close")
	if !stopResult.Success {
		t.Fatalf("fresh listener Stop after CloseAll failed: %s", stopResult.Message)
	}
	nacosListenMu.Lock()
	sessionCount := len(nacosListenSessions)
	nacosListenMu.Unlock()
	if sessionCount != 0 {
		t.Fatalf("listener sessions after fresh Stop = %d, want 0", sessionCount)
	}
	if got := factoryCalls.Load(); got != 2 {
		t.Fatalf("client factory calls after fresh Start = %d, want 2", got)
	}
}
