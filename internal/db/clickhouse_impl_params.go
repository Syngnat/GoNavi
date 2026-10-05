//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

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
