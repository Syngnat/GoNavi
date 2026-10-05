package app

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func buildDriverNetworkProbeItems() []driverNetworkProbeItem {
	mirrorIndexURL := driverReleaseMirrorLatestIndexURL
	if strings.EqualFold(currentDriverReleaseTag(), driverReleaseDevTag) {
		mirrorIndexURL = driverReleaseMirrorDevLatestIndexURL
	}
	return []driverNetworkProbeItem{{
		ProbeCode: driverNetworkProbeCodeDownloadMirror,
		Name:      driverNetworkProbeNameDownloadMirror,
		URL:       mirrorIndexURL,
	}}
}

func buildDriverNetworkFallbackProbeItems(a *App) []driverNetworkProbeItem {
	githubAPIURL := driverReleaseLatestAPIURL
	if strings.EqualFold(currentDriverReleaseTag(), driverReleaseDevTag) {
		githubAPIURL = fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", driverReleaseRepo, driverReleaseDevTag)
	}
	return []driverNetworkProbeItem{
		{
			ProbeCode: driverNetworkProbeCodeGitHubAPI,
			Name:      a.appText("driver_manager.backend.network.probe.github_api", nil),
			URL:       githubAPIURL,
		},
		{
			ProbeCode: driverNetworkProbeCodeGitHubRelease,
			Name:      a.appText("driver_manager.backend.network.probe.github_driver_release", nil),
			// 探测小体积索引：新旧发布都带它，总包已从 ZIP 改为 7z，探测总包会在旧发布上 404。
			URL:       driverReleaseLatestDownloadURLForCurrentChannel(optionalDriverBundleIndexAssetName),
		},
		{
			ProbeCode: driverNetworkProbeCodeGitHubReleaseAsset,
			Name:      a.appText("driver_manager.backend.network.probe.github_release_asset_domain", nil),
			URL:       "https://release-assets.githubusercontent.com/",
		},
		{
			ProbeCode: driverNetworkProbeCodeGoModuleProxy,
			Name:      a.appText("driver_manager.backend.network.probe.go_module_proxy", nil),
			URL:       "https://proxy.golang.org/github.com/go-sql-driver/mysql/@v/list",
		},
	}
}

type driverNetworkProbeFunc func(*http.Client, driverNetworkProbeItem) driverNetworkProbeItem

func isDriverNetworkDownloadRouteAvailable(item driverNetworkProbeItem) bool {
	if !item.Reachable {
		return false
	}
	return item.HTTPStatus == 0 || item.HTTPStatus < http.StatusBadRequest
}

func (a *App) CheckDriverNetworkStatus() connection.QueryResult {
	return a.checkDriverNetworkStatusWithProbe(probeDriverNetworkEndpoint)
}

