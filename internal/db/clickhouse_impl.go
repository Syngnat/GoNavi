//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

const (
	defaultClickHousePort     = 9000
	defaultClickHouseUser     = "default"
	defaultClickHouseDatabase = "default"
	minClickHouseReadTimeout  = 5 * time.Minute
	clickHouseHTTPPortHint    = "8123/8125/8132/8443"

	clickHouseProtocolAuto   = "auto"
	clickHouseProtocolHTTP   = "http"
	clickHouseProtocolNative = "native"
)

type ClickHouseDB struct {
	conn        *sql.DB
	legacyHTTP  *clickHouseLegacyHTTPClient
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
	database    string
}

func normalizeClickHouseConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := applyClickHouseURI(config)
	normalized = applyClickHouseHostURI(normalized)
	if strings.TrimSpace(normalized.Host) == "" {
		normalized.Host = "localhost"
	}
	if normalized.Port <= 0 {
		normalized.Port = defaultClickHousePort
	}
	if strings.TrimSpace(normalized.User) == "" {
		normalized.User = defaultClickHouseUser
	}
	if strings.TrimSpace(normalized.Database) == "" {
		normalized.Database = defaultClickHouseDatabase
	}
	return normalized
}

func applyClickHouseURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	return applyClickHouseEndpointURI(config, uriText, false)
}

func applyClickHouseHostURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	hostText := strings.TrimSpace(config.Host)
	if hostText == "" {
		return config
	}
	return applyClickHouseEndpointURI(config, hostText, true)
}

func applyClickHouseEndpointURI(config connection.ConnectionConfig, uriText string, fromHostField bool) connection.ConnectionConfig {
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if !isClickHouseSupportedEndpointScheme(scheme) || strings.TrimSpace(parsed.Host) == "" {
		return config
	}

	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}

	if dbName := strings.TrimPrefix(strings.TrimSpace(parsed.Path), "/"); dbName != "" && strings.TrimSpace(config.Database) == "" {
		config.Database = dbName
	}
	if strings.TrimSpace(config.Database) == "" {
		if dbName := strings.TrimSpace(parsed.Query().Get("database")); dbName != "" {
			config.Database = dbName
		}
	}
	if queryProtocol := normalizeClickHouseProtocol(parsed.Query().Get("protocol")); queryProtocol != clickHouseProtocolAuto {
		config.ClickHouseProtocol = queryProtocol
	}
	if parsed.RawQuery != "" {
		params := url.Values{}
		mergeConnectionParamValues(params, parsed.Query())
		mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
		config.ConnectionParams = params.Encode()
	}
	endpointProtocol := normalizeClickHouseProtocol(config.ClickHouseProtocol)
	if isClickHouseHTTPURLScheme(scheme) && endpointProtocol != clickHouseProtocolNative {
		config.ClickHouseProtocol = clickHouseProtocolHTTP
		if scheme == "https" {
			config.UseSSL = true
			if normalizeSSLModeValue(config.SSLMode) == sslModeDisable || strings.TrimSpace(config.SSLMode) == "" {
				config.SSLMode = sslModeRequired
			}
		}
	}

	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultClickHousePort
	}
	if isClickHouseHTTPURLScheme(scheme) && endpointProtocol != clickHouseProtocolNative && defaultPort == defaultClickHousePort {
		defaultPort = defaultClickHousePortForScheme(scheme)
	}
	if fromHostField || strings.TrimSpace(config.Host) == "" {
		host, port, ok := parseHostPortWithDefault(parsed.Host, defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}
	if config.Port <= 0 {
		config.Port = defaultPort
	}
	return config
}

func isClickHouseSupportedEndpointScheme(scheme string) bool {
	switch scheme {
	case "clickhouse", "http", "https":
		return true
	default:
		return false
	}
}

func isClickHouseHTTPURLScheme(scheme string) bool {
	return scheme == "http" || scheme == "https"
}

func defaultClickHousePortForScheme(scheme string) int {
	switch scheme {
	case "http":
		return 8123
	case "https":
		return 8443
	default:
		return defaultClickHousePort
	}
}

func (c *ClickHouseDB) buildClickHouseOptions(config connection.ConnectionConfig) (*clickhouse.Options, error) {
	return c.buildClickHouseOptionsWithHTTPCompatibility(config, false)
}

func (c *ClickHouseDB) buildClickHouseOptionsWithHTTPCompatibility(config connection.ConnectionConfig, stripHTTPClientProtocolVersion bool) (*clickhouse.Options, error) {
	connectTimeout := getConnectTimeout(config)
	readTimeout := connectTimeout
	if readTimeout < minClickHouseReadTimeout {
		readTimeout = minClickHouseReadTimeout
	}
	protocol := detectClickHouseProtocol(config)
	opts := &clickhouse.Options{
		Protocol: protocol,
		Addr: []string{
			net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		},
		Auth: clickhouse.Auth{
			Database: strings.TrimSpace(config.Database),
			Username: strings.TrimSpace(config.User),
			Password: config.Password,
		},
		DialTimeout: connectTimeout,
		ReadTimeout: readTimeout,
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		opts.TLS = tlsConfig
	}
	applyClickHouseConnectionParams(opts, config)
	if stripHTTPClientProtocolVersion && protocol == clickhouse.HTTP {
		installClickHouseHTTPClientProtocolVersionStripper(opts)
	}
	return opts, nil
}

type clickHouseHTTPClientProtocolVersionStripper struct {
	next http.RoundTripper
	// serverHelloRewritten 保证只对每个连接的首个握手探测请求改写一次，
	// 避免连接建立之后误改写恰好相同的用户查询（clickhouse-go 的 queryHello
	// 始终是连接上的第一个 HTTP 请求）。
	serverHelloRewritten *atomic.Bool
}

