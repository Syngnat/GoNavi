//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

// kafka-go 要求 Writer.Topic 与 Message.Topic 二选一：两边都设时 WriteMessages 必定失败，
// 历史实现正是两边都设，导致发布永远报「Topic must not be specified for both」。
func TestKafkaPublishSetsTopicOnlyOnWriter(t *testing.T) {
	runtime, err := newKafkaGoRuntime(connection.ConnectionConfig{Type: "kafka", Host: "127.0.0.1", Port: 9092})
	if err != nil {
		t.Fatalf("newKafkaGoRuntime: %v", err)
	}
	defer runtime.Close()
	concrete := runtime.(*kafkaGoRuntime)

	writer := concrete.newPublishWriter("orders.events")
	defer writer.Close()
	if writer.Topic != "orders.events" {
		t.Fatalf("writer topic = %q", writer.Topic)
	}
	message, err := kafkaPublishMessage(kafkaPublishCommand{
		Topic:   "orders.events",
		Key:     "k1",
		Value:   map[string]interface{}{"id": 1},
		Headers: map[string]interface{}{"x-env": "dev"},
	})
	if err != nil {
		t.Fatalf("kafkaPublishMessage: %v", err)
	}
	if message.Topic != "" {
		t.Fatalf("message topic must stay empty when the writer owns the topic, got %q", message.Topic)
	}
	if string(message.Key) != "k1" || string(message.Value) != `{"id":1}` || len(message.Headers) != 1 {
		t.Fatalf("unexpected message: key=%q value=%q headers=%v", message.Key, message.Value, message.Headers)
	}
}

// 默认 BatchBytes 是 1 MiB：超过就在客户端被拒，报错文案却像 broker 拒收。
// 放宽客户端批次上限后，消息大小交给 broker 的 message.max.bytes 判定。
func TestKafkaPublishWriterAllowsMessagesBeyondOneMiB(t *testing.T) {
	runtime, err := newKafkaGoRuntime(connection.ConnectionConfig{Type: "kafka", Host: "127.0.0.1", Port: 9092})
	if err != nil {
		t.Fatalf("newKafkaGoRuntime: %v", err)
	}
	defer runtime.Close()

	writer := runtime.(*kafkaGoRuntime).newPublishWriter("orders.events")
	defer writer.Close()
	if writer.BatchBytes <= 1<<20 {
		t.Fatalf("BatchBytes = %d, want > 1 MiB", writer.BatchBytes)
	}
}
