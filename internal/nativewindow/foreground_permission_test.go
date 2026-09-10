package nativewindow

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestControlHidesBeforeOpeningAISettingsInParent(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	control := newControl(bridge)
	InitializeControl(control, context.Background())
	steps := make([]string, 0, 3)
	bridge.allowParentForeground = func() error {
		steps = append(steps, "allow-parent-foreground")
		return nil
	}
	control.hideWindow = func(context.Context) {
		steps = append(steps, "hide-window")
	}
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != ActionPath {
			t.Fatalf("unexpected request path %q", request.URL.Path)
		}
		steps = append(steps, "post-action")
		return successfulForegroundActionResponse(), nil
	})

	result := control.HideForAISettings(7)
	if !result.Success || result.VisibilityRevision != 7 {
		t.Fatalf("HideForAISettings result = %#v", result)
	}
	if got := strings.Join(steps, ","); got != "allow-parent-foreground,hide-window,post-action" {
		t.Fatalf("HideForAISettings sequence = %q", got)
	}
}

func TestControlIncludesFocusedProviderWhenOpeningAISettings(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	control := newControl(bridge)
	InitializeControl(control, context.Background())
	control.hideWindow = func(context.Context) {}
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request: %v", err)
		}
		if !strings.Contains(string(body), `"providerId":"provider-grok"`) {
			t.Fatalf("provider focus missing from action body: %s", body)
		}
		return successfulForegroundActionResponse(), nil
	})

	result := control.HideForAISettingsProvider(7, " provider-grok ")
	if !result.Success {
		t.Fatalf("HideForAISettingsProvider result = %#v", result)
	}
}

func TestControlDoesNotOpenAISettingsAfterHideIsSupersededByFocus(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	control := newControl(bridge)
	InitializeControl(control, context.Background())
	control.visibilityRevision = 8
	control.visible = true
	hides := 0
	posts := 0
	control.hideWindow = func(context.Context) { hides++ }
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		posts++
		return successfulForegroundActionResponse(), nil
	})

	result := control.HideForAISettings(7)
	if result.Success || !strings.Contains(result.Message, "superseded") {
		t.Fatalf("stale HideForAISettings result = %#v", result)
	}
	if hides != 0 || posts != 0 {
		t.Fatalf("stale settings action reached native/parent: hides=%d posts=%d", hides, posts)
	}
}

func TestControlRestoresAIWindowWhenOpeningSettingsFails(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	control := newControl(bridge)
	ctx := context.Background()
	InitializeControl(control, ctx)
	steps := make([]string, 0, 8)
	control.showWindow = func(context.Context) { steps = append(steps, "show-window") }
	control.hideWindow = func(context.Context) { steps = append(steps, "hide-window") }
	control.focusWindow = func(context.Context) { steps = append(steps, "focus-window") }
	control.markDOMReady(ctx)
	if result := control.markFrontendReady(); !result.Success {
		t.Fatalf("markFrontendReady result = %#v", result)
	}
	steps = steps[:0]
	bridge.allowParentForeground = func() error {
		steps = append(steps, "allow-parent-foreground")
		return nil
	}
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
		case ActionPath:
			steps = append(steps, "post-action")
			return nil, errors.New("parent unavailable")
		case ControlPath:
			steps = append(steps, "focus-parent")
			return &http.Response{
				StatusCode: http.StatusOK,
				Body: io.NopCloser(strings.NewReader(
					`{"success":true,"id":"ai-chat","visibilityRevision":8}`,
				)),
				Header: make(http.Header),
			}, nil
		case CommandStatePath:
			steps = append(steps, "ack-focus")
			return successfulForegroundActionResponse(), nil
		default:
			t.Fatalf("unexpected request path %q", request.URL.Path)
			return nil, nil
		}
	})

	result := control.HideForAISettings(7)
	if result.Success || !strings.Contains(result.Message, "parent unavailable") {
		t.Fatalf("failed HideForAISettings result = %#v", result)
	}
	if got := strings.Join(steps, ","); got != "allow-parent-foreground,hide-window,post-action,focus-parent,show-window,focus-window,ack-focus" {
		t.Fatalf("failed HideForAISettings recovery sequence = %q", got)
	}
	control.mu.RLock()
	visible := control.visible
	revision := control.visibilityRevision
	control.mu.RUnlock()
	if !visible || revision != 8 {
		t.Fatalf("restored visibility = visible %v revision %d, want true/8", visible, revision)
	}
}

