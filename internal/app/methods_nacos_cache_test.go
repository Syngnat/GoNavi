package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/nacos"
)

type nacosCacheTestClient struct {
	nacos.Client
	connect        func(connection.ConnectionConfig) error
	ping           func(context.Context) error
	listNamespaces func(context.Context) ([]nacos.Namespace, error)
	closed         atomic.Int32
}

func (client *nacosCacheTestClient) Connect(config connection.ConnectionConfig) error {
	if client.connect != nil {
		return client.connect(config)
	}
	return nil
}

func (client *nacosCacheTestClient) Ping(ctx context.Context) error {
	if client.ping != nil {
		return client.ping(ctx)
	}
	return nil
}

func (client *nacosCacheTestClient) ListNamespaces(ctx context.Context) ([]nacos.Namespace, error) {
	if client.listNamespaces != nil {
		return client.listNamespaces(ctx)
	}
	return nil, nil
}

func (client *nacosCacheTestClient) Close() error {
	client.closed.Add(1)
	return nil
}

var _ nacos.Client = (*nacosCacheTestClient)(nil)

func installNacosCacheTestHooks(t *testing.T) {
	t.Helper()

	originalNewNacosClientFunc := newNacosClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc

	nacosCacheMu.Lock()
	originalCache := nacosCache
	originalCacheGeneration := nacosCacheGeneration
	originalCacheGenerationCtx := nacosCacheGenerationCtx
	originalCacheGenerationCancel := nacosCacheGenerationCancel
	nacosCache = make(map[string]nacos.Client)
	nacosCacheGeneration = 0
	nacosCacheGenerationCtx, nacosCacheGenerationCancel = context.WithCancel(context.Background())
	nacosCacheMu.Unlock()

	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	t.Cleanup(func() {
		nacosCacheMu.Lock()
		testCache := nacosCache
		testCacheGenerationCancel := nacosCacheGenerationCancel
		nacosCache = originalCache
		nacosCacheGeneration = originalCacheGeneration
		nacosCacheGenerationCtx = originalCacheGenerationCtx
		nacosCacheGenerationCancel = originalCacheGenerationCancel
		nacosCacheMu.Unlock()
		if testCacheGenerationCancel != nil {
			testCacheGenerationCancel()
		}

		for _, client := range testCache {
			if client != nil {
				_ = client.Close()
			}
		}
		newNacosClientFunc = originalNewNacosClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
}

func TestFormatNacosConnSummaryOnlyIncludesSafeContextPath(t *testing.T) {
	const (
		accessToken = "nacos-access-token-secret"
		password    = "nacos-params-password-secret"
		token       = "nacos-generic-token-secret"
	)
	summary := formatNacosConnSummary(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             "nacos.example.com",
		Port:             8848,
		User:             "operator",
		UseSSL:           true,
		ConnectionParams: "contextPath=custom-nacos&accessToken=" + accessToken + "&password=" + password + "&token=" + token,
	})

	for _, expected := range []string{
		"地址=nacos.example.com:8848",
		"SSL=on",
		"用户=operator",
		"contextPath=/custom-nacos",
	} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("connection summary %q does not contain %q", summary, expected)
		}
	}
	for _, sensitive := range []string{
		accessToken,
		password,
		token,
		"accessToken=",
		"password=",
		"token=",
	} {
		if strings.Contains(summary, sensitive) {
			t.Fatalf("connection summary exposed sensitive parameter %q: %q", sensitive, summary)
		}
	}
}

