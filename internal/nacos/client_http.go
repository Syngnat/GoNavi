package nacos

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/tlsconfig"
)

func (c *ClientImpl) doRequest(ctx context.Context, method, apiPath string, query url.Values, form url.Values) ([]byte, int, error) {
	return c.doRequestWithHeaders(ctx, method, apiPath, query, form, nil)
}

func (c *ClientImpl) doRequestWithHeaders(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	headers http.Header,
) ([]byte, int, error) {
	if err := c.ensureAuth(ctx); err != nil {
		return nil, 0, err
	}
	response, err := c.doRequestRawWithHeadersResult(ctx, method, apiPath, query, form, headers, true)
	if err != nil {
		return nil, response.status, err
	}
	if response.status == http.StatusForbidden || response.status == http.StatusUnauthorized {
		retry, authErr := c.reauthenticateAfterUnauthorized(ctx, response.usedToken)
		if authErr != nil {
			return nil, response.status, authErr
		}
		if retry {
			response, err = c.doRequestRawWithHeadersResult(ctx, method, apiPath, query, form, headers, true)
			if err != nil {
				return nil, response.status, err
			}
		}
	}
	return response.body, response.status, nil
}

func (c *ClientImpl) reauthenticateAfterUnauthorized(
	ctx context.Context,
	usedToken nacosTokenSnapshot,
) (bool, error) {
	if strings.TrimSpace(usedToken.value) == "" {
		return false, nil
	}

	c.mu.Lock()
	if c.lifecycleGeneration != usedToken.generation {
		c.mu.Unlock()
		return false, nil
	}
	if c.accessToken == usedToken.value {
		c.accessToken = ""
		c.tokenExpiry = time.Time{}
		c.tokenRefreshAt = time.Time{}
	}
	c.mu.Unlock()

	if err := c.ensureAuth(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (c *ClientImpl) doRequestRaw(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	withToken bool,
) ([]byte, int, error) {
	return c.doRequestRawWithHeaders(ctx, method, apiPath, query, form, nil, withToken)
}

func (c *ClientImpl) doRequestRawWithHeaders(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	headers http.Header,
	withToken bool,
) ([]byte, int, error) {
	response, err := c.doRequestRawWithHeadersResult(ctx, method, apiPath, query, form, headers, withToken)
	return response.body, response.status, err
}

func (c *ClientImpl) doRequestRawWithHeadersResult(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	headers http.Header,
	withToken bool,
) (nacosRawResponse, error) {
	c.mu.Lock()
	httpClient := c.httpClient
	baseURL := c.baseURL
	requestHost := c.requestHost
	token := c.accessToken
	generation := c.lifecycleGeneration
	c.mu.Unlock()
	result := nacosRawResponse{
		usedToken: nacosTokenSnapshot{
			value:      token,
			generation: generation,
		},
	}

	if httpClient == nil || baseURL == nil {
		return result, localizedNacosBackendError("nacos.backend.error.not_connected", nil)
	}

	rel := &url.URL{Path: joinAPIPath(baseURL.Path, apiPath)}
	if query == nil {
		query = url.Values{}
	}
	if withToken && strings.TrimSpace(token) != "" {
		query.Set("accessToken", token)
	}
	rel.RawQuery = query.Encode()
	fullURL := baseURL.ResolveReference(rel).String()

	var bodyReader io.Reader
	contentType := ""
	if form != nil {
		bodyReader = strings.NewReader(form.Encode())
		contentType = "application/x-www-form-urlencoded"
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, bodyReader)
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.build_request", map[string]any{
			"detail": err.Error(),
		})
	}
	if requestHost != "" {
		req.Host = requestHost
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "*/*")
	for name, values := range headers {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}

	startedAt := time.Now()
	resp, err := httpClient.Do(req)
	if err != nil {
		return result, c.requestFailedError(err, token, startedAt)
	}
	defer resp.Body.Close()
	result.status = resp.StatusCode

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.read_body", map[string]any{
			"detail": err.Error(),
		})
	}
	result.body = body
	return result, nil
}

func redactNacosAccessToken(detail, token string) string {
	detail = redactNacosErrorText(detail)
	if strings.TrimSpace(token) == "" {
		return detail
	}
	redacted := strings.ReplaceAll(detail, url.QueryEscape(token), "[REDACTED]")
	return strings.ReplaceAll(redacted, token, "[REDACTED]")
}

func redactNacosErrorText(text string) string {
	redacted := nacosJSONSecretPattern.ReplaceAllString(text, `${1}[REDACTED]${3}`)
	redacted = nacosAuthorizationPattern.ReplaceAllString(redacted, `${1}[REDACTED]`)
	redacted = nacosSecretAssignmentPattern.ReplaceAllString(redacted, `${1}[REDACTED]`)
	return nacosBearerPattern.ReplaceAllString(redacted, `${1}[REDACTED]`)
}

func normalizeNacosConfig(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
	run := config
	run.Type = "nacos"
	run.Host = strings.TrimSpace(run.Host)
	if run.Host == "" {
		return run, localizedNacosBackendError("nacos.backend.error.host_required", nil)
	}
	if run.Port <= 0 {
		run.Port = defaultNacosPort
	}
	if run.Timeout <= 0 {
		run.Timeout = int(defaultNacosTimeout / time.Second)
	}
	return run, nil
}

func buildNacosHTTPClient(config connection.ConnectionConfig) (*http.Client, *url.URL, error) {
	return buildNacosHTTPClientWithDialAddress(config, "")
}

