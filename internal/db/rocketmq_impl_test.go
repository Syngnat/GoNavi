package db

import (
	"context"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	rocketmqprimitive "github.com/apache/rocketmq-client-go/v2/primitive"
)

type fakeRocketMQRuntime struct {
	listTopicsResult   []rocketmqTopicInfo
	describeResult     rocketmqTopicDescription
	fetchResult        []rocketmqMessageRecord
	publishAffected    int64
	lastDescribe       rocketmqDescribeRequest
	lastFetch          rocketmqFetchRequest
	lastPublish        rocketmqPublishCommand
	fetchCount         int
}

func (f *fakeRocketMQRuntime) Close() error { return nil }

func (f *fakeRocketMQRuntime) Ping(ctx context.Context) error { return nil }

func (f *fakeRocketMQRuntime) ListTopics(ctx context.Context, includeSystem bool) ([]rocketmqTopicInfo, error) {
	result := make([]rocketmqTopicInfo, 0, len(f.listTopicsResult))
	for _, item := range f.listTopicsResult {
		if item.System && !includeSystem {
			continue
		}
		result = append(result, item)
	}
	return result, nil
}

func (f *fakeRocketMQRuntime) DescribeTopic(ctx context.Context, request rocketmqDescribeRequest) (rocketmqTopicDescription, error) {
	f.lastDescribe = request
	return f.describeResult, nil
}

func (f *fakeRocketMQRuntime) FetchMessages(ctx context.Context, request rocketmqFetchRequest) ([]rocketmqMessageRecord, error) {
	f.fetchCount++
	f.lastFetch = request
	items := append([]rocketmqMessageRecord(nil), f.fetchResult...)
	if request.Offset > 0 {
		if request.Offset >= len(items) {
			return []rocketmqMessageRecord{}, nil
		}
		items = items[request.Offset:]
	}
	if request.Limit > 0 && len(items) > request.Limit {
		items = items[:request.Limit]
	}
	return items, nil
}

func (f *fakeRocketMQRuntime) Publish(ctx context.Context, command rocketmqPublishCommand) (int64, error) {
	f.lastPublish = command
	return f.publishAffected, nil
}

func TestNormalizeRocketMQConfigParsesURIAndParams(t *testing.T) {
	config := normalizeRocketMQConfig(connection.ConnectionConfig{
		URI:              "rocketmq://ak:sk@127.0.0.1:9876,127.0.0.2:9877/orders.events?topology=cluster&groupId=preview&namespace=prod&tag=TagA&pullBatchSize=64&startOffset=latest",
		ConnectionParams: "producerGroup=writer&sendTimeoutMs=6000",
	})

	if config.Host != "127.0.0.1" || config.Port != 9876 {
		t.Fatalf("unexpected rocketmq host/port: %#v", config)
	}
	if !reflect.DeepEqual(config.Hosts, []string{"127.0.0.2:9877"}) {
		t.Fatalf("unexpected rocketmq extra nameservers: %#v", config.Hosts)
	}
	if config.User != "ak" || config.Password != "sk" {
		t.Fatalf("unexpected rocketmq credentials: %#v", config)
	}
	if config.Database != "orders.events" || config.Topology != "cluster" {
		t.Fatalf("unexpected rocketmq topic/topology: %#v", config)
	}

	params := rocketmqConnectionParams(config)
	if params.Get("groupId") != "preview" || params.Get("namespace") != "prod" || params.Get("tag") != "TagA" {
		t.Fatalf("unexpected rocketmq params: %#v", params)
	}
	if params.Get("producerGroup") != "writer" || params.Get("sendTimeoutMs") != "6000" {
		t.Fatalf("unexpected rocketmq producer params: %#v", params)
	}
}

