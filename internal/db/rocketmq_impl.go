package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"

	rocketmq "github.com/apache/rocketmq-client-go/v2"
	rocketmqadmin "github.com/apache/rocketmq-client-go/v2/admin"
	rocketmqconsumer "github.com/apache/rocketmq-client-go/v2/consumer"
	rocketmqprimitive "github.com/apache/rocketmq-client-go/v2/primitive"
	rocketmqproducer "github.com/apache/rocketmq-client-go/v2/producer"
)

const (
	defaultRocketMQPort           = 9876
	defaultRocketMQQueryTimeout   = 30 * time.Second
	defaultRocketMQPreviewLimit   = 100
	defaultRocketMQPullBatchSize  = 32
	maxRocketMQPullBatchSize      = 256
	rocketMQSyntheticDatabase     = "topics"
	rocketMQDefaultProducerGroup  = "GoNaviRocketMQProducer"
	rocketMQDefaultConsumerGroup  = "GoNaviRocketMQPreview"
	rocketMQDefaultInstancePrefix = "GoNavi"
)

type rocketmqRuntime interface {
	Close() error
	Ping(ctx context.Context) error
	ListTopics(ctx context.Context, includeSystem bool) ([]rocketmqTopicInfo, error)
	DescribeTopic(ctx context.Context, request rocketmqDescribeRequest) (rocketmqTopicDescription, error)
	FetchMessages(ctx context.Context, request rocketmqFetchRequest) ([]rocketmqMessageRecord, error)
	Publish(ctx context.Context, command rocketmqPublishCommand) (int64, error)
	InspectConsumerGroups(ctx context.Context, groupID string) ([]rocketmqConsumerGroupInfo, error)
}

type rocketmqConsumerGroupInfo struct {
	GroupID       string
	State         string
	MemberID      string
	ClientID      string
	ClientHost    string
	Topic         string
	QueueID       int
	CurrentOffset int64
	LogEndOffset  int64
	Lag           int64
}

type rocketmqDescribeRequest struct {
	Topic         string
	ConsumerGroup string
	TagExpression string
	PullBatchSize int
}

type rocketmqTopicInfo struct {
	Name       string
	System     bool
	QueueCount int
}

type rocketmqTopicDescription struct {
	Name                  string
	Namespace             string
	ConsumerGroup         string
	TagExpression         string
	QueueCount            int
	TotalApproximateCount int64
	Queues                []rocketmqTopicQueueInfo
}

type rocketmqTopicQueueInfo struct {
	BrokerName       string
	QueueID          int
	MinOffset        int64
	MaxOffset        int64
	ApproximateCount int64
}

type rocketmqFetchRequest struct {
	Topic         string
	Limit         int
	Offset        int
	ConsumerGroup string
	TagExpression string
	Latest        bool
	PullBatchSize int
}

type rocketmqPublishCommand struct {
	Topic      string
	Payload    interface{}
	Tag        string
	Keys       []string
	DelayLevel int
	Properties map[string]string
}

type rocketmqMessageRecord struct {
	Topic          string
	BrokerName     string
	QueueID        int
	QueueOffset    int64
	MsgID          string
	OffsetMsgID    string
	Tags           string
	Keys           string
	Body           []byte
	Decoded        interface{}
	Encoding       string
	Properties     map[string]string
	BornTimestamp  time.Time
	StoreTimestamp time.Time
	ReconsumeTimes int32
	MinOffset      int64
	MaxOffset      int64
}

type nativeRocketMQRuntime struct {
	config      connection.ConnectionConfig
	nameservers []string
	namespace   string
	timeout     time.Duration
	sendTimeout time.Duration
}

var newRocketMQRuntime = func(config connection.ConnectionConfig) (rocketmqRuntime, error) {
	return newNativeRocketMQRuntime(config)
}

type RocketMQDB struct {
	runtime              rocketmqRuntime
	tunnel               *rocketmqTunnelSet
	defaultTopic         string
	defaultConsumerGroup string
	defaultTagExpression string
	startLatest          bool
	pullBatchSize        int
	namespace            string
}

func (r *RocketMQDB) Connect(config connection.ConnectionConfig) error {
	_ = r.Close()

	runConfig := normalizeRocketMQConfig(config)
	preparedConfig, tunnel, err := prepareRocketMQTunnel(runConfig)
	if err != nil {
		return err
	}
	r.tunnel = tunnel
	runConfig = preparedConfig

	runtime, err := newRocketMQRuntime(runConfig)
	if err != nil {
		_ = r.Close()
		return err
	}
	r.runtime = runtime
	r.defaultTopic = rocketmqDefaultTopic(runConfig)
	r.defaultConsumerGroup = rocketmqConfiguredConsumerGroup(runConfig)
	r.defaultTagExpression = rocketmqConfiguredTagExpression(runConfig)
	r.startLatest = rocketmqDefaultStartLatest(runConfig)
	r.pullBatchSize = rocketmqPullBatchSize(runConfig)
	r.namespace = rocketmqNamespace(runConfig)

	if err := r.Ping(); err != nil {
		_ = r.Close()
		return err
	}
	return nil
}

