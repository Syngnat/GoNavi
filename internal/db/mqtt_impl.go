package db

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
)

const (
	defaultMQTTPort         = 1883
	defaultMQTTQueryTimeout = 30 * time.Second
	defaultMQTTPreviewLimit = 100
	defaultMQTTFetchWait    = 4 * time.Second
	maxMQTTFetchWait        = 30 * time.Second
	mqttSyntheticDatabase   = "topics"
	mqttDefaultClientID     = "GoNavi"
)

type mqttRuntime interface {
	Close() error
	Ping(ctx context.Context) error
	FetchMessages(ctx context.Context, request mqttFetchRequest) ([]mqttMessageRecord, error)
	Publish(ctx context.Context, command mqttPublishCommand) (int64, error)
}

type mqttFetchRequest struct {
	Topic  string
	Limit  int
	Offset int
	QoS    byte
	Wait   time.Duration
}

type mqttPublishCommand struct {
	Topic   string
	Payload interface{}
	QoS     byte
	Retain  bool
}

type mqttMessageRecord struct {
	Topic      string
	QoS        byte
	Retained   bool
	Duplicate  bool
	MessageID  uint16
	Payload    []byte
	Decoded    interface{}
	Encoding   string
	ReceivedAt time.Time
}

type mqttTopicDescriptor struct {
	Filter   string
	Default  bool
	Wildcard bool
	Source   string
}

type pahoMQTTRuntime struct {
	// mu 保护 client/closed。FetchMessages 会在 4~30 秒的等待窗口结束后才在 defer 里
	// 解引用客户端，而保活失败或用户断开会并发调用 Close()。若 Close 直接把 client 置 nil，
	// 在途读者的 nil 接口方法调用会 panic 并崩掉整个 Wails 桌面进程，
	// 因此 Close 只置 closed 标志，字段本身保留给在途读者。
	mu      sync.RWMutex
	client  pahomqtt.Client
	closed  bool
	timeout time.Duration
}

// activeClient 取出可用的客户端快照。调用方必须全程只使用返回的局部变量
// （含 defer 里的 Unsubscribe），不能再读 r.client，否则并发 Close 会重新引入竞争。
func (r *pahoMQTTRuntime) activeClient() (pahomqtt.Client, error) {
	if r == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.closed || r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return r.client, nil
}

var newMQTTRuntime = func(config connection.ConnectionConfig) (mqttRuntime, error) {
	return newPahoMQTTRuntime(config)
}

type MQTTDB struct {
	runtime       mqttRuntime
	forwarders    []*ssh.LocalForwarder
	brokers       []string
	defaultTopic  string
	topics        []mqttTopicDescriptor
	defaultQoS    byte
	defaultRetain bool
	cleanSession  bool
	fetchWait     time.Duration
}

