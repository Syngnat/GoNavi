package webserver

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"reflect"
	"strings"
	"sync"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	httpserverlimits "GoNavi-Wails/internal/httpserver"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/requesttrace"
	"GoNavi-Wails/internal/uievents"
)

const (
	defaultWebServerAddr      = "127.0.0.1:34116"
	internalRoutePrefix       = "/__gonavi"
	detachedWindowIDHeader    = "X-GoNavi-Detached-Window-ID"
	eventSubscriberQueueLimit = 128
	// Reliable events are allowed bounded headroom over the broadcast queue so
	// a critical targeted event can still be delivered after broadcasts fill
	// the soft limit. A subscriber that remains slower than this hard limit is
	// closed and must reconnect instead of retaining an unbounded queue.
	eventSubscriberReliableQueueLimit = eventSubscriberQueueLimit * 2
	eventStreamDataChunkBytes         = 256 << 10
)

var errorType = reflect.TypeOf((*error)(nil)).Elem()

var desktopOnlyAppMethods = map[string]struct{}{
	"Shutdown":                      {},
	"SetWindowTranslucency":         {},
	"SetMacNativeWindowControls":    {},
	"SetApplicationBrandIcon":       {},
	"ResetWebViewZoom":              {},
	"RefreshWebViewBounds":          {},
	"SelectDataRootDirectory":       {},
	"GetDataRootDirectoryInfo":      {},
	"ApplyDataRootDirectory":        {},
	"OpenDataRootDirectory":         {},
	"SelectLogDirectory":            {},
	"ApplyLogDirectory":             {},
	"OpenLogDirectory":              {},
	"SelectSavedQueryDirectory":     {},
	"ApplySavedQueryDirectory":      {},
	"OpenSavedQueryDirectory":       {},
	"RevealSavedQueryInFolder":      {},
	"SelectDriverDownloadDirectory": {},
	"SelectDriverPackageFile":       {},
	"SelectDriverPackageDirectory":  {},
	"OpenSQLFile":                   {},
	"SelectSQLFileForExecution":     {},
	"SelectSQLDirectory":            {},
	"ListSQLDirectory":              {},
	"ReadSQLFile":                   {},
	"WriteSQLFile":                  {},
	"CreateSQLFile":                 {},
	"CreateSQLDirectory":            {},
	"DeleteSQLFile":                 {},
	"DeleteSQLDirectory":            {},
	"RenameSQLFile":                 {},
	"RenameSQLDirectory":            {},
	"ExecuteSQLFile":                {},
	"ExportSQLFile":                 {},
	"ImportConfigFile":              {},
	"ExportConnectionsPackage":      {},
	"SelectSSHKeyFile":              {},
	"SelectSSHKnownHostsFile":       {},
	"SelectCertificateFile":         {},
	"SelectDatabaseFile":            {},
	"ImportData":                    {},
	"ExportSQLAuditFile":            {},
}

var desktopOnlyCredentialAppMethods = map[string]struct{}{
	"RevealSavedConnectionPrimaryPassword": {},
}

type Options struct {
	Addr string
}

type invokeRequest struct {
	Namespace string            `json:"namespace"`
	Receiver  string            `json:"receiver"`
	Method    string            `json:"method"`
	Args      []json.RawMessage `json:"args"`
}

type invokeResponse struct {
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

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

type methodInvoker struct {
	targets             map[string]reflect.Value
	contextHandlers     map[string]map[string]reflect.Value
	allowDesktopMethods bool
}

func newMethodInvoker(app *appcore.App, ai *aiservice.Service) (*methodInvoker, error) {
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"app.app":           reflect.ValueOf(app),
			"app":               reflect.ValueOf(app),
			"aiservice.service": reflect.ValueOf(ai),
			"aiservice":         reflect.ValueOf(ai),
		},
	}
	appHandlers, err := validateContextHandlers(
		reflect.ValueOf(app),
		appcore.RequiredIssue1098WebRPCContextMethods(),
		appcore.WebRPCContextHandlers(app),
	)
	if err != nil {
		return nil, fmt.Errorf("validate App Web RPC context handlers: %w", err)
	}
	invoker.contextHandlers = map[string]map[string]reflect.Value{"app": appHandlers}
	return invoker, nil
}