func TestGetNacosClientCacheKeyIncludesAuthenticationAndTLSIdentity(t *testing.T) {
	const sha256HexLength = 64

	base := connection.ConnectionConfig{
		Type:        "nacos",
		Host:        "nacos.example.com",
		Port:        8848,
		User:        "nacos",
		Password:    "nacos-secret:not-hex",
		UseSSL:      true,
		SSLMode:     "required",
		SSLCAPath:   "C:/certs/ca-a.pem",
		SSLCertPath: "C:/certs/client-a.pem",
		SSLKeyPath:  "C:/certs/client-a.key",
		UseProxy:    true,
		Proxy: connection.ProxyConfig{
			Type:     "http",
			Host:     "proxy.example.com",
			Port:     8080,
			User:     "proxy-user",
			Password: "proxy-secret:not-hex",
		},
	}
	baseKey := getNacosClientCacheKey(base)
	if len(baseKey) != sha256HexLength {
		t.Fatalf("cache key length = %d, want %d", len(baseKey), sha256HexLength)
	}
	for _, secret := range []string{base.Password, base.Proxy.Password} {
		if strings.Contains(baseKey, secret) {
			t.Fatalf("cache key exposed plaintext secret %q", secret)
		}
	}

	tests := []struct {
		name   string
		mutate func(*connection.ConnectionConfig)
	}{
		{
			name: "nacos password",
			mutate: func(config *connection.ConnectionConfig) {
				config.Password = "another-nacos-secret"
			},
		},
		{
			name: "proxy password",
			mutate: func(config *connection.ConnectionConfig) {
				config.Proxy.Password = "another-proxy-secret"
			},
		},
		{
			name: "CA path",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSLCAPath = "C:/certs/ca-b.pem"
			},
		},
		{
			name: "client certificate path",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSLCertPath = "C:/certs/client-b.pem"
			},
		},
		{
			name: "client private key path",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSLKeyPath = "C:/certs/client-b.key"
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			changed := base
			testCase.mutate(&changed)
			if changedKey := getNacosClientCacheKey(changed); changedKey == baseKey {
				t.Fatalf("cache key did not change when %s changed", testCase.name)
			}
		})
	}

	tunnelBase := base
	tunnelBase.UseProxy = false
	tunnelBase.Proxy = connection.ProxyConfig{}
	tunnelBase.UseHTTPTunnel = true
	tunnelBase.HTTPTunnel = connection.HTTPTunnelConfig{
		Host:     "tunnel.example.com",
		Port:     3128,
		User:     "tunnel-user",
		Password: "tunnel-secret:not-hex",
	}
	tunnelBaseKey := getNacosClientCacheKey(tunnelBase)
	if strings.Contains(tunnelBaseKey, tunnelBase.HTTPTunnel.Password) {
		t.Fatalf("cache key exposed plaintext HTTP tunnel secret %q", tunnelBase.HTTPTunnel.Password)
	}
	tunnelTests := []struct {
		name   string
		mutate func(*connection.ConnectionConfig)
	}{
		{
			name: "HTTP tunnel host",
			mutate: func(config *connection.ConnectionConfig) {
				config.HTTPTunnel.Host = "other-tunnel.example.com"
			},
		},
		{
			name: "HTTP tunnel port",
			mutate: func(config *connection.ConnectionConfig) {
				config.HTTPTunnel.Port = 8080
			},
		},
		{
			name: "HTTP tunnel user",
			mutate: func(config *connection.ConnectionConfig) {
				config.HTTPTunnel.User = "other-tunnel-user"
			},
		},
		{
			name: "HTTP tunnel password",
			mutate: func(config *connection.ConnectionConfig) {
				config.HTTPTunnel.Password = "other-tunnel-secret"
			},
		},
	}
	for _, testCase := range tunnelTests {
		t.Run(testCase.name, func(t *testing.T) {
			changed := tunnelBase
			testCase.mutate(&changed)
			if changedKey := getNacosClientCacheKey(changed); changedKey == tunnelBaseKey {
				t.Fatalf("cache key did not change when %s changed", testCase.name)
			}
		})
	}

	sshBase := base
	sshBase.UseProxy = false
	sshBase.Proxy = connection.ProxyConfig{}
	sshBase.UseSSH = true
	sshBase.SSH = connection.SSHConfig{
		Host:     "ssh.example.com",
		Port:     22,
		User:     "ssh-user",
		Password: "ssh-secret:not-hex",
		KeyPath:  "C:/keys/nacos-a.pem",
	}
	sshBaseKey := getNacosClientCacheKey(sshBase)
	if strings.Contains(sshBaseKey, sshBase.SSH.Password) {
		t.Fatalf("cache key exposed plaintext SSH secret %q", sshBase.SSH.Password)
	}
	sshTests := []struct {
		name   string
		mutate func(*connection.ConnectionConfig)
	}{
		{
			name: "SSH enabled",
			mutate: func(config *connection.ConnectionConfig) {
				config.UseSSH = false
			},
		},
		{
			name: "SSH host",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSH.Host = "other-ssh.example.com"
			},
		},
		{
			name: "SSH port",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSH.Port = 2222
			},
		},
		{
			name: "SSH user",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSH.User = "other-ssh-user"
			},
		},
		{
			name: "SSH password",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSH.Password = "other-ssh-secret"
			},
		},
		{
			name: "SSH key path",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSH.KeyPath = "C:/keys/nacos-b.pem"
			},
		},
		{
			name: "SSH known_hosts path",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSH.KnownHostsPath = "/tmp/other-known-hosts"
			},
		},
		{
			name: "SSH host key fingerprint",
			mutate: func(config *connection.ConnectionConfig) {
				config.SSH.HostKeyFingerprint = "SHA256:other-host-key"
			},
		},
	}
	for _, testCase := range sshTests {
		t.Run(testCase.name, func(t *testing.T) {
			changed := sshBase
			testCase.mutate(&changed)
			if changedKey := getNacosClientCacheKey(changed); changedKey == sshBaseKey {
				t.Fatalf("cache key did not change when %s changed", testCase.name)
			}
		})
	}
}