func (r *RocketMQDB) Close() error {
	var firstErr error
	if r.runtime != nil {
		if err := r.runtime.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if r.tunnel != nil {
		if err := r.tunnel.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	r.runtime = nil
	r.tunnel = nil
	r.defaultTopic = ""
	r.defaultConsumerGroup = ""
	r.defaultTagExpression = ""
	r.startLatest = false
	r.pullBatchSize = 0
	r.namespace = ""
	return firstErr
}

func (r *RocketMQDB) Ping() error {
	if r.runtime == nil {
		return fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return r.runtime.Ping(ctx)
}

func (r *RocketMQDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultRocketMQQueryTimeout)
	defer cancel()
	return r.QueryContext(ctx, query)
}

func (r *RocketMQDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if r.runtime == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}

	parsed, ok := parseRocketMQSQL(text, r.startLatest)
	if !ok {
		return nil, nil, fmt.Errorf("RocketMQ 查询仅支持 SHOW TOPICS、SHOW/DESCRIBE CONSUMER GROUP、DESCRIBE TOPIC、SELECT * FROM topic 与 CONSUME FROM topic")
	}

	switch parsed.Action {
	case "show_topics":
		topics, err := r.runtime.ListTopics(ctx, false)
		if err != nil {
			return nil, nil, err
		}
		rows := rocketmqTopicRows(topics)
		if parsed.Limit > 0 && len(rows) > parsed.Limit {
			rows = rows[:parsed.Limit]
		}
		return rows, collectColumns(rows), nil
	case "show_consumer_groups", "describe_consumer_group":
		groups, err := r.runtime.InspectConsumerGroups(ctx, strings.TrimSpace(parsed.GroupID))
		if err != nil {
			return nil, nil, err
		}
		rows := rocketmqConsumerGroupRows(groups)
		return rows, collectColumns(rows), nil
	case "describe_topic":
		topic := rocketmqResolveTopic(parsed.Topic, r.defaultTopic)
		if topic == "" {
			return nil, nil, fmt.Errorf("RocketMQ topic 不能为空")
		}
		description, err := r.runtime.DescribeTopic(ctx, rocketmqDescribeRequest{
			Topic:         topic,
			ConsumerGroup: r.resolveConsumerGroup("describe"),
			TagExpression: r.defaultTagExpression,
			PullBatchSize: r.pullBatchSize,
		})
		if err != nil {
			return nil, nil, err
		}
		rows := rocketmqDescribeRows(description)
		return rows, collectColumns(rows), nil
	case "select", "consume":
		topic := rocketmqResolveTopic(parsed.Topic, r.defaultTopic)
		if topic == "" {
			return nil, nil, fmt.Errorf("RocketMQ topic 不能为空")
		}
		if parsed.Count {
			if !rocketmqTagExpressionIsDefault(r.defaultTagExpression) {
				return nil, nil, fmt.Errorf("RocketMQ 配置了 TAG 过滤时暂不支持 COUNT(*) 总量统计；请改为手动预览消息")
			}
			description, err := r.runtime.DescribeTopic(ctx, rocketmqDescribeRequest{
				Topic:         topic,
				ConsumerGroup: r.resolveConsumerGroup("count"),
				TagExpression: r.defaultTagExpression,
				PullBatchSize: r.pullBatchSize,
			})
			if err != nil {
				return nil, nil, err
			}
			rows := []map[string]interface{}{{
				"topic":                   topic,
				"queue_count":             description.QueueCount,
				"total_approximate_count": description.TotalApproximateCount,
				"namespace":               description.Namespace,
			}}
			return rows, []string{"topic", "queue_count", "total_approximate_count", "namespace"}, nil
		}
		records, err := r.runtime.FetchMessages(ctx, rocketmqFetchRequest{
			Topic:         topic,
			Limit:         parsed.Limit,
			Offset:        parsed.Offset,
			ConsumerGroup: r.resolveConsumerGroup(parsed.Action),
			TagExpression: r.defaultTagExpression,
			Latest:        parsed.Latest,
			PullBatchSize: r.pullBatchSize,
		})
		if err != nil {
			return nil, nil, err
		}
		rows := rocketmqMessageRows(records)
		return rows, collectColumns(rows), nil
	default:
		return nil, nil, fmt.Errorf("未实现的 RocketMQ 查询类型：%s", parsed.Action)
	}
}

func (r *RocketMQDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultRocketMQQueryTimeout)
	defer cancel()
	return r.ExecContext(ctx, query)
}

func (r *RocketMQDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if r.runtime == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("RocketMQ 写入命令必须是 JSON：%w", err)
	}
	topic := rocketmqResolveTopic(firstStringValue(cmd, "publish", "topic", "destination"), r.defaultTopic)
	if topic == "" {
		return 0, fmt.Errorf("RocketMQ publish 命令缺少 topic")
	}
	if !hasAnyKey(cmd, "payload", "value", "body", "message") {
		return 0, fmt.Errorf("RocketMQ publish 命令缺少 payload")
	}
	keys, err := rocketmqKeysFromAny(firstExisting(cmd, "keys", "key", "messageKeys", "message_keys"))
	if err != nil {
		return 0, err
	}
	properties, err := rocketmqPropertiesFromAny(firstExisting(cmd, "properties", "userProperties", "user_properties"))
	if err != nil {
		return 0, err
	}
	delayLevel, err := rocketmqDelayLevelFromAny(firstExisting(cmd, "delayLevel", "delay_level", "delay"))
	if err != nil {
		return 0, err
	}
	return r.runtime.Publish(ctx, rocketmqPublishCommand{
		Topic:      topic,
		Payload:    firstExisting(cmd, "payload", "value", "body", "message"),
		Tag:        strings.TrimSpace(firstStringValue(cmd, "tag", "tags")),
		Keys:       keys,
		DelayLevel: delayLevel,
		Properties: properties,
	})
}

func (r *RocketMQDB) GetDatabases() ([]string, error) {
	if r.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return []string{rocketMQSyntheticDatabase}, nil
}

func (r *RocketMQDB) GetTables(dbName string) ([]string, error) {
	if r.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 10*time.Second)
	defer cancel()
	topics, err := r.runtime.ListTopics(ctx, false)
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

func (r *RocketMQDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if r.runtime == nil {
		return "", fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 10*time.Second)
	defer cancel()
	topic := rocketmqResolveTopic(tableName, r.defaultTopic)
	if topic == "" {
		return "", fmt.Errorf("RocketMQ topic 不能为空")
	}
	description, err := r.runtime.DescribeTopic(ctx, rocketmqDescribeRequest{
		Topic:         topic,
		ConsumerGroup: r.resolveConsumerGroup("ddl"),
		TagExpression: r.defaultTagExpression,
		PullBatchSize: r.pullBatchSize,
	})
	if err != nil {
		return "", err
	}
	payload, _ := json.MarshalIndent(description, "", "  ")
	return fmt.Sprintf("// RocketMQ topic: %s\n%s", topic, string(payload)), nil
}

