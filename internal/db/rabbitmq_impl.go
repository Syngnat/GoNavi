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
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultRabbitMQPort         = 15672
	defaultRabbitMQQueryTimeout = 30 * time.Second
	defaultRabbitMQPreviewLimit = 100
	defaultRabbitMQPageSize     = 200
	maxRabbitMQPageSize         = 500
	rabbitMQDefaultVHost        = "/"
)

type RabbitMQDB struct {
	client          *http.Client
	baseURL         string
	defaultVHost    string
	defaultQueue    string
	defaultExchange string
	pageSize        int
	authHeaders     map[string]string
	forwarder       *ssh.LocalForwarder
}

func (r *RabbitMQDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = r.Close()
	defer func() {
		if err != nil {
			_ = r.Close()
		}
	}()

	runConfig := normalizeRabbitMQConfig(config)
	if err := validateRabbitMQManagementPort(runConfig.Port, config.URI); err != nil {
		return err
	}
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		r.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("RabbitMQ 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	params := rabbitmqConnectionParams(runConfig)
	r.baseURL = buildRabbitMQBaseURL(runConfig)
	r.defaultVHost = rabbitmqResolveVHost(runConfig.Database, "")
	r.defaultQueue = strings.TrimSpace(firstNonEmpty(params.Get("defaultQueue"), params.Get("queue")))
	r.defaultExchange = rabbitmqNormalizeExchangeName(firstNonEmpty(params.Get("defaultExchange"), params.Get("exchange")), "")
	r.pageSize = rabbitmqPageSize(params)
	r.authHeaders = rabbitmqAuthHeaders(runConfig)
	r.client = buildRabbitMQHTTPClient(runConfig)

	if err := r.Ping(); err != nil {
		_ = r.Close()
		return err
	}
	return nil
}

func validateRabbitMQManagementPort(port int, rawURI string) error {
	if rabbitMQHasExplicitManagementURI(rawURI) {
		return nil
	}
	switch port {
	case 5672:
		return fmt.Errorf("RabbitMQ 数据源使用 Management API，5672 是 AMQP 协议端口；请启用 rabbitmq_management 插件并填写 Management API 端口（通常为 15672）")
	case 5671:
		return fmt.Errorf("RabbitMQ 数据源使用 Management API，5671 是 AMQPS 协议端口；请启用 rabbitmq_management 插件并填写 HTTPS Management API 端口（通常为 15671）")
	default:
		return nil
	}
}

func rabbitMQHasExplicitManagementURI(rawURI string) bool {
	parsed, err := url.Parse(strings.TrimSpace(rawURI))
	if err != nil || strings.TrimSpace(parsed.Host) == "" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(parsed.Scheme)) {
	case "http", "https":
		return true
	default:
		return false
	}
}

func (r *RabbitMQDB) Close() error {
	if r.forwarder != nil {
		if err := r.forwarder.Release(); err != nil {
			logger.Warnf("关闭 RabbitMQ SSH 端口转发失败：%v", err)
		}
		r.forwarder = nil
	}
	r.client = nil
	r.baseURL = ""
	r.defaultVHost = ""
	r.defaultQueue = ""
	r.defaultExchange = ""
	r.pageSize = 0
	r.authHeaders = nil
	return nil
}

func (r *RabbitMQDB) Ping() error {
	if r.client == nil {
		return fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return r.doJSON(ctx, http.MethodGet, "/api/overview", nil, nil)
}

func (r *RabbitMQDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultRabbitMQQueryTimeout)
	defer cancel()
	return r.QueryContext(ctx, query)
}

