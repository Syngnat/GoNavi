//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	kafka "github.com/segmentio/kafka-go"
	kafkasasl "github.com/segmentio/kafka-go/sasl"
)

type fakeKafkaRuntime struct {
	listTopicsResult     []kafkaTopicInfo
	describeResult       kafkaTopicDescription
	fetchResult          []kafkaMessageRecord
	publishAffected      int64
	lastDescribeTopic    string
	lastFetchRequest     kafkaFetchRequest
	lastPublishCommand   kafkaPublishCommand
	fetchCount           int
	consumerGroupsResult []kafkaConsumerGroupInfo
	consumerGroupsErr    error
	lastConsumerGroupID  string
}

func TestKafkaRuntimeDoesNotDeriveRequestTimeoutFromConnectionTimeout(t *testing.T) {
	runtime, err := newKafkaGoRuntime(connection.ConnectionConfig{
		Type:    "kafka",
		Host:    "127.0.0.1",
		Port:    9092,
		Timeout: 1,
	})
	if err != nil {
		t.Fatalf("newKafkaGoRuntime: %v", err)
	}
	defer runtime.Close()

	concrete, ok := runtime.(*kafkaGoRuntime)
	if !ok {
		t.Fatalf("runtime type = %T", runtime)
	}
	if concrete.client.Timeout != 0 {
		t.Fatalf("connection timeout leaked into Kafka request timeout: %s", concrete.client.Timeout)
	}
	if concrete.dialer.Timeout != time.Second {
		t.Fatalf("Kafka dial timeout = %s, want 1s", concrete.dialer.Timeout)
	}
}

type kafkaOffsetSeekerRecorder struct {
	firstOffset int64
	lastOffset  int64
	seekOffset  int64
	seekWhence  int
}

func TestKafkaRuntimeRecognizesSASLMechanismAliases(t *testing.T) {
	for _, key := range []string{"mechanism", "saslMechanism", "sasl_mechanism", "sasl", "sasl.mechanism", "sasl.mechanisms", "librdkafka.sasl.mechanism", "librdkafka.sasl.mechanisms"} {
		for _, location := range []string{"uri", "params"} {
			t.Run(key+"/"+location, func(t *testing.T) {
				config := connection.ConnectionConfig{Type: "kafka", URI: "kafka://test-user:test-password@127.0.0.1:9092"}
				params := "librdkafka.security.protocol=SASL_PLAINTEXT&" + key + "=PLAIN"
				if location == "uri" {
					config.URI += "?" + params
				} else {
					config.ConnectionParams = params
				}
				runtime, err := newKafkaGoRuntime(normalizeKafkaConfig(config))
				if err != nil {
					t.Fatal(err)
				}
				defer runtime.Close()
				concrete := runtime.(*kafkaGoRuntime)
				if concrete.transport.TLS != nil || concrete.dialer.TLS != nil {
					t.Fatal("SASL_PLAINTEXT must not enable TLS")
				}
				for _, mechanism := range []kafkasasl.Mechanism{concrete.transport.SASL, concrete.dialer.SASLMechanism} {
					if mechanism == nil {
						t.Fatal("SASL mechanism was silently omitted")
					}
					if mechanism.Name() != "PLAIN" {
						t.Fatalf("mechanism = %s", mechanism.Name())
					}
					_, response, err := mechanism.Start(context.Background())
					if err != nil {
						t.Fatal(err)
					}
					if string(response) != "\x00test-user\x00test-password" {
						t.Fatal("PLAIN credentials not forwarded")
					}
				}
			})
		}
	}
}

func TestKafkaSASLAliasCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, uriParams, params, want string
		wantError                     bool
	}{
		{name: "scram256", params: "librdkafka.sasl.mechanism=SCRAM-SHA-256", want: "SCRAM-SHA-256"},
		{name: "scram512", params: "sasl.mechanisms=SCRAM-SHA-512", want: "SCRAM-SHA-512"},
		{name: "unknown mechanism fails", params: "librdkafka.sasl.mechanism=GSSAPI", wantError: true},
		{name: "no authentication"},
		{name: "explicit none", params: "mechanism=none&librdkafka.sasl.mechanism=PLAIN"},
		{name: "existing alias precedence", params: "mechanism=SCRAM-SHA-256&librdkafka.sasl.mechanism=PLAIN", want: "SCRAM-SHA-256"},
		{name: "params override same URI key", uriParams: "librdkafka.sasl.mechanism=PLAIN", params: "librdkafka.sasl.mechanism=SCRAM-SHA-512", want: "SCRAM-SHA-512"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mechanism, err := kafkaSASLMechanism(connection.ConnectionConfig{
				URI:              "kafka://127.0.0.1:9092?" + tc.uriParams,
				ConnectionParams: tc.params, User: "test-user", Password: "test-password",
			})
			if (err != nil) != tc.wantError {
				t.Fatalf("error = %v, wantError = %v", err, tc.wantError)
			}
			if tc.wantError {
				return
			}
			if tc.want == "" {
				if mechanism != nil {
					t.Fatal("unexpected authentication")
				}
				return
			}
			if mechanism == nil || mechanism.Name() != tc.want {
				t.Fatalf("mechanism = %v, want %s", mechanism, tc.want)
			}
		})
	}
}

func TestKafkaExplicitTLSVerifiesCertificatesByDefault(t *testing.T) {
	for _, protocol := range []string{"SSL", "SASL_SSL"} {
		for _, mode := range []string{"", "preferred", "prefer", "disable", "required", "unexpected", "skip-verify", " INSECURE "} {
			t.Run(protocol+"/"+mode, func(t *testing.T) {
				config := normalizeKafkaConfig(connection.ConnectionConfig{
					Type: "kafka", URI: "kafka://localhost:9092?librdkafka.security.protocol=" + protocol + "&mechanism=plain",
					SSLMode: mode,
				})
				runtime, err := newKafkaGoRuntime(config)
				if err != nil {
					t.Fatal(err)
				}
				defer runtime.Close()
				concrete := runtime.(*kafkaGoRuntime)
				wantSkip := mode == "skip-verify" || mode == " INSECURE "
				if concrete.transport.TLS == nil || concrete.dialer.TLS == nil {
					t.Fatal("explicit TLS protocol did not enable TLS")
				}
				if concrete.transport.TLS.InsecureSkipVerify != wantSkip || concrete.dialer.TLS.InsecureSkipVerify != wantSkip {
					t.Fatalf("certificate verification mismatch: want InsecureSkipVerify=%v", wantSkip)
				}
			})
		}
	}
	legacy := normalizeKafkaConfig(connection.ConnectionConfig{UseSSL: true, SSLMode: "preferred"})
	if legacy.SSLMode != "preferred" {
		t.Fatal("changed legacy TLS configuration without an explicit security protocol")
	}
}

func TestKafkaSecurityProtocols(t *testing.T) {
	for _, protocol := range []string{"PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"} {
		t.Run(protocol, func(t *testing.T) {
			config := normalizeKafkaConfig(connection.ConnectionConfig{Type: "kafka", Host: "localhost", Port: 9092,
				ConnectionParams: "security.protocol=" + protocol + "&mechanism=scram-sha-256", UseSSL: true, SSLMode: "disable", User: "test", Password: "test+pass=="})
			runtime, err := newKafkaGoRuntime(config)
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			concrete := runtime.(*kafkaGoRuntime)
			wantTLS := protocol == "SSL" || protocol == "SASL_SSL"
			wantSASL := strings.HasPrefix(protocol, "SASL_")
			if (concrete.transport.TLS != nil) != wantTLS || (concrete.dialer.TLS != nil) != wantTLS {
				t.Fatal("incorrect TLS configuration")
			}
			if (concrete.transport.SASL != nil) != wantSASL || (concrete.dialer.SASLMechanism != nil) != wantSASL {
				t.Fatal("incorrect SASL configuration")
			}
		})
	}
	for _, params := range []string{"security.protocol=invalid", "security.protocol=SASL_SSL", "security.protocol=SASL_PLAINTEXT&mechanism=none"} {
		if _, err := kafkaSASLMechanism(connection.ConnectionConfig{ConnectionParams: params}); err == nil {
			t.Fatalf("expected error for %s", params)
		}
	}
}

func (s *kafkaOffsetSeekerRecorder) Seek(offset int64, whence int) (int64, error) {
	s.seekOffset = offset
	s.seekWhence = whence
	switch whence {
	case kafka.SeekStart:
		offset += s.firstOffset
	case kafka.SeekAbsolute:
		// offset is already absolute.
	default:
		return 0, kafka.OffsetOutOfRange
	}
	if offset < s.firstOffset || offset > s.lastOffset {
		return 0, kafka.OffsetOutOfRange
	}
	return offset, nil
}

