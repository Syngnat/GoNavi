package app

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
)

type globalProxySnapshot struct {
	Enabled bool                   `json:"enabled"`
	Proxy   connection.ProxyConfig `json:"proxy"`
}

var globalProxyRuntime = struct {
	mu      sync.RWMutex
	enabled bool
	proxy   connection.ProxyConfig
}{}

type localProxyTLSFallbackTransport struct {
	primary       *http.Transport
	fallback      *http.Transport
	proxyEndpoint string
}

func currentGlobalProxyConfig() globalProxySnapshot {
	globalProxyRuntime.mu.RLock()
	defer globalProxyRuntime.mu.RUnlock()
	if !globalProxyRuntime.enabled {
		return globalProxySnapshot{
			Enabled: false,
			Proxy:   connection.ProxyConfig{},
		}
	}
	return globalProxySnapshot{
		Enabled: true,
		Proxy:   globalProxyRuntime.proxy,
	}
}

func setGlobalProxyConfig(enabled bool, proxyConfig connection.ProxyConfig) (globalProxySnapshot, error) {
	if !enabled {
		globalProxyRuntime.mu.Lock()
		globalProxyRuntime.enabled = false
		globalProxyRuntime.proxy = connection.ProxyConfig{}
		globalProxyRuntime.mu.Unlock()
		return currentGlobalProxyConfig(), nil
	}

	normalizedProxy, err := proxytunnel.NormalizeConfig(proxyConfig)
	if err != nil {
		return globalProxySnapshot{}, err
	}

	globalProxyRuntime.mu.Lock()
	globalProxyRuntime.enabled = true
	globalProxyRuntime.proxy = normalizedProxy
	globalProxyRuntime.mu.Unlock()
	return currentGlobalProxyConfig(), nil
}

