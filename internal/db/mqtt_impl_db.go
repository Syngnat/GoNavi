package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

type MQTTDB struct {
	lifecycleMu sync.Mutex
	mu          sync.RWMutex

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

type mqttDBSnapshot struct {
	runtime       mqttRuntime
	brokers       []string
	defaultTopic  string
	topics        []mqttTopicDescriptor
	defaultQoS    byte
	defaultRetain bool
	cleanSession  bool
	fetchWait     time.Duration
}

func (m *MQTTDB) snapshot() (mqttDBSnapshot, error) {
	if m == nil {
		return mqttDBSnapshot{}, fmt.Errorf("连接未打开")
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.runtime == nil {
		return mqttDBSnapshot{}, fmt.Errorf("连接未打开")
	}
	return mqttDBSnapshot{
		runtime:       m.runtime,
		brokers:       append([]string(nil), m.brokers...),
		defaultTopic:  m.defaultTopic,
		topics:        append([]mqttTopicDescriptor(nil), m.topics...),
		defaultQoS:    m.defaultQoS,
		defaultRetain: m.defaultRetain,
		cleanSession:  m.cleanSession,
		fetchWait:     m.fetchWait,
	}, nil
}

func (m *MQTTDB) detachState() (mqttRuntime, []*ssh.LocalForwarder) {
	m.mu.Lock()
	defer m.mu.Unlock()
	runtime := m.runtime
	forwarders := m.forwarders
	m.runtime = nil
	m.forwarders = nil
	m.brokers = nil
	m.defaultTopic = ""
	m.topics = nil
	m.defaultQoS = 0
	m.defaultRetain = false
	m.cleanSession = false
	m.fetchWait = 0
	return runtime, forwarders
}

func closeMQTTResources(runtime mqttRuntime, forwarders []*ssh.LocalForwarder) error {
	var firstErr error
	if runtime != nil {
		if err := runtime.Close(); err != nil {
			firstErr = err
		}
	}
	for _, forwarder := range forwarders {
		if forwarder == nil {
			continue
		}
		if err := forwarder.Release(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (m *MQTTDB) Connect(config connection.ConnectionConfig) error {
	if m == nil {
		return fmt.Errorf("连接未打开")
	}
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()

	oldRuntime, oldForwarders := m.detachState()
	_ = closeMQTTResources(oldRuntime, oldForwarders)

	runConfig := normalizeMQTTConfig(config)
	var forwarders []*ssh.LocalForwarder
	if runConfig.UseSSH {
		sshConfig, brokers, sshForwarders, err := mqttForwardBrokersOverSSH(runConfig)
		if err != nil {
			return err
		}
		forwarders = sshForwarders
		runConfig = sshConfig
		runConfig.Hosts = brokers[1:]
		host, port, ok := parseHostPortWithDefault(brokers[0], defaultMQTTPort)
		if !ok {
			_ = closeMQTTResources(nil, forwarders)
			return fmt.Errorf("解析 MQTT SSH 转发地址失败：%s", brokers[0])
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("MQTT 通过 SSH 端口转发连接：brokers=%s", strings.Join(brokers, ","))
	}

	runtime, err := newMQTTRuntime(runConfig)
	if err != nil {
		_ = closeMQTTResources(nil, forwarders)
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = runtime.Ping(ctx)
	cancel()
	if err != nil {
		_ = closeMQTTResources(runtime, forwarders)
		return err
	}

	defaultTopic := mqttDefaultTopic(runConfig)
	brokers, err := mqttBrokerAddresses(runConfig)
	if err != nil {
		_ = closeMQTTResources(runtime, forwarders)
		return err
	}
	m.mu.Lock()
	m.runtime = runtime
	m.forwarders = forwarders
	m.brokers = brokers
	m.defaultTopic = defaultTopic
	m.topics = mqttConfiguredTopics(runConfig, defaultTopic)
	m.defaultQoS = mqttDefaultQoS(runConfig)
	m.defaultRetain = mqttDefaultRetain(runConfig)
	m.cleanSession = mqttCleanSession(runConfig)
	m.fetchWait = mqttFetchWait(runConfig)
	m.mu.Unlock()
	return nil
}

func (m *MQTTDB) Close() error {
	if m == nil {
		return nil
	}
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	runtime, forwarders := m.detachState()
	return closeMQTTResources(runtime, forwarders)
}

func (m *MQTTDB) Ping() error {
	state, err := m.snapshot()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return state.runtime.Ping(ctx)
}

func (m *MQTTDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultMQTTQueryTimeout)
	defer cancel()
	return m.QueryContext(ctx, query)
}

func (m *MQTTDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	state, err := m.snapshot()
	if err != nil {
		return nil, nil, err
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}
	parsed, ok := parseMQTTSQL(text)
	if !ok {
		return nil, nil, fmt.Errorf("MQTT 查询仅支持 SHOW TOPICS、DESCRIBE TOPIC、SELECT * FROM topic、CONSUME FROM topic 与 UNSUBSCRIBE FROM topic")
	}

	switch parsed.Action {
	case "show_topics":
		rows := mqttTopicRows(state.topics, state.defaultQoS, state.defaultRetain)
		if parsed.Limit > 0 && len(rows) > parsed.Limit {
			rows = rows[:parsed.Limit]
		}
		return rows, collectColumns(rows), nil
	case "describe_topic":
		topic := mqttResolveTopic(parsed.Topic, state.defaultTopic)
		if topic == "" {
			return nil, nil, fmt.Errorf("MQTT topic 不能为空")
		}
		rows := []map[string]interface{}{mqttDescribeTopicRow(topic, state.topics, state.defaultQoS, state.defaultRetain, state.cleanSession, state.fetchWait, state.brokers)}
		return rows, collectColumns(rows), nil
	case "select", "consume":
		if parsed.Count {
			return nil, nil, fmt.Errorf("MQTT 不支持 COUNT(*) 总量统计；请使用 SELECT * FROM topic LIMIT n 预览实时消息")
		}
		topic := mqttResolveTopic(parsed.Topic, state.defaultTopic)
		if topic == "" {
			return nil, nil, fmt.Errorf("MQTT topic 不能为空")
		}
		qos := state.defaultQoS
		if parsed.HasQoS {
			qos = parsed.QoS
		}
		records, err := state.runtime.FetchMessages(ctx, mqttFetchRequest{
			Topic:  topic,
			Limit:  parsed.Limit,
			Offset: parsed.Offset,
			QoS:    qos,
			Wait:   state.fetchWait,
		})
		if err != nil {
			return nil, nil, err
		}
		rows := mqttMessageRows(records)
		return rows, collectColumns(rows), nil
	case "unsubscribe":
		topic := strings.TrimSpace(parsed.Topic)
		if topic == "" {
			return nil, nil, fmt.Errorf("MQTT topic 不能为空")
		}
		removed, err := state.runtime.Unsubscribe(ctx, topic)
		if err != nil {
			return nil, nil, err
		}
		rows := []map[string]interface{}{{
			"topic":        topic,
			"unsubscribed": removed,
		}}
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
	state, err := m.snapshot()
	if err != nil {
		return 0, err
	}
	var cmd map[string]interface{}
	if err = decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("MQTT 写入命令必须是 JSON：%w", err)
	}

	topic := mqttResolveTopic(firstStringValue(cmd, "publish", "topic", "destination"), state.defaultTopic)
	if err := mqttValidatePublishTopic(topic); err != nil {
		return 0, err
	}
	if !hasAnyKey(cmd, "payload", "value", "body", "message") {
		return 0, fmt.Errorf("MQTT publish 命令缺少 payload")
	}
	qos, err := mqttQoSFromAny(firstExisting(cmd, "qos"), state.defaultQoS)
	if err != nil {
		return 0, err
	}
	retain := mqttBoolFromAny(firstExisting(cmd, "retain", "retained"), state.defaultRetain)

	return state.runtime.Publish(ctx, mqttPublishCommand{
		Topic:   topic,
		Payload: firstExisting(cmd, "payload", "value", "body", "message"),
		QoS:     qos,
		Retain:  retain,
	})
}

func (m *MQTTDB) GetDatabases() ([]string, error) {
	if _, err := m.snapshot(); err != nil {
		return nil, err
	}
	return []string{mqttSyntheticDatabase}, nil
}

func (m *MQTTDB) GetTables(dbName string) ([]string, error) {
	state, err := m.snapshot()
	if err != nil {
		return nil, err
	}
	return mqttTopicNames(state.topics), nil
}

func (m *MQTTDB) GetCreateStatement(dbName, tableName string) (string, error) {
	state, err := m.snapshot()
	if err != nil {
		return "", err
	}
	topic := mqttResolveTopic(tableName, state.defaultTopic)
	if topic == "" {
		return "", fmt.Errorf("MQTT topic 不能为空")
	}
	payload, _ := json.MarshalIndent(
		mqttDescribeTopicRow(topic, state.topics, state.defaultQoS, state.defaultRetain, state.cleanSession, state.fetchWait, state.brokers),
		"",
		"  ",
	)
	return fmt.Sprintf("// MQTT topic filter: %s\n%s", topic, string(payload)), nil
}

func (m *MQTTDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	state, err := m.snapshot()
	if err != nil {
		return nil, err
	}
	topic := mqttResolveTopic(tableName, state.defaultTopic)
	if topic == "" {
		return nil, fmt.Errorf("MQTT topic 不能为空")
	}
	return mqttMessageColumns(), nil
}

func mqttTopicNames(topics []mqttTopicDescriptor) []string {
	names := make([]string, 0, len(topics))
	for _, topic := range topics {
		if strings.TrimSpace(topic.Filter) != "" {
			names = append(names, topic.Filter)
		}
	}
	sort.Strings(names)
	return names
}

func mqttMessageColumns() []connection.ColumnDefinition {
	return []connection.ColumnDefinition{
		{Name: "stream_offset", Type: "bigint", Nullable: "NO", Comment: "Topic-filter-local monotonic message offset"},
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
}

func (m *MQTTDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	state, err := m.snapshot()
	if err != nil {
		return nil, err
	}
	tables := mqttTopicNames(state.topics)
	columns := mqttMessageColumns()
	var result []connection.ColumnDefinitionWithTable
	for _, table := range tables {
		for _, col := range columns {
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
	if _, err := m.snapshot(); err != nil {
		return nil, err
	}
	return []connection.IndexDefinition{
		{Name: "TOPIC_RECEIVED_AT", ColumnName: "topic", NonUnique: 1, SeqInIndex: 1, IndexType: "SUBSCRIPTION"},
		{Name: "TOPIC_RECEIVED_AT", ColumnName: "received_at", NonUnique: 1, SeqInIndex: 2, IndexType: "SUBSCRIPTION"},
	}, nil
}

func (m *MQTTDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	if _, err := m.snapshot(); err != nil {
		return nil, err
	}
	return []connection.ForeignKeyDefinition{}, nil
}

func (m *MQTTDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	if _, err := m.snapshot(); err != nil {
		return nil, err
	}
	return []connection.TriggerDefinition{}, nil
}

func (m *MQTTDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if _, err := m.snapshot(); err != nil {
		return err
	}
	if len(changes.Inserts) == 0 && len(changes.Updates) == 0 && len(changes.Deletes) == 0 {
		return nil
	}
	return fmt.Errorf("MQTT 结果集仅支持只读预览；如需写入请在 SQL 编辑器执行 JSON publish 命令")
}