func TestGetNacosClientCacheHitDoesNotPingOrBlockOtherCacheKeys(t *testing.T) {
	installNacosCacheTestHooks(t)

	var pingCalls atomic.Int32
	releaseSlowPing := make(chan struct{})
	slowClient := &nacosCacheTestClient{
		ping: func(context.Context) error {
			pingCalls.Add(1)
			<-releaseSlowPing
			return nil
		},
	}
	fastClient := &nacosCacheTestClient{}
	var factoryCalls atomic.Int32
	newNacosClientFunc = func() nacos.Client {
		factoryCalls.Add(1)
		return &nacosCacheTestClient{}
	}
	slowConfig := connection.ConnectionConfig{Type: "nacos", Host: "slow.nacos.local", Port: 8848}
	fastConfig := connection.ConnectionConfig{Type: "nacos", Host: "fast.nacos.local", Port: 8848}

	nacosCacheMu.Lock()
	nacosCache[getNacosClientCacheKey(slowConfig)] = slowClient
	nacosCache[getNacosClientCacheKey(fastConfig)] = fastClient
	nacosCacheMu.Unlock()

	app := &App{}
	slowDone := make(chan struct {
		client nacos.Client
		err    error
	}, 1)
	go func() {
		client, err := app.getNacosClient(slowConfig)
		slowDone <- struct {
			client nacos.Client
			err    error
		}{client: client, err: err}
	}()
	var slowResult struct {
		client nacos.Client
		err    error
	}
	select {
	case slowResult = <-slowDone:
	case <-time.After(time.Second):
		close(releaseSlowPing)
		<-slowDone
		t.Fatal("cached Nacos lookup invoked Ping and blocked")
	}

	fastResult, fastErr := app.getNacosClient(fastConfig)
	close(releaseSlowPing)
	if slowResult.err != nil {
		t.Fatalf("slow cache lookup failed: %v", slowResult.err)
	}
	if slowResult.client != slowClient {
		t.Fatal("slow cache lookup did not return its cached client")
	}
	if fastErr != nil {
		t.Fatalf("fast cache lookup failed: %v", fastErr)
	}
	if fastResult != fastClient {
		t.Fatal("fast cache lookup did not return its cached client")
	}
	if got := pingCalls.Load(); got != 0 {
		t.Fatalf("cached Nacos lookup invoked Ping %d time(s), want 0", got)
	}
	if got := factoryCalls.Load(); got != 0 {
		t.Fatalf("cached Nacos lookup created %d client(s), want 0", got)
	}
}