func (a *App) ConfigureGlobalProxy(enabled bool, proxyConfig connection.ProxyConfig) connection.QueryResult {
	before := currentGlobalProxyConfig()
	snapshot, err := setGlobalProxyConfig(enabled, proxyConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	// 前端可能在同一配置下重复触发同步（例如严格模式或状态回放），
	// 这里做幂等日志，避免重复刷屏。
	if !globalProxySnapshotEqual(before, snapshot) {
		if snapshot.Enabled {
			authState := ""
			if strings.TrimSpace(snapshot.Proxy.User) != "" {
				authState = "（认证：已配置）"
			}
			logger.Infof(
				"全局代理已启用：%s://%s:%d%s",
				strings.ToLower(strings.TrimSpace(snapshot.Proxy.Type)),
				strings.TrimSpace(snapshot.Proxy.Host),
				snapshot.Proxy.Port,
				authState,
			)
		} else {
			logger.Infof("全局代理已关闭")
		}
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.proxy.message.config_applied", nil),
		Data:    snapshot,
	}
}

func globalProxySnapshotEqual(a, b globalProxySnapshot) bool {
	if a.Enabled != b.Enabled {
		return false
	}
	if !a.Enabled {
		return true
	}
	return proxyConfigEqual(a.Proxy, b.Proxy)
}

func proxyConfigEqual(a, b connection.ProxyConfig) bool {
	return strings.EqualFold(strings.TrimSpace(a.Type), strings.TrimSpace(b.Type)) &&
		strings.TrimSpace(a.Host) == strings.TrimSpace(b.Host) &&
		a.Port == b.Port &&
		strings.TrimSpace(a.User) == strings.TrimSpace(b.User) &&
		a.Password == b.Password
}

func currentGlobalProxyView() connection.GlobalProxyView {
	snapshot := currentGlobalProxyConfig()
	if !snapshot.Enabled {
		return connection.GlobalProxyView{Enabled: false}
	}
	return connection.GlobalProxyView{
		Enabled:     true,
		Type:        snapshot.Proxy.Type,
		Host:        snapshot.Proxy.Host,
		Port:        snapshot.Proxy.Port,
		User:        snapshot.Proxy.User,
		HasPassword: strings.TrimSpace(snapshot.Proxy.Password) != "",
	}
}

func (a *App) GetGlobalProxyConfig() connection.QueryResult {
	if strings.TrimSpace(a.configDir) == "" {
		a.configDir = resolveAppConfigDir()
	}
	if view, err := a.loadStoredGlobalProxyView(); err == nil {
		return connection.QueryResult{
			Success: true,
			Message: "OK",
			Data:    sanitizeGlobalProxyView(view),
		}
	} else if !os.IsNotExist(err) {
		logger.Error(err, "加载全局代理元数据失败")
	}
	return connection.QueryResult{
		Success: true,
		Message: "OK",
		Data:    currentGlobalProxyView(),
	}
}

func newHTTPClientWithGlobalProxy(timeout time.Duration) *http.Client {
	client := &http.Client{
		Timeout: timeout,
	}
	if transport := buildHTTPTransportWithGlobalProxy(); transport != nil {
		client.Transport = transport
	}
	return client
}

func newStrictHTTPClientWithGlobalProxy(timeout time.Duration) *http.Client {
	client := &http.Client{
		Timeout:       timeout,
		CheckRedirect: strictHTTPSRedirectPolicy,
	}
	if transport := buildStrictHTTPTransportWithGlobalProxy(); transport != nil {
		client.Transport = transport
	}
	return client
}

func strictHTTPSRedirectPolicy(req *http.Request, via []*http.Request) error {
	if req == nil || req.URL == nil || !strings.EqualFold(req.URL.Scheme, "https") {
		return errors.New("refusing non-HTTPS redirect for update or driver download")
	}
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	return nil
}

func (a *App) ensurePersistedGlobalProxyRuntime() {
	if currentGlobalProxyConfig().Enabled {
		return
	}
	if strings.TrimSpace(a.configDir) == "" {
		a.configDir = resolveAppConfigDir()
	}
	view, err := a.loadStoredGlobalProxyView()
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Error(err, "加载全局代理元数据失败")
		}
		return
	}
	if !view.Enabled {
		return
	}
	proxyConfig, err := a.resolveStoredGlobalProxyRuntimeConfig(view)
	if err != nil {
		logger.Error(err, "恢复全局代理运行时配置失败")
		return
	}
	if _, err := setGlobalProxyConfig(true, proxyConfig); err != nil {
		logger.Error(err, "恢复全局代理运行时配置失败")
	}
}

func buildHTTPTransportWithGlobalProxy() http.RoundTripper {
	baseTransport, ok := http.DefaultTransport.(*http.Transport)
	if !ok || baseTransport == nil {
		return nil
	}

	transport := baseTransport.Clone()
	snapshot := currentGlobalProxyConfig()
	if !snapshot.Enabled {
		transport.Proxy = http.ProxyFromEnvironment
		return transport
	}

	transportWithProxy, err := buildHTTPTransportForProxyConfig(snapshot.Proxy)
	if err != nil {
		logger.Warnf("全局代理配置无效，回退系统代理：%v", err)
		transport.Proxy = http.ProxyFromEnvironment
		return transport
	}
	return transportWithProxy
}

func buildStrictHTTPTransportWithGlobalProxy() http.RoundTripper {
	baseTransport, ok := http.DefaultTransport.(*http.Transport)
	if !ok || baseTransport == nil {
		return nil
	}
	transport := baseTransport.Clone()
	snapshot := currentGlobalProxyConfig()
	if !snapshot.Enabled {
		transport.Proxy = http.ProxyFromEnvironment
		return transport
	}
	proxyURL, err := buildProxyURLFromConfig(snapshot.Proxy)
	if err != nil {
		logger.Warnf("全局代理配置无效，严格 TLS 请求回退系统代理：%v", err)
		transport.Proxy = http.ProxyFromEnvironment
		return transport
	}
	transport.Proxy = http.ProxyURL(proxyURL)
	// Update and driver downloads must always use the platform trust store,
	// including when the destination is an HTTPS IP with an IP SAN certificate.
	return transport
}

