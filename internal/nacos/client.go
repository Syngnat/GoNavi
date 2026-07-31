package nacos

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/tlsconfig"
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
	normalized, err := normalizeNacosConfig(config)
	if err != nil {
		return err
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
		forwarder, err = acquire(normalized.SSH, normalized.Host, normalized.Port)
		if err != nil {
			return localizedNacosBackendError("nacos.backend.error.ssh_tunnel_create_failed", map[string]any{
				"detail": err.Error(),
			})
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

	ctx, cancel := context.WithTimeout(context.Background(), normalizeNacosTimeout(normalized.Timeout))
	defer cancel()
	if err := c.ensureAuth(ctx); err != nil {
		_ = c.Close()
		return err
	}
	if err := c.detectAPIFamily(ctx); err != nil {
		_ = c.Close()
		return err
	}
	if err := c.Ping(ctx); err != nil {
		_ = c.Close()
		return err
	}
	return nil
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

// ListNamespaces returns all namespaces including public.
func (c *ClientImpl) ListNamespaces(ctx context.Context) ([]Namespace, error) {
	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().namespaceList, nil, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, nacosHTTPStatusError(status, body)
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload []struct {
		Namespace         string `json:"namespace"`
		NamespaceID       string `json:"namespaceId"`
		NamespaceShowName string `json:"namespaceShowName"`
		NamespaceName     string `json:"namespaceName"`
		NamespaceDesc     string `json:"namespaceDesc"`
		Quota             int64  `json:"quota"`
		ConfigCount       int64  `json:"configCount"`
		Type              int    `json:"type"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_namespaces", map[string]any{
			"detail": err.Error(),
		})
	}

	result := make([]Namespace, 0, len(payload))
	for _, item := range payload {
		id := firstNonEmpty(strings.TrimSpace(item.Namespace), strings.TrimSpace(item.NamespaceID))
		showName := firstNonEmpty(strings.TrimSpace(item.NamespaceShowName), strings.TrimSpace(item.NamespaceName))
		if showName == "" {
			if id == "" {
				showName = "public"
			} else {
				showName = id
			}
		}
		result = append(result, Namespace{
			ID:          id,
			ShowName:    showName,
			Description: strings.TrimSpace(item.NamespaceDesc),
			ConfigCount: item.ConfigCount,
			Quota:       item.Quota,
			Type:        item.Type,
		})
	}
	return result, nil
}

// SearchConfigs lists configs under a namespace with optional filters.
func (c *ClientImpl) SearchConfigs(ctx context.Context, query ConfigQuery) (*ConfigPage, error) {
	family := c.currentAPIFamily()
	pageNo := query.PageNo
	if pageNo <= 0 {
		pageNo = 1
	}
	pageSize := query.PageSize
	if pageSize <= 0 {
		pageSize = defaultConfigPageSize
	}
	if pageSize > maxConfigPageSize {
		pageSize = maxConfigPageSize
	}
	searchMode := strings.ToLower(strings.TrimSpace(query.Search))
	if searchMode == "" {
		searchMode = "blur"
	}

	params := url.Values{}
	params.Set("search", searchMode)
	params.Set("dataId", strings.TrimSpace(query.DataID))
	params.Set("appName", strings.TrimSpace(query.AppName))
	params.Set("pageNo", strconv.Itoa(pageNo))
	params.Set("pageSize", strconv.Itoa(pageSize))
	if family == nacosAPIV3 {
		params.Set("groupName", strings.TrimSpace(query.Group))
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
		params.Set("configDetail", "")
	} else {
		params.Set("group", strings.TrimSpace(query.Group))
		params.Set("tenant", normalizeNamespaceID(query.NamespaceID))
		if family == nacosAPIV2 {
			params.Set("config_detail", "")
		}
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().configList, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		TotalCount     int64 `json:"totalCount"`
		PageNumber     int   `json:"pageNumber"`
		PagesAvailable int   `json:"pagesAvailable"`
		PageItems      []struct {
			ID               string `json:"id"`
			DataID           string `json:"dataId"`
			Group            string `json:"group"`
			GroupName        string `json:"groupName"`
			Content          string `json:"content"`
			MD5              string `json:"md5"`
			Tenant           string `json:"tenant"`
			NamespaceID      string `json:"namespaceId"`
			AppName          string `json:"appName"`
			Type             string `json:"type"`
			Desc             string `json:"desc"`
			LastModifiedTime any    `json:"lastModifiedTime"`
			ModifiedTime     any    `json:"modifiedTime"`
			ModifyTime       any    `json:"modifyTime"`
		} `json:"pageItems"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_configs", map[string]any{
			"detail": err.Error(),
		})
	}

	items := make([]ConfigItem, 0, len(payload.PageItems))
	for _, item := range payload.PageItems {
		items = append(items, ConfigItem{
			ID:           strings.TrimSpace(item.ID),
			DataID:       strings.TrimSpace(item.DataID),
			Group:        firstNonEmpty(strings.TrimSpace(item.Group), strings.TrimSpace(item.GroupName)),
			NamespaceID:  normalizeNamespaceID(firstNonEmpty(item.Tenant, item.NamespaceID)),
			Content:      item.Content,
			Type:         strings.TrimSpace(item.Type),
			MD5:          strings.TrimSpace(item.MD5),
			AppName:      strings.TrimSpace(item.AppName),
			Desc:         strings.TrimSpace(item.Desc),
			ModifiedTime: stringifyAnyTime(item.LastModifiedTime, item.ModifiedTime, item.ModifyTime),
		})
	}
	return &ConfigPage{
		TotalCount:     payload.TotalCount,
		PageNumber:     payload.PageNumber,
		PagesAvailable: payload.PagesAvailable,
		PageItems:      items,
	}, nil
}

