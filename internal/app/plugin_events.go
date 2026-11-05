package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/plugin"
)

// Event subscriptions stay bounded and die with the plugin's generation.
const (
	pluginEventsPermission     = "host.events"
	pluginEventsMaxTopics      = 8
	pluginEventsMaxPerPlugin   = 4
	pluginEventsMaxTotal       = 64
	pluginEventsMaxQueued      = 64
	pluginEventsDefaultWait    = 20 * time.Second
	pluginEventsMaxWait        = 25 * time.Second
	pluginEventsPollInterval   = 400 * time.Millisecond
	pluginEventsMaxIDBytes     = 64
	pluginEventsMaxTopicBytes  = 64
	pluginEventsMaxCustomBytes = 16 << 10
)

var pluginEventKnownTopics = map[string]bool{
	"preferences": true,
	"lifecycle":   true,
	"connections": true,
	"custom":      true,
}

type pluginEvent struct {
	Topic string `json:"topic"`
	Data  any    `json:"data"`
}

type pluginEventSnapshot struct {
	value string
	data  any
}

type pluginEventSubscription struct {
	pluginID   string
	generation uint64
	topics     map[string]bool
	last       map[string]string
	queue      []pluginEvent
	polling    bool
	createdAt  time.Time
}

type pluginEventBroker struct {
	mu     sync.Mutex
	subs   map[string]*pluginEventSubscription
	custom map[string][]pluginEvent
}

type pluginEventsSubscribeArguments struct {
	Topics []string `json:"topics"`
}

type pluginEventsPollArguments struct {
	SubscriptionID string `json:"subscriptionId"`
	WaitMs         int    `json:"waitMs,omitempty"`
}

type pluginEventsUnsubscribeArguments struct {
	SubscriptionID string `json:"subscriptionId"`
}

func pluginCapabilityEventsSubscribe(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if a == nil {
		return nil, "internal"
	}
	var arguments pluginEventsSubscribeArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	topics, ok := normalizePluginEventTopics(arguments.Topics)
	if !ok {
		return nil, "invalid_arguments"
	}
	return a.pluginEvents.subscribe(a, request.Status, topics)
}

func pluginCapabilityEventsPoll(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if a == nil {
		return nil, "internal"
	}
	var arguments pluginEventsPollArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	wait := pluginEventsDefaultWait
	if arguments.WaitMs > 0 {
		wait = time.Duration(arguments.WaitMs) * time.Millisecond
	}
	if wait > pluginEventsMaxWait {
		wait = pluginEventsMaxWait
	}
	events, code := a.pluginEvents.poll(ctx, a, request.Status, arguments.SubscriptionID, wait)
	if code != "" {
		return nil, code
	}
	return map[string]any{"events": events}, ""
}