func buildHTTPTransportForProxyConfig(proxyConfig connection.ProxyConfig) (http.RoundTripper, error) {
	baseTransport, ok := http.DefaultTransport.(*http.Transport)
	if !ok || baseTransport == nil {
		return nil, fmt.Errorf("default HTTP transport unavailable")
	}

	transport := baseTransport.Clone()
	proxyURL, err := buildProxyURLFromConfig(proxyConfig)
	if err != nil {
		return nil, err
	}
	transport.Proxy = http.ProxyURL(proxyURL)
	if !isLoopbackProxyHost(proxyConfig.Host) {
		return transport, nil
	}

	fallbackTransport := transport.Clone()
	fallbackTransport.TLSClientConfig = cloneTLSConfigWithInsecureSkipVerify(fallbackTransport.TLSClientConfig)
	return &localProxyTLSFallbackTransport{
		primary:       transport,
		fallback:      fallbackTransport,
		proxyEndpoint: proxyURL.Redacted(),
	}, nil
}

func (t *localProxyTLSFallbackTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.primary.RoundTrip(req)
	if err == nil {
		return resp, nil
	}
	if !isTLSFallbackCandidate(req.Method, err) {
		return nil, err
	}

	retryReq, cloneErr := cloneRequestForRetry(req)
	if cloneErr != nil {
		return nil, err
	}
	logger.Warnf("检测到本地代理 TLS 证书不受信任，启用兼容回退：代理=%s 目标=%s 错误=%v", t.proxyEndpoint, req.URL.String(), err)
	return t.fallback.RoundTrip(retryReq)
}

func isTLSFallbackCandidate(method string, err error) bool {
	if !isIdempotentRequestMethod(method) {
		return false
	}
	return isUnknownAuthorityError(err)
}

func isIdempotentRequestMethod(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodGet, http.MethodHead:
		return true
	default:
		return false
	}
}

func cloneRequestForRetry(req *http.Request) (*http.Request, error) {
	cloned := req.Clone(req.Context())
	if req.Body == nil || req.Body == http.NoBody {
		return cloned, nil
	}
	if req.GetBody == nil {
		return nil, fmt.Errorf("request body not replayable")
	}
	body, err := req.GetBody()
	if err != nil {
		return nil, err
	}
	cloned.Body = body
	return cloned, nil
}

func isUnknownAuthorityError(err error) bool {
	var unknownErr x509.UnknownAuthorityError
	if errors.As(err, &unknownErr) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "x509: certificate signed by unknown authority")
}

func cloneTLSConfigWithInsecureSkipVerify(base *tls.Config) *tls.Config {
	if base == nil {
		return &tls.Config{InsecureSkipVerify: true}
	}
	cloned := base.Clone()
	cloned.InsecureSkipVerify = true
	return cloned
}