func (r *RabbitMQDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if r.client == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}

	parsed, ok := parseRabbitMQSQL(text)
	if !ok {
		return nil, nil, fmt.Errorf("RabbitMQ 查询仅支持 SHOW VHOSTS、SHOW QUEUES、SHOW EXCHANGES、DESCRIBE QUEUE、DESCRIBE EXCHANGE、SELECT * FROM queue 与 CONSUME FROM queue")
	}

	switch parsed.Action {
	case "show_vhosts":
		items, err := r.listVHosts(ctx, parsed.Limit)
		if err != nil {
			return nil, nil, err
		}
		rows := rabbitmqVHostRows(items)
		return rows, collectColumns(rows), nil
	case "show_queues":
		vhost := rabbitmqResolveVHost(parsed.VHost, r.defaultVHost)
		items, err := r.listQueues(ctx, vhost, parsed.Limit)
		if err != nil {
			return nil, nil, err
		}
		rows := rabbitmqQueueRows(items)
		return rows, collectColumns(rows), nil
	case "show_exchanges":
		vhost := rabbitmqResolveVHost(parsed.VHost, r.defaultVHost)
		items, err := r.listExchanges(ctx, vhost, parsed.Limit)
		if err != nil {
			return nil, nil, err
		}
		rows := rabbitmqExchangeRows(items)
		return rows, collectColumns(rows), nil
	case "describe_queue":
		vhost := rabbitmqResolveVHost(parsed.VHost, r.defaultVHost)
		queue := rabbitmqResolveQueue(parsed.Name, r.defaultQueue)
		if queue == "" {
			return nil, nil, fmt.Errorf("RabbitMQ queue 不能为空")
		}
		info, err := r.getQueueInfo(ctx, vhost, queue)
		if err != nil {
			return nil, nil, err
		}
		rows := []map[string]interface{}{rabbitmqQueueRow(info)}
		return rows, collectColumns(rows), nil
	case "describe_exchange":
		vhost := rabbitmqResolveVHost(parsed.VHost, r.defaultVHost)
		exchange := rabbitmqNormalizeExchangeName(parsed.Name, r.defaultExchange)
		info, err := r.getExchangeInfo(ctx, vhost, exchange)
		if err != nil {
			return nil, nil, err
		}
		rows := []map[string]interface{}{rabbitmqExchangeRow(info)}
		return rows, collectColumns(rows), nil
	case "select", "consume":
		vhost := rabbitmqResolveVHost(parsed.VHost, r.defaultVHost)
		queue := rabbitmqResolveQueue(parsed.Name, r.defaultQueue)
		if queue == "" {
			return nil, nil, fmt.Errorf("RabbitMQ queue 不能为空")
		}
		if parsed.Count {
			info, err := r.getQueueInfo(ctx, vhost, queue)
			if err != nil {
				return nil, nil, err
			}
			return []map[string]interface{}{{
				"vhost":   vhost,
				"queue":   queue,
				"total":   intFromAny(info["messages"], 0),
				"ready":   intFromAny(info["messages_ready"], 0),
				"unacked": intFromAny(info["messages_unacknowledged"], 0),
			}}, []string{"vhost", "queue", "total", "ready", "unacked"}, nil
		}

		fetchLimit := parsed.Limit + parsed.Offset
		if fetchLimit <= 0 {
			fetchLimit = defaultRabbitMQPreviewLimit
		}
		items, err := r.getQueueMessages(ctx, vhost, queue, fetchLimit)
		if err != nil {
			return nil, nil, err
		}
		if parsed.Offset > 0 {
			if parsed.Offset >= len(items) {
				items = nil
			} else {
				items = items[parsed.Offset:]
			}
		}
		if parsed.Limit > 0 && len(items) > parsed.Limit {
			items = items[:parsed.Limit]
		}
		rows := rabbitmqMessageRows(vhost, queue, items)
		return rows, collectColumns(rows), nil
	default:
		return nil, nil, fmt.Errorf("未实现的 RabbitMQ 查询类型：%s", parsed.Action)
	}
}

func (r *RabbitMQDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultRabbitMQQueryTimeout)
	defer cancel()
	return r.ExecContext(ctx, query)
}

