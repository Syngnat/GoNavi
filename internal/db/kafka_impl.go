package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
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

	kafka "github.com/segmentio/kafka-go"
	kafkasasl "github.com/segmentio/kafka-go/sasl"
	kafkaplain "github.com/segmentio/kafka-go/sasl/plain"
	kafkascram "github.com/segmentio/kafka-go/sasl/scram"
)

const (
	defaultKafkaPort         = 9092
	defaultKafkaQueryTimeout = 30 * time.Second
	defaultKafkaPreviewLimit = 100
	kafkaSyntheticDatabase   = "topics"
	kafkaFetchMaxBytes       = 1 << 20
	kafkaDefaultClientID     = "GoNavi"
)

type kafkaRuntime interface {
	Close() error
	Ping(ctx context.Context) error
	ListTopics(ctx context.Context, includeInternal bool) ([]kafkaTopicInfo, error)
	DescribeTopic(ctx context.Context, topic string) (kafkaTopicDescription, error)
	FetchMessages(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error)
	Publish(ctx context.Context, command kafkaPublishCommand) (int64, error)
}

type kafkaTopicInfo struct {
	Name       string
	Internal   bool
	Partitions []kafka.Partition
}

type kafkaTopicDescription struct {
	Name       string
	Internal   bool
	Partitions []kafkaTopicPartition
}

type kafkaTopicPartition struct {
	ID               int
	Leader           kafka.Broker
	Replicas         []kafka.Broker
	Isr              []kafka.Broker
	OfflineReplicas  []kafka.Broker
	EarliestOffset   int64
	LatestOffset     int64
	ApproximateCount int64
}

type kafkaFetchRequest struct {
	Topic   string
	Limit   int
	Offset  int
	GroupID string
	Latest  bool
}

type kafkaPublishCommand struct {
	Topic   string
	Key     interface{}
	Value   interface{}
	Headers map[string]interface{}
}

type kafkaMessageRecord struct {
	Message kafka.Message
	Key     interface{}
	Value   interface{}
	Headers map[string]interface{}
}

type kafkaGoRuntime struct {
	brokers    []string
	bootstrap  string
	dialer     *kafka.Dialer
	transport  *kafka.Transport
	client     *kafka.Client
	timeout    time.Duration
	readWait   time.Duration
	defaultAck kafka.RequiredAcks
}

var newKafkaRuntime = func(config connection.ConnectionConfig) (kafkaRuntime, error) {
	return newKafkaGoRuntime(config)
}

type KafkaDB struct {
	runtime      kafkaRuntime
	forwarders   []*ssh.LocalForwarder
	defaultTopic string
	defaultGroup string
	startLatest  bool
}

