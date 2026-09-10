package db

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// fakeRocketMQAdminBroker 是最小 RocketMQ remoting 假服务端：按请求 code
// 回放预置响应，用于验证自研管理客户端的帧编解码、opaque 匹配与
// InspectConsumerGroups 的编排逻辑（协议结构按 Java 端约定构造）。
type fakeRocketMQAdminBroker struct {
	listener net.Listener
	handlers map[int16]func(request *rocketMQAdminCommand) (int16, string, []byte)
}

func newFakeRocketMQAdminBroker(t *testing.T, handlers map[int16]func(*rocketMQAdminCommand) (int16, string, []byte)) *fakeRocketMQAdminBroker {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen fake rocketmq broker: %v", err)
	}
	broker := &fakeRocketMQAdminBroker{listener: listener, handlers: handlers}
	t.Cleanup(func() { _ = listener.Close() })
	return broker
}

// start 启动假服务端；允许测试先安装 handler 再启动。
func (b *fakeRocketMQAdminBroker) start(t *testing.T) {
	t.Helper()
	go b.serve()
}

func (b *fakeRocketMQAdminBroker) addr() string {
	return b.listener.Addr().String()
}

func (b *fakeRocketMQAdminBroker) serve() {
	for {
		conn, err := b.listener.Accept()
		if err != nil {
			return
		}
		go b.handleConn(conn)
	}
}

func (b *fakeRocketMQAdminBroker) handleConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	for {
		sizeHeader := make([]byte, 8)
		if _, err := readFull(conn, sizeHeader); err != nil {
			return
		}
		frameSize := int(binary.BigEndian.Uint32(sizeHeader[0:4]))
		if frameSize < 4 || frameSize > maxRocketMQFrameSize {
			return
		}
		frame := make([]byte, frameSize)
		copy(frame[0:4], sizeHeader[4:8])
		if _, err := readFull(conn, frame[4:]); err != nil {
			return
		}
		request, _, err := decodeRocketMQAdminFrame(frame)
		if err != nil {
			return
		}
		handler := b.handlers[request.Code]
		if handler == nil {
			return
		}
		code, remark, body := handler(request)
		response := &rocketMQAdminCommand{
			Code:      code,
			Language:  rocketMQAdminLanguage,
			Opaque:    request.Opaque,
			Flag:      1,
			Remark:    remark,
			ExtFields: map[string]string{},
		}
		responseFrame, err := encodeRocketMQAdminFrame(response, body)
		if err != nil {
			return
		}
		if _, err := conn.Write(responseFrame); err != nil {
			return
		}
	}
}

func readFull(conn net.Conn, buffer []byte) (int, error) {
	total := 0
	for total < len(buffer) {
		n, err := conn.Read(buffer[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func rocketMQAdminJSON(t *testing.T, value interface{}) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal fake response: %v", err)
	}
	return payload
}

// TestRocketMQAdminGatewayParsesClusterAndGroups 验证帧编解码、opaque 匹配
// 与集群信息/订阅组响应解析。
func TestRocketMQAdminGatewayParsesClusterAndGroups(t *testing.T) {
	broker := newFakeRocketMQAdminBroker(t, map[int16]func(*rocketMQAdminCommand) (int16, string, []byte){})
	selfAddr := broker.addr()
	broker.handlers[rocketMQAdminCodeGetBrokerClusterInfo] = func(request *rocketMQAdminCommand) (int16, string, []byte) {
		if request.Code != rocketMQAdminCodeGetBrokerClusterInfo || request.Language != rocketMQAdminLanguage {
			t.Errorf("unexpected cluster info request: %+v", request)
		}
		return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
			"brokerAddrTable": map[string]interface{}{
				"broker-a": map[string]interface{}{
					"cluster":     "DefaultCluster",
					"brokerName":  "broker-a",
					"brokerAddrs": map[string]interface{}{"0": selfAddr, "1": "10.0.0.2:10911"},
				},
				"broker-b": map[string]interface{}{
					"cluster":     "DefaultCluster",
					"brokerName":  "broker-b",
					"brokerAddrs": map[string]interface{}{"0": selfAddr},
				},
			},
		})
	}
	broker.handlers[rocketMQAdminCodeGetAllSubscriptionGroupConfig] = func(request *rocketMQAdminCommand) (int16, string, []byte) {
		return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
			"subscriptionGroupTable": map[string]interface{}{
				"orders-group": map[string]interface{}{"groupName": "orders-group"},
				"demo-group":   map[string]interface{}{"groupName": "demo-group"},
			},
		})
	}
	broker.start(t)

	gateway := newRocketMQAdminGateway([]string{broker.addr()}, time.Second, nil)
	brokers, err := gateway.brokerAddresses(context.Background())
	if err != nil {
		t.Fatalf("brokerAddresses: %v", err)
	}
	if len(brokers) != 2 || brokers[0].Address != selfAddr || brokers[1].Address != selfAddr {
		t.Fatalf("expected only master brokers, got %#v", brokers)
	}

	groups, err := gateway.subscriptionGroups(context.Background(), brokers)
	if err != nil {
		t.Fatalf("subscriptionGroups: %v", err)
	}
	if len(groups) != 2 || groups[0] != "demo-group" || groups[1] != "orders-group" {
		t.Fatalf("unexpected group names: %#v", groups)
	}
}