func (rt clickHouseHTTPClientProtocolVersionStripper) RoundTrip(req *http.Request) (*http.Response, error) {
	next := rt.next
	if next == nil {
		next = http.DefaultTransport
	}
	if req == nil || req.URL == nil {
		return next.RoundTrip(req)
	}

	query := req.URL.Query()
	stripParam := false
	if _, ok := query["client_protocol_version"]; ok {
		stripParam = true
	}

	var (
		rewrittenBody      []byte
		hadServerInfoQuery bool
		err                error
	)
	// 仅在握手阶段（首个匹配请求）改写探测查询；后续用户查询一律放行。
	if rt.serverHelloRewritten == nil || !rt.serverHelloRewritten.Load() {
		rewrittenBody, hadServerInfoQuery, err = rewriteClickHouseServerHelloRequestBody(req)
		if err != nil {
			return nil, err
		}
		if hadServerInfoQuery && rt.serverHelloRewritten != nil {
			rt.serverHelloRewritten.Store(true)
		}
	}

	if !stripParam && !hadServerInfoQuery {
		return next.RoundTrip(req)
	}

	cloned := req.Clone(req.Context())
	if stripParam {
		clonedURL := *req.URL
		query.Del("client_protocol_version")
		clonedURL.RawQuery = query.Encode()
		cloned.URL = &clonedURL
	}
	if hadServerInfoQuery {
		cloned.Body = io.NopCloser(bytes.NewReader(rewrittenBody))
		cloned.ContentLength = int64(len(rewrittenBody))
		cloned.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(rewrittenBody)), nil
		}
	}
	return next.RoundTrip(cloned)
}

// clickHouseServerHelloQuery 是 clickhouse-go HTTP 驱动在握手阶段发送的服务端信息探测语句。
// 旧版本服务端（如 ClickHouse 22.8）没有 displayName() 函数，会直接返回 UNKNOWN_FUNCTION。
const clickHouseServerHelloQuery = "SELECT displayName(), version(), revision(), timezone()"

// clickHouseServerHelloCompatQuery 使用 hostName() 替换不存在的 displayName()。
// hostName() 在所有受支持的 ClickHouse 版本上都可用，并返回服务端主机名，
// 足以填充驱动握手所需的显示名称字段，其余 version()/revision()/timezone() 保持不变。
const clickHouseServerHelloCompatQuery = "SELECT hostName(), version(), revision(), timezone()"

// rewriteClickHouseServerHelloRequestBody 检测并改写握手探测请求体，将 displayName() 替换为
// hostName()。仅当请求体恰好是驱动的握手探测语句时才改写，其它请求体一律原样放行。
func rewriteClickHouseServerHelloRequestBody(req *http.Request) ([]byte, bool, error) {
	if req == nil || req.Body == nil || req.Body == http.NoBody {
		return nil, false, nil
	}
	body, err := io.ReadAll(req.Body)
	closeErr := req.Body.Close()
	if err != nil {
		return nil, false, err
	}
	if closeErr != nil {
		return nil, false, closeErr
	}
	// 恢复原始请求体，保证非握手请求不受影响。
	req.Body = io.NopCloser(bytes.NewReader(body))
	if strings.TrimSpace(string(body)) != clickHouseServerHelloQuery {
		return nil, false, nil
	}
	return []byte(clickHouseServerHelloCompatQuery), true, nil
}

func installClickHouseHTTPClientProtocolVersionStripper(opts *clickhouse.Options) {
	if opts == nil {
		return
	}
	previous := opts.TransportFunc
	opts.TransportFunc = func(base *http.Transport) (http.RoundTripper, error) {
		next := http.RoundTripper(base)
		if previous != nil {
			wrapped, err := previous(base)
			if err != nil {
				return nil, err
			}
			if wrapped != nil {
				next = wrapped
			}
		}
		return clickHouseHTTPClientProtocolVersionStripper{
			next:                 next,
			serverHelloRewritten: &atomic.Bool{},
		}, nil
	}
}

func parseClickHouseDurationParam(raw string) (time.Duration, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return 0, false
	}
	if n, err := strconv.Atoi(text); err == nil && n >= 0 {
		return time.Duration(n) * time.Second, true
	}
	duration, err := time.ParseDuration(text)
	return duration, err == nil
}

func parseClickHouseIntParam(raw string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	return n, err == nil
}

func clickHouseSettingValue(raw string) any {
	text := strings.TrimSpace(raw)
	switch strings.ToLower(text) {
	case "true", "yes", "on":
		return int(1)
	case "false", "no", "off":
		return int(0)
	}
	if n, err := strconv.Atoi(text); err == nil {
		return n
	}
	return text
}

func applyClickHouseCompressionParam(opts *clickhouse.Options, raw string) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" || value == "false" || value == "0" || value == "none" {
		opts.Compression = &clickhouse.Compression{Method: clickhouse.CompressionNone}
		return
	}
	if opts.Compression == nil {
		opts.Compression = &clickhouse.Compression{Level: 3}
	}
	switch value {
	case "true", "1", "lz4":
		opts.Compression.Method = clickhouse.CompressionLZ4
	case "zstd":
		opts.Compression.Method = clickhouse.CompressionZSTD
	case "lz4hc":
		opts.Compression.Method = clickhouse.CompressionLZ4HC
	case "gzip":
		opts.Compression.Method = clickhouse.CompressionGZIP
	case "deflate":
		opts.Compression.Method = clickhouse.CompressionDeflate
	case "br", "brotli":
		opts.Compression.Method = clickhouse.CompressionBrotli
	}
}