func (r *RocketMQDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if r.runtime == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	topic := rocketmqResolveTopic(tableName, r.defaultTopic)
	if topic == "" {
		return nil, fmt.Errorf("RocketMQ topic 不能为空")
	}
	columns := []connection.ColumnDefinition{
		{Name: "topic", Type: "string", Nullable: "NO", Comment: "RocketMQ topic"},
		{Name: "broker_name", Type: "string", Nullable: "NO", Comment: "Broker name"},
		{Name: "queue_id", Type: "int", Nullable: "NO", Key: "PRI", Comment: "Queue id"},
		{Name: "queue_offset", Type: "bigint", Nullable: "NO", Key: "PRI", Comment: "Queue offset"},
		{Name: "msg_id", Type: "string", Nullable: "YES", Comment: "Message id"},
		{Name: "offset_msg_id", Type: "string", Nullable: "YES", Comment: "Offset message id"},
		{Name: "tags", Type: "string", Nullable: "YES", Comment: "RocketMQ tag"},
		{Name: "keys", Type: "string", Nullable: "YES", Comment: "RocketMQ keys"},
		{Name: "born_timestamp", Type: "timestamp", Nullable: "YES", Comment: "Born timestamp"},
		{Name: "store_timestamp", Type: "timestamp", Nullable: "YES", Comment: "Store timestamp"},
		{Name: "reconsume_times", Type: "int", Nullable: "YES", Comment: "Reconsume times"},
		{Name: "body", Type: "json", Nullable: "YES", Comment: "Decoded message body"},
		{Name: "body_encoding", Type: "string", Nullable: "YES", Comment: "Message body encoding"},
		{Name: "properties", Type: "json", Nullable: "YES", Comment: "Message properties"},
	}
	return columns, nil
}

