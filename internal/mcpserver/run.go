package mcpserver

import (
	"context"
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	httpserverlimits "GoNavi-Wails/internal/httpserver"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	defaultStreamableHTTPAddr     = "127.0.0.1:8765"
	defaultStreamableHTTPPath     = "/mcp"
	streamableHTTPShutdownTimeout = 5 * time.Second
	// streamableHTTPForceCloseTimeout 是优雅关闭超时后，等待活跃 handler
	// 响应强制取消并退出的有界窗口。超时后仍未返回的 handler 会被放弃
	// （goroutine 无法强制终止），关闭流程继续推进，保证 Backend.Close
	// 与进程退出不被无限阻塞。
	streamableHTTPForceCloseTimeout = 3 * time.Second
	// stdioShutdownTimeout 是 stdio 服务在父 Context 取消后等待在途工具
	// 调用自然完成的有界窗口。SDK 的 jsonrpc2 连接层经 notDone 与请求
	// Context 脱钩，取消无法传播到工具 handler，无法像 Streamable HTTP
	// 那样强制取消；超时后放弃等待，保证 Backend.Close 与进程退出不被
	// 无限阻塞。
	stdioShutdownTimeout = 5 * time.Second
)

// HTTPServerOptions 描述远程 Streamable HTTP MCP 入口。
type HTTPServerOptions struct {
	Addr             string
	Path             string
	Token            string
	JSONResponse     bool
	SchemaOnly       bool
	AllowNonLoopback bool
}

// StreamableHTTPServerHandle 表示一个已启动的 Streamable HTTP MCP server。
type StreamableHTTPServerHandle struct {
	Addr       string
	Path       string
	SchemaOnly bool

	cancel context.CancelFunc
	done   chan struct{}
	mu     sync.Mutex
	err    error
}

// Stop 关闭 HTTP MCP server，并等待底层 http.Server 完成退出。
func (h *StreamableHTTPServerHandle) Stop(ctx context.Context) error {
	if h == nil {
		return nil
	}
	if h.cancel != nil {
		h.cancel()
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-h.done:
		return h.waitErr()
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Wait 阻塞直到 HTTP MCP server 退出。
func (h *StreamableHTTPServerHandle) Wait() error {
	if h == nil {
		return nil
	}
	<-h.done
	return h.waitErr()
}

func (h *StreamableHTTPServerHandle) complete(err error) {
	h.mu.Lock()
	h.err = err
	h.mu.Unlock()
	close(h.done)
}

func (h *StreamableHTTPServerHandle) waitErr() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.err
}

// RunAppStdioServer 启动基于真实 GoNavi App 的 stdio MCP server。
func RunAppStdioServer(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}

	backend, err := NewAppBackend(ctx)
	if err != nil {
		return err
	}
	defer backend.Close(ctx)

	return RunStdioServer(ctx, backend)
}

// errAbandonedStdioHandlers 标记 stdio 优雅窗口耗尽后仍有在途工具调用未完成。
var errAbandonedStdioHandlers = errors.New("stdio handlers abandoned after shutdown wait")

// RunStdioServer 使用指定 backend 启动 stdio MCP server。
func RunStdioServer(ctx context.Context, backend Backend) error {
	if ctx == nil {
		ctx = context.Background()
	}
	return runStdioServer(ctx, backend, &mcp.StdioTransport{}, stdioShutdownTimeout)
}

// runStdioServer 包装 Server.Run：ctx 取消后先给在途请求一个优雅窗口
// 自然完成，超时则放弃等待。SDK 的 Server.Run 在 ctx 取消后调用
// ss.Close() 并等待 jsonrpc2 连接空闲；工具调用 context 经 notDone 与
// 父 Context 脱钩，阻塞的 handler 收不到取消信号也无法被强制终止，
// 原先会让进程永久挂起、Backend.Close 永不执行。放弃契约与 Streamable
// HTTP（forceCloseActiveRequests）一致：被放弃的工具调用之后可能在
// 已关闭的 backend 上报错，属于相比进程永久卡死的有意取舍。
func runStdioServer(ctx context.Context, backend Backend, transport mcp.Transport, shutdownTimeout time.Duration) error {
	server := NewServer(backend)
	runDone := make(chan error, 1)
	go func() {
		runDone <- server.Run(ctx, transport)
	}()

	select {
	case err := <-runDone:
		return err
	case <-ctx.Done():
	}
	graceTimer := time.NewTimer(shutdownTimeout)
	defer graceTimer.Stop()
	select {
	case err := <-runDone:
		return err
	case <-graceTimer.C:
		return fmt.Errorf("%w: 优雅窗口 %v 内仍有在途工具调用未完成，已放弃等待", errAbandonedStdioHandlers, shutdownTimeout)
	}
}

