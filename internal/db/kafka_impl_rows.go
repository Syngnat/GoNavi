//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"strings"
	"time"
)

// kafkaFlattenMaxPayloadBytes 限制 SELECT * 时「把 JSON payload 展开成 value.xxx 列」的消息体积。
// 展开会让同一份内容在行里出现两次（value 与 value.data）。显式请求的 value.xxx 列不受此限制。
const kafkaFlattenMaxPayloadBytes = 64 << 10

func kafkaMessageRows(records []kafkaMessageRecord) []map[string]interface{} {
	return kafkaMessageRowsProjected(records, nil)
}

// kafkaMessageRowsProjected 按列投影构造消息行；columns 为空表示全列。
//
// 列表预览只请求元数据列（timestamp/partition/offset/key/value_size），payload 由详情
// 查询按 partition+offset 单独拉取，避免把十几 MB 的消息塞进列表帧。
func kafkaMessageRowsProjected(records []kafkaMessageRecord, columns []string) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(records))
	for _, record := range records {
		row := kafkaMessageBaseRow(record)
		if len(columns) == 0 {
			row["value"] = record.Value
			kafkaFlattenDefault(record, row)
			rows = append(rows, row)
			continue
		}
		if kafkaColumnSelected(columns, "value") {
			row["value"] = record.Value
		}
		kafkaFlattenRequested(record, columns, row)
		rows = append(rows, projectKafkaRow(row, columns))
	}
	return rows
}

func kafkaMessageBaseRow(record kafkaMessageRecord) map[string]interface{} {
	return map[string]interface{}{
		"topic":           record.Message.Topic,
		"partition":       record.Message.Partition,
		"offset":          record.Message.Offset,
		"timestamp":       record.Message.Time.Format(time.RFC3339Nano),
		"high_water_mark": record.Message.HighWaterMark,
		"key":             record.Key,
		"headers":         record.Headers,
		"key_size":        len(record.Message.Key),
		"value_size":      record.valueSize(),
	}
}

// kafkaFlattenDefault 是 SELECT * 的展开规则：小 payload 展开成 value.xxx，key/headers 总是展开。
func kafkaFlattenDefault(record kafkaMessageRecord, row map[string]interface{}) {
	if valueMap, ok := record.Value.(map[string]interface{}); ok && record.valueSize() <= kafkaFlattenMaxPayloadBytes {
		flattenKafkaMap("value", valueMap, row)
	}
	if keyMap, ok := record.Key.(map[string]interface{}); ok {
		flattenKafkaMap("key", keyMap, row)
	}
	if len(record.Headers) > 0 {
		flattenKafkaMap("headers", record.Headers, row)
	}
}

// kafkaFlattenRequested 只展开投影里显式请求了 value./key./headers. 子列的来源。
func kafkaFlattenRequested(record kafkaMessageRecord, columns []string, row map[string]interface{}) {
	if valueMap, ok := record.Value.(map[string]interface{}); ok && kafkaColumnsHavePrefix(columns, "value.") {
		flattenKafkaMap("value", valueMap, row)
	}
	if keyMap, ok := record.Key.(map[string]interface{}); ok && kafkaColumnsHavePrefix(columns, "key.") {
		flattenKafkaMap("key", keyMap, row)
	}
	if len(record.Headers) > 0 && kafkaColumnsHavePrefix(columns, "headers.") {
		flattenKafkaMap("headers", record.Headers, row)
	}
}

// kafkaProjectionNeedsValue 判断投影是否需要 payload：全列、value 或 value.xxx。
func kafkaProjectionNeedsValue(columns []string) bool {
	return len(columns) == 0 || kafkaColumnSelected(columns, "value") || kafkaColumnsHavePrefix(columns, "value.")
}

func kafkaColumnSelected(columns []string, name string) bool {
	for _, column := range columns {
		if column == name {
			return true
		}
	}
	return false
}

func kafkaColumnsHavePrefix(columns []string, prefix string) bool {
	for _, column := range columns {
		if strings.HasPrefix(column, prefix) {
			return true
		}
	}
	return false
}

// projectKafkaRow 只保留请求的列，避免元数据查询把 payload 一并带回。
func projectKafkaRow(row map[string]interface{}, columns []string) map[string]interface{} {
	projected := make(map[string]interface{}, len(columns))
	for _, column := range columns {
		if value, ok := row[column]; ok {
			projected[column] = value
		}
	}
	return projected
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
