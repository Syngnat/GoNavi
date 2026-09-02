package db

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
)

type mqttSubscriptionTestToken struct {
	stubMQTTToken
	result map[string]byte
}

func (t mqttSubscriptionTestToken) Result() map[string]byte {
	return t.result
}

type mqttSubscriptionTestClient struct {
	*stubMQTTClient

	routeMu          sync.Mutex
	routes           map[string]pahomqtt.MessageHandler
	subscribeCalls   int
	subscribeQoS     []byte
	unsubscribeCalls int
	subscribeCode    byte
}

func newMQTTSubscriptionTestClient() *mqttSubscriptionTestClient {
	return &mqttSubscriptionTestClient{
		stubMQTTClient: &stubMQTTClient{connected: true},
		routes:         make(map[string]pahomqtt.MessageHandler),
	}
}

func (c *mqttSubscriptionTestClient) Subscribe(topic string, qos byte, callback pahomqtt.MessageHandler) pahomqtt.Token {
	c.routeMu.Lock()
	c.subscribeCalls++
	c.subscribeQoS = append(c.subscribeQoS, qos)
	c.routes[topic] = callback
	code := c.subscribeCode
	c.routeMu.Unlock()
	return mqttSubscriptionTestToken{
		result: map[string]byte{topic: code},
	}
}

func (c *mqttSubscriptionTestClient) Unsubscribe(topics ...string) pahomqtt.Token {
	c.routeMu.Lock()
	c.unsubscribeCalls++
	for _, topic := range topics {
		delete(c.routes, topic)
	}
	c.routeMu.Unlock()
	return stubMQTTToken{}
}

func (c *mqttSubscriptionTestClient) emit(topic string, payload []byte) bool {
	c.routeMu.Lock()
	callback := c.routes[topic]
	c.routeMu.Unlock()
	if callback == nil {
		return false
	}
	callback(c, mqttSubscriptionTestMessage{topic: topic, payload: payload})
	return true
}

func (c *mqttSubscriptionTestClient) callCounts() (subscribe, unsubscribe int) {
	c.routeMu.Lock()
	defer c.routeMu.Unlock()
	return c.subscribeCalls, c.unsubscribeCalls
}

func (c *mqttSubscriptionTestClient) subscribedQoS() []byte {
	c.routeMu.Lock()
	defer c.routeMu.Unlock()
	return append([]byte(nil), c.subscribeQoS...)
}

type mqttSubscriptionTestMessage struct {
	topic   string
	payload []byte
}

func (m mqttSubscriptionTestMessage) Duplicate() bool   { return false }
func (m mqttSubscriptionTestMessage) Qos() byte         { return 1 }
func (m mqttSubscriptionTestMessage) Retained() bool    { return false }
func (m mqttSubscriptionTestMessage) Topic() string     { return m.topic }
func (m mqttSubscriptionTestMessage) MessageID() uint16 { return 1 }
func (m mqttSubscriptionTestMessage) Payload() []byte   { return m.payload }
func (m mqttSubscriptionTestMessage) Ack()              {}

func newMQTTSubscriptionTestRuntime(client pahomqtt.Client) *pahoMQTTRuntime {
	return &pahoMQTTRuntime{
		client:        client,
		timeout:       time.Second,
		subscriptions: make(map[string]*mqttSharedSubscription),
	}
}

func mqttSubscriptionWaiterCount(subscription *mqttSharedSubscription) int {
	subscription.mu.Lock()
	defer subscription.mu.Unlock()
	return len(subscription.waiters)
}

func waitForMQTTSubscriptionTest(t *testing.T, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

func TestPahoMQTTRuntimeBuffersConfiguredSubscriptionUntilQuery(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	if _, err := runtime.ensureSubscription(client, "devices/+/telemetry", 1); err != nil {
		t.Fatalf("ensure configured subscription: %v", err)
	}
	if !client.emit("devices/+/telemetry", []byte(`{"event":"created"}`)) {
		t.Fatal("configured subscription route was not registered")
	}

	records, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic: "devices/+/telemetry",
		Limit: 1,
		QoS:   1,
		Wait:  time.Second,
	})
	if err != nil {
		t.Fatalf("fetch buffered MQTT message: %v", err)
	}
	if len(records) != 1 || string(records[0].Payload) != `{"event":"created"}` {
		t.Fatalf("unexpected buffered MQTT records: %#v", records)
	}
	if subscribe, unsubscribe := client.callCounts(); subscribe != 1 || unsubscribe != 0 {
		t.Fatalf("subscription calls before close = subscribe:%d unsubscribe:%d, want 1/0", subscribe, unsubscribe)
	}
}