func (k *KafkaDB) Connect(config connection.ConnectionConfig) error {
	_ = k.Close()

	runConfig := normalizeKafkaConfig(config)
	if runConfig.UseSSH {
		sshConfig, brokers, forwarders, err := kafkaForwardBrokersOverSSH(runConfig)
		if err != nil {
			return err
		}
		k.forwarders = forwarders
		runConfig = sshConfig
		runConfig.Hosts = brokers[1:]
		host, port, ok := parseHostPortWithDefault(brokers[0], defaultKafkaPort)
		if !ok {
			_ = k.Close()
			return fmt.Errorf("解析 Kafka SSH 转发地址失败：%s", brokers[0])
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("Kafka 通过 SSH 端口转发连接：brokers=%s", strings.Join(brokers, ","))
	}

	runtime, err := newKafkaRuntime(runConfig)
	if err != nil {
		_ = k.Close()
		return err
	}
	k.runtime = runtime
	k.defaultTopic = kafkaDefaultTopic(runConfig)
	k.defaultGroup = kafkaDefaultGroupID(runConfig)
	k.startLatest = kafkaDefaultStartLatest(runConfig)

	if err := k.Ping(); err != nil {
		_ = k.Close()
		return err
	}
	return nil
}

func (k *KafkaDB) Close() error {
	var firstErr error
	if k.runtime != nil {
		if err := k.runtime.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		k.runtime = nil
	}
	for _, forwarder := range k.forwarders {
		if forwarder == nil {
			continue
		}
		if err := forwarder.Release(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	k.forwarders = nil
	k.defaultTopic = ""
	k.defaultGroup = ""
	k.startLatest = false
	return firstErr
}

func (k *KafkaDB) Ping() error {
	if k.runtime == nil {
		return fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(k), 10*time.Second)
	defer cancel()
	return k.runtime.Ping(ctx)
}

func (k *KafkaDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(metadataContextFor(k), defaultKafkaQueryTimeout)
	defer cancel()
	return k.QueryContext(ctx, query)
}

func (k *KafkaDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if k.runtime == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}
	parsed, ok := parseKafkaSQL(text, k.startLatest)
	if !ok {
		return nil, nil, fmt.Errorf("Kafka 查询仅支持 SHOW TOPICS、DESCRIBE TOPIC、SELECT * FROM topic 与 CONSUME FROM topic")
	}

	switch parsed.Action {
	case "show_topics":
		topics, err := k.runtime.ListTopics(ctx, false)
		if err != nil {
			return nil, nil, err
		}
		rows := kafkaTopicRows(topics)
		if parsed.Limit > 0 && len(rows) > parsed.Limit {
			rows = rows[:parsed.Limit]
		}
		return rows, collectColumns(rows), nil
	case "describe_topic":
		description, err := k.runtime.DescribeTopic(ctx, kafkaResolveTopic(parsed.Topic, k.defaultTopic))
		if err != nil {
			return nil, nil, err
		}
		rows := kafkaDescribeRows(description)
		return rows, collectColumns(rows), nil
	case "select", "consume":
		topic := kafkaResolveTopic(parsed.Topic, k.defaultTopic)
		if topic == "" {
			return nil, nil, fmt.Errorf("Kafka topic 不能为空")
		}
		groupID := strings.TrimSpace(parsed.GroupID)
		if parsed.Action == "consume" && groupID == "" {
			groupID = k.defaultGroup
		}
		if parsed.Count {
			description, err := k.runtime.DescribeTopic(ctx, topic)
			if err != nil {
				return nil, nil, err
			}
			return []map[string]interface{}{{
				"topic": topic,
				"total": kafkaTopicMessageCount(description),
			}}, []string{"topic", "total"}, nil
		}
		records, err := k.runtime.FetchMessages(ctx, kafkaFetchRequest{
			Topic:   topic,
			Limit:   parsed.Limit,
			Offset:  parsed.Offset,
			GroupID: groupID,
			Latest:  parsed.Latest,
		})
		if err != nil {
			return nil, nil, err
		}
		rows := kafkaMessageRows(records)
		return rows, collectColumns(rows), nil
	default:
		return nil, nil, fmt.Errorf("未实现的 Kafka 查询类型：%s", parsed.Action)
	}
}

func (k *KafkaDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultKafkaQueryTimeout)
	defer cancel()
	return k.ExecContext(ctx, query)
}

func (k *KafkaDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if k.runtime == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("Kafka 写入命令必须是 JSON：%w", err)
	}
	topic := kafkaResolveTopic(firstStringValue(cmd, "publish", "topic"), k.defaultTopic)
	if topic == "" {
		return 0, fmt.Errorf("Kafka publish 命令缺少 topic")
	}
	headers := map[string]interface{}{}
	if rawHeaders, ok := cmd["headers"].(map[string]interface{}); ok {
		headers = rawHeaders
	}
	return k.runtime.Publish(ctx, kafkaPublishCommand{
		Topic:   topic,
		Key:     firstExisting(cmd, "key", "messageKey"),
		Value:   firstExisting(cmd, "value", "message", "payload"),
		Headers: headers,
	})
}

func (k *KafkaDB) GetDatabases() ([]string, error) {
	if k.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return []string{kafkaSyntheticDatabase}, nil
}

