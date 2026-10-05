//go:build gonavi_full_drivers || gonavi_kafka_driver

package db

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"

	kafka "github.com/segmentio/kafka-go"
)

func newKafkaGoRuntime(config connection.ConnectionConfig) (kafkaRuntime, error) {
	brokers, err := kafkaBrokerAddresses(config)
	if err != nil {
		return nil, err
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}
	mechanism, err := kafkaSASLMechanism(config)
	if err != nil {
		return nil, err
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	baseDialer := &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
		DualStack: true,
	}
	dialFunc := baseDialer.DialContext
	if config.UseProxy {
		proxyConfig := config.Proxy
		dialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
			return proxytunnel.DialContext(ctx, proxyConfig, network, address)
		}
	}

	dialer := &kafka.Dialer{
		ClientID:      kafkaClientID(config),
		Timeout:       timeout,
		KeepAlive:     30 * time.Second,
		DualStack:     true,
		DialFunc:      dialFunc,
		TLS:           tlsConfig,
		SASLMechanism: mechanism,
	}
	transport := &kafka.Transport{
		Dial:        dialFunc,
		DialTimeout: timeout,
		ClientID:    kafkaClientID(config),
		TLS:         tlsConfig,
		SASL:        mechanism,
	}
	client := &kafka.Client{
		Addr: kafka.TCP(brokers...),
		// Client.Timeout is a per-request deadline. Keep it unset so the
		// caller's context (including an explicit queryTimeout) owns it.
		Timeout:   0,
		Transport: transport,
	}
	return &kafkaGoRuntime{
		brokers:    brokers,
		bootstrap:  brokers[0],
		dialer:     dialer,
		transport:  transport,
		client:     client,
		timeout:    timeout,
		readWait:   kafkaPreviewReadTimeout(config),
		defaultAck: kafka.RequireAll,
	}, nil
}

func (r *kafkaGoRuntime) Close() error {
	if r.transport != nil {
		r.transport.CloseIdleConnections()
	}
	return nil
}

func (r *kafkaGoRuntime) Ping(ctx context.Context) error {
	if r.client == nil {
		return fmt.Errorf("连接未打开")
	}
	_, err := r.client.Metadata(ctx, &kafka.MetadataRequest{Addr: kafka.TCP(r.bootstrap)})
	return err
}

func (r *kafkaGoRuntime) ListTopics(ctx context.Context, includeInternal bool) ([]kafkaTopicInfo, error) {
	if r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	resp, err := r.client.Metadata(ctx, &kafka.MetadataRequest{Addr: kafka.TCP(r.bootstrap)})
	if err != nil {
		return nil, err
	}
	topics := make([]kafkaTopicInfo, 0, len(resp.Topics))
	for _, topic := range resp.Topics {
		if topic.Error != nil {
			continue
		}
		if !includeInternal && topic.Internal {
			continue
		}
		topics = append(topics, kafkaTopicInfo{
			Name:       topic.Name,
			Internal:   topic.Internal,
			Partitions: append([]kafka.Partition(nil), topic.Partitions...),
		})
	}
	sort.Slice(topics, func(i, j int) bool {
		return topics[i].Name < topics[j].Name
	})
	return topics, nil
}