func (m *MQTTDB) Connect(config connection.ConnectionConfig) error {
	_ = m.Close()

	runConfig := normalizeMQTTConfig(config)
	if runConfig.UseSSH {
		sshConfig, brokers, forwarders, err := mqttForwardBrokersOverSSH(runConfig)
		if err != nil {
			return err
		}
		m.forwarders = forwarders
		runConfig = sshConfig
		runConfig.Hosts = brokers[1:]
		host, port, ok := parseHostPortWithDefault(brokers[0], defaultMQTTPort)
		if !ok {
			_ = m.Close()
			return fmt.Errorf("解析 MQTT SSH 转发地址失败：%s", brokers[0])
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("MQTT 通过 SSH 端口转发连接：brokers=%s", strings.Join(brokers, ","))
	}

	runtime, err := newMQTTRuntime(runConfig)
	if err != nil {
		_ = m.Close()
		return err
	}
	m.runtime = runtime
	m.defaultTopic = mqttDefaultTopic(runConfig)
	m.topics = mqttConfiguredTopics(runConfig, m.defaultTopic)
	m.defaultQoS = mqttDefaultQoS(runConfig)
	m.defaultRetain = mqttDefaultRetain(runConfig)
	m.cleanSession = mqttCleanSession(runConfig)
	m.fetchWait = mqttFetchWait(runConfig)
	m.brokers, _ = mqttBrokerAddresses(runConfig)

	if err := m.Ping(); err != nil {
		_ = m.Close()
		return err
	}
	return nil
}

func (m *MQTTDB) Close() error {
	var firstErr error
	if m.runtime != nil {
		if err := m.runtime.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		// 不置 nil：并发的 QueryContext/Publish 已通过 m.runtime != nil 检查后才解引用，
		// 置 nil 会让它们在 nil 接口上调用方法并崩掉整个进程。
		// 关闭后的 runtime 会对所有调用返回「连接未打开」，与置 nil 后的报错口径一致。
	}
	for _, forwarder := range m.forwarders {
		if forwarder == nil {
			continue
		}
		if err := forwarder.Release(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	m.forwarders = nil
	m.brokers = nil
	m.defaultTopic = ""
	m.topics = nil
	m.defaultQoS = 0
	m.defaultRetain = false
	m.cleanSession = false
	m.fetchWait = 0
	return firstErr
}

func (m *MQTTDB) Ping() error {
	if m.runtime == nil {
		return fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return m.runtime.Ping(ctx)
}

func (m *MQTTDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultMQTTQueryTimeout)
	defer cancel()
	return m.QueryContext(ctx, query)
}

func (m *MQTTDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.runtime == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}
	parsed, ok := parseMQTTSQL(text)
	if !ok {
		return nil, nil, fmt.Errorf("MQTT 查询仅支持 SHOW TOPICS、DESCRIBE TOPIC、SELECT * FROM topic 与 CONSUME FROM topic")
	}

	switch parsed.Action {
	case "show_topics":
		rows := mqttTopicRows(m.topics, m.defaultQoS, m.defaultRetain)
		if parsed.Limit > 0 && len(rows) > parsed.Limit {
			rows = rows[:parsed.Limit]
		}
		return rows, collectColumns(rows), nil
	case "describe_topic":
		topic := mqttResolveTopic(parsed.Topic, m.defaultTopic)
		if topic == "" {
			return nil, nil, fmt.Errorf("MQTT topic 不能为空")
		}
		rows := []map[string]interface{}{mqttDescribeTopicRow(topic, m.topics, m.defaultQoS, m.defaultRetain, m.cleanSession, m.fetchWait, m.brokers)}
		return rows, collectColumns(rows), nil
	case "select", "consume":
		if parsed.Count {
			return nil, nil, fmt.Errorf("MQTT 不支持 COUNT(*) 总量统计；请使用 SELECT * FROM topic LIMIT n 预览实时消息")
		}
		topic := mqttResolveTopic(parsed.Topic, m.defaultTopic)
		if topic == "" {
			return nil, nil, fmt.Errorf("MQTT topic 不能为空")
		}
		records, err := m.runtime.FetchMessages(ctx, mqttFetchRequest{
			Topic:  topic,
			Limit:  parsed.Limit,
			Offset: parsed.Offset,
			QoS:    m.defaultQoS,
			Wait:   m.fetchWait,
		})
		if err != nil {
			return nil, nil, err
		}
		rows := mqttMessageRows(records)
		return rows, collectColumns(rows), nil
	default:
		return nil, nil, fmt.Errorf("未实现的 MQTT 查询类型：%s", parsed.Action)
	}
}

func (m *MQTTDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultMQTTQueryTimeout)
	defer cancel()
	return m.ExecContext(ctx, query)
}

func (m *MQTTDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if m.runtime == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("MQTT 写入命令必须是 JSON：%w", err)
	}

	topic := mqttResolveTopic(firstStringValue(cmd, "publish", "topic", "destination"), m.defaultTopic)
	if err := mqttValidatePublishTopic(topic); err != nil {
		return 0, err
	}
	if !hasAnyKey(cmd, "payload", "value", "body", "message") {
		return 0, fmt.Errorf("MQTT publish 命令缺少 payload")
	}
	qos, err := mqttQoSFromAny(firstExisting(cmd, "qos"), m.defaultQoS)
	if err != nil {
		return 0, err
	}
	retain := mqttBoolFromAny(firstExisting(cmd, "retain", "retained"), m.defaultRetain)

	return m.runtime.Publish(ctx, mqttPublishCommand{
		Topic:   topic,
		Payload: firstExisting(cmd, "payload", "value", "body", "message"),
		QoS:     qos,
		Retain:  retain,
	})
}

func (m *MQTTDB) GetDatabases() ([]string, error) {
	if m.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return []string{mqttSyntheticDatabase}, nil
}

