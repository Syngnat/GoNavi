//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

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
		return nil, nil, fmt.Errorf("Kafka 查询仅支持 SHOW TOPICS、SHOW/DESCRIBE CONSUMER GROUP、DESCRIBE TOPIC、SELECT * FROM topic 与 CONSUME FROM topic")
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
	case "show_consumer_groups", "describe_consumer_group":
		groups, err := k.runtime.InspectConsumerGroups(ctx, strings.TrimSpace(parsed.GroupID))
		if err != nil {
			return nil, nil, err
		}
		rows := kafkaConsumerGroupRows(groups)
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
