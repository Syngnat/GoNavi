package db

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type rabbitmqParsedSQL struct {
	Action string
	VHost  string
	Name   string
	Limit  int
	Offset int
	Count  bool
}

var (
	rabbitmqSQLFromRE          = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))`)
	rabbitmqSQLLimitRE         = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	rabbitmqSQLOffsetRE        = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	rabbitmqShowVHostsRE       = regexp.MustCompile(`(?i)^\s*SHOW\s+VHOSTS(?:\s+LIMIT\s+(\d+))?\s*$`)
	rabbitmqShowQueuesRE       = regexp.MustCompile(`(?i)^\s*SHOW\s+QUEUES(?:\s+LIMIT\s+(\d+))?\s*$`)
	rabbitmqShowExchangesRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+EXCHANGES(?:\s+LIMIT\s+(\d+))?\s*$`)
	rabbitmqDescribeQueueRE    = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+QUEUE\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))\s*$`)
	rabbitmqDescribeExchangeRE = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+EXCHANGE\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))\s*$`)
	rabbitmqConsumeQueueRE     = regexp.MustCompile(`(?i)^\s*CONSUME\s+FROM\s+(?:"([^"]*)"|` + "`" + `([^` + "`" + `]*)` + "`" + `|([^\s;]+))`)
)

func parseRabbitMQSQL(sqlText string) (rabbitmqParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if text == "" {
		return rabbitmqParsedSQL{}, false
	}
	if matches := rabbitmqShowVHostsRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{Action: "show_vhosts", Limit: rabbitmqMatchLimit(matches, 1)}, true
	}
	if matches := rabbitmqShowQueuesRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{Action: "show_queues", Limit: rabbitmqMatchLimit(matches, 1)}, true
	}
	if matches := rabbitmqShowExchangesRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{Action: "show_exchanges", Limit: rabbitmqMatchLimit(matches, 1)}, true
	}
	if matches := rabbitmqDescribeQueueRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{
			Action: "describe_queue",
			Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
		}, true
	}
	if matches := rabbitmqDescribeExchangeRE.FindStringSubmatch(text); len(matches) > 0 {
		return rabbitmqParsedSQL{
			Action: "describe_exchange",
			Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
		}, true
	}
	if matches := rabbitmqConsumeQueueRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := rabbitmqParsedSQL{
			Action: "consume",
			Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
			Limit:  defaultRabbitMQPreviewLimit,
		}
		if limitMatch := rabbitmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
			parsed.Limit, _ = strconv.Atoi(limitMatch[1])
		}
		if offsetMatch := rabbitmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
			parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
		}
		return parsed, true
	}
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return rabbitmqParsedSQL{}, false
	}
	matches := rabbitmqSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return rabbitmqParsedSQL{}, false
	}
	parsed := rabbitmqParsedSQL{
		Action: "select",
		Name:   firstNonEmpty(matches[1], matches[2], matches[3]),
		Limit:  defaultRabbitMQPreviewLimit,
		Count:  strings.Contains(strings.ToLower(text), "count("),
	}
	if limitMatch := rabbitmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
		parsed.Limit, _ = strconv.Atoi(limitMatch[1])
	}
	if offsetMatch := rabbitmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
		parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
	}
	return parsed, true
}

func rabbitmqMatchLimit(matches []string, index int) int {
	if index >= len(matches) || strings.TrimSpace(matches[index]) == "" {
		return 0
	}
	limit, _ := strconv.Atoi(matches[index])
	return limit
}

func rabbitmqVHostRows(items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		row := map[string]interface{}{
			"vhost":   mapString(item, "name"),
			"tracing": rabbitmqBoolAny(item["tracing"]),
		}
		if desc := mapString(item, "description"); desc != "" {
			row["description"] = desc
		}
		if tags := mapString(item, "tags"); tags != "" {
			row["tags"] = tags
		}
		if value := mapString(item, "default_queue_type"); value != "" {
			row["default_queue_type"] = value
		}
		if state, ok := item["cluster_state"].(map[string]interface{}); ok && len(state) > 0 {
			row["cluster_state"] = state
		}
		rows = append(rows, row)
	}
	return rows
}

func rabbitmqQueueRows(items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		rows = append(rows, rabbitmqQueueRow(item))
	}
	return rows
}

func rabbitmqQueueRow(item map[string]interface{}) map[string]interface{} {
	row := map[string]interface{}{
		"vhost":                   mapString(item, "vhost"),
		"queue":                   mapString(item, "name"),
		"durable":                 rabbitmqBoolAny(item["durable"]),
		"auto_delete":             rabbitmqBoolAny(item["auto_delete"]),
		"exclusive":               rabbitmqBoolAny(item["exclusive"]),
		"consumers":               intFromAny(item["consumers"], 0),
		"messages":                intFromAny(item["messages"], 0),
		"messages_ready":          intFromAny(item["messages_ready"], 0),
		"messages_unacknowledged": intFromAny(item["messages_unacknowledged"], 0),
	}
	if node := mapString(item, "node"); node != "" {
		row["node"] = node
	}
	if state := mapString(item, "state"); state != "" {
		row["state"] = state
	}
	if queueType := mapString(item, "type"); queueType != "" {
		row["type"] = queueType
	}
	if args, ok := item["arguments"].(map[string]interface{}); ok && len(args) > 0 {
		row["arguments"] = args
	}
	return row
}

