package app

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/sqlaudit"
)

func TestSQLAuditAsyncWriterFlushesQueuedEventsOnStop(t *testing.T) {
	writer := &sqlAuditAsyncWriter{}
	var mu sync.Mutex
	written := make([]sqlaudit.Event, 0, 20)
	write := func(events []sqlaudit.Event) {
		mu.Lock()
		written = append(written, events...)
		mu.Unlock()
	}
	for index := 0; index < 20; index++ {
		if !writer.enqueue([]sqlaudit.Event{{ID: fmt.Sprintf("event-%d", index)}}, write) {
			t.Fatalf("enqueue %d returned false", index)
		}
	}
	writer.stop(2 * time.Second)

	mu.Lock()
	defer mu.Unlock()
	if len(written) != 20 {
		t.Fatalf("flushed %d events, want 20", len(written))
	}
	for index, event := range written {
		if event.ID != fmt.Sprintf("event-%d", index) {
			t.Fatalf("event order changed at %d: %q", index, event.ID)
		}
	}
}

func TestSQLAuditAsyncWriterRejectsEnqueueAfterStop(t *testing.T) {
	writer := &sqlAuditAsyncWriter{}
	write := func([]sqlaudit.Event) {}
	writer.stop(time.Second)
	if writer.enqueue([]sqlaudit.Event{{ID: "late"}}, write) {
		t.Fatal("expected enqueue after stop to return false so the caller writes synchronously")
	}
}