func (k *KafkaDB) GetTables(dbName string) ([]string, error) {
	if k.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(k), 10*time.Second)
	defer cancel()
	topics, err := k.runtime.ListTopics(ctx, false)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(topics))
	for _, topic := range topics {
		if strings.TrimSpace(topic.Name) != "" {
			names = append(names, topic.Name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (k *KafkaDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if k.runtime == nil {
		return "", fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(k), 10*time.Second)
	defer cancel()
	description, err := k.runtime.DescribeTopic(ctx, kafkaResolveTopic(tableName, k.defaultTopic))
	if err != nil {
		return "", err
	}
	payload, _ := json.MarshalIndent(description, "", "  ")
	return fmt.Sprintf("// Kafka topic: %s\n%s", description.Name, string(payload)), nil
}

func (k *KafkaDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if k.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	topic := kafkaResolveTopic(tableName, k.defaultTopic)
	if topic == "" {
		return nil, fmt.Errorf("Kafka topic 不能为空")
	}
	columns := []connection.ColumnDefinition{
		{Name: "topic", Type: "string", Nullable: "NO", Comment: "Kafka topic"},
		{Name: "partition", Type: "int", Nullable: "NO", Key: "PRI", Comment: "Kafka partition id"},
		{Name: "offset", Type: "bigint", Nullable: "NO", Key: "PRI", Comment: "Kafka message offset"},
		{Name: "timestamp", Type: "timestamp", Nullable: "YES", Comment: "Message timestamp"},
		{Name: "high_water_mark", Type: "bigint", Nullable: "YES", Comment: "Partition high water mark"},
		{Name: "key", Type: "string", Nullable: "YES", Comment: "Message key"},
		{Name: "value", Type: "json", Nullable: "YES", Comment: "Message value"},
		{Name: "headers", Type: "json", Nullable: "YES", Comment: "Message headers"},
		{Name: "key_size", Type: "int", Nullable: "YES", Comment: "Message key size in bytes"},
		{Name: "value_size", Type: "int", Nullable: "YES", Comment: "Message value size in bytes"},
	}
	return columns, nil
}

func (k *KafkaDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := k.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	var failures []MetadataObjectFailure
	for _, table := range tables {
		cols, err := k.GetColumns(dbName, table)
		if err != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: table, Err: err})
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
	return result, NewPartialMetadataError(failures)
}

func (k *KafkaDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	if k.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(k), 10*time.Second)
	defer cancel()
	description, err := k.runtime.DescribeTopic(ctx, kafkaResolveTopic(tableName, k.defaultTopic))
	if err != nil {
		return nil, err
	}
	indexes := []connection.IndexDefinition{
		{Name: "PRIMARY", ColumnName: "partition", NonUnique: 0, SeqInIndex: 1, IndexType: "PARTITION_OFFSET"},
		{Name: "PRIMARY", ColumnName: "offset", NonUnique: 0, SeqInIndex: 2, IndexType: "PARTITION_OFFSET"},
		{Name: "TIMESTAMP", ColumnName: "timestamp", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
	}
	for _, partition := range description.Partitions {
		indexes = append(indexes, connection.IndexDefinition{
			Name:       fmt.Sprintf("PARTITION_%d", partition.ID),
			ColumnName: "offset",
			NonUnique:  1,
			SeqInIndex: 1,
			IndexType:  "PARTITION",
		})
	}
	return indexes, nil
}

func (k *KafkaDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (k *KafkaDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (k *KafkaDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if len(changes.Inserts) == 0 && len(changes.Updates) == 0 && len(changes.Deletes) == 0 {
		return nil
	}
	return fmt.Errorf("Kafka 结果集仅支持只读预览；如需写入请在 SQL 编辑器执行 JSON publish 命令")
}

func normalizeKafkaConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyKafkaURI(config)
	if strings.TrimSpace(runConfig.Host) == "" && len(runConfig.Hosts) == 0 {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultKafkaPort
	}
	if kafkaBoolParam(runConfig, "ssl", "tls", "useSSL", "use_ssl") {
		runConfig.UseSSL = true
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		if kafkaBoolParam(runConfig, "skip_verify", "skipVerify", "insecure") {
			runConfig.SSLMode = "skip-verify"
		} else {
			runConfig.SSLMode = "required"
		}
	}
	return runConfig
}

func applyKafkaURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "kafka" && scheme != "apache-kafka" && scheme != "apache_kafka" {
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
		host, port, ok := parseHostPortWithDefault(strings.TrimSpace(entry), defaultKafkaPort)
		if !ok {
			continue
		}
		hosts = append(hosts, kafkaFormatHostPort(host, port))
	}
	if len(hosts) > 0 {
		host, port, ok := parseHostPortWithDefault(hosts[0], defaultKafkaPort)
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
	return config
}

func kafkaConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "kafka", "apache-kafka", "apache_kafka"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func kafkaBoolParam(config connection.ConnectionConfig, keys ...string) bool {
	params := kafkaConnectionParams(config)
	for _, key := range keys {
		value := strings.ToLower(strings.TrimSpace(params.Get(key)))
		switch value {
		case "1", "true", "yes", "on", "required":
			return true
		}
	}
	return false
}

func kafkaDefaultTopic(config connection.ConnectionConfig) string {
	if topic := strings.TrimSpace(config.Database); topic != "" {
		return topic
	}
	params := kafkaConnectionParams(config)
	return firstNonEmpty(params.Get("topic"), params.Get("defaultTopic"), params.Get("default_topic"))
}

func kafkaDefaultGroupID(config connection.ConnectionConfig) string {
	params := kafkaConnectionParams(config)
	return firstNonEmpty(
		params.Get("groupId"),
		params.Get("group_id"),
		params.Get("consumerGroup"),
		params.Get("consumer_group"),
	)
}

func kafkaDefaultStartLatest(config connection.ConnectionConfig) bool {
	params := kafkaConnectionParams(config)
	value := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		params.Get("startOffset"),
		params.Get("start_offset"),
		params.Get("offsetReset"),
		params.Get("auto.offset.reset"),
	)))
	switch value {
	case "latest", "last", "newest", "end":
		return true
	default:
		return false
	}
}

