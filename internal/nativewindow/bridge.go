package nativewindow

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const defaultDetachedRPCRequestTimeout = 30 * time.Second

type invokeRequest struct {
	Namespace string `json:"namespace"`
	Receiver  string `json:"receiver"`
	Method    string `json:"method"`
	Args      []any  `json:"args"`
}

type invokeResponse struct {
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type bridgeEvent struct {
	Name string `json:"name"`
	Args []any  `json:"args,omitempty"`
}

// Bridge is bound only inside a detached child. It performs parent RPC and SSE
// over Go's HTTP stack so long-lived event streams never pass through Wails v2's
// Windows AssetServer response buffering.
type Bridge struct {
	parentURL  string
	token      string
	windowID   string
	kind       string
	client     *http.Client
	rpcTimeout time.Duration

	mu                    sync.Mutex
	ctx                   context.Context
	lifecycleCtx          context.Context // one-shot child lifetime shared by SSE and ordinary RPC
	cancel                context.CancelFunc
	ready                 bool
	onReady               func() OperationResult
	terminal              string
	closeOnce             sync.Once
	emitToWails           func(context.Context, string, ...any)
	allowParentForeground func() error
}

func newBridge(options ChildOptions) *Bridge {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2: false,
	}
	return &Bridge{
		parentURL:             strings.TrimRight(options.ParentURL, "/"),
		token:                 options.Token,
		windowID:              options.ID,
		kind:                  options.Kind,
		client:                &http.Client{Transport: transport},
		rpcTimeout:            defaultDetachedRPCRequestTimeout,
		allowParentForeground: grantParentForegroundAccess,
		emitToWails: func(ctx context.Context, name string, args ...any) {
			wailsRuntime.EventsEmit(ctx, name, args...)
		},
	}
}

func InitializeBridge(bridge *Bridge, ctx context.Context) {
	if bridge == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	bridge.mu.Lock()
	if bridge.lifecycleCtx != nil || bridge.cancel != nil {
		bridge.mu.Unlock()
		return
	}
	lifecycleCtx, cancel := context.WithCancel(ctx)
	bridge.ctx = ctx
	bridge.lifecycleCtx = lifecycleCtx
	bridge.cancel = cancel
	bridge.mu.Unlock()
	go bridge.consumeEvents(lifecycleCtx)
}

// Invoke calls the shared parent App or AI service.
func (b *Bridge) Invoke(namespace string, receiver string, method string, args []any) (any, error) {
	request := invokeRequest{
		Namespace: namespace,
		Receiver:  receiver,
		Method:    method,
		Args:      args,
	}
	var response invokeResponse
	status, err := b.doRPCJSON(http.MethodPost, InvokePath, request, &response)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK || response.Error != "" {
		if response.Error != "" {
			return nil, fmt.Errorf("%s", response.Error)
		}
		return nil, fmt.Errorf("parent invoke failed with status %d", status)
	}
	return response.Result, nil
}

// Bootstrap returns the tab snapshot stored in the main process registry.
func (b *Bridge) Bootstrap() (Bootstrap, error) {
	var result Bootstrap
	status, err := b.doRPCJSON(http.MethodGet, BootstrapPath, nil, &result)
	if err != nil {
		return Bootstrap{}, err
	}
	if status != http.StatusOK {
		return Bootstrap{}, fmt.Errorf("detached bootstrap failed with status %d", status)
	}
	return result, nil
}

// WindowID returns the lightweight process identity used to route parent
// focus/close commands. Command handling must not reload a potentially large
// bootstrap payload just to compare IDs.
func (b *Bridge) WindowID() string {
	if b == nil {
		return ""
	}
	return b.windowID
}

// OpenWindow asks the parent manager to create a child owned by this detached
// window. The parent validates ownership for all subsequent focus/close calls.
func (b *Bridge) OpenWindow(request OpenRequest) OperationResult {
	return b.control(controlRequest{Action: "open", Request: request})
}

