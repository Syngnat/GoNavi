package nativewindow

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func (b *Bridge) consumeEvents(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		err := b.consumeEventStream(ctx)
		if ctx.Err() != nil {
			return
		}
		delay := 750 * time.Millisecond
		if err == nil {
			delay = 100 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (b *Bridge) consumeEventStream(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, b.parentURL+EventsPath, nil)
	if err != nil {
		return err
	}
	b.addHeaders(request)
	request.Header.Set("Accept", "text/event-stream")
	response, err := b.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return fmt.Errorf("detached event stream failed with status %d", response.StatusCode)
	}
	if err := b.replayPendingCommand(ctx); err != nil {
		return err
	}
	// The SSE subscription exists before this GET starts, so a concurrent host
	// update is either present in the retained response, queued on SSE, or both.
	// Frontend revision checks make the possible duplicate harmless.
	if err := b.replayHostState(ctx); err != nil {
		return err
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if data.Len() > 0 {
				if err := b.dispatchEvent(ctx, data.String()); err != nil {
					return err
				}
				data.Reset()
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			chunk := strings.TrimPrefix(line, "data:")
			if strings.HasPrefix(chunk, " ") {
				chunk = chunk[1:]
			}
			if int64(data.Len()+len(chunk)) > maxDetachedSSEEventBytes {
				return fmt.Errorf("detached event exceeds the maximum payload size")
			}
			data.WriteString(chunk)
		}
	}
	return scanner.Err()
}

func (b *Bridge) replayPendingCommand(ctx context.Context) error {
	var command childCommand
	status, err := b.doJSON(ctx, http.MethodGet, CommandStatePath, nil, &command)
	if err != nil {
		return err
	}
	if status == http.StatusNoContent {
		return nil
	}
	if status != http.StatusOK {
		return fmt.Errorf("detached command-state replay failed with status %d", status)
	}
	if strings.TrimSpace(command.ID) != b.windowID ||
		(command.Action != "close" && command.Action != "hide" && command.Action != "focus") {
		return fmt.Errorf("detached command-state replay is invalid")
	}
	visibilityRevision := positiveVisibilityRevision(command.Payload)
	if command.Action == "focus" && visibilityRevision == 0 {
		return fmt.Errorf("detached command-state focus revision is invalid")
	}
	b.emitRuntimeEvent(CommandEventName, command)
	return nil
}

func (b *Bridge) acknowledgeFocus(ctx context.Context, visibilityRevision uint64) error {
	if visibilityRevision == 0 {
		return fmt.Errorf("detached focus acknowledgement revision is invalid")
	}
	var result OperationResult
	status, err := b.doJSON(ctx, http.MethodPost, CommandStatePath, commandStateRequest{
		Action:             "ack-focus",
		VisibilityRevision: visibilityRevision,
	}, &result)
	if err != nil {
		return err
	}
	if status != http.StatusOK || !result.Success {
		return fmt.Errorf("detached focus acknowledgement failed with status %d", status)
	}
	return nil
}

func (b *Bridge) replayHostState(ctx context.Context) error {
	var snapshot HostStateRequest
	status, err := b.doJSON(ctx, http.MethodGet, HostStatePath, nil, &snapshot)
	if err != nil {
		return err
	}
	if status == http.StatusNoContent {
		return nil
	}
	if status != http.StatusOK {
		return fmt.Errorf("detached host-state replay failed with status %d", status)
	}
	if strings.TrimSpace(snapshot.ID) != b.windowID || snapshot.Revision <= 0 || snapshot.StoreState == nil {
		return fmt.Errorf("detached host-state replay is invalid")
	}
	b.emitRuntimeEvent(CommandEventName, childCommand{
		ID:     snapshot.ID,
		Action: "sync-host-state",
		Payload: hostStatePayload{
			Revision:   snapshot.Revision,
			StoreState: snapshot.StoreState,
		},
	})
	return nil
}

func (b *Bridge) dispatchEvent(ctx context.Context, payload string) error {
	var event bridgeEvent
	if err := json.Unmarshal([]byte(payload), &event); err != nil || strings.TrimSpace(event.Name) == "" {
		return nil
	}
	if b.isHostStateInvalidation(event) {
		return b.replayHostState(ctx)
	}
	b.emitRuntimeEvent(event.Name, event.Args...)
	return nil
}

func (b *Bridge) isHostStateInvalidation(event bridgeEvent) bool {
	if b == nil || event.Name != CommandEventName || len(event.Args) != 1 {
		return false
	}
	command, ok := event.Args[0].(map[string]any)
	if !ok || strings.TrimSpace(fmt.Sprint(command["id"])) != b.windowID || command["action"] != "sync-host-state" {
		return false
	}
	payload, ok := command["payload"].(map[string]any)
	if !ok {
		return true
	}
	_, carriesStoreState := payload["storeState"]
	return !carriesStoreState
}

func (b *Bridge) emitRuntimeEvent(name string, args ...any) {
	b.mu.Lock()
	ctx := b.ctx
	emitToWails := b.emitToWails
	b.mu.Unlock()
	if ctx != nil && emitToWails != nil {
		emitToWails(ctx, name, args...)
	}
}
