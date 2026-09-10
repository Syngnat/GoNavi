package db

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/logger"
)

// 最小 RocketMQ remoting 管理协议客户端，只为只读消费组诊断实现。
//
// rocketmq-client-go/v2 v2.1.2 的公开 Admin API 不暴露 broker 集群发现与
// 消费组运维命令（GetBrokerClusterInfo 被注释，消费组相关请求码无封装，
// 且库的 internal 包不可被外部导入），因此这里按 RocketMQ remoting 协议
// 自实现所需的 4 个只读命令。协议码与响应结构以 Java 源码为准
// （remoting/protocol/RequestCode.java、ResponseCode.java），帧格式与
// rocketmq-client-go internal/remote/codec.go 的 JSON 编解码一致：
//
//	[4B 总长][1B 序列化类型(0=JSON) + 3B 头长][JSON 头][body]
//
// 管理客户端连接的是（可能经过 SSH/代理隧道的）NameServer 地址：隧道层
// 会对 NameServer 连接做内容级路由帧改写，响应中的 broker 地址已是本地
// 转发地址，broker 上的管理请求按需复用同一隧道。

const (
	rocketMQAdminCodeGetBrokerClusterInfo          = int16(106)
	rocketMQAdminCodeGetConsumerListByGroup        = int16(38)
	rocketMQAdminCodeGetAllSubscriptionGroupConfig = int16(201)
	rocketMQAdminCodeGetConsumeStats               = int16(208)
	rocketMQAdminCodeGetAllConsumerOffset          = int16(43)
	rocketMQAdminCodeGetMaxOffset                  = int16(30)

	rocketMQAdminResponseSuccess                   = int16(0)
	rocketMQAdminResponseSubscriptionGroupNotExist = int16(26)

	rocketMQAdminLanguage = "GO"
)

// rocketMQAdminCommand 是 remoting 协议的 JSON 头，字段名与 broker 端
// fastjson 的 RemotingCommand 序列化保持一致。
type rocketMQAdminCommand struct {
	Code      int16             `json:"code"`
	Language  string            `json:"language"`
	Version   int16             `json:"version"`
	Opaque    int32             `json:"opaque"`
	Flag      int32             `json:"flag"`
	Remark    string            `json:"remark"`
	ExtFields map[string]string `json:"extFields"`
}

// rocketMQAdminError 表示 broker/NameServer 返回的非 0 响应码。
// rocketmqAdminErrGroupNotExist 表示所有可达 broker 都报告订阅组不存在。
var rocketmqAdminErrGroupNotExist = errors.New("RocketMQ 消费组不存在")

type rocketmqAdminError struct {
	Code   int16
	Remark string
}

func (e *rocketmqAdminError) Error() string {
	return fmt.Sprintf("RocketMQ 管理命令返回错误（code=%d）：%s", e.Code, strings.TrimSpace(e.Remark))
}

// rocketmqAdminClient 是单地址（NameServer 或 broker）上的串行管理连接。
type rocketmqAdminClient struct {
	addr    string
	conn    net.Conn
	mu      sync.Mutex
	opaque  int32
	timeout time.Duration
}

func dialRocketMQAdminClient(ctx context.Context, addr string, timeout time.Duration) (*rocketmqAdminClient, error) {
	dialer := &net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("连接 RocketMQ 管理地址 %s 失败：%w", addr, err)
	}
	return &rocketmqAdminClient{addr: addr, conn: conn, timeout: timeout}, nil
}