// TestParseRocketMQAdminConsumeStats 兼容两种 offsetTable 键格式。
func TestParseRocketMQAdminConsumeStats(t *testing.T) {
	body := rocketMQAdminJSON(t, map[string]interface{}{
		"offsetTable": map[string]interface{}{
			// fastjson Map<MessageQueue,...> 的 toString 键格式。
			"MessageQueue [topic=orders.events, brokerName=broker-a, queueId=0]": map[string]interface{}{
				"brokerOffset": 12, "consumerOffset": 8,
			},
			// 部分工具链的 topic@queueId 键格式；consumerOffset 缺失表示未知。
			"payments.events@3": map[string]interface{}{"brokerOffset": 5},
		},
	})
	entries, err := parseRocketMQAdminConsumeStats(body)
	if err != nil {
		t.Fatalf("parseRocketMQAdminConsumeStats: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %#v", entries)
	}
	byKey := make(map[string]rocketmqAdminOffsetEntry, len(entries))
	for _, entry := range entries {
		byKey[fmt.Sprintf("%s/%d", entry.Topic, entry.QueueID)] = entry
	}
	orders := byKey["orders.events/0"]
	if orders.ConsumerOffset == nil || *orders.ConsumerOffset != 8 || orders.BrokerOffset == nil || *orders.BrokerOffset != 12 {
		t.Fatalf("unexpected orders entry: %#v", orders)
	}
	payments := byKey["payments.events/3"]
	if payments.ConsumerOffset != nil {
		t.Fatalf("missing consumerOffset should stay nil, got %#v", payments)
	}
	if payments.BrokerOffset == nil || *payments.BrokerOffset != 5 {
		t.Fatalf("unexpected payments entry: %#v", payments)
	}
}

