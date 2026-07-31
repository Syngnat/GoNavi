package aiservice

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestIsAIStreamCancellationRecognizesWrappedCancellation(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "direct cancellation", err: context.Canceled, want: true},
		{name: "wrapped cancellation", err: fmt.Errorf("stream stopped: %w", context.Canceled), want: true},
		{name: "deadline exceeded", err: context.DeadlineExceeded, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isAIStreamCancellation(tt.err); got != tt.want {
				t.Fatalf("isAIStreamCancellation(%v) = %t, want %t", tt.err, got, tt.want)
			}
		})
	}
}

func TestAIChatCancelAndWaitWaitsForStreamProducer(t *testing.T) {
	service := &Service{
		streamProducers: make(map[string]map[*aiStreamProducer]struct{}),
	}
	cancelled := make(chan struct{})
	producer := service.registerAIStreamProducer("session-1", func() { close(cancelled) })

	go func() {
		<-cancelled
		time.Sleep(10 * time.Millisecond)
		service.finishAIStreamProducer("session-1", producer)
	}()

	started := time.Now()
	if !service.AIChatCancelAndWait("session-1") {
		t.Fatal("expected stream cancellation to finish")
	}
	if time.Since(started) < 10*time.Millisecond {
		t.Fatal("cancel returned before the stream producer stopped")
	}
}

func TestAIChatCancelAndWaitWaitsForEveryOverlappingProducer(t *testing.T) {
	service := &Service{
		streamProducers: make(map[string]map[*aiStreamProducer]struct{}),
	}
	firstCancelled := make(chan struct{})
	firstReleased := make(chan struct{})
	var firstCancelOnce sync.Once
	first := service.registerAIStreamProducer("session-1", func() {
		firstCancelOnce.Do(func() { close(firstCancelled) })
	})
	go func() {
		<-firstCancelled
		<-firstReleased
		service.finishAIStreamProducer("session-1", first)
	}()

	secondCancelled := make(chan struct{})
	secondReleased := make(chan struct{})
	var secondCancelOnce sync.Once
	second := service.registerAIStreamProducer("session-1", func() {
		secondCancelOnce.Do(func() { close(secondCancelled) })
	})
	go func() {
		<-secondCancelled
		<-secondReleased
		service.finishAIStreamProducer("session-1", second)
	}()

	select {
	case <-firstCancelled:
	case <-time.After(time.Second):
		t.Fatal("starting the second producer did not cancel the first")
	}

	result := make(chan bool, 1)
	go func() { result <- service.AIChatCancelAndWait("session-1") }()
	select {
	case <-secondCancelled:
	case <-time.After(time.Second):
		t.Fatal("CancelAndWait did not cancel the latest producer")
	}
	close(secondReleased)
	select {
	case value := <-result:
		t.Fatalf("CancelAndWait returned %v while the older producer was still active", value)
	case <-time.After(25 * time.Millisecond):
	}

	close(firstReleased)
	select {
	case value := <-result:
		if !value {
			t.Fatal("expected every overlapping producer to stop")
		}
	case <-time.After(time.Second):
		t.Fatal("CancelAndWait did not return after every producer stopped")
	}
}

func TestAIChatCancelAndWaitReturnsWhenNoStreamIsActive(t *testing.T) {
	service := &Service{
		streamProducers: make(map[string]map[*aiStreamProducer]struct{}),
	}
	if !service.AIChatCancelAndWait("missing") {
		t.Fatal("inactive stream should already be stopped")
	}
}

func TestAIChatCancelAllAndWaitWaitsForEverySessionProducer(t *testing.T) {
	service := &Service{
		streamProducers: make(map[string]map[*aiStreamProducer]struct{}),
	}
	firstCancelled := make(chan struct{})
	firstReleased := make(chan struct{})
	first := service.registerAIStreamProducer("session-1", func() { close(firstCancelled) })
	go func() {
		<-firstCancelled
		<-firstReleased
		service.finishAIStreamProducer("session-1", first)
	}()
	secondCancelled := make(chan struct{})
	secondReleased := make(chan struct{})
	second := service.registerAIStreamProducer("session-2", func() { close(secondCancelled) })
	go func() {
		<-secondCancelled
		<-secondReleased
		service.finishAIStreamProducer("session-2", second)
	}()

	result := make(chan bool, 1)
	go func() { result <- service.AIChatCancelAllAndWait() }()
	for name, cancelled := range map[string]<-chan struct{}{
		"session-1": firstCancelled,
		"session-2": secondCancelled,
	} {
		select {
		case <-cancelled:
		case <-time.After(time.Second):
			t.Fatalf("CancelAllAndWait did not cancel %s", name)
		}
	}
	close(firstReleased)
	select {
	case value := <-result:
		t.Fatalf("CancelAllAndWait returned %v while session-2 was still active", value)
	case <-time.After(25 * time.Millisecond):
	}
	close(secondReleased)
	select {
	case value := <-result:
		if !value {
			t.Fatal("expected every session producer to stop")
		}
	case <-time.After(time.Second):
		t.Fatal("CancelAllAndWait did not return after every producer stopped")
	}
}

func TestAIChatCancelAllAndWaitRejectsNewProducersDuringHandoff(t *testing.T) {
	service := &Service{
		streamProducers: make(map[string]map[*aiStreamProducer]struct{}),
	}
	activeCancelled := make(chan struct{})
	activeReleased := make(chan struct{})
	active := service.registerAIStreamProducer("session-active", func() { close(activeCancelled) })
	go func() {
		<-activeCancelled
		<-activeReleased
		service.finishAIStreamProducer("session-active", active)
	}()

	result := make(chan bool, 1)
	go func() { result <- service.AIChatCancelAllAndWait() }()
	select {
	case <-activeCancelled:
	case <-time.After(time.Second):
		t.Fatal("CancelAllAndWait did not enter the handoff phase")
	}

	lateCancelled := make(chan struct{})
	late := service.registerAIStreamProducer("session-late", func() { close(lateCancelled) })
	if late != nil {
		t.Fatal("new producer was registered during terminal handoff")
	}
	select {
	case <-lateCancelled:
	case <-time.After(time.Second):
		t.Fatal("rejected producer context was not cancelled")
	}

	close(activeReleased)
	select {
	case value := <-result:
		if !value {
			t.Fatal("expected terminal handoff to finish")
		}
	case <-time.After(time.Second):
		t.Fatal("CancelAllAndWait did not finish after the active producer stopped")
	}
}
