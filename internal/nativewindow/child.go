package nativewindow

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ChildOptions are intentionally small; the potentially large tab payload is
// kept in the parent registry and fetched through Bootstrap.
type ChildOptions struct {
	ParentURL string
	ParentPID int
	Token     string
	ID        string
	Kind      string
	Title     string
	X         int
	Y         int
	Width     int
	Height    int
}

func ParseChildOptions(args []string) (ChildOptions, error) {
	result := ChildOptions{
		ParentURL: strings.TrimSpace(os.Getenv(envParentURL)),
		ParentPID: environmentInt(envParentPID, 0),
		Token:     strings.TrimSpace(os.Getenv(envToken)),
		ID:        strings.TrimSpace(os.Getenv(envWindowID)),
		Kind:      strings.TrimSpace(os.Getenv(envKind)),
		Title:     strings.TrimSpace(os.Getenv(envTitle)),
		X:         environmentInt(envX, 0),
		Y:         environmentInt(envY, 0),
		Width:     environmentInt(envWidth, defaultWindowWidth),
		Height:    environmentInt(envHeight, defaultWindowHeight),
	}
	flags := flag.NewFlagSet("gonavi detached-window", flag.ContinueOnError)
	flags.SetOutput(discardWriter{})
	flags.StringVar(&result.ParentURL, "parent-url", result.ParentURL, "parent loopback bridge URL")
	flags.IntVar(&result.ParentPID, "parent-pid", result.ParentPID, "parent process ID")
	flags.StringVar(&result.Token, "token", result.Token, "parent bridge token")
	flags.StringVar(&result.ID, "id", result.ID, "detached window ID")
	flags.StringVar(&result.Kind, "kind", result.Kind, "detached window kind")
	flags.StringVar(&result.Title, "title", result.Title, "native window title")
	flags.IntVar(&result.X, "x", result.X, "virtual desktop x coordinate")
	flags.IntVar(&result.Y, "y", result.Y, "virtual desktop y coordinate")
	flags.IntVar(&result.Width, "width", result.Width, "window width")
	flags.IntVar(&result.Height, "height", result.Height, "window height")
	if err := flags.Parse(args); err != nil {
		return ChildOptions{}, err
	}
	if flags.NArg() > 0 {
		return ChildOptions{}, fmt.Errorf("unknown detached-window arguments: %s", strings.Join(flags.Args(), " "))
	}
	if result.ParentPID <= 1 {
		result.ParentPID = os.Getppid()
	}
	result.Kind = strings.TrimSpace(result.Kind)
	if result.Kind == "" {
		result.Kind = "workbench"
	}
	result.Title = strings.TrimSpace(result.Title)
	if result.Title == "" {
		result.Title = "GoNavi"
	}
	if result.Width <= 0 {
		result.Width = defaultWindowWidth
	}
	if result.Height <= 0 {
		result.Height = defaultWindowHeight
	}
	if err := validateChildOptions(result); err != nil {
		return ChildOptions{}, err
	}
	return result, nil
}

func validateChildOptions(options ChildOptions) error {
	if strings.TrimSpace(options.Token) == "" || strings.TrimSpace(options.ID) == "" {
		return fmt.Errorf("detached-window token and id are required")
	}
	if options.ParentPID <= 1 {
		return fmt.Errorf("detached-window parent process ID is required")
	}
	parentURL, err := url.Parse(options.ParentURL)
	if err != nil || parentURL.Scheme != "http" || parentURL.Host == "" || (parentURL.Path != "" && parentURL.Path != "/") || parentURL.RawQuery != "" || parentURL.User != nil {
		return fmt.Errorf("detached-window parent URL must be an HTTP loopback origin")
	}
	host := parentURL.Hostname()
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("detached-window parent URL must use a loopback IP")
	}
	if len(options.ID) > 256 || strings.ContainsAny(options.ID, "\r\n\x00") {
		return fmt.Errorf("detached-window id is invalid")
	}
	return nil
}

func environmentInt(name string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil {
		return fallback
	}
	return value
}

// RunChild starts one native system window in the current child process.
func RunChild(parentCtx context.Context, assetFS fs.FS, args []string) error {
	if assetFS == nil {
		return fmt.Errorf("web assets are unavailable")
	}
	childOptions, err := ParseChildOptions(args)
	if err != nil {
		return err
	}
	parentURL, _ := url.Parse(childOptions.ParentURL)
	proxy := httputil.NewSingleHostReverseProxy(parentURL)
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		originalDirector(request)
		request.Host = parentURL.Host
		request.Header.Set(HeaderToken, childOptions.Token)
		request.Header.Set(HeaderWindowID, childOptions.ID)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		http.Error(w, fmt.Sprintf("detached parent is unavailable: %v", proxyErr), http.StatusBadGateway)
	}

	bridge := newBridge(childOptions)
	control := newControl(bridge)
	bridge.setReadyHandler(control.markFrontendReady)
	minWidth, minHeight := detachedWindowMinimumSize(childOptions.Kind)
	visuals := resolveDetachedWindowVisualOptions(runtime.GOOS)
	err = runDetachedChildApplication(&options.App{
		Title:            childOptions.Title,
		Width:            childOptions.Width,
		Height:           childOptions.Height,
		MinWidth:         minWidth,
		MinHeight:        minHeight,
		StartHidden:      true,
		Frameless:        true,
		AssetServer:      &assetserver.Options{Handler: proxy},
		BackgroundColour: visuals.backgroundColour,
		Windows:          visuals.windows,
		Mac:              visuals.mac,
		Linux:            visuals.linux,
		OnStartup: func(ctx context.Context) {
			InitializeBridge(bridge, ctx)
			InitializeControl(control, ctx)
			parentWatcher, watcherErr := newDetachedParentWatcher(childOptions.ParentPID)
			if watcherErr != nil {
				wailsRuntime.Quit(ctx)
				return
			}
			go monitorDetachedParent(ctx, parentWatcher, defaultDetachedParentCheckInterval, func() {
				wailsRuntime.Quit(ctx)
			})
			if parentCtx != nil {
				go func() {
					select {
					case <-parentCtx.Done():
						wailsRuntime.Quit(ctx)
					case <-ctx.Done():
					}
				}()
			}
		},
		OnDomReady: func(ctx context.Context) {
			setDetachedAccessoryActivationPolicy()
			applyDetachedWindowBounds(
				ctx,
				childOptions.X,
				childOptions.Y,
				childOptions.Width,
				childOptions.Height,
			)
			wailsRuntime.WindowSetTitle(ctx, childOptions.Title)
			control.markDOMReady(ctx)
		},
		OnBeforeClose: func(ctx context.Context) bool {
			return control.handleBeforeClose(ctx)
		},
		OnShutdown: func(context.Context) {
			bridge.notifyClosing()
			bridge.stop()
		},
		Bind: []interface{}{control, bridge},
	}, wails.Run)
	return err
}

func runDetachedChildApplication(app *options.App, runner func(*options.App) error) error {
	prepareDetachedAccessoryActivationPolicy()
	return runner(app)
}

func detachedWindowMinimumSize(kind string) (width int, height int) {
	if strings.TrimSpace(kind) == "ai-chat" {
		return 360, 420
	}
	return 480, 320
}

type discardWriter struct{}

func (discardWriter) Write(payload []byte) (int, error) {
	return len(payload), nil
}