func (r *RocketMQDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := r.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	var failures []MetadataObjectFailure
	for _, table := range tables {
		cols, err := r.GetColumns(dbName, table)
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

func (r *RocketMQDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{
		{Name: "PRIMARY", ColumnName: "queue_id", NonUnique: 0, SeqInIndex: 1, IndexType: "QUEUE_OFFSET"},
		{Name: "PRIMARY", ColumnName: "queue_offset", NonUnique: 0, SeqInIndex: 2, IndexType: "QUEUE_OFFSET"},
		{Name: "STORE_TIMESTAMP", ColumnName: "store_timestamp", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
	}, nil
}

func (r *RocketMQDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (r *RocketMQDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (r *RocketMQDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if len(changes.Inserts) == 0 && len(changes.Updates) == 0 && len(changes.Deletes) == 0 {
		return nil
	}
	return fmt.Errorf("RocketMQ 结果集仅支持只读预览；如需写入请在 SQL 编辑器执行 JSON publish 命令")
}

func (r *RocketMQDB) resolveConsumerGroup(purpose string) string {
	group := strings.TrimSpace(r.defaultConsumerGroup)
	if group != "" {
		return group
	}
	return fmt.Sprintf("%s-%s-%d", rocketMQDefaultConsumerGroup, purpose, time.Now().UnixNano())
}

func newNativeRocketMQRuntime(config connection.ConnectionConfig) (rocketmqRuntime, error) {
	nameservers, err := rocketmqNameServerAddresses(config)
	if err != nil {
		return nil, err
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &nativeRocketMQRuntime{
		config:      config,
		nameservers: nameservers,
		namespace:   rocketmqNamespace(config),
		timeout:     timeout,
		sendTimeout: rocketmqSendTimeout(config),
	}, nil
}

func (r *nativeRocketMQRuntime) Close() error {
	return nil
}

func (r *nativeRocketMQRuntime) Ping(ctx context.Context) error {
	adminClient, err := r.newAdmin()
	if err != nil {
		return err
	}
	defer adminClient.Close()
	_, err = adminClient.FetchAllTopicList(ctx)
	return err
}

func (r *nativeRocketMQRuntime) ListTopics(ctx context.Context, includeSystem bool) ([]rocketmqTopicInfo, error) {
	adminClient, err := r.newAdmin()
	if err != nil {
		return nil, err
	}
	defer adminClient.Close()

	response, err := adminClient.FetchAllTopicList(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	topics := make([]rocketmqTopicInfo, 0, len(response.TopicList))
	for _, name := range response.TopicList {
		topic := strings.TrimSpace(name)
		if topic == "" {
			continue
		}
		if _, exists := seen[topic]; exists {
			continue
		}
		seen[topic] = struct{}{}
		system := rocketmqIsSystemTopic(topic)
		if system && !includeSystem {
			continue
		}
		queues, err := adminClient.FetchPublishMessageQueues(ctx, topic)
		queueCount := 0
		if err == nil {
			queueCount = len(queues)
		}
		topics = append(topics, rocketmqTopicInfo{
			Name:       topic,
			System:     system,
			QueueCount: queueCount,
		})
	}
	sort.Slice(topics, func(i, j int) bool {
		return topics[i].Name < topics[j].Name
	})
	return topics, nil
}

func (r *nativeRocketMQRuntime) InspectConsumerGroups(ctx context.Context, groupID string) ([]rocketmqConsumerGroupInfo, error) {
	return nil, fmt.Errorf("RocketMQ 消费组成员、队列进度和 Lag 查询不可用：当前客户端未公开 broker 路由及对应运维 API；请使用 RocketMQ 控制台或配置具备该管理能力的客户端")
}

func (r *nativeRocketMQRuntime) DescribeTopic(ctx context.Context, request rocketmqDescribeRequest) (rocketmqTopicDescription, error) {
	adminClient, err := r.newAdmin()
	if err != nil {
		return rocketmqTopicDescription{}, err
	}
	defer adminClient.Close()

	consumerClient, err := r.newPullConsumer(request.Topic, request.ConsumerGroup, request.TagExpression, request.PullBatchSize)
	if err != nil {
		return rocketmqTopicDescription{}, err
	}
	defer consumerClient.Shutdown()

	return r.describeTopicWithClients(ctx, adminClient, consumerClient, request)
}

func (r *nativeRocketMQRuntime) FetchMessages(ctx context.Context, request rocketmqFetchRequest) ([]rocketmqMessageRecord, error) {
	adminClient, err := r.newAdmin()
	if err != nil {
		return nil, err
	}
	defer adminClient.Close()

	consumerClient, err := r.newPullConsumer(request.Topic, request.ConsumerGroup, request.TagExpression, request.PullBatchSize)
	if err != nil {
		return nil, err
	}
	defer consumerClient.Shutdown()

	description, err := r.describeTopicWithClients(ctx, adminClient, consumerClient, rocketmqDescribeRequest{
		Topic:         request.Topic,
		ConsumerGroup: request.ConsumerGroup,
		TagExpression: request.TagExpression,
		PullBatchSize: request.PullBatchSize,
	})
	if err != nil {
		return nil, err
	}

	limit := request.Limit
	if limit <= 0 {
		limit = defaultRocketMQPreviewLimit
	}
	target := limit + maxInt(request.Offset, 0)
	if target <= 0 {
		target = defaultRocketMQPreviewLimit
	}
	if request.PullBatchSize <= 0 {
		request.PullBatchSize = defaultRocketMQPullBatchSize
	}
	records := make([]rocketmqMessageRecord, 0, target)
	for _, queue := range description.Queues {
		metaQueue := &rocketmqprimitive.MessageQueue{
			Topic:      description.Name,
			BrokerName: queue.BrokerName,
			QueueId:    queue.QueueID,
		}
		items, err := r.fetchQueueMessages(ctx, consumerClient, metaQueue, queue, request, target)
		if err != nil {
			return nil, err
		}
		records = append(records, items...)
	}
	rocketmqSortMessages(records, request.Latest)
	if request.Offset >= len(records) {
		return []rocketmqMessageRecord{}, nil
	}
	records = records[request.Offset:]
	if len(records) > limit {
		records = records[:limit]
	}
	return records, nil
}

func (r *nativeRocketMQRuntime) Publish(ctx context.Context, command rocketmqPublishCommand) (int64, error) {
	topic := strings.TrimSpace(command.Topic)
	if topic == "" {
		return 0, fmt.Errorf("RocketMQ publish 命令缺少 topic")
	}
	payload, err := mqttEncodePayload(command.Payload)
	if err != nil {
		return 0, fmt.Errorf("序列化 RocketMQ payload 失败：%w", err)
	}

	producerClient, err := r.newProducer()
	if err != nil {
		return 0, err
	}
	defer producerClient.Shutdown()

	message := rocketmqprimitive.NewMessage(topic, payload)
	if tag := strings.TrimSpace(command.Tag); tag != "" {
		message.WithTag(tag)
	}
	if len(command.Keys) > 0 {
		message.WithKeys(command.Keys)
	}
	if command.DelayLevel > 0 {
		message.WithDelayTimeLevel(command.DelayLevel)
	}
	if len(command.Properties) > 0 {
		for key, value := range command.Properties {
			if strings.TrimSpace(key) == "" {
				continue
			}
			message.WithProperty(strings.TrimSpace(key), value)
		}
	}

	result, err := producerClient.SendSync(ctx, message)
	if err != nil {
		return 0, err
	}
	if result == nil || result.Status != rocketmqprimitive.SendOK {
		return 0, fmt.Errorf("RocketMQ 发送失败：状态=%v", result)
	}
	return 1, nil
}

func (r *nativeRocketMQRuntime) describeTopicWithClients(ctx context.Context, adminClient rocketmqadmin.Admin, consumerClient rocketmq.PullConsumer, request rocketmqDescribeRequest) (rocketmqTopicDescription, error) {
	topic := strings.TrimSpace(request.Topic)
	if topic == "" {
		return rocketmqTopicDescription{}, fmt.Errorf("RocketMQ topic 不能为空")
	}
	queues, err := adminClient.FetchPublishMessageQueues(ctx, topic)
	if err != nil {
		return rocketmqTopicDescription{}, err
	}
	sort.Slice(queues, func(i, j int) bool {
		if queues[i].BrokerName == queues[j].BrokerName {
			return queues[i].QueueId < queues[j].QueueId
		}
		if queues[i].QueueId == queues[j].QueueId {
			return queues[i].BrokerName < queues[j].BrokerName
		}
		return queues[i].QueueId < queues[j].QueueId
	})

	description := rocketmqTopicDescription{
		Name:          topic,
		Namespace:     r.namespace,
		ConsumerGroup: strings.TrimSpace(request.ConsumerGroup),
		TagExpression: rocketmqNormalizeTagExpression(request.TagExpression),
		QueueCount:    len(queues),
		Queues:        make([]rocketmqTopicQueueInfo, 0, len(queues)),
	}
	for _, queue := range queues {
		info, err := r.inspectQueue(ctx, consumerClient, queue)
		if err != nil {
			return rocketmqTopicDescription{}, err
		}
		description.Queues = append(description.Queues, info)
		description.TotalApproximateCount += info.ApproximateCount
	}
	return description, nil
}

func (r *nativeRocketMQRuntime) inspectQueue(ctx context.Context, consumerClient rocketmq.PullConsumer, queue *rocketmqprimitive.MessageQueue) (rocketmqTopicQueueInfo, error) {
	result, err := consumerClient.PullFrom(ctx, queue, 0, 1)
	if err != nil {
		return rocketmqTopicQueueInfo{}, err
	}
	minOffset := result.MinOffset
	maxOffset := result.MaxOffset
	if result.Status == rocketmqprimitive.PullOffsetIllegal && result.NextBeginOffset > minOffset {
		minOffset = result.NextBeginOffset
	}
	if maxOffset < minOffset {
		maxOffset = minOffset
	}
	return rocketmqTopicQueueInfo{
		BrokerName:       queue.BrokerName,
		QueueID:          queue.QueueId,
		MinOffset:        minOffset,
		MaxOffset:        maxOffset,
		ApproximateCount: maxInt64(0, maxOffset-minOffset),
	}, nil
}

func (r *nativeRocketMQRuntime) fetchQueueMessages(ctx context.Context, consumerClient rocketmq.PullConsumer, queue *rocketmqprimitive.MessageQueue, meta rocketmqTopicQueueInfo, request rocketmqFetchRequest, target int) ([]rocketmqMessageRecord, error) {
	if target <= 0 || meta.MaxOffset <= meta.MinOffset {
		return []rocketmqMessageRecord{}, nil
	}
	startOffset := meta.MinOffset
	if request.Latest {
		startOffset = maxInt64(meta.MinOffset, meta.MaxOffset-int64(target))
	}
	if startOffset >= meta.MaxOffset {
		return []rocketmqMessageRecord{}, nil
	}

	records := make([]rocketmqMessageRecord, 0, target)
	currentOffset := startOffset
	batchSize := request.PullBatchSize
	if batchSize <= 0 {
		batchSize = defaultRocketMQPullBatchSize
	}
	if batchSize > maxRocketMQPullBatchSize {
		batchSize = maxRocketMQPullBatchSize
	}
	for len(records) < target && currentOffset < meta.MaxOffset {
		numbers := batchSize
		if remaining := target - len(records); remaining < numbers {
			numbers = remaining
		}
		if numbers <= 0 {
			break
		}
		result, err := consumerClient.PullFrom(ctx, queue, currentOffset, numbers)
		if err != nil {
			return nil, err
		}
		switch result.Status {
		case rocketmqprimitive.PullFound:
			for _, message := range result.GetMessageExts() {
				records = append(records, rocketmqRecordFromExt(message, queue.BrokerName, queue.QueueId, result.MinOffset, result.MaxOffset))
			}
			if result.NextBeginOffset <= currentOffset {
				return records, nil
			}
			currentOffset = result.NextBeginOffset
		case rocketmqprimitive.PullOffsetIllegal:
			if result.NextBeginOffset <= currentOffset {
				return records, nil
			}
			currentOffset = result.NextBeginOffset
		case rocketmqprimitive.PullNoNewMsg, rocketmqprimitive.PullNoMsgMatched, rocketmqprimitive.PullBrokerTimeout:
			return records, nil
		default:
			return records, nil
		}
	}
	return records, nil
}

func (r *nativeRocketMQRuntime) newAdmin() (rocketmqadmin.Admin, error) {
	options := []rocketmqadmin.AdminOption{
		rocketmqadmin.WithResolver(rocketmqprimitive.NewPassthroughResolver(append([]string(nil), r.nameservers...))),
	}
	if namespace := strings.TrimSpace(r.namespace); namespace != "" {
		options = append(options, rocketmqadmin.WithNamespace(namespace))
	}
	if credentials, ok := rocketmqCredentials(r.config); ok {
		options = append(options, rocketmqadmin.WithCredentials(credentials))
	}
	return rocketmqadmin.NewAdmin(options...)
}

func (r *nativeRocketMQRuntime) newProducer() (rocketmq.Producer, error) {
	group := rocketmqProducerGroup(r.config)
	if group == "" {
		group = fmt.Sprintf("%s-%d", rocketMQDefaultProducerGroup, time.Now().UnixNano())
	}
	options := []rocketmqproducer.Option{
		rocketmqproducer.WithNsResolver(rocketmqprimitive.NewPassthroughResolver(append([]string(nil), r.nameservers...))),
		rocketmqproducer.WithGroupName(group),
		rocketmqproducer.WithInstanceName(fmt.Sprintf("%s-producer-%d", rocketMQDefaultInstancePrefix, time.Now().UnixNano())),
		rocketmqproducer.WithRetry(0),
		rocketmqproducer.WithSendMsgTimeout(r.sendTimeout),
	}
	if namespace := strings.TrimSpace(r.namespace); namespace != "" {
		options = append(options, rocketmqproducer.WithNamespace(namespace))
	}
	if credentials, ok := rocketmqCredentials(r.config); ok {
		options = append(options, rocketmqproducer.WithCredentials(credentials))
	}
	client, err := rocketmq.NewProducer(options...)
	if err != nil {
		return nil, err
	}
	if err := client.Start(); err != nil {
		return nil, err
	}
	return client, nil
}

func (r *nativeRocketMQRuntime) newPullConsumer(topic string, consumerGroup string, tagExpression string, pullBatchSize int) (rocketmq.PullConsumer, error) {
	group := strings.TrimSpace(consumerGroup)
	if group == "" {
		group = fmt.Sprintf("%s-%d", rocketMQDefaultConsumerGroup, time.Now().UnixNano())
	}
	if pullBatchSize <= 0 {
		pullBatchSize = defaultRocketMQPullBatchSize
	}
	if pullBatchSize > maxRocketMQPullBatchSize {
		pullBatchSize = maxRocketMQPullBatchSize
	}
	options := []rocketmqconsumer.Option{
		rocketmqconsumer.WithNsResolver(rocketmqprimitive.NewPassthroughResolver(append([]string(nil), r.nameservers...))),
		rocketmqconsumer.WithGroupName(group),
		rocketmqconsumer.WithInstance(fmt.Sprintf("%s-consumer-%d", rocketMQDefaultInstancePrefix, time.Now().UnixNano())),
		rocketmqconsumer.WithConsumeFromWhere(rocketmqconsumer.ConsumeFromFirstOffset),
		rocketmqconsumer.WithPullBatchSize(int32(pullBatchSize)),
	}
	if namespace := strings.TrimSpace(r.namespace); namespace != "" {
		options = append(options, rocketmqconsumer.WithNamespace(namespace))
	}
	if credentials, ok := rocketmqCredentials(r.config); ok {
		options = append(options, rocketmqconsumer.WithCredentials(credentials))
	}
	client, err := rocketmq.NewPullConsumer(options...)
	if err != nil {
		return nil, err
	}
	selector := rocketmqconsumer.MessageSelector{
		Type:       rocketmqconsumer.TAG,
		Expression: rocketmqNormalizeTagExpression(tagExpression),
	}
	if err := client.Subscribe(strings.TrimSpace(topic), selector); err != nil {
		_ = client.Shutdown()
		return nil, err
	}
	if err := client.Start(); err != nil {
		_ = client.Shutdown()
		return nil, err
	}
	return client, nil
}

func normalizeRocketMQConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyRocketMQURI(config)
	if strings.TrimSpace(runConfig.Host) == "" && len(runConfig.Hosts) == 0 {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultRocketMQPort
	}
	return runConfig
}

func applyRocketMQURI(config connection.ConnectionConfig) connection.ConnectionConfig {
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
	case "rocketmq", "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq":
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
		host, port, ok := parseHostPortWithDefault(strings.TrimSpace(entry), defaultRocketMQPort)
		if !ok {
			continue
		}
		hosts = append(hosts, rocketmqFormatHostPort(host, port))
	}
	if len(hosts) > 0 {
		host, port, ok := parseHostPortWithDefault(hosts[0], defaultRocketMQPort)
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

func rocketmqConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "rocketmq", "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func rocketmqDefaultTopic(config connection.ConnectionConfig) string {
	if topic := strings.TrimSpace(config.Database); topic != "" {
		return topic
	}
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(params.Get("topic"), params.Get("defaultTopic"), params.Get("default_topic"))
}

func rocketmqConfiguredConsumerGroup(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(
		params.Get("groupId"),
		params.Get("group_id"),
		params.Get("consumerGroup"),
		params.Get("consumer_group"),
	)
}

func rocketmqProducerGroup(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(params.Get("producerGroup"), params.Get("producer_group"))
}

func rocketmqConfiguredTagExpression(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(
		params.Get("tag"),
		params.Get("tags"),
		params.Get("tagExpression"),
		params.Get("tag_expression"),
		params.Get("selector"),
		params.Get("selectorExpression"),
		params.Get("selector_expression"),
	)
}

func rocketmqTagExpressionIsDefault(value string) bool {
	text := strings.TrimSpace(value)
	return text == "" || text == "*" || strings.EqualFold(text, "all")
}

func rocketmqNormalizeTagExpression(value string) string {
	text := strings.TrimSpace(value)
	if rocketmqTagExpressionIsDefault(text) {
		return "*"
	}
	return text
}

func rocketmqNamespace(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(params.Get("namespace"), params.Get("ns"))
}

func rocketmqDefaultStartLatest(config connection.ConnectionConfig) bool {
	params := rocketmqConnectionParams(config)
	value := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		params.Get("startOffset"),
		params.Get("start_offset"),
		params.Get("consumeFrom"),
		params.Get("consume_from"),
	)))
	switch value {
	case "latest", "last", "newest", "end", "tail":
		return true
	default:
		return false
	}
}

func rocketmqPullBatchSize(config connection.ConnectionConfig) int {
	params := rocketmqConnectionParams(config)
	value := strings.TrimSpace(firstNonEmpty(params.Get("pullBatchSize"), params.Get("pull_batch_size")))
	if size, err := strconv.Atoi(value); err == nil && size > 0 {
		if size > maxRocketMQPullBatchSize {
			return maxRocketMQPullBatchSize
		}
		return size
	}
	return defaultRocketMQPullBatchSize
}

func rocketmqSendTimeout(config connection.ConnectionConfig) time.Duration {
	params := rocketmqConnectionParams(config)
	value := strings.TrimSpace(firstNonEmpty(params.Get("sendTimeoutMs"), params.Get("send_timeout_ms")))
	if ms, err := strconv.Atoi(value); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return timeout
}

func rocketmqCredentials(config connection.ConnectionConfig) (rocketmqprimitive.Credentials, bool) {
	params := rocketmqConnectionParams(config)
	accessKey := strings.TrimSpace(firstNonEmpty(config.User, params.Get("accessKey"), params.Get("access_key")))
	secretKey := strings.TrimSpace(firstNonEmpty(config.Password, params.Get("secretKey"), params.Get("secret_key")))
	securityToken := strings.TrimSpace(firstNonEmpty(params.Get("securityToken"), params.Get("security_token")))
	credentials := rocketmqprimitive.Credentials{
		AccessKey:     accessKey,
		SecretKey:     secretKey,
		SecurityToken: securityToken,
	}
	if credentials.IsEmpty() {
		return rocketmqprimitive.Credentials{}, false
	}
	return credentials, true
}

func rocketmqNameServerAddresses(config connection.ConnectionConfig) ([]string, error) {
	candidates := make([]string, 0, len(config.Hosts)+1)
	if host := strings.TrimSpace(config.Host); host != "" {
		port := config.Port
		if port <= 0 {
			port = defaultRocketMQPort
		}
		candidates = append(candidates, rocketmqFormatHostPort(host, port))
	}
	candidates = append(candidates, config.Hosts...)
	seen := map[string]struct{}{}
	nameservers := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		host, port, ok := parseHostPortWithDefault(candidate, defaultRocketMQPort)
		if !ok {
			continue
		}
		address := rocketmqFormatHostPort(host, port)
		if _, exists := seen[address]; exists {
			continue
		}
		seen[address] = struct{}{}
		nameservers = append(nameservers, address)
	}
	if len(nameservers) == 0 {
		return nil, fmt.Errorf("RocketMQ 至少需要一个 NameServer 地址")
	}
	return nameservers, nil
}

func rocketmqFormatHostPort(host string, port int) string {
	h := strings.TrimSpace(host)
	if strings.Contains(h, ":") && !strings.HasPrefix(h, "[") {
		return fmt.Sprintf("[%s]:%d", h, port)
	}
	return fmt.Sprintf("%s:%d", h, port)
}

func rocketmqResolveTopic(topic string, fallback string) string {
	if text := strings.TrimSpace(topic); text != "" {
		return text
	}
	return strings.TrimSpace(fallback)
}

func rocketmqIsSystemTopic(topic string) bool {
	name := strings.TrimSpace(topic)
	if name == "" {
		return false
	}
	switch {
	case strings.HasPrefix(name, "%RETRY%"),
		strings.HasPrefix(name, "%DLQ%"),
		strings.HasPrefix(name, "rmq_sys_"),
		strings.HasPrefix(name, "CID_RMQ_SYS_"):
		return true
	}
	switch name {
	case "TBW102", "SELF_TEST_TOPIC", "OFFSET_MOVED_EVENT", "SCHEDULE_TOPIC_XXXX", "RMQ_SYS_TRANS_HALF_TOPIC", "RMQ_SYS_TRACE_TOPIC", "TRANS_CHECK_MAX_TIME_TOPIC", "BenchmarkTest":
		return true
	default:
		return false
	}
}

func rocketmqKeysFromAny(value interface{}) ([]string, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		return rocketmqSplitKeys(typed), nil
	case []string:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(item); text != "" {
				result = append(result, text)
			}
		}
		return result, nil
	case []interface{}:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(fmt.Sprintf("%v", item))
			if text != "" {
				result = append(result, text)
			}
		}
		return result, nil
	default:
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			return nil, nil
		}
		return rocketmqSplitKeys(text), nil
	}
}

