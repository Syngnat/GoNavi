//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"time"

	"GoNavi-Wails/internal/connection"

	kafka "github.com/segmentio/kafka-go"
)

const (
	defaultKafkaPort         = 9092
	defaultKafkaQueryTimeout = 30 * time.Second
	defaultKafkaPreviewLimit = 100
	kafkaSyntheticDatabase   = "topics"
	kafkaFetchMaxBytes       = 1 << 20
	kafkaDefaultClientID     = "GoNavi"
)

type kafkaRuntime interface {
	Close() error
	Ping(ctx context.Context) error
	ListTopics(ctx context.Context, includeInternal bool) ([]kafkaTopicInfo, error)
	DescribeTopic(ctx context.Context, topic string) (kafkaTopicDescription, error)
	FetchMessages(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error)
	Publish(ctx context.Context, command kafkaPublishCommand) (int64, error)
	InspectConsumerGroups(ctx context.Context, groupID string) ([]kafkaConsumerGroupInfo, error)
}

type kafkaConsumerGroupInfo struct {
	GroupID       string
	State         string
	MemberID      string
	ClientID      string
	ClientHost    string
	Topic         string
	Partition     *int
	CurrentOffset *int64
	LogEndOffset  *int64
	Lag           *int64
}

type kafkaTopicInfo struct {
	Name       string
	Internal   bool
	Partitions []kafka.Partition
}

type kafkaTopicDescription struct {
	Name       string
	Internal   bool
	Partitions []kafkaTopicPartition
}

type kafkaTopicPartition struct {
	ID               int
	Leader           kafka.Broker
	Replicas         []kafka.Broker
	Isr              []kafka.Broker
	OfflineReplicas  []kafka.Broker
	EarliestOffset   int64
	LatestOffset     int64
	ApproximateCount int64
}

type kafkaFetchRequest struct {
	Topic   string
	Limit   int
	Offset  int
	GroupID string
	Latest  bool
}

type kafkaPublishCommand struct {
	Topic   string
	Key     interface{}
	Value   interface{}
	Headers map[string]interface{}
}

type kafkaMessageRecord struct {
	Message kafka.Message
	Key     interface{}
	Value   interface{}
	Headers map[string]interface{}
}

type kafkaGoRuntime struct {
	brokers    []string
	bootstrap  string
	dialer     *kafka.Dialer
	transport  *kafka.Transport
	client     *kafka.Client
	timeout    time.Duration
	readWait   time.Duration
	defaultAck kafka.RequiredAcks
}

var newKafkaRuntime = func(config connection.ConnectionConfig) (kafkaRuntime, error) {
	return newKafkaGoRuntime(config)
}
