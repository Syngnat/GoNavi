//go:build gonavi_full_drivers || gonavi_rocketmq_driver

package db

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"

	rocketmqprimitive "github.com/apache/rocketmq-client-go/v2/primitive"
)

func normalizeRocketMQConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyRocketMQURI(config)
	if strings.TrimSpace(runConfig.Host) == "" && len(runConfig.Hosts) == 0 {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultRocketMQPort
	}
	return runConfig
}

func applyRocketMQURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	switch scheme {
	case "rocketmq", "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq":
	default:
		return config
	}
	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}
	hosts := make([]string, 0, 4)
	for _, entry := range strings.Split(strings.TrimSpace(parsed.Host), ",") {
		host, port, ok := parseHostPortWithDefault(strings.TrimSpace(entry), defaultRocketMQPort)
		if !ok {
			continue
		}
		hosts = append(hosts, rocketmqFormatHostPort(host, port))
	}
	if len(hosts) > 0 {
		host, port, ok := parseHostPortWithDefault(hosts[0], defaultRocketMQPort)
		if ok {
			config.Host = host
			config.Port = port
		}
		if len(hosts) > 1 {
			config.Hosts = append([]string(nil), hosts[1:]...)
		}
	}
	if topic := strings.Trim(strings.TrimSpace(parsed.Path), "/"); topic != "" && strings.TrimSpace(config.Database) == "" {
		config.Database = topic
	}
	params := parsed.Query()
	if strings.TrimSpace(config.Topology) == "" {
		if topology := strings.ToLower(strings.TrimSpace(firstNonEmpty(params.Get("topology"), params.Get("mode")))); topology != "" {
			config.Topology = topology
		} else if len(hosts) > 1 {
			config.Topology = "cluster"
		}
	}
	return config
}

func rocketmqConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "rocketmq", "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func rocketmqDefaultTopic(config connection.ConnectionConfig) string {
	if topic := strings.TrimSpace(config.Database); topic != "" {
		return topic
	}
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(params.Get("topic"), params.Get("defaultTopic"), params.Get("default_topic"))
}

func rocketmqConfiguredConsumerGroup(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(
		params.Get("groupId"),
		params.Get("group_id"),
		params.Get("consumerGroup"),
		params.Get("consumer_group"),
	)
}

func rocketmqProducerGroup(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(params.Get("producerGroup"), params.Get("producer_group"))
}

func rocketmqConfiguredTagExpression(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(
		params.Get("tag"),
		params.Get("tags"),
		params.Get("tagExpression"),
		params.Get("tag_expression"),
		params.Get("selector"),
		params.Get("selectorExpression"),
		params.Get("selector_expression"),
	)
}

func rocketmqTagExpressionIsDefault(value string) bool {
	text := strings.TrimSpace(value)
	return text == "" || text == "*" || strings.EqualFold(text, "all")
}

func rocketmqNormalizeTagExpression(value string) string {
	text := strings.TrimSpace(value)
	if rocketmqTagExpressionIsDefault(text) {
		return "*"
	}
	return text
}

func rocketmqNamespace(config connection.ConnectionConfig) string {
	params := rocketmqConnectionParams(config)
	return firstNonEmpty(params.Get("namespace"), params.Get("ns"))
}

func rocketmqDefaultStartLatest(config connection.ConnectionConfig) bool {
	params := rocketmqConnectionParams(config)
	value := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		params.Get("startOffset"),
		params.Get("start_offset"),
		params.Get("consumeFrom"),
		params.Get("consume_from"),
	)))
	switch value {
	case "latest", "last", "newest", "end", "tail":
		return true
	default:
		return false
	}
}

