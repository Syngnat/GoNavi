//go:build !wails3

package nativewindow

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDetachedChildQueuesFocusUntilFrontendReadyHandshake(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	shows := 0
	focuses := 0
	control.showWindow = func(context.Context) { shows++ }
	control.focusWindow = func(context.Context) { focuses++ }

	control.markDOMReady(ctx)
	if result := control.Focus(); !result.Success {
		t.Fatalf("pre-ready Focus result = %#v", result)
	}
	if shows != 0 || focuses != 0 {
		t.Fatalf("pre-ready presentation = show %d focus %d, want 0/0", shows, focuses)
	}

	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("ready Action result = %#v", result)
	}
	if shows != 1 || focuses != 1 {
		t.Fatalf("ready presentation = show %d focus %d, want 1/1", shows, focuses)
	}

	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("repeated ready Action result = %#v", result)
	}
	if shows != 1 || focuses != 1 {
		t.Fatalf("repeated ready presentation = show %d focus %d, want 1/1", shows, focuses)
	}
}

func TestDetachedChildShowsAfterReadyAndFocusesWithoutShowingAgain(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	shows := 0
	focuses := 0
	control.showWindow = func(context.Context) { shows++ }
	control.focusWindow = func(context.Context) { focuses++ }

	control.markDOMReady(ctx)
	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("ready Action result = %#v", result)
	}
	if shows != 1 || focuses != 0 {
		t.Fatalf("ready presentation = show %d focus %d, want 1/0", shows, focuses)
	}

	if result := control.Focus(); !result.Success {
		t.Fatalf("post-ready Focus result = %#v", result)
	}
	if shows != 1 || focuses != 1 {
		t.Fatalf("post-ready presentation = show %d focus %d, want 1/1", shows, focuses)
	}

	if result := control.Focus(); !result.Success {
		t.Fatalf("later Focus result = %#v", result)
	}
	if shows != 1 || focuses != 2 {
		t.Fatalf("later presentation = show %d focus %d, want 1/2", shows, focuses)
	}
}

func TestDetachedChildAcknowledgesFocusOnlyAfterDelayedPresentation(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	steps := make([]string, 0, 4)
	control.showWindow = func(context.Context) { steps = append(steps, "show") }
	control.focusWindow = func(context.Context) { steps = append(steps, "focus") }
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
		case CommandStatePath:
			var acknowledgement commandStateRequest
			if err := json.NewDecoder(request.Body).Decode(&acknowledgement); err != nil {
				return nil, err
			}
			steps = append(steps, "ack-focus")
			if acknowledgement.Action != "ack-focus" || acknowledgement.VisibilityRevision != 7 {
				t.Fatalf("focus acknowledgement = %#v", acknowledgement)
			}
		case ActionPath:
			steps = append(steps, "post-ready")
		}
		return successfulVisibilityResponse(), nil
	})

	if result := control.FocusRevision(7); !result.Success {
		t.Fatalf("pre-ready FocusRevision result = %#v", result)
	}
	if len(steps) != 0 {
		t.Fatalf("pre-ready steps = %#v, want none", steps)
	}
	control.markDOMReady(ctx)
	if len(steps) != 0 {
		t.Fatalf("DOM-ready steps = %#v, want none before frontend presentation", steps)
	}
	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("ready Action result = %#v", result)
	}
	if got := strings.Join(steps, ","); got != "show,focus,ack-focus,post-ready" {
		t.Fatalf("delayed focus sequence = %q", got)
	}
}