func (r *RabbitMQDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if r.client == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("RabbitMQ 写入命令必须是 JSON：%w", err)
	}
	if !hasAnyKey(cmd, "publish", "queue", "destination") {
		return 0, fmt.Errorf("RabbitMQ JSON 写入命令仅支持 publish/queue/destination 形式的消息发送")
	}

	vhost := rabbitmqResolveVHost(firstStringValue(cmd, "vhost", "database"), r.defaultVHost)
	rawDestination := firstStringValue(cmd, "publish", "queue", "destination")
	rawExchange := firstStringValue(cmd, "exchange")
	exchange := rabbitmqNormalizeExchangeName(rawExchange, r.defaultExchange)
	directExchangePublish := strings.TrimSpace(rawDestination) == "" &&
		strings.TrimSpace(rawExchange) != ""
	var routingKey string
	if directExchangePublish {
		// A named Exchange does not imply a Queue. An empty routing key is valid
		// for fanout exchanges, so preserve it instead of falling back to the
		// connection's default Queue.
		routingKey = strings.TrimSpace(firstStringValue(cmd, "routing_key", "routingKey", "route", "routing"))
	} else {
		queue := rabbitmqResolveQueue(rawDestination, r.defaultQueue)
		if queue == "" {
			return 0, fmt.Errorf("RabbitMQ publish 命令缺少 queue")
		}
		routingKey = strings.TrimSpace(firstNonEmpty(
			firstStringValue(cmd, "routing_key", "routingKey", "route", "routing"),
			queue,
		))
		if routingKey == "" {
			return 0, fmt.Errorf("RabbitMQ publish 命令缺少 routing_key")
		}
	}
	if !hasAnyKey(cmd, "payload", "value", "body", "message") {
		return 0, fmt.Errorf("RabbitMQ publish 命令缺少 payload")
	}
	payload := firstExisting(cmd, "payload", "value", "body", "message")

	properties, err := rabbitmqMapPayload(firstExisting(cmd, "properties", "props"))
	if err != nil {
		return 0, fmt.Errorf("RabbitMQ properties 必须是 JSON 对象：%w", err)
	}
	headers, err := rabbitmqMapPayload(firstExisting(cmd, "headers"))
	if err != nil {
		return 0, fmt.Errorf("RabbitMQ headers 必须是 JSON 对象：%w", err)
	}
	if len(headers) > 0 {
		if properties == nil {
			properties = map[string]interface{}{}
		}
		existingHeaders, err := rabbitmqMapPayload(firstExisting(properties, "headers"))
		if err != nil {
			return 0, fmt.Errorf("RabbitMQ properties.headers 必须是 JSON 对象：%w", err)
		}
		if existingHeaders == nil {
			existingHeaders = map[string]interface{}{}
		}
		for key, value := range headers {
			existingHeaders[key] = value
		}
		properties["headers"] = existingHeaders
	}

	return r.publishMessage(ctx, vhost, exchange, routingKey, payload, properties)
}

func (r *RabbitMQDB) GetDatabases() ([]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 10*time.Second)
	defer cancel()

	items, err := r.listVHosts(ctx, 0)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(items))
	for _, item := range items {
		if name := mapString(item, "name"); name != "" {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		names = append(names, rabbitmqResolveVHost("", r.defaultVHost))
	}
	sort.Strings(names)
	return names, nil
}

