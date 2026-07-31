package nacos

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
)

func TestScopedNacosV3ConnectsViaReadinessWithoutNamespaceAdmin(t *testing.T) {
	var (
		loginRequests     atomic.Int32
		readinessRequests atomic.Int32
		namespaceRequests atomic.Int32
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v3/auth/user/login":
			loginRequests.Add(1)
			writeAuthLifecycleJSON(w, map[string]any{
				"accessToken": "scoped-token",
				"tokenTtl":    3600,
			})
		case nacosV3ReadinessPath:
			readinessRequests.Add(1)
			writeAuthLifecycleJSON(w, map[string]any{
				"code":    0,
				"message": "success",
				"data":    "ok",
			})
		case routesForNacosAPI(nacosAPIV3).namespaceList:
			namespaceRequests.Add(1)
			http.Error(w, "namespace administrator permission required", http.StatusForbidden)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := authLifecycleServerConfig(t, server)
	config.User = "scoped-user"
	config.Password = "scoped-password"
	client := &ClientImpl{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	if client.currentAPIFamily() != nacosAPIV3 {
		t.Fatalf("API family = %d, want v3", client.currentAPIFamily())
	}
	if got := namespaceRequests.Load(); got != 0 {
		t.Fatalf("namespace requests during Connect = %d, want 0", got)
	}
	if err := client.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	if got := namespaceRequests.Load(); got != 0 {
		t.Fatalf("namespace requests after Ping = %d, want 0", got)
	}
	if got := readinessRequests.Load(); got != 3 {
		t.Fatalf("readiness requests = %d, want 3 (detect, Connect Ping, explicit Ping)", got)
	}

	_, err := client.ListNamespaces(context.Background())
	if err == nil {
		t.Fatal("ListNamespaces unexpectedly succeeded for scoped account")
	}
	status, ok := HTTPStatusCode(fmt.Errorf("wrapped namespace error: %w", err))
	if !ok || status != http.StatusForbidden {
		t.Fatalf("HTTPStatusCode(%v) = %d, %v; want 403, true", err, status, ok)
	}
	if got := namespaceRequests.Load(); got != 2 {
		t.Fatalf("namespace requests = %d, want one request plus one auth retry", got)
	}
	if got := loginRequests.Load(); got != 2 {
		t.Fatalf("login requests = %d, want initial login plus one 403 retry", got)
	}
}

func TestEnsureAuthDoesNotReuseCachedConnectionOperationTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v3/auth/user/login" {
			http.NotFound(w, request)
			return
		}
		time.Sleep(1200 * time.Millisecond)
		writeAuthLifecycleJSON(w, map[string]any{
			"accessToken": "refreshed-token",
			"tokenTtl":    3600,
		})
	}))
	defer server.Close()

	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	client := &ClientImpl{
		config: connection.ConnectionConfig{
			User:     "scoped-user",
			Password: "scoped-password",
			// Simulate a cached client first opened by a short operation.
			Timeout: 1,
		},
		httpClient: server.Client(),
		baseURL:    baseURL,
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.ensureAuth(ctx); err != nil {
		t.Fatalf("ensureAuth inherited the cached connection timeout: %v", err)
	}
}