func kafkaClientID(config connection.ConnectionConfig) string {
	params := kafkaConnectionParams(config)
	return firstNonEmpty(params.Get("clientId"), params.Get("client_id"), kafkaDefaultClientID)
}

func kafkaPreviewReadTimeout(config connection.ConnectionConfig) time.Duration {
	params := kafkaConnectionParams(config)
	if ms, err := strconv.Atoi(strings.TrimSpace(firstNonEmpty(params.Get("readTimeoutMs"), params.Get("fetchWaitMs")))); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return 1500 * time.Millisecond
}

func kafkaResolveTopic(topic string, fallback string) string {
	if text := strings.TrimSpace(topic); text != "" {
		return text
	}
	return strings.TrimSpace(fallback)
}

func kafkaBrokerAddresses(config connection.ConnectionConfig) ([]string, error) {
	candidates := make([]string, 0, len(config.Hosts)+1)
	if host := strings.TrimSpace(config.Host); host != "" {
		port := config.Port
		if port <= 0 {
			port = defaultKafkaPort
		}
		candidates = append(candidates, kafkaFormatHostPort(host, port))
	}
	candidates = append(candidates, config.Hosts...)
	seen := map[string]struct{}{}
	brokers := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		host, port, ok := parseHostPortWithDefault(candidate, defaultKafkaPort)
		if !ok {
			continue
		}
		address := kafkaFormatHostPort(host, port)
		if _, exists := seen[address]; exists {
			continue
		}
		seen[address] = struct{}{}
		brokers = append(brokers, address)
	}
	if len(brokers) == 0 {
		return nil, fmt.Errorf("Kafka 至少需要一个 broker 地址")
	}
	return brokers, nil
}

func kafkaForwardBrokersOverSSH(config connection.ConnectionConfig) (connection.ConnectionConfig, []string, []*ssh.LocalForwarder, error) {
	brokers, err := kafkaBrokerAddresses(config)
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
		host, port, ok := parseHostPortWithDefault(broker, defaultKafkaPort)
		if !ok {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("解析 Kafka broker 地址失败：%s", broker)
		}
		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, host, port)
		if err != nil {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("创建 Kafka SSH 隧道失败：%w", err)
		}
		forwarders = append(forwarders, forwarder)
		rewritten = append(rewritten, forwarder.LocalAddr)
	}
	cleanupForwarders = false
	return runConfig, rewritten, forwarders, nil
}

func newKafkaGoRuntime(config connection.ConnectionConfig) (kafkaRuntime, error) {
	brokers, err := kafkaBrokerAddresses(config)
	if err != nil {
		return nil, err
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}
	mechanism, err := kafkaSASLMechanism(config)
	if err != nil {
		return nil, err
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	baseDialer := &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
		DualStack: true,
	}
	dialFunc := baseDialer.DialContext
	if config.UseProxy {
		proxyConfig := config.Proxy
		dialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
			return proxytunnel.DialContext(ctx, proxyConfig, network, address)
		}
	}

	dialer := &kafka.Dialer{
		ClientID:      kafkaClientID(config),
		Timeout:       timeout,
		KeepAlive:     30 * time.Second,
		DualStack:     true,
		DialFunc:      dialFunc,
		TLS:           tlsConfig,
		SASLMechanism: mechanism,
	}
	transport := &kafka.Transport{
		Dial:        dialFunc,
		DialTimeout: timeout,
		ClientID:    kafkaClientID(config),
		TLS:         tlsConfig,
		SASL:        mechanism,
	}
	client := &kafka.Client{
		Addr: kafka.TCP(brokers...),
		// Client.Timeout is a per-request deadline. Keep it unset so the
		// caller's context (including an explicit queryTimeout) owns it.
		Timeout:   0,
		Transport: transport,
	}
	return &kafkaGoRuntime{
		brokers:    brokers,
		bootstrap:  brokers[0],
		dialer:     dialer,
		transport:  transport,
		client:     client,
		timeout:    timeout,
		readWait:   kafkaPreviewReadTimeout(config),
		defaultAck: kafka.RequireAll,
	}, nil
}

func (r *kafkaGoRuntime) Close() error {
	if r.transport != nil {
		r.transport.CloseIdleConnections()
	}
	return nil
}

func (r *kafkaGoRuntime) Ping(ctx context.Context) error {
	if r.client == nil {
		return fmt.Errorf("连接未打开")
	}
	_, err := r.client.Metadata(ctx, &kafka.MetadataRequest{Addr: kafka.TCP(r.bootstrap)})
	return err
}

