package webserver

import (
	"reflect"
	"strings"
	"sync"
)

type eventMessage struct {
	Name string `json:"name"`
	Args []any  `json:"args,omitempty"`
}

type eventHub struct {
	mu          sync.RWMutex
	subscribers map[*eventSubscriber]struct{}
}

func newEventHub() *eventHub {
	return &eventHub{subscribers: make(map[*eventSubscriber]struct{})}
}

type eventSubscriber struct {
	targetID string

	mu     sync.Mutex
	queue  []eventMessage
	head   int
	wake   chan struct{}
	done   chan struct{}
	closed bool
}

func newEventSubscriber(targetID string) *eventSubscriber {
	return &eventSubscriber{
		targetID: strings.TrimSpace(targetID),
		wake:     make(chan struct{}, 1),
		done:     make(chan struct{}),
	}
}

func (s *eventSubscriber) enqueue(msg eventMessage, reliable bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.coalesceQueuedEventLocked(msg) {
		s.mu.Unlock()
		select {
		case s.wake <- struct{}{}:
		default:
		}
		return
	}
	if s.closed {
		s.mu.Unlock()
		return
	}
	queueLen := len(s.queue) - s.head
	if reliable && queueLen >= eventSubscriberReliableQueueLimit {
		// Reliable delivery cannot silently drop the event, but retaining it
		// forever would make a stalled detached window an unbounded memory
		// sink. Close this stream and release its pending payloads; the child
		// runtime will reconnect and obtain fresh state.
		s.closed = true
		s.queue = nil
		s.head = 0
		close(s.done)
		s.mu.Unlock()
		return
	}
	if !reliable && queueLen >= eventSubscriberQueueLimit {
		s.mu.Unlock()
		return
	}
	s.queue = append(s.queue, msg)
	s.mu.Unlock()

	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *eventSubscriber) coalesceQueuedEventLocked(incoming eventMessage) bool {
	if s == nil || s.closed {
		return false
	}
	key := detachedSyncEventKey(incoming)
	if key == "" {
		return false
	}
	for index := len(s.queue) - 1; index >= s.head; index-- {
		if detachedSyncEventKey(s.queue[index]) == key {
			s.queue[index] = incoming
			return true
		}
	}
	return false
}

func detachedSyncEventKey(msg eventMessage) string {
	if msg.Name != "gonavi:native-detached-event" || len(msg.Args) != 1 {
		return ""
	}
	value := reflect.ValueOf(msg.Args[0])
	for value.IsValid() && (value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer) {
		if value.IsNil() {
			return ""
		}
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return ""
	}
	idField := value.FieldByName("ID")
	actionField := value.FieldByName("Action")
	if !idField.IsValid() ||
		idField.Kind() != reflect.String ||
		!actionField.IsValid() ||
		actionField.Kind() != reflect.String ||
		actionField.String() != "sync" {
		return ""
	}
	id := strings.TrimSpace(idField.String())
	if id == "" {
		return ""
	}
	return "detached-sync:" + id
}

func (s *eventSubscriber) dequeue() (eventMessage, bool) {
	if s == nil {
		return eventMessage{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.head >= len(s.queue) {
		return eventMessage{}, false
	}
	msg := s.queue[s.head]
	s.queue[s.head] = eventMessage{}
	s.head++
	if s.head == len(s.queue) {
		s.queue = nil
		s.head = 0
	} else if s.head >= eventSubscriberQueueLimit && s.head*2 >= len(s.queue) {
		remaining := append([]eventMessage(nil), s.queue[s.head:]...)
		s.queue = remaining
		s.head = 0
	}
	return msg, true
}

func (s *eventSubscriber) close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.queue = nil
	s.head = 0
	close(s.done)
	s.mu.Unlock()
}

func (h *eventHub) Emit(name string, args ...any) {
	if h == nil || strings.TrimSpace(name) == "" {
		return
	}
	msg := eventMessage{Name: name, Args: args}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for subscriber := range h.subscribers {
		subscriber.enqueue(msg, false)
	}
}

func (h *eventHub) EmitTo(targetID string, name string, args ...any) {
	h.emitTo(targetID, name, true, args...)
}

func (h *eventHub) EmitToBestEffort(targetID string, name string, args ...any) {
	h.emitTo(targetID, name, false, args...)
}

func (h *eventHub) emitTo(targetID string, name string, reliable bool, args ...any) {
	if h == nil || strings.TrimSpace(targetID) == "" || strings.TrimSpace(name) == "" {
		return
	}
	msg := eventMessage{Name: name, Args: args}
	targetID = strings.TrimSpace(targetID)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for subscriber := range h.subscribers {
		if subscriber.targetID == targetID {
			subscriber.enqueue(msg, reliable)
		}
	}
}

func (h *eventHub) subscribe(targetID string) *eventSubscriber {
	subscriber := newEventSubscriber(targetID)
	h.mu.Lock()
	h.subscribers[subscriber] = struct{}{}
	h.mu.Unlock()
	return subscriber
}

func (h *eventHub) unsubscribe(subscriber *eventSubscriber) {
	if h == nil || subscriber == nil {
		return
	}
	h.mu.Lock()
	if _, ok := h.subscribers[subscriber]; ok {
		delete(h.subscribers, subscriber)
		subscriber.close()
	}
	h.mu.Unlock()
}