// ListConfigGroups returns unique config groups under a namespace.
func (c *ClientImpl) ListConfigGroups(ctx context.Context, namespaceID string) ([]string, error) {
	const pageSize = 100
	pageNo := 1
	seen := make(map[string]struct{})
	groups := make([]string, 0, 16)

	for {
		page, err := c.SearchConfigs(ctx, ConfigQuery{
			NamespaceID: namespaceID,
			PageNo:      pageNo,
			PageSize:    pageSize,
			Search:      "blur",
		})
		if err != nil {
			return nil, err
		}
		if page == nil || len(page.PageItems) == 0 {
			break
		}
		for _, item := range page.PageItems {
			group := strings.TrimSpace(item.Group)
			if group == "" {
				group = "DEFAULT_GROUP"
			}
			if _, ok := seen[group]; ok {
				continue
			}
			seen[group] = struct{}{}
			groups = append(groups, group)
		}
		if pageNo >= page.PagesAvailable || len(page.PageItems) < pageSize {
			break
		}
		pageNo++
		if pageNo > 200 {
			break
		}
	}

	sort.Strings(groups)
	return groups, nil
}

// GetConfig loads a single config content.
func (c *ClientImpl) GetConfig(ctx context.Context, namespaceID, group, dataID string) (*ConfigDetail, error) {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	if dataID == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
	params.Set("dataId", dataID)
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else if family == nacosAPIV2 {
		params.Set("group", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
		params.Set("show", "all")
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().config, params, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, localizedNacosBackendError("nacos.backend.error.config_not_found", map[string]any{
			"dataId": dataID,
			"group":  group,
		})
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data := body
	if family == nacosAPIV2 || family == nacosAPIV3 {
		data, err = unwrapNacosResult(body)
		if err != nil {
			return nil, err
		}
	}
	if family == nacosAPIV2 {
		content := decodeNacosStringData(data)
		return &ConfigDetail{
			DataID:      dataID,
			Group:       group,
			NamespaceID: normalizeNamespaceID(namespaceID),
			Content:     content,
			MD5:         ContentMD5(content),
		}, nil
	}

	// Nacos v1 show=all and v3 return JSON details.
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "{") {
		var payload struct {
			DataID      string `json:"dataId"`
			Group       string `json:"group"`
			GroupName   string `json:"groupName"`
			Content     string `json:"content"`
			Type        string `json:"type"`
			MD5         string `json:"md5"`
			AppName     string `json:"appName"`
			Desc        string `json:"desc"`
			Tenant      string `json:"tenant"`
			NamespaceID string `json:"namespaceId"`
		}
		if err := json.Unmarshal(data, &payload); err == nil && (payload.Content != "" || payload.DataID != "") {
			md5Value := strings.TrimSpace(payload.MD5)
			if md5Value == "" {
				md5Value = ContentMD5(payload.Content)
			}
			return &ConfigDetail{
				DataID:      firstNonEmpty(payload.DataID, dataID),
				Group:       firstNonEmpty(payload.Group, payload.GroupName, group),
				NamespaceID: normalizeNamespaceID(firstNonEmpty(payload.Tenant, payload.NamespaceID, namespaceID)),
				Content:     payload.Content,
				Type:        strings.TrimSpace(payload.Type),
				MD5:         md5Value,
				AppName:     strings.TrimSpace(payload.AppName),
				Desc:        strings.TrimSpace(payload.Desc),
			}, nil
		}
	}

	content := string(data)
	return &ConfigDetail{
		DataID:      dataID,
		Group:       group,
		NamespaceID: normalizeNamespaceID(namespaceID),
		Content:     content,
		MD5:         ContentMD5(content),
	}, nil
}

func decodeNacosStringData(data []byte) string {
	var value string
	if err := json.Unmarshal(data, &value); err == nil {
		return value
	}
	return string(data)
}

// PublishConfig creates or updates a config.
func (c *ClientImpl) PublishConfig(ctx context.Context, req PublishRequest) error {
	family := c.currentAPIFamily()
	dataID := strings.TrimSpace(req.DataID)
	group := strings.TrimSpace(req.Group)
	if dataID == "" {
		return localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	form := url.Values{}
	form.Set("dataId", dataID)
	form.Set("content", req.Content)
	if family == nacosAPIV3 {
		form.Set("groupName", group)
		form.Set("namespaceId", normalizeNamespaceID(req.NamespaceID))
	} else if family == nacosAPIV2 {
		form.Set("group", group)
		form.Set("namespaceId", normalizeNamespaceID(req.NamespaceID))
	} else {
		form.Set("group", group)
		form.Set("tenant", normalizeNamespaceID(req.NamespaceID))
	}
	if typ := strings.TrimSpace(req.Type); typ != "" {
		form.Set("type", typ)
	}
	if appName := strings.TrimSpace(req.AppName); appName != "" {
		form.Set("appName", appName)
	}
	if desc := strings.TrimSpace(req.Desc); desc != "" {
		form.Set("desc", desc)
	}
	headers := http.Header{}
	if betaIPs := strings.TrimSpace(req.BetaIPs); betaIPs != "" {
		headers.Set("betaIps", betaIPs)
	}

	body, status, err := c.doRequestWithHeaders(ctx, http.MethodPost, c.currentAPIRoutes().config, nil, form, headers)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.publish_failed")
}

// DeleteConfig removes a config.
func (c *ClientImpl) DeleteConfig(ctx context.Context, namespaceID, group, dataID string) error {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	if dataID == "" {
		return localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
	params.Set("dataId", dataID)
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else if family == nacosAPIV2 {
		params.Set("group", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
	}

	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().config, params, nil)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.delete_failed")
}

// GetBetaConfig loads beta/gray config if present.
func (c *ClientImpl) GetBetaConfig(ctx context.Context, namespaceID, group, dataID string) (*BetaConfigDetail, error) {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	if dataID == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
	params.Set("dataId", dataID)
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
		params.Set("beta", "true")
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().beta, params, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return &BetaConfigDetail{
			DataID:      dataID,
			Group:       group,
			NamespaceID: normalizeNamespaceID(namespaceID),
			Exists:      false,
		}, nil
	}
	if status < 200 || status >= 300 {
		// Some versions return 400/500 when beta does not exist; treat common empty cases as missing.
		text := strings.TrimSpace(string(body))
		if text == "" || strings.Contains(strings.ToLower(text), "not found") || strings.Contains(text, "config data not exist") {
			return &BetaConfigDetail{
				DataID:      dataID,
				Group:       group,
				NamespaceID: normalizeNamespaceID(namespaceID),
				Exists:      false,
			}, nil
		}
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(text),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return &BetaConfigDetail{
			DataID:      dataID,
			Group:       group,
			NamespaceID: normalizeNamespaceID(namespaceID),
			Exists:      false,
		}, nil
	}
	if strings.HasPrefix(trimmed, "{") {
		var payload struct {
			DataID      string `json:"dataId"`
			Group       string `json:"group"`
			GroupName   string `json:"groupName"`
			Content     string `json:"content"`
			Type        string `json:"type"`
			MD5         string `json:"md5"`
			BetaIPs     string `json:"betaIps"`
			GrayRule    string `json:"grayRule"`
			Tenant      string `json:"tenant"`
			NamespaceID string `json:"namespaceId"`
		}
		if err := json.Unmarshal(data, &payload); err == nil {
			content := payload.Content
			if strings.TrimSpace(content) == "" && strings.TrimSpace(payload.DataID) == "" {
				return &BetaConfigDetail{
					DataID:      dataID,
					Group:       group,
					NamespaceID: normalizeNamespaceID(namespaceID),
					Exists:      false,
				}, nil
			}
			md5Value := strings.TrimSpace(payload.MD5)
			if md5Value == "" {
				md5Value = ContentMD5(content)
			}
			return &BetaConfigDetail{
				DataID:      firstNonEmpty(payload.DataID, dataID),
				Group:       firstNonEmpty(payload.Group, payload.GroupName, group),
				NamespaceID: normalizeNamespaceID(firstNonEmpty(payload.Tenant, payload.NamespaceID, namespaceID)),
				Content:     content,
				Type:        strings.TrimSpace(payload.Type),
				MD5:         md5Value,
				BetaIPs:     firstNonEmpty(strings.TrimSpace(payload.BetaIPs), betaIPsFromGrayRule(payload.GrayRule)),
				Exists:      true,
			}, nil
		}
	}

	return &BetaConfigDetail{
		DataID:      dataID,
		Group:       group,
		NamespaceID: normalizeNamespaceID(namespaceID),
		Content:     string(data),
		MD5:         ContentMD5(string(data)),
		Exists:      true,
	}, nil
}

func betaIPsFromGrayRule(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var rule struct {
		Expr           string `json:"expr"`
		RawGrayRuleExp string `json:"rawGrayRuleExp"`
	}
	if err := json.Unmarshal([]byte(raw), &rule); err == nil {
		return firstNonEmpty(strings.TrimSpace(rule.Expr), strings.TrimSpace(rule.RawGrayRuleExp), raw)
	}
	return raw
}

// StopBetaConfig stops beta/gray publish for a config.
func (c *ClientImpl) StopBetaConfig(ctx context.Context, namespaceID, group, dataID string) error {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	if dataID == "" {
		return localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
	params.Set("dataId", dataID)
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
		params.Set("beta", "true")
	}
	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().beta, params, nil)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.beta_stop_failed")
}

// CreateNamespace creates a namespace.
func (c *ClientImpl) CreateNamespace(ctx context.Context, req CreateNamespaceRequest) error {
	family := c.currentAPIFamily()
	showName := strings.TrimSpace(req.ShowName)
	if showName == "" {
		return localizedNacosBackendError("nacos.backend.error.namespace_name_required", nil)
	}
	nsID := strings.TrimSpace(req.ID)
	if strings.EqualFold(nsID, "public") || nsID == "" && strings.EqualFold(showName, "public") {
		// Creating another "public" is not allowed; empty id with non-public name is ok.
		if strings.EqualFold(showName, "public") {
			return localizedNacosBackendError("nacos.backend.error.namespace_public_reserved", nil)
		}
	}

	form := url.Values{}
	if family == nacosAPIV1 {
		form.Set("customNamespaceId", nsID)
	} else {
		form.Set("namespaceId", nsID)
	}
	form.Set("namespaceName", showName)
	form.Set("namespaceDesc", strings.TrimSpace(req.Description))

	body, status, err := c.doRequest(ctx, http.MethodPost, c.currentAPIRoutes().namespace, nil, form)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.namespace_create_failed")
}

// UpdateNamespace updates namespace show name / description.
func (c *ClientImpl) UpdateNamespace(ctx context.Context, req UpdateNamespaceRequest) error {
	family := c.currentAPIFamily()
	nsID := strings.TrimSpace(req.ID)
	// public is represented as empty id; do not allow renaming public id, but updating show name is usually blocked by server.
	if nsID == "" || strings.EqualFold(nsID, "public") {
		return localizedNacosBackendError("nacos.backend.error.namespace_public_immutable", nil)
	}
	showName := strings.TrimSpace(req.ShowName)
	if showName == "" {
		return localizedNacosBackendError("nacos.backend.error.namespace_name_required", nil)
	}

	form := url.Values{}
	if family == nacosAPIV1 {
		form.Set("namespace", nsID)
		form.Set("namespaceShowName", showName)
	} else {
		form.Set("namespaceId", nsID)
		form.Set("namespaceName", showName)
	}
	form.Set("namespaceDesc", strings.TrimSpace(req.Description))

	body, status, err := c.doRequest(ctx, http.MethodPut, c.currentAPIRoutes().namespace, nil, form)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.namespace_update_failed")
}

// DeleteNamespace deletes a namespace by id.
func (c *ClientImpl) DeleteNamespace(ctx context.Context, namespaceID string) error {
	nsID := strings.TrimSpace(namespaceID)
	if nsID == "" || strings.EqualFold(nsID, "public") {
		return localizedNacosBackendError("nacos.backend.error.namespace_public_immutable", nil)
	}

	// Prefer query parameters: Go's ParseForm ignores DELETE bodies, and many
	// Nacos deployments accept namespaceId on the query string.
	params := url.Values{}
	params.Set("namespaceId", nsID)

	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().namespace, params, nil)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.namespace_delete_failed")
}