func applyClickHouseConnectionParams(opts *clickhouse.Options, config connection.ConnectionConfig) {
	params := url.Values{}
	mergeConnectionParamsFromConfig(params, config, "clickhouse", "http", "https")
	if len(params) == 0 {
		return
	}
	if opts.Settings == nil {
		opts.Settings = clickhouse.Settings{}
	}
	keys := make([]string, 0, len(params))
	for key := range params {
		if strings.TrimSpace(key) != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		values := params[key]
		if len(values) == 0 {
			continue
		}
		value := values[len(values)-1]
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "protocol", "secure", "skip_verify", "username", "password", "database":
			continue
		case "dial_timeout":
			if duration, ok := parseClickHouseDurationParam(value); ok {
				opts.DialTimeout = duration
			}
		case "read_timeout":
			if duration, ok := parseClickHouseDurationParam(value); ok {
				opts.ReadTimeout = duration
			}
		case "compress":
			applyClickHouseCompressionParam(opts, value)
		case "compress_level":
			if level, ok := parseClickHouseIntParam(value); ok {
				if opts.Compression == nil {
					opts.Compression = &clickhouse.Compression{Method: clickhouse.CompressionNone}
				}
				opts.Compression.Level = level
			}
		case "max_open_conns":
			if n, ok := parseClickHouseIntParam(value); ok {
				opts.MaxOpenConns = n
			}
		case "max_idle_conns":
			if n, ok := parseClickHouseIntParam(value); ok {
				opts.MaxIdleConns = n
			}
		case "max_compression_buffer":
			if n, ok := parseClickHouseIntParam(value); ok {
				opts.MaxCompressionBuffer = n
			}
		case "block_buffer_size":
			if n, ok := parseClickHouseIntParam(value); ok && n > 0 && n <= 255 {
				opts.BlockBufferSize = uint8(n)
			}
		case "http_path":
			path := strings.TrimSpace(value)
			if path != "" && !strings.HasPrefix(path, "/") {
				path = "/" + path
			}
			opts.HttpUrlPath = path
		case "connection_open_strategy":
			switch strings.ToLower(strings.TrimSpace(value)) {
			case "in_order":
				opts.ConnOpenStrategy = clickhouse.ConnOpenInOrder
			case "round_robin":
				opts.ConnOpenStrategy = clickhouse.ConnOpenRoundRobin
			case "random":
				opts.ConnOpenStrategy = clickhouse.ConnOpenRandom
			}
		default:
			opts.Settings[key] = clickHouseSettingValue(value)
		}
	}
	if len(opts.Settings) == 0 {
		opts.Settings = nil
	}
}

func detectClickHouseProtocol(config connection.ConnectionConfig) clickhouse.Protocol {
	switch normalizeClickHouseProtocol(config.ClickHouseProtocol) {
	case clickHouseProtocolHTTP:
		return clickhouse.HTTP
	case clickHouseProtocolNative:
		return clickhouse.Native
	}
	if hasClickHouseHTTPScheme(config.URI) || hasClickHouseHTTPScheme(config.Host) {
		return clickhouse.HTTP
	}
	uriText := strings.ToLower(strings.TrimSpace(config.URI))
	if strings.HasPrefix(uriText, "http://") || strings.HasPrefix(uriText, "https://") {
		return clickhouse.HTTP
	}
	if isClickHouseHTTPPort(config.Port) {
		return clickhouse.HTTP
	}
	return clickhouse.Native
}

func normalizeClickHouseProtocol(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case clickHouseProtocolHTTP, "https":
		return clickHouseProtocolHTTP
	case clickHouseProtocolNative, "tcp":
		return clickHouseProtocolNative
	default:
		return clickHouseProtocolAuto
	}
}

func hasClickHouseHTTPScheme(raw string) bool {
	text := strings.ToLower(strings.TrimSpace(raw))
	return strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://")
}

func isClickHouseHTTPPort(port int) bool {
	switch port {
	case 8123, 8125, 8132, 8443:
		return true
	default:
		return false
	}
}

func isClickHouseProtocolMismatch(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" {
		return false
	}
	return strings.Contains(text, "unexpected packet [72]") ||
		(strings.Contains(text, "unexpected packet") && strings.Contains(text, "handshake")) ||
		(strings.Contains(text, "cannot parse input") && strings.Contains(text, "expected '('")) ||
		strings.Contains(text, "http response to https client") ||
		strings.Contains(text, "malformed http response")
}

func isClickHouseHTTPClientProtocolVersionUnsupported(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" || !strings.Contains(text, "client_protocol_version") {
		return false
	}
	return strings.Contains(text, "unknown setting") ||
		strings.Contains(text, "unknown_setting") ||
		strings.Contains(text, "code: 115")
}

// isClickHouseHTTPServerInfoFunctionUnsupported 识别 clickhouse-go 在 HTTP 握手阶段
// 执行 "SELECT displayName(), version(), revision(), timezone()" 时，旧版本服务端
// （如 ClickHouse 22.8）因不存在 displayName() 函数而返回的 Code 46 / UNKNOWN_FUNCTION 错误。
func isClickHouseHTTPServerInfoFunctionUnsupported(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" || !strings.Contains(text, "displayname") {
		return false
	}
	return strings.Contains(text, "unknown function") ||
		strings.Contains(text, "unknown_function") ||
		strings.Contains(text, "code: 46")
}

// shouldRetryClickHouseHTTPCompatibility 判断 HTTP 协议下的失败是否可以通过
// HTTP 兼容模式（移除 client_protocol_version 并改写握手探测查询）重试解决。
func shouldRetryClickHouseHTTPCompatibility(err error) bool {
	return isClickHouseHTTPClientProtocolVersionUnsupported(err) ||
		isClickHouseHTTPServerInfoFunctionUnsupported(err)
}

