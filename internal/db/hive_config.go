package db

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

type hiveConfig struct {
	connection.ConnectionConfig
	family       string
	transport    string
	auth         string
	httpPath     string
	principal    string
	fetchSize    int64
	pollInterval time.Duration
	params       url.Values
	session      map[string]string
	authority    string
	dialAddress  string
}

func normalizeHiveConfig(config connection.ConnectionConfig) (hiveConfig, error) {
	config, params, err := hiveConfigFromURI(config)
	if err != nil {
		return hiveConfig{}, err
	}
	extra, err := url.ParseQuery(strings.TrimLeft(strings.TrimSpace(config.ConnectionParams), "?&"))
	if err != nil {
		return hiveConfig{}, fmt.Errorf("invalid Hive connection parameters")
	}
	hiveMergeParams(params, extra)
	get := func(key string) string { return strings.TrimSpace(params.Get(strings.ToLower(key))) }
	if get("database") != "" && config.Database == "" {
		config.Database = get("database")
	}
	if get("user") != "" && config.User == "" {
		config.User = get("user")
	}
	if config.Password == "" {
		config.Password = params.Get("password")
	}
	if strings.EqualFold(get("ssl"), "true") {
		config.UseSSL = true
	}
	// Hive never silently downgrades TLS or treats "preferred" as insecure verification.
	if config.UseSSL && normalizeSSLModeValue(config.SSLMode) != sslModeSkipVerify {
		config.SSLMode = sslModeRequired
	}
	result := hiveConfig{ConnectionConfig: config, params: params, family: strings.ToLower(get("hiveFamily")), transport: strings.ToLower(get("transportMode")), auth: strings.ToUpper(get("authMode")), httpPath: get("httpPath"), principal: get("principal"), fetchSize: 1000, pollInterval: 200 * time.Millisecond, session: map[string]string{}}
	if result.family == "" {
		result.family = "hive"
	}
	if result.transport == "" {
		result.transport = "binary"
	}
	if result.httpPath == "" {
		result.httpPath = "cliservice"
	}
	if result.auth == "" {
		result.auth = strings.ToUpper(get("auth"))
		if result.auth == "" {
			result.auth = "NONE"
			if result.principal != "" {
				result.auth = "KERBEROS"
			}
		}
	}
	if result.auth == "PLAIN" {
		result.auth = "NONE"
	}
	if result.Host == "" {
		result.Host = "localhost"
	}
	if result.Database == "" {
		result.Database = "default"
	}
	if result.Port <= 0 {
		result.Port = 10000
		if result.family == "impala" {
			result.Port = 21050
			if result.transport == "http" {
				result.Port = 28000
			}
		} else if result.transport == "http" {
			result.Port = 10001
		}
	}
	result.authority = net.JoinHostPort(result.Host, strconv.Itoa(result.Port))
	if err = hiveValidateConfig(result); err != nil {
		return hiveConfig{}, err
	}
	if err = hiveIntegerParam(params, "fetchsize", 1, 10000, &result.fetchSize); err != nil {
		return hiveConfig{}, err
	}
	poll := int64(result.pollInterval / time.Millisecond)
	if err = hiveIntegerParam(params, "pollintervalms", 10, 60000, &poll); err != nil {
		return hiveConfig{}, err
	}
	result.pollInterval = time.Duration(poll) * time.Millisecond
	for key, values := range params {
		if strings.HasPrefix(key, "session.") && len(values) > 0 {
			raw := strings.TrimSpace(key[len("session."):])
			if raw != "" {
				result.session[hiveSessionConfigKey(raw)] = values[len(values)-1]
			}
		}
	}
	// HiveServer2 qualifies result columns with the table name by default (customers.id),
	// but GoNavi matches result fields against unqualified column metadata (id). Keep the
	// session default unqualified so result grids can show column types and comments.
	if _, ok := result.session["set:hiveconf:hive.resultset.use.unique.column.names"]; !ok {
		result.session["set:hiveconf:hive.resultset.use.unique.column.names"] = "false"
	}
	params.Del("auth")
	params.Del("password")
	params.Del("user")
	params.Set("authmode", result.auth)
	// Canonical public spelling avoids the generic secret-parameter key "auth".
	public := url.Values{}
	hiveMergeParams(public, params)
	public.Del("authmode")
	public.Set("authMode", result.auth)
	result.ConnectionParams = public.Encode()
	return result, nil
}

func hiveConfigFromURI(config connection.ConnectionConfig) (connection.ConnectionConfig, url.Values, error) {
	return hiveConfigFromURIWithPolicy(config, true)
}