func rabbitmqExchangeRows(items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		rows = append(rows, rabbitmqExchangeRow(item))
	}
	return rows
}

func rabbitmqExchangeRow(item map[string]interface{}) map[string]interface{} {
	name := mapString(item, "name")
	row := map[string]interface{}{
		"vhost":       mapString(item, "vhost"),
		"exchange":    name,
		"durable":     rabbitmqBoolAny(item["durable"]),
		"auto_delete": rabbitmqBoolAny(item["auto_delete"]),
		"internal":    rabbitmqBoolAny(item["internal"]),
	}
	if name == "" {
		row["exchange_display"] = "(default)"
	}
	if exchangeType := mapString(item, "type"); exchangeType != "" {
		row["type"] = exchangeType
	}
	if args, ok := item["arguments"].(map[string]interface{}); ok && len(args) > 0 {
		row["arguments"] = args
	}
	return row
}

func rabbitmqMessageRows(vhost string, queue string, items []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		row := map[string]interface{}{
			"vhost":            vhost,
			"queue":            queue,
			"exchange":         mapString(item, "exchange"),
			"routing_key":      mapString(item, "routing_key"),
			"redelivered":      rabbitmqBoolAny(item["redelivered"]),
			"message_count":    intFromAny(item["message_count"], 0),
			"payload_bytes":    intFromAny(item["payload_bytes"], 0),
			"payload_encoding": mapString(item, "payload_encoding"),
		}
		payload := rabbitmqDecodePayload(item["payload"], row["payload_encoding"])
		if payload != nil {
			row["payload"] = payload
			if payloadMap, ok := payload.(map[string]interface{}); ok {
				flattenRabbitMQMap("payload", payloadMap, row)
			}
		}
		if properties, ok := item["properties"].(map[string]interface{}); ok && len(properties) > 0 {
			row["properties"] = properties
			flattenRabbitMQMap("properties", properties, row)
			if headers, ok := properties["headers"].(map[string]interface{}); ok && len(headers) > 0 {
				row["headers"] = headers
				flattenRabbitMQMap("headers", headers, row)
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func flattenRabbitMQMap(prefix string, values map[string]interface{}, row map[string]interface{}) {
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		name := prefix + "." + key
		row[name] = value
		if nested, ok := value.(map[string]interface{}); ok {
			flattenRabbitMQMap(name, nested, row)
		}
	}
}

func rabbitmqDecodePayload(raw interface{}, encodingValue interface{}) interface{} {
	switch value := raw.(type) {
	case nil:
		return nil
	case string:
		encoding := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", encodingValue)))
		if encoding == "base64" {
			data, err := base64.StdEncoding.DecodeString(value)
			if err == nil {
				var decoded interface{}
				if decodeJSONWithUseNumber(data, &decoded) == nil {
					return decoded
				}
				return bytesToDisplayValue(data, "")
			}
		}
		var decoded interface{}
		if decodeJSONWithUseNumber([]byte(value), &decoded) == nil {
			return decoded
		}
		return value
	default:
		return value
	}
}

func rabbitmqEncodePayload(payload interface{}) (string, string, error) {
	switch typed := payload.(type) {
	case nil:
		return "", "string", nil
	case string:
		return typed, "string", nil
	case []byte:
		return base64.StdEncoding.EncodeToString(typed), "base64", nil
	case json.Number:
		return typed.String(), "string", nil
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", typed), "string", nil
	case map[string]interface{}, []interface{}:
		data, err := json.Marshal(typed)
		if err != nil {
			return "", "", err
		}
		return string(data), "string", nil
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return "", "", err
		}
		return string(data), "string", nil
	}
}

func rabbitmqMapPayload(raw interface{}) (map[string]interface{}, error) {
	if raw == nil {
		return nil, nil
	}
	value, ok := raw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("不是对象")
	}
	return value, nil
}

func rabbitmqBoolValue(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on", "required":
		return true
	default:
		return false
	}
}

func rabbitmqBoolAny(raw interface{}) bool {
	switch value := raw.(type) {
	case bool:
		return value
	case json.Number:
		n, err := value.Int64()
		return err == nil && n != 0
	case float64:
		return value != 0
	case int:
		return value != 0
	case int64:
		return value != 0
	case string:
		return rabbitmqBoolValue(value)
	default:
		return false
	}
}