// TestNativeRocketMQInspectConsumerGroupsEndToEnd 通过假 broker 走完
// InspectConsumerGroups 的编排：集群信息 → 订阅组 → 成员 → 位点/Lag。
func TestNativeRocketMQInspectConsumerGroupsEndToEnd(t *testing.T) {
	handlers := map[int16]func(*rocketMQAdminCommand) (int16, string, []byte){
		rocketMQAdminCodeGetBrokerClusterInfo: func(*rocketMQAdminCommand) (int16, string, []byte) {
			return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
				"brokerAddrTable": map[string]interface{}{
					"broker-a": map[string]interface{}{
						"brokerName":  "broker-a",
						"brokerAddrs": map[string]interface{}{"0": "10.0.0.1:10911"},
					},
				},
			})
		},
		rocketMQAdminCodeGetAllSubscriptionGroupConfig: func(*rocketMQAdminCommand) (int16, string, []byte) {
			return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
				"subscriptionGroupTable": map[string]interface{}{
					"orders-group": map[string]interface{}{"groupName": "orders-group"},
				},
			})
		},
		// 真实 broker（4.9.4）回放的形态：成员是 consumerIdList 字符串数组。
		rocketMQAdminCodeGetConsumerListByGroup: func(*rocketMQAdminCommand) (int16, string, []byte) {
			return 0, "", []byte(`{"consumerIdList":["192.168.2.141@28408"]}`)
		},
		// 真实 broker 的位点响应：offsetTable 键是裸 JSON 对象字面量（非标准
		// JSON），由 rocketmqAdminLenientJSON 转成字符串键后解析。
		rocketMQAdminCodeGetConsumeStats: func(*rocketMQAdminCommand) (int16, string, []byte) {
			key1 := `{"brokerName":"broker-a","queueId":0,"topic":"orders-events"}`
			key2 := `{"brokerName":"broker-a","queueId":1,"topic":"orders-events"}`
			value1 := `{"brokerOffset":12,"consumerOffset":8}`
			value2 := `{"brokerOffset":7,"consumerOffset":7}`
			body := `{"consumeTps":0.16,"offsetTable":{` +
				key1 + `:` + value1 + `,` +
				key2 + `:` + value2 + `}}`
			return 0, "", []byte(body)
		},
	}
	broker := newFakeRocketMQAdminBroker(t, handlers)
	selfAddr := broker.addr()
	broker.handlers[rocketMQAdminCodeGetBrokerClusterInfo] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
			"brokerAddrTable": map[string]interface{}{
				"broker-a": map[string]interface{}{
					"brokerName":  "broker-a",
					"brokerAddrs": map[string]interface{}{"0": selfAddr},
				},
			},
		})
	}
	broker.start(t)

	runtime := &nativeRocketMQRuntime{nameservers: []string{broker.addr()}, timeout: time.Second}
	infos, err := runtime.InspectConsumerGroups(context.Background(), "orders-group")
	if err != nil {
		t.Fatalf("InspectConsumerGroups: %v", err)
	}

	if len(infos) != 3 {
		t.Fatalf("expected 1 member row + 2 offset rows, got %#v", infos)
	}
	member := infos[0]
	if member.GroupID != "orders-group" || member.ClientID != "192.168.2.141@28408" || member.ClientHost != "192.168.2.141" {
		t.Fatalf("unexpected member row: %#v", member)
	}
	if member.Topic != "" || member.QueueID != nil || member.Lag != nil {
		t.Fatalf("member row must not carry queue/offset data: %#v", member)
	}
	firstQueue := infos[1]
	if firstQueue.Topic != "orders-events" || firstQueue.QueueID == nil || *firstQueue.QueueID != 0 {
		t.Fatalf("unexpected first queue row: %#v", firstQueue)
	}
	if firstQueue.CurrentOffset == nil || *firstQueue.CurrentOffset != 8 || firstQueue.LogEndOffset == nil || *firstQueue.LogEndOffset != 12 {
		t.Fatalf("unexpected offsets: %#v", firstQueue)
	}
	if firstQueue.Lag == nil || *firstQueue.Lag != 4 {
		t.Fatalf("unexpected lag: %#v", firstQueue)
	}
	secondQueue := infos[2]
	if secondQueue.Lag == nil || *secondQueue.Lag != 0 {
		t.Fatalf("fully consumed queue must report lag 0, got %#v", secondQueue)
	}
}

// TestNativeRocketMQInspectConsumerGroupsSurfacesErrors 验证指定组失败时
// 返回带原因的错误（验收 3）。
func TestNativeRocketMQInspectConsumerGroupsSurfacesErrors(t *testing.T) {
	broker := newFakeRocketMQAdminBroker(t, map[int16]func(*rocketMQAdminCommand) (int16, string, []byte){
		rocketMQAdminCodeGetConsumerListByGroup: func(*rocketMQAdminCommand) (int16, string, []byte) {
			return 1, "permission denied", nil
		},
		rocketMQAdminCodeGetConsumeStats: func(*rocketMQAdminCommand) (int16, string, []byte) {
			return 1, "permission denied", nil
		},
	})
	broker.handlers[rocketMQAdminCodeGetBrokerClusterInfo] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
			"brokerAddrTable": map[string]interface{}{
				"broker-a": map[string]interface{}{
					"brokerName":  "broker-a",
					"brokerAddrs": map[string]interface{}{"0": broker.addr()},
				},
			},
		})
	}
	broker.start(t)

	runtime := &nativeRocketMQRuntime{nameservers: []string{broker.addr()}, timeout: time.Second}
	_, err := runtime.InspectConsumerGroups(context.Background(), "orders-group")
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("expected surfaced broker error, got %v", err)
	}
	if !errors.Is(errors.Unwrap(errors.Unwrap(err)), &rocketmqAdminError{}) && !strings.Contains(err.Error(), "管理命令返回错误") {
		t.Fatalf("expected underlying admin error detail, got %v", err)
	}
}