func buildNacosHTTPClientWithDialAddress(
	config connection.ConnectionConfig,
	dialAddress string,
) (*http.Client, *url.URL, error) {
	scheme := "http"
	if config.UseSSL || strings.EqualFold(strings.TrimSpace(config.SSLMode), "required") ||
		strings.EqualFold(strings.TrimSpace(config.SSLMode), "preferred") {
		scheme = "https"
	}

	contextPath := resolveNacosContextPath(config)
	base, err := url.Parse(fmt.Sprintf("%s://%s", scheme, net.JoinHostPort(config.Host, strconv.Itoa(config.Port))))
	if err != nil {
		return nil, nil, localizedNacosBackendError("nacos.backend.error.invalid_address", map[string]any{
			"detail": err.Error(),
		})
	}
	base.Path = contextPath

	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	dialContext := dialer.DialContext
	if dialTarget := strings.TrimSpace(dialAddress); dialTarget != "" {
		dialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, dialTarget)
		}
	} else if config.UseProxy {
		proxyConfig := config.Proxy
		dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return dialNacosProxyContext(ctx, proxyConfig, network, address)
		}
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	if strings.TrimSpace(dialAddress) != "" || config.UseProxy {
		// The explicit network hop is already handled by DialContext. Applying
		// an environment/http.Transport proxy as well would double-proxy it.
		transport.Proxy = nil
	}

	if scheme == "https" {
		sslMode := strings.ToLower(strings.TrimSpace(config.SSLMode))
		insecure := sslMode == "skip-verify" || sslMode == "preferred" || sslMode == ""
		tlsCfg, err := tlsconfig.BuildClientConfig(tlsconfig.ClientConfigOptions{
			Enabled:            true,
			InsecureSkipVerify: insecure,
			CAPath:             config.SSLCAPath,
			CertPath:           config.SSLCertPath,
			KeyPath:            config.SSLKeyPath,
		})
		if err != nil {
			return nil, nil, localizedNacosBackendError("nacos.backend.error.tls_setup_failed", map[string]any{
				"detail": err.Error(),
			})
		}
		if tlsCfg != nil {
			if strings.TrimSpace(dialAddress) != "" {
				tlsCfg.ServerName = strings.Trim(strings.TrimSpace(config.Host), "[]")
			}
			transport.TLSClientConfig = tlsCfg
		} else {
			transport.TLSClientConfig = &tls.Config{
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: insecure, //nolint:gosec
			}
			if strings.TrimSpace(dialAddress) != "" {
				transport.TLSClientConfig.ServerName = strings.Trim(strings.TrimSpace(config.Host), "[]")
			}
		}
	}

	client := &http.Client{
		// Request deadlines are supplied by the caller context. Keeping this
		// unset prevents a cached client from retaining the first connection's
		// timeout for later operations.
		Timeout:   0,
		Transport: transport,
	}
	return client, base, nil
}

func resolveNacosContextPath(config connection.ConnectionConfig) string {
	// Prefer connectionParams contextPath=...
	params := parseSimpleKV(config.ConnectionParams)
	if v := strings.TrimSpace(params["contextPath"]); v != "" {
		return normalizeContextPath(v)
	}
	// Allow Database field to carry context path as a convenience.
	if v := strings.TrimSpace(config.Database); v != "" && strings.Contains(v, "/") {
		return normalizeContextPath(v)
	}
	return defaultNacosContextPath
}

func normalizeContextPath(raw string) string {
	path := strings.TrimSpace(raw)
	if path == "" || path == "/" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return strings.TrimRight(path, "/")
}

func joinAPIPath(basePath, apiPath string) string {
	base := strings.TrimRight(strings.TrimSpace(basePath), "/")
	api := strings.TrimSpace(apiPath)
	if api == "" {
		return base
	}
	if !strings.HasPrefix(api, "/") {
		api = "/" + api
	}
	return base + api
}

func normalizeNamespaceID(raw string) string {
	id := strings.TrimSpace(raw)
	if strings.EqualFold(id, "public") {
		return ""
	}
	return id
}

func normalizeNacosTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		return defaultNacosTimeout
	}
	return time.Duration(seconds) * time.Second
}

func parseSimpleKV(raw string) map[string]string {
	result := make(map[string]string)
	text := strings.TrimSpace(raw)
	if text == "" {
		return result
	}
	// Support both "a=b&c=d" and "a=b;c=d" and newline-separated pairs.
	replacer := strings.NewReplacer(";", "&", "\n", "&")
	text = replacer.Replace(text)
	values, err := url.ParseQuery(text)
	if err == nil {
		for key, vals := range values {
			if len(vals) > 0 {
				result[strings.TrimSpace(key)] = strings.TrimSpace(vals[0])
			}
		}
		return result
	}
	for _, part := range strings.Split(text, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		result[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return result
}

func truncateForError(text string) string {
	const max = 400
	trimmed := strings.TrimSpace(redactNacosErrorText(text))
	if len(trimmed) <= max {
		return trimmed
	}
	cutoff := max
	for cutoff > 0 && !utf8.RuneStart(trimmed[cutoff]) {
		cutoff--
	}
	return trimmed[:cutoff] + "..."
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func stringifyAnyTime(values ...any) string {
	for _, v := range values {
		switch t := v.(type) {
		case nil:
			continue
		case string:
			if s := strings.TrimSpace(t); s != "" {
				return s
			}
		case float64:
			// millis or seconds
			if t > 1e12 {
				return time.UnixMilli(int64(t)).Format(time.RFC3339)
			}
			if t > 0 {
				return time.Unix(int64(t), 0).Format(time.RFC3339)
			}
		case json.Number:
			if i, err := t.Int64(); err == nil {
				if i > 1e12 {
					return time.UnixMilli(i).Format(time.RFC3339)
				}
				if i > 0 {
					return time.Unix(i, 0).Format(time.RFC3339)
				}
			}
		default:
			s := strings.TrimSpace(fmt.Sprint(t))
			if s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}