func (m *MQTTDB) GetTables(dbName string) ([]string, error) {
	if m.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	names := make([]string, 0, len(m.topics))
	for _, topic := range m.topics {
		if strings.TrimSpace(topic.Filter) != "" {
			names = append(names, topic.Filter)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (m *MQTTDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if m.runtime == nil {
		return "", fmt.Errorf("连接未打开")
	}
	topic := mqttResolveTopic(tableName, m.defaultTopic)
	if topic == "" {
		return "", fmt.Errorf("MQTT topic 不能为空")
	}
	payload, _ := json.MarshalIndent(
		mqttDescribeTopicRow(topic, m.topics, m.defaultQoS, m.defaultRetain, m.cleanSession, m.fetchWait, m.brokers),
		"",
		"  ",
	)
	return fmt.Sprintf("// MQTT topic filter: %s\n%s", topic, string(payload)), nil
}

func (m *MQTTDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if m.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	topic := mqttResolveTopic(tableName, m.defaultTopic)
	if topic == "" {
		return nil, fmt.Errorf("MQTT topic 不能为空")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	records, err := m.runtime.FetchMessages(ctx, mqttFetchRequest{
		Topic: topic,
		Limit: 20,
		QoS:   m.defaultQoS,
		Wait:  m.fetchWait,
	})
	if err != nil {
		return nil, err
	}
	rows := mqttMessageRows(records)
	columns := []connection.ColumnDefinition{
		{Name: "topic", Type: "string", Nullable: "NO", Comment: "MQTT topic"},
		{Name: "qos", Type: "tinyint", Nullable: "NO", Comment: "MQTT QoS level"},
		{Name: "retained", Type: "bool", Nullable: "YES", Comment: "Whether the message is retained"},
		{Name: "duplicate", Type: "bool", Nullable: "YES", Comment: "Whether the message is marked as duplicate"},
		{Name: "message_id", Type: "int", Nullable: "YES", Comment: "MQTT message id"},
		{Name: "payload", Type: "json", Nullable: "YES", Comment: "Decoded MQTT payload"},
		{Name: "payload_encoding", Type: "string", Nullable: "YES", Comment: "json / text / base64"},
		{Name: "payload_bytes", Type: "int", Nullable: "YES", Comment: "Payload size in bytes"},
		{Name: "received_at", Type: "timestamp", Nullable: "YES", Comment: "Client receive timestamp"},
	}
	seen := map[string]struct{}{
		"topic": {}, "qos": {}, "retained": {}, "duplicate": {}, "message_id": {},
		"payload": {}, "payload_encoding": {}, "payload_bytes": {}, "received_at": {},
	}
	for _, row := range rows {
		for key, value := range row {
			if _, exists := seen[key]; exists {
				continue
			}
			if !strings.HasPrefix(key, "payload.") {
				continue
			}
			seen[key] = struct{}{}
			columns = append(columns, connection.ColumnDefinition{
				Name:     key,
				Type:     inferChromaValueType(value),
				Nullable: "YES",
				Comment:  "Derived MQTT payload field",
			})
		}
	}
	return columns, nil
}

func (m *MQTTDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := m.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	for _, table := range tables {
		cols, err := m.GetColumns(dbName, table)
		if err != nil {
			continue
		}
		for _, col := range cols {
			result = append(result, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      col.Name,
				Type:      col.Type,
				Comment:   col.Comment,
			})
		}
	}
	return result, nil
}

func (m *MQTTDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{
		{Name: "TOPIC_RECEIVED_AT", ColumnName: "topic", NonUnique: 1, SeqInIndex: 1, IndexType: "SUBSCRIPTION"},
		{Name: "TOPIC_RECEIVED_AT", ColumnName: "received_at", NonUnique: 1, SeqInIndex: 2, IndexType: "SUBSCRIPTION"},
	}, nil
}

func (m *MQTTDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (m *MQTTDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (m *MQTTDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if len(changes.Inserts) == 0 && len(changes.Updates) == 0 && len(changes.Deletes) == 0 {
		return nil
	}
	return fmt.Errorf("MQTT 结果集仅支持只读预览；如需写入请在 SQL 编辑器执行 JSON publish 命令")
}

func normalizeMQTTConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyMQTTURI(config)
	if strings.TrimSpace(runConfig.Host) == "" && len(runConfig.Hosts) == 0 {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultMQTTPort
	}
	params := mqttConnectionParams(runConfig)
	transport := mqttTransportScheme(runConfig)
	if transport == "ssl" || transport == "wss" || mqttBoolValue(firstNonEmpty(params.Get("ssl"), params.Get("tls"), params.Get("useSSL"), params.Get("use_ssl"))) {
		runConfig.UseSSL = true
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		if mqttBoolValue(firstNonEmpty(params.Get("skip_verify"), params.Get("skipVerify"), params.Get("insecure"))) {
			runConfig.SSLMode = "skip-verify"
		} else {
			runConfig.SSLMode = "required"
		}
	}
	return runConfig
}

func applyMQTTURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	switch scheme {
	case "mqtt", "mqtts", "tcp", "ssl", "tls", "ws", "wss":
	default:
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

	hosts := make([]string, 0, 4)
	for _, entry := range strings.Split(strings.TrimSpace(parsed.Host), ",") {
		host, port, ok := parseHostPortWithDefault(strings.TrimSpace(entry), defaultMQTTPort)
		if !ok {
			continue
		}
		hosts = append(hosts, mqttFormatHostPort(host, port))
	}
	if len(hosts) > 0 {
		host, port, ok := parseHostPortWithDefault(hosts[0], defaultMQTTPort)
		if ok {
			config.Host = host
			config.Port = port
		}
		if len(hosts) > 1 {
			config.Hosts = append([]string(nil), hosts[1:]...)
		}
	}
	if topic := strings.Trim(strings.TrimSpace(parsed.Path), "/"); topic != "" && strings.TrimSpace(config.Database) == "" {
		config.Database = topic
	}
	params := parsed.Query()
	if strings.TrimSpace(config.Topology) == "" {
		if topology := strings.ToLower(strings.TrimSpace(firstNonEmpty(params.Get("topology"), params.Get("mode")))); topology != "" {
			config.Topology = topology
		} else if len(hosts) > 1 {
			config.Topology = "cluster"
		}
	}
	if scheme == "ssl" || scheme == "tls" || scheme == "mqtts" || scheme == "wss" {
		config.UseSSL = true
		if strings.TrimSpace(config.SSLMode) == "" {
			config.SSLMode = "required"
		}
	}
	return config
}

func mqttConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "mqtt", "mqtts", "tcp", "ssl", "tls", "ws", "wss"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func mqttDefaultTopic(config connection.ConnectionConfig) string {
	if topic := strings.TrimSpace(config.Database); topic != "" {
		return topic
	}
	params := mqttConnectionParams(config)
	return strings.TrimSpace(firstNonEmpty(params.Get("defaultTopic"), params.Get("default_topic"), params.Get("topic")))
}

func mqttConfiguredTopics(config connection.ConnectionConfig, defaultTopic string) []mqttTopicDescriptor {
	seen := make(map[string]struct{})
	topics := make([]mqttTopicDescriptor, 0, 8)
	appendTopic := func(raw string, isDefault bool, source string) {
		filter := strings.TrimSpace(raw)
		if filter == "" {
			return
		}
		if _, ok := seen[filter]; ok {
			if isDefault {
				for index := range topics {
					if topics[index].Filter == filter {
						topics[index].Default = true
					}
				}
			}
			return
		}
		seen[filter] = struct{}{}
		topics = append(topics, mqttTopicDescriptor{
			Filter:   filter,
			Default:  isDefault,
			Wildcard: strings.ContainsAny(filter, "#+"),
			Source:   source,
		})
	}

	appendTopic(defaultTopic, defaultTopic != "", "default")

	params := mqttConnectionParams(config)
	for _, key := range []string{"topics", "topicFilters", "topic_filters", "subscriptions", "subscription", "subscribe"} {
		for _, value := range params[key] {
			for _, part := range splitMQTTTopicList(value) {
				appendTopic(part, false, key)
			}
		}
	}

	sort.SliceStable(topics, func(i, j int) bool {
		if topics[i].Default != topics[j].Default {
			return topics[i].Default
		}
		return topics[i].Filter < topics[j].Filter
	})
	return topics
}

func splitMQTTTopicList(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\r'
	})
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		if text := strings.TrimSpace(field); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func mqttDefaultQoS(config connection.ConnectionConfig) byte {
	value, err := mqttQoSFromAny(firstNonEmpty(mqttConnectionParams(config).Get("qos"), "0"), 0)
	if err != nil {
		return 0
	}
	return value
}

func mqttDefaultRetain(config connection.ConnectionConfig) bool {
	params := mqttConnectionParams(config)
	return mqttBoolValue(firstNonEmpty(params.Get("retain"), params.Get("retained")))
}

func mqttCleanSession(config connection.ConnectionConfig) bool {
	params := mqttConnectionParams(config)
	value := strings.TrimSpace(firstNonEmpty(params.Get("cleanSession"), params.Get("clean_session")))
	if value == "" {
		return true
	}
	return mqttBoolValue(value)
}

func mqttFetchWait(config connection.ConnectionConfig) time.Duration {
	params := mqttConnectionParams(config)
	for _, key := range []string{"fetchWaitMs", "fetch_wait_ms", "waitMs", "wait_ms"} {
		if value := strings.TrimSpace(params.Get(key)); value != "" {
			if ms, err := strconv.Atoi(value); err == nil && ms > 0 {
				wait := time.Duration(ms) * time.Millisecond
				if wait > maxMQTTFetchWait {
					return maxMQTTFetchWait
				}
				return wait
			}
		}
	}
	for _, key := range []string{"fetchWait", "wait"} {
		if value := strings.TrimSpace(params.Get(key)); value != "" {
			if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
				wait := time.Duration(seconds) * time.Second
				if wait > maxMQTTFetchWait {
					return maxMQTTFetchWait
				}
				return wait
			}
		}
	}
	return defaultMQTTFetchWait
}

func mqttClientID(config connection.ConnectionConfig) string {
	params := mqttConnectionParams(config)
	if clientID := strings.TrimSpace(firstNonEmpty(params.Get("clientId"), params.Get("client_id"))); clientID != "" {
		return clientID
	}
	if id := strings.TrimSpace(config.ID); id != "" {
		return mqttDefaultClientID + "-" + id
	}
	return fmt.Sprintf("%s-%d", mqttDefaultClientID, time.Now().UnixNano())
}

func mqttTransportScheme(config connection.ConnectionConfig) string {
	if parsed, err := url.Parse(strings.TrimSpace(config.URI)); err == nil {
		switch strings.ToLower(strings.TrimSpace(parsed.Scheme)) {
		case "ssl", "tls", "mqtts":
			return "ssl"
		case "wss":
			return "wss"
		case "ws":
			return "ws"
		case "tcp", "mqtt":
			return "tcp"
		}
	}
	params := mqttConnectionParams(config)
	switch strings.ToLower(strings.TrimSpace(firstNonEmpty(params.Get("transport"), params.Get("scheme")))) {
	case "ssl", "tls", "mqtts":
		return "ssl"
	case "wss":
		return "wss"
	case "ws":
		return "ws"
	}
	if config.UseSSL {
		return "ssl"
	}
	return "tcp"
}

func mqttBrokerAddresses(config connection.ConnectionConfig) ([]string, error) {
	hosts := make([]string, 0, 4)
	if host, port, ok := parseHostPortWithDefault(net.JoinHostPort(strings.TrimSpace(config.Host), strconv.Itoa(config.Port)), defaultMQTTPort); ok && strings.TrimSpace(host) != "" {
		hosts = append(hosts, mqttFormatHostPort(host, port))
	}
	for _, entry := range config.Hosts {
		host, port, ok := parseHostPortWithDefault(strings.TrimSpace(entry), defaultMQTTPort)
		if !ok {
			continue
		}
		hosts = append(hosts, mqttFormatHostPort(host, port))
	}
	hosts = uniqueStringsPreserveOrder(hosts)
	if len(hosts) == 0 {
		return nil, fmt.Errorf("MQTT 至少需要一个 broker 地址")
	}
	return hosts, nil
}

func mqttFormatHostPort(host string, port int) string {
	return net.JoinHostPort(strings.TrimSpace(host), strconv.Itoa(port))
}

func mqttForwardBrokersOverSSH(config connection.ConnectionConfig) (connection.ConnectionConfig, []string, []*ssh.LocalForwarder, error) {
	brokers, err := mqttBrokerAddresses(config)
	if err != nil {
		return connection.ConnectionConfig{}, nil, nil, err
	}
	runConfig := config
	forwarders := make([]*ssh.LocalForwarder, 0, len(brokers))
	cleanupForwarders := true
	defer func() {
		if !cleanupForwarders {
			return
		}
		for _, forwarder := range forwarders {
			_ = forwarder.Release()
		}
	}()
	rewritten := make([]string, 0, len(brokers))
	for _, broker := range brokers {
		host, port, ok := parseHostPortWithDefault(broker, defaultMQTTPort)
		if !ok {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("解析 MQTT broker 地址失败：%s", broker)
		}
		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, host, port)
		if err != nil {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("创建 MQTT SSH 隧道失败：%w", err)
		}
		forwarders = append(forwarders, forwarder)
		rewritten = append(rewritten, forwarder.LocalAddr)
	}
	cleanupForwarders = false
	return runConfig, rewritten, forwarders, nil
}

func newPahoMQTTRuntime(config connection.ConnectionConfig) (mqttRuntime, error) {
	brokers, err := mqttBrokerAddresses(config)
	if err != nil {
		return nil, err
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	transport := mqttTransportScheme(config)
	if config.UseProxy && (transport == "ws" || transport == "wss") {
		return nil, fmt.Errorf("MQTT 当前暂不支持通过代理建立 WebSocket 连接，请改用 tcp/ssl")
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}

	options := pahomqtt.NewClientOptions().
		SetClientID(mqttClientID(config)).
		SetCleanSession(mqttCleanSession(config)).
		SetOrderMatters(false).
		SetAutoReconnect(false).
		SetConnectRetry(false).
		SetConnectTimeout(timeout).
		SetWriteTimeout(timeout)

	if user := strings.TrimSpace(config.User); user != "" {
		options.SetUsername(user)
		options.SetPassword(config.Password)
	}
	if transport == "ssl" || transport == "wss" {
		options.SetTLSConfig(tlsConfig)
	}
	for _, broker := range brokers {
		options.AddBroker(fmt.Sprintf("%s://%s", transport, broker))
	}
	if config.UseProxy {
		options.SetCustomOpenConnectionFn(mqttProxyOpenConnectionFn(config.Proxy, timeout, tlsConfig))
	}

	client := pahomqtt.NewClient(options)
	token := client.Connect()
	if !token.WaitTimeout(timeout + 5*time.Second) {
		return nil, localizedDatabaseRuntimeError("db.backend.error.mqtt_connect_timeout", nil)
	}
	if err := token.Error(); err != nil {
		return nil, err
	}
	return &pahoMQTTRuntime{
		client:  client,
		timeout: timeout,
	}, nil
}

func mqttProxyOpenConnectionFn(proxyConfig connection.ProxyConfig, timeout time.Duration, tlsConfig *tls.Config) func(uri *url.URL, options pahomqtt.ClientOptions) (net.Conn, error) {
	return func(uri *url.URL, options pahomqtt.ClientOptions) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()

		conn, err := proxytunnel.DialContext(ctx, proxyConfig, "tcp", uri.Host)
		if err != nil {
			return nil, err
		}
		if uri.Scheme != "ssl" && uri.Scheme != "wss" {
			return conn, nil
		}

		effectiveTLS := tlsConfig
		if effectiveTLS == nil {
			effectiveTLS = options.TLSConfig
		}
		if effectiveTLS == nil {
			effectiveTLS = &tls.Config{}
		}
		cloned := effectiveTLS.Clone()
		if cloned.ServerName == "" {
			host, _, splitErr := net.SplitHostPort(uri.Host)
			if splitErr == nil {
				cloned.ServerName = host
			} else {
				cloned.ServerName = uri.Host
			}
		}

		tlsConn := tls.Client(conn, cloned)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}
}

func (r *pahoMQTTRuntime) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	if r.closed || r.client == nil {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	client := r.client
	r.mu.Unlock()

	// 只断开连接，不把 r.client 置 nil：仍在等待消息的 FetchMessages 会在其 defer 里
	// 通过快照解引用同一个客户端，置 nil 会让它 panic 并崩掉整个进程。
	// paho 的 Unsubscribe/Publish 在已断开的客户端上只会返回错误，不会 panic。
	client.Disconnect(250)
	return nil
}

func (r *pahoMQTTRuntime) Ping(ctx context.Context) error {
	client, err := r.activeClient()
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if !client.IsConnectionOpen() {
		return fmt.Errorf("MQTT 连接已断开")
	}
	return nil
}

func (r *pahoMQTTRuntime) FetchMessages(ctx context.Context, request mqttFetchRequest) ([]mqttMessageRecord, error) {
	// 一次性取快照：下面要等待 4~30 秒，期间并发 Close 不能让本函数的解引用失效。
	client, err := r.activeClient()
	if err != nil {
		return nil, err
	}
	if !client.IsConnectionOpen() {
		return nil, fmt.Errorf("MQTT 连接已断开")
	}

	limit := request.Limit
	if limit <= 0 {
		limit = defaultMQTTPreviewLimit
	}
	offset := request.Offset
	if offset < 0 {
		offset = 0
	}
	wait := request.Wait
	if wait <= 0 {
		wait = defaultMQTTFetchWait
	}
	if wait > maxMQTTFetchWait {
		wait = maxMQTTFetchWait
	}

	bufferSize := limit + offset + 8
	if bufferSize < 8 {
		bufferSize = 8
	}
	if bufferSize > 1024 {
		bufferSize = 1024
	}
	messageCh := make(chan mqttMessageRecord, bufferSize)
	callback := func(_ pahomqtt.Client, msg pahomqtt.Message) {
		record := mqttRecordFromMessage(msg)
		select {
		case messageCh <- record:
		default:
		}
	}

	token := client.Subscribe(request.Topic, request.QoS, callback)
	if !token.WaitTimeout(r.timeout) {
		return nil, localizedDatabaseRuntimeError("db.backend.error.mqtt_subscribe_timeout", nil)
	}
	if err := token.Error(); err != nil {
		return nil, fmt.Errorf("MQTT 订阅失败：%w", err)
	}
	defer func() {
		// 用快照而非 r.client：等待期间可能已并发 Close。
		unsub := client.Unsubscribe(request.Topic)
		if !unsub.WaitTimeout(r.timeout) {
			logger.Warnf("MQTT 取消订阅超时：%s", request.Topic)
			return
		}
		if err := unsub.Error(); err != nil {
			logger.Warnf("MQTT 取消订阅失败：topic=%s err=%v", request.Topic, err)
		}
	}()

	timer := time.NewTimer(wait)
	defer timer.Stop()

	result := make([]mqttMessageRecord, 0, limit)
	for len(result) < limit {
		select {
		case <-ctx.Done():
			if len(result) > 0 {
				return result, nil
			}
			return nil, ctx.Err()
		case <-timer.C:
			return result, nil
		case record := <-messageCh:
			if offset > 0 {
				offset--
				continue
			}
			result = append(result, record)
		}
	}
	return result, nil
}

func (r *pahoMQTTRuntime) Publish(ctx context.Context, command mqttPublishCommand) (int64, error) {
	client, err := r.activeClient()
	if err != nil {
		return 0, err
	}
	if !client.IsConnectionOpen() {
		return 0, fmt.Errorf("MQTT 连接已断开")
	}
	payload, err := mqttEncodePayload(command.Payload)
	if err != nil {
		return 0, err
	}
	token := client.Publish(command.Topic, command.QoS, command.Retain, payload)
	wait := r.timeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < wait {
			wait = remaining
		}
	}
	if !token.WaitTimeout(wait) {
		return 0, localizedDatabaseRuntimeError("db.backend.error.mqtt_publish_timeout", nil)
	}
	if err := token.Error(); err != nil {
		return 0, err
	}
	return 1, nil
}