func TestDetachedChildFailedFocusAcknowledgementLeavesParentPendingForRetry(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info:                 WindowInfo{ID: "ai-chat", Kind: "ai-chat", Ready: true},
		visibilityRevision:   7,
		pendingFocusRevision: 7,
	}
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     manager.token,
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	control := newControl(bridge)
	ctx := context.Background()
	InitializeControl(control, ctx)
	control.showWindow = func(context.Context) {}
	focuses := 0
	control.focusWindow = func(context.Context) { focuses++ }
	control.markDOMReady(ctx)
	if result := control.markFrontendReady(); !result.Success {
		t.Fatalf("markFrontendReady result = %#v", result)
	}

	failAcknowledgement := true
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if failAcknowledgement {
			return nil, errors.New("temporary parent connection failure")
		}
		request.RemoteAddr = "127.0.0.1:51003"
		recorder := httptest.NewRecorder()
		manager.authenticatedHandler().ServeHTTP(recorder, request)
		return recorder.Result(), nil
	})

	if result := control.FocusRevision(7); !result.Success {
		t.Fatalf("FocusRevision with failed acknowledgement = %#v", result)
	}
	manager.mu.RLock()
	pendingAfterFailure := manager.windows["ai-chat"].pendingFocusRevision
	manager.mu.RUnlock()
	if pendingAfterFailure != 7 {
		t.Fatalf("pending focus after failed acknowledgement = %d, want 7", pendingAfterFailure)
	}

	failAcknowledgement = false
	if result := control.FocusRevision(7); !result.Success {
		t.Fatalf("FocusRevision retry result = %#v", result)
	}
	manager.mu.RLock()
	pendingAfterRetry := manager.windows["ai-chat"].pendingFocusRevision
	manager.mu.RUnlock()
	if pendingAfterRetry != 0 || focuses != 2 {
		t.Fatalf("retry state = pending %d focuses %d, want 0/2", pendingAfterRetry, focuses)
	}
}

func TestDetachedChildIgnoresLateHideAfterNewerFocus(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	shows := 0
	hides := 0
	focuses := 0
	control.showWindow = func(context.Context) { shows++ }
	control.hideWindow = func(context.Context) { hides++ }
	control.focusWindow = func(context.Context) { focuses++ }
	control.markDOMReady(ctx)
	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("ready Action result = %#v", result)
	}

	if result := control.Hide(1); !result.Success || result.VisibilityRevision != 1 {
		t.Fatalf("Hide result = %#v", result)
	}
	if hides != 1 {
		t.Fatalf("hides after revision 1 = %d, want 1", hides)
	}
	if result := control.FocusRevision(2); !result.Success || result.VisibilityRevision != 2 {
		t.Fatalf("FocusRevision result = %#v", result)
	}
	if shows != 2 || focuses != 1 {
		t.Fatalf("presentation after focus = show %d focus %d, want 2/1", shows, focuses)
	}

	lateHide := control.Hide(1)
	if !lateHide.Success || lateHide.VisibilityRevision != 2 ||
		!strings.Contains(lateHide.Message, "stale") {
		t.Fatalf("late Hide result = %#v", lateHide)
	}
	if hides != 1 {
		t.Fatalf("late hide reached native window: hides = %d, want 1", hides)
	}
	control.mu.RLock()
	visible := control.visible
	revision := control.visibilityRevision
	control.mu.RUnlock()
	if !visible || revision != 2 {
		t.Fatalf("final visibility state = visible %v revision %d", visible, revision)
	}
}

func TestDetachedChildSerializesNativeHideBeforeNewerFocus(t *testing.T) {
	_, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	steps := make(chan string, 8)
	hideStarted := make(chan struct{})
	releaseHide := make(chan struct{})
	control.showWindow = func(context.Context) { steps <- "show" }
	control.hideWindow = func(context.Context) {
		steps <- "hide-start"
		close(hideStarted)
		<-releaseHide
		steps <- "hide-end"
	}
	control.focusWindow = func(context.Context) { steps <- "focus" }
	control.markDOMReady(ctx)
	if result := control.markFrontendReady(); !result.Success {
		t.Fatalf("markFrontendReady result = %#v", result)
	}
	if step := <-steps; step != "show" {
		t.Fatalf("initial presentation step = %q, want show", step)
	}

	hideDone := make(chan OperationResult, 1)
	go func() {
		hideDone <- control.Hide(1)
	}()
	select {
	case <-hideStarted:
	case <-time.After(time.Second):
		t.Fatal("native hide did not start")
	}

	focusCallStarted := make(chan struct{})
	focusDone := make(chan OperationResult, 1)
	go func() {
		close(focusCallStarted)
		focusDone <- control.FocusRevision(2)
	}()
	<-focusCallStarted
	select {
	case result := <-focusDone:
		close(releaseHide)
		<-hideDone
		t.Fatalf("newer focus completed before the older native hide: %#v", result)
	case <-time.After(25 * time.Millisecond):
	}

	close(releaseHide)
	if result := <-hideDone; !result.Success || result.VisibilityRevision != 1 {
		t.Fatalf("Hide result = %#v", result)
	}
	if result := <-focusDone; !result.Success || result.VisibilityRevision != 2 {
		t.Fatalf("FocusRevision result = %#v", result)
	}

	sequence := make([]string, 0, 4)
	for len(sequence) < 4 {
		select {
		case step := <-steps:
			sequence = append(sequence, step)
		case <-time.After(time.Second):
			t.Fatalf("native visibility sequence stopped at %#v", sequence)
		}
	}
	if got := strings.Join(sequence, ","); got != "hide-start,hide-end,show,focus" {
		t.Fatalf("native visibility sequence = %q", got)
	}
}