func rocketmqSplitKeys(text string) []string {
	parts := strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == ';' || r == '|' || r == '\n' || r == '\r' || r == '\t' || r == ' ' || r == '，'
	})
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if normalized := strings.TrimSpace(part); normalized != "" {
			result = append(result, normalized)
		}
	}
	return result
}

func rocketmqPropertiesFromAny(value interface{}) (map[string]string, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case map[string]string:
		result := make(map[string]string, len(typed))
		for key, item := range typed {
			if strings.TrimSpace(key) != "" {
				result[strings.TrimSpace(key)] = item
			}
		}
		return result, nil
	case map[string]interface{}:
		result := make(map[string]string, len(typed))
		for key, item := range typed {
			normalizedKey := strings.TrimSpace(key)
			if normalizedKey == "" {
				continue
			}
			switch casted := item.(type) {
			case string:
				result[normalizedKey] = casted
			default:
				payload, err := json.Marshal(casted)
				if err != nil {
					return nil, fmt.Errorf("RocketMQ properties 字段 %q 无法序列化：%w", normalizedKey, err)
				}
				result[normalizedKey] = string(payload)
			}
		}
		return result, nil
	default:
		return nil, fmt.Errorf("RocketMQ properties 必须是 JSON 对象")
	}
}

func rocketmqDelayLevelFromAny(value interface{}) (int, error) {
	switch typed := value.(type) {
	case nil:
		return 0, nil
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
		}
		return rocketmqNormalizeDelayLevel(int(n))
	case float64:
		return rocketmqNormalizeDelayLevel(int(typed))
	case int:
		return rocketmqNormalizeDelayLevel(typed)
	case int64:
		return rocketmqNormalizeDelayLevel(int(typed))
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0, nil
		}
		n, err := strconv.Atoi(text)
		if err != nil {
			return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
		}
		return rocketmqNormalizeDelayLevel(n)
	default:
		return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
	}
}