func (b *Bridge) FocusWindow(id string) OperationResult {
	return b.control(controlRequest{Action: "focus", ID: id})
}

func (b *Bridge) HideWindow(id string) OperationResult {
	return b.control(controlRequest{Action: "hide", ID: id})
}

func (b *Bridge) CloseWindow(id string) OperationResult {
	return b.control(controlRequest{Action: "close", ID: id})
}

func (b *Bridge) CloseOwnedWindows() OperationResult {
	return b.control(controlRequest{Action: "close-owned"})
}

func (b *Bridge) control(request controlRequest) OperationResult {
	var result OperationResult
	status, err := b.doRPCJSON(
		http.MethodPost,
		ControlPath,
		request,
		&result,
	)
	if err != nil {
		return operationFailure(err.Error())
	}
	if status != http.StatusOK && result.Message == "" {
		return operationFailure(fmt.Sprintf("detached control failed with status %d", status))
	}
	return result
}

// Action acknowledges child readiness or forwards sync, hide, attach, or close
// state to the main window.
func (b *Bridge) Action(action string, payload any) OperationResult {
	return b.action(action, payload, true)
}

func (b *Bridge) action(action string, payload any, grantForeground bool) OperationResult {
	normalizedAction := strings.ToLower(strings.TrimSpace(action))
	if normalizedAction == "ready" {
		if result := b.presentFrontendReady(); !result.Success {
			return result
		}
	}
	if grantForeground && normalizedAction == "open-ai-settings" && b.allowParentForeground != nil {
		// The detached child owns the current user interaction on Windows. Grant
		// the parent permission immediately before it attempts to take focus. This
		// is best-effort so an OS rejection never blocks the settings action itself.
		_ = b.allowParentForeground()
	}

	var result OperationResult
	status, err := b.doRPCJSON(http.MethodPost, ActionPath, actionRequest{Action: action, Payload: payload}, &result)
	if err != nil {
		return operationFailure(err.Error())
	}
	if status != http.StatusOK {
		return operationFailure(fmt.Sprintf("detached action failed with status %d", status))
	}
	if result.Success && (result.Applied == nil || *result.Applied) {
		b.mu.Lock()
		switch normalizedAction {
		case "attach", "close":
			b.terminal = normalizedAction
		case "cancel-close":
			b.terminal = ""
		}
		b.mu.Unlock()
	}
	return result
}

func (b *Bridge) setReadyHandler(handler func() OperationResult) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.onReady = handler
	b.mu.Unlock()
}

func (b *Bridge) presentFrontendReady() OperationResult {
	if b == nil {
		return operationFailure("detached bridge is unavailable")
	}
	b.mu.Lock()
	if b.ready {
		b.mu.Unlock()
		return OperationResult{Success: true, ID: b.windowID}
	}
	onReady := b.onReady
	b.mu.Unlock()
	if onReady == nil {
		return operationFailure("native window ready handler is unavailable")
	}
	result := onReady()
	if !result.Success {
		return result
	}
	b.mu.Lock()
	b.ready = true
	b.mu.Unlock()
	return OperationResult{Success: true, ID: b.windowID}
}

func (b *Bridge) frontendReady() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ready
}

func (b *Bridge) notifyClosing() {
	if b == nil {
		return
	}
	b.closeOnce.Do(func() {
		b.mu.Lock()
		terminal := b.terminal
		b.mu.Unlock()
		if terminal == "attach" || terminal == "close" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
		defer cancel()
		var result OperationResult
		_, _ = b.doJSON(ctx, http.MethodPost, ActionPath, actionRequest{
			Action: "close",
			Payload: map[string]any{
				"id":   b.windowID,
				"kind": b.kind,
			},
		}, &result)
	})
}