func TestDetachedChildDoesNotBlockHideWhileAcknowledgingFocus(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)
	control.showWindow = func(context.Context) {}
	control.focusWindow = func(context.Context) {}
	hideCalled := make(chan struct{}, 1)
	control.hideWindow = func(context.Context) { hideCalled <- struct{}{} }
	control.markDOMReady(ctx)
	if result := control.markFrontendReady(); !result.Success {
		t.Fatalf("markFrontendReady result = %#v", result)
	}

	acknowledgementStarted := make(chan struct{})
	releaseAcknowledgement := make(chan struct{})
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == CommandStatePath {
			close(acknowledgementStarted)
			<-releaseAcknowledgement
		}
		return successfulVisibilityResponse(), nil
	})

	focusDone := make(chan OperationResult, 1)
	go func() {
		focusDone <- control.FocusRevision(1)
	}()
	select {
	case <-acknowledgementStarted:
	case <-time.After(time.Second):
		t.Fatal("focus acknowledgement did not start")
	}

	hideDone := make(chan OperationResult, 1)
	go func() {
		hideDone <- control.Hide(2)
	}()
	select {
	case result := <-hideDone:
		if !result.Success || result.VisibilityRevision != 2 {
			t.Fatalf("Hide result = %#v", result)
		}
	case <-time.After(25 * time.Millisecond):
		close(releaseAcknowledgement)
		<-focusDone
		<-hideDone
		t.Fatal("native hide waited for the focus acknowledgement network request")
	}
	select {
	case <-hideCalled:
	case <-time.After(time.Second):
		t.Fatal("native hide callback was not called")
	}

	close(releaseAcknowledgement)
	if result := <-focusDone; !result.Success || result.VisibilityRevision != 1 {
		t.Fatalf("FocusRevision result = %#v", result)
	}
}

func TestDetachedChildClosePreventsConcurrentHideFromCancellingExit(t *testing.T) {
	_, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	quitStarted := make(chan struct{})
	releaseQuit := make(chan struct{})
	control.quit = func(context.Context) {
		close(quitStarted)
		<-releaseQuit
	}
	hideCalled := make(chan struct{}, 1)
	control.hideWindow = func(context.Context) { hideCalled <- struct{}{} }

	closeDone := make(chan OperationResult, 1)
	go func() {
		closeDone <- control.Close()
	}()
	select {
	case <-quitStarted:
	case <-time.After(time.Second):
		t.Fatal("native close did not reach quit")
	}
	if !control.closeGate.isAllowed() {
		t.Fatal("close gate was not opened before quit")
	}

	hideDone := make(chan OperationResult, 1)
	go func() {
		hideDone <- control.Hide(1)
	}()
	select {
	case result := <-hideDone:
		close(releaseQuit)
		<-closeDone
		t.Fatalf("hide completed while native close was in progress: %#v", result)
	case <-time.After(25 * time.Millisecond):
	}

	close(releaseQuit)
	if result := <-closeDone; !result.Success {
		t.Fatalf("Close result = %#v", result)
	}
	if result := <-hideDone; result.Success || !strings.Contains(result.Message, "already committed") {
		t.Fatalf("Hide result after committed close = %#v", result)
	}
	if !control.closeGate.isAllowed() {
		t.Fatal("concurrent hide cancelled the committed close gate")
	}
	select {
	case <-hideCalled:
		t.Fatal("concurrent hide reached the native window after close committed")
	default:
	}
}