func validateContextHandlers(target reflect.Value, required []string, handlers map[string]any) (map[string]reflect.Value, error) {
	if !target.IsValid() || (target.Kind() == reflect.Pointer && target.IsNil()) {
		return nil, fmt.Errorf("context handler target is unavailable")
	}
	requiredSet := make(map[string]struct{}, len(required))
	for _, methodName := range required {
		methodName = strings.TrimSpace(methodName)
		if methodName == "" {
			return nil, fmt.Errorf("required context method name is empty")
		}
		if _, exists := requiredSet[methodName]; exists {
			return nil, fmt.Errorf("required context method %s is duplicated", methodName)
		}
		requiredSet[methodName] = struct{}{}
	}
	if len(handlers) != len(requiredSet) {
		return nil, fmt.Errorf("context handler count mismatch: want %d got %d", len(requiredSet), len(handlers))
	}

	contextType := reflect.TypeOf((*context.Context)(nil)).Elem()
	validated := make(map[string]reflect.Value, len(handlers))
	for methodName, rawHandler := range handlers {
		if _, required := requiredSet[methodName]; !required {
			return nil, fmt.Errorf("context handler %s is not in the required method set", methodName)
		}
		publicMethod := target.MethodByName(methodName)
		if !publicMethod.IsValid() {
			return nil, fmt.Errorf("public method %s does not exist", methodName)
		}
		publicType := publicMethod.Type()
		if publicType.IsVariadic() {
			return nil, fmt.Errorf("public method %s must not be variadic", methodName)
		}

		handler := reflect.ValueOf(rawHandler)
		if !handler.IsValid() || handler.Kind() != reflect.Func || handler.IsNil() {
			return nil, fmt.Errorf("context handler %s must be a non-nil function", methodName)
		}
		handlerType := handler.Type()
		if handlerType.IsVariadic() {
			return nil, fmt.Errorf("context handler %s must not be variadic", methodName)
		}
		if handlerType.NumIn() != publicType.NumIn()+1 || handlerType.In(0) != contextType {
			return nil, fmt.Errorf("context handler %s has an invalid parameter list", methodName)
		}
		for index := 0; index < publicType.NumIn(); index++ {
			if handlerType.In(index+1) != publicType.In(index) {
				return nil, fmt.Errorf("context handler %s parameter %d type mismatch", methodName, index)
			}
		}
		if handlerType.NumOut() != publicType.NumOut() {
			return nil, fmt.Errorf("context handler %s return count mismatch", methodName)
		}
		for index := 0; index < publicType.NumOut(); index++ {
			if handlerType.Out(index) != publicType.Out(index) {
				return nil, fmt.Errorf("context handler %s return %d type mismatch", methodName, index)
			}
		}
		validated[methodName] = handler
	}
	for methodName := range requiredSet {
		if _, exists := validated[methodName]; !exists {
			return nil, fmt.Errorf("required context handler %s is missing", methodName)
		}
	}
	return validated, nil
}

func canonicalInvokeTarget(key string) string {
	switch key {
	case "app", "app.app":
		return "app"
	case "aiservice", "aiservice.service":
		return "aiservice"
	default:
		return key
	}
}

