package db

import (
	"context"
	"fmt"
	"sync"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
)

const (
	defaultMQTTPort             = 1883
	defaultMQTTQueryTimeout     = 30 * time.Second
	defaultMQTTPreviewLimit     = 100
	defaultMQTTFetchWait        = 4 * time.Second
	maxMQTTFetchWait            = 30 * time.Second
	mqttSubscriptionBuffer      = 1024
	mqttSubscriptionBufferBytes = 8 * 1024 * 1024
	mqttSyntheticDatabase       = "topics"
	mqttDefaultClientID         = "GoNavi"
)

type mqttRuntime interface {
	Close() error
	Ping(ctx context.Context) error
	FetchMessages(ctx context.Context, request mqttFetchRequest) ([]mqttMessageRecord, error)
	Publish(ctx context.Context, command mqttPublishCommand) (int64, error)
	Unsubscribe(ctx context.Context, topic string) (bool, error)
}

type mqttFetchRequest struct {
	Topic  string
	Limit  int
	Offset int
	QoS    byte
	Wait   time.Duration
}

type mqttPublishCommand struct {
	Topic   string
	Payload interface{}
	QoS     byte
	Retain  bool
}

type mqttMessageRecord struct {
	StreamOffset int
	Topic        string
	QoS          byte
	Retained     bool
	Duplicate    bool
	MessageID    uint16
	Payload      []byte
	Decoded      interface{}
	Encoding     string
	ReceivedAt   time.Time
}

type mqttTopicDescriptor struct {
	Filter   string
	Default  bool
	Wildcard bool
	Source   string
}

// mqttSharedSubscription owns the single Paho route for one Topic filter.
// Queries attach lightweight waiters to it instead of repeatedly replacing
// Paho's one-callback-per-filter route and unsubscribing each other.
type mqttSharedSubscription struct {
	topic string
	qos   byte
	done  chan struct{}

	mu                  sync.Mutex
	closed              bool
	records             []mqttMessageRecord
	recordsPayloadBytes int
	nextStreamOffset    int
	waiters             map[uint64]chan mqttMessageRecord
	nextID              uint64
	terminationErr      error
	closeOnce           sync.Once
}

func newMQTTSharedSubscription(topic string, qos byte) *mqttSharedSubscription {
	return &mqttSharedSubscription{
		topic:   topic,
		qos:     qos,
		done:    make(chan struct{}),
		waiters: make(map[uint64]chan mqttMessageRecord),
	}
}

func (s *mqttSharedSubscription) handleMessage(message pahomqtt.Message) {
	record := mqttRecordFromMessage(message)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	record.StreamOffset = s.nextStreamOffset
	s.nextStreamOffset++

	// An oversized message is still delivered to waiters that are currently
	// consuming the topic, but retaining it would violate the rolling-buffer
	// memory bound all by itself.
	payloadBytes := len(record.Payload)
	if payloadBytes <= mqttSubscriptionBufferBytes {
		dropCount := 0
		retainedBytes := s.recordsPayloadBytes
		for dropCount < len(s.records) && (len(s.records)-dropCount >= mqttSubscriptionBuffer ||
			retainedBytes+payloadBytes > mqttSubscriptionBufferBytes) {
			retainedBytes -= len(s.records[dropCount].Payload)
			dropCount++
		}
		if dropCount > 0 {
			remaining := copy(s.records, s.records[dropCount:])
			clear(s.records[remaining:])
			s.records = s.records[:remaining]
		}
		s.recordsPayloadBytes = retainedBytes
		s.records = append(s.records, record)
		s.recordsPayloadBytes += payloadBytes
	}
	for _, waiter := range s.waiters {
		select {
		case waiter <- record:
		default:
		}
	}
}

// addWaiter registers the live delivery channel and snapshots buffered records
// under the same lock. A message is therefore observed either in the snapshot
// or on the channel, never lost in the hand-off and never duplicated by it.
func (s *mqttSharedSubscription) addWaiter(bufferSize int) (
	uint64,
	<-chan mqttMessageRecord,
	[]mqttMessageRecord,
	error,
) {
	if bufferSize < 1 {
		bufferSize = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, nil, nil, s.terminationErrorLocked()
	}
	s.nextID++
	id := s.nextID
	messageCh := make(chan mqttMessageRecord, bufferSize)
	s.waiters[id] = messageCh
	return id, messageCh, append([]mqttMessageRecord(nil), s.records...), nil
}

func (s *mqttSharedSubscription) removeWaiter(id uint64) {
	s.mu.Lock()
	delete(s.waiters, id)
	s.mu.Unlock()
}

func (s *mqttSharedSubscription) terminationErrorLocked() error {
	if s.terminationErr != nil {
		return s.terminationErr
	}
	return fmt.Errorf("MQTT 连接已断开")
}

func (s *mqttSharedSubscription) terminationError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.terminationErrorLocked()
}

func (s *mqttSharedSubscription) terminate(err error) {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.terminationErr = err
		s.waiters = nil
		s.mu.Unlock()
		close(s.done)
	})
}

func (s *mqttSharedSubscription) close() {
	s.terminate(fmt.Errorf("MQTT 连接已断开"))
}
