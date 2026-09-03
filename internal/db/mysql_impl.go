package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	mysql "github.com/go-sql-driver/mysql"
)

type MySQLDB struct {
	conn                *sql.DB
	pingTimeout         time.Duration
	batchWritesEnabled  bool
	sshNetworkRegistrar func(connection.SSHConfig) (string, error)
}

var _ BatchApplierContext = (*MySQLDB)(nil)

const (
	defaultMySQLPort            = 3306
	defaultGoldenDBPort         = 1523
	defaultMySQLInsertBatchSize = 1000
	maxMySQLInsertBatchArgs     = 60000
)

var mysqlCompatibleURISchemes = []string{
	"mysql",
	"mariadb",
	"doris",
	"diros",
	"oceanbase",
	"starrocks",
	"goldendb",
	"greatdb",
	"gdb",
}

func parseMySQLCompatibleURI(raw string, allowedSchemes ...string) (*url.URL, bool) {
	return parseConnectionURI(raw, allowedSchemes...)
}

func resolveMySQLCompatibleDefaultPort(config connection.ConnectionConfig) int {
	if config.Port > 0 {
		return config.Port
	}
	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "goldendb", "greatdb", "gdb":
		return defaultGoldenDBPort
	default:
		return defaultMySQLPort
	}
}

func mysqlConnectionParamsFromText(raw string) url.Values {
	return connectionParamsFromText(raw)
}

func parseMySQLBoolParam(raw string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	default:
		return false, false
	}
}

func normalizeMySQLDurationParam(raw string, unit time.Duration) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return text
	}
	if n, err := strconv.Atoi(text); err == nil && n >= 0 {
		return (time.Duration(n) * unit).String()
	}
	return text
}

func normalizeMySQLCharsetParam(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	lower := strings.ToLower(text)
	switch lower {
	case "utf-8", "utf_8", "unicode":
		return "utf8mb4"
	case "utf8", "utf8mb4", "latin1", "gbk", "gb2312", "gb18030", "big5", "sjis", "cp932":
		return lower
	case "iso-8859-1", "iso8859-1", "iso88591":
		return "latin1"
	default:
		return text
	}
}

func normalizeMySQLServerTimezoneParam(raw string) (string, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", false
	}
	compact := strings.ToUpper(strings.ReplaceAll(text, " ", ""))
	switch compact {
	case "LOCAL":
		return "Local", true
	case "UTC", "Z", "GMT", "GMT+0", "GMT-0", "GMT+00", "GMT-00", "GMT+00:00", "GMT-00:00",
		"UTC+0", "UTC-0", "UTC+00", "UTC-00", "UTC+00:00", "UTC-00:00":
		return "UTC", true
	case "GMT+8", "GMT+08", "GMT+08:00", "UTC+8", "UTC+08", "UTC+08:00",
		"ASIA/SHANGHAI", "PRC", "CTT":
		return "Asia/Shanghai", true
	}
	if strings.Contains(text, "/") {
		if _, err := time.LoadLocation(text); err == nil {
			return text, true
		}
	}
	return "", false
}

var mysqlSupportedDriverParamNames = map[string]string{
	"allowallfiles":            "allowAllFiles",
	"allowcleartextpasswords":  "allowCleartextPasswords",
	"allowfallbacktoplaintext": "allowFallbackToPlaintext",
	"allownativepasswords":     "allowNativePasswords",
	"allowoldpasswords":        "allowOldPasswords",
	"checkconnliveness":        "checkConnLiveness",
	"clientfoundrows":          "clientFoundRows",
	"charset":                  "charset",
	"collation":                "collation",
	"columnswithalias":         "columnsWithAlias",
	"compress":                 "compress",
	// connectionAttributes 透传 mysql CLIENT_CONNECT_ATTRS（key1:value1,key2:value2 格式）。
	// OceanBase Oracle 租户 MySQL wire 路径用它注入 OBClient 私有 capability attribute；
	// 普通 mysql/mariadb 用户也能在此声明 program_name 等元数据。
	"connectionattributes": "connectionAttributes",
	"interpolateparams":    "interpolateParams",
	"loc":                  "loc",
	"maxallowedpacket":     "maxAllowedPacket",
	"multistatements":      "multiStatements",
	"parsetime":            "parseTime",
	"readtimeout":          "readTimeout",
	"rejectreadonly":       "rejectReadOnly",
	"serverpubkey":         "serverPubKey",
	"sql_mode":             "sql_mode",
	"timetruncate":         "timeTruncate",
	"timeout":              "timeout",
	"tls":                  "tls",
	"writetimeout":         "writeTimeout",
}

