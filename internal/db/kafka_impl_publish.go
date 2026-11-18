//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	kafka "github.com/segmentio/kafka-go"
)

// Publish 把 JSON publish 命令写入一条 Kafka 消息。
func (r *kafkaGoRuntime) Publish(ctx context.Context, command kafkaPublishCommand) (int64, error) {
	topic := strings.TrimSpace(command.Topic)
	if topic == "" {
		return 0, fmt.Errorf("Kafka publish 命令缺少 topic")
	}
	message, err := kafkaPublishMessage(command)
	if err != nil {
		return 0, err
	}
	writer := r.newPublishWriter(topic)
	defer writer.Close()
	if err := writer.WriteMessages(ctx, message); err != nil {
		return 0, err
	}
	return 1, nil
}

// kafkaPublishBatchBytes 放宽 kafka-go 默认 1 MiB 的客户端批次上限。
// 超过默认值时客户端会直接报 Message Size Too Large，看起来像 broker 拒收。
const kafkaPublishBatchBytes = 32 << 20

// newPublishWriter 构造单条发布用的 Writer。
//
// Topic 只能设在 Writer 上：kafka-go 要求 Writer.Topic 与 Message.Topic 二选一，
// 两边都设会让每次 WriteMessages 直接失败。消息能否写入交给 broker 的 message.max.bytes 判定。
func (r *kafkaGoRuntime) newPublishWriter(topic string) *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP(r.brokers...),
		Topic:        topic,
		RequiredAcks: r.defaultAck,
		Transport:    r.transport,
		ReadTimeout:  r.timeout,
		WriteTimeout: r.timeout,
		BatchTimeout: 20 * time.Millisecond,
		BatchBytes:   kafkaPublishBatchBytes,
	}
}

// kafkaPublishMessage 序列化 key / value / headers；topic 由 Writer 决定，这里必须留空。
func kafkaPublishMessage(command kafkaPublishCommand) (kafka.Message, error) {
	keyBytes, err := kafkaMessageBytes(command.Key)
	if err != nil {
		return kafka.Message{}, fmt.Errorf("序列化 Kafka key 失败：%w", err)
	}
	valueBytes, err := kafkaMessageBytes(command.Value)
	if err != nil {
		return kafka.Message{}, fmt.Errorf("序列化 Kafka value 失败：%w", err)
	}
	headers, err := kafkaMessageHeaders(command.Headers)
	if err != nil {
		return kafka.Message{}, fmt.Errorf("序列化 Kafka headers 失败：%w", err)
	}
	return kafka.Message{
		Key:     keyBytes,
		Value:   valueBytes,
		Headers: headers,
		Time:    time.Now(),
	}, nil
}