func TestPahoMQTTRuntimeOffsetSurvivesSubscriptionBufferRollover(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	if _, err := runtime.ensureSubscription(client, "devices/rollover", 1); err != nil {
		t.Fatalf("ensure subscription: %v", err)
	}
	for index := 0; index < mqttSubscriptionBuffer; index++ {
		if !client.emit("devices/rollover", []byte(fmt.Sprintf("message-%d", index))) {
			t.Fatal("subscription route was not registered")
		}
	}
	initial, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic: "devices/rollover",
		Limit: mqttSubscriptionBuffer,
		QoS:   1,
		Wait:  time.Millisecond,
	})
	if err != nil || len(initial) != mqttSubscriptionBuffer {
		t.Fatalf("initial fetch = %d records, err=%v", len(initial), err)
	}

	if !client.emit("devices/rollover", []byte("message-after-rollover")) {
		t.Fatal("subscription route disappeared after initial fetch")
	}
	next, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic:  "devices/rollover",
		Limit:  1,
		Offset: mqttSubscriptionBuffer,
		QoS:    1,
		Wait:   5 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("fetch after buffer rollover: %v", err)
	}
	if len(next) != 1 || string(next[0].Payload) != "message-after-rollover" {
		t.Fatalf("fetch after rollover = %#v, want the first unseen record", next)
	}
}

func TestPahoMQTTRuntimeBoundsBufferedPayloadBytesAndPreservesOffsets(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	const topic = "devices/byte-rollover"
	if _, err := runtime.ensureSubscription(client, topic, 1); err != nil {
		t.Fatalf("ensure subscription: %v", err)
	}
	largePayload := bytes.Repeat([]byte("x"), mqttSubscriptionBufferBytes/2+1)
	if !client.emit(topic, largePayload) || !client.emit(topic, largePayload) {
		t.Fatal("subscription route was not registered")
	}

	buffered, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic: topic,
		Limit: 10,
		QoS:   1,
		Wait:  time.Millisecond,
	})
	if err != nil {
		t.Fatalf("fetch byte-bounded buffer: %v", err)
	}
	if len(buffered) != 1 || buffered[0].StreamOffset != 1 {
		t.Fatalf("byte-bounded buffer = %#v, want only stream offset 1", buffered)
	}

	if !client.emit(topic, []byte("tail")) {
		t.Fatal("subscription route disappeared after byte eviction")
	}
	tail, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic:  topic,
		Limit:  1,
		Offset: 2,
		QoS:    1,
		Wait:   time.Millisecond,
	})
	if err != nil || len(tail) != 1 || tail[0].StreamOffset != 2 || string(tail[0].Payload) != "tail" {
		t.Fatalf("fetch after byte eviction = %#v, err=%v", tail, err)
	}
}

func TestPahoMQTTRuntimeDoesNotPersistSinglePayloadAboveByteLimit(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	const topic = "devices/oversized"
	if _, err := runtime.ensureSubscription(client, topic, 1); err != nil {
		t.Fatalf("ensure subscription: %v", err)
	}
	if !client.emit(topic, bytes.Repeat([]byte("x"), mqttSubscriptionBufferBytes+1)) {
		t.Fatal("subscription route was not registered")
	}
	buffered, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic: topic,
		Limit: 1,
		QoS:   1,
		Wait:  time.Millisecond,
	})
	if err != nil {
		t.Fatalf("fetch oversized buffer: %v", err)
	}
	if len(buffered) != 0 {
		t.Fatalf("oversized payload remained in rolling buffer: offsets=%v", []int{buffered[0].StreamOffset})
	}

	if !client.emit(topic, []byte("after-oversized")) {
		t.Fatal("subscription route disappeared after oversized payload")
	}
	next, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic:  topic,
		Limit:  1,
		Offset: 1,
		QoS:    1,
		Wait:   time.Millisecond,
	})
	if err != nil || len(next) != 1 || next[0].StreamOffset != 1 {
		t.Fatalf("offset after oversized payload = %#v, err=%v", next, err)
	}
}