// ListConfigHistory lists history records for a config.
func (c *ClientImpl) ListConfigHistory(ctx context.Context, query HistoryQuery) (*HistoryPage, error) {
	family := c.currentAPIFamily()
	dataID := strings.TrimSpace(query.DataID)
	group := strings.TrimSpace(query.Group)
	if dataID == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}
	pageNo := query.PageNo
	if pageNo <= 0 {
		pageNo = 1
	}
	pageSize := query.PageSize
	if pageSize <= 0 {
		pageSize = defaultConfigPageSize
	}
	if pageSize > maxConfigPageSize {
		pageSize = maxConfigPageSize
	}

	params := url.Values{}
	params.Set("dataId", dataID)
	params.Set("pageNo", strconv.Itoa(pageNo))
	params.Set("pageSize", strconv.Itoa(pageSize))
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
	} else if family == nacosAPIV2 {
		params.Set("group", group)
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
	} else {
		params.Set("search", "accurate")
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(query.NamespaceID))
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().historyList, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		TotalCount     int64 `json:"totalCount"`
		PageNumber     int   `json:"pageNumber"`
		PagesAvailable int   `json:"pagesAvailable"`
		PageItems      []struct {
			ID               any    `json:"id"`
			LastID           any    `json:"lastId"`
			DataID           string `json:"dataId"`
			Group            string `json:"group"`
			GroupName        string `json:"groupName"`
			Tenant           string `json:"tenant"`
			NamespaceID      string `json:"namespaceId"`
			AppName          string `json:"appName"`
			MD5              string `json:"md5"`
			Content          string `json:"content"`
			SrcIP            string `json:"srcIp"`
			SrcUser          string `json:"srcUser"`
			OpType           string `json:"opType"`
			CreatedTime      any    `json:"createdTime"`
			CreateTime       any    `json:"createTime"`
			LastModifiedTime any    `json:"lastModifiedTime"`
			ModifyTime       any    `json:"modifyTime"`
		} `json:"pageItems"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_history", map[string]any{
			"detail": err.Error(),
		})
	}

	items := make([]HistoryItem, 0, len(payload.PageItems))
	for _, item := range payload.PageItems {
		items = append(items, HistoryItem{
			ID:           stringifyAnyID(item.ID),
			LastID:       stringifyAnyID(item.LastID),
			DataID:       strings.TrimSpace(item.DataID),
			Group:        firstNonEmpty(strings.TrimSpace(item.Group), strings.TrimSpace(item.GroupName)),
			NamespaceID:  normalizeNamespaceID(firstNonEmpty(item.Tenant, item.NamespaceID)),
			AppName:      strings.TrimSpace(item.AppName),
			MD5:          strings.TrimSpace(item.MD5),
			Content:      item.Content,
			SrcIP:        strings.TrimSpace(item.SrcIP),
			SrcUser:      strings.TrimSpace(item.SrcUser),
			OpType:       strings.TrimSpace(item.OpType),
			CreatedTime:  stringifyAnyTime(item.CreatedTime, item.CreateTime),
			ModifiedTime: stringifyAnyTime(item.LastModifiedTime, item.ModifyTime),
		})
	}
	return &HistoryPage{
		TotalCount:     payload.TotalCount,
		PageNumber:     payload.PageNumber,
		PagesAvailable: payload.PagesAvailable,
		PageItems:      items,
	}, nil
}

// GetConfigHistory loads one history detail by nid.
func (c *ClientImpl) GetConfigHistory(ctx context.Context, namespaceID, group, dataID, nid string) (*HistoryItem, error) {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	nid = strings.TrimSpace(nid)
	if dataID == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if nid == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.history_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
	params.Set("nid", nid)
	params.Set("dataId", dataID)
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else if family == nacosAPIV2 {
		params.Set("group", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().configHistory, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		ID               any    `json:"id"`
		LastID           any    `json:"lastId"`
		DataID           string `json:"dataId"`
		Group            string `json:"group"`
		GroupName        string `json:"groupName"`
		Tenant           string `json:"tenant"`
		NamespaceID      string `json:"namespaceId"`
		AppName          string `json:"appName"`
		MD5              string `json:"md5"`
		Content          string `json:"content"`
		SrcIP            string `json:"srcIp"`
		SrcUser          string `json:"srcUser"`
		OpType           string `json:"opType"`
		CreatedTime      any    `json:"createdTime"`
		CreateTime       any    `json:"createTime"`
		LastModifiedTime any    `json:"lastModifiedTime"`
		ModifyTime       any    `json:"modifyTime"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_history", map[string]any{
			"detail": err.Error(),
		})
	}
	return &HistoryItem{
		ID:           firstNonEmpty(stringifyAnyID(payload.ID), nid),
		LastID:       stringifyAnyID(payload.LastID),
		DataID:       firstNonEmpty(strings.TrimSpace(payload.DataID), dataID),
		Group:        firstNonEmpty(strings.TrimSpace(payload.Group), strings.TrimSpace(payload.GroupName), group),
		NamespaceID:  normalizeNamespaceID(firstNonEmpty(payload.Tenant, payload.NamespaceID, namespaceID)),
		AppName:      strings.TrimSpace(payload.AppName),
		MD5:          strings.TrimSpace(payload.MD5),
		Content:      payload.Content,
		SrcIP:        strings.TrimSpace(payload.SrcIP),
		SrcUser:      strings.TrimSpace(payload.SrcUser),
		OpType:       strings.TrimSpace(payload.OpType),
		CreatedTime:  stringifyAnyTime(payload.CreatedTime, payload.CreateTime),
		ModifiedTime: stringifyAnyTime(payload.LastModifiedTime, payload.ModifyTime),
	}, nil
}