func (f *fakeKafkaRuntime) Close() error { return nil }

func (f *fakeKafkaRuntime) Ping(ctx context.Context) error { return nil }

func (f *fakeKafkaRuntime) ListTopics(ctx context.Context, includeInternal bool) ([]kafkaTopicInfo, error) {
	return append([]kafkaTopicInfo(nil), f.listTopicsResult...), nil
}

func (f *fakeKafkaRuntime) DescribeTopic(ctx context.Context, topic string) (kafkaTopicDescription, error) {
	f.lastDescribeTopic = topic
	return f.describeResult, nil
}

func (f *fakeKafkaRuntime) FetchMessages(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error) {
	f.fetchCount++
	f.lastFetchRequest = request
	return append([]kafkaMessageRecord(nil), f.fetchResult...), nil
}

func (f *fakeKafkaRuntime) Publish(ctx context.Context, command kafkaPublishCommand) (int64, error) {
	f.lastPublishCommand = command
	return f.publishAffected, nil
}
func (f *fakeKafkaRuntime) InspectConsumerGroups(ctx context.Context, groupID string) ([]kafkaConsumerGroupInfo, error) {
	f.lastConsumerGroupID = groupID
	return f.consumerGroupsResult, f.consumerGroupsErr
}

func TestSeekKafkaAbsoluteOffsetUsesAbsoluteKafkaOffset(t *testing.T) {
	seeker := &kafkaOffsetSeekerRecorder{
		firstOffset: 100,
		lastOffset:  150,
	}

	if err := seekKafkaAbsoluteOffset(seeker, 100); err != nil {
		t.Fatalf("seek at retained first offset failed: %v", err)
	}
	if seeker.seekOffset != 100 {
		t.Fatalf("expected absolute offset 100, got %d", seeker.seekOffset)
	}
	if seeker.seekWhence != kafka.SeekAbsolute {
		t.Fatalf("expected kafka.SeekAbsolute, got %d", seeker.seekWhence)
	}
}

func TestNormalizeKafkaConfigParsesURIAndParams(t *testing.T) {
	config := normalizeKafkaConfig(connection.ConnectionConfig{
		URI:              "kafka://alice:secret@127.0.0.1:9092,127.0.0.2:9093/orders.events?topology=cluster&tls=true&skip_verify=true",
		ConnectionParams: "groupId=analytics&mechanism=scram-sha-256",
	})

	if config.Host != "127.0.0.1" || config.Port != 9092 {
		t.Fatalf("unexpected primary broker: %#v", config)
	}
	if !reflect.DeepEqual(config.Hosts, []string{"127.0.0.2:9093"}) {
		t.Fatalf("unexpected extra brokers: %#v", config.Hosts)
	}
	if config.User != "alice" || config.Password != "secret" {
		t.Fatalf("unexpected credentials: %#v", config)
	}
	if config.Database != "orders.events" || config.Topology != "cluster" {
		t.Fatalf("unexpected topic/topology: %#v", config)
	}
	if !config.UseSSL || config.SSLMode != "skip-verify" {
		t.Fatalf("unexpected tls settings: %#v", config)
	}

	params := kafkaConnectionParams(config)
	if params.Get("groupId") != "analytics" || params.Get("mechanism") != "scram-sha-256" {
		t.Fatalf("unexpected kafka params: %#v", params)
	}
}

