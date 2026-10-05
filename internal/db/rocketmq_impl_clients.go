//go:build gonavi_full_drivers || gonavi_rocketmq_driver

package db

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	rocketmq "github.com/apache/rocketmq-client-go/v2"
	rocketmqadmin "github.com/apache/rocketmq-client-go/v2/admin"
	rocketmqconsumer "github.com/apache/rocketmq-client-go/v2/consumer"
	rocketmqprimitive "github.com/apache/rocketmq-client-go/v2/primitive"
	rocketmqproducer "github.com/apache/rocketmq-client-go/v2/producer"
)

func (r *nativeRocketMQRuntime) describeTopicWithClients(ctx context.Context, adminClient rocketmqadmin.Admin, consumerClient rocketmq.PullConsumer, request rocketmqDescribeRequest) (rocketmqTopicDescription, error) {
	topic := strings.TrimSpace(request.Topic)
	if topic == "" {
		return rocketmqTopicDescription{}, fmt.Errorf("RocketMQ topic 不能为空")
	}
	queues, err := adminClient.FetchPublishMessageQueues(ctx, topic)
	if err != nil {
		return rocketmqTopicDescription{}, err
	}
	sort.Slice(queues, func(i, j int) bool {
		if queues[i].BrokerName == queues[j].BrokerName {
			return queues[i].QueueId < queues[j].QueueId
		}
		if queues[i].QueueId == queues[j].QueueId {
			return queues[i].BrokerName < queues[j].BrokerName
		}
		return queues[i].QueueId < queues[j].QueueId
	})

	description := rocketmqTopicDescription{
		Name:          topic,
		Namespace:     r.namespace,
		ConsumerGroup: strings.TrimSpace(request.ConsumerGroup),
		TagExpression: rocketmqNormalizeTagExpression(request.TagExpression),
		QueueCount:    len(queues),
		Queues:        make([]rocketmqTopicQueueInfo, 0, len(queues)),
	}
	for _, queue := range queues {
		info, err := r.inspectQueue(ctx, consumerClient, queue)
		if err != nil {
			return rocketmqTopicDescription{}, err
		}
		description.Queues = append(description.Queues, info)
		description.TotalApproximateCount += info.ApproximateCount
	}
	return description, nil
}

func (r *nativeRocketMQRuntime) inspectQueue(ctx context.Context, consumerClient rocketmq.PullConsumer, queue *rocketmqprimitive.MessageQueue) (rocketmqTopicQueueInfo, error) {
	result, err := consumerClient.PullFrom(ctx, queue, 0, 1)
	if err != nil {
		return rocketmqTopicQueueInfo{}, err
	}
	minOffset := result.MinOffset
	maxOffset := result.MaxOffset
	if result.Status == rocketmqprimitive.PullOffsetIllegal && result.NextBeginOffset > minOffset {
		minOffset = result.NextBeginOffset
	}
	if maxOffset < minOffset {
		maxOffset = minOffset
	}
	return rocketmqTopicQueueInfo{
		BrokerName:       queue.BrokerName,
		QueueID:          queue.QueueId,
		MinOffset:        minOffset,
		MaxOffset:        maxOffset,
		ApproximateCount: maxInt64(0, maxOffset-minOffset),
	}, nil
}

func (r *nativeRocketMQRuntime) fetchQueueMessages(ctx context.Context, consumerClient rocketmq.PullConsumer, queue *rocketmqprimitive.MessageQueue, meta rocketmqTopicQueueInfo, request rocketmqFetchRequest, target int) ([]rocketmqMessageRecord, error) {
	if target <= 0 || meta.MaxOffset <= meta.MinOffset {
		return []rocketmqMessageRecord{}, nil
	}
	startOffset := meta.MinOffset
	if request.Latest {
		startOffset = maxInt64(meta.MinOffset, meta.MaxOffset-int64(target))
	}
	if startOffset >= meta.MaxOffset {
		return []rocketmqMessageRecord{}, nil
	}

	records := make([]rocketmqMessageRecord, 0, target)
	currentOffset := startOffset
	batchSize := request.PullBatchSize
	if batchSize <= 0 {
		batchSize = defaultRocketMQPullBatchSize
	}
	if batchSize > maxRocketMQPullBatchSize {
		batchSize = maxRocketMQPullBatchSize
	}
	for len(records) < target && currentOffset < meta.MaxOffset {
		numbers := batchSize
		if remaining := target - len(records); remaining < numbers {
			numbers = remaining
		}
		if numbers <= 0 {
			break
		}
		result, err := consumerClient.PullFrom(ctx, queue, currentOffset, numbers)
		if err != nil {
			return nil, err
		}
		switch result.Status {
		case rocketmqprimitive.PullFound:
			for _, message := range result.GetMessageExts() {
				records = append(records, rocketmqRecordFromExt(message, queue.BrokerName, queue.QueueId, result.MinOffset, result.MaxOffset))
			}
			if result.NextBeginOffset <= currentOffset {
				return records, nil
			}
			currentOffset = result.NextBeginOffset
		case rocketmqprimitive.PullOffsetIllegal:
			if result.NextBeginOffset <= currentOffset {
				return records, nil
			}
			currentOffset = result.NextBeginOffset
		case rocketmqprimitive.PullNoNewMsg, rocketmqprimitive.PullNoMsgMatched, rocketmqprimitive.PullBrokerTimeout:
			return records, nil
		default:
			return records, nil
		}
	}
	return records, nil
}