func (r *kafkaGoRuntime) InspectConsumerGroups(ctx context.Context, groupID string) ([]kafkaConsumerGroupInfo, error) {
	if r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	bootstrapAddr := kafka.TCP(r.bootstrap)
	groupsResp, err := r.client.ListGroups(ctx, &kafka.ListGroupsRequest{Addr: bootstrapAddr})
	if err != nil {
		return nil, fmt.Errorf("Kafka 消费组列表读取失败（可能缺少 Describe 权限或 broker 版本不支持）：%w", err)
	}
	if groupsResp.Error != nil {
		return nil, fmt.Errorf("Kafka 消费组列表读取失败（可能缺少 Describe 权限）：%w", groupsResp.Error)
	}
	metadata, err := r.client.Metadata(ctx, &kafka.MetadataRequest{Addr: bootstrapAddr})
	if err != nil {
		return nil, fmt.Errorf("Kafka broker 元数据读取失败：%w", err)
	}
	brokers := make(map[int]kafka.Broker, len(metadata.Brokers))
	for _, broker := range metadata.Brokers {
		brokers[broker.ID] = broker
	}
	selectedByCoordinator := make(map[string][]string)
	for _, g := range groupsResp.Groups {
		if strings.TrimSpace(groupID) == "" || g.GroupID == groupID {
			coordinator := r.bootstrap
			if broker, ok := brokers[g.Coordinator]; ok {
				coordinator = kafkaBrokerAddress(broker)
			}
			selectedByCoordinator[coordinator] = append(selectedByCoordinator[coordinator], g.GroupID)
		}
	}
	if len(selectedByCoordinator) == 0 {
		return []kafkaConsumerGroupInfo{}, nil
	}
	rows := make([]kafkaConsumerGroupInfo, 0)
	for coordinator, selected := range selectedByCoordinator {
		addr := kafka.TCP(coordinator)
		desc, err := r.client.DescribeGroups(ctx, &kafka.DescribeGroupsRequest{Addr: addr, GroupIDs: selected})
		if err != nil {
			return nil, fmt.Errorf("Kafka 消费组成员读取失败（可能缺少 Describe 权限或 broker 版本不支持）：%w", err)
		}
		for _, g := range desc.Groups {
			groupRowStart := len(rows)
			if g.Error != nil {
				return nil, fmt.Errorf("Kafka 消费组 %s 读取失败：%w", g.GroupID, g.Error)
			}
			offsets, err := r.client.OffsetFetch(ctx, &kafka.OffsetFetchRequest{Addr: addr, GroupID: g.GroupID})
			if err != nil {
				return nil, fmt.Errorf("Kafka 消费组 %s offset 读取失败（需要 Kafka 0.10.2 或更高版本，且可能缺少 Describe 权限）：%w", g.GroupID, err)
			}
			if offsets.Error != nil {
				return nil, fmt.Errorf("Kafka 消费组 %s offset 读取失败（需要 Kafka 0.10.2 或更高版本，且可能缺少 Describe 权限）：%w", g.GroupID, offsets.Error)
			}
			membersByPartition := map[string]string{}
			for _, m := range g.Members {
				for _, t := range m.MemberAssignments.Topics {
					for _, p := range t.Partitions {
						membersByPartition[fmt.Sprintf("%s/%d", t.Topic, p)] = m.MemberID
					}
				}
			}
			for topic, parts := range offsets.Topics {
				for _, p := range parts {
					if p.Error != nil {
						return nil, fmt.Errorf("Kafka 消费组 %s 的 %s 分区 %d offset 读取失败（可能缺少权限）：%w", g.GroupID, topic, p.Partition, p.Error)
					}
					_, end, err := r.partitionOffsets(ctx, topic, p.Partition)
					if err != nil {
						return nil, err
					}
					row := kafkaConsumerGroupInfo{GroupID: g.GroupID, State: g.GroupState, Topic: topic, Partition: kafkaIntPointer(p.Partition), CurrentOffset: kafkaInt64Pointer(p.CommittedOffset), LogEndOffset: kafkaInt64Pointer(end)}
					row.Lag = kafkaInt64Pointer(maxInt64(0, end-p.CommittedOffset))
					row.MemberID = membersByPartition[fmt.Sprintf("%s/%d", topic, p.Partition)]
					for _, m := range g.Members {
						if m.MemberID == row.MemberID {
							row.ClientID = m.ClientID
							row.ClientHost = m.ClientHost
						}
					}
					rows = append(rows, row)
					delete(membersByPartition, fmt.Sprintf("%s/%d", topic, p.Partition))
				}
			}
			assignedMembers := make(map[string]struct{}, len(g.Members))
			for assignment, memberID := range membersByPartition {
				parts := strings.SplitN(assignment, "/", 2)
				partition, _ := strconv.Atoi(parts[1])
				row := kafkaConsumerGroupInfo{GroupID: g.GroupID, State: g.GroupState, Topic: parts[0], Partition: kafkaIntPointer(partition), MemberID: memberID}
				assignedMembers[memberID] = struct{}{}
				for _, member := range g.Members {
					if member.MemberID == memberID {
						row.ClientID = member.ClientID
						row.ClientHost = member.ClientHost
					}
				}
				rows = append(rows, row)
			}
			for _, member := range g.Members {
				if _, assigned := assignedMembers[member.MemberID]; !assigned && len(member.MemberAssignments.Topics) == 0 {
					rows = append(rows, kafkaConsumerGroupInfo{GroupID: g.GroupID, State: g.GroupState, MemberID: member.MemberID, ClientID: member.ClientID, ClientHost: member.ClientHost})
				}
			}
			if len(rows) == groupRowStart {
				rows = append(rows, kafkaConsumerGroupInfo{GroupID: g.GroupID, State: g.GroupState})
			}
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].GroupID == rows[j].GroupID {
			if rows[i].Topic == rows[j].Topic {
				return kafkaConsumerGroupPartition(rows[i]) < kafkaConsumerGroupPartition(rows[j])
			}
			return rows[i].Topic < rows[j].Topic
		}
		return rows[i].GroupID < rows[j].GroupID
	})
	return rows, nil
}