func parseNacosBoolResult(body []byte, status int, failKey string) error {
	if status < 200 || status >= 300 {
		return localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}
	text := strings.TrimSpace(string(body))
	if text == "true" || text == "" || strings.EqualFold(text, "ok") {
		return nil
	}
	var boolResult bool
	if err := json.Unmarshal(body, &boolResult); err == nil && boolResult {
		return nil
	}
	// Some console APIs return {"code":200,...}
	var wrapped struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    any    `json:"data"`
	}
	if err := json.Unmarshal(body, &wrapped); err == nil && (wrapped.Code == 0 || wrapped.Code == 200) {
		switch v := wrapped.Data.(type) {
		case bool:
			if v {
				return nil
			}
		case string:
			if v == "true" || v == "" {
				return nil
			}
		case nil:
			return nil
		}
	}
	return localizedNacosBackendError(failKey, map[string]any{
		"body": truncateForError(text),
	})
}

func stringifyAnyID(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case float64:
		// avoid scientific notation for large ids
		return strconv.FormatInt(int64(v), 10)
	case json.Number:
		return v.String()
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func (c *ClientImpl) ensureAuth(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	c.mu.Lock()
	username := strings.TrimSpace(c.config.User)
	if username == "" {
		c.mu.Unlock()
		return nil
	}
	c.ensureAuthLifecycleLocked()
	if c.accessTokenValidLocked(time.Now()) {
		c.mu.Unlock()
		return nil
	}
	authGroup := c.authGroup
	lifecycleCtx := c.lifecycleCtx
	generation := c.lifecycleGeneration
	c.mu.Unlock()

	resultCh := authGroup.DoChan("login", func() (any, error) {
		c.mu.Lock()
		if c.lifecycleGeneration != generation || c.lifecycleCtx == nil || c.httpClient == nil {
			c.mu.Unlock()
			return nil, context.Canceled
		}
		if c.accessTokenValidLocked(time.Now()) {
			c.mu.Unlock()
			return nil, nil
		}
		loginUser := strings.TrimSpace(c.config.User)
		loginPassword := c.config.Password
		// Cached clients may be shared by operations with different deadlines.
		// The caller context still controls how long that caller waits, while
		// the shared login uses a stable lifecycle timeout so the first
		// connection's short operation timeout cannot poison later refreshes.
		loginTimeout := defaultNacosTimeout
		c.mu.Unlock()

		loginCtx, cancel := context.WithTimeout(lifecycleCtx, loginTimeout)
		defer cancel()
		authResult, err := c.login(loginCtx, loginUser, loginPassword)
		if err != nil {
			return nil, err
		}

		c.mu.Lock()
		defer c.mu.Unlock()
		if c.lifecycleGeneration != generation || c.lifecycleCtx == nil ||
			c.httpClient == nil || lifecycleCtx.Err() != nil {
			return nil, context.Canceled
		}
		c.accessToken = authResult.token
		c.tokenExpiry = authResult.expiry
		c.tokenRefreshAt = authResult.refreshAt
		return nil, nil
	})

	select {
	case <-ctx.Done():
		return ctx.Err()
	case result := <-resultCh:
		return result.Err
	}
}

func (c *ClientImpl) ensureAuthLifecycleLocked() {
	if c.authGroup != nil && c.lifecycleCtx != nil {
		return
	}
	lifecycleCtx, lifecycleCancel := context.WithCancel(context.Background())
	c.lifecycleGeneration++
	c.authGroup = &singleflight.Group{}
	c.lifecycleCtx = lifecycleCtx
	c.lifecycleCancel = lifecycleCancel
}

func (c *ClientImpl) accessTokenValidLocked(now time.Time) bool {
	if c.accessToken == "" {
		return false
	}
	refreshAt := c.tokenRefreshAt
	if refreshAt.IsZero() {
		refreshAt = c.tokenExpiry.Add(-maxTokenRefreshSkew)
	}
	return now.Before(refreshAt)
}

func (c *ClientImpl) login(ctx context.Context, username, password string) (nacosAuthResult, error) {
	query := url.Values{}
	query.Set("username", username)
	form := url.Values{}
	form.Set("password", password)

	var (
		body   []byte
		status int
		err    error
	)
	loginPaths := []string{"/v3/auth/user/login", "/v1/auth/users/login", "/v1/auth/login"}
	for index, loginPath := range loginPaths {
		body, status, err = c.doRequestRaw(ctx, http.MethodPost, loginPath, query, form, false)
		if err != nil {
			return nacosAuthResult{}, err
		}
		if status >= 200 && status < 300 {
			break
		}
		if index < len(loginPaths)-1 && isUnsupportedNacosLogin(status) {
			continue
		}
		return nacosAuthResult{}, localizedNacosBackendError("nacos.backend.error.login_failed", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	var payload struct {
		AccessToken string `json:"accessToken"`
		TokenTtl    int64  `json:"tokenTtl"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nacosAuthResult{}, localizedNacosBackendError("nacos.backend.error.login_parse", map[string]any{
			"detail": err.Error(),
		})
	}
	token := strings.TrimSpace(payload.AccessToken)
	if token == "" {
		return nacosAuthResult{}, localizedNacosBackendError("nacos.backend.error.login_empty_token", nil)
	}
	ttl := payload.TokenTtl
	if ttl <= 0 {
		ttl = 18000
	}
	issuedAt := time.Now()
	ttlDuration := time.Duration(ttl) * time.Second
	refreshSkew := ttlDuration / 10
	if refreshSkew > maxTokenRefreshSkew {
		refreshSkew = maxTokenRefreshSkew
	}
	expiry := issuedAt.Add(ttlDuration)

	return nacosAuthResult{
		token:     token,
		expiry:    expiry,
		refreshAt: expiry.Add(-refreshSkew),
	}, nil
}

func isUnsupportedNacosLogin(status int) bool {
	return status == http.StatusNotFound ||
		status == http.StatusMethodNotAllowed ||
		status == http.StatusNotImplemented
}

func (c *ClientImpl) doRequest(ctx context.Context, method, apiPath string, query url.Values, form url.Values) ([]byte, int, error) {
	return c.doRequestWithHeaders(ctx, method, apiPath, query, form, nil)
}

func (c *ClientImpl) doRequestWithHeaders(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	headers http.Header,
) ([]byte, int, error) {
	if err := c.ensureAuth(ctx); err != nil {
		return nil, 0, err
	}
	response, err := c.doRequestRawWithHeadersResult(ctx, method, apiPath, query, form, headers, true)
	if err != nil {
		return nil, response.status, err
	}
	if response.status == http.StatusForbidden || response.status == http.StatusUnauthorized {
		retry, authErr := c.reauthenticateAfterUnauthorized(ctx, response.usedToken)
		if authErr != nil {
			return nil, response.status, authErr
		}
		if retry {
			response, err = c.doRequestRawWithHeadersResult(ctx, method, apiPath, query, form, headers, true)
			if err != nil {
				return nil, response.status, err
			}
		}
	}
	return response.body, response.status, nil
}

func (c *ClientImpl) reauthenticateAfterUnauthorized(
	ctx context.Context,
	usedToken nacosTokenSnapshot,
) (bool, error) {
	if strings.TrimSpace(usedToken.value) == "" {
		return false, nil
	}

	c.mu.Lock()
	if c.lifecycleGeneration != usedToken.generation {
		c.mu.Unlock()
		return false, nil
	}
	if c.accessToken == usedToken.value {
		c.accessToken = ""
		c.tokenExpiry = time.Time{}
		c.tokenRefreshAt = time.Time{}
	}
	c.mu.Unlock()

	if err := c.ensureAuth(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (c *ClientImpl) doRequestRaw(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	withToken bool,
) ([]byte, int, error) {
	return c.doRequestRawWithHeaders(ctx, method, apiPath, query, form, nil, withToken)
}

func (c *ClientImpl) doRequestRawWithHeaders(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	headers http.Header,
	withToken bool,
) ([]byte, int, error) {
	response, err := c.doRequestRawWithHeadersResult(ctx, method, apiPath, query, form, headers, withToken)
	return response.body, response.status, err
}

func (c *ClientImpl) doRequestRawWithHeadersResult(
	ctx context.Context,
	method, apiPath string,
	query url.Values,
	form url.Values,
	headers http.Header,
	withToken bool,
) (nacosRawResponse, error) {
	c.mu.Lock()
	httpClient := c.httpClient
	baseURL := c.baseURL
	requestHost := c.requestHost
	token := c.accessToken
	generation := c.lifecycleGeneration
	c.mu.Unlock()
	result := nacosRawResponse{
		usedToken: nacosTokenSnapshot{
			value:      token,
			generation: generation,
		},
	}

	if httpClient == nil || baseURL == nil {
		return result, localizedNacosBackendError("nacos.backend.error.not_connected", nil)
	}

	rel := &url.URL{Path: joinAPIPath(baseURL.Path, apiPath)}
	if query == nil {
		query = url.Values{}
	}
	if withToken && strings.TrimSpace(token) != "" {
		query.Set("accessToken", token)
	}
	rel.RawQuery = query.Encode()
	fullURL := baseURL.ResolveReference(rel).String()

	var bodyReader io.Reader
	contentType := ""
	if form != nil {
		bodyReader = strings.NewReader(form.Encode())
		contentType = "application/x-www-form-urlencoded"
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, bodyReader)
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.build_request", map[string]any{
			"detail": err.Error(),
		})
	}
	if requestHost != "" {
		req.Host = requestHost
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "*/*")
	for name, values := range headers {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.request_failed", map[string]any{
			"detail": redactNacosAccessToken(err.Error(), token),
		})
	}
	defer resp.Body.Close()
	result.status = resp.StatusCode

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.read_body", map[string]any{
			"detail": err.Error(),
		})
	}
	result.body = body
	return result, nil
}

func redactNacosAccessToken(detail, token string) string {
	detail = redactNacosErrorText(detail)
	if strings.TrimSpace(token) == "" {
		return detail
	}
	redacted := strings.ReplaceAll(detail, url.QueryEscape(token), "[REDACTED]")
	return strings.ReplaceAll(redacted, token, "[REDACTED]")
}

func redactNacosErrorText(text string) string {
	redacted := nacosJSONSecretPattern.ReplaceAllString(text, `${1}[REDACTED]${3}`)
	redacted = nacosAuthorizationPattern.ReplaceAllString(redacted, `${1}[REDACTED]`)
	redacted = nacosSecretAssignmentPattern.ReplaceAllString(redacted, `${1}[REDACTED]`)
	return nacosBearerPattern.ReplaceAllString(redacted, `${1}[REDACTED]`)
}

func normalizeNacosConfig(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
	run := config
	run.Type = "nacos"
	run.Host = strings.TrimSpace(run.Host)
	if run.Host == "" {
		return run, localizedNacosBackendError("nacos.backend.error.host_required", nil)
	}
	if run.Port <= 0 {
		run.Port = defaultNacosPort
	}
	if run.Timeout <= 0 {
		run.Timeout = int(defaultNacosTimeout / time.Second)
	}
	return run, nil
}

func buildNacosHTTPClient(config connection.ConnectionConfig) (*http.Client, *url.URL, error) {
	return buildNacosHTTPClientWithDialAddress(config, "")
}

func buildNacosHTTPClientWithDialAddress(
	config connection.ConnectionConfig,
	dialAddress string,
) (*http.Client, *url.URL, error) {
	scheme := "http"
	if config.UseSSL || strings.EqualFold(strings.TrimSpace(config.SSLMode), "required") ||
		strings.EqualFold(strings.TrimSpace(config.SSLMode), "preferred") {
		scheme = "https"
	}

	contextPath := resolveNacosContextPath(config)
	base, err := url.Parse(fmt.Sprintf("%s://%s", scheme, net.JoinHostPort(config.Host, strconv.Itoa(config.Port))))
	if err != nil {
		return nil, nil, localizedNacosBackendError("nacos.backend.error.invalid_address", map[string]any{
			"detail": err.Error(),
		})
	}
	base.Path = contextPath

	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	dialContext := dialer.DialContext
	if dialTarget := strings.TrimSpace(dialAddress); dialTarget != "" {
		dialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, dialTarget)
		}
	} else if config.UseProxy {
		proxyConfig := config.Proxy
		dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return dialNacosProxyContext(ctx, proxyConfig, network, address)
		}
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	if strings.TrimSpace(dialAddress) != "" || config.UseProxy {
		// The explicit network hop is already handled by DialContext. Applying
		// an environment/http.Transport proxy as well would double-proxy it.
		transport.Proxy = nil
	}

	if scheme == "https" {
		sslMode := strings.ToLower(strings.TrimSpace(config.SSLMode))
		insecure := sslMode == "skip-verify" || sslMode == "preferred" || sslMode == ""
		tlsCfg, err := tlsconfig.BuildClientConfig(tlsconfig.ClientConfigOptions{
			Enabled:            true,
			InsecureSkipVerify: insecure,
			CAPath:             config.SSLCAPath,
			CertPath:           config.SSLCertPath,
			KeyPath:            config.SSLKeyPath,
		})
		if err != nil {
			return nil, nil, localizedNacosBackendError("nacos.backend.error.tls_setup_failed", map[string]any{
				"detail": err.Error(),
			})
		}
		if tlsCfg != nil {
			if strings.TrimSpace(dialAddress) != "" {
				tlsCfg.ServerName = strings.Trim(strings.TrimSpace(config.Host), "[]")
			}
			transport.TLSClientConfig = tlsCfg
		} else {
			transport.TLSClientConfig = &tls.Config{
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: insecure, //nolint:gosec
			}
			if strings.TrimSpace(dialAddress) != "" {
				transport.TLSClientConfig.ServerName = strings.Trim(strings.TrimSpace(config.Host), "[]")
			}
		}
	}

	client := &http.Client{
		// Request deadlines are supplied by the caller context. Keeping this
		// unset prevents a cached client from retaining the first connection's
		// timeout for later operations.
		Timeout:   0,
		Transport: transport,
	}
	return client, base, nil
}

func resolveNacosContextPath(config connection.ConnectionConfig) string {
	// Prefer connectionParams contextPath=...
	params := parseSimpleKV(config.ConnectionParams)
	if v := strings.TrimSpace(params["contextPath"]); v != "" {
		return normalizeContextPath(v)
	}
	// Allow Database field to carry context path as a convenience.
	if v := strings.TrimSpace(config.Database); v != "" && strings.Contains(v, "/") {
		return normalizeContextPath(v)
	}
	return defaultNacosContextPath
}

func normalizeContextPath(raw string) string {
	path := strings.TrimSpace(raw)
	if path == "" || path == "/" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return strings.TrimRight(path, "/")
}

func joinAPIPath(basePath, apiPath string) string {
	base := strings.TrimRight(strings.TrimSpace(basePath), "/")
	api := strings.TrimSpace(apiPath)
	if api == "" {
		return base
	}
	if !strings.HasPrefix(api, "/") {
		api = "/" + api
	}
	return base + api
}

func normalizeNamespaceID(raw string) string {
	id := strings.TrimSpace(raw)
	if strings.EqualFold(id, "public") {
		return ""
	}
	return id
}

func normalizeNacosTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		return defaultNacosTimeout
	}
	return time.Duration(seconds) * time.Second
}

func parseSimpleKV(raw string) map[string]string {
	result := make(map[string]string)
	text := strings.TrimSpace(raw)
	if text == "" {
		return result
	}
	// Support both "a=b&c=d" and "a=b;c=d" and newline-separated pairs.
	replacer := strings.NewReplacer(";", "&", "\n", "&")
	text = replacer.Replace(text)
	values, err := url.ParseQuery(text)
	if err == nil {
		for key, vals := range values {
			if len(vals) > 0 {
				result[strings.TrimSpace(key)] = strings.TrimSpace(vals[0])
			}
		}
		return result
	}
	for _, part := range strings.Split(text, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		result[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return result
}

func truncateForError(text string) string {
	const max = 400
	trimmed := strings.TrimSpace(redactNacosErrorText(text))
	if len(trimmed) <= max {
		return trimmed
	}
	cutoff := max
	for cutoff > 0 && !utf8.RuneStart(trimmed[cutoff]) {
		cutoff--
	}
	return trimmed[:cutoff] + "..."
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func stringifyAnyTime(values ...any) string {
	for _, v := range values {
		switch t := v.(type) {
		case nil:
			continue
		case string:
			if s := strings.TrimSpace(t); s != "" {
				return s
			}
		case float64:
			// millis or seconds
			if t > 1e12 {
				return time.UnixMilli(int64(t)).Format(time.RFC3339)
			}
			if t > 0 {
				return time.Unix(int64(t), 0).Format(time.RFC3339)
			}
		case json.Number:
			if i, err := t.Int64(); err == nil {
				if i > 1e12 {
					return time.UnixMilli(i).Format(time.RFC3339)
				}
				if i > 0 {
					return time.Unix(i, 0).Format(time.RFC3339)
				}
			}
		default:
			s := strings.TrimSpace(fmt.Sprint(t))
			if s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}