func mqttEncodePayload(payload interface{}) ([]byte, error) {
	switch typed := payload.(type) {
	case nil:
		return []byte{}, nil
	case []byte:
		return typed, nil
	case string:
		return []byte(typed), nil
	default:
		return json.Marshal(typed)
	}
}

func mqttRecordFromMessage(message pahomqtt.Message) mqttMessageRecord {
	decoded, encoding := mqttDecodePayload(message.Payload())
	return mqttMessageRecord{
		Topic:      message.Topic(),
		QoS:        message.Qos(),
		Retained:   message.Retained(),
		Duplicate:  message.Duplicate(),
		MessageID:  message.MessageID(),
		Payload:    append([]byte(nil), message.Payload()...),
		Decoded:    decoded,
		Encoding:   encoding,
		ReceivedAt: time.Now(),
	}
}

func mqttDecodePayload(payload []byte) (interface{}, string) {
	if payload == nil {
		return nil, "text"
	}
	var decoded interface{}
	if err := decodeJSONWithUseNumber(payload, &decoded); err == nil {
		return decoded, "json"
	}
	if utf8.Valid(payload) {
		return string(payload), "text"
	}
	return base64.StdEncoding.EncodeToString(payload), "base64"
}

type mqttParsedSQL struct {
	Action string
	Topic  string
	Limit  int
	Offset int
	Count  bool
}

