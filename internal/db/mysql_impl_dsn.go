package db

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"

	mysql "github.com/go-sql-driver/mysql"
)

type mySQLCompatibleDSNOptions struct {
	defaultCharset         string
	defaultMultiStatements *bool
}

type mySQLCompatibleConnectPlan struct {
	label string
	dsn   string
}

const (
	mySQLCompatPlanDefaultLabel                = "默认兼容参数"
	mySQLCompatPlanDisableMultiStatementsLabel = "禁用 multiStatements 兼容重试"
)

func hasMySQLConnectionParam(config connection.ConnectionConfig, names ...string) bool {
	if len(names) == 0 {
		return false
	}

	targets := make(map[string]struct{}, len(names))
	for _, name := range names {
		normalized := strings.ToLower(strings.TrimSpace(name))
		if normalized == "" {
			continue
		}
		targets[normalized] = struct{}{}
	}
	if len(targets) == 0 {
		return false
	}

	hasMatchingKey := func(values url.Values) bool {
		for key := range values {
			if _, ok := targets[strings.ToLower(strings.TrimSpace(key))]; ok {
				return true
			}
		}
		return false
	}

	if parsed, ok := parseMySQLCompatibleURI(config.URI, mysqlCompatibleURISchemes...); ok && hasMatchingKey(parsed.Query()) {
		return true
	}
	return hasMatchingKey(mysqlConnectionParamsFromText(config.ConnectionParams))
}

func resolveMySQLTLSParam(config connection.ConnectionConfig) (string, bool, error) {
	mode := resolveMySQLTLSMode(config)
	if mode == "false" || !hasTLSCertificatePaths(config) {
		return mode, false, nil
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return "", false, err
	}
	if tlsConfig == nil {
		return mode, false, nil
	}
	name := mysqlTLSConfigName(config)
	if err := mysql.RegisterTLSConfig(name, tlsConfig); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already registered") {
		return "", false, fmt.Errorf("注册 MySQL TLS 证书配置失败：%w", err)
	}
	return name, normalizeSSLModeValue(config.SSLMode) == sslModePreferred, nil
}

func buildMySQLCompatibleDSNWithOptions(config connection.ConnectionConfig, protocol, address, database string, options mySQLCompatibleDSNOptions) (string, error) {
	timeout := getConnectTimeoutSeconds(config)
	tlsMode, allowFallbackToPlaintext, err := resolveMySQLTLSParam(config)
	if err != nil {
		return "", err
	}
	params := url.Values{}
	defaultCharset := strings.TrimSpace(options.defaultCharset)
	if defaultCharset == "" {
		defaultCharset = "utf8mb4,utf8"
	}
	params.Set("charset", defaultCharset)
	params.Set("parseTime", "True")
	params.Set("loc", "Local")
	params.Set("timeout", fmt.Sprintf("%ds", timeout))
	params.Set("tls", tlsMode)
	if allowFallbackToPlaintext {
		params.Set("allowFallbackToPlaintext", "true")
	}
	defaultMultiStatements := true
	if options.defaultMultiStatements != nil {
		defaultMultiStatements = *options.defaultMultiStatements
	}
	params.Set("multiStatements", strconv.FormatBool(defaultMultiStatements))
	if parsed, ok := parseMySQLCompatibleURI(config.URI, mysqlCompatibleURISchemes...); ok {
		mergeMySQLConnectionParams(params, parsed.Query())
	}
	mergeMySQLConnectionParams(params, mysqlConnectionParamsFromText(config.ConnectionParams))
	encodedParams := encodeMySQLDSNQuery(params)
	return fmt.Sprintf(
		"%s:%s@%s(%s)/%s?%s",
		config.User, config.Password, protocol, address, database, encodedParams,
	), nil
}

func encodeMySQLDSNQuery(params url.Values) string {
	if len(params) == 0 {
		return ""
	}

	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var builder strings.Builder
	for _, key := range keys {
		escapedKey := url.QueryEscape(key)
		values := params[key]
		for _, value := range values {
			if builder.Len() > 0 {
				builder.WriteByte('&')
			}
			builder.WriteString(escapedKey)
			builder.WriteByte('=')
			escapedValue := url.QueryEscape(value)
			if strings.EqualFold(strings.TrimSpace(key), "charset") {
				escapedValue = strings.ReplaceAll(escapedValue, "%2C", ",")
				escapedValue = strings.ReplaceAll(escapedValue, "%2c", ",")
			}
			builder.WriteString(escapedValue)
		}
	}

	return builder.String()
}

func buildMySQLCompatibleDSN(config connection.ConnectionConfig, protocol, address, database string) (string, error) {
	defaultMultiStatements := true
	return buildMySQLCompatibleDSNWithOptions(config, protocol, address, database, mySQLCompatibleDSNOptions{
		defaultCharset:         "utf8mb4,utf8",
		defaultMultiStatements: &defaultMultiStatements,
	})
}