func (r *kafkaGoRuntime) ListTopics(ctx context.Context, includeInternal bool) ([]kafkaTopicInfo, error) {
	if r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	resp, err := r.client.Metadata(ctx, &kafka.MetadataRequest{Addr: kafka.TCP(r.bootstrap)})
	if err != nil {
		return nil, err
	}
	topics := make([]kafkaTopicInfo, 0, len(resp.Topics))
	for _, topic := range resp.Topics {
		if topic.Error != nil {
			continue
		}
		if !includeInternal && topic.Internal {
			continue
		}
		topics = append(topics, kafkaTopicInfo{
			Name:       topic.Name,
			Internal:   topic.Internal,
			Partitions: append([]kafka.Partition(nil), topic.Partitions...),
		})
	}
	sort.Slice(topics, func(i, j int) bool {
		return topics[i].Name < topics[j].Name
	})
	return topics, nil
}

func (r *kafkaGoRuntime) DescribeTopic(ctx context.Context, topic string) (kafkaTopicDescription, error) {
	if r.client == nil {
		return kafkaTopicDescription{}, fmt.Errorf("连接未打开")
	}
	name := strings.TrimSpace(topic)
	if name == "" {
		return kafkaTopicDescription{}, fmt.Errorf("Kafka topic 不能为空")
	}
	resp, err := r.client.Metadata(ctx, &kafka.MetadataRequest{
		Addr:   kafka.TCP(r.bootstrap),
		Topics: []string{name},
	})
	if err != nil {
		return kafkaTopicDescription{}, err
	}
	for _, topicInfo := range resp.Topics {
		if topicInfo.Name != name {
			continue
		}
		if topicInfo.Error != nil {
			return kafkaTopicDescription{}, topicInfo.Error
		}
		description := kafkaTopicDescription{
			Name:     topicInfo.Name,
			Internal: topicInfo.Internal,
		}
		for _, partition := range topicInfo.Partitions {
			earliest, latest, err := r.partitionOffsets(ctx, name, partition.ID)
			if err != nil {
				return kafkaTopicDescription{}, err
			}
			description.Partitions = append(description.Partitions, kafkaTopicPartition{
				ID:               partition.ID,
				Leader:           partition.Leader,
				Replicas:         append([]kafka.Broker(nil), partition.Replicas...),
				Isr:              append([]kafka.Broker(nil), partition.Isr...),
				OfflineReplicas:  append([]kafka.Broker(nil), partition.OfflineReplicas...),
				EarliestOffset:   earliest,
				LatestOffset:     latest,
				ApproximateCount: maxInt64(0, latest-earliest),
			})
		}
		sort.Slice(description.Partitions, func(i, j int) bool {
			return description.Partitions[i].ID < description.Partitions[j].ID
		})
		return description, nil
	}
	return kafkaTopicDescription{}, fmt.Errorf("Kafka topic 不存在：%s", name)
}

func (r *kafkaGoRuntime) FetchMessages(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error) {
	topic := strings.TrimSpace(request.Topic)
	if topic == "" {
		return nil, fmt.Errorf("Kafka topic 不能为空")
	}
	limit := request.Limit
	if limit <= 0 {
		limit = defaultKafkaPreviewLimit
	}
	if strings.TrimSpace(request.GroupID) != "" {
		return r.fetchMessagesWithGroup(ctx, kafkaFetchRequest{
			Topic:   topic,
			Limit:   limit,
			Offset:  maxInt(request.Offset, 0),
			GroupID: strings.TrimSpace(request.GroupID),
			Latest:  request.Latest,
		})
	}
	return r.fetchMessagesDirect(ctx, kafkaFetchRequest{
		Topic:  topic,
		Limit:  limit,
		Offset: maxInt(request.Offset, 0),
		Latest: request.Latest,
	})
}

func (r *kafkaGoRuntime) Publish(ctx context.Context, command kafkaPublishCommand) (int64, error) {
	topic := strings.TrimSpace(command.Topic)
	if topic == "" {
		return 0, fmt.Errorf("Kafka publish 命令缺少 topic")
	}
	keyBytes, err := kafkaMessageBytes(command.Key)
	if err != nil {
		return 0, fmt.Errorf("序列化 Kafka key 失败：%w", err)
	}
	valueBytes, err := kafkaMessageBytes(command.Value)
	if err != nil {
		return 0, fmt.Errorf("序列化 Kafka value 失败：%w", err)
	}
	headers, err := kafkaMessageHeaders(command.Headers)
	if err != nil {
		return 0, fmt.Errorf("序列化 Kafka headers 失败：%w", err)
	}
	writer := &kafka.Writer{
		Addr:         kafka.TCP(r.brokers...),
		Topic:        topic,
		RequiredAcks: r.defaultAck,
		Transport:    r.transport,
		ReadTimeout:  r.timeout,
		WriteTimeout: r.timeout,
		BatchTimeout: 20 * time.Millisecond,
	}
	defer writer.Close()
	if err := writer.WriteMessages(ctx, kafka.Message{
		Topic:   topic,
		Key:     keyBytes,
		Value:   valueBytes,
		Headers: headers,
		Time:    time.Now(),
	}); err != nil {
		return 0, err
	}
	return 1, nil
}

