package nacos

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"

	"golang.org/x/sync/singleflight"
)

const (
	defaultNacosPort        = 8848
	defaultNacosContextPath = "/nacos"
	defaultNacosTimeout     = 30 * time.Second
	defaultConfigPageSize   = 20
	maxConfigPageSize       = 200
	maxTokenRefreshSkew     = 60 * time.Second
)

var dialNacosProxyContext = proxytunnel.DialContext

var (
	nacosJSONSecretPattern = regexp.MustCompile(
		`(?i)("(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|secret[_-]?key|api[_-]?key|authorization)"\s*:\s*")((?:\\.|[^"\\])*)(")`,
	)
	nacosAuthorizationPattern = regexp.MustCompile(
		`(?i)(\bauthorization\s*[:=]\s*)(?:bearer|basic)\s+[a-z0-9._~+/%=-]+`,
	)
	nacosSecretAssignmentPattern = regexp.MustCompile(
		`(?i)(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|secret[_-]?key|api[_-]?key|authorization)\s*=\s*)([^&\s"'<>;,]+)`,
	)
	nacosBearerPattern = regexp.MustCompile(`(?i)(\bbearer\s+)[a-z0-9._~+/%=-]+`)
)

type nacosForwarderLease interface {
	LocalAddress() string
	Release() error
}

type nacosForwarderAcquirer func(connection.SSHConfig, string, int) (nacosForwarderLease, error)

type nacosAuthResult struct {
	token     string
	expiry    time.Time
	refreshAt time.Time
}

type nacosTokenSnapshot struct {
	value      string
	generation uint64
}

type nacosRawResponse struct {
	body      []byte
	status    int
	usedToken nacosTokenSnapshot
}

type localForwarderLeaseAdapter struct {
	forwarder *ssh.LocalForwarder
}

func (l *localForwarderLeaseAdapter) LocalAddress() string {
	if l == nil || l.forwarder == nil {
		return ""
	}
	return l.forwarder.LocalAddr
}

func (l *localForwarderLeaseAdapter) Release() error {
	if l == nil || l.forwarder == nil {
		return nil
	}
	return l.forwarder.Release()
}

func acquireNacosForwarder(
	sshConfig connection.SSHConfig,
	remoteHost string,
	remotePort int,
) (nacosForwarderLease, error) {
	forwarder, err := ssh.AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		return nil, err
	}
	return &localForwarderLeaseAdapter{forwarder: forwarder}, nil
}

// ClientImpl is an HTTP client for the supported Nacos API families.
type ClientImpl struct {
	mu                  sync.Mutex
	config              connection.ConnectionConfig
	httpClient          *http.Client
	baseURL             *url.URL
	requestHost         string
	apiFamily           nacosAPIFamily
	accessToken         string
	tokenExpiry         time.Time
	tokenRefreshAt      time.Time
	sshForwarder        nacosForwarderLease
	acquireSSHForwarder nacosForwarderAcquirer
	authGroup           *singleflight.Group
	lifecycleCtx        context.Context
	lifecycleCancel     context.CancelFunc
	lifecycleGeneration uint64
}

// NewClient creates a new Nacos client instance.
func NewClient() Client {
	return &ClientImpl{acquireSSHForwarder: acquireNacosForwarder}
}

// Connect prepares the HTTP client and validates reachability.
func (c *ClientImpl) Connect(config connection.ConnectionConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), normalizeNacosTimeout(config.Timeout))
	defer cancel()
	return c.ConnectContext(ctx, config)
}

