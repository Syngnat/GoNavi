//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"

	kafkasasl "github.com/segmentio/kafka-go/sasl"
	kafkaplain "github.com/segmentio/kafka-go/sasl/plain"
	kafkascram "github.com/segmentio/kafka-go/sasl/scram"
)

func kafkaSASLMechanism(config connection.ConnectionConfig) (kafkasasl.Mechanism, error) {
	params := kafkaConnectionParams(config)
	protocol := strings.ToUpper(strings.TrimSpace(firstNonEmpty(params.Get("security.protocol"), params.Get("librdkafka.security.protocol"))))
	if protocol == "PLAINTEXT" || protocol == "SSL" {
		return nil, nil
	}
	if protocol != "" && protocol != "SASL_PLAINTEXT" && protocol != "SASL_SSL" {
		return nil, fmt.Errorf("unsupported Kafka security protocol: %s", protocol)
	}
	// Keep existing aliases first; accept Java/librdkafka connection strings too.
	mechanism := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		params.Get("mechanism"),
		params.Get("saslMechanism"),
		params.Get("sasl_mechanism"),
		params.Get("sasl"),
		params.Get("sasl.mechanism"),
		params.Get("sasl.mechanisms"),
		params.Get("librdkafka.sasl.mechanism"),
		params.Get("librdkafka.sasl.mechanisms"),
	)))
	if mechanism == "" || mechanism == "none" {
		if strings.HasPrefix(protocol, "SASL_") {
			return nil, fmt.Errorf("kafka SASL mechanism is required for %s", protocol)
		}
		return nil, nil
	}
	username := strings.TrimSpace(config.User)
	password := config.Password
	switch mechanism {
	case "plain", "sasl_plaintext":
		return kafkaplain.Mechanism{Username: username, Password: password}, nil
	case "scram-sha-256", "scram_sha_256", "scram256":
		return kafkascram.Mechanism(kafkascram.SHA256, username, password)
	case "scram-sha-512", "scram_sha_512", "scram512":
		return kafkascram.Mechanism(kafkascram.SHA512, username, password)
	default:
		return nil, fmt.Errorf("unsupported Kafka SASL mechanism: %s", mechanism)
	}
}

func normalizeKafkaSecurityProtocol(config connection.ConnectionConfig) connection.ConnectionConfig {
	params := kafkaConnectionParams(config)
	switch strings.ToUpper(strings.TrimSpace(firstNonEmpty(params.Get("security.protocol"), params.Get("librdkafka.security.protocol")))) {
	case "PLAINTEXT", "SASL_PLAINTEXT":
		config.UseSSL, config.SSLMode = false, "disable"
	case "SSL", "SASL_SSL":
		config.UseSSL = true
		// Explicit TLS protocols verify certificates unless the user opted out.
		if normalizeSSLModeValue(config.SSLMode) == sslModeSkipVerify {
			config.SSLMode = sslModeSkipVerify
		} else {
			config.SSLMode = sslModeRequired
		}
	}
	return config
}