func isLoopbackProxyHost(host string) bool {
	trimmed := strings.TrimSpace(host)
	if trimmed == "" {
		return false
	}
	if strings.EqualFold(trimmed, "localhost") {
		return true
	}
	ip := net.ParseIP(trimmed)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

func buildProxyURLFromConfig(proxyConfig connection.ProxyConfig) (*url.URL, error) {
	normalizedProxy, err := proxytunnel.NormalizeConfig(proxyConfig)
	if err != nil {
		return nil, err
	}

	proxyType := strings.ToLower(strings.TrimSpace(normalizedProxy.Type))
	if proxyType != "http" && proxyType != "socks5" {
		return nil, fmt.Errorf("unsupported proxy type: %s", normalizedProxy.Type)
	}
	if strings.TrimSpace(normalizedProxy.Host) == "" {
		return nil, fmt.Errorf("proxy host is empty")
	}
	if normalizedProxy.Port <= 0 || normalizedProxy.Port > 65535 {
		return nil, fmt.Errorf("invalid proxy port: %d", normalizedProxy.Port)
	}

	proxyURL := &url.URL{
		Scheme: proxyType,
		Host:   net.JoinHostPort(strings.TrimSpace(normalizedProxy.Host), strconv.Itoa(normalizedProxy.Port)),
	}
	if strings.TrimSpace(normalizedProxy.User) != "" {
		proxyURL.User = url.UserPassword(strings.TrimSpace(normalizedProxy.User), normalizedProxy.Password)
	}
	return proxyURL, nil
}

func (a *App) TestGlobalProxyConnection(input connection.TestGlobalProxyInput) connection.QueryResult {
	started := time.Now()
	targetURL, err := normalizeGlobalProxyTestURL(input.URL)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizedGlobalProxyTestError(err)}
	}

	timeoutSeconds := input.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 8
	}
	if timeoutSeconds > 30 {
		timeoutSeconds = 30
	}

	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}
	if input.Proxy.Enabled {
		proxyPassword, err := a.resolveGlobalProxyPasswordForInput(input.Proxy)
		if err != nil {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.proxy.backend.message.test_failed", map[string]any{
					"url":    targetURL,
					"detail": err.Error(),
				}),
			}
		}
		transport, err := buildHTTPTransportForProxyConfig(connection.ProxyConfig{
			Type:     input.Proxy.Type,
			Host:     input.Proxy.Host,
			Port:     input.Proxy.Port,
			User:     input.Proxy.User,
			Password: proxyPassword,
		})
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		client.Transport = transport
	}

	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	req.Header.Set("User-Agent", "GoNavi-Proxy-Test")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Range", "bytes=0-0")

	resp, err := client.Do(req)
	durationMs := time.Since(started).Milliseconds()
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.proxy.backend.message.test_failed", map[string]any{
				"url":    targetURL,
				"detail": err.Error(),
			}),
			Data: connection.GlobalProxyTestResult{
				URL:        targetURL,
				DurationMs: durationMs,
				ViaProxy:   input.Proxy.Enabled,
			},
		}
	}
	defer resp.Body.Close()
	_, _ = io.CopyN(io.Discard, resp.Body, 512)

	result := connection.GlobalProxyTestResult{
		URL:        targetURL,
		FinalURL:   resp.Request.URL.String(),
		StatusCode: resp.StatusCode,
		Status:     resp.Status,
		DurationMs: durationMs,
		ViaProxy:   input.Proxy.Enabled,
	}
	messageKey := "app.proxy.backend.message.test_success"
	if resp.StatusCode >= http.StatusBadRequest {
		messageKey = "app.proxy.backend.message.test_http_status"
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText(messageKey, map[string]any{
			"status":   resp.StatusCode,
			"duration": durationMs,
			"url":      targetURL,
		}),
		Data: result,
	}
}

func (a *App) resolveGlobalProxyPasswordForInput(input connection.SaveGlobalProxyInput) (string, error) {
	if strings.TrimSpace(input.Password) != "" {
		return input.Password, nil
	}
	if input.ClearPassword {
		return "", nil
	}
	if strings.TrimSpace(a.configDir) == "" {
		a.configDir = resolveAppConfigDir()
	}
	existing, err := a.loadStoredGlobalProxyView()
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if !existing.HasPassword {
		return "", nil
	}
	bundle, err := a.loadGlobalProxySecretBundle(existing)
	if err != nil {
		return "", err
	}
	return bundle.Password, nil
}

func normalizeGlobalProxyTestURL(rawURL string) (string, error) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return "", localizedUpdateError{key: "app.proxy.backend.error.test_url_empty"}
	}
	if !strings.Contains(trimmed, "://") {
		trimmed = "https://" + trimmed
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", localizedUpdateError{
			key:    "app.proxy.backend.error.test_url_invalid",
			params: map[string]any{"detail": err.Error()},
		}
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
	default:
		return "", localizedUpdateError{
			key:    "app.proxy.backend.error.test_scheme_unsupported",
			params: map[string]any{"scheme": parsed.Scheme},
		}
	}
	if strings.TrimSpace(parsed.Host) == "" {
		return "", localizedUpdateError{key: "app.proxy.backend.error.test_host_missing"}
	}
	return parsed.String(), nil
}

func (a *App) localizedGlobalProxyTestError(err error) string {
	var localized localizedUpdateError
	if errors.As(err, &localized) {
		return a.appText(localized.key, localized.params)
	}
	return err.Error()
}