func rocketmqNormalizeDelayLevel(value int) (int, error) {
	if value < 0 {
		return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
	}
	return value, nil
}

func rocketmqRecordFromExt(message *rocketmqprimitive.MessageExt, brokerName string, queueID int, minOffset int64, maxOffset int64) rocketmqMessageRecord {
	if message == nil {
		return rocketmqMessageRecord{
			BrokerName: brokerName,
			QueueID:    queueID,
			MinOffset:  minOffset,
			MaxOffset:  maxOffset,
		}
	}
	decoded, encoding := mqttDecodePayload(message.Body)
	embeddedBroker := ""
	if message.Queue != nil {
		embeddedBroker = message.Queue.BrokerName
	}
	return rocketmqMessageRecord{
		Topic:          message.Topic,
		BrokerName:     firstNonEmpty(brokerName, embeddedBroker),
		QueueID:        queueID,
		QueueOffset:    message.QueueOffset,
		MsgID:          message.MsgId,
		OffsetMsgID:    message.OffsetMsgId,
		Tags:           message.GetTags(),
		Keys:           message.GetKeys(),
		Body:           append([]byte(nil), message.Body...),
		Decoded:        decoded,
		Encoding:       encoding,
		Properties:     message.GetProperties(),
		BornTimestamp:  time.UnixMilli(message.BornTimestamp),
		StoreTimestamp: time.UnixMilli(message.StoreTimestamp),
		ReconsumeTimes: message.ReconsumeTimes,
		MinOffset:      minOffset,
		MaxOffset:      maxOffset,
	}
}

