//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const (
	// kafkaDefaultPreviewByteBudget 是只取元数据的列表预览累计读取的消息体积上限。
	// Kafka 没有「只读元数据」的 fetch：列出 N 条就要传 N 条完整消息。不设上限时
	// 100 条 15 MB 的消息要传 1.5 GB；超出时返回已读到的部分并附带截断提示。
	kafkaDefaultPreviewByteBudget int64 = 64 << 20
	// kafkaPayloadByteBudget 是带 payload 的结果读取上限。大消息会让结果和主进程内存一起膨胀，
	// 超出时返回已读到的部分并附带截断提示。
	kafkaPayloadByteBudget int64 = 16 << 20
)

// kafkaPreviewByteBudget 读取连接参数 previewMaxMB（列表预览的读取上限，单位 MB）。
func kafkaPreviewByteBudget(config connection.ConnectionConfig) int64 {
	params := kafkaConnectionParams(config)
	text := strings.TrimSpace(firstNonEmpty(params.Get("previewMaxMB"), params.Get("preview_max_mb")))
	if mb, err := strconv.Atoi(text); err == nil && mb > 0 {
		return int64(mb) << 20
	}
	return kafkaDefaultPreviewByteBudget
}

// queryMessages 处理 SELECT / CONSUME：列表、按 partition+offset 定位、计数。
func (k *KafkaDB) queryMessages(ctx context.Context, parsed kafkaParsedSQL) ([]map[string]interface{}, []string, []string, error) {
	topic := kafkaResolveTopic(parsed.Topic, k.defaultTopic)
	if topic == "" {
		return nil, nil, nil, fmt.Errorf("Kafka topic 不能为空")
	}
	if parsed.Count {
		rows, columns, err := k.countMessages(ctx, topic, parsed.Partition)
		return rows, columns, nil, err
	}
	if parsed.MsgOffset != nil && parsed.Partition == nil {
		return nil, nil, nil, fmt.Errorf("Kafka 按 offset 定位需要同时指定 partition，例如 WHERE partition = 0 AND offset = %d", *parsed.MsgOffset)
	}
	if parsed.Partition != nil && parsed.MsgOffset != nil {
		record, err := k.runtime.FetchMessageAt(ctx, kafkaMessageLocator{Topic: topic, Partition: *parsed.Partition, Offset: *parsed.MsgOffset})
		if err != nil {
			return nil, nil, nil, err
		}
		if record == nil {
			return []map[string]interface{}{}, []string{}, nil, nil
		}
		rows := kafkaMessageRowsProjected([]kafkaMessageRecord{*record}, parsed.Columns)
		return rows, collectColumns(rows), nil, nil
	}
	request := kafkaFetchRequest{
		Topic:        topic,
		Limit:        parsed.Limit,
		Offset:       parsed.Offset,
		Latest:       parsed.Latest,
		IncludeValue: kafkaProjectionNeedsValue(parsed.Columns),
	}
	if parsed.Action == "consume" {
		request.GroupID = firstNonEmpty(strings.TrimSpace(parsed.GroupID), k.defaultGroup)
	} else {
		request.Partition = parsed.Partition
	}
	request.ByteBudget = k.fetchByteBudget(request.IncludeValue)
	result, err := k.runtime.FetchMessages(ctx, request)
	if err != nil {
		return nil, nil, nil, err
	}
	rows := kafkaMessageRowsProjected(result.Records, parsed.Columns)
	var messages []string
	if result.Truncated {
		messages = []string{FormatKafkaPreviewTruncatedNotice(len(rows), request.ByteBudget)}
	}
	return rows, collectColumns(rows), messages, nil
}

func (k *KafkaDB) fetchByteBudget(includeValue bool) int64 {
	budget := k.previewBudget
	if budget <= 0 {
		budget = kafkaDefaultPreviewByteBudget
	}
	if includeValue && budget > kafkaPayloadByteBudget {
		return kafkaPayloadByteBudget
	}
	return budget
}

// countMessages 返回近似消息数（high-water mark - 最早 offset）；指定 partition 时只算该分区。
func (k *KafkaDB) countMessages(ctx context.Context, topic string, partition *int) ([]map[string]interface{}, []string, error) {
	description, err := k.runtime.DescribeTopic(ctx, topic)
	if err != nil {
		return nil, nil, err
	}
	if partition != nil {
		filtered := description.Partitions[:0:0]
		for _, item := range description.Partitions {
			if item.ID == *partition {
				filtered = append(filtered, item)
			}
		}
		if len(filtered) == 0 {
			return nil, nil, fmt.Errorf("Kafka topic %s 不存在分区 %d", topic, *partition)
		}
		description.Partitions = filtered
	}
	return []map[string]interface{}{{
		"topic": topic,
		"total": kafkaTopicMessageCount(description),
	}}, []string{"topic", "total"}, nil
}
