//go:build gonavi_full_drivers || gonavi_oceanbase_driver

package db

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func applyOceanBaseURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, ok := parseMySQLCompatibleURI(uriText, "oceanbase", "mysql")
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

	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultOceanBasePort
	}

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

func collectOceanBaseAddresses(config connection.ConnectionConfig) []string {
	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultOceanBasePort
	}

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

func (o *OceanBaseDB) getDSN(config connection.ConnectionConfig) (string, error) {
	database := config.Database
	protocol := "tcp"
	address := normalizeMySQLAddress(config.Host, config.Port)

	if config.UseSSH {
		netName, err := oceanBaseRegisterSSHNetwork(config.SSH)
		if err != nil {
			return "", fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		protocol = netName
	}

	return buildMySQLCompatibleDSN(config, protocol, address, database)
}

func normalizeOceanBaseProtocol(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case oceanBaseProtocolOracle, "oracle-mode", "oracle_mode", "oboracle":
		return oceanBaseProtocolOracle
	case oceanBaseProtocolMySQL, "mysql-compatible", "mysql_compatible", "mysql-mode", "mysql_mode", "obmysql", "":
		return oceanBaseProtocolMySQL
	default:
		return ""
	}
}

func unsupportedOceanBaseProtocolError(raw string) error {
	return fmt.Errorf("OceanBase 当前仅支持 MySQL/Oracle 租户协议，不支持 %q；请改为 MySQL 或 Oracle", strings.TrimSpace(raw))
}

func resolveOceanBaseProtocolFromValues(values url.Values) (string, error) {
	if len(values) == 0 {
		return "", nil
	}
	for _, key := range []string{"protocol", "oceanBaseProtocol", "oceanbaseProtocol", "tenantMode", "compatMode", "mode"} {
		if value := strings.TrimSpace(values.Get(key)); value != "" {
			protocol := normalizeOceanBaseProtocol(value)
			if protocol == "" {
				return "", unsupportedOceanBaseProtocolError(value)
			}
			return protocol, nil
		}
	}
	return "", nil
}

func resolveOceanBaseProtocol(config connection.ConnectionConfig) (string, error) {
	explicitProtocol := ""
	if explicit := strings.TrimSpace(config.OceanBaseProtocol); explicit != "" {
		protocol := normalizeOceanBaseProtocol(explicit)
		if protocol == "" {
			return "", unsupportedOceanBaseProtocolError(explicit)
		}
		explicitProtocol = protocol
	}
	if protocol, err := resolveOceanBaseProtocolFromValues(connectionParamsFromText(config.ConnectionParams)); err != nil {
		return "", err
	} else if protocol != "" {
		if explicitProtocol != "" {
			return explicitProtocol, nil
		}
		return protocol, nil
	}
	if protocol, err := resolveOceanBaseProtocolFromValues(connectionParamsFromURI(config.URI, "oceanbase", "mysql")); err != nil {
		return "", err
	} else if protocol != "" {
		if explicitProtocol != "" {
			return explicitProtocol, nil
		}
		return protocol, nil
	}
	if explicitProtocol != "" {
		return explicitProtocol, nil
	}
	return oceanBaseProtocolMySQL, nil
}

func stripOceanBaseProtocolParams(raw string) string {
	values := connectionParamsFromText(raw)
	if len(values) == 0 {
		return strings.TrimSpace(raw)
	}
	for _, key := range []string{"protocol", "oceanBaseProtocol", "oceanbaseProtocol", "tenantMode", "compatMode", "mode"} {
		values.Del(key)
	}
	return values.Encode()
}

func stripOceanBaseProtocolURI(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return text
	}
	parsed, ok := parseConnectionURI(text, "oceanbase", "mysql")
	if !ok {
		return text
	}
	values := parsed.Query()
	if len(values) == 0 {
		return text
	}
	for _, key := range []string{"protocol", "oceanBaseProtocol", "oceanbaseProtocol", "tenantMode", "compatMode", "mode"} {
		values.Del(key)
	}
	parsed.RawQuery = values.Encode()
	return parsed.String()
}