type pluginEventsPublishArguments struct {
	Topic string          `json:"topic"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// pluginCapabilityEventsPublish queues one plugin-defined event for its own
// pages and windows. It never reaches other plugins, and the payload is bounded
// before it is stored.
func pluginCapabilityEventsPublish(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if a == nil {
		return nil, "internal"
	}
	var arguments pluginEventsPublishArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	topic := strings.TrimSpace(arguments.Topic)
	if topic == "" || len(topic) > pluginEventsMaxTopicBytes || !utf8.ValidString(topic) {
		return nil, "invalid_arguments"
	}
	data := arguments.Data
	if len(data) == 0 {
		data = json.RawMessage(`null`)
	}
	if len(data) > pluginEventsMaxCustomBytes || !json.Valid(data) {
		return nil, "invalid_arguments"
	}
	a.pluginEvents.publish(request.Status.Manifest.ID, topic, data)
	return map[string]any{"accepted": true}, ""
}

func pluginCapabilityEventsUnsubscribe(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if a == nil {
		return nil, "internal"
	}
	var arguments pluginEventsUnsubscribeArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	removed := a.pluginEvents.unsubscribe(request.Status, arguments.SubscriptionID)
	return map[string]any{"removed": removed}, ""
}

func normalizePluginEventTopics(values []string) ([]string, bool) {
	if len(values) == 0 || len(values) > pluginEventsMaxTopics {
		return nil, false
	}
	seen := make(map[string]bool, len(values))
	topics := make([]string, 0, len(values))
	for _, value := range values {
		topic := strings.TrimSpace(value)
		if !pluginEventKnownTopics[topic] || seen[topic] {
			return nil, false
		}
		seen[topic] = true
		topics = append(topics, topic)
	}
	return topics, true
}

func (b *pluginEventBroker) subscribe(a *App, status plugin.Status, topics []string) (any, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.subs == nil {
		b.subs = make(map[string]*pluginEventSubscription)
	}
	// Drop subscriptions from an earlier generation of the same plugin.
	active, total := 0, 0
	for id, sub := range b.subs {
		if sub.pluginID == status.Manifest.ID && sub.generation != status.Generation {
			delete(b.subs, id)
			continue
		}
		if sub.pluginID == status.Manifest.ID {
			active++
		}
		total++
	}
	if active >= pluginEventsMaxPerPlugin || total >= pluginEventsMaxTotal {
		return nil, "limit_exceeded"
	}
	id, err := newPluginEventID()
	if err != nil {
		return nil, "internal"
	}
	sub := &pluginEventSubscription{
		pluginID:   status.Manifest.ID,
		generation: status.Generation,
		topics:     make(map[string]bool, len(topics)),
		last:       make(map[string]string, len(topics)),
		createdAt:  time.Now(),
	}
	snapshot := make(map[string]any, len(topics))
	for _, topic := range topics {
		sub.topics[topic] = true
		value := a.pluginEventSnapshot(status, topic)
		sub.last[topic] = value.value
		snapshot[topic] = value.data
	}
	b.subs[id] = sub
	return map[string]any{"subscriptionId": id, "snapshot": snapshot}, ""
}

func (b *pluginEventBroker) poll(ctx context.Context, a *App, status plugin.Status, id string, wait time.Duration) ([]pluginEvent, string) {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > pluginEventsMaxIDBytes {
		return nil, "invalid_arguments"
	}
	b.mu.Lock()
	sub := b.subs[id]
	if sub == nil || sub.pluginID != status.Manifest.ID || sub.generation != status.Generation {
		b.mu.Unlock()
		return nil, "unknown_subscription"
	}
	if sub.polling {
		b.mu.Unlock()
		return nil, "busy"
	}
	sub.polling = true
	if events := drainPluginEvents(sub); len(events) > 0 {
		b.mu.Unlock()
		sub.polling = false
		return events, ""
	}
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		if current := b.subs[id]; current != nil {
			current.polling = false
		}
		b.mu.Unlock()
	}()

	deadline := time.Now().Add(wait)
	for {
		if ctx.Err() != nil {
			return nil, "internal"
		}
		if b.customSubscribed(id, status.Manifest.ID) {
			if events := b.drainCustom(status.Manifest.ID); len(events) > 0 {
				return events, ""
			}
		}
		b.mu.Lock()
		current := b.subs[id]
		if current == nil {
			b.mu.Unlock()
			return nil, "unknown_subscription"
		}
		last := current.last
		topics := make([]string, 0, len(current.topics))
		for topic := range current.topics {
			topics = append(topics, topic)
		}
		b.mu.Unlock()

		sort.Strings(topics)
		changed := make([]pluginEvent, 0, len(topics))
		next := make(map[string]string, len(topics))
		for _, topic := range topics {
			value := a.pluginEventSnapshot(status, topic)
			next[topic] = value.value
			if last[topic] != value.value {
				changed = append(changed, pluginEvent{Topic: topic, Data: value.data})
			}
		}
		if len(changed) > 0 {
			b.mu.Lock()
			current = b.subs[id]
			if current == nil {
				b.mu.Unlock()
				return nil, "unknown_subscription"
			}
			for topic, value := range next {
				current.last[topic] = value
			}
			current.queue = append(current.queue, changed...)
			if len(current.queue) > pluginEventsMaxQueued {
				current.queue = current.queue[len(current.queue)-pluginEventsMaxQueued:]
			}
			events := drainPluginEvents(current)
			b.mu.Unlock()
			return events, ""
		}
		if time.Now().After(deadline) {
			return []pluginEvent{}, ""
		}
		select {
		case <-ctx.Done():
			return nil, "internal"
		case <-time.After(pluginEventsPollInterval):
		}
	}
}

// publish appends one plugin-defined event to that plugin's own queue.
func (b *pluginEventBroker) publish(pluginID, topic string, data json.RawMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.custom == nil {
		b.custom = make(map[string][]pluginEvent)
	}
	queue := append(b.custom[pluginID], pluginEvent{Topic: "custom", Data: map[string]any{"topic": topic, "data": data}})
	if len(queue) > pluginEventsMaxQueued {
		queue = queue[len(queue)-pluginEventsMaxQueued:]
	}
	b.custom[pluginID] = queue
}

func (b *pluginEventBroker) drainCustom(pluginID string) []pluginEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	queue := b.custom[pluginID]
	if len(queue) == 0 {
		return nil
	}
	b.custom[pluginID] = nil
	return append([]pluginEvent(nil), queue...)
}

func (b *pluginEventBroker) unsubscribe(status plugin.Status, id string) bool {
	id = strings.TrimSpace(id)
	b.mu.Lock()
	defer b.mu.Unlock()
	sub := b.subs[id]
	if sub == nil || sub.pluginID != status.Manifest.ID || sub.generation != status.Generation {
		return false
	}
	delete(b.subs, id)
	return true
}

func (b *pluginEventBroker) customSubscribed(id, pluginID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	sub := b.subs[id]
	return sub != nil && sub.pluginID == pluginID && sub.topics["custom"]
}

func drainPluginEvents(sub *pluginEventSubscription) []pluginEvent {
	if len(sub.queue) == 0 {
		return []pluginEvent{}
	}
	events := append([]pluginEvent(nil), sub.queue...)
	sub.queue = nil
	return events
}

// pluginEventSnapshot returns the comparable value and the payload published
// when that value changes. Snapshots never carry credentials or connection
// configuration: callers only learn that something changed.
func (a *App) pluginEventSnapshot(status plugin.Status, topic string) pluginEventSnapshot {
	switch topic {
	case "preferences":
		locale := a.pluginPageLocale()
		return pluginEventSnapshot{value: locale, data: map[string]any{"locale": locale}}
	case "lifecycle":
		current := status
		if manager, err := a.pluginManager(a.pluginContext()); err == nil {
			for _, candidate := range manager.List() {
				if candidate.Manifest.ID == status.Manifest.ID {
					current = candidate
					break
				}
			}
		}
		value := string(current.State) + ":" + strconv.FormatUint(current.Generation, 10) + ":" + formatPluginEnabled(current.DesiredEnabled)
		return pluginEventSnapshot{value: value, data: map[string]any{
			"state": string(current.State), "generation": current.Generation, "desiredEnabled": current.DesiredEnabled,
		}}
	case "connections":
		repository := a.savedConnectionRepository()
		views, err := repository.List()
		if err != nil {
			return pluginEventSnapshot{value: "error", data: map[string]any{"count": 0, "revision": ""}}
		}
		lines := make([]string, 0, len(views))
		for _, view := range views {
			lines = append(lines, view.ID+"\x00"+view.Name)
		}
		sort.Strings(lines)
		sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
		revision := hex.EncodeToString(sum[:8])
		return pluginEventSnapshot{value: revision, data: map[string]any{"count": len(views), "revision": revision}}
	default:
		return pluginEventSnapshot{value: "", data: map[string]any{}}
	}
}

func formatPluginEnabled(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func newPluginEventID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}