func (c *rocketmqAdminClient) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// invoke 发送一条管理命令并等待同一连接上的响应帧。
func (c *rocketmqAdminClient) invoke(ctx context.Context, code int16, extFields map[string]string) (*rocketMQAdminCommand, []byte, error) {
	if c == nil || c.conn == nil {
		return nil, nil, errors.New("RocketMQ 管理连接未建立")
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	// ctx 取消/超时立即关闭连接，解除阻塞中的读等待。
	if stopWatch := context.AfterFunc(ctx, func() { _ = c.conn.Close() }); stopWatch != nil {
		defer stopWatch()
	}

	deadline := time.Time{}
	if rawDeadline, ok := ctx.Deadline(); ok {
		deadline = rawDeadline
	}
	if c.timeout > 0 {
		if candidate := time.Now().Add(c.timeout); deadline.IsZero() || candidate.Before(deadline) {
			deadline = candidate
		}
	}
	_ = c.conn.SetDeadline(deadline)

	c.opaque++
	request := &rocketMQAdminCommand{
		Code:      code,
		Language:  rocketMQAdminLanguage,
		Opaque:    c.opaque,
		ExtFields: extFields,
	}
	frame, err := encodeRocketMQAdminFrame(request, nil)
	if err != nil {
		return nil, nil, err
	}
	if _, err := c.conn.Write(frame); err != nil {
		return nil, nil, fmt.Errorf("发送 RocketMQ 管理命令（code=%d）失败：%w", code, err)
	}

	response, body, err := c.readResponse()
	if err != nil {
		return nil, nil, fmt.Errorf("读取 RocketMQ 管理响应（code=%d）失败：%w", code, err)
	}
	if response.Opaque != request.Opaque {
		return nil, nil, fmt.Errorf("RocketMQ 管理响应 opaque 不匹配：期望 %d，实际 %d", request.Opaque, response.Opaque)
	}
	return response, body, nil
}

func (c *rocketmqAdminClient) readResponse() (*rocketMQAdminCommand, []byte, error) {
	sizeBuf := make([]byte, 4)
	if _, err := io.ReadFull(c.conn, sizeBuf); err != nil {
		return nil, nil, err
	}
	// size 之后是 [4B 头长字段][头][body]。
	frameSize := int(binary.BigEndian.Uint32(sizeBuf))
	if frameSize < 4 || frameSize > maxRocketMQFrameSize {
		return nil, nil, fmt.Errorf("RocketMQ 管理响应帧长度无效：%d", frameSize)
	}
	frame := make([]byte, frameSize)
	if _, err := io.ReadFull(c.conn, frame); err != nil {
		return nil, nil, err
	}
	return decodeRocketMQAdminFrame(frame)
}

func encodeRocketMQAdminFrame(command *rocketMQAdminCommand, body []byte) ([]byte, error) {
	header, err := json.Marshal(command)
	if err != nil {
		return nil, err
	}
	frameSize := 4 + len(header) + len(body)
	frame := make([]byte, 8+len(header)+len(body))
	binary.BigEndian.PutUint32(frame[0:4], uint32(frameSize))
	// 高字节为序列化类型：0 = JSON。
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(header))&0x00ffffff)
	copy(frame[8:], header)
	copy(frame[8+len(header):], body)
	return frame, nil
}

// decodeRocketMQAdminFrame 解析 size 前缀之后的帧段：
// [4B 序列化类型+头长][JSON 头][body]。
func decodeRocketMQAdminFrame(frame []byte) (*rocketMQAdminCommand, []byte, error) {
	if len(frame) < 4 {
		return nil, nil, fmt.Errorf("RocketMQ 管理响应帧过短：%d", len(frame))
	}
	headerLenField := binary.BigEndian.Uint32(frame[0:4])
	codecType := byte(headerLenField >> 24)
	headerLen := int(headerLenField & 0x00ffffff)
	if codecType != 0 {
		return nil, nil, fmt.Errorf("RocketMQ 管理响应使用不支持的序列化类型：%d", codecType)
	}
	if 4+headerLen > len(frame) {
		return nil, nil, fmt.Errorf("RocketMQ 管理响应头长度无效：%d", headerLen)
	}
	command := &rocketMQAdminCommand{ExtFields: map[string]string{}}
	if headerLen > 0 {
		if err := json.Unmarshal(frame[4:4+headerLen], command); err != nil {
			return nil, nil, fmt.Errorf("解析 RocketMQ 管理响应头失败：%w", err)
		}
	}
	var body []byte
	if rest := len(frame) - 4 - headerLen; rest > 0 {
		body = make([]byte, rest)
		copy(body, frame[4+headerLen:])
	}
	return command, body, nil
}