func TestNacosHTTPErrorRedactsStructuredSecretsWithoutDroppingDiagnostics(t *testing.T) {
	const (
		accessToken  = "access-token-secret"
		jsonSecret   = "json-token-secret"
		formSecret   = "form-password-secret"
		bearerSecret = "bearer-token-secret"
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v3/auth/user/login":
			writeAuthLifecycleJSON(w, map[string]any{
				"accessToken": accessToken,
				"tokenTtl":    3600,
			})
		case nacosV3ReadinessPath:
			writeAuthLifecycleJSON(w, map[string]any{
				"code":    0,
				"message": "success",
				"data":    "ok",
			})
		case routesForNacosAPI(nacosAPIV3).namespaceList:
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprintf(
				w,
				`request failed: url=/namespace?accessToken=%s&group=DEFAULT_GROUP `+
					`json={"refreshToken":"%s","message":"keep-json"} `+
					`form=password=%s&reason=denied `+
					`Authorization: Bearer %s; ordinary token and password words remain`,
				url.QueryEscape(accessToken),
				jsonSecret,
				url.QueryEscape(formSecret),
				bearerSecret,
			)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := authLifecycleServerConfig(t, server)
	config.User = "nacos"
	config.Password = formSecret
	client := &ClientImpl{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	_, err := client.ListNamespaces(context.Background())
	if err == nil {
		t.Fatal("ListNamespaces unexpectedly succeeded")
	}
	if status, ok := HTTPStatusCode(err); !ok || status != http.StatusBadGateway {
		t.Fatalf("HTTPStatusCode(%v) = %d, %v; want 502, true", err, status, ok)
	}
	message := err.Error()
	for _, secret := range []string{accessToken, jsonSecret, formSecret, bearerSecret} {
		if strings.Contains(message, secret) || strings.Contains(message, url.QueryEscape(secret)) {
			t.Fatalf("HTTP error leaked %q: %s", secret, message)
		}
	}
	for _, diagnostic := range []string{
		"group=DEFAULT_GROUP",
		`"message":"keep-json"`,
		"reason=denied",
		"ordinary token and password words remain",
	} {
		if !strings.Contains(message, diagnostic) {
			t.Fatalf("HTTP error dropped non-sensitive diagnostic %q: %s", diagnostic, message)
		}
	}
}

func TestNacosAPIErrorRedactsStructuredSecrets(t *testing.T) {
	const (
		accessToken = "api-error-access-token"
		apiSecret   = "api-error-json-secret"
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v3/auth/user/login":
			writeAuthLifecycleJSON(w, map[string]any{
				"accessToken": accessToken,
				"tokenTtl":    3600,
			})
		case nacosV3ReadinessPath:
			writeAuthLifecycleJSON(w, map[string]any{
				"code":    0,
				"message": "success",
				"data":    "ok",
			})
		case routesForNacosAPI(nacosAPIV3).namespaceList:
			writeAuthLifecycleJSON(w, map[string]any{
				"code": 500,
				"message": fmt.Sprintf(
					`upstream rejected /namespace?accessToken=%s payload={"secret":"%s"}; keep api diagnostic %s OMITTED_TAIL`,
					url.QueryEscape(accessToken),
					apiSecret,
					strings.Repeat("x", 500),
				),
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := authLifecycleServerConfig(t, server)
	config.User = "nacos"
	config.Password = "nacos-password"
	client := &ClientImpl{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	_, err := client.ListNamespaces(context.Background())
	if err == nil {
		t.Fatal("ListNamespaces unexpectedly succeeded")
	}
	message := err.Error()
	for _, secret := range []string{accessToken, apiSecret} {
		if strings.Contains(message, secret) || strings.Contains(message, url.QueryEscape(secret)) {
			t.Fatalf("API error leaked %q: %s", secret, message)
		}
	}
	if !strings.Contains(message, "keep api diagnostic") {
		t.Fatalf("API error dropped non-sensitive diagnostic: %s", message)
	}
	if strings.Contains(message, "OMITTED_TAIL") {
		t.Fatalf("API error message was not bounded: %s", message)
	}
}

func TestShortLivedAuthTokenIsReusedUntilDynamicRefreshWindow(t *testing.T) {
	const accessToken = "short-lived-token"
	var loginRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v3/auth/user/login":
			loginRequests.Add(1)
			writeAuthLifecycleJSON(w, map[string]any{
				"accessToken": accessToken,
				"tokenTtl":    30,
			})
		case nacosV3ReadinessPath:
			writeAuthLifecycleJSON(w, map[string]any{
				"code":    0,
				"message": "success",
				"data":    "ok",
			})
		case routesForNacosAPI(nacosAPIV3).namespaceList:
			if got := request.URL.Query().Get("accessToken"); got != accessToken {
				t.Errorf("namespace accessToken = %q, want %q", got, accessToken)
			}
			writeAuthLifecycleJSON(w, map[string]any{
				"code":    0,
				"message": "success",
				"data":    []any{},
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := authLifecycleServerConfig(t, server)
	config.User = "nacos"
	config.Password = "nacos-password"
	client := &ClientImpl{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	if _, err := client.ListNamespaces(context.Background()); err != nil {
		t.Fatalf("ListNamespaces: %v", err)
	}
	if got := loginRequests.Load(); got != 1 {
		t.Fatalf("login requests = %d, want 1 before the dynamic refresh window", got)
	}
}

func TestTruncateForErrorPreservesUTF8(t *testing.T) {
	result := truncateForError(strings.Repeat("a", 399) + "界")
	if !utf8.ValidString(result) {
		t.Fatalf("truncateForError returned invalid UTF-8: %q", result)
	}
	if !strings.HasSuffix(result, "...") {
		t.Fatalf("truncateForError result = %q, want truncation suffix", result)
	}
}

func TestLocalizedNacosBackendDiagnosticsAreSanitized(t *testing.T) {
	tests := []struct {
		name       string
		key        string
		params     map[string]any
		secret     string
		diagnostic string
	}{
		{
			name: "detail",
			key:  "nacos.backend.error.request_failed",
			params: map[string]any{
				"detail": "proxy failed Authorization: Basic detail-secret; keep-detail",
			},
			secret:     "detail-secret",
			diagnostic: "keep-detail",
		},
		{
			name: "body",
			key:  "nacos.backend.error.http_status",
			params: map[string]any{
				"status": 502,
				"body":   "upstream password=body-secret&reason=keep-body",
			},
			secret:     "body-secret",
			diagnostic: "reason=keep-body",
		},
		{
			name: "message",
			key:  "nacos.backend.error.api_code",
			params: map[string]any{
				"code":    500,
				"message": `upstream {"refreshToken":"message-secret"} keep-message`,
			},
			secret:     "message-secret",
			diagnostic: "keep-message",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := localizedNacosBackendError(test.key, test.params).Error()
			if strings.Contains(message, test.secret) {
				t.Fatalf("localized diagnostic leaked %q: %s", test.secret, message)
			}
			if !strings.Contains(message, test.diagnostic) {
				t.Fatalf("localized diagnostic dropped %q: %s", test.diagnostic, message)
			}
		})
	}
}

func TestLocalizedNacosBackendErrorPreservesStructuredClassification(t *testing.T) {
	httpErr := localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
		"status": http.StatusForbidden,
		"body":   "permission denied",
	})
	if status, ok := HTTPStatusCode(fmt.Errorf("wrapped: %w", httpErr)); !ok || status != http.StatusForbidden {
		t.Fatalf("HTTPStatusCode(%v) = %d, %v; want 403, true", httpErr, status, ok)
	}

	notFoundErr := localizedNacosBackendError("nacos.backend.error.config_not_found", map[string]any{
		"group":  "DEFAULT_GROUP",
		"dataId": "application.yaml",
	})
	if !IsConfigNotFound(fmt.Errorf("wrapped: %w", notFoundErr)) {
		t.Fatalf("IsConfigNotFound(%v) = false, want true", notFoundErr)
	}
	if IsConfigNotFound(errors.New("upstream config not found in an unrelated diagnostic")) {
		t.Fatal("IsConfigNotFound classified an untyped diagnostic as missing")
	}
}

func TestAuthSingleflightSharesOneLogin(t *testing.T) {
	const callers = 16
	loginStarted := make(chan struct{})
	releaseLogin := make(chan struct{})
	var (
		loginCalls  atomic.Int32
		startedOnce sync.Once
		releaseOnce sync.Once
	)
	release := func() {
		releaseOnce.Do(func() { close(releaseLogin) })
	}
	defer release()

	client := newManualAuthLifecycleClient(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/nacos/v3/auth/user/login" {
			return nil, fmt.Errorf("unexpected request: %s", request.URL.Path)
		}
		loginCalls.Add(1)
		startedOnce.Do(func() { close(loginStarted) })
		<-releaseLogin
		return authLifecycleResponse(http.StatusOK, `{"accessToken":"shared-token","tokenTtl":3600}`), nil
	}), "")
	defer client.Close()

	start := make(chan struct{})
	results := make(chan error, callers)
	var workers sync.WaitGroup
	workers.Add(callers)
	for range callers {
		go func() {
			defer workers.Done()
			<-start
			results <- client.ensureAuth(context.Background())
		}()
	}
	close(start)
	waitAuthLifecycleSignal(t, loginStarted, "shared login start")
	release()

	done := make(chan struct{})
	go func() {
		workers.Wait()
		close(done)
	}()
	waitAuthLifecycleSignal(t, done, "all auth waiters")
	close(results)
	for err := range results {
		if err != nil {
			t.Errorf("ensureAuth: %v", err)
		}
	}
	if got := loginCalls.Load(); got != 1 {
		t.Fatalf("login requests = %d, want 1", got)
	}
	client.mu.Lock()
	token := client.accessToken
	client.mu.Unlock()
	if token != "shared-token" {
		t.Fatalf("access token = %q, want shared-token", token)
	}
}

func TestAuthCallerCancellationDoesNotCancelSharedLogin(t *testing.T) {
	loginStarted := make(chan struct{})
	releaseLogin := make(chan struct{})
	var (
		loginCalls  atomic.Int32
		startedOnce sync.Once
		releaseOnce sync.Once
	)
	release := func() {
		releaseOnce.Do(func() { close(releaseLogin) })
	}
	defer release()

	client := newManualAuthLifecycleClient(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		loginCalls.Add(1)
		startedOnce.Do(func() { close(loginStarted) })
		select {
		case <-releaseLogin:
			return authLifecycleResponse(http.StatusOK, `{"accessToken":"surviving-token","tokenTtl":3600}`), nil
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
	}), "")
	defer client.Close()

	firstCtx, cancelFirst := context.WithCancel(context.Background())
	firstResult := make(chan error, 1)
	go func() {
		firstResult <- client.ensureAuth(firstCtx)
	}()
	waitAuthLifecycleSignal(t, loginStarted, "login start")

	secondResult := make(chan error, 1)
	go func() {
		secondResult <- client.ensureAuth(context.Background())
	}()
	cancelFirst()
	if err := waitAuthLifecycleError(t, firstResult, "canceled auth caller"); !errors.Is(err, context.Canceled) {
		t.Fatalf("first ensureAuth error = %v, want context.Canceled", err)
	}

	release()
	if err := waitAuthLifecycleError(t, secondResult, "surviving auth caller"); err != nil {
		t.Fatalf("second ensureAuth: %v", err)
	}
	if got := loginCalls.Load(); got != 1 {
		t.Fatalf("login requests = %d, want 1", got)
	}
}

func TestAuthClosePreventsLateLoginFromOverwritingReconnect(t *testing.T) {
	oldLoginStarted := make(chan struct{})
	releaseOldLogin := make(chan struct{})
	var (
		oldLoginCalls atomic.Int32
		startedOnce   sync.Once
		releaseOnce   sync.Once
	)
	release := func() {
		releaseOnce.Do(func() { close(releaseOldLogin) })
	}
	defer release()

	client := newManualAuthLifecycleClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		oldLoginCalls.Add(1)
		startedOnce.Do(func() { close(oldLoginStarted) })
		// Intentionally ignore request cancellation to exercise the generation guard.
		<-releaseOldLogin
		return authLifecycleResponse(http.StatusOK, `{"accessToken":"late-old-token","tokenTtl":3600}`), nil
	}), "")

	oldResult := make(chan error, 1)
	go func() {
		oldResult <- client.ensureAuth(context.Background())
	}()
	waitAuthLifecycleSignal(t, oldLoginStarted, "old login start")
	if err := client.Close(); err != nil {
		t.Fatalf("Close old lifecycle: %v", err)
	}

	var newLoginCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v3/auth/user/login":
			newLoginCalls.Add(1)
			writeAuthLifecycleJSON(w, map[string]any{
				"accessToken": "new-generation-token",
				"tokenTtl":    3600,
			})
		case nacosV3ReadinessPath:
			writeAuthLifecycleJSON(w, map[string]any{
				"code":    0,
				"message": "success",
				"data":    "ok",
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	config := authLifecycleServerConfig(t, server)
	config.User = "new-user"
	config.Password = "new-password"
	if err := client.Connect(config); err != nil {
		t.Fatalf("Connect new lifecycle: %v", err)
	}
	defer client.Close()

	release()
	if err := waitAuthLifecycleError(t, oldResult, "old login completion"); !errors.Is(err, context.Canceled) {
		t.Fatalf("old ensureAuth error = %v, want context.Canceled", err)
	}
	client.mu.Lock()
	token := client.accessToken
	client.mu.Unlock()
	if token != "new-generation-token" {
		t.Fatalf("access token after old login completed = %q, want new-generation-token", token)
	}
	if got := oldLoginCalls.Load(); got != 1 {
		t.Fatalf("old login requests = %d, want 1", got)
	}
	if got := newLoginCalls.Load(); got != 1 {
		t.Fatalf("new login requests = %d, want 1", got)
	}
}

func TestLateUnauthorizedDoesNotInvalidateRefreshedToken(t *testing.T) {
	tests := []struct {
		name        string
		requestPath string
		invoke      func(*ClientImpl) error
	}{
		{
			name:        "ordinary request",
			requestPath: "/nacos/test-resource",
			invoke: func(client *ClientImpl) error {
				_, status, err := client.doRequest(context.Background(), http.MethodGet, "/test-resource", nil, nil)
				if err != nil {
					return err
				}
				if status != http.StatusOK {
					return fmt.Errorf("status = %d, want 200", status)
				}
				return nil
			},
		},
		{
			name:        "long listener",
			requestPath: "/nacos/v1/cs/configs/listener",
			invoke: func(client *ClientImpl) error {
				_, err := client.ListenOnce(context.Background(), []ConfigListenTarget{{
					DataID:      "application.yaml",
					Group:       "DEFAULT_GROUP",
					NamespaceID: "dev",
					ContentMD5:  ContentMD5("old"),
				}}, minListenTimeoutMs)
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			firstOldRelease := make(chan struct{})
			secondOldRelease := make(chan struct{})
			secondOldStarted := make(chan struct{})
			firstNewTokenRequest := make(chan struct{})
			var (
				oldRequests       atomic.Int32
				newTokenRequests  atomic.Int32
				loginRequests     atomic.Int32
				secondStartedOnce sync.Once
				newTokenSeenOnce  sync.Once
				firstReleaseOnce  sync.Once
				secondReleaseOnce sync.Once
			)
			releaseFirst := func() {
				firstReleaseOnce.Do(func() { close(firstOldRelease) })
			}
			releaseSecond := func() {
				secondReleaseOnce.Do(func() { close(secondOldRelease) })
			}
			defer releaseFirst()
			defer releaseSecond()

			client := newManualAuthLifecycleClient(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
				switch request.URL.Path {
				case "/nacos/v3/auth/user/login":
					loginRequests.Add(1)
					return authLifecycleResponse(
						http.StatusOK,
						`{"accessToken":"token-2","tokenTtl":3600}`,
					), nil
				case test.requestPath:
					switch request.URL.Query().Get("accessToken") {
					case "token-1":
						sequence := oldRequests.Add(1)
						switch sequence {
						case 1:
							<-firstOldRelease
						case 2:
							secondStartedOnce.Do(func() { close(secondOldStarted) })
							<-secondOldRelease
						default:
							return nil, fmt.Errorf("unexpected old-token request #%d", sequence)
						}
						return authLifecycleResponse(http.StatusUnauthorized, "expired token"), nil
					case "token-2":
						newTokenRequests.Add(1)
						newTokenSeenOnce.Do(func() { close(firstNewTokenRequest) })
						return authLifecycleResponse(http.StatusOK, ""), nil
					default:
						return nil, fmt.Errorf(
							"unexpected access token %q",
							request.URL.Query().Get("accessToken"),
						)
					}
				default:
					return nil, fmt.Errorf("unexpected request: %s", request.URL.Path)
				}
			}), "token-1")
			defer client.Close()

			start := make(chan struct{})
			results := make(chan error, 2)
			for range 2 {
				go func() {
					<-start
					results <- test.invoke(client)
				}()
			}
			close(start)
			waitAuthLifecycleSignal(t, secondOldStarted, "both old-token requests")
			releaseFirst()
			waitAuthLifecycleSignal(t, firstNewTokenRequest, "first refreshed-token retry")
			releaseSecond()

			for range 2 {
				if err := waitAuthLifecycleError(t, results, "request result"); err != nil {
					t.Errorf("request failed: %v", err)
				}
			}
			if got := oldRequests.Load(); got != 2 {
				t.Fatalf("old-token requests = %d, want 2", got)
			}
			if got := newTokenRequests.Load(); got != 2 {
				t.Fatalf("new-token requests = %d, want 2", got)
			}
			if got := loginRequests.Load(); got != 1 {
				t.Fatalf("login requests = %d, want 1", got)
			}
			client.mu.Lock()
			token := client.accessToken
			client.mu.Unlock()
			if token != "token-2" {
				t.Fatalf("access token = %q, want token-2", token)
			}
		})
	}
}

func newManualAuthLifecycleClient(
	t *testing.T,
	transport http.RoundTripper,
	accessToken string,
) *ClientImpl {
	t.Helper()
	baseURL, err := url.Parse("http://nacos.example.test/nacos")
	if err != nil {
		t.Fatal(err)
	}
	expiry := time.Time{}
	if accessToken != "" {
		expiry = time.Now().Add(time.Hour)
	}
	return &ClientImpl{
		config: connection.ConnectionConfig{
			Type:     "nacos",
			User:     "nacos",
			Password: "nacos-password",
			Timeout:  2,
		},
		httpClient:  &http.Client{Transport: transport},
		baseURL:     baseURL,
		apiFamily:   nacosAPIV1,
		accessToken: accessToken,
		tokenExpiry: expiry,
	}
}

func authLifecycleServerConfig(t *testing.T, server *httptest.Server) connection.ConnectionConfig {
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
		Timeout:          2,
		ConnectionParams: "contextPath=/",
	}
}

func authLifecycleResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func writeAuthLifecycleJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func waitAuthLifecycleSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func waitAuthLifecycleError(t *testing.T, result <-chan error, label string) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
		return nil
	}
}