func (i *methodInvoker) Invoke(ctx context.Context, req invokeRequest) (any, error) {
	if i == nil {
		return nil, fmt.Errorf("web invoker is not initialized")
	}
	namespace := strings.ToLower(strings.TrimSpace(req.Namespace))
	receiver := strings.ToLower(strings.TrimSpace(req.Receiver))
	methodName := strings.TrimSpace(req.Method)
	if namespace == "" || methodName == "" {
		return nil, fmt.Errorf("invalid invoke request")
	}

	key := namespace
	if receiver != "" {
		key = namespace + "." + receiver
	}
	target, ok := i.targets[key]
	if !ok {
		return nil, fmt.Errorf("unsupported invoke target: %s.%s", namespace, receiver)
	}
	if !i.allowDesktopMethods && (key == "app" || key == "app.app") && isDesktopOnlyAppMethod(methodName) {
		return nil, fmt.Errorf("method %s is unavailable in web runtime", methodName)
	}

	method := target.MethodByName(methodName)
	if !method.IsValid() {
		return nil, fmt.Errorf("unsupported method: %s.%s.%s", namespace, receiver, methodName)
	}

	methodType := method.Type()
	if methodType.IsVariadic() {
		return nil, fmt.Errorf("variadic methods are not supported: %s", methodName)
	}
	if methodType.NumIn() != len(req.Args) {
		return nil, fmt.Errorf("invalid argument count for %s: want %d got %d", methodName, methodType.NumIn(), len(req.Args))
	}

	callArgs := make([]reflect.Value, 0, len(req.Args))
	for index, raw := range req.Args {
		argValue, err := decodeArgument(raw, methodType.In(index))
		if err != nil {
			return nil, fmt.Errorf("decode argument %d for %s failed: %w", index, methodName, err)
		}
		callArgs = append(callArgs, argValue)
	}

	canonicalTarget := canonicalInvokeTarget(key)
	handler := reflect.Value{}
	if handlers := i.contextHandlers[canonicalTarget]; handlers != nil {
		handler = handlers[methodName]
	}
	if handler.IsValid() {
		if ctx == nil {
			ctx = context.Background()
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		contextCallArgs := make([]reflect.Value, 0, len(callArgs)+1)
		contextCallArgs = append(contextCallArgs, reflect.ValueOf(ctx))
		contextCallArgs = append(contextCallArgs, callArgs...)
		return unpackResults(handler.Call(contextCallArgs))
	}

	results := method.Call(callArgs)
	return unpackResults(results)
}

func isDesktopOnlyAppMethod(methodName string) bool {
	methodName = strings.TrimSpace(methodName)
	if _, denied := desktopOnlyAppMethods[methodName]; denied {
		return true
	}
	_, denied := desktopOnlyCredentialAppMethods[methodName]
	return denied
}

func decodeArgument(raw json.RawMessage, targetType reflect.Type) (reflect.Value, error) {
	holder := reflect.New(targetType)
	if len(raw) == 0 {
		return holder.Elem(), nil
	}
	if err := json.Unmarshal(raw, holder.Interface()); err != nil {
		return reflect.Value{}, err
	}
	return holder.Elem(), nil
}

func unpackResults(results []reflect.Value) (any, error) {
	if len(results) == 0 {
		return nil, nil
	}

	last := results[len(results)-1]
	if last.IsValid() && last.Type().Implements(errorType) {
		if !last.IsNil() {
			return nil, last.Interface().(error)
		}
		results = results[:len(results)-1]
	}

	switch len(results) {
	case 0:
		return nil, nil
	case 1:
		return results[0].Interface(), nil
	default:
		unpacked := make([]any, len(results))
		for index := range results {
			unpacked[index] = results[index].Interface()
		}
		return unpacked, nil
	}
}

type Server struct {
	options       Options
	assets        fs.FS
	app           *appcore.App
	ai            *aiservice.Service
	auth          *webAuthManager
	events        *eventHub
	invoker       *methodInvoker
	auditHeavySem chan struct{}
}

// SharedRuntimeOptions configures the authenticated loopback runtime used by
// native child windows. Authentication is intentionally owned by the caller so
// the same handler can be protected by a process-scoped token instead of the
// browser server's password/session flow.
type SharedRuntimeOptions struct {
	RuntimeBridgePath   string
	RuntimeBridgeScript string
}

// SharedRuntime exposes the existing frontend assets and reflective App/AI RPC
// bridge without creating a second backend. It is safe to host this on a
// loopback-only listener owned by the desktop process.
type SharedRuntime struct {
	server              *Server
	runtimeBridgePath   string
	runtimeBridgeScript string
	handler             http.Handler
}

// NewSharedRuntime creates an HTTP runtime backed by the already-running
// desktop App and AI service. The caller remains responsible for their
// lifecycle.
func NewSharedRuntime(assetFS fs.FS, app *appcore.App, ai *aiservice.Service, options SharedRuntimeOptions) (*SharedRuntime, error) {
	if assetFS == nil {
		return nil, fmt.Errorf("web assets are unavailable")
	}
	if app == nil || ai == nil {
		return nil, fmt.Errorf("shared App and AI service are required")
	}
	frontendFS, err := fs.Sub(assetFS, "frontend/dist")
	if err != nil {
		return nil, fmt.Errorf("resolve frontend dist assets failed: %w", err)
	}

	bridgePath := strings.TrimSpace(options.RuntimeBridgePath)
	if bridgePath == "" || !strings.HasPrefix(bridgePath, internalRoutePrefix+"/") {
		return nil, fmt.Errorf("runtime bridge path must be under %s", internalRoutePrefix)
	}

	events := newEventHub()
	invoker, err := newMethodInvoker(app, ai)
	if err != nil {
		return nil, err
	}
	invoker.allowDesktopMethods = true
	shared := &SharedRuntime{
		server: &Server{
			assets:        frontendFS,
			app:           app,
			ai:            ai,
			events:        events,
			invoker:       invoker,
			auditHeavySem: make(chan struct{}, 1),
		},
		runtimeBridgePath:   bridgePath,
		runtimeBridgeScript: options.RuntimeBridgeScript,
	}
	shared.handler = shared.routes()
	return shared, nil
}

// Handler returns the shared runtime HTTP handler.
func (s *SharedRuntime) Handler() http.Handler {
	if s == nil {
		return http.NotFoundHandler()
	}
	return s.handler
}

// Emit publishes a backend event to every native child window connected to the
// shared runtime event stream.
func (s *SharedRuntime) Emit(name string, args ...any) {
	if s == nil || s.server == nil || s.server.events == nil {
		return
	}
	s.server.events.Emit(name, args...)
}

// EmitTo publishes a backend event only to the native child window whose SSE
// stream is identified by targetID. Targeted events use a reliable per-stream
// queue so control commands are not discarded when the broadcast queue is full.
func (s *SharedRuntime) EmitTo(targetID string, name string, args ...any) {
	if s == nil || s.server == nil || s.server.events == nil {
		return
	}
	s.server.events.EmitTo(targetID, name, args...)
}

// EmitToBestEffort publishes a high-frequency event to one child without
// allowing a slow SSE consumer to grow its queue without bound.
func (s *SharedRuntime) EmitToBestEffort(targetID string, name string, args ...any) {
	if s == nil || s.server == nil || s.server.events == nil {
		return
	}
	s.server.events.EmitToBestEffort(targetID, name, args...)
}

func (s *SharedRuntime) routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle(internalRoutePrefix+"/api/invoke", httpserverlimits.LimitRequestBody(http.HandlerFunc(s.server.handleInvoke)))
	mux.Handle(internalRoutePrefix+"/events", httpserverlimits.StreamingWriteTimeout(http.HandlerFunc(s.server.handleEvents)))
	mux.HandleFunc(s.runtimeBridgePath, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = w.Write([]byte(s.runtimeBridgeScript))
	})
	mux.HandleFunc(internalRoutePrefix+"/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})

	fileServer := http.FileServer(http.FS(s.server.assets))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if strings.HasPrefix(r.URL.Path, internalRoutePrefix+"/") {
			http.NotFound(w, r)
			return
		}
		if s.server.shouldServeIndex(r.URL.Path) {
			payload, err := fs.ReadFile(s.server.assets, "index.html")
			if err != nil {
				http.Error(w, "frontend index is unavailable", http.StatusInternalServerError)
				return
			}
			html := injectBodyScript(string(payload), s.runtimeBridgePath)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			http.ServeContent(w, r, "index.html", time.Time{}, strings.NewReader(html))
			return
		}
		fileServer.ServeHTTP(w, r)
	})
	return withSecurityHeaders(mux)
}