func (a *App) checkDriverNetworkStatusWithProbe(probe driverNetworkProbeFunc) connection.QueryResult {
	if probe == nil {
		probe = probeDriverNetworkEndpoint
	}

	client := newStrictHTTPClientWithGlobalProxy(driverNetworkProbeTimeout)
	mirrorItems := buildDriverNetworkProbeItems()
	checks := make([]driverNetworkProbeItem, 0, len(mirrorItems)+4)
	for _, item := range mirrorItems {
		checks = append(checks, probe(client, item))
	}
	mirrorReachable := len(checks) > 0 && isDriverNetworkDownloadRouteAvailable(checks[0])
	fallbackChecked := !mirrorReachable
	if fallbackChecked {
		for _, item := range buildDriverNetworkFallbackProbeItems(a) {
			checks = append(checks, probe(client, item))
		}
	}

	findProbe := func(probeCode string) (driverNetworkProbeItem, bool) {
		for _, item := range checks {
			if strings.EqualFold(strings.TrimSpace(item.ProbeCode), strings.TrimSpace(probeCode)) {
				return item, true
			}
		}
		return driverNetworkProbeItem{}, false
	}
	githubReleaseCheck, _ := findProbe(driverNetworkProbeCodeGitHubRelease)
	fallbackReachable := fallbackChecked && isDriverNetworkDownloadRouteAvailable(githubReleaseCheck)
	downloadChainReachable := mirrorReachable || fallbackReachable
	usingFallback := !mirrorReachable && fallbackReachable
	allReachable := mirrorReachable
	for _, item := range checks[1:] {
		if !item.Reachable {
			allReachable = false
			break
		}
	}

	proxyEnv := collectDriverProxyEnv()
	proxyConfigured := len(proxyEnv) > 0
	summary := a.appText("driver_manager.network.summary.reachable", nil)
	if mirrorReachable && proxyConfigured {
		summary = a.appText("driver_manager.network.summary.reachable_with_proxy", nil)
	} else if usingFallback {
		summary = a.appText("driver_manager.network.summary.mirror_fallback_available", nil)
	} else if !downloadChainReachable {
		if proxyConfigured {
			summary = a.appText("driver_manager.network.summary.unreachable_proxy_configured", nil)
		} else {
			summary = a.appText("driver_manager.network.summary.proxy_recommended", nil)
		}
	}

	downloadRequiredHosts := []string{"download.syngnat.top"}
	if fallbackChecked {
		downloadRequiredHosts = append(downloadRequiredHosts,
			"github.com",
			"api.github.com",
			"release-assets.githubusercontent.com",
			"objects.githubusercontent.com",
			"proxy.golang.org",
		)
	}

	data := map[string]interface{}{
		"reachable":              downloadChainReachable,
		"allReachable":           allReachable,
		"summary":                summary,
		"recommendedProxy":       !downloadChainReachable,
		"proxyConfigured":        proxyConfigured,
		"proxyEnv":               proxyEnv,
		"mirrorReachable":        mirrorReachable,
		"fallbackChecked":        fallbackChecked,
		"fallbackReachable":      fallbackReachable,
		"usingFallback":          usingFallback,
		"downloadChainReachable": downloadChainReachable,
		"downloadRequiredHosts":  downloadRequiredHosts,
		"checkedAt":              time.Now().Format(time.RFC3339),
		"checks":                 checks,
	}
	if logPath := strings.TrimSpace(logger.Path()); logPath != "" {
		data["logPath"] = logPath
	}
	return connection.QueryResult{
		Success: true,
		Data:    data,
	}
}

func probeDriverNetworkEndpoint(client *http.Client, item driverNetworkProbeItem) driverNetworkProbeItem {
	probed := item
	probed.Reachable = false
	probed.HTTPStatus = 0
	probed.Error = ""
	probed.LatencyMs = 0
	probed.TCPLatency = 0
	probed.HTTPLatency = 0
	probed.Method = ""

	urlText := strings.TrimSpace(item.URL)
	if urlText == "" {
		probed.Error = localizedDriverBackendText(nil, "driver_manager.backend.network.error.probe_url_empty", nil)
		return probed
	}

	if tcpLatency, tcpErr := probeDriverTCPLatency(urlText); tcpErr == nil {
		probed.TCPLatency = tcpLatency
		probed.LatencyMs = tcpLatency
	}

	if client == nil {
		client = newStrictHTTPClientWithGlobalProxy(driverNetworkProbeTimeout)
	}
	start := time.Now()
	resp, method, err := doDriverProbeRequest(client, urlText, http.MethodGet)
	if err != nil || shouldFallbackHeadProbe(resp) {
		if resp != nil {
			_ = resp.Body.Close()
		}
		// 回退到 HEAD 时重置计时，避免把失败重试耗时累计到最终延迟指标里。
		start = time.Now()
		resp, method, err = doDriverProbeRequest(client, urlText, http.MethodHead)
	}
	probed.HTTPLatency = time.Since(start).Milliseconds()
	if probed.LatencyMs <= 0 {
		probed.LatencyMs = probed.HTTPLatency
	}
	if err != nil {
		probed.Error = normalizeDriverNetworkError(err)
		return probed
	}
	defer resp.Body.Close()
	probed.Method = method

	probed.HTTPStatus = resp.StatusCode
	if resp.StatusCode >= 500 {
		probed.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return probed
	}
	probed.Reachable = true
	return probed
}

