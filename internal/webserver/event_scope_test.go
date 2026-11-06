package webserver

import "testing"

func drainSubscriber(subscriber *eventSubscriber) []eventMessage {
	messages := make([]eventMessage, 0)
	for {
		message, ok := subscriber.dequeue()
		if !ok {
			return messages
		}
		messages = append(messages, message)
	}
}

func TestEventHubEmitToSessionOnlyReachesMatchingSubscribers(t *testing.T) {
	hub := newEventHub()
	aliceTab1 := hub.subscribe("", "session-alice")
	aliceTab2 := hub.subscribe("", "session-alice")
	bob := hub.subscribe("", "session-bob")
	defer hub.unsubscribe(aliceTab1)
	defer hub.unsubscribe(aliceTab2)
	defer hub.unsubscribe(bob)

	hub.emitterForSession("session-alice").Emit("query:progress", "payload")

	for _, subscriber := range []*eventSubscriber{aliceTab1, aliceTab2} {
		messages := drainSubscriber(subscriber)
		if len(messages) != 1 || messages[0].Name != "query:progress" {
			t.Fatalf("alice subscriber = %+v, want one query:progress", messages)
		}
	}
	if messages := drainSubscriber(bob); len(messages) != 0 {
		t.Fatalf("bob must not receive alice's scoped event: %+v", messages)
	}
}

func TestEventHubSessionEmitterWithoutSubscribersIsNoop(t *testing.T) {
	hub := newEventHub()
	hub.emitterForSession("missing").Emit("query:progress", "payload")
	if got := hub.subscriberCount(); got != 0 {
		t.Fatalf("subscriber count = %d, want 0", got)
	}
}