// rocketmqAdminGateway 在多个 NameServer/broker 地址上编排只读管理命令。
type rocketmqAdminGateway struct {
	nameservers []string
	timeout     time.Duration
	// dialContext 仅用于 broker 地址：SSH/代理隧道场景下 NameServer 走
	// 本地转发地址（普通拨号），而 106 响应返回的 broker 地址是远端真实
	// 地址（隧道不改写 brokerAddrTable），必须经隧道拨号函数才能到达。
	dialContext rocketmqDialContextFunc
}

func newRocketMQAdminGateway(nameservers []string, timeout time.Duration, dialContext rocketmqDialContextFunc) *rocketmqAdminGateway {
	return &rocketmqAdminGateway{nameservers: append([]string(nil), nameservers...), timeout: timeout, dialContext: dialContext}
}

func (g *rocketmqAdminGateway) dialBroker(ctx context.Context, addr string) (*rocketmqAdminClient, error) {
	if g.dialContext != nil {
		conn, err := g.dialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("连接 RocketMQ 管理地址 %s 失败：%w", addr, err)
		}
		return &rocketmqAdminClient{addr: addr, conn: conn, timeout: g.timeout}, nil
	}
	return dialRocketMQAdminClient(ctx, addr, g.timeout)
}

type rocketmqAdminClusterBroker struct {
	BrokerName string
	Address    string
}

// brokerAddresses 返回集群中全部 master broker（brokerId=0）地址。
func (g *rocketmqAdminGateway) brokerAddresses(ctx context.Context) ([]rocketmqAdminClusterBroker, error) {
	var lastErr error
	for _, nameserver := range g.nameservers {
		client, err := dialRocketMQAdminClient(ctx, nameserver, g.timeout)
		if err != nil {
			lastErr = err
			continue
		}
		response, body, invokeErr := client.invoke(ctx, rocketMQAdminCodeGetBrokerClusterInfo, nil)
		_ = client.Close()
		if invokeErr != nil {
			lastErr = invokeErr
			continue
		}
		if response.Code != rocketMQAdminResponseSuccess {
			lastErr = &rocketmqAdminError{Code: response.Code, Remark: response.Remark}
			continue
		}
		brokers, err := parseRocketMQAdminClusterBrokers(body)
		if err != nil {
			lastErr = err
			continue
		}
		if len(brokers) > 0 {
			return brokers, nil
		}
		lastErr = errors.New("集群信息中没有任何 broker")
	}
	if lastErr == nil {
		lastErr = errors.New("没有可用的 NameServer 地址")
	}
	return nil, fmt.Errorf("RocketMQ broker 集群信息读取失败：%w", lastErr)
}