func ParseOptions(args []string) (Options, error) {
	options := Options{
		Addr: defaultWebServerAddr,
	}
	if envAddr := strings.TrimSpace(os.Getenv("GONAVI_WEB_ADDR")); envAddr != "" {
		options.Addr = envAddr
	}
	fs := flag.NewFlagSet("gonavi web-server", flag.ContinueOnError)
	fs.SetOutput(ioDiscard{})
	fs.StringVar(&options.Addr, "addr", options.Addr, "web server listen address, for example 127.0.0.1:34116")
	if err := fs.Parse(args); err != nil {
		return Options{}, err
	}
	if fs.NArg() > 0 {
		return Options{}, fmt.Errorf("unknown web-server arguments: %s", strings.Join(fs.Args(), " "))
	}
	return options, nil
}

func Run(ctx context.Context, assetFS fs.FS, args []string) error {
	options, err := ParseOptions(args)
	if err != nil {
		return err
	}
	server, err := New(ctx, assetFS, options)
	if err != nil {
		return err
	}
	return server.Run(ctx)
}

func New(ctx context.Context, assetFS fs.FS, options Options) (*Server, error) {
	if assetFS == nil {
		return nil, fmt.Errorf("web assets are unavailable")
	}
	frontendFS, err := fs.Sub(assetFS, "frontend/dist")
	if err != nil {
		return nil, fmt.Errorf("resolve frontend dist assets failed: %w", err)
	}

	events := newEventHub()
	lifecycleCtx := uievents.WithEmitter(ctx, events)

	app := appcore.NewWebApp()
	appcore.InitializeLifecycle(app, lifecycleCtx)
	ai := aiservice.NewService()
	aiservice.InitializeLifecycle(ai, lifecycleCtx)
	invoker, err := newMethodInvoker(app, ai)
	if err != nil {
		return nil, err
	}
	auth, err := newWebAuthManagerFromEnvironment("")
	if err != nil {
		return nil, fmt.Errorf("initialize web auth failed: %w", err)
	}

	return &Server{
		options:       options,
		assets:        frontendFS,
		app:           app,
		ai:            ai,
		auth:          auth,
		events:        events,
		invoker:       invoker,
		auditHeavySem: make(chan struct{}, 1),
	}, nil
}

