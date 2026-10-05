//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	kafka "github.com/segmentio/kafka-go"
)

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
	kafkaShowGroupsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+CONSUMER\s+GROUPS\s*;?\s*$`)
	kafkaDescribeGroupRE = regexp.MustCompile(`(?i)^\s*(?:DESCRIBE|SHOW)\s+CONSUMER\s+GROUP\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))\s*$`)
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
	if kafkaShowGroupsRE.MatchString(text) {
		return kafkaParsedSQL{Action: "show_consumer_groups"}, true
	}
	if matches := kafkaDescribeGroupRE.FindStringSubmatch(text); len(matches) > 0 {
		return kafkaParsedSQL{Action: "describe_consumer_group", GroupID: firstNonEmpty(matches[1], matches[2], matches[3])}, true
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
			Latest:  defaultLatest,
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

func kafkaConsumerGroupRows(groups []kafkaConsumerGroupInfo) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(groups))
	for _, g := range groups {
		rows = append(rows, map[string]interface{}{
			"group": g.GroupID, "state": g.State, "member": g.MemberID, "client_id": g.ClientID, "client_host": g.ClientHost,
			"topic": g.Topic, "partition": kafkaOptionalInt(g.Partition), "current_offset": kafkaOptionalInt64(g.CurrentOffset), "log_end_offset": kafkaOptionalInt64(g.LogEndOffset), "lag": kafkaOptionalInt64(g.Lag),
		})
	}
	return rows
}

func kafkaOptionalInt(value *int) interface{} {
	if value == nil {
		return nil
	}
	return *value
}

func kafkaOptionalInt64(value *int64) interface{} {
	if value == nil {
		return nil
	}
	return *value
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