func buildMySQLCompatibleConnectPlans(config connection.ConnectionConfig, protocol, address, database string) ([]mySQLCompatibleConnectPlan, error) {
	defaultDSN, err := buildMySQLCompatibleDSN(config, protocol, address, database)
	if err != nil {
		return nil, err
	}
	plans := []mySQLCompatibleConnectPlan{{
		label: mySQLCompatPlanDefaultLabel,
		dsn:   defaultDSN,
	}}

	if hasMySQLConnectionParam(config, "multiStatements", "allowMultiQueries") {
		return plans, nil
	}

	disabled := false
	fallbackDSN, err := buildMySQLCompatibleDSNWithOptions(config, protocol, address, database, mySQLCompatibleDSNOptions{
		defaultCharset:         "utf8mb4,utf8",
		defaultMultiStatements: &disabled,
	})
	if err != nil {
		return nil, err
	}
	if fallbackDSN == defaultDSN {
		return plans, nil
	}

	return append(plans, mySQLCompatibleConnectPlan{
		label: mySQLCompatPlanDisableMultiStatementsLabel,
		dsn:   fallbackDSN,
	}), nil
}

func mysqlDSNSupportsBatchWrites(dsn string) bool {
	parsed, err := mysql.ParseDSN(dsn)
	return err == nil && parsed.MultiStatements
}

func normalizeMySQLRawDSNCompatibilityParams(raw string) string {
	text := strings.TrimSpace(raw)
	queryIndex := strings.Index(text, "?")
	if text == "" || queryIndex < 0 {
		return raw
	}

	prefix := text[:queryIndex]
	queryText := text[queryIndex+1:]
	suffix := ""
	if fragmentIndex := strings.Index(queryText, "#"); fragmentIndex >= 0 {
		suffix = queryText[fragmentIndex:]
		queryText = queryText[:fragmentIndex]
	}
	values, err := url.ParseQuery(queryText)
	if err != nil {
		return raw
	}

	changed := false
	explicitMultiStatements := ""
	hasExplicitMultiStatements := false
	allowMultiQueries := ""
	hasAllowMultiQueries := false

	for key, items := range values {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "multistatements":
			delete(values, key)
			changed = true
			for _, item := range items {
				if enabled, ok := parseMySQLBoolParam(item); ok {
					explicitMultiStatements = strconv.FormatBool(enabled)
					hasExplicitMultiStatements = true
				}
			}
		case "allowmultiqueries":
			delete(values, key)
			changed = true
			for _, item := range items {
				if enabled, ok := parseMySQLBoolParam(item); ok {
					allowMultiQueries = strconv.FormatBool(enabled)
					hasAllowMultiQueries = true
				}
			}
		}
	}

	if hasExplicitMultiStatements {
		values.Set("multiStatements", explicitMultiStatements)
	} else if hasAllowMultiQueries {
		values.Set("multiStatements", allowMultiQueries)
	}

	if !changed {
		return raw
	}
	encoded := encodeMySQLDSNQuery(values)
	if encoded == "" {
		return prefix + suffix
	}
	return prefix + "?" + encoded + suffix
}

func parseHostPortWithDefault(raw string, defaultPort int) (string, int, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", 0, false
	}

	if strings.HasPrefix(text, "[") {
		end := strings.Index(text, "]")
		if end < 0 {
			return text, defaultPort, true
		}
		host := text[1:end]
		portText := strings.TrimSpace(text[end+1:])
		if strings.HasPrefix(portText, ":") {
			if p, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(portText, ":"))); err == nil && p > 0 {
				return host, p, true
			}
		}
		return host, defaultPort, true
	}

	lastColon := strings.LastIndex(text, ":")
	if lastColon > 0 && strings.Count(text, ":") == 1 {
		host := strings.TrimSpace(text[:lastColon])
		portText := strings.TrimSpace(text[lastColon+1:])
		if host != "" {
			if p, err := strconv.Atoi(portText); err == nil && p > 0 {
				return host, p, true
			}
			return host, defaultPort, true
		}
	}

	return text, defaultPort, true
}

func normalizeMySQLAddress(host string, port int) string {
	h := strings.TrimSpace(host)
	if h == "" {
		h = "localhost"
	}
	p := port
	if p <= 0 {
		p = defaultMySQLPort
	}
	return fmt.Sprintf("%s:%d", h, p)
}

var mysqlDatabaseQueries = []string{
	"SHOW DATABASES",
	"SELECT DATABASE() AS `Database`",
	"SELECT schema_name AS database_name FROM information_schema.schemata ORDER BY schema_name",
}

var mysqlDatabaseNameKeys = []string{
	"Database",
	"database",
	"DATABASE",
	"database_name",
	"DATABASE_NAME",
	"schema",
	"SCHEMA",
	"schema_name",
	"SCHEMA_NAME",
}