func isClickHouseNativeHandshakeTimeout(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if !strings.Contains(text, "handshake") {
		return false
	}
	return strings.Contains(text, "i/o timeout") ||
		strings.Contains(text, "context deadline exceeded") ||
		strings.Contains(text, "deadline exceeded")
}

func shouldTryNextClickHouseProtocol(protocol clickhouse.Protocol, err error) bool {
	return isClickHouseProtocolMismatch(err) ||
		(protocol == clickhouse.Native && isClickHouseNativeHandshakeTimeout(err)) ||
		(protocol == clickhouse.HTTP && shouldRetryClickHouseHTTPCompatibility(err))
}

func clickHouseProtocolName(protocol clickhouse.Protocol) string {
	if protocol == clickhouse.HTTP {
		return "HTTP"
	}
	return "Native"
}

func sanitizeClickHouseErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	text := strings.ToValidUTF8(err.Error(), "�")
	var b strings.Builder
	lastSpace := false
	for _, r := range text {
		if r == utf8.RuneError || r == '�' {
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
			continue
		}
		if unicode.IsControl(r) {
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
			continue
		}
		b.WriteRune(r)
		lastSpace = unicode.IsSpace(r)
	}
	sanitized := strings.Join(strings.Fields(b.String()), " ")
	if len(sanitized) > 320 {
		return sanitized[:320] + "..."
	}
	return sanitized
}

func clickHouseAttemptFailureMessage(protocol clickhouse.Protocol, err error) string {
	if protocol == clickhouse.HTTP && isClickHouseHTTPClientProtocolVersionUnsupported(err) {
		return localizedDriverRuntimeText("db.backend.error.clickhouse_http_client_protocol_version_unsupported", nil)
	}
	if protocol == clickhouse.HTTP && isClickHouseHTTPServerInfoFunctionUnsupported(err) {
		return "当前 ClickHouse HTTP 端口不支持 displayName() 握手探测函数（常见于 ClickHouse 22.8），将使用 HTTP 兼容模式重试；如仍失败请确认连接协议和端口"
	}
	if isClickHouseProtocolMismatch(err) {
		if protocol == clickhouse.Native {
			return localizedDriverRuntimeText("db.backend.error.clickhouse_native_protocol_mismatch", nil)
		}
		return localizedDriverRuntimeText("db.backend.error.clickhouse_http_protocol_mismatch", nil)
	}
	message := sanitizeClickHouseErrorMessage(err)
	if message == "" {
		return localizedDriverRuntimeText("db.backend.error.clickhouse_unknown_error", nil)
	}
	return message
}

func clickHouseTLSConfigFailedMessage(attempt int, protocol string, err error) string {
	return localizedDriverRuntimeText("db.backend.error.clickhouse_attempt_tls_config_failed", map[string]any{
		"attempt":  attempt,
		"protocol": protocol,
		"detail":   err,
	})
}

func clickHouseAttemptValidationFailedMessage(attempt int, protocol string, detail string) string {
	return localizedDriverRuntimeText("db.backend.error.clickhouse_attempt_validation_failed", map[string]any{
		"attempt":  attempt,
		"protocol": protocol,
		"detail":   detail,
	})
}

func clickHouseConnectFailureSummary(config connection.ConnectionConfig, failures []string) string {
	protocolMode := normalizeClickHouseProtocol(config.ClickHouseProtocol)
	detail := strings.Join(failures, "; ")
	if strings.TrimSpace(detail) == "" {
		detail = localizedDriverRuntimeText("db.backend.error.clickhouse_driver_detail_missing", nil)
	}
	if protocolMode != clickHouseProtocolAuto {
		return localizedDriverRuntimeText("db.backend.error.clickhouse_validation_failed_manual", map[string]any{
			"protocol": strings.ToUpper(protocolMode),
			"host":     config.Host,
			"port":     config.Port,
			"detail":   detail,
		})
	}
	return localizedDriverRuntimeText("db.backend.error.clickhouse_validation_failed_auto", map[string]any{
		"httpPorts": clickHouseHTTPPortHint,
		"detail":    detail,
	})
}

func withClickHouseProtocol(config connection.ConnectionConfig, protocol clickhouse.Protocol) connection.ConnectionConfig {
	next := config
	switch protocol {
	case clickhouse.HTTP:
		next.ClickHouseProtocol = clickHouseProtocolHTTP
		if next.Port == 0 {
			next.Port = 8123
		}
	default:
		next.ClickHouseProtocol = clickHouseProtocolNative
		if next.Port == 0 {
			next.Port = defaultClickHousePort
		}
	}
	return next
}

func clickHouseProtocolsForAttempt(config connection.ConnectionConfig) []clickhouse.Protocol {
	primaryProtocol := detectClickHouseProtocol(config)
	if normalizeClickHouseProtocol(config.ClickHouseProtocol) != clickHouseProtocolAuto {
		return []clickhouse.Protocol{primaryProtocol}
	}
	if primaryProtocol == clickhouse.Native {
		return []clickhouse.Protocol{primaryProtocol, clickhouse.HTTP}
	}
	return []clickhouse.Protocol{primaryProtocol, clickhouse.Native}
}