// StartAppStreamableHTTPServer 启动基于真实 GoNavi App 的 Streamable HTTP MCP server，并立即返回可停止句柄。
func StartAppStreamableHTTPServer(ctx context.Context, options HTTPServerOptions) (*StreamableHTTPServerHandle, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	backend, err := NewAppBackend(ctx)
	if err != nil {
		return nil, err
	}
	handle, err := StartStreamableHTTPServer(ctx, backend, options)
	if err != nil {
		_ = backend.Close(context.Background())
		return nil, err
	}

	closeBackendAfterServerStops(handle, backend)
	return handle, nil
}

func closeBackendAfterServerStops(handle *StreamableHTTPServerHandle, backend Backend) {
	go func() {
		_ = handle.Wait()
		_ = backend.Close(context.Background())
	}()
}

// RunAppStreamableHTTPServer 启动基于真实 GoNavi App 的 Streamable HTTP MCP server。
func RunAppStreamableHTTPServer(ctx context.Context, options HTTPServerOptions) error {
	if ctx == nil {
		ctx = context.Background()
	}

	handle, err := StartAppStreamableHTTPServer(ctx, options)
	if err != nil {
		return err
	}
	return handle.Wait()
}

// RunStreamableHTTPServer 使用指定 backend 启动带 bearer token 的 Streamable HTTP MCP server。
func RunStreamableHTTPServer(ctx context.Context, backend Backend, options HTTPServerOptions) error {
	handle, err := StartStreamableHTTPServer(ctx, backend, options)
	if err != nil {
		return err
	}
	return handle.Wait()
}

// StartStreamableHTTPServer 使用指定 backend 启动带 bearer token 的 Streamable HTTP MCP server，并返回可停止句柄。
func StartStreamableHTTPServer(ctx context.Context, backend Backend, options HTTPServerOptions) (*StreamableHTTPServerHandle, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	normalized, err := normalizeHTTPServerOptions(options)
	if err != nil {
		return nil, err
	}

	server := NewServerWithOptions(backend, ServerOptions{SchemaOnly: normalized.SchemaOnly})
	streamableHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return server
	}, &mcp.StreamableHTTPOptions{
		JSONResponse:   normalized.JSONResponse,
		SessionTimeout: 30 * time.Minute,
	})
	return startStreamableHTTPServer(ctx, normalized, streamableHandler, streamableHTTPShutdownTimeout, streamableHTTPForceCloseTimeout)
}

func startStreamableHTTPServer(ctx context.Context, options HTTPServerOptions, streamableHandler http.Handler, shutdownTimeout time.Duration, forceCloseTimeout time.Duration) (*StreamableHTTPServerHandle, error) {
	var activeRequests sync.WaitGroup
	inFlight := newActiveRequestTracker()
	requestHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// 为每个请求派生可取消 context 并替换进 req：感知 req.Context()
		// 的 HTTP 层处理代码可在强制关闭阶段立即收到取消信号。注意 MCP
		// SDK 的工具调用 context 在 jsonrpc2 连接层与请求 context 脱钩，
		// 不会收到该信号；真正解除阻塞的是 forceCloseActiveRequests 中
		// 的 httpServer.Close 硬断连接。
		reqCtx, cancelReq := context.WithCancel(req.Context())
		defer cancelReq()
		req = req.Clone(reqCtx)
		activeRequests.Add(1)
		inFlight.add(req, cancelReq)
		defer inFlight.remove(req)
		defer activeRequests.Done()
		streamableHandler.ServeHTTP(w, req)
	})

	httpServer := &http.Server{
		Addr:              options.Addr,
		Handler:           streamableHTTPRoutes(options, requestHandler),
		ReadHeaderTimeout: httpserverlimits.ReadHeaderTimeout,
		ReadTimeout:       httpserverlimits.ReadTimeout,
		WriteTimeout:      httpserverlimits.WriteTimeout,
		IdleTimeout:       httpserverlimits.IdleTimeout,
	}

	listener, err := net.Listen("tcp", options.Addr)
	if err != nil {
		return nil, err
	}

	serverCtx, cancel := context.WithCancel(ctx)
	handle := &StreamableHTTPServerHandle{
		Addr:       listener.Addr().String(),
		Path:       options.Path,
		SchemaOnly: options.SchemaOnly,
		cancel:     cancel,
		done:       make(chan struct{}),
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(listener)
	}()

	go func() {
		select {
		case err := <-errCh:
			cancel()
			// Serve can fail for reasons other than an intentional shutdown while
			// authenticated handlers are still using the backend. Force-close the
			// in-flight requests within a bounded window so the shutdown flow can
			// proceed even if a handler ignores cancellation.
			abandonErr := forceCloseActiveRequests(httpServer, inFlight, &activeRequests, forceCloseTimeout)
			if abandonErr != nil {
				if err != nil && !errors.Is(err, http.ErrServerClosed) {
					abandonErr = errors.Join(abandonErr, err)
				}
				handle.complete(abandonErr)
				return
			}
			if errors.Is(err, http.ErrServerClosed) {
				handle.complete(nil)
				return
			}
			handle.complete(err)
		case <-serverCtx.Done():
			shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
			defer shutdownCancel()
			shutdownErr := httpServer.Shutdown(shutdownCtx)
			serveErr := <-errCh
			// 优雅窗口耗尽仍有活跃 handler：取消其请求 context 并强制关闭
			// 连接，在有界窗口内等待。原先这里是无界 activeRequests.Wait()，
			// 一个不返回的 handler 会永久阻塞 Backend.Close 与进程退出。
			var abandonErr error
			if shutdownErr != nil {
				// Shutdown 只返回 nil 或 ctx.Err()，到达这里的都是优雅窗口超时。
				abandonErr = forceCloseActiveRequests(httpServer, inFlight, &activeRequests, forceCloseTimeout)
			}
			if abandonErr != nil {
				if shutdownErr != nil {
					abandonErr = errors.Join(abandonErr, shutdownErr)
				}
				handle.complete(abandonErr)
				return
			}
			if shutdownErr != nil {
				handle.complete(shutdownErr)
				return
			}
			if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				handle.complete(serveErr)
				return
			}
			handle.complete(nil)
		}
	}()

	return handle, nil
}