// TestRocketMQAdminInvokeRejectsOpaqueMismatch 验证 opaque 校验：
// 服务端返回的 opaque 与请求不一致时客户端必须报错而不是错配数据。
func TestRocketMQAdminInvokeRejectsOpaqueMismatch(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer func() { _ = serverConn.Close() }()
	defer func() { _ = clientConn.Close() }()
	client := &rocketmqAdminClient{addr: "pipe", conn: clientConn, timeout: time.Second}

	go func() {
		sizeBuf := make([]byte, 4)
		if _, err := readFull(serverConn, sizeBuf); err != nil {
			return
		}
		frameSize := int(binary.BigEndian.Uint32(sizeBuf))
		frame := make([]byte, frameSize)
		if _, err := readFull(serverConn, frame); err != nil {
			return
		}
		request, _, err := decodeRocketMQAdminFrame(frame)
		if err != nil {
			return
		}
		mismatched := &rocketMQAdminCommand{Code: 0, Language: rocketMQAdminLanguage, Opaque: request.Opaque + 1, Flag: 1, ExtFields: map[string]string{}}
		responseFrame, err := encodeRocketMQAdminFrame(mismatched, nil)
		if err != nil {
			return
		}
		_, _ = serverConn.Write(responseFrame)
	}()

	if _, _, err := client.invoke(context.Background(), rocketMQAdminCodeGetBrokerClusterInfo, nil); err == nil || !strings.Contains(err.Error(), "opaque") {
		t.Fatalf("expected opaque mismatch error, got %v", err)
	}
}

// TestRocketMQAdminFrameEncodeGolden 用手写字节验证帧编码（非循环验证）：
// [4B 总长][1B 序列化类型 0 + 3B 头长][JSON 头][body]。
func TestRocketMQAdminFrameEncodeGolden(t *testing.T) {
	command := &rocketMQAdminCommand{
		Code:      rocketMQAdminCodeGetConsumerListByGroup,
		Language:  rocketMQAdminLanguage,
		Opaque:    7,
		ExtFields: map[string]string{"consumerGroup": "g1"},
	}
	frame, err := encodeRocketMQAdminFrame(command, nil)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	header := `{"code":38,"language":"GO","version":0,"opaque":7,"flag":0,"remark":"","extFields":{"consumerGroup":"g1"}}`
	expected := append([]byte{0x00, 0x00, 0x00, byte(4 + len(header)), 0x00, 0x00, 0x00, byte(len(header))}, []byte(header)...)
	if string(frame) != string(expected) {
		t.Fatalf("frame mismatch: got %q, want %q", frame, expected)
	}
}

// TestRocketMQAdminFrameDecodeGolden 用手写字节验证响应解码：真实 broker
// 返回的响应头带 codecType 高字节，body 独立传输。
func TestRocketMQAdminFrameDecodeGolden(t *testing.T) {
	header := `{"code":0,"language":"JAVA","version":4,"opaque":9,"flag":1,"remark":"","extFields":{"offset":"12"}}`
	body := []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	headerLen := len(header)
	frame := make([]byte, 0, 4+headerLen+len(body))
	frame = append(frame, 0x00, byte(headerLen>>16), byte(headerLen>>8), byte(headerLen))
	frame = append(frame, []byte(header)...)
	frame = append(frame, body...)

	command, decodedBody, err := decodeRocketMQAdminFrame(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if command.Code != 0 || command.Opaque != 9 || command.Flag != 1 {
		t.Fatalf("unexpected header: %+v", command)
	}
	if len(command.ExtFields) != 1 || command.ExtFields["offset"] != "12" {
		t.Fatalf("unexpected extFields: %#v", command.ExtFields)
	}
	if len(decodedBody) != len(body) {
		t.Fatalf("unexpected body length: %d", len(decodedBody))
	}
}

// TestParseRocketMQAdminConsumerConnections 兼容 consumerIdList 与裸数组。
func TestParseRocketMQAdminConsumerConnections(t *testing.T) {
	realForm, err := parseRocketMQAdminConsumerConnections([]byte(`{"consumerIdList":["192.168.2.141@28408"]}`))
	if err != nil || len(realForm) != 1 || realForm[0].ClientID != "192.168.2.141@28408" {
		t.Fatalf("consumerIdList form: %#v err=%v", realForm, err)
	}
	legacyForm, err := parseRocketMQAdminConsumerConnections([]byte(`[{"clientId":"client-x","clientAddr":"10.0.0.9:80"}]`))
	if err != nil || len(legacyForm) != 1 || legacyForm[0].ClientID != "client-x" {
		t.Fatalf("array form: %#v err=%v", legacyForm, err)
	}
}

// TestRocketMQAdminGatewayDialsBrokersThroughTunnel 验证 SSH/代理场景：
// 集群信息返回的远端 broker 地址经注入的 dialContext 拨号（隧道转发），
// 而不是裸直连。
func TestRocketMQAdminGatewayDialsBrokersThroughTunnel(t *testing.T) {
	broker := newFakeRocketMQAdminBroker(t, map[int16]func(*rocketMQAdminCommand) (int16, string, []byte){})
	broker.handlers[rocketMQAdminCodeGetBrokerClusterInfo] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
			"brokerAddrTable": map[string]interface{}{
				"broker-a": map[string]interface{}{
					"brokerName":  "broker-a",
					"brokerAddrs": map[string]interface{}{"0": "10.0.0.1:10911"},
				},
			},
		})
	}
	broker.handlers[rocketMQAdminCodeGetConsumeStats] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 0, "", []byte(`{"consumeTps":0,"offsetTable":{}}`)
	}
	// 208 空表触发回退路径：43 全表为空 + 30 不会被调用（无队列条目）。
	broker.handlers[rocketMQAdminCodeGetAllConsumerOffset] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 0, "", []byte(`{"offsetTable":{}}`)
	}
	broker.start(t)

	dialed := make(chan string, 1)
	gateway := newRocketMQAdminGateway([]string{broker.addr()}, time.Second, func(ctx context.Context, network, address string) (net.Conn, error) {
		select {
		case dialed <- address:
		default:
		}
		var d net.Dialer
		return d.DialContext(ctx, network, broker.addr())
	})

	stats, err := gateway.consumeStats(context.Background(), "10.0.0.1:10911", "orders-group")
	if err != nil {
		t.Fatalf("consumeStats through tunnel dialer: %v", err)
	}
	if len(stats) != 0 {
		t.Fatalf("expected empty offset table, got %#v", stats)
	}
	select {
	case addr := <-dialed:
		if addr != "10.0.0.1:10911" {
			t.Fatalf("unexpected tunneled address: %q", addr)
		}
	case <-time.After(time.Second):
		t.Fatal("broker dial did not go through the injected dialer")
	}
}