func TestGetNacosClientConnectsDifferentCacheKeysConcurrently(t *testing.T) {
	installNacosCacheTestHooks(t)

	connectStarted := make(chan string, 2)
	releaseConnect := make(chan struct{})
	newNacosClientFunc = func() nacos.Client {
		return &nacosCacheTestClient{
			connect: func(config connection.ConnectionConfig) error {
				connectStarted <- config.Host
				<-releaseConnect
				return nil
			},
		}
	}

	app := &App{}
	configs := []connection.ConnectionConfig{
		{Type: "nacos", Host: "one.nacos.local", Port: 8848},
		{Type: "nacos", Host: "two.nacos.local", Port: 8848},
	}
	results := make(chan error, len(configs))
	for _, config := range configs {
		config := config
		go func() {
			_, err := app.getNacosClient(config)
			results <- err
		}()
	}

	seen := make(map[string]struct{}, len(configs))
	select {
	case host := <-connectStarted:
		seen[host] = struct{}{}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first Nacos Connect")
	}
	secondStartedBeforeRelease := true
	select {
	case host := <-connectStarted:
		seen[host] = struct{}{}
	case <-time.After(300 * time.Millisecond):
		secondStartedBeforeRelease = false
	}
	close(releaseConnect)
	for range configs {
		if err := <-results; err != nil {
			t.Fatalf("getNacosClient failed: %v", err)
		}
	}
	if !secondStartedBeforeRelease {
		t.Fatal("Connect for one cache key blocked Connect for another cache key")
	}
	if len(seen) != len(configs) {
		t.Fatalf("connected hosts = %v, want both cache keys", seen)
	}
}

func TestGetNacosClientCoalescesConcurrentColdConnects(t *testing.T) {
	installNacosCacheTestHooks(t)

	const callers = 16
	var factoryCalls atomic.Int32
	connectStarted := make(chan struct{})
	releaseConnect := make(chan struct{})
	var connectStartedOnce sync.Once
	sharedClient := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			connectStartedOnce.Do(func() { close(connectStarted) })
			<-releaseConnect
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client {
		factoryCalls.Add(1)
		return sharedClient
	}

	app := &App{}
	config := connection.ConnectionConfig{Type: "nacos", Host: "shared.nacos.local", Port: 8848}
	start := make(chan struct{})
	results := make(chan nacos.Client, callers)
	errors := make(chan error, callers)
	var workers sync.WaitGroup
	workers.Add(callers)
	for range callers {
		go func() {
			defer workers.Done()
			<-start
			client, err := app.getNacosClient(config)
			results <- client
			errors <- err
		}()
	}
	close(start)
	select {
	case <-connectStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for shared Nacos Connect")
	}
	time.Sleep(100 * time.Millisecond)
	close(releaseConnect)
	workers.Wait()
	close(results)
	close(errors)

	for err := range errors {
		if err != nil {
			t.Fatalf("getNacosClient failed: %v", err)
		}
	}
	for client := range results {
		if client != sharedClient {
			t.Fatal("concurrent caller did not receive the shared cached client")
		}
	}
	if got := factoryCalls.Load(); got != 1 {
		t.Fatalf("Nacos client factory calls = %d, want 1", got)
	}
	if got := sharedClient.closed.Load(); got != 0 {
		t.Fatalf("shared cached client was closed %d times", got)
	}
}

func TestGetNacosClientWithContextCancelsSingleflightWaiter(t *testing.T) {
	installNacosCacheTestHooks(t)

	connectStarted := make(chan struct{})
	releaseConnect := make(chan struct{})
	var connectStartedOnce sync.Once
	newNacosClientFunc = func() nacos.Client {
		return &nacosCacheTestClient{
			connect: func(connection.ConnectionConfig) error {
				connectStartedOnce.Do(func() { close(connectStarted) })
				<-releaseConnect
				return nil
			},
		}
	}

	app := &App{}
	config := connection.ConnectionConfig{
		Type:    "nacos",
		Host:    "cancel-waiter.nacos.local",
		Port:    8848,
		Timeout: 30,
	}
	leaderDone := make(chan error, 1)
	go func() {
		_, err := app.getNacosClientWithContext(context.Background(), config)
		leaderDone <- err
	}()
	select {
	case <-connectStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for shared Nacos Connect")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	startedAt := time.Now()
	_, err := app.getNacosClientWithContext(ctx, config)
	elapsed := time.Since(startedAt)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting caller error = %v, want context deadline exceeded", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("waiting caller returned after %v, want prompt context cancellation", elapsed)
	}

	close(releaseConnect)
	if err := <-leaderDone; err != nil {
		t.Fatalf("leader getNacosClientWithContext failed: %v", err)
	}
}