func rocketmqPullBatchSize(config connection.ConnectionConfig) int {
	params := rocketmqConnectionParams(config)
	value := strings.TrimSpace(firstNonEmpty(params.Get("pullBatchSize"), params.Get("pull_batch_size")))
	if size, err := strconv.Atoi(value); err == nil && size > 0 {
		if size > maxRocketMQPullBatchSize {
			return maxRocketMQPullBatchSize
		}
		return size
	}
	return defaultRocketMQPullBatchSize
}

func rocketmqSendTimeout(config connection.ConnectionConfig) time.Duration {
	params := rocketmqConnectionParams(config)
	value := strings.TrimSpace(firstNonEmpty(params.Get("sendTimeoutMs"), params.Get("send_timeout_ms")))
	if ms, err := strconv.Atoi(value); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return timeout
}

func rocketmqCredentials(config connection.ConnectionConfig) (rocketmqprimitive.Credentials, bool) {
	params := rocketmqConnectionParams(config)
	accessKey := strings.TrimSpace(firstNonEmpty(config.User, params.Get("accessKey"), params.Get("access_key")))
	secretKey := strings.TrimSpace(firstNonEmpty(config.Password, params.Get("secretKey"), params.Get("secret_key")))
	securityToken := strings.TrimSpace(firstNonEmpty(params.Get("securityToken"), params.Get("security_token")))
	credentials := rocketmqprimitive.Credentials{
		AccessKey:     accessKey,
		SecretKey:     secretKey,
		SecurityToken: securityToken,
	}
	if credentials.IsEmpty() {
		return rocketmqprimitive.Credentials{}, false
	}
	return credentials, true
}

func rocketmqNameServerAddresses(config connection.ConnectionConfig) ([]string, error) {
	candidates := make([]string, 0, len(config.Hosts)+1)
	if host := strings.TrimSpace(config.Host); host != "" {
		port := config.Port
		if port <= 0 {
			port = defaultRocketMQPort
		}
		candidates = append(candidates, rocketmqFormatHostPort(host, port))
	}
	candidates = append(candidates, config.Hosts...)
	seen := map[string]struct{}{}
	nameservers := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		host, port, ok := parseHostPortWithDefault(candidate, defaultRocketMQPort)
		if !ok {
			continue
		}
		address := rocketmqFormatHostPort(host, port)
		if _, exists := seen[address]; exists {
			continue
		}
		seen[address] = struct{}{}
		nameservers = append(nameservers, address)
	}
	if len(nameservers) == 0 {
		return nil, fmt.Errorf("RocketMQ 至少需要一个 NameServer 地址")
	}
	return nameservers, nil
}

func rocketmqFormatHostPort(host string, port int) string {
	h := strings.TrimSpace(host)
	if strings.Contains(h, ":") && !strings.HasPrefix(h, "[") {
		return fmt.Sprintf("[%s]:%d", h, port)
	}
	return fmt.Sprintf("%s:%d", h, port)
}

func rocketmqResolveTopic(topic string, fallback string) string {
	if text := strings.TrimSpace(topic); text != "" {
		return text
	}
	return strings.TrimSpace(fallback)
}

func rocketmqIsSystemTopic(topic string) bool {
	name := strings.TrimSpace(topic)
	if name == "" {
		return false
	}
	switch {
	case strings.HasPrefix(name, "%RETRY%"),
		strings.HasPrefix(name, "%DLQ%"),
		strings.HasPrefix(name, "rmq_sys_"),
		strings.HasPrefix(name, "CID_RMQ_SYS_"):
		return true
	}
	switch name {
	case "TBW102", "SELF_TEST_TOPIC", "OFFSET_MOVED_EVENT", "SCHEDULE_TOPIC_XXXX", "RMQ_SYS_TRANS_HALF_TOPIC", "RMQ_SYS_TRACE_TOPIC", "TRANS_CHECK_MAX_TIME_TOPIC", "BenchmarkTest":
		return true
	default:
		return false
	}
}