func (r *RabbitMQDB) GetTables(dbName string) ([]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 10*time.Second)
	defer cancel()

	vhost := rabbitmqResolveVHost(dbName, r.defaultVHost)
	items, err := r.listQueues(ctx, vhost, 0)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(items))
	for _, item := range items {
		if name := mapString(item, "name"); name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (r *RabbitMQDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if r.client == nil {
		return "", fmt.Errorf("连接未打开")
	}
	vhost := rabbitmqResolveVHost(dbName, r.defaultVHost)
	queue := rabbitmqResolveQueue(tableName, r.defaultQueue)
	if queue == "" {
		return "", fmt.Errorf("RabbitMQ queue 不能为空")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 10*time.Second)
	defer cancel()

	info, err := r.getQueueInfo(ctx, vhost, queue)
	if err != nil {
		return "", err
	}
	payload, _ := json.MarshalIndent(info, "", "  ")
	return fmt.Sprintf("// RabbitMQ queue: %s @ %s\n%s", queue, vhost, string(payload)), nil
}

func (r *RabbitMQDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	queue := rabbitmqResolveQueue(tableName, r.defaultQueue)
	if queue == "" {
		return nil, fmt.Errorf("RabbitMQ queue 不能为空")
	}

	columns := []connection.ColumnDefinition{
		{Name: "vhost", Type: "string", Nullable: "NO", Comment: "RabbitMQ virtual host"},
		{Name: "queue", Type: "string", Nullable: "NO", Key: "PRI", Comment: "RabbitMQ queue"},
		{Name: "exchange", Type: "string", Nullable: "YES", Comment: "Exchange used for routing"},
		{Name: "routing_key", Type: "string", Nullable: "YES", Comment: "RabbitMQ routing key"},
		{Name: "redelivered", Type: "bool", Nullable: "YES", Comment: "Whether the message was redelivered"},
		{Name: "message_count", Type: "int", Nullable: "YES", Comment: "Remaining messages after this delivery"},
		{Name: "payload", Type: "json", Nullable: "YES", Comment: "Message payload"},
		{Name: "payload_encoding", Type: "string", Nullable: "YES", Comment: "RabbitMQ payload encoding"},
		{Name: "payload_bytes", Type: "int", Nullable: "YES", Comment: "Payload size in bytes"},
		{Name: "properties", Type: "json", Nullable: "YES", Comment: "AMQP properties"},
		{Name: "headers", Type: "json", Nullable: "YES", Comment: "AMQP headers"},
	}
	return columns, nil
}

func (r *RabbitMQDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := r.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	for _, table := range tables {
		columns, err := r.GetColumns(dbName, table)
		if err != nil {
			return nil, err
		}
		for _, column := range columns {
			result = append(result, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      column.Name,
				Type:      column.Type,
				Comment:   column.Comment,
			})
		}
	}
	return result, nil
}

func (r *RabbitMQDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (r *RabbitMQDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (r *RabbitMQDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (r *RabbitMQDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if len(changes.Inserts) == 0 && len(changes.Updates) == 0 && len(changes.Deletes) == 0 {
		return nil
	}
	return fmt.Errorf("RabbitMQ 结果集仅支持只读预览；如需写入请在 SQL 编辑器执行 JSON publish 命令")
}

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

type rabbitmqParsedSQL struct {
	Action string
	VHost  string
	Name   string
	Limit  int
	Offset int
	Count  bool
}

var (
	rabbitmqSQLFromRE          = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))`)
	rabbitmqSQLLimitRE         = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	rabbitmqSQLOffsetRE        = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	rabbitmqShowVHostsRE       = regexp.MustCompile(`(?i)^\s*SHOW\s+VHOSTS(?:\s+LIMIT\s+(\d+))?\s*$`)
	rabbitmqShowQueuesRE       = regexp.MustCompile(`(?i)^\s*SHOW\s+QUEUES(?:\s+LIMIT\s+(\d+))?\s*$`)
	rabbitmqShowExchangesRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+EXCHANGES(?:\s+LIMIT\s+(\d+))?\s*$`)
	rabbitmqDescribeQueueRE    = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+QUEUE\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))\s*$`)
	rabbitmqDescribeExchangeRE = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+EXCHANGE\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))\s*$`)
	rabbitmqConsumeQueueRE     = regexp.MustCompile(`(?i)^\s*CONSUME\s+FROM\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))`)
)