func (r *kafkaGoRuntime) fetchMessagesWithGroup(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:         append([]string(nil), r.brokers...),
		GroupID:         request.GroupID,
		Topic:           request.Topic,
		Dialer:          r.dialer,
		QueueCapacity:   maxInt(request.Limit+request.Offset, 1),
		MinBytes:        1,
		MaxBytes:        kafkaFetchMaxBytes,
		MaxWait:         r.readWait,
		ReadLagInterval: -1,
		CommitInterval:  0,
		StartOffset:     kafkaOffsetMode(request.Latest),
		MaxAttempts:     1,
	})
	defer reader.Close()

	target := request.Limit + request.Offset
	records := make([]kafkaMessageRecord, 0, request.Limit)
	skipped := 0
	for len(records) < request.Limit && skipped+len(records) < target {
		readCtx, cancel := context.WithTimeout(ctx, r.readWait)
		msg, err := reader.FetchMessage(readCtx)
		cancel()
		if err != nil {
			if isKafkaReadTimeout(err) || errorsIsContextTimeout(err) {
				break
			}
			return nil, err
		}
		record := kafkaMessageRecord{
			Message: msg,
			Key:     kafkaDecodePayload(msg.Key),
			Value:   kafkaDecodePayload(msg.Value),
			Headers: kafkaHeadersToMap(msg.Headers),
		}
		if skipped < request.Offset {
			skipped++
			continue
		}
		records = append(records, record)
	}
	return records, nil
}

func (r *kafkaGoRuntime) fetchMessagesDirect(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error) {
	partitions, err := r.dialer.LookupPartitions(ctx, "tcp", r.bootstrap, request.Topic)
	if err != nil {
		return nil, err
	}
	sort.Slice(partitions, func(i, j int) bool {
		return partitions[i].ID < partitions[j].ID
	})
	target := maxInt(request.Limit+request.Offset, request.Limit)
	records := make([]kafkaMessageRecord, 0, target)
	for _, partition := range partitions {
		start, err := r.partitionStartOffset(ctx, request.Topic, partition.ID, request.Latest, target)
		if err != nil {
			return nil, err
		}
		items, err := r.fetchPartitionMessages(ctx, request.Topic, partition.ID, start, target)
		if err != nil {
			return nil, err
		}
		records = append(records, items...)
	}
	sortKafkaRecords(records, request.Latest)
	if request.Offset >= len(records) {
		return []kafkaMessageRecord{}, nil
	}
	records = records[request.Offset:]
	if len(records) > request.Limit {
		records = records[:request.Limit]
	}
	return records, nil
}

func (r *kafkaGoRuntime) partitionStartOffset(ctx context.Context, topic string, partitionID int, latest bool, limit int) (int64, error) {
	first, last, err := r.partitionOffsets(ctx, topic, partitionID)
	if err != nil {
		return 0, err
	}
	if !latest {
		return first, nil
	}
	start := last - int64(limit)
	if start < first {
		start = first
	}
	return start, nil
}

func (r *kafkaGoRuntime) partitionOffsets(ctx context.Context, topic string, partitionID int) (int64, int64, error) {
	conn, err := r.dialer.DialLeader(ctx, "tcp", r.bootstrap, topic, partitionID)
	if err != nil {
		return 0, 0, err
	}
	defer conn.Close()
	return conn.ReadOffsets()
}

type kafkaOffsetSeeker interface {
	Seek(offset int64, whence int) (int64, error)
}

func seekKafkaAbsoluteOffset(conn kafkaOffsetSeeker, offset int64) error {
	_, err := conn.Seek(offset, kafka.SeekAbsolute)
	return err
}