// ConnectContext prepares the HTTP client and validates reachability while
// honoring a caller-owned cancellation context.
func (c *ClientImpl) ConnectContext(ctx context.Context, config connection.ConnectionConfig) error {
	if ctx == nil {
		ctx = context.Background()
	}
	normalized, err := normalizeNacosConfig(config)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, normalizeNacosTimeout(normalized.Timeout))
		defer cancel()
	}

	if err := c.Close(); err != nil {
		return err
	}

	var forwarder nacosForwarderLease
	dialAddress := ""
	if normalized.UseSSH {
		acquire := c.acquireSSHForwarder
		if acquire == nil {
			acquire = acquireNacosForwarder
		}
		forwarder, err = acquireNacosForwarderWithContext(ctx, acquire, normalized.SSH, normalized.Host, normalized.Port)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			return localizedNacosBackendErrorWithCause("nacos.backend.error.ssh_tunnel_create_failed", map[string]any{
				"detail": err.Error(),
			}, err)
		}
		if forwarder == nil {
			return localizedNacosBackendError("nacos.backend.error.ssh_tunnel_create_failed", map[string]any{
				"detail": "forwarder acquisition returned no lease",
			})
		}
		dialAddress = strings.TrimSpace(forwarder.LocalAddress())
		if dialAddress == "" {
			_ = forwarder.Release()
			return localizedNacosBackendError("nacos.backend.error.ssh_tunnel_create_failed", map[string]any{
				"detail": "local forward address is empty",
			})
		}
	}

	httpClient, baseURL, err := buildNacosHTTPClientWithDialAddress(normalized, dialAddress)
	if err != nil {
		if forwarder != nil {
			_ = forwarder.Release()
		}
		return err
	}
	if err := ctx.Err(); err != nil {
		httpClient.CloseIdleConnections()
		if forwarder != nil {
			_ = forwarder.Release()
		}
		return err
	}
	lifecycleCtx, lifecycleCancel := context.WithCancel(context.Background())

	c.mu.Lock()
	c.lifecycleGeneration++
	c.config = normalized
	c.httpClient = httpClient
	c.baseURL = baseURL
	c.requestHost = net.JoinHostPort(normalized.Host, strconv.Itoa(normalized.Port))
	c.apiFamily = nacosAPIUnknown
	c.accessToken = ""
	c.tokenExpiry = time.Time{}
	c.tokenRefreshAt = time.Time{}
	c.sshForwarder = forwarder
	c.authGroup = &singleflight.Group{}
	c.lifecycleCtx = lifecycleCtx
	c.lifecycleCancel = lifecycleCancel
	c.mu.Unlock()

	if err := c.ensureAuth(ctx); err != nil {
		_ = c.Close()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return err
	}
	if err := c.detectAPIFamily(ctx); err != nil {
		_ = c.Close()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return err
	}
	if err := c.Ping(ctx); err != nil {
		_ = c.Close()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return err
	}
	return nil
}

func acquireNacosForwarderWithContext(
	ctx context.Context,
	acquire nacosForwarderAcquirer,
	sshConfig connection.SSHConfig,
	remoteHost string,
	remotePort int,
) (nacosForwarderLease, error) {
	type acquireResult struct {
		forwarder nacosForwarderLease
		err       error
	}
	resultCh := make(chan acquireResult, 1)
	go func() {
		forwarder, err := acquire(sshConfig, remoteHost, remotePort)
		resultCh <- acquireResult{forwarder: forwarder, err: err}
	}()

	select {
	case result := <-resultCh:
		return result.forwarder, result.err
	case <-ctx.Done():
		go func() {
			result := <-resultCh
			if result.forwarder != nil {
				_ = result.forwarder.Release()
			}
		}()
		return nil, ctx.Err()
	}
}

// Close releases client resources.
func (c *ClientImpl) Close() error {
	c.mu.Lock()
	httpClient := c.httpClient
	forwarder := c.sshForwarder
	lifecycleCancel := c.lifecycleCancel
	c.lifecycleGeneration++
	c.config = connection.ConnectionConfig{}
	c.httpClient = nil
	c.baseURL = nil
	c.requestHost = ""
	c.apiFamily = nacosAPIUnknown
	c.accessToken = ""
	c.tokenExpiry = time.Time{}
	c.tokenRefreshAt = time.Time{}
	c.sshForwarder = nil
	c.authGroup = nil
	c.lifecycleCtx = nil
	c.lifecycleCancel = nil
	c.mu.Unlock()
	if lifecycleCancel != nil {
		lifecycleCancel()
	}
	if httpClient != nil {
		httpClient.CloseIdleConnections()
	}
	if forwarder != nil {
		return forwarder.Release()
	}
	return nil
}

// Ping checks server reachability without requiring namespace administrator access.
func (c *ClientImpl) Ping(ctx context.Context) error {
	return c.probeReadiness(ctx, c.currentAPIFamily())
}