// subscriptionGroups 枚举各 broker 上登记的消费组名（并集、排序）。
func (g *rocketmqAdminGateway) subscriptionGroups(ctx context.Context, brokers []rocketmqAdminClusterBroker) ([]string, error) {
	groups := make(map[string]struct{})
	var lastErr error
	for _, broker := range brokers {
		client, err := g.dialBroker(ctx, broker.Address)
		if err != nil {
			lastErr = err
			logger.Warnf("RocketMQ 订阅组枚举跳过 broker %s：%v", broker.Address, err)
			continue
		}
		response, body, invokeErr := client.invoke(ctx, rocketMQAdminCodeGetAllSubscriptionGroupConfig, nil)
		_ = client.Close()
		if invokeErr != nil {
			lastErr = invokeErr
			logger.Warnf("RocketMQ 订阅组枚举跳过 broker %s：%v", broker.Address, invokeErr)
			continue
		}
		if response.Code != rocketMQAdminResponseSuccess {
			lastErr = &rocketmqAdminError{Code: response.Code, Remark: response.Remark}
			logger.Warnf("RocketMQ 订阅组枚举跳过 broker %s：%v", broker.Address, lastErr)
			continue
		}
		names, err := parseRocketMQAdminSubscriptionGroupNames(body)
		if err != nil {
			lastErr = err
			logger.Warnf("RocketMQ 订阅组枚举跳过 broker %s：%v", broker.Address, err)
			continue
		}
		for _, name := range names {
			groups[name] = struct{}{}
		}
	}
	if len(groups) == 0 {
		if lastErr == nil {
			lastErr = errors.New("broker 上没有任何订阅组配置")
		}
		return nil, fmt.Errorf("RocketMQ 消费组列表读取失败（可能缺少管理权限或 broker 不可达）：%w", lastErr)
	}
	names := make([]string, 0, len(groups))
	for name := range groups {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

type rocketmqAdminConsumerConnection struct {
	ClientID   string
	ClientAddr string
}

// consumerConnections 查询一个消费组在指定 broker 上的客户端连接。
// 组在该 broker 上不存在时返回空列表（err 非空表示真实故障）。
func (g *rocketmqAdminGateway) consumerConnections(ctx context.Context, brokerAddr string, groupID string) ([]rocketmqAdminConsumerConnection, error) {
	client, err := g.dialBroker(ctx, brokerAddr)
	if err != nil {
		return nil, err
	}
	defer func() { _ = client.Close() }()
	response, body, err := client.invoke(ctx, rocketMQAdminCodeGetConsumerListByGroup, map[string]string{"consumerGroup": groupID})
	if err != nil {
		return nil, err
	}
	if response.Code == rocketMQAdminResponseSubscriptionGroupNotExist {
		return nil, rocketmqAdminErrGroupNotExist
	}
	if response.Code != rocketMQAdminResponseSuccess {
		// broker 对没有在线成员的组返回 SYSTEM_ERROR + "no consumer for
		// this group"——这是正常空态而非故障。
		if strings.Contains(strings.ToLower(response.Remark), "no consumer for this group") {
			return nil, nil
		}
		return nil, &rocketmqAdminError{Code: response.Code, Remark: response.Remark}
	}
	return parseRocketMQAdminConsumerConnections(body)
}

type rocketmqAdminOffsetEntry struct {
	Topic          string
	QueueID        int
	ConsumerOffset *int64
	BrokerOffset   *int64
}

// consumeStats 查询一个消费组在指定 broker 上的全部队列位点。
func (g *rocketmqAdminGateway) consumeStats(ctx context.Context, brokerAddr string, groupID string) ([]rocketmqAdminOffsetEntry, error) {
	client, err := g.dialBroker(ctx, brokerAddr)
	if err != nil {
		return nil, err
	}
	defer func() { _ = client.Close() }()
	response, body, err := client.invoke(ctx, rocketMQAdminCodeGetConsumeStats, map[string]string{"consumerGroup": groupID})
	if err != nil {
		return nil, err
	}
	if response.Code == rocketMQAdminResponseSubscriptionGroupNotExist {
		return nil, rocketmqAdminErrGroupNotExist
	}
	if response.Code != rocketMQAdminResponseSuccess {
		return nil, &rocketmqAdminError{Code: response.Code, Remark: response.Remark}
	}
	entries, err := parseRocketMQAdminConsumeStats(body)
	if err != nil {
		return nil, err
	}
	if len(entries) > 0 {
		return entries, nil
	}
	// GET_CONSUME_STATS 依赖 broker 的运行时消费组注册状态：组没有在线
	// 消费者时即使持久化位点存在也返回空表。回退到 GET_ALL_CONSUMER_OFFSET
	// （持久化位点全表）+ GET_MAX_OFFSET 补全位点与 Lag。
	return g.offsetsFromAllConsumerOffsets(ctx, brokerAddr, groupID)
}

// offsetsFromAllConsumerOffsets 经 GET_ALL_CONSUMER_OFFSET(43) 读取
// broker 持久化位点全表，再逐队列用 GET_MAX_OFFSET(30) 取末端位点。
func (g *rocketmqAdminGateway) offsetsFromAllConsumerOffsets(ctx context.Context, brokerAddr string, groupID string) ([]rocketmqAdminOffsetEntry, error) {
	client, err := g.dialBroker(ctx, brokerAddr)
	if err != nil {
		return nil, err
	}
	defer func() { _ = client.Close() }()

	response, body, err := client.invoke(ctx, rocketMQAdminCodeGetAllConsumerOffset, nil)
	if err != nil {
		return nil, err
	}
	if response.Code != rocketMQAdminResponseSuccess {
		return nil, &rocketmqAdminError{Code: response.Code, Remark: response.Remark}
	}
	groupOffsets, err := parseRocketMQAdminAllConsumerOffsets(body, groupID)
	if err != nil {
		return nil, err
	}
	entries := make([]rocketmqAdminOffsetEntry, 0, len(groupOffsets))
	for _, offsetEntry := range groupOffsets {
		brokerOffset, maxErr := g.maxOffset(ctx, brokerAddr, offsetEntry.Topic, offsetEntry.QueueID)
		if maxErr != nil {
			return nil, maxErr
		}
		consumerOffset := offsetEntry.ConsumerOffset
		entry := rocketmqAdminOffsetEntry{
			Topic:          offsetEntry.Topic,
			QueueID:        offsetEntry.QueueID,
			ConsumerOffset: consumerOffset,
			BrokerOffset:   brokerOffset,
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Topic != entries[j].Topic {
			return entries[i].Topic < entries[j].Topic
		}
		return entries[i].QueueID < entries[j].QueueID
	})
	return entries, nil
}

// maxOffset 查询指定队列的末端位点（GET_MAX_OFFSET，响应 extFields 的 offset）。
func (g *rocketmqAdminGateway) maxOffset(ctx context.Context, brokerAddr string, topic string, queueID int) (*int64, error) {
	client, err := g.dialBroker(ctx, brokerAddr)
	if err != nil {
		return nil, err
	}
	defer func() { _ = client.Close() }()
	response, body, err := client.invoke(ctx, rocketMQAdminCodeGetMaxOffset, map[string]string{
		"topic":   topic,
		"queueId": strconv.Itoa(queueID),
	})
	if err != nil {
		return nil, err
	}
	if response.Code != rocketMQAdminResponseSuccess {
		return nil, &rocketmqAdminError{Code: response.Code, Remark: response.Remark}
	}
	if raw, ok := response.ExtFields["offset"]; ok {
		if value, parseErr := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); parseErr == nil {
			return &value, nil
		}
	}
	var decoded struct {
		Offset *int64 `json:"offset"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &decoded); err == nil && decoded.Offset != nil {
			return decoded.Offset, nil
		}
	}
	return nil, fmt.Errorf("GET_MAX_OFFSET 响应缺少 offset 字段")
}

// parseRocketMQAdminAllConsumerOffsets 解析 GET_ALL_CONSUMER_OFFSET 响应：
// {"offsetTable":{"topic@group":{queueId: offset}}}，键的数字为裸数字，
// 由 rocketmqAdminLenientJSON 修复；按组名过滤出目标组的条目。
func parseRocketMQAdminAllConsumerOffsets(body []byte, groupID string) ([]rocketmqAdminOffsetEntry, error) {
	var wrapper struct {
		OffsetTable map[string]json.RawMessage `json:"offsetTable"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(rocketmqAdminLenientJSON(body), &wrapper); err != nil {
			return nil, fmt.Errorf("解析消费位点全表失败：%w", err)
		}
	}
	entries := make([]rocketmqAdminOffsetEntry, 0)
	for key, raw := range wrapper.OffsetTable {
		index := strings.LastIndex(key, "@")
		if index <= 0 {
			continue
		}
		topic := strings.TrimSpace(key[:index])
		group := strings.TrimSpace(key[index+1:])
		if group != groupID || topic == "" {
			continue
		}
		var queueOffsets map[string]*int64
		if err := json.Unmarshal(raw, &queueOffsets); err != nil {
			return nil, fmt.Errorf("解析组 %s 的队列位点失败：%w", group, err)
		}
		for queueKey, offset := range queueOffsets {
			queueID, parseErr := strconv.Atoi(strings.TrimSpace(queueKey))
			if parseErr != nil {
				continue
			}
			entries = append(entries, rocketmqAdminOffsetEntry{
				Topic:          topic,
				QueueID:        queueID,
				ConsumerOffset: offset,
			})
		}
	}
	return entries, nil
}

type rocketmqAdminClusterInfo struct {
	BrokerAddrTable map[string]struct {
		Cluster     string            `json:"cluster"`
		BrokerName  string            `json:"brokerName"`
		BrokerAddrs map[string]string `json:"brokerAddrs"`
	} `json:"brokerAddrTable"`
}

func parseRocketMQAdminClusterBrokers(body []byte) ([]rocketmqAdminClusterBroker, error) {
	var cluster rocketmqAdminClusterInfo
	if len(body) > 0 {
		if err := json.Unmarshal(rocketmqAdminLenientJSON(body), &cluster); err != nil {
			return nil, fmt.Errorf("解析 broker 集群信息失败：%w", err)
		}
	}
	brokers := make([]rocketmqAdminClusterBroker, 0, len(cluster.BrokerAddrTable))
	for _, broker := range cluster.BrokerAddrTable {
		// 只取 master（brokerId=0）；从节点不承载消费位点管理。
		if addr, ok := broker.BrokerAddrs["0"]; ok && strings.TrimSpace(addr) != "" {
			brokers = append(brokers, rocketmqAdminClusterBroker{BrokerName: broker.BrokerName, Address: addr})
		}
	}
	sort.Slice(brokers, func(i, j int) bool { return brokers[i].BrokerName < brokers[j].BrokerName })
	return brokers, nil
}

func parseRocketMQAdminSubscriptionGroupNames(body []byte) ([]string, error) {
	var wrapper struct {
		SubscriptionGroupTable map[string]json.RawMessage `json:"subscriptionGroupTable"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(rocketmqAdminLenientJSON(body), &wrapper); err != nil {
			return nil, fmt.Errorf("解析订阅组配置失败：%w", err)
		}
	}
	names := make([]string, 0, len(wrapper.SubscriptionGroupTable))
	for name := range wrapper.SubscriptionGroupTable {
		name = strings.TrimSpace(name)
		if name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func parseRocketMQAdminConsumerConnections(body []byte) ([]rocketmqAdminConsumerConnection, error) {
	// 响应是 Java GetConsumerListByGroupResponseBody：
	// {"consumerIdList":["<host>@<pid>", ...]}；兼容 connectionSet 对象形式。
	var wrapper struct {
		ConsumerIDList []string `json:"consumerIdList"`
		ConnectionSet  []struct {
			ClientID   string `json:"clientId"`
			ClientAddr string `json:"clientAddr"`
		} `json:"connectionSet"`
	}
	var connections []struct {
		ClientID   string `json:"clientId"`
		ClientAddr string `json:"clientAddr"`
	}
	if len(body) > 0 {
		lenient := rocketmqAdminLenientJSON(body)
		trimmed := strings.TrimSpace(string(lenient))
		if strings.HasPrefix(trimmed, "[") {
			if err := json.Unmarshal(lenient, &connections); err != nil {
				return nil, fmt.Errorf("解析消费组客户端连接失败：%w", err)
			}
		} else if err := json.Unmarshal(lenient, &wrapper); err != nil {
			return nil, fmt.Errorf("解析消费组客户端连接失败：%w", err)
		}
	}
	if len(wrapper.ConsumerIDList) > 0 {
		for _, id := range wrapper.ConsumerIDList {
			id = strings.TrimSpace(id)
			if id != "" {
				connections = append(connections, struct {
					ClientID   string `json:"clientId"`
					ClientAddr string `json:"clientAddr"`
				}{ClientID: id, ClientAddr: id})
			}
		}
	} else {
		for _, conn := range wrapper.ConnectionSet {
			connections = append(connections, struct {
				ClientID   string `json:"clientId"`
				ClientAddr string `json:"clientAddr"`
			}{ClientID: strings.TrimSpace(conn.ClientID), ClientAddr: strings.TrimSpace(conn.ClientAddr)})
		}
	}
	result := make([]rocketmqAdminConsumerConnection, 0, len(connections))
	for _, conn := range connections {
		result = append(result, rocketmqAdminConsumerConnection{
			ClientID:   strings.TrimSpace(conn.ClientID),
			ClientAddr: strings.TrimSpace(conn.ClientAddr),
		})
	}
	return result, nil
}

type rocketmqAdminConsumeStats struct {
	OffsetTable map[string]json.RawMessage `json:"offsetTable"`
}

type rocketmqAdminOffsetWrapper struct {
	BrokerOffset   *int64 `json:"brokerOffset"`
	ConsumerOffset *int64 `json:"consumerOffset"`
}

func parseRocketMQAdminConsumeStats(body []byte) ([]rocketmqAdminOffsetEntry, error) {
	var stats rocketmqAdminConsumeStats
	if len(body) > 0 {
		if err := json.Unmarshal(rocketmqAdminLenientJSON(body), &stats); err != nil {
			return nil, fmt.Errorf("解析消费位点统计失败：%w", err)
		}
	}
	entries := make([]rocketmqAdminOffsetEntry, 0, len(stats.OffsetTable))
	seen := make(map[string]struct{}, len(stats.OffsetTable))
	for key, raw := range stats.OffsetTable {
		topic, queueID, ok := parseRocketMQAdminOffsetKey(key)
		if !ok {
			continue
		}
		dedup := fmt.Sprintf("%s\x00%d", topic, queueID)
		if _, exists := seen[dedup]; exists {
			continue
		}
		seen[dedup] = struct{}{}
		var wrapper rocketmqAdminOffsetWrapper
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &wrapper); err != nil {
				return nil, fmt.Errorf("解析消费位点失败：%w", err)
			}
		}
		entries = append(entries, rocketmqAdminOffsetEntry{
			Topic:          topic,
			QueueID:        queueID,
			ConsumerOffset: wrapper.ConsumerOffset,
			BrokerOffset:   wrapper.BrokerOffset,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Topic != entries[j].Topic {
			return entries[i].Topic < entries[j].Topic
		}
		return entries[i].QueueID < entries[j].QueueID
	})
	return entries, nil
}

// rocketmqAdminLenientJSON 把对象键位置上的裸数字键加引号，兼容
// Java fastjson 对非 String 键（如 ClusterInfo 中 Map<Long, String> 的
// brokerAddrs）输出的非标准 JSON：{0:"127.0.0.1:10911"}。标准 JSON 要求数
// 对象键必须带引号，Go 的 json.Unmarshal 会直接失败——这也是
// rocketmq-client-go 公开 Admin API 缺失这些命令的原因之一。
// 字符串字面量内的内容（含转义）原样保留。
func rocketmqAdminLenientJSON(body []byte) []byte {
	if len(body) == 0 {
		return body
	}

	out := make([]byte, 0, len(body)+16)
	type frame struct {
		isObject  bool
		expectKey bool
	}
	// 栈底哨兵表示“root 之外”：root 的 '{' 本身不能被当作键。
	stack := []frame{{isObject: false, expectKey: false}}
	inString := false
	escaped := false
	for i := 0; i < len(body); i++ {
		ch := body[i]
		if inString {
			out = append(out, ch)
			if escaped {
				escaped = false
			} else if ch == 92 {
				escaped = true
			} else if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
			out = append(out, ch)
			if len(stack) > 0 {
				stack[len(stack)-1].expectKey = false
			}
		case '{':
			if len(stack) > 0 && stack[len(stack)-1].isObject {
				// fastjson 对 Map<复杂键, ...> 的输出把对象字面量放在键位置：
				// 形如 "key":{...}:{value}。识别方式：平衡扫描该对象后紧跟
				// ':' 即为对象键，转成 JSON 字符串键后再正常解析值。
				objectEnd := i + rocketmqAdminSkipBalancedObject(body[i:])
				peek := objectEnd + 1
				for peek < len(body) && rocketmqAdminIsSpace(body[peek]) {
					peek++
				}
				if peek < len(body) && body[peek] == ':' {
					objectJSON := body[i : objectEnd+1]
					encodedKey, err := json.Marshal(string(objectJSON))
					if err != nil {
						return body
					}
					out = append(out, encodedKey...)
					out = append(out, ':')
					stack[len(stack)-1].expectKey = false
					i = peek
					continue
				}
			}
			stack = append(stack, frame{isObject: true, expectKey: true})
			out = append(out, ch)
		case '[':
			stack = append(stack, frame{isObject: false, expectKey: false})
			out = append(out, ch)
		case '}', ']':
			// 结构损坏（多余闭合符）时不弹空栈，原样透传交给
			// json.Unmarshal 报错，避免本函数 panic。
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
				if len(stack) > 0 {
					stack[len(stack)-1].expectKey = false
				}
			}
			out = append(out, ch)
		case ':':
			if len(stack) > 0 {
				stack[len(stack)-1].expectKey = false
			}
			out = append(out, ch)
		case ',':
			if len(stack) > 0 && stack[len(stack)-1].isObject {
				stack[len(stack)-1].expectKey = true
			}
			out = append(out, ch)
		default:
			if rocketmqAdminIsDigit(ch) || ch == '-' {
				if len(stack) > 0 && stack[len(stack)-1].isObject && stack[len(stack)-1].expectKey {
					// 对象键位置的裸数字：加引号并消费整个数字 token。
					out = append(out, '"')
					out = append(out, ch)
					i++
					for i < len(body) && (rocketmqAdminIsDigit(body[i]) || body[i] == '.') {
						out = append(out, body[i])
						i++
					}
					out = append(out, '"')
					// 回退一格，循环的自增会前进到下一个字符。
					i--
					continue
				}
			}
			out = append(out, ch)
		}
	}
	return out
}

func rocketmqAdminIsSpace(ch byte) bool {
	return ch == ' ' || ch == 9 || ch == 10 || ch == 13
}

func rocketmqAdminIsDigit(ch byte) bool {
	return ch >= '0' && ch <= '9'
}

// rocketmqAdminSkipBalancedObject 返回从 body[start]（应为 '{'）开始的
// 平衡对象字面量的结束下标（'}' 的位置），正确处理字符串与嵌套。
func rocketmqAdminSkipBalancedObject(body []byte) int {
	depth := 0
	inString := false
	escaped := false
	for i := 0; i < len(body); i++ {
		ch := body[i]
		if inString {
			if escaped {
				escaped = false
			} else if ch == 92 {
				escaped = true
			} else if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return len(body) - 1
}

var rocketmqAdminMessageQueueKeyRE = regexp.MustCompile(`topic\s*=\s*([^,\]]+),\s*brokerName\s*=\s*[^,\]]+,\s*queueId\s*=\s*(-?\d+)`)

// parseRocketMQAdminOffsetKey 解析 offsetTable 的键。fastjson 序列化
// Map<MessageQueue, OffsetWrapper> 时键为 MessageQueue.toString()
// （"MessageQueue [topic=..., brokerName=..., queueId=N]"），部分工具链
// 使用 "topic@queueId" 形式，这里两种都兼容。
func parseRocketMQAdminOffsetKey(key string) (string, int, bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return "", 0, false
	}
	if strings.HasPrefix(key, "{") {
		var decoded struct {
			Topic   string `json:"topic"`
			QueueID int    `json:"queueId"`
		}
		if err := json.Unmarshal([]byte(key), &decoded); err == nil && decoded.Topic != "" {
			return decoded.Topic, decoded.QueueID, true
		}
		return "", 0, false
	}
	if index := strings.LastIndex(key, "@"); index > 0 {
		topic := strings.TrimSpace(key[:index])
		if queueID, err := strconv.Atoi(strings.TrimSpace(key[index+1:])); err == nil {
			return topic, queueID, true
		}
	}
	if match := rocketmqAdminMessageQueueKeyRE.FindStringSubmatch(key); match != nil {
		if queueID, err := strconv.Atoi(strings.TrimSpace(match[2])); err == nil {
			return strings.TrimSpace(match[1]), queueID, true
		}
	}
	return "", 0, false
}
