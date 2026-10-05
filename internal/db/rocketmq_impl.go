//go:build gonavi_full_drivers || gonavi_rocketmq_driver

package db

import (
	"context"
	"time"

	"GoNavi-Wails/internal/connection"
)

const (
	defaultRocketMQPort           = 9876
	defaultRocketMQQueryTimeout   = 30 * time.Second
	defaultRocketMQPreviewLimit   = 100
	defaultRocketMQPullBatchSize  = 32
	maxRocketMQPullBatchSize      = 256
	rocketMQSyntheticDatabase     = "topics"
	rocketMQDefaultProducerGroup  = "GoNaviRocketMQProducer"
	rocketMQDefaultConsumerGroup  = "GoNaviRocketMQPreview"
	rocketMQDefaultInstancePrefix = "GoNavi"
)

type rocketmqRuntime interface {
	Close() error
	Ping(ctx context.Context) error
	ListTopics(ctx context.Context, includeSystem bool) ([]rocketmqTopicInfo, error)
	DescribeTopic(ctx context.Context, request rocketmqDescribeRequest) (rocketmqTopicDescription, error)
	FetchMessages(ctx context.Context, request rocketmqFetchRequest) ([]rocketmqMessageRecord, error)
	Publish(ctx context.Context, command rocketmqPublishCommand) (int64, error)
	InspectConsumerGroups(ctx context.Context, groupID string) ([]rocketmqConsumerGroupInfo, error)
}

type rocketmqConsumerGroupInfo struct {
	GroupID       string
	State         string
	MemberID      string
	ClientID      string
	ClientHost    string
	Topic         string
	QueueID       *int
	CurrentOffset *int64
	LogEndOffset  *int64
	Lag           *int64
}

func rocketmqOptionalInt(value *int) interface{} {
	if value == nil {
		return nil
	}
	return *value
}

func rocketmqOptionalInt64(value *int64) interface{} {
	if value == nil {
		return nil
	}
	return *value
}

type rocketmqDescribeRequest struct {
	Topic         string
	ConsumerGroup string
	TagExpression string
	PullBatchSize int
}

type rocketmqTopicInfo struct {
	Name       string
	System     bool
	QueueCount int
}

type rocketmqTopicDescription struct {
	Name                  string
	Namespace             string
	ConsumerGroup         string
	TagExpression         string
	QueueCount            int
	TotalApproximateCount int64
	Queues                []rocketmqTopicQueueInfo
}

type rocketmqTopicQueueInfo struct {
	BrokerName       string
	QueueID          int
	MinOffset        int64
	MaxOffset        int64
	ApproximateCount int64
}

type rocketmqFetchRequest struct {
	Topic         string
	Limit         int
	Offset        int
	ConsumerGroup string
	TagExpression string
	Latest        bool
	PullBatchSize int
}

type rocketmqPublishCommand struct {
	Topic      string
	Payload    interface{}
	Tag        string
	Keys       []string
	DelayLevel int
	Properties map[string]string
}

type rocketmqMessageRecord struct {
	Topic          string
	BrokerName     string
	QueueID        int
	QueueOffset    int64
	MsgID          string
	OffsetMsgID    string
	Tags           string
	Keys           string
	Body           []byte
	Decoded        interface{}
	Encoding       string
	Properties     map[string]string
	BornTimestamp  time.Time
	StoreTimestamp time.Time
	ReconsumeTimes int32
	MinOffset      int64
	MaxOffset      int64
}

type nativeRocketMQRuntime struct {
	config      connection.ConnectionConfig
	nameservers []string
	namespace   string
	timeout     time.Duration
	sendTimeout time.Duration
	// dialContext 来自隧道（SSH/代理），消费组诊断的 broker 管理请求经它拨号。
	dialContext rocketmqDialContextFunc
}

var newRocketMQRuntime = func(config connection.ConnectionConfig) (rocketmqRuntime, error) {
	return newNativeRocketMQRuntime(config)
}