func rocketmqKeysFromAny(value interface{}) ([]string, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		return rocketmqSplitKeys(typed), nil
	case []string:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(item); text != "" {
				result = append(result, text)
			}
		}
		return result, nil
	case []interface{}:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(fmt.Sprintf("%v", item))
			if text != "" {
				result = append(result, text)
			}
		}
		return result, nil
	default:
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			return nil, nil
		}
		return rocketmqSplitKeys(text), nil
	}
}

func rocketmqSplitKeys(text string) []string {
	parts := strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == ';' || r == '|' || r == '\n' || r == '\r' || r == '\t' || r == ' ' || r == '，'
	})
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if normalized := strings.TrimSpace(part); normalized != "" {
			result = append(result, normalized)
		}
	}
	return result
}

func rocketmqPropertiesFromAny(value interface{}) (map[string]string, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case map[string]string:
		result := make(map[string]string, len(typed))
		for key, item := range typed {
			if strings.TrimSpace(key) != "" {
				result[strings.TrimSpace(key)] = item
			}
		}
		return result, nil
	case map[string]interface{}:
		result := make(map[string]string, len(typed))
		for key, item := range typed {
			normalizedKey := strings.TrimSpace(key)
			if normalizedKey == "" {
				continue
			}
			switch casted := item.(type) {
			case string:
				result[normalizedKey] = casted
			default:
				payload, err := json.Marshal(casted)
				if err != nil {
					return nil, fmt.Errorf("RocketMQ properties 字段 %q 无法序列化：%w", normalizedKey, err)
				}
				result[normalizedKey] = string(payload)
			}
		}
		return result, nil
	default:
		return nil, fmt.Errorf("RocketMQ properties 必须是 JSON 对象")
	}
}

func rocketmqDelayLevelFromAny(value interface{}) (int, error) {
	switch typed := value.(type) {
	case nil:
		return 0, nil
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
		}
		return rocketmqNormalizeDelayLevel(int(n))
	case float64:
		return rocketmqNormalizeDelayLevel(int(typed))
	case int:
		return rocketmqNormalizeDelayLevel(typed)
	case int64:
		return rocketmqNormalizeDelayLevel(int(typed))
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0, nil
		}
		n, err := strconv.Atoi(text)
		if err != nil {
			return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
		}
		return rocketmqNormalizeDelayLevel(n)
	default:
		return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
	}
}

func rocketmqNormalizeDelayLevel(value int) (int, error) {
	if value < 0 {
		return 0, fmt.Errorf("RocketMQ delayLevel 必须是正整数")
	}
	return value, nil
}

func rocketmqRecordFromExt(message *rocketmqprimitive.MessageExt, brokerName string, queueID int, minOffset int64, maxOffset int64) rocketmqMessageRecord {
	if message == nil {
		return rocketmqMessageRecord{
			BrokerName: brokerName,
			QueueID:    queueID,
			MinOffset:  minOffset,
			MaxOffset:  maxOffset,
		}
	}
	decoded, encoding := mqttDecodePayload(message.Body)
	embeddedBroker := ""
	if message.Queue != nil {
		embeddedBroker = message.Queue.BrokerName
	}
	return rocketmqMessageRecord{
		Topic:          message.Topic,
		BrokerName:     firstNonEmpty(brokerName, embeddedBroker),
		QueueID:        queueID,
		QueueOffset:    message.QueueOffset,
		MsgID:          message.MsgId,
		OffsetMsgID:    message.OffsetMsgId,
		Tags:           message.GetTags(),
		Keys:           message.GetKeys(),
		Body:           append([]byte(nil), message.Body...),
		Decoded:        decoded,
		Encoding:       encoding,
		Properties:     message.GetProperties(),
		BornTimestamp:  time.UnixMilli(message.BornTimestamp),
		StoreTimestamp: time.UnixMilli(message.StoreTimestamp),
		ReconsumeTimes: message.ReconsumeTimes,
		MinOffset:      minOffset,
		MaxOffset:      maxOffset,
	}
}