func TestGetNacosClientWithContextCanceledLeaderDoesNotPoisonWaiter(t *testing.T) {
	installNacosCacheTestHooks(t)

	connectStarted := make(chan struct{})
	releaseConnect := make(chan struct{})
	var connectStartedOnce sync.Once
	sharedClient := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			connectStartedOnce.Do(func() { close(connectStarted) })
			<-releaseConnect
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client {
		return sharedClient
	}

	app := &App{}
	config := connection.ConnectionConfig{
		Type:    "nacos",
		Host:    "cancel-leader.nacos.local",
		Port:    8848,
		Timeout: 30,
	}
	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderDone := make(chan error, 1)
	go func() {
		_, err := app.getNacosClientWithContext(leaderCtx, config)
		leaderDone <- err
	}()
	select {
	case <-connectStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for leader Nacos Connect")
	}

	waiterDone := make(chan struct {
		client nacos.Client
		err    error
	}, 1)
	go func() {
		client, err := app.getNacosClientWithContext(context.Background(), config)
		waiterDone <- struct {
			client nacos.Client
			err    error
		}{client: client, err: err}
	}()
	time.Sleep(50 * time.Millisecond)
	cancelLeader()
	if err := <-leaderDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("leader error = %v, want context canceled", err)
	}

	close(releaseConnect)
	waiter := <-waiterDone
	if waiter.err != nil {
		t.Fatalf("live waiter inherited canceled leader error: %v", waiter.err)
	}
	if waiter.client != sharedClient {
		t.Fatal("live waiter did not receive the shared client")
	}
}

func TestGetNacosClientWithContextSeparatesFlightsByTimeout(t *testing.T) {
	installNacosCacheTestHooks(t)

	shortConnectStarted := make(chan struct{})
	releaseShortConnect := make(chan struct{})
	longConnectStarted := make(chan struct{})
	var shortStartedOnce sync.Once
	var longStartedOnce sync.Once
	var factoryCalls atomic.Int32
	newNacosClientFunc = func() nacos.Client {
		factoryCalls.Add(1)
		return &nacosCacheTestClient{
			connect: func(config connection.ConnectionConfig) error {
				switch config.Timeout {
				case 1:
					shortStartedOnce.Do(func() { close(shortConnectStarted) })
					<-releaseShortConnect
					return errors.New("short connection timeout")
				case 30:
					longStartedOnce.Do(func() { close(longConnectStarted) })
					return nil
				default:
					return errors.New("unexpected connection timeout")
				}
			},
		}
	}

	app := &App{}
	baseConfig := connection.ConnectionConfig{
		Type: "nacos",
		Host: "timeout-flight.nacos.local",
		Port: 8848,
	}
	shortConfig := baseConfig
	shortConfig.Timeout = 1
	longConfig := baseConfig
	longConfig.Timeout = 30

	shortDone := make(chan error, 1)
	go func() {
		_, err := app.getNacosClientWithContext(context.Background(), shortConfig)
		shortDone <- err
	}()
	select {
	case <-shortConnectStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for short-timeout Nacos Connect")
	}

	longDone := make(chan struct {
		client nacos.Client
		err    error
	}, 1)
	go func() {
		client, err := app.getNacosClientWithContext(context.Background(), longConfig)
		longDone <- struct {
			client nacos.Client
			err    error
		}{client: client, err: err}
	}()
	longStartedBeforeShortRelease := true
	select {
	case <-longConnectStarted:
	case <-time.After(300 * time.Millisecond):
		longStartedBeforeShortRelease = false
	}

	close(releaseShortConnect)
	shortErr := <-shortDone
	longResult := <-longDone
	if !longStartedBeforeShortRelease {
		t.Fatal("long-timeout caller joined the short-timeout connection flight")
	}
	if shortErr == nil {
		t.Fatal("short-timeout Connect unexpectedly succeeded")
	}
	if longResult.err != nil {
		t.Fatalf("long-timeout Connect inherited short-timeout error: %v", longResult.err)
	}
	if longResult.client == nil {
		t.Fatal("long-timeout Connect returned nil client")
	}
	if got := factoryCalls.Load(); got != 2 {
		t.Fatalf("Nacos client factory calls = %d, want 2 timeout-specific flights", got)
	}
}