func withoutOceanBaseProtocolParams(config connection.ConnectionConfig) connection.ConnectionConfig {
	next := config
	next.OceanBaseProtocol = ""
	next.ConnectionParams = stripOceanBaseProtocolParams(config.ConnectionParams)
	next.URI = stripOceanBaseProtocolURI(config.URI)
	return next
}

// parseMySQLConnectionAttributes 解析 "key1:value1,key2:value2" 格式的 attribute 串。
// 兼容 mysql DSN 中 connectionAttributes 参数的格式。
func parseMySQLConnectionAttributes(raw string) map[string]string {
	result := map[string]string{}
	text := strings.TrimSpace(raw)
	if text == "" {
		return result
	}
	for _, item := range strings.Split(text, ",") {
		entry := strings.TrimSpace(item)
		if entry == "" {
			continue
		}
		colon := strings.Index(entry, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(entry[:colon])
		value := strings.TrimSpace(entry[colon+1:])
		if key == "" {
			continue
		}
		result[key] = value
	}
	return result
}

// promoteOceanBaseOracleURIParams 把 oceanbase:// URI 中的 Oracle 业务参数提升到 ConnectionParams，
// 让 OracleDB.Connect 在不解析 oceanbase URI 的情况下仍能拿到 PREFETCH_ROWS 等参数。
func promoteOceanBaseOracleURIParams(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriParams := connectionParamsFromURI(config.URI, "oceanbase", "mysql")
	if len(uriParams) == 0 {
		return config
	}
	for _, key := range []string{"protocol", "oceanBaseProtocol", "oceanbaseProtocol", "tenantMode", "compatMode", "mode"} {
		uriParams.Del(key)
	}
	if len(uriParams) == 0 {
		return config
	}
	merged := url.Values{}
	mergeConnectionParamValuesWithAllowlist(merged, uriParams, oracleConnectionParamNames)
	mergeConnectionParamValuesWithAllowlist(merged, connectionParamsFromText(config.ConnectionParams), oracleConnectionParamNames)
	config.ConnectionParams = merged.Encode()
	return config
}

func mergeOceanBaseOracleOBClientParams(params url.Values, values url.Values) {
	if len(values) == 0 {
		return
	}
	for key, vals := range values {
		name := strings.TrimSpace(key)
		if name == "" {
			continue
		}
		lowerName := strings.ToLower(name)
		if lowerName == "connectionattributes" {
			for _, value := range vals {
				for attrKey, attrValue := range parseMySQLConnectionAttributes(value) {
					params.Set("attr."+attrKey, attrValue)
				}
			}
			continue
		}
		if strings.HasPrefix(lowerName, "attr.") {
			for _, value := range vals {
				params.Set(name, value)
			}
			continue
		}
		switch lowerName {
		case "timeout", "connecttimeout", "connect timeout":
			for _, value := range vals {
				params.Set("timeout", normalizeMySQLDurationParam(value, time.Millisecond))
			}
		case "trace", "preset", "cap.add", "cap.drop", "collation", "ob20", "protocol.v2",
			"ob20.magic", "ob20.disablechecksum", "compress", "usecompression", "use_compression",
			"tls", "tls.ca", "tls_ca", "tls.cert", "tls_cert", "tls.key", "tls_key":
			for _, value := range vals {
				params.Set(name, value)
			}
		case "init":
			for _, value := range vals {
				params.Add("init", value)
			}
		}
	}
}

func buildOceanBaseOracleOBClientDSN(config connection.ConnectionConfig) (string, error) {
	if strings.TrimSpace(config.User) == "" {
		return "", fmt.Errorf("OceanBase Oracle (OBClient 路径) 缺少用户名")
	}
	address := normalizeMySQLAddress(config.Host, config.Port)
	dsnURL := url.URL{
		Scheme: "oboracle",
		Host:   address,
		User:   url.UserPassword(config.User, config.Password),
	}
	if strings.TrimSpace(config.Database) != "" {
		dsnURL.Path = "/" + strings.TrimSpace(config.Database)
	}

	params := url.Values{}
	params.Set("preset", "oboracle")
	if timeout := getConnectTimeout(config); timeout > 0 {
		params.Set("timeout", timeout.String())
	}
	mergeOceanBaseOracleOBClientParams(params, connectionParamsFromURI(config.URI, "oceanbase", "mysql", "oboracle"))
	mergeOceanBaseOracleOBClientParams(params, connectionParamsFromText(config.ConnectionParams))
	if strings.TrimSpace(params.Get("preset")) == "" {
		params.Set("preset", "oboracle")
	}
	dsnURL.RawQuery = params.Encode()
	return dsnURL.String(), nil
}

func prepareOceanBaseOracleConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := withoutOceanBaseProtocolParams(applyOceanBaseURI(config))
	runConfig = promoteOceanBaseOracleURIParams(runConfig)
	runConfig.Type = "oracle"
	runConfig.URI = ""
	return runConfig
}

