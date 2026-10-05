//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

func normalizeKafkaConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyKafkaURI(config)
	if strings.TrimSpace(runConfig.Host) == "" && len(runConfig.Hosts) == 0 {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultKafkaPort
	}
	if kafkaBoolParam(runConfig, "ssl", "tls", "useSSL", "use_ssl") {
		runConfig.UseSSL = true
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		if kafkaBoolParam(runConfig, "skip_verify", "skipVerify", "insecure") {
			runConfig.SSLMode = "skip-verify"
		} else {
			runConfig.SSLMode = "required"
		}
	}
	return normalizeKafkaSecurityProtocol(runConfig)
}

func applyKafkaURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "kafka" && scheme != "apache-kafka" && scheme != "apache_kafka" {
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
		host, port, ok := parseHostPortWithDefault(strings.TrimSpace(entry), defaultKafkaPort)
		if !ok {
			continue
		}
		hosts = append(hosts, kafkaFormatHostPort(host, port))
	}
	if len(hosts) > 0 {
		host, port, ok := parseHostPortWithDefault(hosts[0], defaultKafkaPort)
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

func kafkaConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "kafka", "apache-kafka", "apache_kafka"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func kafkaBoolParam(config connection.ConnectionConfig, keys ...string) bool {
	params := kafkaConnectionParams(config)
	for _, key := range keys {
		value := strings.ToLower(strings.TrimSpace(params.Get(key)))
		switch value {
		case "1", "true", "yes", "on", "required":
			return true
		}
	}
	return false
}

func kafkaDefaultTopic(config connection.ConnectionConfig) string {
	if topic := strings.TrimSpace(config.Database); topic != "" {
		return topic
	}
	params := kafkaConnectionParams(config)
	return firstNonEmpty(params.Get("topic"), params.Get("defaultTopic"), params.Get("default_topic"))
}

func kafkaDefaultGroupID(config connection.ConnectionConfig) string {
	params := kafkaConnectionParams(config)
	return firstNonEmpty(
		params.Get("groupId"),
		params.Get("group_id"),
		params.Get("consumerGroup"),
		params.Get("consumer_group"),
	)
}

func kafkaDefaultStartLatest(config connection.ConnectionConfig) bool {
	params := kafkaConnectionParams(config)
	value := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		params.Get("startOffset"),
		params.Get("start_offset"),
		params.Get("offsetReset"),
		params.Get("auto.offset.reset"),
	)))
	switch value {
	case "latest", "last", "newest", "end":
		return true
	default:
		return false
	}
}

func kafkaClientID(config connection.ConnectionConfig) string {
	params := kafkaConnectionParams(config)
	return firstNonEmpty(params.Get("clientId"), params.Get("client_id"), kafkaDefaultClientID)
}

func kafkaPreviewReadTimeout(config connection.ConnectionConfig) time.Duration {
	params := kafkaConnectionParams(config)
	if ms, err := strconv.Atoi(strings.TrimSpace(firstNonEmpty(params.Get("readTimeoutMs"), params.Get("fetchWaitMs")))); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return 1500 * time.Millisecond
}

func kafkaResolveTopic(topic string, fallback string) string {
	if text := strings.TrimSpace(topic); text != "" {
		return text
	}
	return strings.TrimSpace(fallback)
}

func kafkaBrokerAddresses(config connection.ConnectionConfig) ([]string, error) {
	candidates := make([]string, 0, len(config.Hosts)+1)
	if host := strings.TrimSpace(config.Host); host != "" {
		port := config.Port
		if port <= 0 {
			port = defaultKafkaPort
		}
		candidates = append(candidates, kafkaFormatHostPort(host, port))
	}
	candidates = append(candidates, config.Hosts...)
	seen := map[string]struct{}{}
	brokers := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		host, port, ok := parseHostPortWithDefault(candidate, defaultKafkaPort)
		if !ok {
			continue
		}
		address := kafkaFormatHostPort(host, port)
		if _, exists := seen[address]; exists {
			continue
		}
		seen[address] = struct{}{}
		brokers = append(brokers, address)
	}
	if len(brokers) == 0 {
		return nil, fmt.Errorf("Kafka 至少需要一个 broker 地址")
	}
	return brokers, nil
}

func kafkaForwardBrokersOverSSH(config connection.ConnectionConfig) (connection.ConnectionConfig, []string, []*ssh.LocalForwarder, error) {
	brokers, err := kafkaBrokerAddresses(config)
	if err != nil {
		return connection.ConnectionConfig{}, nil, nil, err
	}
	runConfig := config
	forwarders := make([]*ssh.LocalForwarder, 0, len(brokers))
	cleanupForwarders := true
	defer func() {
		if !cleanupForwarders {
			return
		}
		for _, forwarder := range forwarders {
			_ = forwarder.Release()
		}
	}()
	rewritten := make([]string, 0, len(brokers))
	for _, broker := range brokers {
		host, port, ok := parseHostPortWithDefault(broker, defaultKafkaPort)
		if !ok {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("解析 Kafka broker 地址失败：%s", broker)
		}
		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, host, port)
		if err != nil {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("创建 Kafka SSH 隧道失败：%w", err)
		}
		forwarders = append(forwarders, forwarder)
		rewritten = append(rewritten, forwarder.LocalAddr)
	}
	cleanupForwarders = false
	return runConfig, rewritten, forwarders, nil
}