func (b *Bridge) stop() {
	if b == nil {
		return
	}
	b.mu.Lock()
	cancel := b.cancel
	// lifecycleCtx is intentionally retained in its cancelled state after stop.
	b.cancel = nil
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (b *Bridge) lifecycleContext() context.Context {
	if b == nil {
		return context.Background()
	}
	b.mu.Lock()
	lifecycleCtx := b.lifecycleCtx
	b.mu.Unlock()
	if lifecycleCtx != nil {
		return lifecycleCtx
	}
	return context.Background()
}

func (b *Bridge) rpcTimeoutDuration() time.Duration {
	if b == nil {
		return defaultDetachedRPCRequestTimeout
	}
	b.mu.Lock()
	timeout := b.rpcTimeout
	b.mu.Unlock()
	if timeout <= 0 {
		return defaultDetachedRPCRequestTimeout
	}
	return timeout
}

func (b *Bridge) doRPCJSON(method string, requestPath string, requestBody any, responseBody any) (int, error) {
	requestCtx, cancel := context.WithTimeout(b.lifecycleContext(), b.rpcTimeoutDuration())
	defer cancel()
	return b.doJSON(requestCtx, method, requestPath, requestBody, responseBody)
}

func (b *Bridge) doJSON(ctx context.Context, method string, requestPath string, requestBody any, responseBody any) (int, error) {
	if b == nil || b.client == nil {
		return 0, fmt.Errorf("detached bridge is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var body io.Reader
	if requestBody != nil {
		payload, err := json.Marshal(requestBody)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, b.parentURL+requestPath, body)
	if err != nil {
		return 0, err
	}
	b.addHeaders(request)
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := b.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if responseBody != nil {
		decoder := json.NewDecoder(io.LimitReader(response.Body, maxDetachedJSONBytes))
		if err := decoder.Decode(responseBody); err != nil && !errorsIsEOF(err) {
			return response.StatusCode, err
		}
	}
	return response.StatusCode, nil
}

func errorsIsEOF(err error) bool {
	return err == io.EOF
}

func (b *Bridge) addHeaders(request *http.Request) {
	request.Header.Set(HeaderToken, b.token)
	request.Header.Set(HeaderWindowID, b.windowID)
}

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

// Control is bound only in a child and always targets that process's native
// Wails window.
type Control struct {
	mu                      sync.RWMutex
	visibilityOpMu          sync.Mutex
	ctx                     context.Context
	bridge                  *Bridge
	closeGate               closeGate
	closeFallback           *time.Timer
	closeFallbackGeneration uint64
	closeFallbackDelay      time.Duration
	closeCommitted          bool
	visibilityRevision      uint64
	domReady                bool
	frontendReady           bool
	focusPending            bool
	focusPendingRevision    uint64
	visible                 bool
	emitCommand             func(context.Context, childCommand)
	showWindow              func(context.Context)
	hideWindow              func(context.Context)
	focusWindow             func(context.Context)
	quit                    func(context.Context)
}

func newControl(bridge *Bridge) *Control {
	return &Control{
		bridge:             bridge,
		closeFallbackDelay: defaultGracefulCloseTimeout,
		emitCommand: func(ctx context.Context, command childCommand) {
			wailsRuntime.EventsEmit(ctx, CommandEventName, command)
		},
		showWindow: func(ctx context.Context) {
			wailsRuntime.WindowShow(ctx)
		},
		hideWindow: func(ctx context.Context) {
			wailsRuntime.WindowHide(ctx)
		},
		focusWindow: func(ctx context.Context) {
			wailsRuntime.WindowUnminimise(ctx)
			wailsRuntime.Show(ctx)
			// Accessory applications do not reliably make their window key when
			// only the application is activated. Explicitly order the detached
			// window front after unhiding the process.
			wailsRuntime.WindowShow(ctx)
		},
		quit: wailsRuntime.Quit,
	}
}

func InitializeControl(control *Control, ctx context.Context) {
	if control == nil {
		return
	}
	control.mu.Lock()
	control.ctx = ctx
	control.mu.Unlock()
}

// markDOMReady records that the WebView exists without exposing its still-empty
// surface. The frontend ready handshake releases the first presentation only
// after its own post-paint barrier.
func (c *Control) markDOMReady(ctx context.Context) {
	if c == nil {
		return
	}
	c.visibilityOpMu.Lock()
	c.mu.Lock()
	if c.ctx == nil {
		c.ctx = ctx
	}
	c.domReady = true
	presentation := c.takeInitialPresentationLocked()
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
}

func (c *Control) markFrontendReady() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	c.mu.Lock()
	if c.closeCommitted {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window close is already committed")
	}
	if !c.domReady || c.ctx == nil || c.showWindow == nil {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window DOM is not ready")
	}
	c.frontendReady = true
	presentation := c.takeInitialPresentationLocked()
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
	return OperationResult{Success: true}
}

// Present exposes the already-mounted child without acknowledging readiness to
// the parent. The visible WebView can then cross a real paint frame before the
// frontend sends its final ready action.
func (c *Control) Present() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	c.mu.Lock()
	if c.closeCommitted {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window close is already committed")
	}
	if !c.domReady || c.ctx == nil || c.showWindow == nil {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window DOM is not ready")
	}
	if c.visible {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return OperationResult{Success: true}
	}
	c.visible = true
	presentation := childWindowPresentation{ctx: c.ctx, show: c.showWindow}
	if c.focusPending && c.focusWindow != nil {
		c.focusPending = false
		presentation.visibilityRevision = c.focusPendingRevision
		c.focusPendingRevision = 0
		presentation.focus = c.focusWindow
		presentation.bridge = c.bridge
	}
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
	return OperationResult{Success: true}
}

type childWindowPresentation struct {
	ctx                context.Context
	show               func(context.Context)
	focus              func(context.Context)
	bridge             *Bridge
	visibilityRevision uint64
}

func (p childWindowPresentation) runNative() {
	if p.show != nil {
		p.show(p.ctx)
	}
	if p.focus != nil {
		p.focus(p.ctx)
	}
}

func (p childWindowPresentation) acknowledgeFocus() {
	if p.focus == nil || p.bridge == nil || p.visibilityRevision == 0 {
		return
	}
	// The parent must retain its pending focus until the native focus callback
	// has actually run. A failed acknowledgement deliberately leaves that
	// pending command available for the next SSE reconnect.
	_ = p.bridge.acknowledgeFocus(p.ctx, p.visibilityRevision)
}

// runVisibilityPresentationLocked keeps state selection and native effects in
// one visibility operation, then releases the lock before parent RPC.
func (c *Control) runVisibilityPresentationLocked(presentation childWindowPresentation) {
	func() {
		defer c.visibilityOpMu.Unlock()
		presentation.runNative()
	}()
	presentation.acknowledgeFocus()
}

func (c *Control) takeInitialPresentationLocked() childWindowPresentation {
	if c.closeCommitted || c.visible || !c.domReady || !c.frontendReady || c.ctx == nil || c.showWindow == nil {
		return childWindowPresentation{}
	}
	c.visible = true
	presentation := childWindowPresentation{ctx: c.ctx, show: c.showWindow}
	if c.focusPending && c.focusWindow != nil {
		c.focusPending = false
		presentation.visibilityRevision = c.focusPendingRevision
		c.focusPendingRevision = 0
		presentation.focus = c.focusWindow
		presentation.bridge = c.bridge
	}
	return presentation
}

func (c *Control) Close() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	defer c.visibilityOpMu.Unlock()
	c.mu.Lock()
	ctx := c.ctx
	quit := c.quit
	if ctx == nil || quit == nil {
		c.mu.Unlock()
		return operationFailure("native window is not ready")
	}
	c.closeCommitted = true
	c.invalidateCloseFallbackLocked()
	c.mu.Unlock()
	c.closeGate.allow()
	if c.bridge != nil {
		c.bridge.notifyClosing()
	}
	quit(ctx)
	return OperationResult{Success: true}
}