func parseRocketMQSQL(sqlText string, defaultLatest bool) (rocketmqParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if text == "" {
		return rocketmqParsedSQL{}, false
	}
	if matches := rocketmqShowTopicsRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := rocketmqParsedSQL{Action: "show_topics"}
		if len(matches) > 1 && strings.TrimSpace(matches[1]) != "" {
			parsed.Limit, _ = strconv.Atoi(matches[1])
		}
		return parsed, true
	}
	if rocketmqShowGroupsRE.MatchString(text) {
		return rocketmqParsedSQL{Action: "show_consumer_groups"}, true
	}
	if matches := rocketmqDescribeGroupRE.FindStringSubmatch(text); len(matches) > 0 {
		return rocketmqParsedSQL{Action: "describe_consumer_group", GroupID: firstNonEmpty(matches[1], matches[2], matches[3])}, true
	}
	if matches := rocketmqDescribeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		return rocketmqParsedSQL{
			Action: "describe_topic",
			Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
		}, true
	}
	if matches := rocketmqConsumeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := rocketmqParsedSQL{
			Action: "consume",
			Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
			Limit:  defaultRocketMQPreviewLimit,
			Latest: defaultLatest,
		}
		if limitMatch := rocketmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
			parsed.Limit, _ = strconv.Atoi(limitMatch[1])
		}
		if offsetMatch := rocketmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
			parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
		}
		return parsed, true
	}
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return rocketmqParsedSQL{}, false
	}
	matches := rocketmqSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return rocketmqParsedSQL{}, false
	}
	parsed := rocketmqParsedSQL{
		Action: "select",
		Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
		Limit:  defaultRocketMQPreviewLimit,
		Count:  strings.Contains(strings.ToLower(text), "count("),
		Latest: defaultLatest,
	}
	if limitMatch := rocketmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
		parsed.Limit, _ = strconv.Atoi(limitMatch[1])
	}
	if offsetMatch := rocketmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
		parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
	}
	return parsed, true
}