func (r *kafkaGoRuntime) fetchPartitionMessages(ctx context.Context, topic string, partitionID int, startOffset int64, limit int) ([]kafkaMessageRecord, error) {
	conn, err := r.dialer.DialLeader(ctx, "tcp", r.bootstrap, topic, partitionID)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := seekKafkaAbsoluteOffset(conn, startOffset); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(r.readWait)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	_ = conn.SetReadDeadline(deadline)

	records := make([]kafkaMessageRecord, 0, limit)
	for len(records) < limit {
		msg, err := conn.ReadMessage(kafkaFetchMaxBytes)
		if err != nil {
			if isKafkaReadTimeout(err) || errorsIsContextTimeout(err) || errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
		records = append(records, kafkaMessageRecord{
			Message: msg,
			Key:     kafkaDecodePayload(msg.Key),
			Value:   kafkaDecodePayload(msg.Value),
			Headers: kafkaHeadersToMap(msg.Headers),
		})
	}
	return records, nil
}

func kafkaSASLMechanism(config connection.ConnectionConfig) (kafkasasl.Mechanism, error) {
	params := kafkaConnectionParams(config)
	mechanism := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		params.Get("mechanism"),
		params.Get("saslMechanism"),
		params.Get("sasl_mechanism"),
		params.Get("sasl"),
	)))
	if mechanism == "" || mechanism == "none" {
		return nil, nil
	}
	username := strings.TrimSpace(config.User)
	password := config.Password
	switch mechanism {
	case "plain", "sasl_plaintext":
		return kafkaplain.Mechanism{Username: username, Password: password}, nil
	case "scram-sha-256", "scram_sha_256", "scram256":
		return kafkascram.Mechanism(kafkascram.SHA256, username, password)
	case "scram-sha-512", "scram_sha_512", "scram512":
		return kafkascram.Mechanism(kafkascram.SHA512, username, password)
	default:
		return nil, fmt.Errorf("不支持的 Kafka SASL 认证机制：%s", mechanism)
	}
}

type kafkaParsedSQL struct {
	Action  string
	Topic   string
	Limit   int
	Offset  int
	GroupID string
	Count   bool
	Latest  bool
}