func TestControlRestoresParentAndChildVisibilityThroughAuthenticatedSelfFocus(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{
			ID:     "ai-chat",
			Kind:   "ai-chat",
			Title:  "GoNavi AI",
			Hidden: true,
		},
		visibilityRevision: 8,
	}
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     manager.token,
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		request.RemoteAddr = "127.0.0.1:51003"
		recorder := httptest.NewRecorder()
		manager.authenticatedHandler().ServeHTTP(recorder, request)
		return recorder.Result(), nil
	})
	control := newControl(bridge)
	ctx := context.Background()
	InitializeControl(control, ctx)
	control.showWindow = func(context.Context) {}
	control.hideWindow = func(context.Context) {}
	control.focusWindow = func(context.Context) {}
	control.markDOMReady(ctx)
	if result := control.markFrontendReady(); !result.Success {
		t.Fatalf("markFrontendReady result = %#v", result)
	}

	result := control.HideForAISettings(7)
	if result.Success || !strings.Contains(result.Message, "ignored after a newer visibility action") {
		t.Fatalf("superseded HideForAISettings result = %#v", result)
	}

	manager.mu.RLock()
	managerEntry := manager.windows["ai-chat"]
	managerHidden := managerEntry.info.Hidden
	managerRevision := managerEntry.visibilityRevision
	pendingFocusRevision := managerEntry.pendingFocusRevision
	manager.mu.RUnlock()
	if managerHidden || managerRevision != 9 || pendingFocusRevision != 0 {
		t.Fatalf(
			"restored manager visibility = hidden %v revision %d pending %d, want false/9/0",
			managerHidden,
			managerRevision,
			pendingFocusRevision,
		)
	}
	control.mu.RLock()
	childVisible := control.visible
	childRevision := control.visibilityRevision
	control.mu.RUnlock()
	if !childVisible || childRevision != 9 {
		t.Fatalf("restored child visibility = visible %v revision %d, want true/9", childVisible, childRevision)
	}
}

func TestBridgeAllowsParentForegroundImmediatelyBeforeOpeningAISettings(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	steps := make([]string, 0, 2)
	bridge.allowParentForeground = func() error {
		steps = append(steps, "allow-parent-foreground")
		return nil
	}
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		steps = append(steps, "post-action")
		return successfulForegroundActionResponse(), nil
	})

	if result := bridge.Action("open-ai-settings", map[string]any{"id": "ai-chat"}); !result.Success {
		t.Fatalf("open-ai-settings result = %#v", result)
	}
	if got := strings.Join(steps, ","); got != "allow-parent-foreground,post-action" {
		t.Fatalf("open-ai-settings sequence = %q", got)
	}
}

func TestBridgeStillOpensAISettingsWhenForegroundPermissionFails(t *testing.T) {
	bridge := newBridge(ChildOptions{ParentURL: "http://127.0.0.1:43119", ID: "ai-chat", Kind: "ai-chat"})
	bridge.allowParentForeground = func() error {
		return errors.New("permission denied")
	}
	posts := 0
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		posts++
		return successfulForegroundActionResponse(), nil
	})

	if result := bridge.Action("open-ai-settings", nil); !result.Success {
		t.Fatalf("open-ai-settings result = %#v", result)
	}
	if posts != 1 {
		t.Fatalf("parent action posts = %d, want 1", posts)
	}
}

func TestBridgeDoesNotGrantForegroundForOtherActions(t *testing.T) {
	bridge := newBridge(ChildOptions{ParentURL: "http://127.0.0.1:43119", ID: "ai-chat", Kind: "ai-chat"})
	grants := 0
	bridge.allowParentForeground = func() error {
		grants++
		return nil
	}
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return successfulForegroundActionResponse(), nil
	})

	for _, action := range []string{"sync", "attach", "close", "host-event"} {
		if result := bridge.Action(action, nil); !result.Success {
			t.Fatalf("%s result = %#v", action, result)
		}
	}
	if grants != 0 {
		t.Fatalf("foreground grants = %d, want 0", grants)
	}
}

func successfulForegroundActionResponse() *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(`{"success":true,"id":"ai-chat"}`)),
		Header:     make(http.Header),
	}
}