type rocketmqParsedSQL struct {
	Action  string
	Topic   string
	GroupID string
	Limit   int
	Offset  int
	Count   bool
	Latest  bool
}

var (
	rocketmqSQLFromRE       = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
	rocketmqSQLLimitRE      = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	rocketmqSQLOffsetRE     = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	rocketmqShowTopicsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+TOPICS(?:\s+LIMIT\s+(\d+))?\s*;?\s*$`)
	rocketmqShowGroupsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+CONSUMER\s+GROUPS\s*;?\s*$`)
	rocketmqDescribeGroupRE = regexp.MustCompile(`(?i)^\s*(?:DESCRIBE|SHOW)\s+CONSUMER\s+GROUP\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))\s*;?\s*$`)
	rocketmqDescribeTopicRE = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+TOPIC\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))\s*;?\s*$`)
	rocketmqConsumeTopicRE  = regexp.MustCompile(`(?i)^\s*CONSUME\s+FROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
)

func rocketmqConsumerGroupRows(groups []rocketmqConsumerGroupInfo) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(groups))
	for _, g := range groups {
		rows = append(rows, map[string]interface{}{
			"group": g.GroupID, "state": g.State, "member": g.MemberID, "client_id": g.ClientID, "client_host": g.ClientHost,
			"topic": g.Topic, "queue_id": g.QueueID, "current_offset": g.CurrentOffset, "log_end_offset": g.LogEndOffset, "lag": g.Lag,
		})
	}
	return rows
}

func rocketmqTopicRows(topics []rocketmqTopicInfo) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(topics))
	for _, topic := range topics {
		rows = append(rows, map[string]interface{}{
			"topic":        topic.Name,
			"system_topic": topic.System,
			"queue_count":  topic.QueueCount,
		})
	}
	return rows
}

func rocketmqDescribeRows(description rocketmqTopicDescription) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(description.Queues))
	for _, queue := range description.Queues {
		rows = append(rows, map[string]interface{}{
			"topic":                   description.Name,
			"namespace":               description.Namespace,
			"consumer_group":          description.ConsumerGroup,
			"tag_expression":          description.TagExpression,
			"queue_count":             description.QueueCount,
			"topic_approximate_count": description.TotalApproximateCount,
			"broker_name":             queue.BrokerName,
			"queue_id":                queue.QueueID,
			"min_offset":              queue.MinOffset,
			"max_offset":              queue.MaxOffset,
			"approximate_count":       queue.ApproximateCount,
		})
	}
	if len(rows) == 0 {
		rows = append(rows, map[string]interface{}{
			"topic":                   description.Name,
			"namespace":               description.Namespace,
			"consumer_group":          description.ConsumerGroup,
			"tag_expression":          description.TagExpression,
			"queue_count":             0,
			"topic_approximate_count": 0,
		})
	}
	return rows
}

func rocketmqMessageRows(records []rocketmqMessageRecord) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(records))
	for _, record := range records {
		row := map[string]interface{}{
			"topic":           record.Topic,
			"broker_name":     record.BrokerName,
			"queue_id":        record.QueueID,
			"queue_offset":    record.QueueOffset,
			"msg_id":          record.MsgID,
			"offset_msg_id":   record.OffsetMsgID,
			"tags":            record.Tags,
			"keys":            record.Keys,
			"born_timestamp":  record.BornTimestamp,
			"store_timestamp": record.StoreTimestamp,
			"reconsume_times": record.ReconsumeTimes,
			"body":            record.Decoded,
			"body_encoding":   record.Encoding,
			"properties":      record.Properties,
			"min_offset":      record.MinOffset,
			"max_offset":      record.MaxOffset,
		}
		if payloadMap, ok := record.Decoded.(map[string]interface{}); ok {
			flattenRocketMQMap("body", payloadMap, row)
		}
		if len(record.Properties) > 0 {
			for key, value := range record.Properties {
				if strings.TrimSpace(key) == "" {
					continue
				}
				row["properties."+key] = value
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func flattenRocketMQMap(prefix string, values map[string]interface{}, row map[string]interface{}) {
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		name := prefix + "." + key
		row[name] = value
		if nested, ok := value.(map[string]interface{}); ok {
			flattenRocketMQMap(name, nested, row)
		}
	}
}

func rocketmqSortMessages(records []rocketmqMessageRecord, latest bool) {
	sort.Slice(records, func(i, j int) bool {
		left := records[i]
		right := records[j]
		switch {
		case left.StoreTimestamp.Equal(right.StoreTimestamp):
			if left.QueueOffset == right.QueueOffset {
				if left.QueueID == right.QueueID {
					return left.BrokerName < right.BrokerName
				}
				if latest {
					return left.QueueID > right.QueueID
				}
				return left.QueueID < right.QueueID
			}
			if latest {
				return left.QueueOffset > right.QueueOffset
			}
			return left.QueueOffset < right.QueueOffset
		case latest:
			return left.StoreTimestamp.After(right.StoreTimestamp)
		default:
			return left.StoreTimestamp.Before(right.StoreTimestamp)
		}
	})
}