func parseRabbitMQSQL(sqlText string) (rabbitmqParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if text == "" {
		return rabbitmqParsedSQL{}, false
	}
	if matches := rabbitmqShowVHostsRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{Action: "show_vhosts", Limit: rabbitmqMatchLimit(matches, 1)}, true
	}
	if matches := rabbitmqShowQueuesRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{Action: "show_queues", Limit: rabbitmqMatchLimit(matches, 1)}, true
	}
	if matches := rabbitmqShowExchangesRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{Action: "show_exchanges", Limit: rabbitmqMatchLimit(matches, 1)}, true
	}
	if matches := rabbitmqDescribeQueueRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{
			Action: "describe_queue",
			Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
		}, true
	}
	if matches := rabbitmqDescribeExchangeRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{
			Action: "describe_exchange",
			Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
		}, true
	}
	if matches := rabbitmqConsumeQueueRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := rabbitmqParsedSQL{
			Action: "consume",
			Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
			Limit:  defaultRabbitMQPreviewLimit,
		}
		if limitMatch := rabbitmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
			parsed.Limit, _ = strconv.Atoi(limitMatch[1])
		}
		if offsetMatch := rabbitmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
			parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
		}
		return parsed, true
	}
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return rabbitmqParsedSQL{}, false
	}
	matches := rabbitmqSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return rabbitmqParsedSQL{}, false
	}
	parsed := rabbitmqParsedSQL{
		Action: "select",
		Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
		Limit:  defaultRabbitMQPreviewLimit,
		Count:  strings.Contains(strings.ToLower(text), "count("),
	}
	if limitMatch := rabbitmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
		parsed.Limit, _ = strconv.Atoi(limitMatch[1])
	}
	if offsetMatch := rabbitmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
		parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
	}
	return parsed, true
}

func rabbitmqMatchLimit(matches []string, index int) int {
	if index >= len(matches) || strings.TrimSpace(matches[index]) == "" {
		return 0
	}
	limit, _ := strconv.Atoi(matches[index])
	return limit
}

func rabbitmqVHostRows(items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		row := map[string]interface{}{
			"vhost":   mapString(item, "name"),
			"tracing": rabbitmqBoolAny(item["tracing"]),
		}
		if desc := mapString(item, "description"); desc != "" {
			row["description"] = desc
		}
		if tags := mapString(item, "tags"); tags != "" {
			row["tags"] = tags
		}
		if value := mapString(item, "default_queue_type"); value != "" {
			row["default_queue_type"] = value
		}
		if state, ok := item["cluster_state"].(map[string]interface{}); ok && len(state) > 0 {
			row["cluster_state"] = state
		}
		rows = append(rows, row)
	}
	return rows
}

func rabbitmqQueueRows(items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		rows = append(rows, rabbitmqQueueRow(item))
	}
	return rows
}

func rabbitmqQueueRow(item map[string]interface{}) map[string]interface{} {
	row := map[string]interface{}{
		"vhost":                   mapString(item, "vhost"),
		"queue":                   mapString(item, "name"),
		"durable":                 rabbitmqBoolAny(item["durable"]),
		"auto_delete":             rabbitmqBoolAny(item["auto_delete"]),
		"exclusive":               rabbitmqBoolAny(item["exclusive"]),
		"consumers":               intFromAny(item["consumers"], 0),
		"messages":                intFromAny(item["messages"], 0),
		"messages_ready":          intFromAny(item["messages_ready"], 0),
		"messages_unacknowledged": intFromAny(item["messages_unacknowledged"], 0),
	}
	if node := mapString(item, "node"); node != "" {
		row["node"] = node
	}
	if state := mapString(item, "state"); state != "" {
		row["state"] = state
	}
	if queueType := mapString(item, "type"); queueType != "" {
		row["type"] = queueType
	}
	if args, ok := item["arguments"].(map[string]interface{}); ok && len(args) > 0 {
		row["arguments"] = args
	}
	return row
}

func rabbitmqExchangeRows(items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		rows = append(rows, rabbitmqExchangeRow(item))
	}
	return rows
}

