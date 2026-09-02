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

// RunStdioServer 使用指定 backend 启动 stdio MCP server。
func RunStdioServer(ctx context.Context, backend Backend) error {
	if ctx == nil {
		ctx = context.Background()
	}

	server := NewServer(backend)
	return server.Run(ctx, &mcp.StdioTransport{})
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
	return startStreamableHTTPServer(ctx, normalized, streamableHandler, streamableHTTPShutdownTimeout)
}

func startStreamableHTTPServer(ctx context.Context, options HTTPServerOptions, streamableHandler http.Handler, shutdownTimeout time.Duration) (*StreamableHTTPServerHandle, error) {
	var activeRequests sync.WaitGroup
	requestHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		activeRequests.Add(1)
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
			// authenticated handlers are still using the backend.
			activeRequests.Wait()
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
			// A Shutdown timeout does not stop active handlers; keep the backend alive until they return.
			activeRequests.Wait()
			if shutdownErr != nil && !errors.Is(shutdownErr, http.ErrServerClosed) {
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
