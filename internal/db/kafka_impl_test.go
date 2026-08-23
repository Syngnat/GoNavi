package db

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	kafka "github.com/segmentio/kafka-go"
)

type fakeKafkaRuntime struct {
	listTopicsResult   []kafkaTopicInfo
	describeResult     kafkaTopicDescription
	fetchResult        []kafkaMessageRecord
	publishAffected    int64
	lastDescribeTopic  string
	lastFetchRequest   kafkaFetchRequest
	lastPublishCommand kafkaPublishCommand
	fetchCount         int
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
	if runtime.lastFetchRequest.Topic != "logs.app-1" || runtime.lastFetchRequest.GroupID != "gonavi" || !runtime.lastFetchRequest.Latest {
		t.Fatalf("unexpected consume request: %#v", runtime.lastFetchRequest)
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