func TestKafkaQueryShowTopicsAndDescribeTopic(t *testing.T) {
	runtime := &fakeKafkaRuntime{
		listTopicsResult: []kafkaTopicInfo{
			{Name: "logs.app", Partitions: []kafka.Partition{{}, {}}},
			{Name: "orders-events", Partitions: []kafka.Partition{{}}},
		},
		describeResult: kafkaTopicDescription{
			Name: "logs.app",
			Partitions: []kafkaTopicPartition{{
				ID:               0,
				Leader:           kafka.Broker{Host: "127.0.0.1", Port: 9092},
				EarliestOffset:   1,
				LatestOffset:     9,
				ApproximateCount: 8,
			}},
		},
	}
	client := &KafkaDB{runtime: runtime}

	rows, columns, err := client.Query(`SHOW TOPICS LIMIT 1`)
	if err != nil {
		t.Fatalf("SHOW TOPICS failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["topic"] != "logs.app" {
		t.Fatalf("unexpected topic rows: %#v", rows)
	}
	if !containsString(columns, "partition_count") {
		t.Fatalf("expected partition_count column, got %v", columns)
	}

	rows, columns, err = client.Query(`DESCRIBE TOPIC "logs.app"`)
	if err != nil {
		t.Fatalf("DESCRIBE TOPIC failed: %v", err)
	}
	if runtime.lastDescribeTopic != "logs.app" {
		t.Fatalf("expected describe topic logs.app, got %q", runtime.lastDescribeTopic)
	}
	if len(rows) != 1 || rows[0]["leader"] != "127.0.0.1:9092" {
		t.Fatalf("unexpected describe rows: %#v", rows)
	}
	if !containsString(columns, "approximate_count") {
		t.Fatalf("expected approximate_count column, got %v", columns)
	}
}

func TestKafkaQueryConsumerGroupsPreservesUnknownOffsets(t *testing.T) {
	partition := 3
	currentOffset := int64(12)
	logEndOffset := int64(20)
	lag := int64(8)
	runtime := &fakeKafkaRuntime{consumerGroupsResult: []kafkaConsumerGroupInfo{
		{GroupID: "empty-group", State: "Empty"},
		{
			GroupID: "orders", State: "Stable", MemberID: "member-1", ClientID: "consumer-a",
			Topic: "orders.events", Partition: &partition, CurrentOffset: &currentOffset,
			LogEndOffset: &logEndOffset, Lag: &lag,
		},
	}}
	client := &KafkaDB{runtime: runtime}

	rows, columns, err := client.Query(`SHOW CONSUMER GROUPS;`)
	if err != nil {
		t.Fatalf("SHOW CONSUMER GROUPS failed: %v", err)
	}
	if runtime.lastConsumerGroupID != "" {
		t.Fatalf("SHOW CONSUMER GROUPS group ID = %q, want empty", runtime.lastConsumerGroupID)
	}
	if len(rows) != 2 || rows[0]["partition"] != nil || rows[0]["current_offset"] != nil || rows[0]["log_end_offset"] != nil || rows[0]["lag"] != nil {
		t.Fatalf("empty group must keep offsets unknown, got %#v", rows)
	}
	if rows[1]["partition"] != partition || rows[1]["lag"] != lag {
		t.Fatalf("unexpected populated group row: %#v", rows[1])
	}
	for _, name := range []string{"group", "current_offset", "log_end_offset", "lag"} {
		if !containsString(columns, name) {
			t.Fatalf("expected %q column, got %v", name, columns)
		}
	}

	_, _, err = client.Query(`DESCRIBE CONSUMER GROUP "orders"`)
	if err != nil {
		t.Fatalf("DESCRIBE CONSUMER GROUP failed: %v", err)
	}
	if runtime.lastConsumerGroupID != "orders" {
		t.Fatalf("DESCRIBE CONSUMER GROUP group ID = %q, want orders", runtime.lastConsumerGroupID)
	}
}

func TestKafkaQueryConsumerGroupsPropagatesRuntimeError(t *testing.T) {
	runtime := &fakeKafkaRuntime{consumerGroupsErr: errors.New("forbidden")}
	client := &KafkaDB{runtime: runtime}

	if _, _, err := client.Query(`SHOW CONSUMER GROUPS`); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected runtime error to propagate, got %v", err)
	}
}