func (c *ClickHouseDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = c.Close()
	defer func() {
		if err != nil {
			_ = c.Close()
		}
	}()

	if supported, reason := DriverRuntimeSupportStatus("clickhouse"); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = localizedDriverRuntimeText("driver_manager.backend.status.optional_disabled", map[string]any{"name": "ClickHouse"})
		}
		return fmt.Errorf("%s", reason)
	}

	runConfig := normalizeClickHouseConfig(config)
	c.pingTimeout = getConnectTimeout(runConfig)
	c.database = runConfig.Database
	logger.Infof("ClickHouse 连接准备：地址=%s:%d 数据库=%s 用户=%s 协议选择=%s SSL=%t SSH=%t 超时=%s",
		runConfig.Host, runConfig.Port, runConfig.Database, runConfig.User,
		normalizeClickHouseProtocol(runConfig.ClickHouseProtocol), runConfig.UseSSL, runConfig.UseSSH, c.pingTimeout)

	if runConfig.UseSSH {
		if normalizeClickHouseProtocol(runConfig.ClickHouseProtocol) == clickHouseProtocolAuto && detectClickHouseProtocol(runConfig) == clickhouse.HTTP {
			runConfig.ClickHouseProtocol = clickHouseProtocolHTTP
		}
		logger.Infof("ClickHouse 使用 SSH 连接：地址=%s:%d 用户=%s", runConfig.Host, runConfig.Port, runConfig.User)
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		c.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("ClickHouse 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for idx, attempt := range attempts {
		protocols := clickHouseProtocolsForAttempt(attempt)
		for pIdx, protocol := range protocols {
			protocolConfig := withClickHouseProtocol(attempt, protocol)
			compatibilityModes := []bool{false}
			if protocol == clickhouse.HTTP {
				compatibilityModes = append(compatibilityModes, true)
			}
			protocolSuccess := false
			var lastProtocolErr error
			for compatIdx, stripHTTPClientProtocolVersion := range compatibilityModes {
				logger.Infof("ClickHouse 连接尝试：第%d组/%d 协议=%s 地址=%s:%d SSL=%t HTTP兼容=%t",
					idx+1, len(attempts), clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, stripHTTPClientProtocolVersion)
				opts, err := c.buildClickHouseOptionsWithHTTPCompatibility(protocolConfig, stripHTTPClientProtocolVersion)
				if err != nil {
					failures = append(failures, clickHouseTLSConfigFailedMessage(idx+1, protocol.String(), err))
					logger.Warnf("ClickHouse TLS 配置失败：第%d组/%d 协议=%s 地址=%s:%d SSL=%t 原因=%v",
						idx+1, len(attempts), clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, err)
					lastProtocolErr = err
					break
				}
				c.conn = clickhouse.OpenDB(opts)
				configureSQLConnectionPool(c.conn, "clickhouse")
				if err := c.Ping(); err != nil {
					lastProtocolErr = err
					failureMessage := clickHouseAttemptFailureMessage(protocol, err)
					failures = append(failures, clickHouseAttemptValidationFailedMessage(idx+1, protocol.String(), failureMessage))
					logger.Warnf("ClickHouse 连接尝试失败：第%d组/%d 协议=%s 地址=%s:%d SSL=%t HTTP兼容=%t 原因=%s",
						idx+1, len(attempts), clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, stripHTTPClientProtocolVersion, failureMessage)
					if c.conn != nil {
						_ = c.conn.Close()
						c.conn = nil
					}
					if protocol == clickhouse.HTTP &&
						!stripHTTPClientProtocolVersion &&
						shouldRetryClickHouseHTTPCompatibility(err) &&
						compatIdx+1 < len(compatibilityModes) {
						if isClickHouseHTTPServerInfoFunctionUnsupported(err) {
							logger.Warnf("ClickHouse HTTP 端口不支持 displayName() 握手探测函数，改用 HTTP 兼容模式重试")
						} else {
							logger.Warnf("ClickHouse HTTP 端口不支持 client_protocol_version，改用 HTTP 兼容模式重试")
						}
						continue
					}
					if protocol == clickhouse.HTTP && stripHTTPClientProtocolVersion {
						legacyClient, legacyErr := c.connectClickHouseLegacyHTTP(opts)
						if legacyErr == nil {
							c.legacyHTTP = legacyClient
							protocolSuccess = true
							logger.Warnf("ClickHouse HTTP 兼容握手无法解码旧版 Native block，已切换 legacy JSON HTTP 模式")
							break
						}
						lastProtocolErr = legacyErr
						legacyFailure := sanitizeClickHouseErrorMessage(legacyErr)
						failures = append(failures, clickHouseAttemptValidationFailedMessage(idx+1, "legacy-http", legacyFailure))
						logger.Warnf("ClickHouse legacy JSON HTTP 连接尝试失败：第%d组/%d 地址=%s:%d SSL=%t 原因=%s",
							idx+1, len(attempts), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, legacyFailure)
					}
					break
				}
				protocolSuccess = true
				if stripHTTPClientProtocolVersion {
					logger.Warnf("ClickHouse HTTP 兼容模式连接成功：已移除 client_protocol_version 参数")
				}
				break
			}
			if !protocolSuccess {
				if pIdx == 0 && !shouldTryNextClickHouseProtocol(protocol, lastProtocolErr) {
					// 首次连接不是协议误配或已知兼容性特征，避免无谓重试次协议。
					break
				}
				continue
			}
			if idx > 0 {
				logger.Warnf("ClickHouse SSL 优先连接失败，已回退至明文连接")
			}
			if pIdx > 0 {
				logger.Warnf("ClickHouse 已自动切换连接协议为 %s（常见于 %s HTTP 端口）", protocol.String(), clickHouseHTTPPortHint)
			}
			logger.Infof("ClickHouse 连接验证成功：协议=%s 地址=%s:%d 数据库=%s", clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.Database)
			return nil
		}
	}

	_ = c.Close()
	return fmt.Errorf("%s", clickHouseConnectFailureSummary(runConfig, failures))
}