// activeRequestTracker 跟踪在途 HTTP 请求及其派生 context 的取消函数，
// 供强制关闭阶段统一取消。
type activeRequestTracker struct {
	mu   sync.Mutex
	reqs map[*http.Request]context.CancelFunc
}

func newActiveRequestTracker() *activeRequestTracker {
	return &activeRequestTracker{reqs: make(map[*http.Request]context.CancelFunc)}
}

func (t *activeRequestTracker) add(req *http.Request, cancel context.CancelFunc) {
	t.mu.Lock()
	t.reqs[req] = cancel
	t.mu.Unlock()
}

func (t *activeRequestTracker) remove(req *http.Request) {
	t.mu.Lock()
	delete(t.reqs, req)
	t.mu.Unlock()
}

// cancelAll 取消全部在途请求的派生 context，返回取消数量。
func (t *activeRequestTracker) cancelAll() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	count := len(t.reqs)
	for _, cancel := range t.reqs {
		cancel()
	}
	t.reqs = make(map[*http.Request]context.CancelFunc)
	return count
}

// errAbandonedActiveHandlers 标记强制关闭窗口耗尽后仍有活跃 handler 未退出。
var errAbandonedActiveHandlers = errors.New("active handlers abandoned after force close")

// forceCloseActiveRequests 在优雅关闭窗口耗尽后强制终止仍在运行的活跃 HTTP
// 请求：先取消其派生 context（感知 req.Context 的处理代码可立即退出），
// 再关闭底层连接硬断 SDK 会话等待，然后在 forceTimeout 内等待 HTTP
// handler 返回。超时后仍未返回的 handler 将被放弃并返回
// errAbandonedActiveHandlers——Go 无法强制杀死 goroutine，但关闭流程必须
// 继续推进，保证 Backend.Close 与进程退出不被无限阻塞。
//
// 放弃契约：本函数只保证 HTTP handler 层退出；仍在运行的 MCP 工具调用
// goroutine 不会被终止，可能在 Backend.Close 之后继续访问已关闭的
// backend 资源（database/sql 并发 Close 安全，通常表现为该调用报错）。
// 这是相比进程永久卡死的有意取舍。
func forceCloseActiveRequests(httpServer *http.Server, tracker *activeRequestTracker, activeRequests *sync.WaitGroup, forceTimeout time.Duration) error {
	canceled := tracker.cancelAll()
	_ = httpServer.Close()
	drained := make(chan struct{})
	go func() {
		activeRequests.Wait()
		close(drained)
	}()
	select {
	case <-drained:
		return nil
	case <-time.After(forceTimeout):
		return fmt.Errorf("%w: 强制取消 %d 个在途请求后，仍有请求未在 %v 内退出，已放弃等待", errAbandonedActiveHandlers, canceled, forceTimeout)
	}
}

