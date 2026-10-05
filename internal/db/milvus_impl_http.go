package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
)

func normalizeMilvusConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyMilvusURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultMilvusPort
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		runConfig.SSLMode = "required"
	}
	return runConfig
}

func applyMilvusURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "http" && scheme != "https" && scheme != "milvus" {
		return config
	}
	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if password, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = password
		}
	}
	if scheme == "https" {
		config.UseSSL = true
	}
	if host := strings.TrimSpace(parsed.Host); host != "" {
		if parsedHost, port, ok := parseHostPortWithDefault(host, defaultMilvusPort); ok {
			config.Host = parsedHost
			config.Port = port
		}
	}
	if strings.TrimSpace(config.Database) == "" {
		if dbName := strings.Trim(strings.TrimSpace(parsed.Path), "/"); dbName != "" && !strings.HasPrefix(dbName, "v2/") {
			config.Database = dbName
		}
	}
	if strings.TrimSpace(config.Database) == "" {
		params := parsed.Query()
		config.Database = firstNonEmpty(params.Get("dbName"), params.Get("database"), params.Get("db"))
	}
	return config
}

func buildMilvusBaseURL(config connection.ConnectionConfig) string {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	host := strings.Trim(strings.TrimSpace(config.Host), "[]")
	return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(config.Port))
}

func milvusDatabaseFromConfig(config connection.ConnectionConfig) string {
	if name := strings.TrimSpace(config.Database); name != "" {
		return name
	}
	params := milvusConnectionParams(config)
	if name := firstNonEmpty(params.Get("dbName"), params.Get("database"), params.Get("db")); name != "" {
		return name
	}
	return defaultMilvusDatabase
}

func milvusConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "http", "https", "milvus"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func milvusAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := milvusConnectionParams(config)
	token := firstNonEmpty(params.Get("token"), params.Get("apiKey"), params.Get("apikey"), params.Get("api-key"), params.Get("authToken"))
	if token == "" {
		if user := strings.TrimSpace(config.User); user != "" {
			token = user + ":" + config.Password
		} else {
			token = strings.TrimSpace(config.Password)
		}
	}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	if headerName := strings.TrimSpace(params.Get("authHeader")); headerName != "" {
		if headerValue := strings.TrimSpace(params.Get("authHeaderValue")); headerValue != "" && isSafeConnectionParamKey(headerName) {
			headers[headerName] = headerValue
		}
	}
	return headers
}

func buildMilvusHTTPClient(config connection.ConnectionConfig) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialTimeout := getConnectTimeout(config)
	transport.DialContext = (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext
	if tlsConfig, err := resolveGenericTLSConfig(config); err == nil && tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	if config.UseProxy {
		proxyConfig := config.Proxy
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
			defer cancel()
			return proxytunnel.DialContext(dialCtx, proxyConfig, network, address)
		}
	}
	return &http.Client{Transport: transport}
}

func (m *MilvusDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if m.client == nil {
		return fmt.Errorf("connection is not open")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(m.baseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Type-Allow-Int64", "true")
	for key, value := range m.authHeaders {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}

	response, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := readLimitedJSONResponseBody(response.Body)
	if err != nil {
		return fmt.Errorf("read Milvus response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(string(responseBody))
		if message == "" {
			message = response.Status
		}
		return fmt.Errorf("Milvus REST API %s %s failed: %s", method, path, message)
	}
	if len(bytes.TrimSpace(responseBody)) == 0 {
		return nil
	}

	var envelope struct {
		Code    json.RawMessage `json:"code"`
		Message string          `json:"message"`
		Msg     string          `json:"msg"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &envelope); err != nil {
		return fmt.Errorf("decode Milvus response: %w", err)
	}
	if len(envelope.Code) > 0 && !milvusSuccessCode(envelope.Code) {
		message := firstNonEmpty(envelope.Message, envelope.Msg, strings.TrimSpace(string(responseBody)))
		return fmt.Errorf("Milvus REST API %s %s failed: %s", method, path, message)
	}
	if out == nil {
		return nil
	}
	data := envelope.Data
	if len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "null" {
		return nil
	}
	if err := decodeJSONWithUseNumber(data, out); err != nil {
		return fmt.Errorf("decode Milvus response data: %w", err)
	}
	return nil
}

func milvusSuccessCode(raw json.RawMessage) bool {
	value := strings.Trim(strings.TrimSpace(string(raw)), "\"")
	return value == "" || value == "0"
}

func (m *MilvusDB) databaseName(value string) string {
	if name := strings.TrimSpace(value); name != "" {
		return name
	}
	return m.database
}

func (m *MilvusDB) listCollections(ctx context.Context, database string) ([]string, error) {
	var raw interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusCollectionsListPath, map[string]interface{}{
		"dbName": m.databaseName(database),
	}, &raw); err != nil {
		return nil, err
	}
	return milvusNamesFromValue(raw, "collections", "collectionNames", "names"), nil
}

func (m *MilvusDB) getCollectionInfo(ctx context.Context, database, collection string) (map[string]interface{}, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, fmt.Errorf("collection name cannot be empty")
	}
	var info map[string]interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusCollectionsDescribePath, map[string]interface{}{
		"dbName":         m.databaseName(database),
		"collectionName": name,
	}, &info); err != nil {
		return nil, err
	}
	return info, nil
}
