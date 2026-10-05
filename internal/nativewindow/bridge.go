package nativewindow

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/rpctimeout"

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
	var status int
	var err error
	if rpctimeout.IsLongRunningAppMethod(method) {
		status, err = b.doJSON(b.lifecycleContext(), http.MethodPost, InvokePath, request, &response)
	} else {
		status, err = b.doRPCJSON(http.MethodPost, InvokePath, request, &response)
	}
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
