//go:build gonavi_full_drivers || gonavi_rocketmq_driver

package db

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func parseRocketMQSQL(sqlText string, defaultLatest bool) (rocketmqParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if text == "" {
		return rocketmqParsedSQL{}, false
	}
	if matches := rocketmqShowTopicsRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := rocketmqParsedSQL{Action: "show_topics"}
		if len(matches) > 1 && strings.TrimSpace(matches[1]) != "" {
			parsed.Limit, _ = strconv.Atoi(matches[1])
		}
		return parsed, true
	}
	if rocketmqShowGroupsRE.MatchString(text) {
		return rocketmqParsedSQL{Action: "show_consumer_groups"}, true
	}
	if matches := rocketmqDescribeGroupRE.FindStringSubmatch(text); len(matches) > 0 {
		return rocketmqParsedSQL{Action: "describe_consumer_group", GroupID: firstNonEmpty(matches[1], matches[2], matches[3])}, true
	}
	if matches := rocketmqDescribeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		return rocketmqParsedSQL{
			Action: "describe_topic",
			Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
		}, true
	}
	if matches := rocketmqConsumeTopicRE.FindStringSubmatch(text); len(matches) > 0 {
		parsed := rocketmqParsedSQL{
			Action: "consume",
			Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
			Limit:  defaultRocketMQPreviewLimit,
			Latest: defaultLatest,
		}
		if limitMatch := rocketmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
			parsed.Limit, _ = strconv.Atoi(limitMatch[1])
		}
		if offsetMatch := rocketmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
			parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
		}
		return parsed, true
	}
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return rocketmqParsedSQL{}, false
	}
	matches := rocketmqSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return rocketmqParsedSQL{}, false
	}
	parsed := rocketmqParsedSQL{
		Action: "select",
		Topic:  firstNonEmpty(matches[1], matches[2], matches[3]),
		Limit:  defaultRocketMQPreviewLimit,
		Count:  strings.Contains(strings.ToLower(text), "count("),
		Latest: defaultLatest,
	}
	if limitMatch := rocketmqSQLLimitRE.FindStringSubmatch(text); len(limitMatch) > 1 {
		parsed.Limit, _ = strconv.Atoi(limitMatch[1])
	}
	if offsetMatch := rocketmqSQLOffsetRE.FindStringSubmatch(text); len(offsetMatch) > 1 {
		parsed.Offset, _ = strconv.Atoi(offsetMatch[1])
	}
	return parsed, true
}

type rocketmqParsedSQL struct {
	Action  string
	Topic   string
	GroupID string
	Limit   int
	Offset  int
	Count   bool
	Latest  bool
}