func TestRocketMQConnectSupportsNetworkTunnels(t *testing.T) {
	tests := []struct {
		name   string
		config connection.ConnectionConfig
	}{
		{
			name: "SSH",
			config: connection.ConnectionConfig{
				Type:   "rocketmq",
				Host:   "nameserver.internal.test",
				Port:   9876,
				UseSSH: true,
				SSH: connection.SSHConfig{
					Host: "ssh.internal.test",
					Port: 22,
					User: "ssh-user",
				},
			},
		},
		{
			name: "proxy",
			config: connection.ConnectionConfig{
				Type:     "rocketmq",
				Host:     "nameserver.internal.test",
				Port:     9876,
				UseProxy: true,
				Proxy: connection.ProxyConfig{
					Type: "socks5",
					Host: "proxy.internal.test",
					Port: 1080,
				},
			},
		},
		{
			name: "HTTP tunnel",
			config: connection.ConnectionConfig{
				Type:          "rocketmq",
				Host:          "nameserver.internal.test",
				Port:          9876,
				UseHTTPTunnel: true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host: "tunnel.internal.test",
					Port: 8080,
				},
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			var runtimeConfig connection.ConnectionConfig
			originalFactory := newRocketMQRuntime
			originalEnsure := rocketMQEnsureSSHClient
			ensureCalls := 0
			if testCase.config.UseSSH {
				rocketMQEnsureSSHClient = func(config connection.SSHConfig) error {
					ensureCalls++
					if config.Host != testCase.config.SSH.Host || config.Port != testCase.config.SSH.Port {
						t.Fatalf("prepared SSH config = %#v, want %#v", config, testCase.config.SSH)
					}
					return nil
				}
			}
			newRocketMQRuntime = func(config connection.ConnectionConfig) (rocketmqRuntime, error) {
				runtimeConfig = config
				return &fakeRocketMQRuntime{}, nil
			}
			defer func() {
				newRocketMQRuntime = originalFactory
				rocketMQEnsureSSHClient = originalEnsure
			}()

			client := &RocketMQDB{}
			if err := client.Connect(testCase.config); err != nil {
				t.Fatalf("Connect failed: %v", err)
			}

			if runtimeConfig.UseSSH || runtimeConfig.UseProxy || runtimeConfig.UseHTTPTunnel {
				t.Fatalf("runtime received unresolved tunnel config: %#v", runtimeConfig)
			}
			if runtimeConfig.Host != "127.0.0.1" || runtimeConfig.Port <= 0 {
				t.Fatalf("runtime NameServer = %s:%d, want local forwarded address", runtimeConfig.Host, runtimeConfig.Port)
			}
			if testCase.config.UseSSH && ensureCalls != 1 {
				t.Fatalf("SSH client preparation calls = %d, want 1", ensureCalls)
			}
			localAddress := rocketmqFormatHostPort(runtimeConfig.Host, runtimeConfig.Port)
			if err := client.Close(); err != nil {
				t.Fatalf("Close failed: %v", err)
			}
			if conn, err := net.DialTimeout("tcp", localAddress, 50*time.Millisecond); err == nil {
				_ = conn.Close()
				t.Fatalf("RocketMQ tunnel listener still accepts connections after Close: %s", localAddress)
			}
		})
	}
}

