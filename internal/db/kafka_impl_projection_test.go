//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"strings"
	"testing"

	kafka "github.com/segmentio/kafka-go"
)

func TestParseKafkaSQLSelectColumnsAndLocator(t *testing.T) {
	parsed, ok := parseKafkaSQL(`SELECT timestamp, partition, offset, key, value_size FROM "orders" LIMIT 5`, true)
	if !ok {
		t.Fatal("列投影查询应解析成功")
	}
	if strings.Join(parsed.Columns, ",") != "timestamp,partition,offset,key,value_size" {
		t.Fatalf("columns = %v", parsed.Columns)
	}
	if parsed.Limit != 5 {
		t.Fatalf("limit = %d", parsed.Limit)
	}

	locator, ok := parseKafkaSQL(`SELECT * FROM "orders" WHERE partition = 3 AND offset = 42 LIMIT 1`, true)
	if !ok {
		t.Fatal("定位查询应解析成功")
	}
	if locator.Columns != nil {
		t.Fatalf("SELECT * 应为全列，got %v", locator.Columns)
	}
	if locator.Partition == nil || *locator.Partition != 3 {
		t.Fatalf("partition = %v", locator.Partition)
	}
	if locator.MsgOffset == nil || *locator.MsgOffset != 42 {
		t.Fatalf("offset = %v", locator.MsgOffset)
	}
}

// 列表预览只取元数据列：payload 不进入行，帧体积才能与消息大小解耦。
func TestKafkaMessageRowsProjectedDropsPayload(t *testing.T) {
	records := []kafkaMessageRecord{{
		Message: kafka.Message{Topic: "orders", Partition: 0, Offset: 7, Value: []byte(`{"appid":"x","data":"payload"}`)},
		Key:     "k1",
		Value:   map[string]interface{}{"appid": "x", "data": "payload"},
	}}
	rows := kafkaMessageRowsProjected(records, []string{"timestamp", "offset", "value_size"})
	if len(rows) != 1 {
		t.Fatalf("rows = %d", len(rows))
	}
	row := rows[0]
	if _, ok := row["value"]; ok {
		t.Fatal("投影模式不应返回 value")
	}
	if row["offset"] != int64(7) {
		t.Fatalf("offset = %v", row["offset"])
	}
	if _, ok := row["value_size"]; !ok {
		t.Fatal("应返回 value_size")
	}
}

// 大 payload 不再展开成 value.xxx 列：展开会让同一份内容在行里出现两次。
func TestKafkaMessageRowsSkipsFlatteningOversizedPayload(t *testing.T) {
	big := strings.Repeat("x", kafkaFlattenMaxPayloadBytes+1)
	records := []kafkaMessageRecord{{
		Message: kafka.Message{Topic: "orders", Value: []byte(big)},
		Value:   map[string]interface{}{"data": big},
	}}
	rows := kafkaMessageRows(records)
	if len(rows) != 1 {
		t.Fatalf("rows = %d", len(rows))
	}
	if _, ok := rows[0]["value.data"]; ok {
		t.Fatal("超大 payload 不应展开成 value.xxx 列")
	}
	if _, ok := rows[0]["value"]; !ok {
		t.Fatal("全列模式仍应返回 value")
	}
}