func TestPahoMQTTRuntimeSharedSubscriptionQoSNeverDowngrades(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	const topic = "devices/shared-qos"
	initial, err := runtime.ensureSubscription(client, topic, 2)
	if err != nil {
		t.Fatalf("ensure QoS 2 subscription: %v", err)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	errors := make(chan error, 64)
	for index := 0; index < 64; index++ {
		qos := byte(index % 3)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			subscription, subscribeErr := runtime.ensureSubscription(client, topic, qos)
			if subscribeErr != nil {
				errors <- subscribeErr
				return
			}
			if subscription != initial {
				errors <- fmt.Errorf("shared subscription instance changed")
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errors)
	for subscribeErr := range errors {
		t.Fatalf("concurrent ensureSubscription: %v", subscribeErr)
	}

	if initial.qos != 2 {
		t.Fatalf("shared subscription QoS = %d, want monotonic maximum 2", initial.qos)
	}
	if subscribe, unsubscribe := client.callCounts(); subscribe != 1 || unsubscribe != 0 {
		t.Fatalf("subscription churn = subscribe:%d unsubscribe:%d, want 1/0", subscribe, unsubscribe)
	}
}

func TestPahoMQTTRuntimeSharedSubscriptionQoSOnlyUpgrades(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	const topic = "devices/qos-upgrade"
	var initial *mqttSharedSubscription
	for _, qos := range []byte{0, 1, 0, 2, 1, 2} {
		subscription, err := runtime.ensureSubscription(client, topic, qos)
		if err != nil {
			t.Fatalf("ensure QoS %d subscription: %v", qos, err)
		}
		if initial == nil {
			initial = subscription
		} else if subscription != initial {
			t.Fatal("QoS upgrade replaced the shared subscription")
		}
	}
	if initial.qos != 2 {
		t.Fatalf("shared subscription QoS = %d, want 2", initial.qos)
	}
	if got := client.subscribedQoS(); !bytes.Equal(got, []byte{0, 1, 2}) {
		t.Fatalf("broker subscription QoS calls = %v, want [0 1 2]", got)
	}
}

func TestPahoMQTTRuntimeConcurrentFetchesShareSubscription(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	ctxA, cancelA := context.WithCancel(context.Background())
	resultA := make(chan error, 1)
	go func() {
		_, err := runtime.FetchMessages(ctxA, mqttFetchRequest{
			Topic: "devices/shared",
			Limit: 1,
			QoS:   1,
			Wait:  time.Second,
		})
		resultA <- err
	}()

	var subscription *mqttSharedSubscription
	waitForMQTTSubscriptionTest(t, func() bool {
		runtime.subscriptionsMu.Lock()
		subscription = runtime.subscriptions["devices/shared"]
		runtime.subscriptionsMu.Unlock()
		return subscription != nil && mqttSubscriptionWaiterCount(subscription) == 1
	}, "first MQTT fetch waiter")

	resultB := make(chan []mqttMessageRecord, 1)
	errorB := make(chan error, 1)
	go func() {
		records, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
			Topic: "devices/shared",
			Limit: 1,
			QoS:   1,
			Wait:  time.Second,
		})
		resultB <- records
		errorB <- err
	}()
	waitForMQTTSubscriptionTest(t, func() bool {
		return mqttSubscriptionWaiterCount(subscription) == 2
	}, "second MQTT fetch waiter")

	cancelA()
	if err := <-resultA; err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("first fetch error = %v, want context canceled", err)
	}
	waitForMQTTSubscriptionTest(t, func() bool {
		return mqttSubscriptionWaiterCount(subscription) == 1
	}, "first MQTT fetch waiter cleanup")

	if !client.emit("devices/shared", []byte("fan-out")) {
		t.Fatal("shared subscription route was removed while another fetch was active")
	}
	if err := <-errorB; err != nil {
		t.Fatalf("second fetch failed: %v", err)
	}
	records := <-resultB
	if len(records) != 1 || string(records[0].Payload) != "fan-out" {
		t.Fatalf("second fetch records = %#v", records)
	}
	if subscribe, unsubscribe := client.callCounts(); subscribe != 1 || unsubscribe != 0 {
		t.Fatalf("shared subscription calls before close = subscribe:%d unsubscribe:%d, want 1/0", subscribe, unsubscribe)
	}
}

