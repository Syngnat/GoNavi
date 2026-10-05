package db

import (
	"context"
	"encoding/base64"
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

func normalizeRabbitMQConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyRabbitMQURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultRabbitMQPort
	}
	params := rabbitmqConnectionParams(runConfig)
	if rabbitmqBoolValue(firstNonEmpty(params.Get("ssl"), params.Get("tls"), params.Get("useSSL"), params.Get("use_ssl"))) {
		runConfig.UseSSL = true
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		if rabbitmqBoolValue(firstNonEmpty(params.Get("skip_verify"), params.Get("skipVerify"), params.Get("insecure"))) {
			runConfig.SSLMode = "skip-verify"
		} else {
			runConfig.SSLMode = "required"
		}
	}
	return runConfig
}

func applyRabbitMQURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "rabbitmq" && scheme != "http" && scheme != "https" {
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
	host, port, ok := parseHostPortWithDefault(parsed.Host, defaultRabbitMQPort)
	if ok {
		config.Host = host
		config.Port = port
	}
	if vhost := rabbitmqDecodePathValue(parsed.Path); vhost != "" && strings.TrimSpace(config.Database) == "" {
		config.Database = vhost
	}
	if scheme == "https" {
		config.UseSSL = true
		if strings.TrimSpace(config.SSLMode) == "" {
			config.SSLMode = "required"
		}
	}
	return config
}

func rabbitmqConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "rabbitmq", "http", "https"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func rabbitmqDecodePathValue(path string) string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(path), "/")
	if trimmed == "" {
		return ""
	}
	decoded, err := url.PathUnescape(trimmed)
	if err != nil {
		return trimmed
	}
	return decoded
}

func rabbitmqResolveVHost(raw string, fallback string) string {
	if text := strings.TrimSpace(raw); text != "" {
		return text
	}
	if text := strings.TrimSpace(fallback); text != "" {
		return text
	}
	return rabbitMQDefaultVHost
}

func rabbitmqResolveQueue(raw string, fallback string) string {
	if text := strings.TrimSpace(raw); text != "" {
		return text
	}
	return strings.TrimSpace(fallback)
}

func rabbitmqNormalizeExchangeName(raw string, fallback string) string {
	text := strings.TrimSpace(firstNonEmpty(raw, fallback))
	switch text {
	case "(default)", "amq.default":
		return ""
	default:
		return text
	}
}

func rabbitmqPageSize(params url.Values) int {
	size := intFromAny(firstNonEmpty(params.Get("pageSize"), params.Get("page_size")), defaultRabbitMQPageSize)
	if size <= 0 {
		size = defaultRabbitMQPageSize
	}
	if size > maxRabbitMQPageSize {
		size = maxRabbitMQPageSize
	}
	return size
}

func buildRabbitMQBaseURL(config connection.ConnectionConfig) string {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	params := rabbitmqConnectionParams(config)
	prefix := strings.TrimSpace(firstNonEmpty(params.Get("managementPathPrefix"), params.Get("pathPrefix")))
	if prefix != "" {
		prefix = "/" + strings.Trim(strings.TrimSpace(prefix), "/")
	}
	return (&url.URL{
		Scheme: scheme,
		Host:   net.JoinHostPort(strings.TrimSpace(config.Host), strconv.Itoa(config.Port)),
		Path:   prefix,
	}).String()
}

func buildRabbitMQHTTPClient(config connection.ConnectionConfig) *http.Client {
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

func rabbitmqAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := map[string]string{}
	if user := strings.TrimSpace(config.User); user != "" {
		raw := user + ":" + config.Password
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(raw))
	}
	params := rabbitmqConnectionParams(config)
	if headerName := strings.TrimSpace(params.Get("authHeader")); headerName != "" {
		if headerValue := strings.TrimSpace(params.Get("authHeaderValue")); headerValue != "" && isSafeConnectionParamKey(headerName) {
			headers[headerName] = headerValue
		}
	}
	return headers
}