func TestGetNacosClientDifferentTimeoutCacheHitsDoNotPingOrCloseSharedClient(t *testing.T) {
	installNacosCacheTestHooks(t)

	var pingCalls atomic.Int32
	cachedClient := &nacosCacheTestClient{
		ping: func(context.Context) error {
			pingCalls.Add(1)
			return errors.New("cached client must not be health-probed")
		},
	}
	var factoryCalls atomic.Int32
	newNacosClientFunc = func() nacos.Client {
		factoryCalls.Add(1)
		return &nacosCacheTestClient{}
	}

	baseConfig := connection.ConnectionConfig{
		Type: "nacos",
		Host: "timeout-cache-hit.nacos.local",
		Port: 8848,
	}
	nacosCacheMu.Lock()
	nacosCache[getNacosClientCacheKey(baseConfig)] = cachedClient
	nacosCacheMu.Unlock()

	configs := []connection.ConnectionConfig{baseConfig, baseConfig}
	configs[0].Timeout = 1
	configs[1].Timeout = 30
	start := make(chan struct{})
	results := make(chan struct {
		client nacos.Client
		err    error
	}, len(configs))
	for _, config := range configs {
		config := config
		go func() {
			<-start
			client, err := (&App{}).getNacosClientWithContext(context.Background(), config)
			results <- struct {
				client nacos.Client
				err    error
			}{client: client, err: err}
		}()
	}
	close(start)

	for range configs {
		result := <-results
		if result.err != nil {
			t.Fatalf("cached Nacos lookup failed: %v", result.err)
		}
		if result.client != cachedClient {
			t.Fatal("timeout-specific cache hit did not return the shared client")
		}
	}
	if got := pingCalls.Load(); got != 0 {
		t.Fatalf("timeout-specific cache hits invoked Ping %d time(s), want 0", got)
	}
	if got := cachedClient.closed.Load(); got != 0 {
		t.Fatalf("timeout-specific cache hits closed shared client %d time(s)", got)
	}
	if got := factoryCalls.Load(); got != 0 {
		t.Fatalf("timeout-specific cache hits created %d client(s), want 0", got)
	}
}

func TestNacosOperationTimeoutIncludesClientAcquisition(t *testing.T) {
	installNacosCacheTestHooks(t)

	operationStartedAt := time.Now()
	var operationDeadline time.Time
	testClient := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			time.Sleep(400 * time.Millisecond)
			return nil
		},
		listNamespaces: func(ctx context.Context) ([]nacos.Namespace, error) {
			var ok bool
			operationDeadline, ok = ctx.Deadline()
			if !ok {
				return nil, errors.New("Nacos operation context has no deadline")
			}
			return []nacos.Namespace{}, nil
		},
	}
	newNacosClientFunc = func() nacos.Client {
		return testClient
	}

	result := (&App{}).NacosListNamespaces(connection.ConnectionConfig{
		Type:    "nacos",
		Host:    "shared-deadline.nacos.local",
		Port:    8848,
		Timeout: 1,
	})
	if !result.Success {
		t.Fatalf("NacosListNamespaces failed: %s", result.Message)
	}
	if totalBudget := operationDeadline.Sub(operationStartedAt); totalBudget > 1250*time.Millisecond {
		t.Fatalf("operation deadline budget = %v, want connection and operation to share one timeout", totalBudget)
	}
}