var (
	mqttSQLFromRE       = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
	mqttSQLLimitRE      = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	mqttSQLOffsetRE     = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	mqttShowTopicsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+TOPICS(?:\s+LIMIT\s+(\d+))?\s*;?\s*$`)
	mqttDescribeTopicRE = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+TOPIC\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))\s*;?\s*$`)
	mqttConsumeTopicRE  = regexp.MustCompile(`(?i)^\s*CONSUME\s+FROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
)

func parseMQTTSQL(sqlText string) (mqttParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if text == "" {
		return mqttParsedSQL{}, false
	}
	if matches := mqttShowTopicsRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := mqttParsedSQL{Action: "show_topics"}
		if len(matches) > 1 && strings.TrimSpace(matches[1]) != "" {
			parsed.Limit, _ = strconv.Atoi(matches[1])
		}
		return parsed, true
	}
	if matches := mqttDescribeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		return mqttParsedSQL{
			Action: "describe_topic",
			Topic:  mqttTrimIdentifier(firstNonEmpty(matches[1], matches[2], matches[3])),
		}, true
	}
	if matches := mqttConsumeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := mqttParsedSQL{
			Action: "consume",
			Topic:  mqttTrimIdentifier(firstNonEmpty(matches[1], matches[2], matches[3])),
			Limit:  defaultMQTTPreviewLimit,
		}
		if limitMatch := mqttSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
			parsed.Limit, _ = strconv.Atoi(limitMatch[1])
		}
		if offsetMatch := mqttSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
			parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
		}
		return parsed, true
	}
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return mqttParsedSQL{}, false
	}
	matches := mqttSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return mqttParsedSQL{}, false
	}
	parsed := mqttParsedSQL{
		Action: "select",
		Topic:  mqttTrimIdentifier(firstNonEmpty(matches[1], matches[2], matches[3])),
		Limit:  defaultMQTTPreviewLimit,
		Count:  strings.Contains(strings.ToLower(text), "count("),
	}
	if limitMatch := mqttSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
		parsed.Limit, _ = strconv.Atoi(limitMatch[1])
	}
	if offsetMatch := mqttSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
		parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
	}
	return parsed, true
}

func mqttTrimIdentifier(value string) string {
	return strings.TrimSuffix(strings.TrimSpace(value), ";")
}

func mqttResolveTopic(raw string, fallback string) string {
	return strings.TrimSpace(firstNonEmpty(raw, fallback))
}

func mqttValidatePublishTopic(topic string) error {
	text := strings.TrimSpace(topic)
	if text == "" {
		return fmt.Errorf("MQTT publish 命令缺少 topic")
	}
	if strings.ContainsAny(text, "#+") {
		return fmt.Errorf("MQTT publish topic 不能包含通配符：%s", text)
	}
	return nil
}

func mqttQoSFromAny(value interface{}, fallback byte) (byte, error) {
	if value == nil {
		return fallback, nil
	}
	qosValue := intFromAny(value, int(fallback))
	if qosValue < 0 || qosValue > 2 {
		return 0, fmt.Errorf("MQTT QoS 仅支持 0、1、2")
	}
	return byte(qosValue), nil
}

func mqttBoolFromAny(value interface{}, fallback bool) bool {
	if value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return mqttBoolValue(typed)
	default:
		return mqttBoolValue(fmt.Sprintf("%v", value))
	}
}

func mqttBoolValue(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on", "required":
		return true
	default:
		return false
	}
}

func mqttTopicRows(topics []mqttTopicDescriptor, defaultQoS byte, defaultRetain bool) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(topics))
	for _, topic := range topics {
		rows = append(rows, map[string]interface{}{
			"topic":     topic.Filter,
			"default":   topic.Default,
			"wildcard":  topic.Wildcard,
			"default_qos": int(defaultQoS),
			"retain":    defaultRetain,
			"source":    topic.Source,
		})
	}
	return rows
}

func mqttDescribeTopicRow(topic string, topics []mqttTopicDescriptor, defaultQoS byte, defaultRetain bool, cleanSession bool, fetchWait time.Duration, brokers []string) map[string]interface{} {
	configured := false
	isDefault := false
	wildcard := strings.ContainsAny(topic, "#+")
	source := ""
	for _, entry := range topics {
		if entry.Filter == topic {
			configured = true
			isDefault = entry.Default
			wildcard = entry.Wildcard
			source = entry.Source
			break
		}
	}
	return map[string]interface{}{
		"topic":          topic,
		"configured":     configured,
		"default":        isDefault,
		"wildcard":       wildcard,
		"source":         source,
		"default_qos":    int(defaultQoS),
		"default_retain": defaultRetain,
		"clean_session":  cleanSession,
		"fetch_wait_ms":  fetchWait.Milliseconds(),
		"broker_count":   len(brokers),
		"brokers":        append([]string(nil), brokers...),
	}
}

func mqttMessageRows(records []mqttMessageRecord) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(records))
	for _, record := range records {
		row := map[string]interface{}{
			"topic":            record.Topic,
			"qos":              int(record.QoS),
			"retained":         record.Retained,
			"duplicate":        record.Duplicate,
			"message_id":       int(record.MessageID),
			"payload":          record.Decoded,
			"payload_encoding": record.Encoding,
			"payload_bytes":    len(record.Payload),
			"received_at":      record.ReceivedAt.Format(time.RFC3339Nano),
		}
		if payloadMap, ok := record.Decoded.(map[string]interface{}); ok {
			flattenMQTTMap("payload", payloadMap, row)
		}
		rows = append(rows, row)
	}
	return rows
}

func flattenMQTTMap(prefix string, values map[string]interface{}, row map[string]interface{}) {
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		name := prefix + "." + key
		row[name] = value
		if nested, ok := value.(map[string]interface{}); ok {
			flattenMQTTMap(name, nested, row)
		}
	}
}

func uniqueStringsPreserveOrder(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		key := strings.TrimSpace(value)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result
}