func (s *Server) Run(ctx context.Context) error {
	if s == nil {
		return fmt.Errorf("web server is not initialized")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	defer s.ai.Shutdown()
	defer s.app.Shutdown()

	httpServer := &http.Server{
		Addr:              s.options.Addr,
		Handler:           s.routes(),
		ReadHeaderTimeout: httpserverlimits.ReadHeaderTimeout,
		ReadTimeout:       httpserverlimits.ReadTimeout,
		WriteTimeout:      httpserverlimits.WriteTimeout,
		IdleTimeout:       httpserverlimits.IdleTimeout,
	}

	listener, err := net.Listen("tcp", s.options.Addr)
	if err != nil {
		return err
	}
	logger.Infof("GoNavi Web Server 启动：addr=%s", listener.Addr().String())

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(listener)
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownErr := httpServer.Shutdown(shutdownCtx)
		serveErr := <-errCh
		if shutdownErr != nil && !errors.Is(shutdownErr, http.ErrServerClosed) {
			return shutdownErr
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return serveErr
		}
		return nil
	}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(internalRoutePrefix+"/auth/status", s.handleAuthStatus)
	mux.Handle(internalRoutePrefix+"/auth/setup/bootstrap", httpserverlimits.LimitRequestBody(http.HandlerFunc(s.handleSetupBootstrap)))
	mux.Handle(internalRoutePrefix+"/auth/setup/complete", httpserverlimits.LimitRequestBody(http.HandlerFunc(s.handleSetupComplete)))
	mux.Handle(internalRoutePrefix+"/auth/login", httpserverlimits.LimitRequestBody(http.HandlerFunc(s.handleLogin)))
	mux.HandleFunc(internalRoutePrefix+"/auth/logout", s.handleLogout)
	mux.Handle(internalRoutePrefix+"/auth/settings", s.requireWebAuth(http.HandlerFunc(s.handleAuthSettings)))
	mux.Handle(internalRoutePrefix+"/auth/settings/password", s.requireWebAuth(httpserverlimits.LimitRequestBody(http.HandlerFunc(s.handleAuthPasswordChange))))
	mux.Handle(internalRoutePrefix+"/api/invoke", s.requireWebAuth(httpserverlimits.LimitRequestBody(http.HandlerFunc(s.handleInvoke))))
	mux.Handle(internalRoutePrefix+"/api/upload", s.requireWebAuth(http.HandlerFunc(s.handleWebUpload)))
	mux.Handle(internalRoutePrefix+"/api/download/", s.requireWebAuth(httpserverlimits.StreamingWriteTimeout(http.HandlerFunc(s.handleWebDownload))))
	mux.Handle(internalRoutePrefix+"/events", s.requireWebAuth(httpserverlimits.StreamingWriteTimeout(http.HandlerFunc(s.handleEvents))))
	mux.Handle(internalRoutePrefix+"/web-runtime.js", s.requireWebAuth(http.HandlerFunc(s.handleRuntimeBridge)))
	mux.HandleFunc(internalRoutePrefix+"/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/login", s.handleLoginPage)
	mux.HandleFunc("/setup", s.handleSetupPage)
	fileServer := http.FileServer(http.FS(s.assets))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, internalRoutePrefix+"/") {
			http.NotFound(w, r)
			return
		}
		status := s.auth.Status(func() string {
			sessionID, _ := readSessionCookie(r)
			return sessionID
		}())
		if !status.Configured {
			http.Redirect(w, r, buildAuthRedirectURL("/setup", r.URL.RequestURI()), http.StatusSeeOther)
			return
		}
		if !status.Authenticated {
			clearSessionCookie(w, r)
			http.Redirect(w, r, buildAuthRedirectURL("/login", r.URL.RequestURI()), http.StatusSeeOther)
			return
		}
		if s.shouldServeIndex(r.URL.Path) {
			s.serveIndex(w, r)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
	return withSecurityHeaders(mux)
}