func (r *nativeRocketMQRuntime) newAdmin() (rocketmqadmin.Admin, error) {
	options := []rocketmqadmin.AdminOption{
		rocketmqadmin.WithResolver(rocketmqprimitive.NewPassthroughResolver(append([]string(nil), r.nameservers...))),
	}
	if namespace := strings.TrimSpace(r.namespace); namespace != "" {
		options = append(options, rocketmqadmin.WithNamespace(namespace))
	}
	if credentials, ok := rocketmqCredentials(r.config); ok {
		options = append(options, rocketmqadmin.WithCredentials(credentials))
	}
	return rocketmqadmin.NewAdmin(options...)
}

func (r *nativeRocketMQRuntime) newProducer() (rocketmq.Producer, error) {
	group := rocketmqProducerGroup(r.config)
	if group == "" {
		group = fmt.Sprintf("%s-%d", rocketMQDefaultProducerGroup, time.Now().UnixNano())
	}
	options := []rocketmqproducer.Option{
		rocketmqproducer.WithNsResolver(rocketmqprimitive.NewPassthroughResolver(append([]string(nil), r.nameservers...))),
		rocketmqproducer.WithGroupName(group),
		rocketmqproducer.WithInstanceName(fmt.Sprintf("%s-producer-%d", rocketMQDefaultInstancePrefix, time.Now().UnixNano())),
		rocketmqproducer.WithRetry(0),
		rocketmqproducer.WithSendMsgTimeout(r.sendTimeout),
	}
	if namespace := strings.TrimSpace(r.namespace); namespace != "" {
		options = append(options, rocketmqproducer.WithNamespace(namespace))
	}
	if credentials, ok := rocketmqCredentials(r.config); ok {
		options = append(options, rocketmqproducer.WithCredentials(credentials))
	}
	client, err := rocketmq.NewProducer(options...)
	if err != nil {
		return nil, err
	}
	if err := client.Start(); err != nil {
		return nil, err
	}
	return client, nil
}

func (r *nativeRocketMQRuntime) newPullConsumer(topic string, consumerGroup string, tagExpression string, pullBatchSize int) (rocketmq.PullConsumer, error) {
	group := strings.TrimSpace(consumerGroup)
	if group == "" {
		group = fmt.Sprintf("%s-%d", rocketMQDefaultConsumerGroup, time.Now().UnixNano())
	}
	if pullBatchSize <= 0 {
		pullBatchSize = defaultRocketMQPullBatchSize
	}
	if pullBatchSize > maxRocketMQPullBatchSize {
		pullBatchSize = maxRocketMQPullBatchSize
	}
	options := []rocketmqconsumer.Option{
		rocketmqconsumer.WithNsResolver(rocketmqprimitive.NewPassthroughResolver(append([]string(nil), r.nameservers...))),
		rocketmqconsumer.WithGroupName(group),
		rocketmqconsumer.WithInstance(fmt.Sprintf("%s-consumer-%d", rocketMQDefaultInstancePrefix, time.Now().UnixNano())),
		rocketmqconsumer.WithConsumeFromWhere(rocketmqconsumer.ConsumeFromFirstOffset),
		rocketmqconsumer.WithPullBatchSize(int32(pullBatchSize)),
	}
	if namespace := strings.TrimSpace(r.namespace); namespace != "" {
		options = append(options, rocketmqconsumer.WithNamespace(namespace))
	}
	if credentials, ok := rocketmqCredentials(r.config); ok {
		options = append(options, rocketmqconsumer.WithCredentials(credentials))
	}
	client, err := rocketmq.NewPullConsumer(options...)
	if err != nil {
		return nil, err
	}
	selector := rocketmqconsumer.MessageSelector{
		Type:       rocketmqconsumer.TAG,
		Expression: rocketmqNormalizeTagExpression(tagExpression),
	}
	if err := client.Subscribe(strings.TrimSpace(topic), selector); err != nil {
		_ = client.Shutdown()
		return nil, err
	}
	if err := client.Start(); err != nil {
		_ = client.Shutdown()
		return nil, err
	}
	return client, nil
}