func (c *ClickHouseDB) connectClickHouseLegacyHTTP(opts *clickhouse.Options) (*clickHouseLegacyHTTPClient, error) {
	legacyClient, err := newClickHouseLegacyHTTPClient(opts)
	if err != nil {
		return nil, err
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	if err := legacyClient.Ping(ctx); err != nil {
		_ = legacyClient.Close()
		return nil, err
	}
	return legacyClient, nil
}

func (c *ClickHouseDB) Close() error {
	if c.forwarder != nil {
		if err := c.forwarder.Release(); err != nil {
			logger.Warnf("关闭 ClickHouse SSH 端口转发失败：%v", err)
		}
		c.forwarder = nil
	}
	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		if err != nil {
			return err
		}
	}
	if c.legacyHTTP != nil {
		err := c.legacyHTTP.Close()
		c.legacyHTTP = nil
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *ClickHouseDB) Ping() error {
	if c.legacyHTTP != nil {
		timeout := c.pingTimeout
		if timeout <= 0 {
			timeout = 5 * time.Second
		}
		ctx, cancel := utils.ContextWithTimeout(timeout)
		defer cancel()
		return c.legacyHTTP.Ping(ctx)
	}
	if c.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	if err := c.conn.PingContext(ctx); err != nil {
		return err
	}
	return c.validateQueryPath()
}

func (c *ClickHouseDB) validateQueryPath() error {
	if c.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()

	rows, err := c.conn.QueryContext(ctx, "SELECT currentDatabase()")
	if err != nil {
		return err
	}
	defer rows.Close()

	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return fmt.Errorf("连接查询验证未返回结果")
	}

	var current sql.NullString
	if err := rows.Scan(&current); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return nil
}

func (c *ClickHouseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.Query(ctx, query)
	}
	if c.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := c.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (c *ClickHouseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.Query(context.Background(), query)
	}
	if c.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := c.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (c *ClickHouseDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.StreamQuery(ctx, query, consumer)
	}
	if c.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	rows, err := c.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRows(rows, consumer)
}

func (c *ClickHouseDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return c.StreamQueryContext(context.Background(), query, consumer)
}

func (c *ClickHouseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.Exec(ctx, query)
	}
	if c.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := c.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *ClickHouseDB) Exec(query string) (int64, error) {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.Exec(context.Background(), query)
	}
	if c.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := c.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *ClickHouseDB) GetDatabases() ([]string, error) {
	data, _, err := c.Query("SELECT name FROM system.databases ORDER BY name")
	if err == nil {
		result := make([]string, 0, len(data))
		for _, row := range data {
			if val, ok := getClickHouseValueFromRow(row, "name", "database"); ok {
				result = append(result, fmt.Sprintf("%v", val))
				continue
			}
			for _, value := range row {
				result = append(result, fmt.Sprintf("%v", value))
				break
			}
		}
		if len(result) > 0 {
			return result, nil
		}
	}

	fallbackData, _, fallbackErr := c.Query("SELECT currentDatabase() AS name")
	if fallbackErr != nil {
		if err != nil {
			return nil, err
		}
		return nil, fallbackErr
	}

	result := make([]string, 0, len(fallbackData))
	for _, row := range fallbackData {
		if val, ok := getClickHouseValueFromRow(row, "name", "database", "currentDatabase"); ok {
			name := strings.TrimSpace(fmt.Sprintf("%v", val))
			if name != "" {
				result = append(result, name)
			}
			continue
		}
		for _, value := range row {
			name := strings.TrimSpace(fmt.Sprintf("%v", value))
			if name != "" {
				result = append(result, name)
			}
			break
		}
	}
	if len(result) > 0 {
		return result, nil
	}
	if current := strings.TrimSpace(c.database); current != "" {
		return []string{current}, nil
	}
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("未获取到 ClickHouse 数据库列表")
}

