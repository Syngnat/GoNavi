package db

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
)

type pahoMQTTRuntime struct {
	// mu 保护 client/closed。FetchMessages 和 Publish 会持有客户端快照，保活失败或用户
	// 断开可并发调用 Close()。若 Close 直接把 client 置 nil，在途读者的接口方法调用会
	// panic 并崩掉整个 Wails 桌面进程，因此 Close 只置 closed 标志并保留字段。
	mu      sync.RWMutex
	client  pahomqtt.Client
	closed  bool
	timeout time.Duration

	subscriptionsMu sync.Mutex
	subscriptions   map[string]*mqttSharedSubscription
}

// activeClient 取出可用的客户端快照。调用方必须全程只使用返回的局部变量，
// 不能再读 r.client，否则并发 Close 会重新引入竞争。
func (r *pahoMQTTRuntime) activeClient() (pahomqtt.Client, error) {
	if r == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.closed || r.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return r.client, nil
}

func (r *pahoMQTTRuntime) isClosed() bool {
	if r == nil {
		return true
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.closed || r.client == nil
}

type mqttSubscribeResultToken interface {
	Result() map[string]byte
}

func mqttSubscribeGrantError(token pahomqtt.Token, topic string) error {
	resultToken, ok := token.(mqttSubscribeResultToken)
	if !ok {
		return nil
	}
	for _, returnCode := range resultToken.Result() {
		if returnCode > 2 {
			return fmt.Errorf("MQTT 订阅被 Broker 拒绝：topic=%s returnCode=0x%02X", topic, returnCode)
		}
	}
	return nil
}

func (r *pahoMQTTRuntime) cleanupFailedSubscription(client pahomqtt.Client, topic string) {
	token := client.Unsubscribe(topic)
	if !token.WaitTimeout(r.timeout) {
		logger.Warnf("MQTT 清理失败订阅超时：%s", topic)
		return
	}
	if err := token.Error(); err != nil {
		logger.Warnf("MQTT 清理失败订阅异常：topic=%s err=%v", topic, err)
	}
}

func (r *pahoMQTTRuntime) ensureSubscription(client pahomqtt.Client, topic string, qos byte) (*mqttSharedSubscription, error) {
	topic = strings.TrimSpace(topic)
	if topic == "" {
		return nil, fmt.Errorf("MQTT topic 不能为空")
	}

	r.subscriptionsMu.Lock()
	defer r.subscriptionsMu.Unlock()
	if r.isClosed() {
		return nil, fmt.Errorf("MQTT 连接已断开")
	}
	if r.subscriptions == nil {
		r.subscriptions = make(map[string]*mqttSharedSubscription)
	}
	if subscription := r.subscriptions[topic]; subscription != nil {
		// One broker subscription is shared by every consumer of the same
		// filter. A higher broker-side QoS satisfies lower-QoS readers too, so
		// only upgrade the shared route and never let a later low-QoS query
		// downgrade it or cause subscribe churn.
		if qos <= subscription.qos {
			return subscription, nil
		}
		// Re-subscribing the same filter updates the broker-side QoS while
		// preserving the shared buffer and all query waiters. Do not unsubscribe
		// on a failed QoS update: the previous subscription is still useful and
		// its callback already targets this same shared subscription.
		token := client.Subscribe(topic, qos, func(_ pahomqtt.Client, message pahomqtt.Message) {
			subscription.handleMessage(message)
		})
		if !token.WaitTimeout(r.timeout) {
			return nil, localizedDatabaseRuntimeError("db.backend.error.mqtt_subscribe_timeout", nil)
		}
		if err := token.Error(); err != nil {
			return nil, fmt.Errorf("MQTT 更新订阅 QoS 失败：%w", err)
		}
		if err := mqttSubscribeGrantError(token, topic); err != nil {
			return nil, err
		}
		subscription.qos = qos
		return subscription, nil
	}

	subscription := newMQTTSharedSubscription(topic, qos)
	token := client.Subscribe(topic, qos, func(_ pahomqtt.Client, message pahomqtt.Message) {
		subscription.handleMessage(message)
	})
	if !token.WaitTimeout(r.timeout) {
		r.cleanupFailedSubscription(client, topic)
		return nil, localizedDatabaseRuntimeError("db.backend.error.mqtt_subscribe_timeout", nil)
	}
	if err := token.Error(); err != nil {
		r.cleanupFailedSubscription(client, topic)
		return nil, fmt.Errorf("MQTT 订阅失败：%w", err)
	}
	if err := mqttSubscribeGrantError(token, topic); err != nil {
		r.cleanupFailedSubscription(client, topic)
		return nil, err
	}
	r.subscriptions[topic] = subscription
	return subscription, nil
}

func (r *pahoMQTTRuntime) subscribeConfiguredTopics(client pahomqtt.Client, config connection.ConnectionConfig) error {
	defaultTopic := mqttDefaultTopic(config)
	for _, topic := range mqttConfiguredTopics(config, defaultTopic) {
		if _, err := r.ensureSubscription(client, topic.Filter, mqttDefaultQoS(config)); err != nil {
			return err
		}
	}
	return nil
}

var newMQTTRuntime = func(config connection.ConnectionConfig) (mqttRuntime, error) {
	return newPahoMQTTRuntime(config)
}

func (r *pahoMQTTRuntime) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	if r.closed || r.client == nil {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	client := r.client
	r.mu.Unlock()

	r.subscriptionsMu.Lock()
	topics := make([]string, 0, len(r.subscriptions))
	for topic, subscription := range r.subscriptions {
		topics = append(topics, topic)
		subscription.close()
	}
	r.subscriptions = make(map[string]*mqttSharedSubscription)
	r.subscriptionsMu.Unlock()
	if len(topics) > 0 && client.IsConnectionOpen() {
		unsub := client.Unsubscribe(topics...)
		if !unsub.WaitTimeout(r.timeout) {
			logger.Warnf("MQTT 关闭连接时取消订阅超时：topics=%s", strings.Join(topics, ","))
		} else if err := unsub.Error(); err != nil {
			logger.Warnf("MQTT 关闭连接时取消订阅失败：topics=%s err=%v", strings.Join(topics, ","), err)
		}
	}

	// 只断开连接，不把 r.client 置 nil：仍在等待消息的 FetchMessages 持有客户端快照，
	// 置 nil 会让并发路径重新出现接口空指针竞争。
	client.Disconnect(250)
	return nil
}

func (r *pahoMQTTRuntime) Ping(ctx context.Context) error {
	client, err := r.activeClient()
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if !client.IsConnectionOpen() {
		return fmt.Errorf("MQTT 连接已断开")
	}
	return nil
}

func (r *pahoMQTTRuntime) FetchMessages(ctx context.Context, request mqttFetchRequest) ([]mqttMessageRecord, error) {
	// 一次性取快照：下面要等待 4~30 秒，期间并发 Close 不能让本函数的解引用失效。
	client, err := r.activeClient()
	if err != nil {
		return nil, err
	}
	if !client.IsConnectionOpen() {
		return nil, fmt.Errorf("MQTT 连接已断开")
	}

	limit := request.Limit
	if limit <= 0 {
		limit = defaultMQTTPreviewLimit
	}
	offset := request.Offset
	if offset < 0 {
		offset = 0
	}
	wait := request.Wait
	if wait <= 0 {
		wait = defaultMQTTFetchWait
	}
	if wait > maxMQTTFetchWait {
		wait = maxMQTTFetchWait
	}

	bufferSize := limit + offset + 8
	if bufferSize < 8 {
		bufferSize = 8
	}
	if bufferSize > 1024 {
		bufferSize = 1024
	}
	subscription, err := r.ensureSubscription(client, request.Topic, request.QoS)
	if err != nil {
		return nil, err
	}
	waiterID, messageCh, buffered, err := subscription.addWaiter(bufferSize)
	if err != nil {
		return nil, err
	}
	defer subscription.removeWaiter(waiterID)

	timer := time.NewTimer(wait)
	defer timer.Stop()

	result := make([]mqttMessageRecord, 0, limit)
	for _, record := range buffered {
		if record.StreamOffset < offset {
			continue
		}
		result = append(result, record)
		if len(result) >= limit {
			return result, nil
		}
	}
	for len(result) < limit {
		select {
		case <-ctx.Done():
			if len(result) > 0 {
				return result, nil
			}
			return nil, ctx.Err()
		case <-timer.C:
			return result, nil
		case <-subscription.done:
			if len(result) > 0 {
				return result, nil
			}
			return nil, subscription.terminationError()
		case record := <-messageCh:
			if record.StreamOffset < offset {
				continue
			}
			result = append(result, record)
		}
	}
	return result, nil
}

func (r *pahoMQTTRuntime) Unsubscribe(ctx context.Context, topic string) (bool, error) {
	client, err := r.activeClient()
	if err != nil {
		return false, err
	}
	topic = strings.TrimSpace(topic)
	if topic == "" {
		return false, fmt.Errorf("MQTT topic 不能为空")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return false, ctx.Err()
	default:
	}

	r.subscriptionsMu.Lock()
	defer r.subscriptionsMu.Unlock()
	if r.isClosed() {
		return false, fmt.Errorf("MQTT 连接已断开")
	}
	select {
	case <-ctx.Done():
		return false, ctx.Err()
	default:
	}
	subscription := r.subscriptions[topic]
	if subscription == nil {
		return false, nil
	}
	wait := r.timeout
	if wait <= 0 {
		wait = 10 * time.Second
	}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false, ctx.Err()
		}
		if remaining < wait {
			wait = remaining
		}
	}

	// Remove the local generation before contacting the broker so every
	// waiter is woken immediately. Holding subscriptionsMu through the broker
	// token prevents ensureSubscription from installing a newer generation
	// that this UNSUBSCRIBE packet could accidentally remove.
	delete(r.subscriptions, topic)
	subscription.terminate(fmt.Errorf("MQTT 订阅已取消：%s", topic))
	token := client.Unsubscribe(topic)
	if !token.WaitTimeout(wait) {
		if err := ctx.Err(); err != nil {
			return true, err
		}
		return true, fmt.Errorf("MQTT 取消订阅超时：topic=%s", topic)
	}
	if err := token.Error(); err != nil {
		return true, fmt.Errorf("MQTT 取消订阅失败：topic=%s: %w", topic, err)
	}
	return true, nil
}

func (r *pahoMQTTRuntime) Publish(ctx context.Context, command mqttPublishCommand) (int64, error) {
	client, err := r.activeClient()
	if err != nil {
		return 0, err
	}
	if !client.IsConnectionOpen() {
		return 0, fmt.Errorf("MQTT 连接已断开")
	}
	payload, err := mqttEncodePayload(command.Payload)
	if err != nil {
		return 0, err
	}
	token := client.Publish(command.Topic, command.QoS, command.Retain, payload)
	wait := r.timeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < wait {
			wait = remaining
		}
	}
	if !token.WaitTimeout(wait) {
		return 0, localizedDatabaseRuntimeError("db.backend.error.mqtt_publish_timeout", nil)
	}
	if err := token.Error(); err != nil {
		return 0, err
	}
	return 1, nil
}