func (r *RabbitMQDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if r.client == nil {
		return fmt.Errorf("连接未打开")
	}
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = strings.NewReader(string(data))
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(r.baseURL, "/")+path, payload)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range r.authHeaders {
		req.Header.Set(key, value)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	data, err := readLimitedJSONResponseBody(resp.Body)
	if err != nil {
		return fmt.Errorf("读取 RabbitMQ HTTP API 响应失败：%w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(string(data))
		var errBody map[string]interface{}
		if decodeJSONWithUseNumber(data, &errBody) == nil {
			message = strings.TrimSpace(firstNonEmpty(
				mapString(errBody, "error"),
				mapString(errBody, "reason"),
				mapString(errBody, "message"),
				message,
			))
		}
		if message == "" {
			message = resp.Status
		}
		return fmt.Errorf("RabbitMQ HTTP API %s %s 失败：%s", method, path, message)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	if err := decodeJSONWithUseNumber(data, out); err != nil {
		return fmt.Errorf("解析 RabbitMQ HTTP API 响应失败：%w", err)
	}
	return nil
}

func (r *RabbitMQDB) listVHosts(ctx context.Context, limit int) ([]map[string]interface{}, error) {
	return r.listCollection(ctx, "/api/vhosts", limit, nil)
}

func (r *RabbitMQDB) listQueues(ctx context.Context, vhost string, limit int) ([]map[string]interface{}, error) {
	params := url.Values{}
	params.Set("disable_stats", "true")
	params.Set("enable_queue_totals", "true")
	return r.listCollection(ctx, fmt.Sprintf("/api/queues/%s", url.PathEscape(vhost)), limit, params)
}

func (r *RabbitMQDB) listExchanges(ctx context.Context, vhost string, limit int) ([]map[string]interface{}, error) {
	return r.listCollection(ctx, fmt.Sprintf("/api/exchanges/%s", url.PathEscape(vhost)), limit, nil)
}

func (r *RabbitMQDB) listCollection(ctx context.Context, path string, limit int, extraParams url.Values) ([]map[string]interface{}, error) {
	pageSize := r.pageSize
	if pageSize <= 0 {
		pageSize = defaultRabbitMQPageSize
	}
	if limit > 0 && limit < pageSize {
		pageSize = limit
	}
	if pageSize <= 0 {
		pageSize = defaultRabbitMQPageSize
	}
	if pageSize > maxRabbitMQPageSize {
		pageSize = maxRabbitMQPageSize
	}

	var result []map[string]interface{}
	for page := 1; ; page++ {
		query := url.Values{}
		for key, values := range extraParams {
			for _, value := range values {
				query.Add(key, value)
			}
		}
		query.Set("page", strconv.Itoa(page))
		query.Set("page_size", strconv.Itoa(pageSize))
		query.Set("pagination", "true")

		requestPath := path
		if encoded := query.Encode(); encoded != "" {
			requestPath += "?" + encoded
		}

		var raw interface{}
		if err := r.doJSON(ctx, http.MethodGet, requestPath, nil, &raw); err != nil {
			return nil, err
		}
		items, pageCount, err := rabbitmqItemsFromResponse(raw)
		if err != nil {
			return nil, err
		}
		result = append(result, items...)
		if limit > 0 && len(result) >= limit {
			return result[:limit], nil
		}
		if pageCount <= page || len(items) == 0 {
			break
		}
	}
	return result, nil
}

func rabbitmqItemsFromResponse(raw interface{}) ([]map[string]interface{}, int, error) {
	switch typed := raw.(type) {
	case []interface{}:
		return rabbitmqMapSlice(typed)
	case []map[string]interface{}:
		return typed, 1, nil
	case map[string]interface{}:
		itemsRaw, ok := typed["items"]
		if !ok {
			return nil, 0, fmt.Errorf("RabbitMQ 列表响应缺少 items 字段")
		}
		items, _, err := rabbitmqItemsFromResponse(itemsRaw)
		if err != nil {
			return nil, 0, err
		}
		return items, intFromAny(typed["page_count"], 1), nil
	default:
		return nil, 0, fmt.Errorf("无法解析 RabbitMQ 列表响应")
	}
}

func rabbitmqMapSlice(raw []interface{}) ([]map[string]interface{}, int, error) {
	result := make([]map[string]interface{}, 0, len(raw))
	for _, item := range raw {
		row, ok := item.(map[string]interface{})
		if !ok {
			return nil, 0, fmt.Errorf("RabbitMQ 列表项不是对象")
		}
		result = append(result, row)
	}
	return result, 1, nil
}

func (r *RabbitMQDB) getQueueInfo(ctx context.Context, vhost string, queue string) (map[string]interface{}, error) {
	params := url.Values{}
	params.Set("disable_stats", "true")
	params.Set("enable_queue_totals", "true")
	path := fmt.Sprintf("/api/queues/%s/%s?%s", url.PathEscape(vhost), url.PathEscape(queue), params.Encode())
	var info map[string]interface{}
	if err := r.doJSON(ctx, http.MethodGet, path, nil, &info); err != nil {
		return nil, err
	}
	return info, nil
}

func (r *RabbitMQDB) getExchangeInfo(ctx context.Context, vhost string, exchange string) (map[string]interface{}, error) {
	path := fmt.Sprintf("/api/exchanges/%s/%s", url.PathEscape(vhost), url.PathEscape(exchange))
	var info map[string]interface{}
	if err := r.doJSON(ctx, http.MethodGet, path, nil, &info); err != nil {
		return nil, err
	}
	return info, nil
}

func (r *RabbitMQDB) getQueueMessages(ctx context.Context, vhost string, queue string, limit int) ([]map[string]interface{}, error) {
	if limit <= 0 {
		limit = defaultRabbitMQPreviewLimit
	}
	body := map[string]interface{}{
		"count":    limit,
		"ackmode":  "ack_requeue_true",
		"encoding": "auto",
		"truncate": 50000,
	}
	path := fmt.Sprintf("/api/queues/%s/%s/get", url.PathEscape(vhost), url.PathEscape(queue))
	var result []map[string]interface{}
	if err := r.doJSON(ctx, http.MethodPost, path, body, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *RabbitMQDB) publishMessage(ctx context.Context, vhost string, exchange string, routingKey string, payload interface{}, properties map[string]interface{}) (int64, error) {
	payloadText, encoding, err := rabbitmqEncodePayload(payload)
	if err != nil {
		return 0, err
	}
	if properties == nil {
		properties = map[string]interface{}{}
	}
	if _, exists := properties["content_type"]; !exists {
		switch payload.(type) {
		case map[string]interface{}, []interface{}:
			properties["content_type"] = "application/json"
		}
	}
	body := map[string]interface{}{
		"properties":       properties,
		"routing_key":      routingKey,
		"payload":          payloadText,
		"payload_encoding": encoding,
	}
	path := fmt.Sprintf("/api/exchanges/%s/%s/publish", url.PathEscape(vhost), url.PathEscape(exchange))
	var result map[string]interface{}
	if err := r.doJSON(ctx, http.MethodPost, path, body, &result); err != nil {
		return 0, err
	}
	if !rabbitmqBoolAny(result["routed"]) {
		return 0, fmt.Errorf("RabbitMQ publish 未路由到任何队列")
	}
	return 1, nil
}