func TestRocketMQQueryExecAndColumns(t *testing.T) {
	fakeRuntime := &fakeRocketMQRuntime{
		listTopicsResult: []rocketmqTopicInfo{
			{Name: "orders.events", QueueCount: 2},
			{Name: "%RETRY%preview", System: true, QueueCount: 1},
		},
		describeResult: rocketmqTopicDescription{
			Name:                  "orders.events",
			Namespace:             "prod",
			ConsumerGroup:         "preview",
			TagExpression:         "*",
			QueueCount:            2,
			TotalApproximateCount: 42,
			Queues: []rocketmqTopicQueueInfo{
				{BrokerName: "broker-a", QueueID: 0, MinOffset: 0, MaxOffset: 21, ApproximateCount: 21},
				{BrokerName: "broker-b", QueueID: 1, MinOffset: 0, MaxOffset: 21, ApproximateCount: 21},
			},
		},
		fetchResult: []rocketmqMessageRecord{
			{
				Topic:          "orders.events",
				BrokerName:     "broker-a",
				QueueID:        0,
				QueueOffset:    11,
				MsgID:          "msg-11",
				OffsetMsgID:    "offset-11",
				Tags:           "TagA",
				Keys:           "order-11 tenant-a",
				Decoded:        map[string]interface{}{"event": "created", "meta": map[string]interface{}{"source": "erp"}},
				Encoding:       "json",
				Properties:     map[string]string{"trace": "trace-11"},
				BornTimestamp:  time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC),
				StoreTimestamp: time.Date(2026, 6, 14, 12, 0, 1, 0, time.UTC),
			},
			{
				Topic:          "orders.events",
				BrokerName:     "broker-b",
				QueueID:        1,
				QueueOffset:    12,
				MsgID:          "msg-12",
				OffsetMsgID:    "offset-12",
				Tags:           "TagB",
				Keys:           "order-12",
				Decoded:        "plain-text",
				Encoding:       "text",
				Properties:     map[string]string{"trace": "trace-12"},
				BornTimestamp:  time.Date(2026, 6, 14, 12, 0, 2, 0, time.UTC),
				StoreTimestamp: time.Date(2026, 6, 14, 12, 0, 3, 0, time.UTC),
			},
		},
		publishAffected: 1,
	}

	originalFactory := newRocketMQRuntime
	newRocketMQRuntime = func(config connection.ConnectionConfig) (rocketmqRuntime, error) {
		return fakeRuntime, nil
	}
	defer func() {
		newRocketMQRuntime = originalFactory
	}()

	client := &RocketMQDB{}
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "rocketmq",
		Host:             "127.0.0.1",
		Port:             9876,
		Database:         "orders.events",
		ConnectionParams: "groupId=preview&namespace=prod&pullBatchSize=48&startOffset=latest",
	}); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	defer client.Close()

	rows, columns, err := client.Query(`SHOW TOPICS LIMIT 1`)
	if err != nil {
		t.Fatalf("SHOW TOPICS failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["topic"] != "orders.events" || rows[0]["queue_count"] != 2 {
		t.Fatalf("unexpected rocketmq topic rows: %#v", rows)
	}
	if !containsString(columns, "system_topic") {
		t.Fatalf("expected system_topic column, got %v", columns)
	}

	rows, columns, err = client.Query(`DESCRIBE TOPIC "orders.events"`)
	if err != nil {
		t.Fatalf("DESCRIBE TOPIC failed: %v", err)
	}
	if fakeRuntime.lastDescribe.Topic != "orders.events" || fakeRuntime.lastDescribe.ConsumerGroup != "preview" {
		t.Fatalf("unexpected describe request: %#v", fakeRuntime.lastDescribe)
	}
	if len(rows) != 2 || rows[0]["topic_approximate_count"] != int64(42) {
		t.Fatalf("unexpected rocketmq describe rows: %#v", rows)
	}
	if !containsString(columns, "broker_name") {
		t.Fatalf("expected broker_name column, got %v", columns)
	}

	rows, columns, err = client.Query(`SELECT * FROM "orders.events" LIMIT 1 OFFSET 1`)
	if err != nil {
		t.Fatalf("SELECT topic failed: %v", err)
	}
	if fakeRuntime.lastFetch.Topic != "orders.events" || fakeRuntime.lastFetch.Limit != 1 || fakeRuntime.lastFetch.Offset != 1 || !fakeRuntime.lastFetch.Latest {
		t.Fatalf("unexpected fetch request: %#v", fakeRuntime.lastFetch)
	}
	if len(rows) != 1 || rows[0]["body"] != "plain-text" || rows[0]["properties.trace"] != "trace-12" {
		t.Fatalf("unexpected rocketmq message rows: %#v", rows)
	}
	if !containsString(columns, "body_encoding") || !containsString(columns, "properties.trace") {
		t.Fatalf("unexpected columns: %v", columns)
	}

	rows, columns, err = client.Query(`SELECT COUNT(*) FROM "orders.events"`)
	if err != nil {
		t.Fatalf("COUNT(*) failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["total_approximate_count"] != int64(42) {
		t.Fatalf("unexpected count rows: %#v", rows)
	}
	if !containsString(columns, "queue_count") {
		t.Fatalf("expected queue_count column, got %v", columns)
	}

	affected, err := client.Exec(`{"publish":"orders.events","payload":{"id":1},"tag":"TagA","keys":["order-1","tenant-a"],"delayLevel":3,"properties":{"trace":"trace-1"}}`)
	if err != nil {
		t.Fatalf("RocketMQ publish failed: %v", err)
	}
	if affected != 1 {
		t.Fatalf("unexpected affected rows: %d", affected)
	}
	if fakeRuntime.lastPublish.Topic != "orders.events" || fakeRuntime.lastPublish.Tag != "TagA" || fakeRuntime.lastPublish.DelayLevel != 3 {
		t.Fatalf("unexpected publish command: %#v", fakeRuntime.lastPublish)
	}
	if !reflect.DeepEqual(fakeRuntime.lastPublish.Keys, []string{"order-1", "tenant-a"}) {
		t.Fatalf("unexpected publish keys: %#v", fakeRuntime.lastPublish.Keys)
	}
	if fakeRuntime.lastPublish.Properties["trace"] != "trace-1" {
		t.Fatalf("unexpected publish properties: %#v", fakeRuntime.lastPublish.Properties)
	}

	fakeRuntime.fetchCount = 0
	columnDefs, err := client.GetColumns(rocketMQSyntheticDatabase, "orders.events")
	if err != nil {
		t.Fatalf("GetColumns failed: %v", err)
	}
	if fakeRuntime.fetchCount != 0 {
		t.Fatalf("GetColumns must not read RocketMQ messages, fetches=%d", fakeRuntime.fetchCount)
	}
	names := make([]string, 0, len(columnDefs))
	for _, col := range columnDefs {
		names = append(names, col.Name)
	}
	joined := strings.Join(names, ",")
	for _, want := range []string{"topic", "body", "properties"} {
		if !containsString(names, want) {
			t.Fatalf("expected rocketmq column %q in %s", want, joined)
		}
	}
	for _, unexpected := range []string{"body.meta.source", "properties.trace"} {
		if containsString(names, unexpected) {
			t.Fatalf("unexpected sample-derived RocketMQ column %q in %s", unexpected, joined)
		}
	}

	databases, err := client.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases failed: %v", err)
	}
	if !reflect.DeepEqual(databases, []string{rocketMQSyntheticDatabase}) {
		t.Fatalf("unexpected rocketmq database list: %#v", databases)
	}

	tables, err := client.GetTables(rocketMQSyntheticDatabase)
	if err != nil {
		t.Fatalf("GetTables failed: %v", err)
	}
	if !reflect.DeepEqual(tables, []string{"orders.events"}) {
		t.Fatalf("unexpected rocketmq topic list: %#v", tables)
	}
}