func probeDriverTCPLatency(rawURL string) (int64, error) {
	dialAddr, err := resolveDriverProbeDialAddress(rawURL)
	if err != nil {
		return 0, err
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", dialAddr, driverNetworkProbeTCPTimeout)
	elapsed := time.Since(start)
	latency := elapsed.Milliseconds()
	if elapsed > 0 && latency <= 0 {
		latency = 1
	}
	if err != nil {
		return latency, err
	}
	_ = conn.Close()
	return latency, nil
}

func resolveDriverProbeDialAddress(rawURL string) (string, error) {
	urlText := strings.TrimSpace(rawURL)
	if urlText == "" {
		return "", errors.New(localizedDriverBackendText(nil, "driver_manager.backend.network.error.probe_url_empty", nil))
	}
	parsed, err := url.Parse(urlText)
	if err != nil {
		return "", err
	}

	targetHost := strings.TrimSpace(parsed.Hostname())
	if targetHost == "" {
		return "", errors.New(localizedDriverBackendText(nil, "driver_manager.backend.network.error.probe_host_missing", nil))
	}
	targetPort := strings.TrimSpace(parsed.Port())
	if targetPort == "" {
		if strings.EqualFold(parsed.Scheme, "http") {
			targetPort = "80"
		} else {
			targetPort = "443"
		}
	}

	proxyURL, proxyErr := resolveDriverProbeProxyURL(parsed)
	if proxyErr != nil {
		return "", proxyErr
	}
	if proxyURL != nil {
		proxyHost := strings.TrimSpace(proxyURL.Hostname())
		if proxyHost == "" {
			return net.JoinHostPort(targetHost, targetPort), nil
		}
		proxyPort := strings.TrimSpace(proxyURL.Port())
		if proxyPort == "" {
			proxyPort = defaultPortForScheme(proxyURL.Scheme)
		}
		return net.JoinHostPort(proxyHost, proxyPort), nil
	}

	return net.JoinHostPort(targetHost, targetPort), nil
}

func resolveDriverProbeProxyURL(target *url.URL) (*url.URL, error) {
	if target == nil {
		return nil, nil
	}

	snapshot := currentGlobalProxyConfig()
	if snapshot.Enabled {
		proxyURL, err := buildProxyURLFromConfig(snapshot.Proxy)
		if err == nil {
			return proxyURL, nil
		}
	}

	req := &http.Request{URL: target}
	return defaultHTTPProxyFunc()(req)
}

func defaultPortForScheme(scheme string) string {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "https":
		return "443"
	case "socks5", "socks5h":
		return "1080"
	case "http":
		fallthrough
	default:
		return "80"
	}
}

func doDriverProbeRequest(client *http.Client, urlText string, method string) (*http.Response, string, error) {
	req, err := http.NewRequest(method, urlText, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	// 用 GET+Range 探测可更接近真实下载链路，同时避免下载正文。
	if strings.EqualFold(method, http.MethodGet) {
		req.Header.Set("Range", "bytes=0-0")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, method, err
	}
	return resp, method, nil
}

func shouldFallbackHeadProbe(resp *http.Response) bool {
	if resp == nil {
		return false
	}
	return resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusNotImplemented
}

func normalizeDriverNetworkError(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return localizedDriverBackendText(nil, "driver_manager.backend.network.error.timeout", nil)
	}
	return normalizeErrorMessage(err)
}

func collectDriverProxyEnv() map[string]string {
	keys := []string{
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	}
	result := make(map[string]string)
	for _, key := range keys {
		value := strings.TrimSpace(os.Getenv(key))
		if value == "" {
			continue
		}
		result[key] = value
	}
	return result
}

func driverLogHint() string {
	path := strings.TrimSpace(logger.Path())
	if path == "" {
		return ""
	}
	return localizedDriverBackendText(nil, "driver_manager.backend.message.log_hint", map[string]any{"path": path})
}

func logDriverOperationError(err error, format string, args ...interface{}) string {
	message := normalizeErrorMessage(err)
	if strings.TrimSpace(message) == "" {
		message = localizedDriverBackendText(nil, "driver_manager.backend.error.unknown", nil)
	}
	logger.Error(err, format, args...)
	return strings.TrimSpace(message) + driverLogHint()
}
