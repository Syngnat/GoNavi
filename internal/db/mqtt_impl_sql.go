package db

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
)

func mqttEncodePayload(payload interface{}) ([]byte, error) {
	switch typed := payload.(type) {
	case nil:
		return []byte{}, nil
	case []byte:
		return typed, nil
	case string:
		return []byte(typed), nil
	default:
		return json.Marshal(typed)
	}
}

func mqttRecordFromMessage(message pahomqtt.Message) mqttMessageRecord {
	decoded, encoding := mqttDecodePayload(message.Payload())
	return mqttMessageRecord{
		Topic:      message.Topic(),
		QoS:        message.Qos(),
		Retained:   message.Retained(),
		Duplicate:  message.Duplicate(),
		MessageID:  message.MessageID(),
		Payload:    append([]byte(nil), message.Payload()...),
		Decoded:    decoded,
		Encoding:   encoding,
		ReceivedAt: time.Now(),
	}
}

func mqttDecodePayload(payload []byte) (interface{}, string) {
	if payload == nil {
		return nil, "text"
	}
	var decoded interface{}
	if err := decodeJSONWithUseNumber(payload, &decoded); err == nil {
		return decoded, "json"
	}
	if utf8.Valid(payload) {
		return string(payload), "text"
	}
	return base64.StdEncoding.EncodeToString(payload), "base64"
}

type mqttParsedSQL struct {
	Action string
	Topic  string
	Limit  int
	Offset int
	Count  bool
	QoS    byte
	HasQoS bool
}