func (c *ClickHouseDB) GetTables(dbName string) ([]string, error) {
	targetDB := strings.TrimSpace(dbName)
	if targetDB == "" {
		targetDB = strings.TrimSpace(c.database)
	}

	var query string
	if targetDB != "" {
		query = fmt.Sprintf(
			"SELECT name FROM system.tables WHERE database = '%s' ORDER BY name",
			escapeClickHouseSQLLiteral(targetDB),
		)
	} else {
		query = "SELECT database, name FROM system.tables ORDER BY database, name"
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	result := make([]string, 0, len(data))
	for _, row := range data {
		if targetDB != "" {
			if val, ok := getClickHouseValueFromRow(row, "name", "table", "table_name"); ok {
				result = append(result, fmt.Sprintf("%v", val))
				continue
			}
		} else {
			databaseValue, hasDB := getClickHouseValueFromRow(row, "database", "schema_name")
			tableValue, hasTable := getClickHouseValueFromRow(row, "name", "table", "table_name")
			if hasDB && hasTable {
				result = append(result, fmt.Sprintf("%v.%v", databaseValue, tableValue))
				continue
			}
		}
		for _, value := range row {
			result = append(result, fmt.Sprintf("%v", value))
			break
		}
	}
	return result, nil
}

func (c *ClickHouseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	database, table, err := c.resolveDatabaseAndTable(dbName, tableName)
	if err != nil {
		return "", err
	}

	query := fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteClickHouseIdentifier(database), quoteClickHouseIdentifier(table))
	data, _, err := c.Query(query)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
	}
	row := data[0]
	if val, ok := getClickHouseValueFromRow(row, "statement", "create_statement", "sql", "query"); ok {
		text := strings.TrimSpace(fmt.Sprintf("%v", val))
		if text != "" {
			return text, nil
		}
	}

	longest := ""
	for _, value := range row {
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" {
			continue
		}
		if strings.Contains(strings.ToUpper(text), "CREATE ") && len(text) > len(longest) {
			longest = text
		}
	}
	if longest != "" {
		return longest, nil
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func (c *ClickHouseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	database, table, err := c.resolveDatabaseAndTable(dbName, tableName)
	if err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`
SELECT
    name,
    type,
    default_kind,
    default_expression,
    is_in_primary_key,
    is_in_sorting_key,
    comment
FROM system.columns
WHERE database = '%s' AND table = '%s'
ORDER BY position`,
		escapeClickHouseSQLLiteral(database),
		escapeClickHouseSQLLiteral(table),
	)
	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		nameValue, _ := getClickHouseValueFromRow(row, "name", "column_name")
		typeValue, _ := getClickHouseValueFromRow(row, "type", "data_type")
		defaultKind, _ := getClickHouseValueFromRow(row, "default_kind")
		defaultExpr, hasDefault := getClickHouseValueFromRow(row, "default_expression", "column_default")
		commentValue, _ := getClickHouseValueFromRow(row, "comment")
		inPrimary, _ := getClickHouseValueFromRow(row, "is_in_primary_key")
		inSorting, _ := getClickHouseValueFromRow(row, "is_in_sorting_key")

		colType := strings.TrimSpace(fmt.Sprintf("%v", typeValue))
		nullable := "NO"
		if strings.HasPrefix(strings.ToLower(colType), "nullable(") {
			nullable = "YES"
		}

		key := ""
		if isClickHouseTruthy(inPrimary) {
			key = "PRI"
		} else if isClickHouseTruthy(inSorting) {
			key = "MUL"
		}

		extra := ""
		kindText := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", defaultKind)))
		if kindText != "" && kindText != "DEFAULT" {
			extra = kindText
		}

		col := connection.ColumnDefinition{
			Name:     strings.TrimSpace(fmt.Sprintf("%v", nameValue)),
			Type:     colType,
			Nullable: nullable,
			Key:      key,
			Extra:    extra,
			Comment:  strings.TrimSpace(fmt.Sprintf("%v", commentValue)),
		}
		if hasDefault && defaultExpr != nil {
			text := strings.TrimSpace(fmt.Sprintf("%v", defaultExpr))
			if text != "" {
				col.Default = &text
			}
		}
		columns = append(columns, col)
	}
	return columns, nil
}

func (c *ClickHouseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	targetDB := strings.TrimSpace(dbName)
	if targetDB == "" {
		targetDB = strings.TrimSpace(c.database)
	}

	var query string
	if targetDB != "" {
		query = fmt.Sprintf(`
SELECT
    database,
    table,
    name,
    type,
    comment
FROM system.columns
WHERE database = '%s'
ORDER BY table, position`,
			escapeClickHouseSQLLiteral(targetDB),
		)
	} else {
		query = `
SELECT
    database,
    table,
    name,
    type,
    comment
FROM system.columns
WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
ORDER BY database, table, position`
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	result := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		databaseValue, _ := getClickHouseValueFromRow(row, "database")
		tableValue, hasTable := getClickHouseValueFromRow(row, "table", "table_name")
		nameValue, hasName := getClickHouseValueFromRow(row, "name", "column_name")
		typeValue, _ := getClickHouseValueFromRow(row, "type", "data_type")
		commentValue, _ := getClickHouseValueFromRow(row, "comment")
		if !hasTable || !hasName {
			continue
		}

		tableName := strings.TrimSpace(fmt.Sprintf("%v", tableValue))
		if targetDB == "" {
			dbText := strings.TrimSpace(fmt.Sprintf("%v", databaseValue))
			if dbText != "" {
				tableName = dbText + "." + tableName
			}
		}

		result = append(result, connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      strings.TrimSpace(fmt.Sprintf("%v", nameValue)),
			Type:      strings.TrimSpace(fmt.Sprintf("%v", typeValue)),
			Comment:   strings.TrimSpace(fmt.Sprintf("%v", commentValue)),
		})
	}
	return result, nil
}