func TestRocketMQCountRejectsTagFilteredConnections(t *testing.T) {
	fakeRuntime := &fakeRocketMQRuntime{}

	originalFactory := newRocketMQRuntime
	newRocketMQRuntime = func(config connection.ConnectionConfig) (rocketmqRuntime, error) {
		return fakeRuntime, nil
	}
	defer func() {
		newRocketMQRuntime = originalFactory
	}()

	client := &RocketMQDB{}
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "rocketmq",
		Host:             "127.0.0.1",
		Port:             9876,
		Database:         "orders.events",
		ConnectionParams: "tag=TagA",
	}); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	defer client.Close()

	if _, _, err := client.Query(`SELECT COUNT(*) FROM "orders.events"`); err == nil || !strings.Contains(err.Error(), "TAG 过滤") {
		t.Fatalf("expected COUNT(*) to be rejected for tag-filtered RocketMQ, got %v", err)
	}
}

func TestRocketMQRecordFromExtUsesPayloadDecoder(t *testing.T) {
	record := rocketmqRecordFromExt(&rocketmqprimitive.MessageExt{
		Message: rocketmqprimitive.Message{
			Topic: "orders.events",
			Body:  []byte(`{"id":1}`),
		},
		MsgId:          "msg-1",
		OffsetMsgId:    "offset-1",
		QueueOffset:    2,
		BornTimestamp:  time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC).UnixMilli(),
		StoreTimestamp: time.Date(2026, 6, 14, 12, 0, 1, 0, time.UTC).UnixMilli(),
	}, "broker-a", 1, 0, 3)

	if record.Encoding != "json" {
		t.Fatalf("expected json encoding, got %#v", record)
	}
	if body, ok := record.Decoded.(map[string]interface{}); !ok || body["id"] == nil {
		t.Fatalf("unexpected decoded body: %#v", record.Decoded)
	}
}