func TestDetachedChildCloseFallbackPreventsConcurrentHideFromCancellingExit(t *testing.T) {
	_, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	control.closeFallbackDelay = time.Millisecond
	quitStarted := make(chan struct{})
	releaseQuit := make(chan struct{})
	control.quit = func(context.Context) {
		close(quitStarted)
		<-releaseQuit
	}
	hideCalled := make(chan struct{}, 1)
	control.hideWindow = func(context.Context) { hideCalled <- struct{}{} }

	control.scheduleCloseFallback(ctx)
	select {
	case <-quitStarted:
	case <-time.After(time.Second):
		t.Fatal("native close fallback did not reach quit")
	}
	if !control.closeGate.isAllowed() {
		t.Fatal("close fallback did not open the gate before quit")
	}

	hideDone := make(chan OperationResult, 1)
	go func() {
		hideDone <- control.Hide(1)
	}()
	select {
	case result := <-hideDone:
		close(releaseQuit)
		t.Fatalf("hide completed while native close fallback was in progress: %#v", result)
	case <-time.After(25 * time.Millisecond):
	}

	close(releaseQuit)
	if result := <-hideDone; result.Success || !strings.Contains(result.Message, "already committed") {
		t.Fatalf("Hide result after fallback committed close = %#v", result)
	}
	if !control.closeGate.isAllowed() {
		t.Fatal("concurrent hide cancelled the fallback close gate")
	}
	select {
	case <-hideCalled:
		t.Fatal("concurrent hide reached the native window after fallback close committed")
	default:
	}
}

func TestDetachedChildStaleCloseFallbackKeepsNewerTimer(t *testing.T) {
	_, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)
	control.closeFallbackDelay = time.Hour
	quits := 0
	control.quit = func(context.Context) { quits++ }

	control.mu.Lock()
	control.closeFallbackGeneration = 1
	control.closeFallback = time.AfterFunc(time.Hour, func() {})
	control.mu.Unlock()

	control.visibilityOpMu.Lock()
	staleFallbackDone := make(chan struct{})
	go func() {
		control.runCloseFallback(1, ctx)
		close(staleFallbackDone)
	}()

	if result := control.CancelClose(); !result.Success {
		control.visibilityOpMu.Unlock()
		t.Fatalf("CancelClose result = %#v", result)
	}
	control.scheduleCloseFallback(ctx)
	control.mu.RLock()
	newGeneration := control.closeFallbackGeneration
	newFallback := control.closeFallback
	control.mu.RUnlock()
	if newGeneration != 3 || newFallback == nil {
		control.visibilityOpMu.Unlock()
		t.Fatalf("new fallback state = generation %d timer %p, want 3/non-nil", newGeneration, newFallback)
	}

	control.visibilityOpMu.Unlock()
	select {
	case <-staleFallbackDone:
	case <-time.After(time.Second):
		t.Fatal("stale close fallback did not complete")
	}
	control.mu.RLock()
	retainedFallback := control.closeFallback
	retainedGeneration := control.closeFallbackGeneration
	closeCommitted := control.closeCommitted
	control.mu.RUnlock()
	if retainedFallback != newFallback || retainedGeneration != newGeneration {
		t.Fatalf(
			"fallback after stale callback = generation %d timer %p, want %d/%p",
			retainedGeneration,
			retainedFallback,
			newGeneration,
			newFallback,
		)
	}
	if closeCommitted || control.closeGate.isAllowed() || quits != 0 {
		t.Fatalf(
			"stale fallback exit state = committed %v gate %v quits %d, want false/false/0",
			closeCommitted,
			control.closeGate.isAllowed(),
			quits,
		)
	}
	if result := control.CancelClose(); !result.Success {
		t.Fatalf("final CancelClose result = %#v", result)
	}
}

func TestDetachedChildDoesNotPresentOrFocusAfterCloseCommitted(t *testing.T) {
	_, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	shows := 0
	focuses := 0
	control.showWindow = func(context.Context) { shows++ }
	control.focusWindow = func(context.Context) { focuses++ }
	control.quit = func(context.Context) {}
	control.markDOMReady(ctx)

	if result := control.Close(); !result.Success {
		t.Fatalf("Close result = %#v", result)
	}
	if result := control.markFrontendReady(); result.Success {
		t.Fatalf("markFrontendReady after close = %#v, want failure", result)
	}
	if result := control.Present(); result.Success {
		t.Fatalf("Present after close = %#v, want failure", result)
	}
	if result := control.FocusRevision(1); result.Success {
		t.Fatalf("FocusRevision after close = %#v, want failure", result)
	}
	if shows != 0 || focuses != 0 {
		t.Fatalf("post-close presentation = show %d focus %d, want 0/0", shows, focuses)
	}
}