func (s *Server) shouldServeIndex(requestPath string) bool {
	cleaned := strings.TrimPrefix(path.Clean("/"+requestPath), "/")
	if cleaned == "" || cleaned == "." {
		return true
	}
	if strings.Contains(path.Base(cleaned), ".") {
		file, err := s.assets.Open(cleaned)
		if err != nil {
			return false
		}
		defer file.Close()
		info, err := file.Stat()
		return err == nil && info.IsDir()
	}
	return true
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	payload, err := fs.ReadFile(s.assets, "index.html")
	if err != nil {
		http.Error(w, "frontend index is unavailable", http.StatusInternalServerError)
		return
	}
	html := injectRuntimeBridge(string(payload))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, strings.NewReader(html))
}

func injectRuntimeBridge(indexHTML string) string {
	return injectScript(indexHTML, internalRoutePrefix+"/web-runtime.js")
}

func injectScript(indexHTML string, scriptPath string) string {
	if strings.Contains(indexHTML, scriptPath) {
		return indexHTML
	}
	scriptTag := fmt.Sprintf(`<script src="%s"></script>`, scriptPath)
	if strings.Contains(indexHTML, "</head>") {
		return strings.Replace(indexHTML, "</head>", scriptTag+"\n</head>", 1)
	}
	return scriptTag + "\n" + indexHTML
}

