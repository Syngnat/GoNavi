//go:build gonavi_full_drivers || gonavi_rocketmq_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

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
	if native, ok := runtime.(*nativeRocketMQRuntime); ok && tunnel != nil {
		native.dialContext = tunnel.dialContext
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
