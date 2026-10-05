package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

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
