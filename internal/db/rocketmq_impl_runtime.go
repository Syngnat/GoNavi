//go:build gonavi_full_drivers || gonavi_rocketmq_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	rocketmqprimitive "github.com/apache/rocketmq-client-go/v2/primitive"
)

func newNativeRocketMQRuntime(config connection.ConnectionConfig) (rocketmqRuntime, error) {
	nameservers, err := rocketmqNameServerAddresses(config)
	if err != nil {
		return nil, err
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &nativeRocketMQRuntime{
		config:      config,
		nameservers: nameservers,
		namespace:   rocketmqNamespace(config),
		timeout:     timeout,
		sendTimeout: rocketmqSendTimeout(config),
	}, nil
}

func (r *nativeRocketMQRuntime) Close() error {
	return nil
}

func (r *nativeRocketMQRuntime) Ping(ctx context.Context) error {
	adminClient, err := r.newAdmin()
	if err != nil {
		return err
	}
	defer adminClient.Close()
	_, err = adminClient.FetchAllTopicList(ctx)
	return err
}

func (r *nativeRocketMQRuntime) ListTopics(ctx context.Context, includeSystem bool) ([]rocketmqTopicInfo, error) {
	adminClient, err := r.newAdmin()
	if err != nil {
		return nil, err
	}
	defer adminClient.Close()

	response, err := adminClient.FetchAllTopicList(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	topics := make([]rocketmqTopicInfo, 0, len(response.TopicList))
	for _, name := range response.TopicList {
		topic := strings.TrimSpace(name)
		if topic == "" {
			continue
		}
		if _, exists := seen[topic]; exists {
			continue
		}
		seen[topic] = struct{}{}
		system := rocketmqIsSystemTopic(topic)
		if system && !includeSystem {
			continue
		}
		queues, err := adminClient.FetchPublishMessageQueues(ctx, topic)
		queueCount := 0
		if err == nil {
			queueCount = len(queues)
		}
		topics = append(topics, rocketmqTopicInfo{
			Name:       topic,
			System:     system,
			QueueCount: queueCount,
		})
	}
	sort.Slice(topics, func(i, j int) bool {
		return topics[i].Name < topics[j].Name
	})
	return topics, nil
}

// InspectConsumerGroups 通过自研的最小 remoting 管理协议客户端（rocketmq_admin.go）
// 读取消费组成员、队列位点与 Lag。groupID 为空时枚举各 broker 登记的全部订阅组，
// 否则只查指定组。纯只读元数据查询，不创建消费组、不提交或重置任何位点。
func (r *nativeRocketMQRuntime) InspectConsumerGroups(ctx context.Context, groupID string) ([]rocketmqConsumerGroupInfo, error) {
	groupID = strings.TrimSpace(groupID)
	gateway := newRocketMQAdminGateway(r.nameservers, r.timeout, r.dialContext)
	brokers, err := gateway.brokerAddresses(ctx)
	if err != nil {
		return nil, fmt.Errorf("RocketMQ 消费组诊断需要读取 broker 集群信息，请检查 NameServer/broker 可达性：%w", err)
	}

	groups := []string{groupID}
	if groupID == "" {
		groups, err = gateway.subscriptionGroups(ctx, brokers)
		if err != nil {
			return nil, err
		}
	}

	infos := make([]rocketmqConsumerGroupInfo, 0)
	failedGroups := 0
	var firstGroupErr error
	for _, group := range groups {
		groupInfos, groupErr := r.inspectRocketMQConsumerGroup(ctx, gateway, brokers, group)
		if groupErr != nil {
			if errors.Is(groupErr, rocketmqAdminErrGroupNotExist) {
				if groupID != "" {
					// 指定组在所有可达 broker 上都不存在：给用户明确原因。
					return nil, fmt.Errorf("RocketMQ 消费组 %s 不存在（请确认消费组名称，或先在 broker 上创建订阅组）：%w", groupID, rocketmqAdminErrGroupNotExist)
				}
				// 全量模式：组在枚举后从所有 broker 上被移除，跳过。
				continue
			}
			if groupID != "" {
				// 指定组查询失败必须给出原因（验收：权限不足/不支持时显示原因）。
				return nil, groupErr
			}
			// 全量扫描时单组失败不阻断其余组：记录日志后继续；
			// 但全部组都失败时应报错而不是退化为静默空结果。
			failedGroups++
			if firstGroupErr == nil {
				firstGroupErr = groupErr
			}
			logger.Warnf("RocketMQ 消费组 %s 诊断失败，已跳过：%v", group, groupErr)
			continue
		}
		infos = append(infos, groupInfos...)
	}
	if len(groups) > 0 && failedGroups == len(groups) && len(infos) == 0 {
		return nil, fmt.Errorf("RocketMQ 消费组诊断全部失败（共 %d 组）：%w", failedGroups, firstGroupErr)
	}
	sortRocketMQConsumerGroupInfos(infos)
	return infos, nil
}

func (r *nativeRocketMQRuntime) inspectRocketMQConsumerGroup(ctx context.Context, gateway *rocketmqAdminGateway, brokers []rocketmqAdminClusterBroker, groupID string) ([]rocketmqConsumerGroupInfo, error) {
	infos := make([]rocketmqConsumerGroupInfo, 0)

	// 成员连接：同一客户端可能同时连多个 broker，按 clientId/clientAddr 去重。
	memberSeen := make(map[string]struct{})
	memberNotExistCount := 0
	for _, broker := range brokers {
		connections, err := gateway.consumerConnections(ctx, broker.Address, groupID)
		if err != nil {
			if errors.Is(err, rocketmqAdminErrGroupNotExist) {
				memberNotExistCount++
				continue
			}
			return nil, fmt.Errorf("RocketMQ 消费组 %s 成员读取失败（可能缺少管理权限或 broker 版本不支持）：%w", groupID, err)
		}
		for _, conn := range connections {
			dedup := conn.ClientID + "\x00" + conn.ClientAddr
			if _, exists := memberSeen[dedup]; exists {
				continue
			}
			memberSeen[dedup] = struct{}{}
			infos = append(infos, rocketmqConsumerGroupInfo{
				GroupID:    groupID,
				ClientID:   conn.ClientID,
				ClientHost: rocketmqClientHost(conn.ClientAddr),
			})
		}
	}

	// 队列位点与 Lag：GET_CONSUME_STATS 一次返回该组全部 topic@queue 的
	// consumerOffset/brokerOffset。
	offsetSeen := make(map[string]struct{})
	statsNotExistCount := 0
	for _, broker := range brokers {
		entries, err := gateway.consumeStats(ctx, broker.Address, groupID)
		if err != nil {
			if errors.Is(err, rocketmqAdminErrGroupNotExist) {
				statsNotExistCount++
				continue
			}
			return nil, fmt.Errorf("RocketMQ 消费组 %s 队列位点读取失败（可能缺少管理权限或 broker 版本不支持）：%w", groupID, err)
		}
		for _, entry := range entries {
			dedup := entry.Topic + "\x00" + strconv.Itoa(entry.QueueID)
			if _, exists := offsetSeen[dedup]; exists {
				continue
			}
			offsetSeen[dedup] = struct{}{}
			queueID := entry.QueueID
			info := rocketmqConsumerGroupInfo{
				GroupID:       groupID,
				Topic:         entry.Topic,
				QueueID:       &queueID,
				CurrentOffset: entry.ConsumerOffset,
			}
			if entry.BrokerOffset != nil {
				logEnd := *entry.BrokerOffset
				info.LogEndOffset = &logEnd
				if entry.ConsumerOffset != nil {
					lag := logEnd - *entry.ConsumerOffset
					if lag < 0 {
						lag = 0
					}
					info.Lag = &lag
				}
			}
			infos = append(infos, info)
		}
	}

	if len(infos) == 0 {
		// 所有 broker 都报告订阅组不存在：明确报错（指定组场景给用户原因）。
		if memberNotExistCount == len(brokers) && statsNotExistCount == len(brokers) && len(brokers) > 0 {
			return nil, rocketmqAdminErrGroupNotExist
		}
		// 组已登记但没有任何在线成员与位点：输出单行说明组存在（与 Kafka 空组行为一致）。
		infos = append(infos, rocketmqConsumerGroupInfo{GroupID: groupID})
	}
	return infos, nil
}

func rocketmqClientHost(clientAddr string) string {
	// GET_CONSUMER_LIST_BY_GROUP 的成员是 "<host>@<pid>" 形式。
	if index := strings.Index(clientAddr, "@"); index > 0 {
		return clientAddr[:index]
	}
	if host, _, err := net.SplitHostPort(clientAddr); err == nil {
		return host
	}
	return clientAddr
}

func sortRocketMQConsumerGroupInfos(infos []rocketmqConsumerGroupInfo) {
	sort.Slice(infos, func(i, j int) bool {
		if infos[i].GroupID != infos[j].GroupID {
			return infos[i].GroupID < infos[j].GroupID
		}
		if infos[i].Topic != infos[j].Topic {
			return infos[i].Topic < infos[j].Topic
		}
		leftQueue, rightQueue := -1, -1
		if infos[i].QueueID != nil {
			leftQueue = *infos[i].QueueID
		}
		if infos[j].QueueID != nil {
			rightQueue = *infos[j].QueueID
		}
		if leftQueue != rightQueue {
			return leftQueue < rightQueue
		}
		return infos[i].ClientID < infos[j].ClientID
	})
}

func (r *nativeRocketMQRuntime) DescribeTopic(ctx context.Context, request rocketmqDescribeRequest) (rocketmqTopicDescription, error) {
	adminClient, err := r.newAdmin()
	if err != nil {
		return rocketmqTopicDescription{}, err
	}
	defer adminClient.Close()

	consumerClient, err := r.newPullConsumer(request.Topic, request.ConsumerGroup, request.TagExpression, request.PullBatchSize)
	if err != nil {
		return rocketmqTopicDescription{}, err
	}
	defer consumerClient.Shutdown()

	return r.describeTopicWithClients(ctx, adminClient, consumerClient, request)
}

func (r *nativeRocketMQRuntime) FetchMessages(ctx context.Context, request rocketmqFetchRequest) ([]rocketmqMessageRecord, error) {
	adminClient, err := r.newAdmin()
	if err != nil {
		return nil, err
	}
	defer adminClient.Close()

	consumerClient, err := r.newPullConsumer(request.Topic, request.ConsumerGroup, request.TagExpression, request.PullBatchSize)
	if err != nil {
		return nil, err
	}
	defer consumerClient.Shutdown()

	description, err := r.describeTopicWithClients(ctx, adminClient, consumerClient, rocketmqDescribeRequest{
		Topic:         request.Topic,
		ConsumerGroup: request.ConsumerGroup,
		TagExpression: request.TagExpression,
		PullBatchSize: request.PullBatchSize,
	})
	if err != nil {
		return nil, err
	}

	limit := request.Limit
	if limit <= 0 {
		limit = defaultRocketMQPreviewLimit
	}
	target := limit + maxInt(request.Offset, 0)
	if target <= 0 {
		target = defaultRocketMQPreviewLimit
	}
	if request.PullBatchSize <= 0 {
		request.PullBatchSize = defaultRocketMQPullBatchSize
	}
	records := make([]rocketmqMessageRecord, 0, target)
	for _, queue := range description.Queues {
		metaQueue := &rocketmqprimitive.MessageQueue{
			Topic:      description.Name,
			BrokerName: queue.BrokerName,
			QueueId:    queue.QueueID,
		}
		items, err := r.fetchQueueMessages(ctx, consumerClient, metaQueue, queue, request, target)
		if err != nil {
			return nil, err
		}
		records = append(records, items...)
	}
	rocketmqSortMessages(records, request.Latest)
	if request.Offset >= len(records) {
		return []rocketmqMessageRecord{}, nil
	}
	records = records[request.Offset:]
	if len(records) > limit {
		records = records[:limit]
	}
	return records, nil
}

func (r *nativeRocketMQRuntime) Publish(ctx context.Context, command rocketmqPublishCommand) (int64, error) {
	topic := strings.TrimSpace(command.Topic)
	if topic == "" {
		return 0, fmt.Errorf("RocketMQ publish 命令缺少 topic")
	}
	payload, err := mqttEncodePayload(command.Payload)
	if err != nil {
		return 0, fmt.Errorf("序列化 RocketMQ payload 失败：%w", err)
	}

	producerClient, err := r.newProducer()
	if err != nil {
		return 0, err
	}
	defer producerClient.Shutdown()

	message := rocketmqprimitive.NewMessage(topic, payload)
	if tag := strings.TrimSpace(command.Tag); tag != "" {
		message.WithTag(tag)
	}
	if len(command.Keys) > 0 {
		message.WithKeys(command.Keys)
	}
	if command.DelayLevel > 0 {
		message.WithDelayTimeLevel(command.DelayLevel)
	}
	if len(command.Properties) > 0 {
		for key, value := range command.Properties {
			if strings.TrimSpace(key) == "" {
				continue
			}
			message.WithProperty(strings.TrimSpace(key), value)
		}
	}

	result, err := producerClient.SendSync(ctx, message)
	if err != nil {
		return 0, err
	}
	if result == nil || result.Status != rocketmqprimitive.SendOK {
		return 0, fmt.Errorf("RocketMQ 发送失败：状态=%v", result)
	}
	return 1, nil
}