// Hide parks this child window while keeping its process, WebView, and React
// tree alive. Visibility revisions make the transition monotonic: a delayed
// hide from an older close request cannot win over a newer host focus.
func (c *Control) Hide(visibilityRevision uint64) OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	defer c.visibilityOpMu.Unlock()
	c.mu.Lock()
	if visibilityRevision < c.visibilityRevision {
		currentRevision := c.visibilityRevision
		c.mu.Unlock()
		return OperationResult{
			Success:            true,
			Message:            "stale native window hide ignored",
			VisibilityRevision: currentRevision,
		}
	}
	ctx := c.ctx
	hide := c.hideWindow
	if ctx == nil || hide == nil {
		c.mu.Unlock()
		return operationFailure("native window is not ready")
	}
	if c.closeCommitted {
		c.mu.Unlock()
		return operationFailure("native window close is already committed")
	}
	c.visibilityRevision = visibilityRevision
	c.visible = false
	c.focusPending = false
	c.focusPendingRevision = 0
	c.invalidateCloseFallbackLocked()
	c.mu.Unlock()
	c.closeGate.cancel()
	hide(ctx)
	return OperationResult{Success: true, VisibilityRevision: visibilityRevision}
}

// HideForAISettings parks the child before asking the parent to render its
// settings modal. The request runs in Go after WindowHide, so WebView suspension
// cannot leave the modal behind the detached window.
func (c *Control) HideForAISettings(visibilityRevision uint64) OperationResult {
	if c == nil || c.bridge == nil {
		return operationFailure("native window control is unavailable")
	}
	bridge := c.bridge
	if bridge.allowParentForeground != nil {
		// Windows requires the currently foreground child to grant activation to
		// its parent before the child is hidden.
		_ = bridge.allowParentForeground()
	}
	hideResult := c.Hide(visibilityRevision)
	if !hideResult.Success {
		return hideResult
	}
	if hideResult.VisibilityRevision != visibilityRevision {
		failure := operationFailure("open AI settings was superseded by a newer window focus")
		failure.VisibilityRevision = hideResult.VisibilityRevision
		return failure
	}
	actionResult := bridge.action("open-ai-settings", map[string]any{
		"id":                 bridge.windowID,
		"kind":               bridge.kind,
		"visibilityRevision": visibilityRevision,
	}, false)
	if actionResult.Success && (actionResult.Applied == nil || *actionResult.Applied) {
		return OperationResult{
			Success:            true,
			ID:                 bridge.windowID,
			VisibilityRevision: visibilityRevision,
		}
	}

	// Do not strand the user in a hidden child when the parent request fails.
	restoreResult := bridge.FocusWindow(bridge.windowID)
	if restoreResult.Success {
		_ = c.FocusRevision(restoreResult.VisibilityRevision)
	} else {
		_ = c.FocusRevision(visibilityRevision)
	}
	failure := operationFailure(fmt.Sprintf("open AI settings failed: %s", actionResult.Message))
	failure.VisibilityRevision = visibilityRevision
	return failure
}