func streamableHTTPRoutes(options HTTPServerOptions, streamableHandler http.Handler) http.Handler {
	streamableHandler = httpserverlimits.StreamingWriteTimeoutWhen(streamableHandler, func(r *http.Request) bool {
		// GET is always the standalone SSE stream. Unless JSONResponse was
		// explicitly requested, POST call responses are SSE streams as well.
		return r.Method == http.MethodGet || !options.JSONResponse
	})

	mux := http.NewServeMux()
	mux.Handle(options.Path, bearerTokenAuthHandler(options.Token, httpserverlimits.LimitRequestBody(streamableHandler)))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "ok")
	})
	return mux
}

// ParseHTTPServerOptions 解析 http 模式参数，并支持环境变量兜底。
func ParseHTTPServerOptions(args []string) (HTTPServerOptions, error) {
	defaultAddr := strings.TrimSpace(os.Getenv("GONAVI_MCP_HTTP_ADDR"))
	if defaultAddr == "" {
		defaultAddr = defaultStreamableHTTPAddr
	}
	defaultPath := strings.TrimSpace(os.Getenv("GONAVI_MCP_HTTP_PATH"))
	if defaultPath == "" {
		defaultPath = defaultStreamableHTTPPath
	}

	options := HTTPServerOptions{
		Addr:             defaultAddr,
		Path:             defaultPath,
		Token:            strings.TrimSpace(os.Getenv("GONAVI_MCP_HTTP_TOKEN")),
		JSONResponse:     true,
		SchemaOnly:       parseBoolEnvDefault("GONAVI_MCP_SCHEMA_ONLY", false),
		AllowNonLoopback: parseBoolEnvDefault("GONAVI_MCP_HTTP_ALLOW_NON_LOOPBACK", false),
	}
	fs := flag.NewFlagSet("gonavi-mcp-server http", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&options.Addr, "addr", options.Addr, "HTTP listen address, for example 127.0.0.1:8765")
	fs.StringVar(&options.Path, "path", options.Path, "HTTP MCP path")
	fs.StringVar(&options.Token, "token", options.Token, "bearer token required by remote MCP clients")
	fs.BoolVar(&options.JSONResponse, "json-response", options.JSONResponse, "return application/json streamable responses when possible")
	fs.BoolVar(&options.SchemaOnly, "schema-only", options.SchemaOnly, "only expose schema inspection tools and omit execute_sql")
	fs.BoolVar(&options.AllowNonLoopback, "allow-non-loopback", options.AllowNonLoopback, "allow binding HTTP outside loopback for explicit container deployments")
	if err := fs.Parse(args); err != nil {
		return HTTPServerOptions{}, err
	}
	if fs.NArg() > 0 {
		return HTTPServerOptions{}, fmt.Errorf("未知 http 参数: %s", strings.Join(fs.Args(), " "))
	}
	return options, nil
}

func parseBoolEnvDefault(name string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func normalizeHTTPServerOptions(options HTTPServerOptions) (HTTPServerOptions, error) {
	options.Addr = strings.TrimSpace(options.Addr)
	if options.Addr == "" {
		options.Addr = defaultStreamableHTTPAddr
	}
	if err := validateHTTPServerAddr(options.Addr, options.AllowNonLoopback); err != nil {
		return HTTPServerOptions{}, err
	}
	options.Path = strings.TrimSpace(options.Path)
	if options.Path == "" {
		options.Path = defaultStreamableHTTPPath
	}
	if !strings.HasPrefix(options.Path, "/") {
		options.Path = "/" + options.Path
	}
	options.Token = strings.TrimSpace(options.Token)
	if options.Token == "" {
		return HTTPServerOptions{}, errors.New("远程 MCP HTTP 模式必须设置 bearer token，可使用 --token 或 GONAVI_MCP_HTTP_TOKEN")
	}
	return options, nil
}

func validateHTTPServerAddr(addr string, allowNonLoopback bool) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("MCP HTTP address must include a loopback host and port: %w", err)
	}
	if allowNonLoopback {
		return nil
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("MCP HTTP server must bind to loopback (127.0.0.1, ::1, or localhost), got %q", addr)
	}
	return nil
}

func bearerTokenAuthHandler(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !hasBearerToken(req, token) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="GoNavi MCP"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, req)
	})
}

func hasBearerToken(req *http.Request, token string) bool {
	if req == nil {
		return false
	}
	expected := strings.TrimSpace(token)
	if expected == "" {
		return false
	}
	header := strings.TrimSpace(req.Header.Get("Authorization"))
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return false
	}
	actual := strings.TrimSpace(header[len("bearer "):])
	if actual == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}