var mysqlBoolDriverParamNames = map[string]struct{}{
	"allowAllFiles":            {},
	"allowCleartextPasswords":  {},
	"allowFallbackToPlaintext": {},
	"allowNativePasswords":     {},
	"allowOldPasswords":        {},
	"checkConnLiveness":        {},
	"clientFoundRows":          {},
	"columnsWithAlias":         {},
	"compress":                 {},
	"interpolateParams":        {},
	"multiStatements":          {},
	"parseTime":                {},
	"rejectReadOnly":           {},
}

func canonicalMySQLDriverParamName(name string) (string, bool) {
	canonical, ok := mysqlSupportedDriverParamNames[strings.ToLower(strings.TrimSpace(name))]
	return canonical, ok
}

func setMySQLDriverParam(params url.Values, name string, value string) {
	switch name {
	case "charset":
		if charset := normalizeMySQLCharsetParam(value); charset != "" {
			params.Set("charset", charset)
		}
	case "timeout", "readTimeout", "writeTimeout", "timeTruncate":
		params.Set(name, normalizeMySQLDurationParam(value, time.Second))
	default:
		if _, ok := mysqlBoolDriverParamNames[name]; ok {
			if enabled, ok := parseMySQLBoolParam(value); ok {
				params.Set(name, strconv.FormatBool(enabled))
				return
			}
		}
		params.Set(name, value)
	}
}

func mergeMySQLConnectionParam(params url.Values, key string, value string) {
	name := strings.TrimSpace(key)
	if name == "" {
		return
	}
	lowerName := strings.ToLower(name)
	switch lowerName {
	case "topology":
		return
	case "useunicode", "autoreconnect", "useoldaliasmetadatabehavior", "allowpublickeyretrieval":
		return
	case "characterencoding":
		if charset := normalizeMySQLCharsetParam(value); charset != "" {
			params.Set("charset", charset)
		}
		return
	case "servertimezone":
		if loc, ok := normalizeMySQLServerTimezoneParam(value); ok {
			params.Set("loc", loc)
		}
		return
	case "usessl":
		if enabled, ok := parseMySQLBoolParam(value); ok {
			if enabled {
				params.Set("tls", "true")
			} else {
				params.Set("tls", "false")
			}
		}
		return
	case "verifyservercertificate":
		if verified, ok := parseMySQLBoolParam(value); ok && !verified && params.Get("tls") != "false" {
			params.Set("tls", "skip-verify")
		}
		return
	case "trustservercertificate":
		if trusted, ok := parseMySQLBoolParam(value); ok && trusted && params.Get("tls") != "false" {
			params.Set("tls", "skip-verify")
		}
		return
	case "sslmode":
		switch normalizeSSLModeValue(value) {
		case sslModeDisable:
			params.Set("tls", "false")
		case sslModeRequired:
			params.Set("tls", "true")
		case sslModeSkipVerify:
			params.Set("tls", "skip-verify")
		default:
			params.Set("tls", "preferred")
		}
		return
	case "connecttimeout":
		params.Set("timeout", normalizeMySQLDurationParam(value, time.Millisecond))
		return
	case "sockettimeout":
		params.Set("readTimeout", normalizeMySQLDurationParam(value, time.Millisecond))
		return
	case "allowmultiqueries":
		if enabled, ok := parseMySQLBoolParam(value); ok {
			params.Set("multiStatements", strconv.FormatBool(enabled))
		}
		return
	case "usecompression":
		if enabled, ok := parseMySQLBoolParam(value); ok {
			params.Set("compress", strconv.FormatBool(enabled))
		}
		return
	case "connectioncollation":
		params.Set("collation", value)
		return
	default:
		if canonical, ok := canonicalMySQLDriverParamName(name); ok {
			setMySQLDriverParam(params, canonical, value)
		}
	}
}

func mergeMySQLConnectionParams(params url.Values, values url.Values) {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		lowerName := strings.ToLower(strings.TrimSpace(key))
		if lowerName == "verifyservercertificate" || lowerName == "trustservercertificate" {
			continue
		}
		for _, value := range values[key] {
			mergeMySQLConnectionParam(params, key, value)
		}
	}
	for _, key := range keys {
		lowerName := strings.ToLower(strings.TrimSpace(key))
		if lowerName != "verifyservercertificate" && lowerName != "trustservercertificate" {
			continue
		}
		for _, value := range values[key] {
			mergeMySQLConnectionParam(params, key, value)
		}
	}
}

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