func TestDetachedChildPresentsBeforePaintReadyWithoutShowingTwice(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)
	control.markDOMReady(ctx)

	shows := 0
	control.showWindow = func(context.Context) { shows++ }
	if result := control.Present(); !result.Success {
		t.Fatalf("Present result = %#v", result)
	}
	if shows != 1 {
		t.Fatalf("present shows = %d, want 1", shows)
	}

	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("ready Action result = %#v", result)
	}
	if shows != 1 {
		t.Fatalf("post-ready shows = %d, want 1", shows)
	}
}

func TestDetachedChildPresentConsumesQueuedFocus(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	shows := 0
	focuses := 0
	control.showWindow = func(context.Context) { shows++ }
	control.focusWindow = func(context.Context) { focuses++ }
	control.markDOMReady(ctx)

	if result := control.Focus(); !result.Success {
		t.Fatalf("pre-present Focus result = %#v", result)
	}
	if shows != 0 || focuses != 0 {
		t.Fatalf("queued focus presentation = show %d focus %d, want 0/0", shows, focuses)
	}
	if result := control.Present(); !result.Success {
		t.Fatalf("Present result = %#v", result)
	}
	if shows != 1 || focuses != 1 {
		t.Fatalf("presented queued focus = show %d focus %d, want 1/1", shows, focuses)
	}

	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("ready Action result = %#v", result)
	}
	if shows != 1 || focuses != 1 {
		t.Fatalf("post-ready presentation = show %d focus %d, want 1/1", shows, focuses)
	}
	if result := control.Focus(); !result.Success {
		t.Fatalf("post-ready Focus result = %#v", result)
	}
	if shows != 1 || focuses != 2 {
		t.Fatalf("repeated focus presentation = show %d focus %d, want 1/2", shows, focuses)
	}
}

func TestDetachedChildWaitsForDOMReadyEvenAfterFrontendHandshake(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)

	shows := 0
	focuses := 0
	posts := 0
	control.showWindow = func(context.Context) { shows++ }
	control.focusWindow = func(context.Context) { focuses++ }
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		posts++
		return successfulVisibilityResponse(), nil
	})

	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); result.Success {
		t.Fatalf("pre-DOM ready Action result = %#v, want failure", result)
	}
	if result := control.Focus(); !result.Success {
		t.Fatalf("pre-DOM Focus result = %#v", result)
	}
	if shows != 0 || focuses != 0 || posts != 0 {
		t.Fatalf("pre-DOM state = show %d focus %d post %d, want 0/0/0", shows, focuses, posts)
	}

	control.markDOMReady(ctx)
	if shows != 0 || focuses != 0 || posts != 0 {
		t.Fatalf("DOM-ready state before retry = show %d focus %d post %d, want 0/0/0", shows, focuses, posts)
	}
	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("retried ready Action result = %#v", result)
	}
	if shows != 1 || focuses != 1 {
		t.Fatalf("DOM-ready presentation = show %d focus %d, want 1/1", shows, focuses)
	}
	if posts != 1 {
		t.Fatalf("parent ready posts = %d, want 1", posts)
	}
}

func TestDetachedChildShowsBeforePostingParentReady(t *testing.T) {
	bridge, control := newVisibilityTestChild()
	ctx := context.Background()
	InitializeControl(control, ctx)
	control.markDOMReady(ctx)

	steps := make([]string, 0, 2)
	control.showWindow = func(context.Context) {
		steps = append(steps, "show")
	}
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		steps = append(steps, "post-parent-ready")
		return successfulVisibilityResponse(), nil
	})

	if result := bridge.Action("ready", map[string]any{"id": "window-1"}); !result.Success {
		t.Fatalf("ready Action result = %#v", result)
	}
	if got := strings.Join(steps, ","); got != "show,post-parent-ready" {
		t.Fatalf("ready sequence = %q, want show,post-parent-ready", got)
	}
}

func newVisibilityTestChild() (*Bridge, *Control) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "window-1",
		Kind:      "workbench",
	})
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return successfulVisibilityResponse(), nil
	})
	control := newControl(bridge)
	bridge.setReadyHandler(control.markFrontendReady)
	return bridge, control
}

func successfulVisibilityResponse() *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(`{"success":true,"id":"window-1"}`)),
		Header:     make(http.Header),
	}
}