func rabbitmqExchangeRow(item map[string]interface{}) map[string]interface{} {
	name := mapString(item, "name")
	row := map[string]interface{}{
		"vhost":       mapString(item, "vhost"),
		"exchange":    name,
		"durable":     rabbitmqBoolAny(item["durable"]),
		"auto_delete": rabbitmqBoolAny(item["auto_delete"]),
		"internal":    rabbitmqBoolAny(item["internal"]),
	}
	if name == "" {
		row["exchange_display"] = "(default)"
	}
	if exchangeType := mapString(item, "type"); exchangeType != "" {
		row["type"] = exchangeType
	}
	if args, ok := item["arguments"].(map[string]interface{}); ok && len(args) > 0 {
		row["arguments"] = args
	}
	return row
}

func rabbitmqMessageRows(vhost string, queue string, items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		row := map[string]interface{}{
			"vhost":            vhost,
			"queue":            queue,
			"exchange":         mapString(item, "exchange"),
			"routing_key":      mapString(item, "routing_key"),
			"redelivered":      rabbitmqBoolAny(item["redelivered"]),
			"message_count":    intFromAny(item["message_count"], 0),
			"payload_bytes":    intFromAny(item["payload_bytes"], 0),
			"payload_encoding": mapString(item, "payload_encoding"),
		}
		payload := rabbitmqDecodePayload(item["payload"], row["payload_encoding"])
		if payload != nil {
			row["payload"] = payload
			if payloadMap, ok := payload.(map[string]interface{}); ok {
				flattenRabbitMQMap("payload", payloadMap, row)
			}
		}
		if properties, ok := item["properties"].(map[string]interface{}); ok && len(properties) > 0 {
			row["properties"] = properties
			flattenRabbitMQMap("properties", properties, row)
			if headers, ok := properties["headers"].(map[string]interface{}); ok && len(headers) > 0 {
				row["headers"] = headers
				flattenRabbitMQMap("headers", headers, row)
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func flattenRabbitMQMap(prefix string, values map[string]interface{}, row map[string]interface{}) {
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		name := prefix + "." + key
		row[name] = value
		if nested, ok := value.(map[string]interface{}); ok {
			flattenRabbitMQMap(name, nested, row)
		}
	}
}

func rabbitmqDecodePayload(raw interface{}, encodingValue interface{}) interface{} {
	switch value := raw.(type) {
	case nil:
		return nil
	case string:
		encoding := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", encodingValue)))
		if encoding == "base64" {
			data, err := base64.StdEncoding.DecodeString(value)
			if err == nil {
				var decoded interface{}
				if decodeJSONWithUseNumber(data, &decoded) == nil {
					return decoded
				}
				return bytesToDisplayValue(data, "")
			}
		}
		var decoded interface{}
		if decodeJSONWithUseNumber([]byte(value), &decoded) == nil {
			return decoded
		}
		return value
	default:
		return value
	}
}

func rabbitmqEncodePayload(payload interface{}) (string, string, error) {
	switch typed := payload.(type) {
	case nil:
		return "", "string", nil
	case string:
		return typed, "string", nil
	case []byte:
		return base64.StdEncoding.EncodeToString(typed), "base64", nil
	case json.Number:
		return typed.String(), "string", nil
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", typed), "string", nil
	case map[string]interface{}, []interface{}:
		data, err := json.Marshal(typed)
		if err != nil {
			return "", "", err
		}
		return string(data), "string", nil
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return "", "", err
		}
		return string(data), "string", nil
	}
}

func rabbitmqMapPayload(raw interface{}) (map[string]interface{}, error) {
	if raw == nil {
		return nil, nil
	}
	value, ok := raw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("不是对象")
	}
	return value, nil
}

func rabbitmqBoolValue(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on", "required":
		return true
	default:
		return false
	}
}

func rabbitmqBoolAny(raw interface{}) bool {
	switch value := raw.(type) {
	case bool:
		return value
	case json.Number:
		n, err := value.Int64()
		return err == nil && n != 0
	case float64:
		return value != 0
	case int:
		return value != 0
	case int64:
		return value != 0
	case string:
		return rabbitmqBoolValue(value)
	default:
		return false
	}
}