func collectMySQLDatabaseNames(queryFn func(string) ([]map[string]interface{}, []string, error)) ([]string, error) {
	if queryFn == nil {
		return nil, fmt.Errorf("查询函数为空")
	}

	names := make([]string, 0, 8)
	seen := make(map[string]struct{}, 8)
	var lastErr error

	normalizeName := func(val interface{}) string {
		if val == nil {
			return ""
		}
		name := strings.TrimSpace(fmt.Sprintf("%v", val))
		if name == "" || strings.EqualFold(name, "<nil>") || strings.EqualFold(name, "null") {
			return ""
		}
		return name
	}

	extractName := func(row map[string]interface{}, columns []string) string {
		for _, key := range mysqlDatabaseNameKeys {
			if name := normalizeName(row[key]); name != "" {
				return name
			}
		}
		for _, column := range columns {
			if name := normalizeName(row[column]); name != "" {
				return name
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				if name := normalizeName(val); name != "" {
					return name
				}
			}
		}
		return ""
	}

	appendNames := func(rows []map[string]interface{}, columns []string) {
		for _, row := range rows {
			name := extractName(row, columns)
			if name == "" {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			names = append(names, name)
		}
	}

	for _, sqlText := range mysqlDatabaseQueries {
		rows, columns, err := queryFn(sqlText)
		if err != nil {
			lastErr = err
			continue
		}
		appendNames(rows, columns)
		if len(names) > 0 {
			return names, nil
		}
	}

	if len(names) > 0 {
		return names, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("未获取到可用数据库")
}

func applyMySQLURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, ok := parseMySQLCompatibleURI(uriText, mysqlCompatibleURISchemes...)
	if !ok {
		return config
	}

	if parsed.User != nil {
		if config.User == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}

	if dbName := strings.TrimPrefix(parsed.Path, "/"); dbName != "" && config.Database == "" {
		config.Database = dbName
	}

	defaultPort := resolveMySQLCompatibleDefaultPort(config)

	hostsFromURI := make([]string, 0, 4)
	hostText := strings.TrimSpace(parsed.Host)
	if hostText != "" {
		for _, entry := range strings.Split(hostText, ",") {
			host, port, ok := parseHostPortWithDefault(entry, defaultPort)
			if !ok {
				continue
			}
			hostsFromURI = append(hostsFromURI, normalizeMySQLAddress(host, port))
		}
	}

	if len(config.Hosts) == 0 && len(hostsFromURI) > 0 {
		config.Hosts = hostsFromURI
	}
	if strings.TrimSpace(config.Host) == "" && len(hostsFromURI) > 0 {
		host, port, ok := parseHostPortWithDefault(hostsFromURI[0], defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}

	if config.Topology == "" {
		topology := strings.TrimSpace(parsed.Query().Get("topology"))
		if topology != "" {
			config.Topology = strings.ToLower(topology)
		}
	}

	return config
}

func collectMySQLAddresses(config connection.ConnectionConfig) []string {
	defaultPort := resolveMySQLCompatibleDefaultPort(config)

	candidates := make([]string, 0, len(config.Hosts)+1)
	if len(config.Hosts) > 0 {
		candidates = append(candidates, config.Hosts...)
	} else {
		candidates = append(candidates, normalizeMySQLAddress(config.Host, defaultPort))
	}

	result := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, entry := range candidates {
		host, port, ok := parseHostPortWithDefault(entry, defaultPort)
		if !ok {
			continue
		}
		normalized := normalizeMySQLAddress(host, port)
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func (m *MySQLDB) resolveProtocolAndAddress(config connection.ConnectionConfig) (string, string, error) {
	protocol := "tcp"
	address := normalizeMySQLAddress(config.Host, config.Port)

	if config.UseSSH {
		netName, err := m.registerSSHNetwork(config.SSH)
		if err != nil {
			return "", "", fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		protocol = netName
	}

	return protocol, address, nil
}

func (m *MySQLDB) registerSSHNetwork(config connection.SSHConfig) (string, error) {
	if m != nil && m.sshNetworkRegistrar != nil {
		return m.sshNetworkRegistrar(config)
	}
	return ssh.RegisterSSHNetwork(config)
}

func (m *MySQLDB) getDSN(config connection.ConnectionConfig) (string, error) {
	protocol, address, err := m.resolveProtocolAndAddress(config)
	if err != nil {
		return "", err
	}
	return buildMySQLCompatibleDSN(config, protocol, address, config.Database)
}

func resolveMySQLCredential(config connection.ConnectionConfig, addressIndex int) (string, string) {
	primaryUser := strings.TrimSpace(config.User)
	primaryPassword := config.Password
	replicaUser := strings.TrimSpace(config.MySQLReplicaUser)
	replicaPassword := config.MySQLReplicaPassword

	if addressIndex > 0 && replicaUser != "" {
		return replicaUser, replicaPassword
	}

	if primaryUser == "" && replicaUser != "" {
		return replicaUser, replicaPassword
	}

	return config.User, primaryPassword
}

func (m *MySQLDB) Connect(config connection.ConnectionConfig) error {
	m.batchWritesEnabled = false
	runConfig := applyMySQLURI(config)
	addresses := collectMySQLAddresses(runConfig)
	if len(addresses) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 MySQL 地址")
	}
	defaultPort := resolveMySQLCompatibleDefaultPort(runConfig)

	var errorDetails []string
	for index, address := range addresses {
		candidateConfig := runConfig
		host, port, ok := parseHostPortWithDefault(address, defaultPort)
		if !ok {
			continue
		}
		candidateConfig.Host = host
		candidateConfig.Port = port
		candidateConfig.User, candidateConfig.Password = resolveMySQLCredential(runConfig, index)

		protocol, address, err := m.resolveProtocolAndAddress(candidateConfig)
		if err != nil {
			if _, requiresTrust := ssh.HostKeyTrustStatusFromError(err); requiresTrust {
				return fmt.Errorf("MySQL %s 创建 SSH 隧道失败: %w", address, err)
			}
			errorDetails = append(errorDetails, fmt.Sprintf("%s 生成连接串失败: %v", address, err))
			continue
		}
		plans, err := buildMySQLCompatibleConnectPlans(candidateConfig, protocol, address, candidateConfig.Database)
		if err != nil {
			errorDetails = append(errorDetails, fmt.Sprintf("%s 生成连接串失败: %v", address, err))
			continue
		}

		for _, plan := range plans {
			db, err := sql.Open("mysql", plan.dsn)
			if err != nil {
				if len(plans) > 1 || plan.label != mySQLCompatPlanDefaultLabel {
					errorDetails = append(errorDetails, fmt.Sprintf("%s [%s] 打开失败: %v", address, plan.label, err))
				} else {
					errorDetails = append(errorDetails, fmt.Sprintf("%s 打开失败: %v", address, err))
				}
				continue
			}
			configureSQLConnectionPool(db, candidateConfig.Type)

			timeout := getConnectTimeout(candidateConfig)
			ctx, cancel := utils.ContextWithTimeout(timeout)
			pingErr := db.PingContext(ctx)
			cancel()
			if pingErr != nil {
				_ = db.Close()
				if len(plans) > 1 || plan.label != mySQLCompatPlanDefaultLabel {
					errorDetails = append(errorDetails, fmt.Sprintf("%s [%s] 验证失败: %v", address, plan.label, pingErr))
				} else {
					errorDetails = append(errorDetails, fmt.Sprintf("%s 验证失败: %v", address, pingErr))
				}
				continue
			}

			if plan.label != mySQLCompatPlanDefaultLabel {
				logger.Warnf("MySQL 兼容回退生效：地址=%s 模式=%s", address, plan.label)
			}

			m.conn = db
			m.pingTimeout = timeout
			m.batchWritesEnabled = mysqlDSNSupportsBatchWrites(plan.dsn)
			return nil
		}
	}

	if len(errorDetails) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 MySQL 地址")
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(errorDetails, "；"))
}

func (m *MySQLDB) SupportsBatchWrites() bool {
	return m != nil && m.batchWritesEnabled
}

func (m *MySQLDB) Close() error {
	if m.conn != nil {
		return m.conn.Close()
	}
	return nil
}

func (m *MySQLDB) Ping() error {
	if m.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return m.conn.PingContext(ctx)
}

func (m *MySQLDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := m.conn.QueryContext(metadataContextFor(m), query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialect(rows, "mysql")
}

func (m *MySQLDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := m.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialect(rows, "mysql")
}

func (m *MySQLDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := m.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRowsForDialect(rows, "mysql")
}

func (m *MySQLDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := m.conn.QueryContext(metadataContextFor(m), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, "mysql")
}

func (m *MySQLDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := m.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	// 必须与 QueryContext 的扫描方言一致（mysql_impl.go:938 用 "mysql"）。
	// 传空串会让 scanDialect 退化，DATE 列在会话路径（流式导出、SQL 编辑器托管事务）
	// 被格式化成 RFC3339 时间戳，与网格直查的 2006-01-02 不一致，导出文件再导入 DATE 列会被拒绝。
	return NewSQLConnStatementExecerWithDialect(conn, "mysql"), nil
}

func (m *MySQLDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) Exec(query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) GetDatabases() ([]string, error) {
	return collectMySQLDatabaseNames(m.Query)
}

func (m *MySQLDB) GetTables(dbName string) ([]string, error) {
	query := "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
	if dbName != "" {
		query = fmt.Sprintf(
			"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = '%s' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
			strings.ReplaceAll(dbName, "'", "''"),
		)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	tables := make([]string, 0, len(data))
	for _, row := range data {
		for _, v := range row {
			tables = append(tables, fmt.Sprintf("%v", v))
			break
		}
	}
	return resolveShardingSphereLogicalTables(dedupeExactTableMetadataNames(tables), m.Query), nil
}

func dedupeExactTableMetadataNames(tables []string) []string {
	if len(tables) == 0 {
		return tables
	}
	seen := make(map[string]struct{}, len(tables))
	result := make([]string, 0, len(tables))
	for _, table := range tables {
		if strings.TrimSpace(table) == "" {
			continue
		}
		if _, exists := seen[table]; exists {
			continue
		}
		seen[table] = struct{}{}
		result = append(result, table)
	}
	return result
}

func normalizeMySQLIdentifierPart(ident string) string {
	value := strings.TrimSpace(ident)
	for i := 0; i < 4; i++ {
		next := normalizeSQLIdentPartWithBracketMode(value, false, false)
		if next == value {
			break
		}
		value = next
	}
	if len(value) >= 2 {
		first := value[0]
		last := value[len(value)-1]
		switch {
		case first == '\'' && last == '\'':
			return strings.TrimSpace(strings.ReplaceAll(value[1:len(value)-1], `''`, `'`))
		case (first == '\'' && last == '"') || (first == '"' && last == '\''):
			return strings.TrimSpace(value[1 : len(value)-1])
		}
	}
	return strings.TrimSpace(value)
}

func quoteMySQLIdentifier(ident string) string {
	return "`" + strings.ReplaceAll(normalizeMySQLIdentifierPart(ident), "`", "``") + "`"
}

func mysqlMetadataTableParts(dbName, tableName string) (string, string) {
	schema := normalizeMySQLIdentifierPart(dbName)
	table := strings.TrimSpace(tableName)
	if parsedSchema, parsedTable := SplitSQLQualifiedNamePreserveTableQuoteForDialect(table, "mysql"); parsedTable != "" {
		if parsedSchema != "" {
			schema = normalizeMySQLIdentifierPart(parsedSchema)
		}
		table = normalizeMySQLIdentifierPart(parsedTable)
	} else {
		table = normalizeMySQLIdentifierPart(table)
	}
	return schema, table
}

func mysqlQualifiedTableIdentifier(dbName, tableName string) string {
	schema, table := mysqlMetadataTableParts(dbName, tableName)
	if schema != "" {
		return quoteMySQLIdentifier(schema) + "." + quoteMySQLIdentifier(table)
	}
	return quoteMySQLIdentifier(table)
}

func buildMySQLShowCreateTableQuery(dbName, tableName string) string {
	return "SHOW CREATE TABLE " + mysqlQualifiedTableIdentifier(dbName, tableName)
}

func buildMySQLShowFullColumnsQuery(dbName, tableName string) string {
	return "SHOW FULL COLUMNS FROM " + mysqlQualifiedTableIdentifier(dbName, tableName)
}

func buildMySQLShowIndexQuery(dbName, tableName string) string {
	return "SHOW INDEX FROM " + mysqlQualifiedTableIdentifier(dbName, tableName)
}

func buildMySQLForeignKeysQuery() string {
	return `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
              FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`
}

func buildMySQLShowTriggersQuery(dbName string) string {
	schema := normalizeMySQLIdentifierPart(dbName)
	query := "SHOW TRIGGERS"
	if schema != "" {
		query += " FROM " + quoteMySQLIdentifier(schema)
	}
	return query + " WHERE `Table` = ?"
}

func queryMetadataRowsWithArgs(conn *sql.DB, ctx context.Context, dialect, query string, args ...interface{}) ([]map[string]interface{}, []string, error) {
	if conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := conn.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, dialect)
}

func (m *MySQLDB) GetCreateStatement(dbName, tableName string) (string, error) {
	data, _, err := m.Query(buildMySQLShowCreateTableQuery(dbName, tableName))
	if err != nil {
		return "", err
	}

	if len(data) > 0 {
		if val, ok := data[0]["Create Table"]; ok {
			return fmt.Sprintf("%v", val), nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func buildMySQLColumnDefinition(row map[string]interface{}) connection.ColumnDefinition {
	col := connection.ColumnDefinition{
		Name:     fmt.Sprintf("%v", row["Field"]),
		Type:     fmt.Sprintf("%v", row["Type"]),
		Nullable: fmt.Sprintf("%v", row["Null"]),
		Key:      fmt.Sprintf("%v", row["Key"]),
		Extra:    fmt.Sprintf("%v", row["Extra"]),
		Comment:  fmt.Sprintf("%v", row["Comment"]),
	}

	if row["Default"] != nil {
		defaultValue := fmt.Sprintf("%v", row["Default"])
		col.Default = &defaultValue
		col.HasDefault = true
	}
	if row["Collation"] != nil {
		col.Collation = fmt.Sprintf("%v", row["Collation"])
		if separator := strings.IndexByte(col.Collation, '_'); separator > 0 {
			col.Charset = col.Collation[:separator]
		}
	}

	return col
}

func (m *MySQLDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	data, _, err := m.Query(buildMySQLShowFullColumnsQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		columns = append(columns, buildMySQLColumnDefinition(row))
	}
	return columns, nil
}

func (m *MySQLDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	data, _, err := m.Query(buildMySQLShowIndexQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		nonUnique := 0
		if val, ok := row["Non_unique"]; ok {
			if f, ok := val.(float64); ok {
				nonUnique = int(f)
			} else if i, ok := val.(int64); ok {
				nonUnique = int(i)
			}
		}

		seq := 0
		if val, ok := row["Seq_in_index"]; ok {
			if f, ok := val.(float64); ok {
				seq = int(f)
			} else if i, ok := val.(int64); ok {
				seq = int(i)
			}
		}

		subPart := 0
		if val, ok := row["Sub_part"]; ok && val != nil {
			if f, ok := val.(float64); ok {
				subPart = int(f)
			} else if i, ok := val.(int64); ok {
				subPart = int(i)
			}
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["Key_name"]),
			ColumnName: fmt.Sprintf("%v", row["Column_name"]),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  fmt.Sprintf("%v", row["Index_type"]),
			SubPart:    subPart,
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (m *MySQLDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema, table := mysqlMetadataTableParts(dbName, tableName)
	data, _, err := queryMetadataRowsWithArgs(m.conn, metadataContextFor(m), "mysql", buildMySQLForeignKeysQuery(), schema, table)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
			ColumnName:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			RefTableName:   fmt.Sprintf("%v", row["REFERENCED_TABLE_NAME"]),
			RefColumnName:  fmt.Sprintf("%v", row["REFERENCED_COLUMN_NAME"]),
			ConstraintName: fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (m *MySQLDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	schema, table := mysqlMetadataTableParts(dbName, tableName)
	data, _, err := queryMetadataRowsWithArgs(m.conn, metadataContextFor(m), "mysql", buildMySQLShowTriggersQuery(schema), table)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["Trigger"]),
			Timing:    fmt.Sprintf("%v", row["Timing"]),
			Event:     fmt.Sprintf("%v", row["Event"]),
			Statement: fmt.Sprintf("%v", row["Statement"]),
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (m *MySQLDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return m.ApplyChangesContext(context.Background(), tableName, changes)
}

func (m *MySQLDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if m.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	columnTypeMap := m.loadColumnTypeMapContext(ctx, tableName)

	tx, err := m.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		for k, v := range pk {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLValueForWrite(k, v, columnTypeMap))
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM `%s` WHERE %s", tableName, strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, fmt.Errorf("删除失败：%w", err))
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}

		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLValueForWrite(k, v, columnTypeMap))
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLValueForWrite(k, v, columnTypeMap))
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE `%s` SET %s WHERE %s", tableName, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, fmt.Errorf("更新失败：%w", err))
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	if err := m.applyInsertChangesContext(ctx, tx, tableName, changes.Inserts, columnTypeMap); err != nil {
		return err
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}

func (m *MySQLDB) applyInsertChangesContext(ctx context.Context, tx *sql.Tx, tableName string, rows []map[string]interface{}, columnTypeMap map[string]string) error {
	var unknownWriteErr error
	err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table: fmt.Sprintf("`%s`", escapeMySQLBacktickIdent(tableName)),
		Rows:  rows,
		QuoteColumn: func(column string) string {
			return fmt.Sprintf("`%s`", escapeMySQLBacktickIdent(column))
		},
		Placeholder: func(int) string { return "?" },
		Value: func(column string, value interface{}) (interface{}, bool) {
			return normalizeMySQLValueForInsert(column, value, columnTypeMap)
		},
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			result, err := tx.ExecContext(ctx, query, args...)
			err = markWriteOutcomeUnknownIfAmbiguous(ctx, err)
			if IsWriteOutcomeUnknown(err) {
				unknownWriteErr = err
			}
			return result, err
		},
		MaxRows:         defaultMySQLInsertBatchSize,
		MaxArgs:         maxMySQLInsertBatchArgs,
		RequireAffected: true,
		EmptyInsertSQL: func(table string) string {
			return fmt.Sprintf("INSERT INTO %s () VALUES ()", table)
		},
	})
	if err != nil && unknownWriteErr != nil {
		return fmt.Errorf("%s: %w", err.Error(), unknownWriteErr)
	}
	return err
}

func escapeMySQLBacktickIdent(ident string) string {
	return strings.ReplaceAll(strings.TrimSpace(ident), "`", "``")
}

func normalizeMySQLComplexValue(value interface{}) interface{} {
	switch v := value.(type) {
	case map[string]interface{}, []interface{}:
		if data, err := json.Marshal(v); err == nil {
			return string(data)
		}
		return fmt.Sprintf("%v", value)
	default:
		return value
	}
}

func normalizeMySQLDateTimeValue(value interface{}) interface{} {
	text, ok := value.(string)
	if !ok {
		return value
	}
	raw := strings.TrimSpace(text)
	if raw == "" {
		return value
	}

	cleaned := strings.ReplaceAll(raw, "+ ", "+")
	cleaned = strings.ReplaceAll(cleaned, "- ", "-")

	if len(cleaned) >= 19 && cleaned[10] == 'T' {
		if strings.HasSuffix(cleaned, "Z") || hasTimezoneOffset(cleaned) {
			if t, err := time.Parse(time.RFC3339Nano, cleaned); err == nil {
				return formatMySQLDateTime(t)
			}
			if t, err := time.Parse(time.RFC3339, cleaned); err == nil {
				return formatMySQLDateTime(t)
			}
		}
		return strings.Replace(cleaned, "T", " ", 1)
	}

	if strings.Contains(cleaned, " ") && (strings.HasSuffix(cleaned, "Z") || hasTimezoneOffset(cleaned)) {
		candidate := strings.Replace(cleaned, " ", "T", 1)
		if t, err := time.Parse(time.RFC3339Nano, candidate); err == nil {
			return formatMySQLDateTime(t)
		}
		if t, err := time.Parse(time.RFC3339, candidate); err == nil {
			return formatMySQLDateTime(t)
		}
	}

	return value
}

func (m *MySQLDB) loadColumnTypeMapContext(ctx context.Context, tableName string) map[string]string {
	result := map[string]string{}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return result
	}

	data, _, err := m.QueryContext(ctx, buildMySQLShowFullColumnsQuery("", table))
	if err != nil {
		logger.Warnf("加载列元数据失败（不影响提交）：表=%s err=%v", table, err)
		return result
	}

	for _, row := range data {
		col := buildMySQLColumnDefinition(row)
		name := strings.ToLower(strings.TrimSpace(col.Name))
		if name == "" {
			continue
		}
		result[name] = strings.TrimSpace(col.Type)
	}
	return result
}

func normalizeMySQLValueForInsert(columnName string, value interface{}, columnTypeMap map[string]string) (interface{}, bool) {
	columnType := strings.ToLower(strings.TrimSpace(columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]))
	if isMySQLBitColumnType(columnType) {
		return normalizeMySQLBitValue(value), false
	}
	if !isMySQLTemporalColumnType(columnType) {
		return normalizeMySQLComplexValue(value), false
	}
	text, ok := value.(string)
	if ok && strings.TrimSpace(text) == "" {
		// INSERT 空时间字段不写入，交给 DB 默认值处理（如 CURRENT_TIMESTAMP）。
		return nil, true
	}
	return normalizeMySQLDateTimeValue(value), false
}

func normalizeMySQLValueForWrite(columnName string, value interface{}, columnTypeMap map[string]string) interface{} {
	columnType := strings.ToLower(strings.TrimSpace(columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]))
	if isMySQLBitColumnType(columnType) {
		return normalizeMySQLBitValue(value)
	}
	if !isMySQLTemporalColumnType(columnType) {
		return value
	}
	text, ok := value.(string)
	if ok && strings.TrimSpace(text) == "" {
		return nil
	}
	return normalizeMySQLDateTimeValue(value)
}

func isMySQLTemporalColumnType(columnType string) bool {
	raw := strings.ToLower(strings.TrimSpace(columnType))
	if raw == "" {
		return false
	}
	if strings.Contains(raw, "datetime") || strings.Contains(raw, "timestamp") {
		return true
	}
	base := raw
	if idx := strings.IndexAny(base, "( "); idx >= 0 {
		base = base[:idx]
	}
	return base == "date" || base == "time" || base == "year"
}

func isMySQLBitColumnType(columnType string) bool {
	raw := strings.ToLower(strings.TrimSpace(columnType))
	if raw == "" {
		return false
	}
	base := raw
	if idx := strings.IndexAny(base, "( "); idx >= 0 {
		base = base[:idx]
	}
	return base == "bit"
}

func normalizeMySQLBitValue(value interface{}) interface{} {
	switch v := value.(type) {
	case nil:
		return nil
	case []byte:
		return v
	case bool:
		if v {
			return []byte{1}
		}
		return []byte{0}
	case string:
		if bitValue, ok := parseMySQLBitString(v); ok {
			return bitValue
		}
		return value
	case int:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int8:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int16:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int32:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int64:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case uint:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint8:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint16:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint32:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint64:
		if bitValue, ok := mysqlBitBytesFromUint64(v); ok {
			return bitValue
		}
	case float32:
		if v >= 0 && math.Trunc(float64(v)) == float64(v) {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case float64:
		if v >= 0 && math.Trunc(v) == v {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	}
	return value
}

func parseMySQLBitString(text string) ([]byte, bool) {
	raw := strings.TrimSpace(text)
	if raw == "" {
		return nil, false
	}

	switch strings.ToLower(raw) {
	case "true":
		return []byte{1}, true
	case "false":
		return []byte{0}, true
	}

	if len(raw) > 3 && (raw[0] == 'b' || raw[0] == 'B') && raw[1] == '\'' && raw[len(raw)-1] == '\'' {
		value, err := strconv.ParseUint(raw[2:len(raw)-1], 2, 64)
		if err == nil {
			return mysqlBitBytesFromUint64OrZero(value), true
		}
		return nil, false
	}

	if len(raw) > 2 && (strings.HasPrefix(raw, "0b") || strings.HasPrefix(raw, "0B")) {
		value, err := strconv.ParseUint(raw[2:], 2, 64)
		if err == nil {
			return mysqlBitBytesFromUint64OrZero(value), true
		}
		return nil, false
	}

	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return nil, false
	}
	return mysqlBitBytesFromUint64OrZero(value), true
}

func mysqlBitBytesFromUint64(value uint64) ([]byte, bool) {
	return mysqlBitBytesFromUint64OrZero(value), true
}

func mysqlBitBytesFromUint64OrZero(value uint64) []byte {
	if value == 0 {
		return []byte{0}
	}
	var buf [8]byte
	index := len(buf)
	for value > 0 {
		index--
		buf[index] = byte(value)
		value >>= 8
	}
	return append([]byte(nil), buf[index:]...)
}

func hasTimezoneOffset(text string) bool {
	pos := strings.LastIndexAny(text, "+-")
	if pos < 0 || pos < 10 || pos+1 >= len(text) {
		return false
	}
	offset := text[pos+1:]
	if len(offset) == 5 && offset[2] == ':' {
		return isAllDigits(offset[:2]) && isAllDigits(offset[3:])
	}
	if len(offset) == 4 {
		return isAllDigits(offset)
	}
	return false
}

func isAllDigits(text string) bool {
	if text == "" {
		return false
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func formatMySQLDateTime(t time.Time) string {
	base := t.Format("2006-01-02 15:04:05")
	nanos := t.Nanosecond()
	if nanos == 0 {
		return base
	}
	micro := nanos / 1000
	return fmt.Sprintf("%s.%06d", base, micro)
}

func (m *MySQLDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	if dbName == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.database_name_required", nil)
	}
	query := fmt.Sprintf("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '%s'", strings.ReplaceAll(dbName, "'", "''"))

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["COLUMN_TYPE"]),
			Comment:   fmt.Sprintf("%v", row["COLUMN_COMMENT"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