func TestCloseAllNacosClientsCanceledListenerCannotRepopulateFreshCache(t *testing.T) {
	installNacosCacheTestHooks(t)

	proxyResolutionStarted := make(chan struct{})
	releaseProxyResolution := make(chan struct{})
	var proxyResolutionStartedOnce sync.Once
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		proxyResolutionStartedOnce.Do(func() { close(proxyResolutionStarted) })
		<-releaseProxyResolution
		return config, nil
	}
	var factoryCalls atomic.Int32
	newNacosClientFunc = func() nacos.Client {
		factoryCalls.Add(1)
		return &nacosCacheTestClient{}
	}

	ctx, cancel := context.WithCancel(context.Background())
	const watchID = "close-all-canceled-listener"
	nacosListenMu.Lock()
	nacosListenSessions[watchID] = &nacosListenSession{
		watchID: watchID,
		cancel:  cancel,
	}
	nacosListenMu.Unlock()

	app := &App{}
	config := connection.ConnectionConfig{
		Type: "nacos",
		Host: "listener-race.nacos.local",
		Port: 8848,
	}
	connectDone := make(chan error, 1)
	go func() {
		_, err := app.getNacosClientWithContext(ctx, config)
		connectDone <- err
	}()
	select {
	case <-proxyResolutionStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for listener connection preparation")
	}

	CloseAllNacosClients()
	close(releaseProxyResolution)
	if err := <-connectDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled listener connection error = %v, want context canceled", err)
	}
	if got := factoryCalls.Load(); got != 0 {
		t.Fatalf("Nacos client factory called %d time(s) after listener cancellation", got)
	}
	nacosCacheMu.Lock()
	cachedClients := len(nacosCache)
	nacosCacheMu.Unlock()
	if cachedClients != 0 {
		t.Fatalf("Nacos cache contains %d client(s) after CloseAll", cachedClients)
	}
}

func TestNacosCacheLogsDoNotExposeCredentialDerivedFingerprint(t *testing.T) {
	installNacosCacheTestHooks(t)

	config := connection.ConnectionConfig{
		Type:     "nacos",
		Host:     "log-fingerprint.nacos.local",
		Port:     8848,
		User:     "nacos",
		Password: "unique-cache-log-secret",
	}
	cacheKey := getNacosClientCacheKey(config)
	fingerprint := cacheKey[:12]
	newNacosClientFunc = func() nacos.Client {
		return &nacosCacheTestClient{}
	}

	logPath := logger.Path()
	before, err := os.Stat(logPath)
	if err != nil {
		t.Fatalf("stat Nacos log: %v", err)
	}

	if _, err := (&App{}).getNacosClient(config); err != nil {
		t.Fatalf("getNacosClient: %v", err)
	}
	CloseAllNacosClients()

	logContents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read Nacos log: %v", err)
	}
	appended := logContents[before.Size():]
	if strings.Contains(string(appended), fingerprint) {
		t.Fatalf("Nacos cache log exposed credential-derived fingerprint %q", fingerprint)
	}
}

func TestGetNacosClientClosesUnpublishedClientWhenCachePublisherWins(t *testing.T) {
	installNacosCacheTestHooks(t)

	connectStarted := make(chan struct{})
	releaseConnect := make(chan struct{})
	var connectStartedOnce sync.Once
	connectingClient := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			connectStartedOnce.Do(func() { close(connectStarted) })
			<-releaseConnect
			return nil
		},
	}
	cachedWinner := &nacosCacheTestClient{}
	newNacosClientFunc = func() nacos.Client {
		return connectingClient
	}

	app := &App{}
	config := connection.ConnectionConfig{Type: "nacos", Host: "winner.nacos.local", Port: 8848}
	result := make(chan struct {
		client nacos.Client
		err    error
	}, 1)
	go func() {
		client, err := app.getNacosClient(config)
		result <- struct {
			client nacos.Client
			err    error
		}{client: client, err: err}
	}()
	select {
	case <-connectStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Nacos Connect")
	}

	key := getNacosClientCacheKey(config)
	nacosCacheMu.Lock()
	nacosCache[key] = cachedWinner
	nacosCacheMu.Unlock()
	close(releaseConnect)

	got := <-result
	if got.err != nil {
		t.Fatalf("getNacosClient failed: %v", got.err)
	}
	if got.client != cachedWinner {
		t.Fatal("getNacosClient did not preserve the existing cache winner")
	}
	if closed := connectingClient.closed.Load(); closed != 1 {
		t.Fatalf("unpublished client close count = %d, want 1", closed)
	}
}