func TestKafkaQuerySelectAndConsumeKeepTopicNameIntact(t *testing.T) {
	runtime := &fakeKafkaRuntime{
		fetchResult: []kafkaMessageRecord{{
			Message: kafka.Message{
				Topic:         "logs.app-1",
				Partition:     2,
				Offset:        42,
				HighWaterMark: 100,
				Key:           []byte(`{"tenant":"a"}`),
				Value:         []byte(`{"event":"login","meta":{"ip":"127.0.0.1"}}`),
			},
			Key: map[string]interface{}{"tenant": "a"},
			Value: map[string]interface{}{
				"event": "login",
				"meta":  map[string]interface{}{"ip": "127.0.0.1"},
			},
			Headers: map[string]interface{}{"x-trace-id": "trace-1"},
		}},
	}
	client := &KafkaDB{
		runtime:      runtime,
		defaultGroup: "gonavi",
		startLatest:  false,
	}

	rows, columns, err := client.Query(`SELECT * FROM "logs.app-1" LIMIT 5 OFFSET 2`)
	if err != nil {
		t.Fatalf("SELECT failed: %v", err)
	}
	if runtime.lastFetchRequest.Topic != "logs.app-1" || runtime.lastFetchRequest.Limit != 5 || runtime.lastFetchRequest.Offset != 2 {
		t.Fatalf("unexpected select fetch request: %#v", runtime.lastFetchRequest)
	}
	if len(rows) != 1 || rows[0]["value.meta.ip"] != "127.0.0.1" || rows[0]["headers.x-trace-id"] != "trace-1" {
		t.Fatalf("unexpected select rows: %#v", rows)
	}
	if !containsString(columns, "value.meta.ip") || !containsString(columns, "headers.x-trace-id") {
		t.Fatalf("unexpected columns: %v", columns)
	}

	_, _, err = client.Query(`CONSUME FROM "logs.app-1" LIMIT 3`)
	if err != nil {
		t.Fatalf("CONSUME failed: %v", err)
	}
	if runtime.lastFetchRequest.Topic != "logs.app-1" || runtime.lastFetchRequest.GroupID != "gonavi" || runtime.lastFetchRequest.Latest {
		t.Fatalf("unexpected consume request: %#v", runtime.lastFetchRequest)
	}
}

func TestParseKafkaConsumeUsesConfiguredStartOffset(t *testing.T) {
	for _, testCase := range []struct {
		name          string
		defaultLatest bool
	}{
		{name: "earliest", defaultLatest: false},
		{name: "latest", defaultLatest: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, ok := parseKafkaSQL(`CONSUME FROM "orders.events" LIMIT 10`, testCase.defaultLatest)
			if !ok {
				t.Fatal("CONSUME should parse")
			}
			if parsed.Latest != testCase.defaultLatest {
				t.Fatalf("Latest = %v, want configured value %v", parsed.Latest, testCase.defaultLatest)
			}
		})
	}
}

func TestKafkaExecPublishesJSONCommand(t *testing.T) {
	runtime := &fakeKafkaRuntime{publishAffected: 1}
	client := &KafkaDB{runtime: runtime, defaultTopic: "orders.events"}

	affected, err := client.Exec(`{"key":{"tenant":"a"},"value":{"id":1},"headers":{"x-env":"dev"}}`)
	if err != nil {
		t.Fatalf("Exec failed: %v", err)
	}
	if affected != 1 {
		t.Fatalf("unexpected affected rows: %d", affected)
	}
	if runtime.lastPublishCommand.Topic != "orders.events" {
		t.Fatalf("expected default topic publish, got %#v", runtime.lastPublishCommand)
	}
	if valueMap, ok := runtime.lastPublishCommand.Value.(map[string]interface{}); !ok || valueMap["id"] == nil {
		t.Fatalf("unexpected publish value: %#v", runtime.lastPublishCommand.Value)
	}
}

func TestKafkaGetColumnsReturnsStaticFieldsWithoutFetchingMessages(t *testing.T) {
	runtime := &fakeKafkaRuntime{
		fetchResult: []kafkaMessageRecord{{
			Message: kafka.Message{Topic: "orders.events"},
			Value: map[string]interface{}{
				"meta": map[string]interface{}{
					"ip": "127.0.0.1",
				},
			},
			Headers: map[string]interface{}{"x-request-id": "req-1"},
		}},
	}
	client := &KafkaDB{runtime: runtime}

	columns, err := client.GetColumns("topics", "orders.events")
	if err != nil {
		t.Fatalf("GetColumns failed: %v", err)
	}
	if runtime.fetchCount != 0 {
		t.Fatalf("GetColumns must not read Kafka messages, fetches=%d", runtime.fetchCount)
	}
	names := make([]string, 0, len(columns))
	for _, col := range columns {
		names = append(names, col.Name)
	}
	joined := strings.Join(names, ",")
	for _, want := range []string{"topic", "partition", "offset", "value", "headers"} {
		if !containsString(names, want) {
			t.Fatalf("expected Kafka column %q in %s", want, joined)
		}
	}
	for _, unexpected := range []string{"value.meta.ip", "headers.x-request-id"} {
		if containsString(names, unexpected) {
			t.Fatalf("unexpected sample-derived Kafka column %q in %s", unexpected, joined)
		}
	}
}