var (
	kafkaSQLFromRE       = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))`)
	kafkaSQLLimitRE      = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	kafkaSQLOffsetRE     = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	kafkaShowTopicsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+TOPICS(?:\s+LIMIT\s+(\d+))?\s*$`)
	kafkaDescribeTopicRE = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+TOPIC\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))\s*$`)
	kafkaConsumeTopicRE  = regexp.MustCompile(`(?i)^\s*CONSUME(?:\s+GROUP\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+)))?\s+FROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))`)
)

func parseKafkaSQL(sqlText string, defaultLatest bool) (kafkaParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if text == "" {
		return kafkaParsedSQL{}, false
	}
	if matches := kafkaShowTopicsRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := kafkaParsedSQL{Action: "show_topics"}
		if len(matches) > 1 && strings.TrimSpace(matches[1]) != "" {
			parsed.Limit, _ = strconv.Atoi(matches[1])
		}
		return parsed, true
	}
	if matches := kafkaDescribeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		return kafkaParsedSQL{
			Action: "describe_topic",
			Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
		}, true
	}
	if matches := kafkaConsumeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := kafkaParsedSQL{
			Action:  "consume",
			GroupID: firstNonEmpty(matches[1], matches[2], matches[3]),
			Topic:   firstNonEmpty(matches[4], matches[5], matches[6]),
			Limit:   defaultKafkaPreviewLimit,
			Latest:  true,
		}
		if limitMatch := kafkaSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
			parsed.Limit, _ = strconv.Atoi(limitMatch[1])
		}
		if offsetMatch := kafkaSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
			parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
		}
		return parsed, true
	}
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return kafkaParsedSQL{}, false
	}
	matches := kafkaSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return kafkaParsedSQL{}, false
	}
	parsed := kafkaParsedSQL{
		Action: "select",
		Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
		Limit:  defaultKafkaPreviewLimit,
		Count:  strings.Contains(strings.ToLower(text), "count("),
		Latest: defaultLatest,
	}
	if limitMatch := kafkaSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
		parsed.Limit, _ = strconv.Atoi(limitMatch[1])
	}
	if offsetMatch := kafkaSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
		parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
	}
	return parsed, true
}

func kafkaTopicRows(topics []kafkaTopicInfo) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(topics))
	for _, topic := range topics {
		rows = append(rows, map[string]interface{}{
			"topic":           topic.Name,
			"internal":        topic.Internal,
			"partition_count": len(topic.Partitions),
		})
	}
	return rows
}

func kafkaDescribeRows(description kafkaTopicDescription) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(description.Partitions))
	for _, partition := range description.Partitions {
		rows = append(rows, map[string]interface{}{
			"topic":             description.Name,
			"internal":          description.Internal,
			"partition":         partition.ID,
			"leader":            kafkaBrokerAddress(partition.Leader),
			"replicas":          kafkaBrokerAddressesList(partition.Replicas),
			"isr":               kafkaBrokerAddressesList(partition.Isr),
			"offline_replicas":  kafkaBrokerAddressesList(partition.OfflineReplicas),
			"earliest_offset":   partition.EarliestOffset,
			"latest_offset":     partition.LatestOffset,
			"approximate_count": partition.ApproximateCount,
		})
	}
	return rows
}

func kafkaMessageRows(records []kafkaMessageRecord) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(records))
	for _, record := range records {
		row := map[string]interface{}{
			"topic":           record.Message.Topic,
			"partition":       record.Message.Partition,
			"offset":          record.Message.Offset,
			"timestamp":       record.Message.Time.Format(time.RFC3339Nano),
			"high_water_mark": record.Message.HighWaterMark,
			"key":             record.Key,
			"value":           record.Value,
			"headers":         record.Headers,
			"key_size":        len(record.Message.Key),
			"value_size":      len(record.Message.Value),
		}
		if valueMap, ok := record.Value.(map[string]interface{}); ok {
			flattenKafkaMap("value", valueMap, row)
		}
		if keyMap, ok := record.Key.(map[string]interface{}); ok {
			flattenKafkaMap("key", keyMap, row)
		}
		if len(record.Headers) > 0 {
			flattenKafkaMap("headers", record.Headers, row)
		}
		rows = append(rows, row)
	}
	return rows
}

func flattenKafkaMap(prefix string, values map[string]interface{}, row map[string]interface{}) {
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		name := prefix + "." + key
		row[name] = value
		if nested, ok := value.(map[string]interface{}); ok {
			flattenKafkaMap(name, nested, row)
		}
	}
}

func kafkaHeadersToMap(headers []kafka.Header) map[string]interface{} {
	result := make(map[string]interface{}, len(headers))
	for _, header := range headers {
		key := strings.TrimSpace(header.Key)
		if key == "" {
			continue
		}
		value := kafkaDecodePayload(header.Value)
		if existing, ok := result[key]; ok {
			switch typed := existing.(type) {
			case []interface{}:
				result[key] = append(typed, value)
			default:
				result[key] = []interface{}{typed, value}
			}
			continue
		}
		result[key] = value
	}
	return result
}

func kafkaDecodePayload(payload []byte) interface{} {
	if payload == nil {
		return nil
	}
	var decoded interface{}
	if err := decodeJSONWithUseNumber(payload, &decoded); err == nil {
		return decoded
	}
	return bytesToDisplayValue(payload, "")
}

func kafkaMessageBytes(value interface{}) ([]byte, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case []byte:
		return typed, nil
	case string:
		return []byte(typed), nil
	case json.Number:
		return []byte(typed.String()), nil
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return []byte(fmt.Sprintf("%v", typed)), nil
	case map[string]interface{}, []interface{}:
		return json.Marshal(typed)
	default:
		return json.Marshal(typed)
	}
}

func kafkaMessageHeaders(values map[string]interface{}) ([]kafka.Header, error) {
	if len(values) == 0 {
		return nil, nil
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	headers := make([]kafka.Header, 0, len(keys))
	for _, key := range keys {
		payload, err := kafkaMessageBytes(values[key])
		if err != nil {
			return nil, err
		}
		headers = append(headers, kafka.Header{Key: key, Value: payload})
	}
	return headers, nil
}

func sortKafkaRecords(records []kafkaMessageRecord, latest bool) {
	sort.Slice(records, func(i, j int) bool {
		left := records[i].Message
		right := records[j].Message
		if !left.Time.Equal(right.Time) {
			if latest {
				return left.Time.After(right.Time)
			}
			return left.Time.Before(right.Time)
		}
		if left.Partition != right.Partition {
			if latest {
				return left.Partition > right.Partition
			}
			return left.Partition < right.Partition
		}
		if latest {
			return left.Offset > right.Offset
		}
		return left.Offset < right.Offset
	})
}

func kafkaOffsetMode(latest bool) int64 {
	if latest {
		return kafka.LastOffset
	}
	return kafka.FirstOffset
}

func kafkaTopicMessageCount(description kafkaTopicDescription) int64 {
	var total int64
	for _, partition := range description.Partitions {
		total += partition.ApproximateCount
	}
	return total
}

func kafkaBrokerAddress(broker kafka.Broker) string {
	if strings.TrimSpace(broker.Host) == "" || broker.Port <= 0 {
		return strconv.Itoa(broker.ID)
	}
	return kafkaFormatHostPort(broker.Host, broker.Port)
}

func kafkaBrokerAddressesList(brokers []kafka.Broker) []string {
	result := make([]string, 0, len(brokers))
	for _, broker := range brokers {
		result = append(result, kafkaBrokerAddress(broker))
	}
	return result
}

func kafkaFormatHostPort(host string, port int) string {
	h := strings.TrimSpace(host)
	if strings.Contains(h, ":") && !strings.HasPrefix(h, "[") {
		return fmt.Sprintf("[%s]:%d", h, port)
	}
	return fmt.Sprintf("%s:%d", h, port)
}

func isKafkaReadTimeout(err error) bool {
	if err == nil {
		return false
	}
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "i/o timeout")
}

func errorsIsContextTimeout(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