func TestCloseAllNacosClientsPreventsInflightConnectLateCacheWrite(t *testing.T) {
	installNacosCacheTestHooks(t)

	connectStarted := make(chan struct{})
	releaseConnect := make(chan struct{})
	var connectStartedOnce sync.Once
	connectingClient := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			connectStartedOnce.Do(func() { close(connectStarted) })
			<-releaseConnect
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client {
		return connectingClient
	}

	app := &App{}
	config := connection.ConnectionConfig{Type: "nacos", Host: "closing.nacos.local", Port: 8848}
	connectDone := make(chan error, 1)
	go func() {
		_, err := app.getNacosClient(config)
		connectDone <- err
	}()
	select {
	case <-connectStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for in-flight Nacos Connect")
	}

	CloseAllNacosClients()
	close(releaseConnect)
	err := <-connectDone
	if err == nil {
		t.Fatal("in-flight Connect unexpectedly succeeded after CloseAll")
	}
	if got := connectingClient.closed.Load(); got != 1 {
		t.Fatalf("in-flight client close count = %d, want 1", got)
	}
	nacosCacheMu.Lock()
	cachedClients := len(nacosCache)
	nacosCacheMu.Unlock()
	if cachedClients != 0 {
		t.Fatalf("Nacos cache contains %d client(s) after CloseAll returned", cachedClients)
	}
}

func TestCloseAllNacosClientsLetsFreshGenerationBypassOldFlight(t *testing.T) {
	installNacosCacheTestHooks(t)

	oldConnectStarted := make(chan struct{})
	releaseOldConnect := make(chan struct{})
	var oldConnectStartedOnce sync.Once
	oldClient := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			oldConnectStartedOnce.Do(func() { close(oldConnectStarted) })
			<-releaseOldConnect
			return nil
		},
	}
	freshConnectStarted := make(chan struct{})
	var freshConnectStartedOnce sync.Once
	freshClient := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			freshConnectStartedOnce.Do(func() { close(freshConnectStarted) })
			return nil
		},
	}
	var factoryCalls atomic.Int32
	newNacosClientFunc = func() nacos.Client {
		switch factoryCalls.Add(1) {
		case 1:
			return oldClient
		case 2:
			return freshClient
		default:
			return &nacosCacheTestClient{}
		}
	}

	app := &App{}
	config := connection.ConnectionConfig{Type: "nacos", Host: "generation.nacos.local", Port: 8848}
	oldDone := make(chan error, 1)
	go func() {
		_, err := app.getNacosClient(config)
		oldDone <- err
	}()
	select {
	case <-oldConnectStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for old-generation Nacos Connect")
	}

	CloseAllNacosClients()
	freshDone := make(chan struct {
		client nacos.Client
		err    error
	}, 1)
	go func() {
		client, err := app.getNacosClient(config)
		freshDone <- struct {
			client nacos.Client
			err    error
		}{client: client, err: err}
	}()

	freshStartedBeforeOldRelease := true
	select {
	case <-freshConnectStarted:
	case <-time.After(300 * time.Millisecond):
		freshStartedBeforeOldRelease = false
	}
	close(releaseOldConnect)
	oldErr := <-oldDone
	freshResult := <-freshDone

	if !freshStartedBeforeOldRelease {
		t.Fatal("fresh-generation Connect joined the invalidated old-generation flight")
	}
	if oldErr == nil {
		t.Fatal("old-generation Connect unexpectedly succeeded after CloseAll")
	}
	if freshResult.err != nil {
		t.Fatalf("fresh-generation Connect failed: %v", freshResult.err)
	}
	if freshResult.client != freshClient {
		t.Fatal("fresh-generation lookup did not return the fresh client")
	}
	if got := factoryCalls.Load(); got != 2 {
		t.Fatalf("Nacos client factory calls = %d, want 2 generations", got)
	}
	if got := oldClient.closed.Load(); got != 1 {
		t.Fatalf("old-generation client close count = %d, want 1", got)
	}
	if got := freshClient.closed.Load(); got != 0 {
		t.Fatalf("fresh-generation client was closed %d times", got)
	}
}