var (
	mqttSQLFromRE       = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
	mqttSQLLimitRE      = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	mqttSQLOffsetRE     = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	mqttSQLQoSRE        = regexp.MustCompile(`(?i)\bQOS\s+(\d+)`)
	mqttShowTopicsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+TOPICS(?:\s+LIMIT\s+(\d+))?\s*;?\s*$`)
	mqttDescribeTopicRE = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+TOPIC\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))\s*;?\s*$`)
	mqttUnsubscribeRE   = regexp.MustCompile(`(?i)^\s*UNSUBSCRIBE\s+FROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;"` + "`" + `]+))\s*;?\s*$`)
	mqttConsumeTopicRE  = regexp.MustCompile(`(?i)^\s*CONSUME\s+FROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
)

func parseMQTTSQL(sqlText string) (mqttParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if text == "" {
		return mqttParsedSQL{}, false
	}
	if matches := mqttShowTopicsRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := mqttParsedSQL{Action: "show_topics"}
		if len(matches) > 1 && strings.TrimSpace(matches[1]) != "" {
			parsed.Limit, _ = strconv.Atoi(matches[1])
		}
		return parsed, true
	}
	if matches := mqttDescribeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		return mqttParsedSQL{
			Action: "describe_topic",
			Topic:  mqttTrimIdentifier(firstNonEmpty(matches[1], matches[2], matches[3])),
		}, true
	}
	if matches := mqttUnsubscribeRE.FindStringSubmatch(text); len(matches) > 0 {
		return mqttParsedSQL{
			Action: "unsubscribe",
			Topic:  mqttTrimIdentifier(firstNonEmpty(matches[1], matches[2], matches[3])),
		}, true
	}
	if matches := mqttConsumeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := mqttParsedSQL{
			Action: "consume",
			Topic:  mqttTrimIdentifier(firstNonEmpty(matches[1], matches[2], matches[3])),
			Limit:  defaultMQTTPreviewLimit,
		}
		if limitMatch := mqttSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
			parsed.Limit, _ = strconv.Atoi(limitMatch[1])
		}
		if offsetMatch := mqttSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
			parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
		}
		if qosMatch := mqttSQLQoSRE.FindStringSubmatch(text); len(qosMatch) > 1 {
			qos, err := strconv.Atoi(qosMatch[1])
			if err != nil || qos < 0 || qos > 2 {
				return mqttParsedSQL{}, false
			}
			parsed.QoS = byte(qos)
			parsed.HasQoS = true
		} else if regexp.MustCompile(`(?i)\bQOS\b`).MatchString(text) {
			return mqttParsedSQL{}, false
		}
		return parsed, true
	}
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return mqttParsedSQL{}, false
	}
	matches := mqttSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return mqttParsedSQL{}, false
	}
	parsed := mqttParsedSQL{
		Action: "select",
		Topic:  mqttTrimIdentifier(firstNonEmpty(matches[1], matches[2], matches[3])),
		Limit:  defaultMQTTPreviewLimit,
		Count:  strings.Contains(strings.ToLower(text), "count("),
	}
	if limitMatch := mqttSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
		parsed.Limit, _ = strconv.Atoi(limitMatch[1])
	}
	if offsetMatch := mqttSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
		parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
	}
	return parsed, true
}

func mqttTrimIdentifier(value string) string {
	return strings.TrimSuffix(strings.TrimSpace(value), ";")
}

func mqttResolveTopic(raw string, fallback string) string {
	return strings.TrimSpace(firstNonEmpty(raw, fallback))
}

func mqttValidatePublishTopic(topic string) error {
	text := strings.TrimSpace(topic)
	if text == "" {
		return fmt.Errorf("MQTT publish 命令缺少 topic")
	}
	if strings.ContainsAny(text, "#+") {
		return fmt.Errorf("MQTT publish topic 不能包含通配符：%s", text)
	}
	return nil
}

func mqttQoSFromAny(value interface{}, fallback byte) (byte, error) {
	if value == nil {
		return fallback, nil
	}
	qosValue := intFromAny(value, int(fallback))
	if qosValue < 0 || qosValue > 2 {
		return 0, fmt.Errorf("MQTT QoS 仅支持 0、1、2")
	}
	return byte(qosValue), nil
}

func mqttBoolFromAny(value interface{}, fallback bool) bool {
	if value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return mqttBoolValue(typed)
	default:
		return mqttBoolValue(fmt.Sprintf("%v", value))
	}
}

func mqttBoolValue(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on", "required":
		return true
	default:
		return false
	}
}

func mqttTopicRows(topics []mqttTopicDescriptor, defaultQoS byte, defaultRetain bool) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(topics))
	for _, topic := range topics {
		rows = append(rows, map[string]interface{}{
			"topic":       topic.Filter,
			"default":     topic.Default,
			"wildcard":    topic.Wildcard,
			"default_qos": int(defaultQoS),
			"retain":      defaultRetain,
			"source":      topic.Source,
		})
	}
	return rows
}

func mqttDescribeTopicRow(topic string, topics []mqttTopicDescriptor, defaultQoS byte, defaultRetain bool, cleanSession bool, fetchWait time.Duration, brokers []string) map[string]interface{} {
	configured := false
	isDefault := false
	wildcard := strings.ContainsAny(topic, "#+")
	source := ""
	for _, entry := range topics {
		if entry.Filter == topic {
			configured = true
			isDefault = entry.Default
			wildcard = entry.Wildcard
			source = entry.Source
			break
		}
	}
	return map[string]interface{}{
		"topic":          topic,
		"configured":     configured,
		"default":        isDefault,
		"wildcard":       wildcard,
		"source":         source,
		"default_qos":    int(defaultQoS),
		"default_retain": defaultRetain,
		"clean_session":  cleanSession,
		"fetch_wait_ms":  fetchWait.Milliseconds(),
		"broker_count":   len(brokers),
		"brokers":        append([]string(nil), brokers...),
	}
}

func mqttMessageRows(records []mqttMessageRecord) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(records))
	for _, record := range records {
		row := map[string]interface{}{
			"stream_offset":    record.StreamOffset,
			"topic":            record.Topic,
			"qos":              int(record.QoS),
			"retained":         record.Retained,
			"duplicate":        record.Duplicate,
			"message_id":       int(record.MessageID),
			"payload":          record.Decoded,
			"payload_encoding": record.Encoding,
			"payload_bytes":    len(record.Payload),
			"received_at":      record.ReceivedAt.Format(time.RFC3339Nano),
		}
		if payloadMap, ok := record.Decoded.(map[string]interface{}); ok {
			flattenMQTTMap("payload", payloadMap, row)
		}
		rows = append(rows, row)
	}
	return rows
}

func flattenMQTTMap(prefix string, values map[string]interface{}, row map[string]interface{}) {
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		name := prefix + "." + key
		row[name] = value
		if nested, ok := value.(map[string]interface{}); ok {
			flattenMQTTMap(name, nested, row)
		}
	}
}

func uniqueStringsPreserveOrder(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		key := strings.TrimSpace(value)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result
}