// isOceanBaseOracleTenantMySQLDriverError 识别 OceanBase 服务端在 MySQL wire 上拒绝 Oracle 租户的错误
// （Error 1235 / SQLSTATE 0A000：Oracle tenant for current client driver is not supported）。
// 当用户错选 MySQL 协议但实际是 Oracle 租户时给出明确切换建议。
func isOceanBaseOracleTenantMySQLDriverError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "oracle tenant") && strings.Contains(text, "not supported")
}

func formatOceanBaseMySQLAttemptError(address string, err error) string {
	if isOceanBaseOracleTenantMySQLDriverError(err) {
		return fmt.Sprintf("%s 验证失败：当前选择的是 OceanBase MySQL 协议，但服务端返回 Oracle 租户不支持 MySQL 客户端驱动（OB Error 1235）；请在连接配置中将 OceanBase 协议切换为 Oracle。若使用 OBClient/OBServer MySQL-wire 入口，主机和端口可保持不变且服务名可留空；只有连接 OBProxy Oracle listener/TNS 入口时才需要填写服务名（Service Name）", address)
	}
	return fmt.Sprintf("%s 验证失败：%v", address, err)
}

// annotateOceanBaseOracleConnectError 把 go-ora 返回的底层错误转换为 OceanBase Oracle 租户友好诊断，
// 帮助用户区分「端口不通」「端口非 Oracle 协议」「认证失败」三类常见问题。
func annotateOceanBaseOracleConnectError(err error) error {
	if err == nil {
		return nil
	}
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "connection refused"),
		strings.Contains(lower, "no route to host"),
		strings.Contains(lower, "i/o timeout"),
		strings.Contains(lower, "deadline exceeded"):
		return fmt.Errorf("%w（OceanBase Oracle 协议连接失败：目标地址未响应。请确认 OBProxy 已启用 Oracle 协议监听端口，并检查网络与防火墙）", err)
	case strings.Contains(lower, "tns"),
		strings.Contains(lower, "protocol error"),
		strings.Contains(lower, "unexpected packet"),
		strings.Contains(lower, "got packets out of order"),
		strings.Contains(lower, "use of closed network connection"):
		return fmt.Errorf("%w（OceanBase Oracle TNS 路径握手失败：当前端口可能是 OBServer 的 MySQL wire 协议端口而非 OBProxy 的 Oracle listener。GoNavi 会优先尝试 OB Oracle 专用 MySQL-wire 路径；如这里仍报此错说明该路径也未成功，详见随后的 OBClient 错误诊断）", err)
	case strings.Contains(lower, "ora-"):
		return fmt.Errorf("%w（OceanBase Oracle 租户认证或服务名失败：请确认服务名（Service Name）、用户名（如 SYS@oracle_tenant#cluster_name）与权限配置）", err)
	}
	return fmt.Errorf("%w（OceanBase Oracle 协议连接失败）", err)
}