func (c *ClickHouseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (c *ClickHouseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (c *ClickHouseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (c *ClickHouseDB) resolveDatabaseAndTable(dbName, tableName string) (string, string, error) {
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		return "", "", localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	resolvedDB := strings.TrimSpace(dbName)
	resolvedTable := rawTable
	if parts := strings.SplitN(rawTable, ".", 2); len(parts) == 2 {
		if dbPart := normalizeClickHouseIdentifierPart(parts[0]); dbPart != "" {
			resolvedDB = dbPart
		}
		resolvedTable = normalizeClickHouseIdentifierPart(parts[1])
	} else {
		resolvedTable = normalizeClickHouseIdentifierPart(rawTable)
	}

	if resolvedDB == "" {
		resolvedDB = strings.TrimSpace(c.database)
	}
	if resolvedDB == "" {
		resolvedDB = defaultClickHouseDatabase
	}
	if resolvedTable == "" {
		return "", "", localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	return resolvedDB, resolvedTable, nil
}

func normalizeClickHouseIdentifierPart(raw string) string {
	text := strings.TrimSpace(raw)
	if len(text) >= 2 {
		first := text[0]
		last := text[len(text)-1]
		if (first == '`' && last == '`') || (first == '"' && last == '"') {
			text = text[1 : len(text)-1]
		}
	}
	return strings.TrimSpace(text)
}

func quoteClickHouseIdentifier(raw string) string {
	return "`" + strings.ReplaceAll(strings.TrimSpace(raw), "`", "``") + "`"
}

func escapeClickHouseSQLLiteral(raw string) string {
	return strings.ReplaceAll(strings.TrimSpace(raw), "'", "''")
}

func getClickHouseValueFromRow(row map[string]interface{}, keys ...string) (interface{}, bool) {
	if len(row) == 0 {
		return nil, false
	}
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return value, true
		}
	}
	for existingKey, value := range row {
		for _, key := range keys {
			if strings.EqualFold(existingKey, key) {
				return value, true
			}
		}
	}
	return nil, false
}

func isClickHouseTruthy(value interface{}) bool {
	switch val := value.(type) {
	case bool:
		return val
	case int:
		return val != 0
	case int8:
		return val != 0
	case int16:
		return val != 0
	case int32:
		return val != 0
	case int64:
		return val != 0
	case uint:
		return val != 0
	case uint8:
		return val != 0
	case uint16:
		return val != 0
	case uint32:
		return val != 0
	case uint64:
		return val != 0
	case string:
		normalized := strings.ToLower(strings.TrimSpace(val))
		return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "y"
	default:
		normalized := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", value)))
		return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "y"
	}
}

func (c *ClickHouseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if c.conn == nil && c.legacyHTTP == nil {
		return fmt.Errorf("连接未打开")
	}

	database, table, err := c.resolveDatabaseAndTable(c.database, tableName)
	if err != nil {
		return err
	}
	qualifiedTable := fmt.Sprintf("%s.%s", quoteClickHouseIdentifier(database), quoteClickHouseIdentifier(table))

	for _, pk := range changes.Deletes {
		whereExpr := buildClickHouseWhereClause(pk)
		if whereExpr == "" {
			continue
		}
		query := fmt.Sprintf("ALTER TABLE %s DELETE WHERE %s", qualifiedTable, whereExpr)
		if _, err := c.Exec(query); err != nil {
			return localizedDatabaseRuntimeError("db.backend.error.clickhouse_delete_failed_with_sql", map[string]any{
				"detail": err.Error(),
				"sql":    query,
			})
		}
	}

	for _, update := range changes.Updates {
		setExpr := buildClickHouseAssignments(update.Values)
		whereExpr := buildClickHouseWhereClause(update.Keys)
		if setExpr == "" || whereExpr == "" {
			continue
		}
		query := fmt.Sprintf("ALTER TABLE %s UPDATE %s WHERE %s", qualifiedTable, setExpr, whereExpr)
		if _, err := c.Exec(query); err != nil {
			return localizedDatabaseRuntimeError("db.backend.error.clickhouse_update_failed_with_sql", map[string]any{
				"detail": err.Error(),
				"sql":    query,
			})
		}
	}

	if err := execClickHouseInsertBatches(c.Exec, qualifiedTable, changes.Inserts); err != nil {
		return err
	}
	return nil
}

func execClickHouseInsertBatches(exec func(string) (int64, error), qualifiedTable string, rows []map[string]interface{}) error {
	if exec == nil {
		return fmt.Errorf("连接未打开")
	}
	return execLiteralInsertBatches(literalInsertConfig{
		Table:       qualifiedTable,
		Rows:        rows,
		QuoteColumn: quoteClickHouseIdentifier,
		Literal:     clickHouseLiteral,
		Exec: func(query string) (sql.Result, error) {
			affected, err := exec(query)
			return driver.RowsAffected(affected), err
		},
	})
}

func buildClickHouseInsertSQL(qualifiedTable string, row map[string]interface{}) (string, error) {
	if len(row) == 0 {
		return "", nil
	}
	cols := make([]string, 0, len(row))
	for k := range row {
		if strings.TrimSpace(k) == "" {
			continue
		}
		cols = append(cols, k)
	}
	if len(cols) == 0 {
		return "", nil
	}
	sort.Strings(cols)
	quotedCols := make([]string, 0, len(cols))
	values := make([]string, 0, len(cols))
	for _, col := range cols {
		quotedCols = append(quotedCols, quoteClickHouseIdentifier(col))
		values = append(values, clickHouseLiteral(row[col]))
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(quotedCols, ", "), strings.Join(values, ", ")), nil
}

func buildClickHouseAssignments(values map[string]interface{}) string {
	if len(values) == 0 {
		return ""
	}
	cols := make([]string, 0, len(values))
	for k := range values {
		if strings.TrimSpace(k) == "" {
			continue
		}
		cols = append(cols, k)
	}
	sort.Strings(cols)
	parts := make([]string, 0, len(cols))
	for _, col := range cols {
		parts = append(parts, fmt.Sprintf("%s = %s", quoteClickHouseIdentifier(col), clickHouseLiteral(values[col])))
	}
	return strings.Join(parts, ", ")
}

func buildClickHouseWhereClause(keys map[string]interface{}) string {
	if len(keys) == 0 {
		return ""
	}
	cols := make([]string, 0, len(keys))
	for k := range keys {
		if strings.TrimSpace(k) == "" {
			continue
		}
		cols = append(cols, k)
	}
	sort.Strings(cols)
	parts := make([]string, 0, len(cols))
	for _, col := range cols {
		parts = append(parts, fmt.Sprintf("%s = %s", quoteClickHouseIdentifier(col), clickHouseLiteral(keys[col])))
	}
	return strings.Join(parts, " AND ")
}

func clickHouseLiteral(value interface{}) string {
	switch val := value.(type) {
	case nil:
		return "NULL"
	case bool:
		if val {
			return "1"
		}
		return "0"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", val)
	case time.Time:
		return fmt.Sprintf("'%s'", val.Format("2006-01-02 15:04:05"))
	case []byte:
		return fmt.Sprintf("'%s'", strings.ReplaceAll(string(val), "'", "''"))
	default:
		return fmt.Sprintf("'%s'", strings.ReplaceAll(fmt.Sprintf("%v", val), "'", "''"))
	}
}