var (
	rocketmqSQLFromRE       = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
	rocketmqSQLLimitRE      = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
	rocketmqSQLOffsetRE     = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	rocketmqShowTopicsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+TOPICS(?:\s+LIMIT\s+(\d+))?\s*;?\s*$`)
	rocketmqShowGroupsRE    = regexp.MustCompile(`(?i)^\s*SHOW\s+CONSUMER\s+GROUPS\s*;?\s*$`)
	rocketmqDescribeGroupRE = regexp.MustCompile(`(?i)^\s*(?:DESCRIBE|SHOW)\s+CONSUMER\s+GROUP\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))\s*;?\s*$`)
	rocketmqDescribeTopicRE = regexp.MustCompile(`(?i)^\s*(?:SHOW|DESCRIBE)\s+TOPIC\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))\s*;?\s*$`)
	rocketmqConsumeTopicRE  = regexp.MustCompile(`(?i)^\s*CONSUME\s+FROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([^\s;]+))`)
)

func rocketmqConsumerGroupRows(groups []rocketmqConsumerGroupInfo) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(groups))
	for _, g := range groups {
		rows = append(rows, map[string]interface{}{
			"group": g.GroupID, "state": g.State, "member": g.MemberID, "client_id": g.ClientID, "client_host": g.ClientHost,
			"topic": g.Topic, "queue_id": rocketmqOptionalInt(g.QueueID), "current_offset": rocketmqOptionalInt64(g.CurrentOffset), "log_end_offset": rocketmqOptionalInt64(g.LogEndOffset), "lag": rocketmqOptionalInt64(g.Lag),
		})
	}
	return rows
}

func rocketmqTopicRows(topics []rocketmqTopicInfo) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(topics))
	for _, topic := range topics {
		rows = append(rows, map[string]interface{}{
			"topic":        topic.Name,
			"system_topic": topic.System,
			"queue_count":  topic.QueueCount,
		})
	}
	return rows
}

func rocketmqDescribeRows(description rocketmqTopicDescription) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(description.Queues))
	for _, queue := range description.Queues {
		rows = append(rows, map[string]interface{}{
			"topic":                   description.Name,
			"namespace":               description.Namespace,
			"consumer_group":          description.ConsumerGroup,
			"tag_expression":          description.TagExpression,
			"queue_count":             description.QueueCount,
			"topic_approximate_count": description.TotalApproximateCount,
			"broker_name":             queue.BrokerName,
			"queue_id":                queue.QueueID,
			"min_offset":              queue.MinOffset,
			"max_offset":              queue.MaxOffset,
			"approximate_count":       queue.ApproximateCount,
		})
	}
	if len(rows) == 0 {
		rows = append(rows, map[string]interface{}{
			"topic":                   description.Name,
			"namespace":               description.Namespace,
			"consumer_group":          description.ConsumerGroup,
			"tag_expression":          description.TagExpression,
			"queue_count":             0,
			"topic_approximate_count": 0,
		})
	}
	return rows
}

func rocketmqMessageRows(records []rocketmqMessageRecord) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(records))
	for _, record := range records {
		row := map[string]interface{}{
			"topic":           record.Topic,
			"broker_name":     record.BrokerName,
			"queue_id":        record.QueueID,
			"queue_offset":    record.QueueOffset,
			"msg_id":          record.MsgID,
			"offset_msg_id":   record.OffsetMsgID,
			"tags":            record.Tags,
			"keys":            record.Keys,
			"born_timestamp":  record.BornTimestamp,
			"store_timestamp": record.StoreTimestamp,
			"reconsume_times": record.ReconsumeTimes,
			"body":            record.Decoded,
			"body_encoding":   record.Encoding,
			"properties":      record.Properties,
			"min_offset":      record.MinOffset,
			"max_offset":      record.MaxOffset,
		}
		if payloadMap, ok := record.Decoded.(map[string]interface{}); ok {
			flattenRocketMQMap("body", payloadMap, row)
		}
		if len(record.Properties) > 0 {
			for key, value := range record.Properties {
				if strings.TrimSpace(key) == "" {
					continue
				}
				row["properties."+key] = value
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func flattenRocketMQMap(prefix string, values map[string]interface{}, row map[string]interface{}) {
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		name := prefix + "." + key
		row[name] = value
		if nested, ok := value.(map[string]interface{}); ok {
			flattenRocketMQMap(name, nested, row)
		}
	}
}

func rocketmqSortMessages(records []rocketmqMessageRecord, latest bool) {
	sort.Slice(records, func(i, j int) bool {
		left := records[i]
		right := records[j]
		switch {
		case left.StoreTimestamp.Equal(right.StoreTimestamp):
			if left.QueueOffset == right.QueueOffset {
				if left.QueueID == right.QueueID {
					return left.BrokerName < right.BrokerName
				}
				if latest {
					return left.QueueID > right.QueueID
				}
				return left.QueueID < right.QueueID
			}
			if latest {
				return left.QueueOffset > right.QueueOffset
			}
			return left.QueueOffset < right.QueueOffset
		case latest:
			return left.StoreTimestamp.After(right.StoreTimestamp)
		default:
			return left.StoreTimestamp.Before(right.StoreTimestamp)
		}
	})
}
