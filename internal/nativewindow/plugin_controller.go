package nativewindow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/plugin"
)

type pluginWindowEntry struct {
	info              PluginWindowInfo
	key               string
	stamp             pluginWindowStamp
	title             string
	entry             string
	token             string
	profile           string
	context           json.RawMessage
	locale            string
	theme             string
	process           pluginProcess
	life              context.Context
	cancel            context.CancelFunc
	stop              chan struct{}
	done              chan struct{}
	closing           bool
	revokedAt         time.Time
	opened            time.Time
	heartbeat         time.Time
	heartbeatSequence uint64
	requests          map[string]context.CancelFunc
	canceledRequests  map[string]time.Time
	assetCalls        int
	invokeCalls       int
}

// PluginController owns plugin UI processes separately from the trusted App
// detached-window manager. Never bind this controller to an untrusted WebView.
type PluginController struct {
	mu                        sync.Mutex
	manager                   pluginWindowRuntime
	capability                func(ctx context.Context, pluginID string, generation uint64, method string, arguments json.RawMessage) (json.RawMessage, error)
	assets                    fs.FS
	bundle                    []byte
	executable                string
	windows                   map[string]*pluginWindowEntry
	windowIDs                 map[string]*pluginWindowEntry
	revokedGenerations        map[string]pluginWindowStamp
	knownGenerations          map[string]pluginWindowStamp
	admissionEpochs           map[string]uint64
	server                    *http.Server
	endpoint                  string
	life                      context.Context
	cancel                    context.CancelFunc
	closed                    bool
	wg                        sync.WaitGroup
	startProcess              func(pluginProcessSpec) (pluginProcess, error)
	stopTimeout               time.Duration
	heartbeatTimeout          time.Duration
	startupTimeout            time.Duration
	checkInterval             time.Duration
	onWindowClosed            func(context.Context, PluginWindowInfo)
	preferences               json.RawMessage
	preferencesRevision       uint64
	preferenceRequestRevision uint64
}

// NewPluginController validates the standalone frontend before enabling windows.
func NewPluginController(manager *plugin.Manager, opts PluginControllerOptions) (*PluginController, error) {
	if manager == nil {
		return nil, errors.New("plugin manager is unavailable")
	}
	return newPluginController(manager, opts)
}

func newPluginController(manager pluginWindowRuntime, opts PluginControllerOptions) (*PluginController, error) {
	if opts.Assets == nil {
		return nil, errors.New("plugin window runtime assets are unavailable")
	}
	file, err := opts.Assets.Open("runtime.js")
	if err != nil {
		return nil, fmt.Errorf("open plugin window runtime: %w", err)
	}
	defer file.Close()
	bundle, err := readPluginBytes(file, pluginMaxJSONBytes)
	if err != nil || len(bundle) == 0 {
		return nil, errors.New("plugin window runtime is missing or too large")
	}
	executable := opts.Executable
	if executable == "" {
		executable, err = os.Executable()
		if err != nil {
			return nil, fmt.Errorf("resolve plugin window executable: %w", err)
		}
	}
	return &PluginController{manager: manager, capability: opts.Capability, assets: opts.Assets, bundle: bundle, executable: executable,
		windows: make(map[string]*pluginWindowEntry), windowIDs: make(map[string]*pluginWindowEntry), revokedGenerations: make(map[string]pluginWindowStamp), knownGenerations: make(map[string]pluginWindowStamp), admissionEpochs: make(map[string]uint64), startProcess: startPluginProcess,
		stopTimeout: pluginStopTimeout, heartbeatTimeout: pluginHeartbeatTimeout,
		startupTimeout: pluginStartupTimeout, checkInterval: 250 * time.Millisecond,
		onWindowClosed: opts.OnWindowClosed}, nil
}

// Start attaches the controller to the host lifecycle and creates a dedicated
// loopback listener. No App routes, cookies or shared RPC token are reused.
func (c *PluginController) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for plugin windows: %w", err)
	}
	c.mu.Lock()
	if c.closed || c.server != nil {
		c.mu.Unlock()
		closePluginListener(listener)
		return errors.New("plugin window controller already started or closed")
	}
	c.life, c.cancel = context.WithCancel(ctx)
	c.endpoint = "http://" + listener.Addr().String()
	c.server = &http.Server{Handler: http.HandlerFunc(c.serveHTTP), ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout: 5 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8192}
	server, life := c.server, c.life
	c.wg.Add(2)
	c.mu.Unlock()
	go func() {
		defer c.wg.Done()
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error(serveErr, "plugin window bridge stopped")
			c.revokeAll()
		}
	}()
	go c.monitor(life)
	return nil
}

// Revoke immediately invalidates a plugin's bridge and cancels its calls. Child
// cooperation never delays this method; a supervisor enforces the kill deadline.
func (c *PluginController) Revoke(id string) {
	c.mu.Lock()
	// No filesystem/process cooperation before capabilities and pending calls die.
	c.admissionEpochs[id]++
	if stamp, known := c.knownGenerations[id]; known {
		c.revokedGenerations[id] = stamp
	}
	for _, entry := range c.windows {
		if entry.info.PluginID == id {
			c.revokedGenerations[id] = entry.stamp
			c.revokeLocked(entry)
		}
	}
	c.mu.Unlock()
}

func (c *PluginController) revokeEntry(entry *pluginWindowEntry) {
	c.mu.Lock()
	c.revokeLocked(entry)
	c.mu.Unlock()
}

func (c *PluginController) revokeLocked(entry *pluginWindowEntry) {
	if entry.closing {
		return
	}
	entry.closing = true
	entry.revokedAt = time.Now()
	entry.cancel()
	close(entry.stop)
}

func (c *PluginController) revokeAll() {
	c.mu.Lock()
	for _, entry := range c.windows {
		c.revokeLocked(entry)
	}
	c.mu.Unlock()
}

// Close revokes first, then waits only as long as the caller allows. Even after
// caller cancellation, registered supervisors continue killing and reaping.
func (c *PluginController) Close(ctx context.Context) error {
	c.mu.Lock()
	c.closed = true
	for _, entry := range c.windows {
		c.revokeLocked(entry)
	}
	if c.cancel != nil {
		c.cancel()
	}
	server := c.server
	c.mu.Unlock()
	if server != nil {
		if err := server.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	done := make(chan struct{})
	go func() { c.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func closePluginListener(listener net.Listener) {
	if err := listener.Close(); err != nil {
		logger.Error(err, "close plugin window listener")
	}
}