// TestRocketMQAdminLenientJSONToleratesBrokenStructure 回归：结构损坏的
// 输入（如以 }," 开头）不得 panic，原样透传交给 json.Unmarshal 报错。
func TestRocketMQAdminLenientJSONToleratesBrokenStructure(t *testing.T) {
	for _, input := range []string{`},"x"`, `}{`, `{0:"a"}`, `{"a":1}`, `{"offsetTable":{{"brokerName":"b","queueId":0,"topic":"t"}:{"brokerOffset":1}}}`} {
		got := rocketmqAdminLenientJSON([]byte(input))
		if len(got) == 0 {
			t.Fatalf("lenient JSON returned empty for %q", input)
		}
	}
}

// TestNativeRocketMQInspectConsumerGroupsReportsMissingGroup 验收 3：
// 指定组在所有 broker 上都不存在时返回明确的不存在错误。
func TestNativeRocketMQInspectConsumerGroupsReportsMissingGroup(t *testing.T) {
	broker := newFakeRocketMQAdminBroker(t, map[int16]func(*rocketMQAdminCommand) (int16, string, []byte){})
	broker.handlers[rocketMQAdminCodeGetBrokerClusterInfo] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 0, "", rocketMQAdminJSON(t, map[string]interface{}{
			"brokerAddrTable": map[string]interface{}{
				"broker-a": map[string]interface{}{
					"brokerName":  "broker-a",
					"brokerAddrs": map[string]interface{}{"0": broker.addr()},
				},
			},
		})
	}
	broker.handlers[rocketMQAdminCodeGetConsumerListByGroup] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 26, "subscription group not exist", nil
	}
	broker.handlers[rocketMQAdminCodeGetConsumeStats] = func(*rocketMQAdminCommand) (int16, string, []byte) {
		return 26, "subscription group not exist", nil
	}
	broker.start(t)

	runtime := &nativeRocketMQRuntime{nameservers: []string{broker.addr()}, timeout: time.Second}
	_, err := runtime.InspectConsumerGroups(context.Background(), "missing-group")
	if err == nil || !errors.Is(err, rocketmqAdminErrGroupNotExist) {
		t.Fatalf("expected group-not-exist error, got %v", err)
	}
}

// TestRocketMQDBConnectDirectReturnsErrorWithoutPanic 回归 B1：直连（无
// 隧道）场景 tunnel 为 nil，Connect 不得 panic 且应返回连接错误。
func TestRocketMQDBConnectDirectReturnsErrorWithoutPanic(t *testing.T) {
	client := &RocketMQDB{}
	err := client.Connect(connection.ConnectionConfig{
		Type: "rocketmq", Host: "127.0.0.1", Port: 1, // 不可达端口
	})
	if err == nil {
		t.Fatal("expected connect error for unreachable broker, got nil")
	}
}
