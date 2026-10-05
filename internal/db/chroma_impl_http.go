package db

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
)

func normalizeChromaConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyChromaURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultChromaPort
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		runConfig.SSLMode = "required"
	}
	return runConfig
}

func applyChromaURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "http" && scheme != "https" && scheme != "chroma" {
		return config
	}
	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}
	if scheme == "https" {
		config.UseSSL = true
	}
	if host := strings.TrimSpace(parsed.Host); host != "" {
		if h, port, ok := parseHostPortWithDefault(host, defaultChromaPort); ok {
			config.Host = h
			config.Port = port
		}
	}
	if dbName := strings.Trim(strings.TrimSpace(parsed.Path), "/"); dbName != "" && !strings.HasPrefix(dbName, "api/") && strings.TrimSpace(config.Database) == "" {
		config.Database = dbName
	}
	return config
}

func buildChromaBaseURL(config connection.ConnectionConfig) string {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s:%d", scheme, strings.TrimSpace(config.Host), config.Port)
}

func chromaTenantFromConfig(config connection.ConnectionConfig) string {
	params := chromaConnectionParams(config)
	if tenant := strings.TrimSpace(params.Get("tenant")); tenant != "" {
		return tenant
	}
	return defaultChromaTenant
}

func chromaDatabaseFromConfig(config connection.ConnectionConfig) string {
	if dbName := strings.TrimSpace(config.Database); dbName != "" {
		return dbName
	}
	params := chromaConnectionParams(config)
	if dbName := strings.TrimSpace(params.Get("database")); dbName != "" {
		return dbName
	}
	return defaultChromaDatabase
}

func chromaConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "http", "https", "chroma"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func chromaAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := chromaConnectionParams(config)
	token := firstNonEmpty(params.Get("apiKey"), params.Get("apikey"), params.Get("token"), params.Get("authToken"))
	if token == "" && strings.TrimSpace(config.User) == "" {
		token = strings.TrimSpace(config.Password)
	}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	} else if user := strings.TrimSpace(config.User); user != "" {
		raw := user + ":" + config.Password
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(raw))
	}
	if headerName := strings.TrimSpace(params.Get("authHeader")); headerName != "" {
		if headerValue := strings.TrimSpace(params.Get("authHeaderValue")); headerValue != "" && isSafeConnectionParamKey(headerName) {
			headers[headerName] = headerValue
		}
	}
	return headers
}

func buildChromaHTTPClient(config connection.ConnectionConfig) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialTimeout := getConnectTimeout(config)
	transport.DialContext = (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext
	if tlsConfig, err := resolveGenericTLSConfig(config); err == nil && tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	if config.UseProxy {
		proxyCfg := config.Proxy
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
			defer cancel()
			return proxytunnel.DialContext(dialCtx, proxyCfg, network, addr)
		}
	}
	return &http.Client{Transport: transport}
}

func (c *ChromaDB) detectVersion(ctx context.Context) error {
	if c.client == nil {
		return fmt.Errorf("连接未打开")
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v2/heartbeat", nil, nil); err == nil {
		c.apiVersion = 2
		return nil
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/heartbeat", nil, nil); err == nil {
		c.apiVersion = 1
		return nil
	}
	return fmt.Errorf("Chroma 连接失败：无法访问 /api/v2/heartbeat 或 /api/v1/heartbeat")
}

func (c *ChromaDB) ensureVersion(ctx context.Context) error {
	if c.apiVersion == 1 || c.apiVersion == 2 {
		return nil
	}
	return c.detectVersion(ctx)
}

func (c *ChromaDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if c.client == nil {
		return fmt.Errorf("连接未打开")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.baseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if strings.TrimSpace(c.authHeaders["Authorization"]) == "" && strings.TrimSpace(req.Header.Get("Authorization")) == "" {
		// Basic Auth remains useful for gateways even when Chroma itself uses token auth.
	}
	for key, value := range c.authHeaders {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}
	res, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return fmt.Errorf("读取 Chroma 响应失败：%w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		message := strings.TrimSpace(string(resBody))
		if message == "" {
			message = res.Status
		}
		return fmt.Errorf("Chroma API %s %s 失败：%s", method, path, message)
	}
	if out == nil || len(bytes.TrimSpace(resBody)) == 0 {
		return nil
	}
	if err := decodeJSONWithUseNumber(resBody, out); err != nil {
		return fmt.Errorf("解析 Chroma 响应失败：%w", err)
	}
	return nil
}

func (c *ChromaDB) v2Path(dbName string, suffix string) string {
	database := strings.TrimSpace(dbName)
	if database == "" {
		database = c.database
	}
	base := fmt.Sprintf("/api/v2/tenants/%s/databases/%s", url.PathEscape(c.tenant), url.PathEscape(database))
	if suffix == "" {
		return base
	}
	return base + suffix
}
