package webserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"path"
	"strings"
	"time"

	appcore "GoNavi-Wails/internal/app"
	httpserverlimits "GoNavi-Wails/internal/httpserver"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/requesttrace"
)

func (s *Server) Run(ctx context.Context) error {
	if s == nil {
		return fmt.Errorf("web server is not initialized")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return s.runHTTP(ctx, s.routes())
}

// runHTTP owns the HTTP server lifecycle. The deferred resource teardown must
// only start once every in-flight handler has returned or was explicitly
// cancelled, otherwise live requests race closed databases and already
// shut-down services.
func (s *Server) runHTTP(ctx context.Context, handler http.Handler) error {
	defer s.shutdownTeardown()

	serveCtx, serveCancel := context.WithCancel(ctx)
	defer serveCancel()

	tracker := newRequestTracker()
	httpServer := &http.Server{
		Addr:              s.options.Addr,
		Handler:           withRequestLifecycle(serveCtx, tracker, handler),
		ReadHeaderTimeout: httpserverlimits.ReadHeaderTimeout,
		ReadTimeout:       httpserverlimits.ReadTimeout,
		WriteTimeout:      httpserverlimits.WriteTimeout,
		IdleTimeout:       httpserverlimits.IdleTimeout,
	}

	listener, err := net.Listen("tcp", s.options.Addr)
	if err != nil {
		return err
	}
	s.boundAddr.Store(listener.Addr().String())
	logger.Infof("GoNavi Web Server 启动：addr=%s", listener.Addr())
	s.writeStartupBanner(listener.Addr().String())

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(listener)
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		// Serve stopped accepting connections, but handlers already in flight
		// must still be drained before the resources they use are released.
		serveCancel()
		if remaining := tracker.waitDrain(shutdownDrainTimeout); remaining > 0 {
			logger.Warnf("Web Server 监听异常退出后仍有 %d 个请求未能在等待期内退出", remaining)
		}
		return err
	case <-ctx.Done():
		return s.shutdownHTTP(serveCtx, serveCancel, tracker, httpServer, errCh)
	}
}

// shutdownHTTP stops the listener, gives in-flight handlers a bounded grace
// period to finish normally, then force-cancels the survivors through their
// request contexts and waits for them to unwind. It returns only after every
// handler finished or was explicitly cancelled; the deferred App resource
// teardown starts the moment this returns.
func (s *Server) shutdownHTTP(serveCtx context.Context, serveCancel context.CancelFunc, tracker *requestTracker, httpServer *http.Server, errCh <-chan error) error {
	graceCtx, graceCancel := context.WithTimeout(context.Background(), shutdownGraceTimeout)
	defer graceCancel()
	shutdownErr := httpServer.Shutdown(graceCtx)
	if shutdownErr != nil && !errors.Is(shutdownErr, http.ErrServerClosed) {
		logger.Warnf("Web Server 优雅关闭等待超时：%v；活跃请求 %d 个，已发送强制取消信号", shutdownErr, tracker.active())
	}

	// http.Server.Shutdown never cancels active handlers; server-level
	// cancellation is delivered through each request's derived context.
	serveCancel()
	serveErr := <-errCh

	remaining := tracker.waitDrain(shutdownDrainTimeout)
	if remaining > 0 {
		return fmt.Errorf("web server shutdown: %d request handler(s) still active after forced cancellation and drain timeout", remaining)
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		return serveErr
	}
	// A graceful-phase timeout is already logged above; handlers unwound
	// after the explicit cancellation, so the shutdown itself succeeded.
	return nil
}

// shutdownTeardown releases App-owned resources after the HTTP handlers are
// done. Run defers it so teardown cannot race live requests.
func (s *Server) shutdownTeardown() {
	if s.app != nil {
		s.app.Shutdown()
	}
	if s.ai != nil {
		s.ai.Shutdown()
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
	mux.Handle(internalRoutePrefix+"/api/invoke", s.requireWebAuth(wrapInvokeRoute(http.HandlerFunc(s.handleInvoke))))
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
	clearLongRunningInvokeWriteDeadline(w, request.Method)
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

// writeStartupBanner 把监听地址与日志路径打到终端。
//
// 日志默认只写文件（internal/logger），CLI 启动后终端完全空白：用户既无法
// 确认服务是否就绪，也不知道失败原因该去哪里查（端口占用、前端资源缺失、
// 数据目录不可写都只体现在日志里）。失败的路径由 main.go 打印到 stderr，
// 这里只负责成功路径。
func (s *Server) writeStartupBanner(addr string) {
	if s == nil || s.options.Console == nil {
		return
	}
	// 监听 0.0.0.0 时直接给浏览器打开 0.0.0.0 是无效地址，展示回环地址。
	display := addr
	if host, port, err := net.SplitHostPort(addr); err == nil {
		if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
			display = net.JoinHostPort("127.0.0.1", port)
		}
	}
	_, _ = fmt.Fprintf(s.options.Console, "GoNavi Web Server 已启动：http://%s\n日志：%s\n", display, logger.Path())
}
