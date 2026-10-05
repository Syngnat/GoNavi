package db

import (
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

func normalizeMQTTConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyMQTTURI(config)
	if host, port, ok := parseMQTTBrokerEndpoint(runConfig.Host, runConfig.Port); ok {
		runConfig.Host = host
		runConfig.Port = port
	}
	if strings.TrimSpace(runConfig.Host) == "" && len(runConfig.Hosts) == 0 {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultMQTTPort
	}
	params := mqttConnectionParams(runConfig)
	transport := mqttTransportScheme(runConfig)
	if transport == "ssl" || transport == "wss" || mqttBoolValue(firstNonEmpty(params.Get("ssl"), params.Get("tls"), params.Get("useSSL"), params.Get("use_ssl"))) {
		runConfig.UseSSL = true
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		if mqttBoolValue(firstNonEmpty(params.Get("skip_verify"), params.Get("skipVerify"), params.Get("insecure"))) {
			runConfig.SSLMode = "skip-verify"
		} else {
			runConfig.SSLMode = "required"
		}
	}
	return runConfig
}

func applyMQTTURI(config connection.ConnectionConfig) connection.ConnectionConfig {
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
	case "mqtt", "mqtts", "tcp", "ssl", "tls", "ws", "wss":
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
		host, port, ok := parseHostPortWithDefault(strings.TrimSpace(entry), defaultMQTTPort)
		if !ok {
			continue
		}
		hosts = append(hosts, mqttFormatHostPort(host, port))
	}
	if len(hosts) > 0 {
		host, port, ok := parseHostPortWithDefault(hosts[0], defaultMQTTPort)
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
	if scheme == "ssl" || scheme == "tls" || scheme == "mqtts" || scheme == "wss" {
		config.UseSSL = true
		if strings.TrimSpace(config.SSLMode) == "" {
			config.SSLMode = "required"
		}
	}
	return config
}

func mqttConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "mqtt", "mqtts", "tcp", "ssl", "tls", "ws", "wss"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func mqttDefaultTopic(config connection.ConnectionConfig) string {
	if topic := strings.TrimSpace(config.Database); topic != "" {
		return topic
	}
	params := mqttConnectionParams(config)
	return strings.TrimSpace(firstNonEmpty(params.Get("defaultTopic"), params.Get("default_topic"), params.Get("topic")))
}

func mqttConfiguredTopics(config connection.ConnectionConfig, defaultTopic string) []mqttTopicDescriptor {
	seen := make(map[string]struct{})
	topics := make([]mqttTopicDescriptor, 0, 8)
	appendTopic := func(raw string, isDefault bool, source string) {
		filter := strings.TrimSpace(raw)
		if filter == "" {
			return
		}
		if _, ok := seen[filter]; ok {
			if isDefault {
				for index := range topics {
					if topics[index].Filter == filter {
						topics[index].Default = true
					}
				}
			}
			return
		}
		seen[filter] = struct{}{}
		topics = append(topics, mqttTopicDescriptor{
			Filter:   filter,
			Default:  isDefault,
			Wildcard: strings.ContainsAny(filter, "#+"),
			Source:   source,
		})
	}

	appendTopic(defaultTopic, defaultTopic != "", "default")

	params := mqttConnectionParams(config)
	for _, key := range []string{"topics", "topicFilters", "topic_filters", "subscriptions", "subscription", "subscribe"} {
		for _, value := range params[key] {
			for _, part := range splitMQTTTopicList(value) {
				appendTopic(part, false, key)
			}
		}
	}

	sort.SliceStable(topics, func(i, j int) bool {
		if topics[i].Default != topics[j].Default {
			return topics[i].Default
		}
		return topics[i].Filter < topics[j].Filter
	})
	return topics
}

func splitMQTTTopicList(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\r'
	})
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		if text := strings.TrimSpace(field); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func mqttDefaultQoS(config connection.ConnectionConfig) byte {
	value, err := mqttQoSFromAny(firstNonEmpty(mqttConnectionParams(config).Get("qos"), "0"), 0)
	if err != nil {
		return 0
	}
	return value
}

func mqttDefaultRetain(config connection.ConnectionConfig) bool {
	params := mqttConnectionParams(config)
	return mqttBoolValue(firstNonEmpty(params.Get("retain"), params.Get("retained")))
}

func mqttCleanSession(config connection.ConnectionConfig) bool {
	params := mqttConnectionParams(config)
	value := strings.TrimSpace(firstNonEmpty(params.Get("cleanSession"), params.Get("clean_session")))
	if value == "" {
		return true
	}
	return mqttBoolValue(value)
}

func mqttFetchWait(config connection.ConnectionConfig) time.Duration {
	params := mqttConnectionParams(config)
	for _, key := range []string{"fetchWaitMs", "fetch_wait_ms", "waitMs", "wait_ms"} {
		if value := strings.TrimSpace(params.Get(key)); value != "" {
			if ms, err := strconv.Atoi(value); err == nil && ms > 0 {
				wait := time.Duration(ms) * time.Millisecond
				if wait > maxMQTTFetchWait {
					return maxMQTTFetchWait
				}
				return wait
			}
		}
	}
	for _, key := range []string{"fetchWait", "wait"} {
		if value := strings.TrimSpace(params.Get(key)); value != "" {
			if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
				wait := time.Duration(seconds) * time.Second
				if wait > maxMQTTFetchWait {
					return maxMQTTFetchWait
				}
				return wait
			}
		}
	}
	return defaultMQTTFetchWait
}