func TestPahoMQTTRuntimeUnsubscribeRemovesSubscriptionAndWakesWaiters(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	const topic = "devices/interactive"
	fetchResult := make(chan error, 1)
	go func() {
		_, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
			Topic: topic,
			Limit: 1,
			QoS:   1,
			Wait:  time.Second,
		})
		fetchResult <- err
	}()

	var subscription *mqttSharedSubscription
	waitForMQTTSubscriptionTest(t, func() bool {
		runtime.subscriptionsMu.Lock()
		subscription = runtime.subscriptions[topic]
		runtime.subscriptionsMu.Unlock()
		return subscription != nil && mqttSubscriptionWaiterCount(subscription) == 1
	}, "interactive MQTT fetch waiter")

	removed, err := runtime.Unsubscribe(context.Background(), topic)
	if err != nil || !removed {
		t.Fatalf("Unsubscribe = removed:%v err:%v, want true/nil", removed, err)
	}
	select {
	case fetchErr := <-fetchResult:
		if fetchErr == nil || !strings.Contains(fetchErr.Error(), "订阅已取消") {
			t.Fatalf("waiting fetch error = %v, want subscription-cancelled error", fetchErr)
		}
	case <-time.After(time.Second):
		t.Fatal("waiting fetch was not woken by Unsubscribe")
	}
	if got := mqttSubscriptionWaiterCount(subscription); got != 0 {
		t.Fatalf("waiters after Unsubscribe = %d, want 0", got)
	}
	runtime.subscriptionsMu.Lock()
	_, exists := runtime.subscriptions[topic]
	runtime.subscriptionsMu.Unlock()
	if exists {
		t.Fatal("Unsubscribe left the topic in the runtime subscription map")
	}
	if subscribe, unsubscribe := client.callCounts(); subscribe != 1 || unsubscribe != 1 {
		t.Fatalf("subscription calls = subscribe:%d unsubscribe:%d, want 1/1", subscribe, unsubscribe)
	}

	removed, err = runtime.Unsubscribe(context.Background(), topic)
	if err != nil || removed {
		t.Fatalf("idempotent Unsubscribe = removed:%v err:%v, want false/nil", removed, err)
	}
	if _, unsubscribe := client.callCounts(); unsubscribe != 1 {
		t.Fatalf("idempotent Unsubscribe called broker %d times, want 1", unsubscribe)
	}
}

func TestPahoMQTTRuntimeConcurrentUnsubscribeEnsureAndCloseIsSafe(t *testing.T) {
	const topic = "devices/concurrent-cancel"
	for round := 0; round < 40; round++ {
		client := newMQTTSubscriptionTestClient()
		runtime := newMQTTSubscriptionTestRuntime(client)
		if _, err := runtime.ensureSubscription(client, topic, 1); err != nil {
			t.Fatalf("round %d initial subscription: %v", round, err)
		}

		start := make(chan struct{})
		finished := make(chan struct{})
		var wg sync.WaitGroup
		for index := 0; index < 16; index++ {
			wg.Add(1)
			go func(operation int) {
				defer wg.Done()
				<-start
				if operation%2 == 0 {
					_, _ = runtime.Unsubscribe(context.Background(), topic)
					return
				}
				_, _ = runtime.ensureSubscription(client, topic, byte(operation%3))
			}(index)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_ = runtime.Close()
		}()
		close(start)
		go func() {
			wg.Wait()
			close(finished)
		}()
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Fatalf("round %d deadlocked", round)
		}

		if !runtime.isClosed() {
			t.Fatalf("round %d runtime remained open", round)
		}
		runtime.subscriptionsMu.Lock()
		remaining := len(runtime.subscriptions)
		runtime.subscriptionsMu.Unlock()
		if remaining != 0 {
			t.Fatalf("round %d left %d runtime subscriptions", round, remaining)
		}
		if client.emit(topic, []byte("after-close")) {
			t.Fatalf("round %d left broker callback route installed", round)
		}
	}
}

func TestPahoMQTTRuntimeReportsRejectedSubscription(t *testing.T) {
	client := newMQTTSubscriptionTestClient()
	client.subscribeCode = 0x80
	runtime := newMQTTSubscriptionTestRuntime(client)
	t.Cleanup(func() { _ = runtime.Close() })

	_, err := runtime.ensureSubscription(client, "denied/topic", 1)
	if err == nil || !strings.Contains(err.Error(), "订阅被 Broker 拒绝") {
		t.Fatalf("rejected subscription error = %v", err)
	}
	if subscribe, unsubscribe := client.callCounts(); subscribe != 1 || unsubscribe != 1 {
		t.Fatalf("rejected subscription cleanup = subscribe:%d unsubscribe:%d, want 1/1", subscribe, unsubscribe)
	}
}