func hiveConfigFromURIWithPolicy(config connection.ConnectionConfig, requireEndpoint bool) (connection.ConnectionConfig, url.Values, error) {
	params := url.Values{}
	raw := strings.TrimSpace(config.URI)
	if raw == "" && strings.Contains(config.Host, "://") {
		raw = config.Host
	}
	if strings.HasPrefix(strings.ToLower(raw), "jdbc:") {
		raw = raw[5:]
	}
	if raw == "" {
		return config, params, nil
	}
	endpoint, err := url.Parse(raw)
	if err != nil {
		return config, nil, fmt.Errorf("invalid Hive connection URI")
	}
	scheme := strings.ToLower(endpoint.Scheme)
	switch scheme {
	case "hive", "hive2", "http", "https":
	default:
		return config, nil, fmt.Errorf("unsupported Hive URI scheme")
	}
	if requireEndpoint && (endpoint.Hostname() == "" || strings.Contains(endpoint.Host, ",")) {
		return config, nil, fmt.Errorf("Hive requires one HiveServer2 endpoint")
	}
	config.Host = endpoint.Hostname()
	config.Port = 0
	if endpoint.Port() != "" {
		port, err := strconv.Atoi(endpoint.Port())
		if err != nil || port < 1 || port > 65535 {
			return config, nil, fmt.Errorf("invalid Hive port")
		}
		config.Port = port
	}
	if endpoint.User != nil {
		if config.User == "" {
			config.User = endpoint.User.Username()
		}
		if config.Password == "" {
			// Password() reports whether the URI actually carried a password; a bare
			// userinfo (hive2://user@host) must stay an empty, unsaved password rather
			// than an implicitly discarded value.
			if password, ok := endpoint.User.Password(); ok {
				config.Password = password
			}
		}
	}
	rawPath, semicolon, _ := strings.Cut(strings.TrimPrefix(endpoint.EscapedPath(), "/"), ";")
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return config, nil, fmt.Errorf("invalid Hive URI path")
	}
	if scheme == "http" || scheme == "https" {
		params.Set("transportmode", "http")
		params.Set("httppath", path)
		if endpoint.Port() == "" {
			config.Port = 80
			if scheme == "https" {
				config.Port = 443
			}
		}
	} else if config.Database == "" {
		config.Database = path
	}
	for _, item := range strings.Split(semicolon, ";") {
		if item == "" {
			continue
		}
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			return config, nil, fmt.Errorf("invalid Hive JDBC parameter")
		}
		decodedKey, keyErr := url.PathUnescape(key)
		decodedValue, valueErr := url.PathUnescape(value)
		if keyErr != nil || valueErr != nil {
			return config, nil, fmt.Errorf("invalid Hive JDBC parameter escape")
		}
		params.Set(strings.ToLower(decodedKey), decodedValue)
	}
	query, err := url.ParseQuery(strings.ReplaceAll(endpoint.RawQuery, ";", "&"))
	if err != nil {
		return config, nil, fmt.Errorf("invalid Hive URI parameters")
	}
	if scheme == "hive" || scheme == "hive2" {
		if err = hiveJDBCProperties(params, query, endpoint.EscapedFragment()); err != nil {
			return config, nil, err
		}
	} else {
		hiveMergeParams(params, query)
		if endpoint.Fragment != "" {
			return config, nil, fmt.Errorf("Hive HTTP endpoint fragments are not supported")
		}
	}
	if scheme == "https" {
		config.UseSSL = true
	}
	return config, params, nil
}

func hiveMergeParams(target, values url.Values) {
	for key, items := range values {
		if len(items) > 0 {
			normalized := strings.ToLower(key)
			if strings.HasPrefix(normalized, "session.") {
				normalized = "session." + key[len("session."):]
			}
			target.Set(normalized, items[len(items)-1])
		}
	}
}

// hiveSessionConfigKey maps a GoNavi session.* override to the key shape
// TOpenSessionReq.Configuration expects. HiveConf/HiveVar names need set: prefixes;
// use:database and already-prefixed set: keys are kept as-is.
func hiveSessionConfigKey(raw string) string {
	key := strings.TrimSpace(raw)
	lower := strings.ToLower(key)
	switch {
	case strings.HasPrefix(lower, "set:"), strings.HasPrefix(lower, "use:"):
		return key
	case strings.HasPrefix(lower, "hiveconf:"), strings.HasPrefix(lower, "hivevar:"):
		return "set:" + key
	default:
		return "set:hiveconf:" + key
	}
}

func hiveValidateConfig(cfg hiveConfig) error {
	switch cfg.family {
	case "hive", "spark", "impala":
	default:
		return fmt.Errorf("unsupported Hive server family")
	}
	switch cfg.transport {
	case "binary", "http":
	default:
		return fmt.Errorf("unsupported Hive transport mode")
	}
	switch cfg.auth {
	case "NOSASL", "NONE", "LDAP", "CUSTOM", "PAM", "KERBEROS":
	default:
		return fmt.Errorf("unsupported Hive authentication mode")
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return fmt.Errorf("invalid Hive port")
	}
	if cfg.UseHTTPTunnel {
		return fmt.Errorf("Hive does not support SQL-script HTTP tunnels; use HTTP transport or a CONNECT proxy")
	}
	for key := range cfg.params {
		normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
		if strings.Contains(normalized, "initfile") || normalized == "initsql" || normalized == "sessioninitstatement" {
			return fmt.Errorf("Hive automatic initialization scripts are not supported; use the audited SQL import workflow")
		}
	}
	if cfg.params.Get("servicediscoverymode") != "" {
		return fmt.Errorf("Hive ZooKeeper discovery is not supported; use a HiveServer2 endpoint")
	}
	if qop := strings.ToLower(cfg.params.Get("saslqop")); qop != "" && qop != "auth" {
		return fmt.Errorf("Hive SASL supports auth QOP only; use TLS for encryption")
	}
	if strings.ContainsAny(cfg.httpPath, "?#\r\n") || strings.HasPrefix(cfg.httpPath, "//") {
		return fmt.Errorf("invalid Hive HTTP path")
	}
	return nil
}

func hiveIntegerParam(params url.Values, key string, min, max int64, target *int64) error {
	if raw := params.Get(key); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < min || value > max {
			return fmt.Errorf("Hive %s must be between %d and %d", key, min, max)
		}
		*target = value
	}
	return nil
}