// CancelClose keeps the child alive after a failed final frontend flush. It
// also invalidates any native-close fallback so a retry starts a fresh grace
// period instead of inheriting the old timeout.
func (c *Control) CancelClose() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.mu.Lock()
	if c.closeCommitted {
		c.mu.Unlock()
		return operationFailure("native window close is already committed")
	}
	c.invalidateCloseFallbackLocked()
	c.mu.Unlock()
	c.closeGate.cancel()
	return OperationResult{Success: true}
}

// handleBeforeClose gives a mounted frontend one opportunity to submit its
// terminal payload. A child that has not acknowledged ready has no state worth
// gating, so its existing notifyClosing fallback remains in force.
func (c *Control) handleBeforeClose(ctx context.Context) bool {
	if c == nil {
		return false
	}
	if c.bridge == nil || !c.bridge.frontendReady() {
		if c.bridge != nil {
			c.bridge.notifyClosing()
		}
		return false
	}
	veto, requestFrontendClose := c.closeGate.intercept()
	if requestFrontendClose {
		c.mu.RLock()
		emitCommand := c.emitCommand
		c.mu.RUnlock()
		if emitCommand != nil {
			emitCommand(ctx, childCommand{
				ID:     c.bridge.WindowID(),
				Action: "close",
				Reason: ExitReasonWindowClosed,
			})
		}
	}
	if veto {
		c.scheduleCloseFallback(ctx)
	}
	return veto
}

