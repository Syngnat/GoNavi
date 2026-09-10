package db

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	rocketmqconsumer "github.com/apache/rocketmq-client-go/v2/consumer"
	rocketmqprimitive "github.com/apache/rocketmq-client-go/v2/primitive"
)

// TestRocketMQAdminManualBrokerDiagnostics 针对"隔离 Broker"的手动验证入口：
//
//	ROCKETMQ_MANUAL_NAMESERVER=127.0.0.1:9876 go test ./internal/db/ -run TestRocketMQAdminManualBrokerDiagnostics -v
//
// 未设置环境变量时跳过（CI 不执行）。流程：向 orders-events 发布若干消息，
// 用 orders-group 的 push consumer 消费并提交位点，再调用
// InspectConsumerGroups 断言成员/位点/Lag 诊断可用并打印结果供人工核对。
func TestRocketMQAdminManualBrokerDiagnostics(t *testing.T) {
	nameserver := stringsTrimSpaceEnv("ROCKETMQ_MANUAL_NAMESERVER")
	if nameserver == "" {
		t.Skip("ROCKETMQ_MANUAL_NAMESERVER 未设置，跳过真实 broker 手动验证")
	}

	runtime := &nativeRocketMQRuntime{nameservers: []string{nameserver}, timeout: 10 * time.Second, sendTimeout: 5 * time.Second}
	ctx := context.Background()

	published := 0
	for i := 0; i < 10; i++ {
		result, err := runtime.Publish(ctx, rocketmqPublishCommand{
			Topic:   "orders-events",
			Payload: fmt.Sprintf(`{"seq":%d}`, i),
		})
		if err != nil {
			t.Fatalf("publish seed message %d: %v", i, err)
		}
		published += int(result)
	}
	t.Logf("published %d messages", published)

	consumed := int32(0)
	consumer, err := rocketmqconsumer.NewPushConsumer(
		rocketmqconsumer.WithGroupName("orders-group"),
		rocketmqconsumer.WithNsResolver(rocketmqprimitive.NewPassthroughResolver([]string{nameserver})),
		rocketmqconsumer.WithConsumeFromWhere(rocketmqconsumer.ConsumeFromFirstOffset),
	)
	if err != nil {
		t.Fatalf("create push consumer: %v", err)
	}
	ready := make(chan struct{})
	var once sync.Once
	if err := consumer.Subscribe("orders-events", rocketmqconsumer.MessageSelector{
		Type:       rocketmqconsumer.TAG,
		Expression: "*",
	}, func(ctx context.Context, msgs ...*rocketmqprimitive.MessageExt) (rocketmqconsumer.ConsumeResult, error) {
		atomic.AddInt32(&consumed, int32(len(msgs)))
		once.Do(func() { close(ready) })
		return rocketmqconsumer.ConsumeSuccess, nil
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := consumer.Start(); err != nil {
		t.Fatalf("start push consumer: %v", err)
	}
	select {
	case <-ready:
	case <-time.After(15 * time.Second):
	}
	time.Sleep(6 * time.Second) // 等待位点持久化
	t.Logf("consumed %d messages with orders-group", atomic.LoadInt32(&consumed))

	// 消费者仍在线：诊断应包含成员行（clientId/clientHost）。
	liveInfos, err := runtime.InspectConsumerGroups(ctx, "orders-group")
	if err != nil {
		t.Fatalf("InspectConsumerGroups(live): %v", err)
	}
	liveMembers := 0
	for _, info := range liveInfos {
		t.Logf("live row: group=%q member=%q client=%q host=%q topic=%q queue=%v lag=%v",
			info.GroupID, info.MemberID, info.ClientID, info.ClientHost, info.Topic,
			derefInt(info.QueueID), derefInt64(info.Lag))
		if info.ClientID != "" {
			liveMembers++
		}
	}
	if liveMembers == 0 {
		t.Fatal("no member rows while the consumer is still online")
	}
	_ = consumer.Shutdown()

	infos, err := runtime.InspectConsumerGroups(ctx, "")
	if err != nil {
		t.Fatalf("InspectConsumerGroups(all): %v", err)
	}
	foundGroup := false
	for _, info := range infos {
		t.Logf("row: group=%q state=%q member=%q client=%q host=%q topic=%q queue=%v offset=%v end=%v lag=%v",
			info.GroupID, info.State, info.MemberID, info.ClientID, info.ClientHost, info.Topic,
			derefInt(info.QueueID), derefInt64(info.CurrentOffset), derefInt64(info.LogEndOffset), derefInt64(info.Lag))
		if info.GroupID == "orders-group" {
			foundGroup = true
		}
	}
	if !foundGroup {
		t.Fatalf("orders-group missing from diagnostics: %#v", infos)
	}

	single, err := runtime.InspectConsumerGroups(ctx, "orders-group")
	if err != nil {
		t.Fatalf("InspectConsumerGroups(orders-group): %v", err)
	}
	if len(single) == 0 {
		t.Fatal("specified group returned no rows")
	}
	var lagRows int
	for _, info := range single {
		if info.Topic != "" && info.Lag != nil {
			lagRows++
		}
	}
	if lagRows == 0 {
		t.Fatalf("no lag rows parsed from real broker: %#v", single)
	}
}

func stringsTrimSpaceEnv(key string) string {
	value := os.Getenv(key)
	for len(value) > 0 && (value[0] == ' ' || value[len(value)-1] == ' ') {
		value = value[1 : len(value)-1]
	}
	return value
}

func derefInt(value *int) interface{} {
	if value == nil {
		return nil
	}
	return *value
}

func derefInt64(value *int64) interface{} {
	if value == nil {
		return nil
	}
	return *value
}