func mqttClientID(config connection.ConnectionConfig) string {
	params := mqttConnectionParams(config)
	if clientID := strings.TrimSpace(firstNonEmpty(params.Get("clientId"), params.Get("client_id"))); clientID != "" {
		return clientID
	}
	if id := strings.TrimSpace(config.ID); id != "" {
		return mqttDefaultClientID + "-" + id
	}
	return fmt.Sprintf("%s-%d", mqttDefaultClientID, time.Now().UnixNano())
}

func mqttTransportScheme(config connection.ConnectionConfig) string {
	if parsed, err := url.Parse(strings.TrimSpace(config.URI)); err == nil {
		switch strings.ToLower(strings.TrimSpace(parsed.Scheme)) {
		case "ssl", "tls", "mqtts":
			return "ssl"
		case "wss":
			return "wss"
		case "ws":
			return "ws"
		case "tcp", "mqtt":
			return "tcp"
		}
	}
	params := mqttConnectionParams(config)
	switch strings.ToLower(strings.TrimSpace(firstNonEmpty(params.Get("transport"), params.Get("scheme")))) {
	case "ssl", "tls", "mqtts":
		return "ssl"
	case "wss":
		return "wss"
	case "ws":
		return "ws"
	}
	if config.UseSSL {
		return "ssl"
	}
	return "tcp"
}

func mqttBrokerAddresses(config connection.ConnectionConfig) ([]string, error) {
	hosts := make([]string, 0, 4)
	if host, port, ok := parseMQTTBrokerEndpoint(config.Host, config.Port); ok {
		hosts = append(hosts, mqttFormatHostPort(host, port))
	}
	for _, entry := range config.Hosts {
		host, port, ok := parseMQTTBrokerEndpoint(entry, defaultMQTTPort)
		if !ok {
			continue
		}
		hosts = append(hosts, mqttFormatHostPort(host, port))
	}
	hosts = uniqueStringsPreserveOrder(hosts)
	if len(hosts) == 0 {
		return nil, fmt.Errorf("MQTT 至少需要一个 broker 地址")
	}
	return hosts, nil
}

func parseMQTTBrokerEndpoint(raw string, fallbackPort int) (string, int, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", 0, false
	}
	if fallbackPort <= 0 || fallbackPort > 65535 {
		fallbackPort = defaultMQTTPort
	}

	if schemeEnd := strings.Index(text, "://"); schemeEnd >= 0 {
		scheme := strings.ToLower(strings.TrimSpace(text[:schemeEnd]))
		switch scheme {
		case "mqtt", "tcp":
			text = text[schemeEnd+3:]
		default:
			return "", 0, false
		}
	}
	if authorityEnd := strings.IndexAny(text, "/?#"); authorityEnd >= 0 {
		text = text[:authorityEnd]
	}
	if userInfoEnd := strings.LastIndex(text, "@"); userInfoEnd >= 0 {
		text = text[userInfoEnd+1:]
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", 0, false
	}

	if net.ParseIP(text) != nil {
		return text, fallbackPort, true
	}
	if !strings.HasPrefix(text, "[") && strings.Count(text, ":") > 1 {
		parts := strings.Split(text, ":")
		suffixStart := len(parts)
		for suffixStart > 1 {
			if _, err := strconv.Atoi(strings.TrimSpace(parts[suffixStart-1])); err != nil {
				break
			}
			suffixStart--
		}
		host := strings.TrimSpace(strings.Join(parts[:suffixStart], ":"))
		if suffixStart < len(parts) && host != "" && !strings.Contains(host, ":") {
			port, err := strconv.Atoi(strings.TrimSpace(parts[suffixStart]))
			if err == nil && port > 0 && port <= 65535 {
				return host, port, true
			}
			return host, fallbackPort, true
		}
	}

	host, port, ok := parseHostPortWithDefault(text, fallbackPort)
	if !ok || strings.TrimSpace(host) == "" {
		return "", 0, false
	}
	if port <= 0 || port > 65535 {
		port = fallbackPort
	}
	return strings.TrimSpace(host), port, true
}

func mqttFormatHostPort(host string, port int) string {
	return net.JoinHostPort(strings.TrimSpace(host), strconv.Itoa(port))
}

func mqttForwardBrokersOverSSH(config connection.ConnectionConfig) (connection.ConnectionConfig, []string, []*ssh.LocalForwarder, error) {
	brokers, err := mqttBrokerAddresses(config)
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
		host, port, ok := parseHostPortWithDefault(broker, defaultMQTTPort)
		if !ok {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("解析 MQTT broker 地址失败：%s", broker)
		}
		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, host, port)
		if err != nil {
			return connection.ConnectionConfig{}, nil, nil, fmt.Errorf("创建 MQTT SSH 隧道失败：%w", err)
		}
		forwarders = append(forwarders, forwarder)
		rewritten = append(rewritten, forwarder.LocalAddr)
	}
	cleanupForwarders = false
	return runConfig, rewritten, forwarders, nil
}
