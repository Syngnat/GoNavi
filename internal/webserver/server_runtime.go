package webserver

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	httpserverlimits "GoNavi-Wails/internal/httpserver"
	"GoNavi-Wails/internal/uievents"
)

type Server struct {
	options       Options
	assets        fs.FS
	app           *appcore.App
	ai            *aiservice.Service
	auth          *webAuthManager
	events        *eventHub
	invoker       *methodInvoker
	auditHeavySem chan struct{}
	// boundAddr records the actual listener address once runHTTP has bound
	// the socket, which is observable by tests when Addr uses port zero.
	boundAddr atomic.Value
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
	frontendFS, err := resolveFrontendAssets(assetFS)
	if err != nil {
		return nil, err
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
	mux.Handle(internalRoutePrefix+"/api/invoke", wrapInvokeRoute(http.HandlerFunc(s.server.handleInvoke)))
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

// webServerUsage 是 web-server 模式的用法文本。flag 包默认会把用法打到自己的
// 输出上，但我们把输出改成了丢弃（见 ParseOptions），因此这里自行维护一份，
// 由 Run 在需要时写到 stdout。
const webServerUsage = `用法：gonavi web-server [选项]

选项：
  --addr <主机:端口>   监听地址，默认 127.0.0.1:34116
                      也可用环境变量 GONAVI_WEB_ADDR 指定

示例：
  gonavi web-server --addr 127.0.0.1:34116
`

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
		// flag 包把 -h/--help 也报成错误，但用户主动求助不是失败：按仓库 CLI
		// 惯例（internal/cli）把用法打到 stdout 并以 0 退出。此前这里会连同
		// 用法一起被 logger 吞进文件，终端只剩一个空屏和退出码 1。
		if errors.Is(err, flag.ErrHelp) {
			_, _ = fmt.Fprint(os.Stdout, webServerUsage)
			return nil
		}
		return err
	}
	// 只有命令行入口把横幅接到终端；New 的程序化调用方（测试、内嵌运行时）
	// 保持 Console 为空，避免污染它们的输出。
	options.Console = os.Stderr
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
	frontendFS, err := resolveFrontendAssets(assetFS)
	if err != nil {
		return nil, err
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

// resolveFrontendAssets accepts both the production ZIP layout, where Vite's
// output is stored at the FS root, and the development layout, where the
// project root contains frontend/dist.
func resolveFrontendAssets(assetFS fs.FS) (fs.FS, error) {
	if info, err := fs.Stat(assetFS, "index.html"); err == nil {
		if !info.IsDir() {
			return assetFS, nil
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("resolve frontend index asset failed: %w", err)
	}

	frontendFS, err := fs.Sub(assetFS, "frontend/dist")
	if err != nil {
		return nil, fmt.Errorf("resolve frontend dist assets failed: %w", err)
	}
	return frontendFS, nil
}