func kafkaConsumerGroupPartition(group kafkaConsumerGroupInfo) int {
	if group.Partition == nil {
		return -1
	}
	return *group.Partition
}

func kafkaIntPointer(value int) *int { return &value }

func kafkaInt64Pointer(value int64) *int64 { return &value }

func (r *kafkaGoRuntime) DescribeTopic(ctx context.Context, topic string) (kafkaTopicDescription, error) {
	if r.client == nil {
		return kafkaTopicDescription{}, fmt.Errorf("连接未打开")
	}
	name := strings.TrimSpace(topic)
	if name == "" {
		return kafkaTopicDescription{}, fmt.Errorf("Kafka topic 不能为空")
	}
	resp, err := r.client.Metadata(ctx, &kafka.MetadataRequest{
		Addr:   kafka.TCP(r.bootstrap),
		Topics: []string{name},
	})
	if err != nil {
		return kafkaTopicDescription{}, err
	}
	for _, topicInfo := range resp.Topics {
		if topicInfo.Name != name {
			continue
		}
		if topicInfo.Error != nil {
			return kafkaTopicDescription{}, topicInfo.Error
		}
		description := kafkaTopicDescription{
			Name:     topicInfo.Name,
			Internal: topicInfo.Internal,
		}
		for _, partition := range topicInfo.Partitions {
			earliest, latest, err := r.partitionOffsets(ctx, name, partition.ID)
			if err != nil {
				return kafkaTopicDescription{}, err
			}
			description.Partitions = append(description.Partitions, kafkaTopicPartition{
				ID:               partition.ID,
				Leader:           partition.Leader,
				Replicas:         append([]kafka.Broker(nil), partition.Replicas...),
				Isr:              append([]kafka.Broker(nil), partition.Isr...),
				OfflineReplicas:  append([]kafka.Broker(nil), partition.OfflineReplicas...),
				EarliestOffset:   earliest,
				LatestOffset:     latest,
				ApproximateCount: maxInt64(0, latest-earliest),
			})
		}
		sort.Slice(description.Partitions, func(i, j int) bool {
			return description.Partitions[i].ID < description.Partitions[j].ID
		})
		return description, nil
	}
	return kafkaTopicDescription{}, fmt.Errorf("Kafka topic 不存在：%s", name)
}

func (r *kafkaGoRuntime) FetchMessages(ctx context.Context, request kafkaFetchRequest) ([]kafkaMessageRecord, error) {
	topic := strings.TrimSpace(request.Topic)
	if topic == "" {
		return nil, fmt.Errorf("Kafka topic 不能为空")
	}
	limit := request.Limit
	if limit <= 0 {
		limit = defaultKafkaPreviewLimit
	}
	if strings.TrimSpace(request.GroupID) != "" {
		return r.fetchMessagesWithGroup(ctx, kafkaFetchRequest{
			Topic:   topic,
			Limit:   limit,
			Offset:  maxInt(request.Offset, 0),
			GroupID: strings.TrimSpace(request.GroupID),
			Latest:  request.Latest,
		})
	}
	return r.fetchMessagesDirect(ctx, kafkaFetchRequest{
		Topic:  topic,
		Limit:  limit,
		Offset: maxInt(request.Offset, 0),
		Latest: request.Latest,
	})
}

func (r *kafkaGoRuntime) Publish(ctx context.Context, command kafkaPublishCommand) (int64, error) {
	topic := strings.TrimSpace(command.Topic)
	if topic == "" {
		return 0, fmt.Errorf("Kafka publish 命令缺少 topic")
	}
	keyBytes, err := kafkaMessageBytes(command.Key)
	if err != nil {
		return 0, fmt.Errorf("序列化 Kafka key 失败：%w", err)
	}
	valueBytes, err := kafkaMessageBytes(command.Value)
	if err != nil {
		return 0, fmt.Errorf("序列化 Kafka value 失败：%w", err)
	}
	headers, err := kafkaMessageHeaders(command.Headers)
	if err != nil {
		return 0, fmt.Errorf("序列化 Kafka headers 失败：%w", err)
	}
	writer := &kafka.Writer{
		Addr:         kafka.TCP(r.brokers...),
		Topic:        topic,
		RequiredAcks: r.defaultAck,
		Transport:    r.transport,
		ReadTimeout:  r.timeout,
		WriteTimeout: r.timeout,
		BatchTimeout: 20 * time.Millisecond,
	}
	defer writer.Close()
	if err := writer.WriteMessages(ctx, kafka.Message{
		Topic:   topic,
		Key:     keyBytes,
		Value:   valueBytes,
		Headers: headers,
		Time:    time.Now(),
	}); err != nil {
		return 0, err
	}
	return 1, nil
}