func injectBodyScript(indexHTML string, scriptPath string) string {
	if strings.Contains(indexHTML, scriptPath) {
		return indexHTML
	}
	scriptTag := fmt.Sprintf(`<script src="%s"></script>`, scriptPath)
	if strings.Contains(indexHTML, "</body>") {
		return strings.Replace(indexHTML, "</body>", scriptTag+"\n</body>", 1)
	}
	return injectScript(indexHTML, scriptPath)
}

func (s *Server) handleInvoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var request invokeRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.writeInvokeResponse(w, http.StatusBadRequest, invokeResponse{Error: err.Error()})
		return
	}
	var webTrace *requesttrace.Handle
	if shouldTraceWebInvoke(request) {
		if traceStore := appcore.RequestTraceStoreForEntryPoint(s.app); traceStore != nil {
			webTrace = traceStore.Start(webInvokeTraceInput(request))
		}
	}
	writeResponse := func(status int, response invokeResponse) {
		requestID := ""
		if resultRequestID := webInvokeResultRequestID(response.Result); resultRequestID != "" {
			requestID = resultRequestID
		} else if webTrace != nil && webTrace.ID() != "" {
			requestID = webTrace.ID()
		}
		response.RequestID = requestID
		if webTrace != nil {
			completeWebInvokeTrace(webTrace, response)
		}
		if r.Context().Err() != nil {
			return
		}
		if requestID != "" {
			w.Header().Set("X-GoNavi-Request-ID", requestID)
		}
		s.writeInvokeResponse(w, status, response)
	}
	if isSQLAuditHeavyInvoke(request) && s.auditHeavySem != nil {
		select {
		case s.auditHeavySem <- struct{}{}:
			defer func() { <-s.auditHeavySem }()
		default:
			writeResponse(http.StatusTooManyRequests, invokeResponse{Error: "another SQL audit export or integrity verification is already in progress"})
			return
		}
	}
	result, err := s.invoker.Invoke(r.Context(), request)
	if err != nil {
		writeResponse(http.StatusBadRequest, invokeResponse{Error: err.Error()})
		return
	}
	writeResponse(http.StatusOK, invokeResponse{Result: result})
}

func isSQLAuditHeavyInvoke(request invokeRequest) bool {
	namespace := strings.ToLower(strings.TrimSpace(request.Namespace))
	receiver := strings.ToLower(strings.TrimSpace(request.Receiver))
	if namespace != "app" || (receiver != "" && receiver != "app") {
		return false
	}
	switch strings.TrimSpace(request.Method) {
	case "BuildSQLAuditExport", "VerifySQLAuditIntegrity":
		return true
	default:
		return false
	}
}

func (s *Server) writeInvokeResponse(w http.ResponseWriter, status int, response invokeResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	subscriber := s.events.subscribe(r.Header.Get(detachedWindowIDHeader))
	defer s.events.unsubscribe(subscriber)

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	_, _ = w.Write([]byte(": connected\n\n"))
	flusher.Flush()

	for {
		if msg, ok := subscriber.dequeue(); ok {
			if err := writeEventStreamMessage(w, msg, subscriber.targetID != ""); err != nil {
				return
			}
			flusher.Flush()
			continue
		}
		select {
		case <-r.Context().Done():
			return
		case <-subscriber.done:
			return
		case <-subscriber.wake:
			continue
		case <-ticker.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeEventStreamMessage(writer io.Writer, msg eventMessage, fragmented bool) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(writer, "event: gonavi\n"); err != nil {
		return err
	}
	chunkSize := len(payload)
	if fragmented {
		chunkSize = eventStreamDataChunkBytes
	}
	for offset := 0; offset < len(payload); offset += chunkSize {
		end := offset + chunkSize
		if end > len(payload) {
			end = len(payload)
		}
		if _, err := fmt.Fprintf(writer, "data: %s\n", payload[offset:end]); err != nil {
			return err
		}
	}
	_, err = io.WriteString(writer, "\n")
	return err
}

func (s *Server) handleRuntimeBridge(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	_, _ = w.Write([]byte(runtimeBridgeScript()))
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) {
	return len(p), nil
}