func (c *Control) scheduleCloseFallback(fallbackCtx context.Context) {
	c.mu.Lock()
	if c.closeCommitted || c.closeFallback != nil {
		c.mu.Unlock()
		return
	}
	delay := c.closeFallbackDelay
	if delay <= 0 {
		delay = defaultGracefulCloseTimeout
	}
	c.closeFallbackGeneration++
	generation := c.closeFallbackGeneration
	c.closeFallback = time.AfterFunc(delay, func() {
		c.runCloseFallback(generation, fallbackCtx)
	})
	c.mu.Unlock()
}

func (c *Control) runCloseFallback(generation uint64, fallbackCtx context.Context) {
	c.visibilityOpMu.Lock()
	defer c.visibilityOpMu.Unlock()
	c.mu.Lock()
	if c.closeFallbackGeneration != generation {
		c.mu.Unlock()
		return
	}
	if c.closeCommitted || c.closeGate.isAllowed() {
		c.closeFallback = nil
		c.mu.Unlock()
		return
	}
	c.closeFallback = nil
	c.closeCommitted = true
	ctx := c.ctx
	quit := c.quit
	c.mu.Unlock()

	c.closeGate.allow()
	if c.bridge != nil {
		c.bridge.notifyClosing()
	}
	if ctx == nil {
		ctx = fallbackCtx
	}
	if ctx != nil && quit != nil {
		quit(ctx)
	}
}

func (c *Control) invalidateCloseFallbackLocked() {
	c.closeFallbackGeneration++
	if c.closeFallback != nil {
		c.closeFallback.Stop()
		c.closeFallback = nil
	}
}

func (c *Control) Focus() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.mu.RLock()
	visibilityRevision := c.visibilityRevision
	c.mu.RUnlock()
	return c.FocusRevision(visibilityRevision)
}

// FocusRevision raises the window only when the request is at least as new as
// the last visibility transition observed by this child.
func (c *Control) FocusRevision(visibilityRevision uint64) OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	c.mu.Lock()
	if c.closeCommitted {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window close is already committed")
	}
	if visibilityRevision < c.visibilityRevision {
		currentRevision := c.visibilityRevision
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return OperationResult{
			Success:            true,
			Message:            "stale native window focus ignored",
			VisibilityRevision: currentRevision,
		}
	}
	c.visibilityRevision = visibilityRevision
	ctx := c.ctx
	focus := c.focusWindow
	if ctx == nil || focus == nil {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window is not ready")
	}
	if !c.visible {
		c.focusPending = true
		c.focusPendingRevision = visibilityRevision
		presentation := c.takeInitialPresentationLocked()
		c.mu.Unlock()
		c.runVisibilityPresentationLocked(presentation)
		return OperationResult{Success: true, VisibilityRevision: visibilityRevision}
	}
	c.focusPending = false
	c.focusPendingRevision = 0
	presentation := childWindowPresentation{
		ctx:                ctx,
		focus:              focus,
		bridge:             c.bridge,
		visibilityRevision: visibilityRevision,
	}
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
	return OperationResult{Success: true, VisibilityRevision: visibilityRevision}
}
