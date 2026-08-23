//go:build gonavi_full_drivers || gonavi_oceanbase_driver

// Package db 中的 OceanBase 实现说明（请在调整 Oracle 路径前阅读，避免方向摇摆）：
//
// OceanBase 有两类入口：
//  1. OBServer 直连 / OBProxy MySQL listener —— MySQL wire 协议（OBClient 协议扩展）
//  2. OBProxy Oracle listener —— 标准 Oracle TNS 网络协议
//
// Navicat 的"OceanBase"数据源经实测能在 OB MySQL wire 端口上直接连接 Oracle 租户，
// 但本机企业版验证表明：仅通过 go-sql-driver/mysql 注入 CLIENT_CONNECT_ATTRS 不足以
// 让 Oracle 租户放行，还需要 CLIENT_SUPPORT_ORACLE_MODE 等 OceanBase 私有 capability。
// 因此 GoNavi 将 Oracle 租户的 MySQL-wire 路径隔离到 OB Oracle 专用 driver。
//
// GoNavi 当前路由（按 OceanBase 协议字段选择决定）：
//   - 协议=MySQL：走 go-sql-driver/mysql，连 MySQL 租户。OB 服务端在 Oracle 租户上返回
//     "Error 1235 (0A000): Oracle tenant for current client driver is not supported"
//     时，错误信息提示用户切换到 Oracle 协议。
//   - 协议=Oracle：先做 mysql wire 端口预探测（probeOceanBaseMySQLWireHandshake）。
//     识别为 OB MySQL wire 时，走 obconnector-go 的 OB Oracle 专用握手路径；
//     元数据查询通过 OracleDB wrapper 复用 Oracle 方言 SQL，ApplyChanges 用
//     applyOracleChangesMySQLWire（"?" 占位符 + 双引号引用）。
//     端口非 OB MySQL wire 时，走 sijms/go-ora 连接 OBProxy 的 Oracle listener。
//
// 历史教训：d2dad751 / 17331ddb / 5/14 两次反转都没在真实 OB Oracle 租户集群上联调，
// 多次方向摇摆。本次反转有 Navicat 真实工作证据（用户报告：Navicat 用 OceanBase 数据源
// 类型连同一端口 60014 成功）以及本机企业版 Oracle 租户验证。go-sql-driver/mysql 即使
// 注入 connectionAttributes 也无法发出 OceanBase Oracle 租户需要的私有 capability，
// 因此 Oracle/MySQL-wire 路径必须和普通 OceanBase MySQL 路径隔离。
package db

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	mysqlDriver "github.com/go-sql-driver/mysql"
	_ "github.com/helingjun/obconnector-go"
)

const (
	oceanbaseDriverName             = "gonavi_oceanbase_mysql"
	oceanbaseOracleOBClientDriver   = "oboracle"
	defaultOceanBasePort            = 2881
	oceanBaseProtocolMySQL          = "mysql"
	oceanBaseProtocolOracle         = "oracle"
	oceanBaseOracleProbeReadTimeout = 3 * time.Second
)

// OceanBaseDB 支持 OceanBase MySQL/Oracle 两种租户协议。
type OceanBaseDB struct {
	MySQLDB
	oracle   *OracleDB
	protocol string
}

func init() {
	for _, name := range sql.Drivers() {
		if name == oceanbaseDriverName {
			return
		}
	}
	sql.Register(oceanbaseDriverName, &mysqlDriver.MySQLDriver{})
}

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

type oceanBaseMySQLWireProbeResult struct {
	isOBMySQLWire  bool
	probeSucceeded bool
	tcpReachable   bool
	err            error
}

var (
	oceanBaseProbeDialContext      = defaultOceanBaseProbeDialContext
	oceanBaseAcquireLocalForwarder = ssh.AcquireLocalForwarder
	oceanBaseRegisterSSHNetwork    = ssh.RegisterSSHNetwork
)

func defaultOceanBaseProbeDialContext(ctx context.Context, config connection.ConnectionConfig, address string) (net.Conn, error) {
	if config.UseSSH {
		return ssh.DialContextThroughSSH(ctx, config.SSH, "tcp", address)
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, "tcp", address)
}

func formatOceanBaseOracleNetworkProbeError(config connection.ConnectionConfig, err error) error {
	address := normalizeMySQLAddress(config.Host, config.Port)
	if config.UseSSH {
		if err == nil {
			return fmt.Errorf("OceanBase Oracle 连接失败：通过 SSH 跳板机访问目标地址 %s 失败。该错误发生在协议选择之前，和 OBClient/TNS 路径无关；请确认跳板机能访问该内网地址，并检查 SSH 配置、远端防火墙以及 OBProxy/OBServer 监听端口", address)
		}
		return fmt.Errorf("OceanBase Oracle 连接失败：通过 SSH 跳板机访问目标地址 %s 失败：%w。该错误发生在协议选择之前，和 OBClient/TNS 路径无关；请确认跳板机能访问该内网地址，并检查 SSH 配置、远端防火墙以及 OBProxy/OBServer 监听端口", address, err)
	}
	if err == nil {
		return fmt.Errorf("OceanBase Oracle 连接失败：目标地址 %s TCP 不可达。该错误发生在协议选择之前，和 OBClient/TNS 路径无关；请确认客户端机器能访问该地址，并检查 VPN/内网路由、防火墙以及 OBProxy/OBServer 监听端口", address)
	}
	return fmt.Errorf("OceanBase Oracle 连接失败：目标地址 %s TCP 不可达：%w。该错误发生在协议选择之前，和 OBClient/TNS 路径无关；请确认客户端机器能访问该地址，并检查 VPN/内网路由、防火墙以及 OBProxy/OBServer 监听端口", address, err)
}

// probeOceanBaseMySQLWireHandshake 通过读取目标端口的 MySQL initial handshake packet
// 判断该端口背后是否是 OceanBase 的 MySQL wire 协议端口。
//
// 探测过程：
//  1. TCP 建连（带 timeout）
//  2. 读 4 字节 packet header（3 字节 payload length + 1 字节 sequence id）
//  3. 读 payload；payload[0] 为 protocol version
//  4. server_version 是从 payload[1] 开始的 null-terminated 字符串
//  5. server_version 中包含 "oceanbase" / "ob" 关键字时判定为 OB MySQL wire
//
// 返回值：(isOBMySQLWire, probeSucceeded)。probeSucceeded=false 表示建连或完整握手包读取失败。
// Connect 使用 probeOceanBaseMySQLWireHandshakeDetail 区分 TCP 不可达与协议探测失败。
//
// 容忍度设计：
//   - protocol_version 不严限（OB 自定义版本号也接受）
//   - payload 上限 64KB（OB 4.x 的 handshake 可能携带额外的能力位信息）
//   - 短超时（2s）：探测只为方向选择，主流程的真实超时由 Connect 控制
func probeOceanBaseMySQLWireHandshake(host string, port int, timeout time.Duration) (bool, bool) {
	result := probeOceanBaseMySQLWireHandshakeDetail(connection.ConnectionConfig{Host: host, Port: port}, timeout)
	return result.isOBMySQLWire, result.probeSucceeded
}

func probeOceanBaseMySQLWireHandshakeDetail(config connection.ConnectionConfig, timeout time.Duration) oceanBaseMySQLWireProbeResult {
	return probeOceanBaseMySQLWireHandshakeDetailWithTimeouts(config, timeout, timeout)
}

func probeOceanBaseMySQLWireHandshakeDetailWithTimeouts(config connection.ConnectionConfig, dialTimeout time.Duration, readTimeout time.Duration) oceanBaseMySQLWireProbeResult {
	if dialTimeout <= 0 {
		dialTimeout = 2 * time.Second
	}
	if readTimeout <= 0 {
		readTimeout = dialTimeout
	}
	addr := normalizeMySQLAddress(config.Host, config.Port)
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()
	conn, err := oceanBaseProbeDialContext(ctx, config, addr)
	if err != nil {
		return oceanBaseMySQLWireProbeResult{err: err}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(readTimeout))

	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		// TCP 已经连通但服务端没有主动发送 MySQL handshake，通常是 Oracle TNS listener
		// 或其它非 MySQL wire 协议端口。此时不能归因为网络不可达。
		return oceanBaseMySQLWireProbeResult{probeSucceeded: true, tcpReachable: true, err: err}
	}
	payloadLen := int(header[0]) | int(header[1])<<8 | int(header[2])<<16
	// 放宽上限：OB 4.x handshake 可能携带额外 capability info。仍要约束以避免读取异常长度
	if payloadLen < 1 || payloadLen > 65536 {
		return oceanBaseMySQLWireProbeResult{probeSucceeded: true, tcpReachable: true}
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return oceanBaseMySQLWireProbeResult{tcpReachable: true, err: err}
	}

	// 不再严格检查 protocol_version。OB 自定义版本号也认作 MySQL wire 候选——
	// 只要 server_version 字符串含 OceanBase/OBProxy 关键字就足以做方向选择。
	nullIdx := bytes.IndexByte(payload[1:], 0)
	if nullIdx < 0 {
		return oceanBaseMySQLWireProbeResult{probeSucceeded: true, tcpReachable: true}
	}
	serverVersion := strings.ToLower(string(payload[1 : 1+nullIdx]))
	if serverVersion == "" {
		return oceanBaseMySQLWireProbeResult{probeSucceeded: true, tcpReachable: true}
	}
	if strings.Contains(serverVersion, "oceanbase") || strings.Contains(serverVersion, "obproxy") {
		return oceanBaseMySQLWireProbeResult{isOBMySQLWire: true, probeSucceeded: true, tcpReachable: true}
	}
	if strings.Contains(serverVersion, "-ob") {
		return oceanBaseMySQLWireProbeResult{isOBMySQLWire: true, probeSucceeded: true, tcpReachable: true}
	}
	return oceanBaseMySQLWireProbeResult{probeSucceeded: true, tcpReachable: true}
}

// connectOracleViaTNS 走 sijms/go-ora，连 OBProxy 暴露的 Oracle listener 端口（标准 TNS）。
// 用于端口非 OB MySQL wire 的情况。
func (o *OceanBaseDB) connectOracleViaTNS(config connection.ConnectionConfig) error {
	runConfig := prepareOceanBaseOracleConfig(config)
	if strings.TrimSpace(runConfig.Database) == "" {
		return fmt.Errorf("OceanBase Oracle 协议（TNS 路径）需要填写服务名（Service Name），请在连接配置中填写租户监听的服务名（例如 ORCL / tenant_oracle 等）")
	}
	oracleDB := &OracleDB{scanDialect: oceanBaseOracleScanDialect}
	if err := oracleDB.Connect(runConfig); err != nil {
		_ = oracleDB.Close()
		return annotateOceanBaseOracleConnectError(err)
	}
	o.oracle = oracleDB
	o.protocol = oceanBaseProtocolOracle
	return nil
}

// connectOracleViaOBClient 走 OB Oracle 专用 MySQL-wire 握手，连 OceanBase
// MySQL wire 端口上的 Oracle 租户。
// 用于端口预探测识别为 OB MySQL wire 的情况。
func (o *OceanBaseDB) connectOracleViaOBClient(config connection.ConnectionConfig) error {
	addresses := collectOceanBaseAddresses(config)
	if len(addresses) == 0 {
		return fmt.Errorf("OceanBase Oracle (OBClient 路径) 连接建立后验证失败：未找到可用地址")
	}

	var errorDetails []string
	for index, address := range addresses {
		candidateConfig := config
		var forwarder *ssh.LocalForwarder
		releaseForwarder := func() {
			if forwarder != nil {
				_ = forwarder.Release()
				forwarder = nil
			}
		}
		host, port, ok := parseHostPortWithDefault(address, defaultOceanBasePort)
		if !ok {
			continue
		}
		candidateConfig.Host = host
		candidateConfig.Port = port
		candidateConfig.User, candidateConfig.Password = resolveMySQLCredential(config, index)

		if candidateConfig.UseSSH {
			var err error
			forwarder, err = oceanBaseAcquireLocalForwarder(candidateConfig.SSH, host, port)
			if err != nil {
				if _, requiresTrust := ssh.HostKeyTrustStatusFromError(err); requiresTrust {
					return fmt.Errorf("OceanBase Oracle (OBClient 路径) %s 创建 SSH 本地转发失败：%w", address, err)
				}
				errorDetails = append(errorDetails, fmt.Sprintf("%s 创建 SSH 本地转发失败：%v", address, err))
				continue
			}
			localHost, localPort, ok := parseHostPortWithDefault(forwarder.LocalAddr, defaultOceanBasePort)
			if !ok {
				errorDetails = append(errorDetails, fmt.Sprintf("%s 解析 SSH 本地转发地址失败：%s", address, forwarder.LocalAddr))
				releaseForwarder()
				continue
			}
			candidateConfig.Host = localHost
			candidateConfig.Port = localPort
			candidateConfig.UseSSH = false
		}

		dsn, err := buildOceanBaseOracleOBClientDSN(candidateConfig)
		if err != nil {
			errorDetails = append(errorDetails, fmt.Sprintf("%s 生成连接串失败：%v", address, err))
			releaseForwarder()
			continue
		}
		db, err := sql.Open(oceanbaseOracleOBClientDriver, dsn)
		if err != nil {
			errorDetails = append(errorDetails, fmt.Sprintf("%s 打开失败：%v", address, err))
			releaseForwarder()
			continue
		}
		configureSQLConnectionPool(db, "oceanbase")

		timeout := getConnectTimeout(candidateConfig)
		ctx, cancel := utils.ContextWithTimeout(timeout)
		pingErr := db.PingContext(ctx)
		cancel()
		if pingErr != nil {
			_ = db.Close()
			errorDetails = append(errorDetails, formatOceanBaseOBClientAttemptError(address, pingErr))
			releaseForwarder()
			continue
		}

		o.bindConnectedDatabase(db, timeout, oceanBaseProtocolOracle)
		if o.oracle != nil {
			o.oracle.forwarder = forwarder
			forwarder = nil
		}
		releaseForwarder()
		return nil
	}

	if len(errorDetails) == 0 {
		return fmt.Errorf("OceanBase Oracle (OBClient 路径) 连接建立后验证失败：未找到可用地址")
	}
	return fmt.Errorf("OceanBase Oracle (OBClient 路径) 连接建立后验证失败：%s", strings.Join(errorDetails, "；"))
}

// formatOceanBaseOBClientAttemptError 给 OBClient 路径下的握手失败添加针对 attribute 调试的提示。
func formatOceanBaseOBClientAttemptError(address string, err error) string {
	if isOceanBaseOracleTenantMySQLDriverError(err) {
		return fmt.Sprintf("%s 验证失败：OceanBase 服务端仍返回 Error 1235 拒绝当前 client driver。"+
			"GoNavi 已使用 OB Oracle 专用握手路径；如仍失败，请确认该端口是 OceanBase Oracle 租户的 MySQL-wire 入口，"+
			"并在 ConnectionParams 中通过 preset/cap.add/cap.drop 或 connectionAttributes=key1:value1 覆盖驱动握手参数。"+
			"详细错误：%v", address, err)
	}
	return fmt.Sprintf("%s 验证失败：%v", address, err)
}

// bindConnectedDatabase 把已经握手成功的 *sql.DB 绑定到 OceanBaseDB 的合适字段：
// Oracle 协议时通过 OracleDB wrapper 复用 Oracle 方言 SQL；MySQL 协议时直接绑定 MySQLDB。
func (o *OceanBaseDB) bindConnectedDatabase(db *sql.DB, timeout time.Duration, protocol string) {
	o.oracle = nil
	o.conn = nil
	o.pingTimeout = 0
	o.batchWritesEnabled = false
	if protocol == oceanBaseProtocolOracle {
		o.oracle = &OracleDB{conn: db, pingTimeout: timeout, scanDialect: oceanBaseOracleScanDialect}
		o.protocol = oceanBaseProtocolOracle
		return
	}
	o.conn = db
	o.pingTimeout = timeout
	o.protocol = oceanBaseProtocolMySQL
}

func (o *OceanBaseDB) setMySQLBatchWritesFromDSN(dsn string) {
	if o == nil {
		return
	}
	o.batchWritesEnabled = mysqlDSNSupportsBatchWrites(dsn)
}

func (o *OceanBaseDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = o.Close()
	o.batchWritesEnabled = false
	defer func() {
		if err != nil {
			_ = o.Close()
		}
	}()

	o.oracle = nil
	o.conn = nil
	o.protocol = oceanBaseProtocolMySQL
	appliedConfig := applyOceanBaseURI(config)
	protocol, err := resolveOceanBaseProtocol(appliedConfig)
	if err != nil {
		return err
	}
	runConfig := withoutOceanBaseProtocolParams(appliedConfig)

	if protocol == oceanBaseProtocolOracle {
		// 预探测目标端口的实际协议，决定走哪条 Oracle 连接路径。
		// SSH 跳板机到内网目标的 direct-tcpip 拨号可能慢于 3 秒；只收紧握手读取超时，避免误判内网目标不可达。
		probeDialTimeout := getConnectTimeout(runConfig)
		if !runConfig.UseSSH && probeDialTimeout > oceanBaseOracleProbeReadTimeout {
			probeDialTimeout = oceanBaseOracleProbeReadTimeout
		}
		probeReadTimeout := oceanBaseOracleProbeReadTimeout
		if probeReadTimeout > probeDialTimeout {
			probeReadTimeout = probeDialTimeout
		}
		probeResult := probeOceanBaseMySQLWireHandshakeDetailWithTimeouts(runConfig, probeDialTimeout, probeReadTimeout)
		switch {
		case probeResult.probeSucceeded && probeResult.isOBMySQLWire:
			// 明确识别为 OB MySQL wire 端口：直接走 OB Oracle 专用 MySQL-wire 路径
			logger.Infof("OceanBase 协议=Oracle 预探测：%s:%d 是 OB MySQL wire 端口，走 OB Oracle 专用 MySQL-wire 路径连接 Oracle 租户", runConfig.Host, runConfig.Port)
			return o.connectOracleViaOBClient(runConfig)
		case probeResult.probeSucceeded:
			// 已收到 MySQL handshake，但 server_version 不一定包含 OceanBase 标识。
			// 部分 OceanBase Oracle 租户会返回通用 MySQL 版本串；此时仍应优先按
			// OBClient/MySQL-wire 路径连接，失败后再尝试 TNS。
			logger.Infof("OceanBase 协议=Oracle 预探测：%s:%d 返回 MySQL handshake 但未识别 OceanBase 标识，优先尝试 OB Oracle 专用 MySQL-wire 路径", runConfig.Host, runConfig.Port)
			return o.connectOracleViaOBClientThenTNS(runConfig)
		case !probeResult.tcpReachable && probeResult.err != nil:
			logger.Warnf("OceanBase 协议=Oracle 预探测建连失败：%s:%d，跳过 OBClient/TNS 重复尝试：%v", runConfig.Host, runConfig.Port, probeResult.err)
			return formatOceanBaseOracleNetworkProbeError(runConfig, probeResult.err)
		default:
			// 探测失败但 TCP 已建连：可能是异常截断的握手包，或某些 OB 版本不主动发完整 handshake。
			// 不能盲选 TNS——用户填 60014/2881 这类端口大概率仍是 OB MySQL wire。
			// 串行尝试两条真实路径：先 OBClient（命中概率更高），失败再 TNS，合并错误信息。
			logger.Warnf("OceanBase 协议=Oracle 预探测失败：%s:%d，串行尝试 OB Oracle 专用 MySQL-wire 与 TNS 两条路径", runConfig.Host, runConfig.Port)
			return o.connectOracleViaOBClientThenTNS(runConfig)
		}
	}

	addresses := collectOceanBaseAddresses(runConfig)
	if len(addresses) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 OceanBase 地址")
	}

	var errorDetails []string
	for index, address := range addresses {
		candidateConfig := runConfig
		host, port, ok := parseHostPortWithDefault(address, defaultOceanBasePort)
		if !ok {
			continue
		}
		candidateConfig.Host = host
		candidateConfig.Port = port
		candidateConfig.User, candidateConfig.Password = resolveMySQLCredential(runConfig, index)

		dsn, err := o.getDSN(candidateConfig)
		if err != nil {
			if _, requiresTrust := ssh.HostKeyTrustStatusFromError(err); requiresTrust {
				return fmt.Errorf("OceanBase %s 创建 SSH 隧道失败：%w", address, err)
			}
			errorDetails = append(errorDetails, fmt.Sprintf("%s 生成连接串失败：%v", address, err))
			continue
		}
		db, err := sql.Open(oceanbaseDriverName, dsn)
		if err != nil {
			errorDetails = append(errorDetails, fmt.Sprintf("%s 打开失败：%v", address, err))
			continue
		}
		configureSQLConnectionPool(db, "oceanbase")

		timeout := getConnectTimeout(candidateConfig)
		ctx, cancel := utils.ContextWithTimeout(timeout)
		pingErr := db.PingContext(ctx)
		cancel()
		if pingErr != nil {
			_ = db.Close()
			errorDetails = append(errorDetails, formatOceanBaseMySQLAttemptError(address, pingErr))
			continue
		}

		o.conn = db
		o.pingTimeout = timeout
		o.protocol = oceanBaseProtocolMySQL
		o.setMySQLBatchWritesFromDSN(dsn)
		return nil
	}

	if len(errorDetails) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 OceanBase 地址")
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(errorDetails, "；"))
}

func (o *OceanBaseDB) connectOracleViaOBClientThenTNS(config connection.ConnectionConfig) error {
	obclientErr := o.connectOracleViaOBClient(config)
	if obclientErr == nil {
		return nil
	}
	if _, requiresTrust := ssh.HostKeyTrustStatusFromError(obclientErr); requiresTrust {
		return obclientErr
	}
	if strings.TrimSpace(config.Database) == "" {
		return fmt.Errorf("OceanBase Oracle OBClient/MySQL-wire 路径连接失败：%v；当前未填写 Service Name，已跳过 TNS 路径。若连接的是 OBClient/OBServer MySQL-wire 入口，Service Name 可继续留空，请检查主机、端口、用户名、密码和 driver-agent 是否为当前版本；Service Name 只用于 OBProxy Oracle listener/TNS 入口", obclientErr)
	}
	logger.Warnf("OceanBase Oracle OBClient 路径失败，继续尝试 TNS 路径：%v", obclientErr)
	tnsErr := o.connectOracleViaTNS(config)
	if tnsErr == nil {
		return nil
	}
	return fmt.Errorf("OceanBase Oracle 两条连接路径均失败；OBClient 路径错误：%v；TNS 路径错误：%w", obclientErr, tnsErr)
}

func (o *OceanBaseDB) activeDatabase() Database {
	if o.oracle != nil {
		return o.oracle
	}
	return &o.MySQLDB
}

func (o *OceanBaseDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(o.activeDatabase(), ctx)
}

func (o *OceanBaseDB) clearMetadataContext() {
	ClearMetadataContext(o.activeDatabase())
}

func (o *OceanBaseDB) Close() error {
	if o.oracle != nil {
		err := o.oracle.Close()
		o.oracle = nil
		return err
	}
	return o.MySQLDB.Close()
}

func (o *OceanBaseDB) Ping() error {
	return o.activeDatabase().Ping()
}

func (o *OceanBaseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if q, ok := o.activeDatabase().(interface {
		QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
	}); ok {
		return q.QueryContext(ctx, query)
	}
	return o.activeDatabase().Query(query)
}

func (o *OceanBaseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return o.activeDatabase().Query(query)
}

func (o *OceanBaseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if e, ok := o.activeDatabase().(interface {
		ExecContext(context.Context, string) (int64, error)
	}); ok {
		return e.ExecContext(ctx, query)
	}
	return o.activeDatabase().Exec(query)
}

func (o *OceanBaseDB) Exec(query string) (int64, error) {
	return o.activeDatabase().Exec(query)
}

func (o *OceanBaseDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	if q, ok := o.activeDatabase().(MultiResultQuerier); ok {
		return q.QueryMulti(query)
	}
	data, columns, err := o.Query(query)
	if err != nil {
		return nil, err
	}
	return []connection.ResultSetData{{Rows: data, Columns: columns}}, nil
}

func (o *OceanBaseDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if q, ok := o.activeDatabase().(MultiResultQuerierContext); ok {
		return q.QueryMultiContext(ctx, query)
	}
	data, columns, err := o.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return []connection.ResultSetData{{Rows: data, Columns: columns}}, nil
}

func (o *OceanBaseDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if e, ok := o.activeDatabase().(BatchWriteExecer); ok {
		return e.ExecBatchContext(ctx, query)
	}
	return o.ExecContext(ctx, query)
}

func (o *OceanBaseDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if p, ok := o.activeDatabase().(SessionExecerProvider); ok {
		return p.OpenSessionExecer(ctx)
	}
	return nil, fmt.Errorf("当前 OceanBase %s 协议不支持独立导入会话", o.protocol)
}

func (o *OceanBaseDB) GetDatabases() ([]string, error) {
	return o.activeDatabase().GetDatabases()
}

func (o *OceanBaseDB) GetTables(dbName string) ([]string, error) {
	return o.activeDatabase().GetTables(dbName)
}

func (o *OceanBaseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if o.protocol == oceanBaseProtocolOracle && o.oracle != nil {
		ddl, err := o.oracle.GetCreateStatement(dbName, tableName)
		if err == nil && strings.TrimSpace(ddl) != "" {
			return ddl, nil
		}
		showDDL, showErr := o.getOceanBaseOracleShowCreateStatement(dbName, tableName)
		if showErr == nil {
			return showDDL, nil
		}
		if err != nil {
			return "", localizedDatabaseRuntimeError("db.backend.error.oceanbase_oracle_show_create_table_fallback_failed", map[string]any{
				"metadataDetail": err.Error(),
				"showDetail":     showErr.Error(),
			})
		}
		return "", showErr
	}
	return o.activeDatabase().GetCreateStatement(dbName, tableName)
}

func (o *OceanBaseDB) getOceanBaseOracleShowCreateStatement(dbName string, tableName string) (string, error) {
	var firstErr error
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		query := buildOceanBaseOracleShowCreateTableQuery(candidate.schema, candidate.table)
		data, _, err := o.oracle.Query(query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if ddl := extractOceanBaseOracleCreateStatement(data); ddl != "" {
			return o.oracle.appendOracleCommentDDL(ddl, candidate.schema, candidate.table), nil
		}
	}
	if firstErr != nil {
		return "", firstErr
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func buildOceanBaseOracleShowCreateTableQuery(schema string, table string) string {
	return "SHOW CREATE TABLE " + quoteOracleTableRef(schema, table)
}

func extractOceanBaseOracleCreateStatement(data []map[string]interface{}) string {
	for _, row := range data {
		for _, key := range []string{"Create Table", "CREATE TABLE", "CREATE_TABLE", "DDL", "ddl"} {
			if val, ok := row[key]; ok {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text
				}
			}
		}
		for _, val := range row {
			text := strings.TrimSpace(fmt.Sprintf("%v", val))
			lower := strings.ToLower(text)
			if strings.HasPrefix(lower, "create table") ||
				strings.HasPrefix(lower, "create view") ||
				strings.HasPrefix(lower, "create or replace view") {
				return text
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text
				}
			}
		}
	}
	return ""
}

func (o *OceanBaseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return o.activeDatabase().GetColumns(dbName, tableName)
}

func (o *OceanBaseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return o.activeDatabase().GetAllColumns(dbName)
}

func (o *OceanBaseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return o.activeDatabase().GetIndexes(dbName, tableName)
}

func (o *OceanBaseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return o.activeDatabase().GetForeignKeys(dbName, tableName)
}

func (o *OceanBaseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return o.activeDatabase().GetTriggers(dbName, tableName)
}

func (o *OceanBaseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return o.ApplyChangesContext(context.Background(), tableName, changes)
}

func (o *OceanBaseDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	// Oracle 协议走 OBClient 路径时，o.oracle.conn 实际上是 mysql wire 的 *sql.DB，
	// Oracle 风格 SQL（双引号引用 + ROWID）由 OceanBase 服务端按 Oracle 解析器处理，
	// 但占位符必须是 mysql 风格的 "?"，不能用 OracleDB.ApplyChanges 的 ":1" Oracle bind 风格。
	if o.protocol == oceanBaseProtocolOracle && o.oracle != nil {
		return o.applyOracleChangesMySQLWireContext(ctx, tableName, changes)
	}
	if applier, ok := o.activeDatabase().(BatchApplierContext); ok {
		return applier.ApplyChangesContext(ctx, tableName, changes)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if applier, ok := o.activeDatabase().(BatchApplier); ok {
		return applier.ApplyChanges(tableName, changes)
	}
	return fmt.Errorf("当前 OceanBase %s 协议不支持 ApplyChanges", o.protocol)
}

func buildOceanBaseOracleTemporalBind(columnType string, value interface{}) (string, interface{}, bool) {
	if value == nil {
		return "?", nil, false
	}

	rawType := strings.ToUpper(strings.TrimSpace(columnType))
	if !isOracleTemporalColumnType(rawType) {
		return "?", value, false
	}

	var parsed time.Time
	switch typed := value.(type) {
	case time.Time:
		parsed = typed
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return "?", nil, false
		}
		var ok bool
		parsed, ok = parseOracleTemporalString(text)
		if !ok {
			return "?", value, false
		}
	default:
		return "?", value, false
	}

	if strings.Contains(rawType, "TIMESTAMP") {
		text := parsed.Format("2006-01-02 15:04:05")
		format := "YYYY-MM-DD HH24:MI:SS"
		if parsed.Nanosecond() != 0 {
			text = parsed.Format("2006-01-02 15:04:05.999999999")
			text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
			format = "YYYY-MM-DD HH24:MI:SS.FF"
		}
		return fmt.Sprintf("TO_TIMESTAMP(?, '%s')", format), text, true
	}

	if parsed.Hour() == 0 && parsed.Minute() == 0 && parsed.Second() == 0 && parsed.Nanosecond() == 0 {
		return "TO_DATE(?, 'YYYY-MM-DD')", parsed.Format("2006-01-02"), true
	}
	return "TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')", parsed.Format("2006-01-02 15:04:05"), true
}

func buildOceanBaseOracleAssignment(columnName string, value interface{}, columnTypeMap map[string]string) (string, []interface{}) {
	columnType := columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]
	normalized := normalizeOracleValueForWrite(columnName, value, columnTypeMap)
	if expr, bind, ok := buildOceanBaseOracleTemporalBind(columnType, normalized); ok {
		return expr, []interface{}{bind}
	}
	return "?", []interface{}{normalized}
}

// applyOracleChangesMySQLWire 在 OceanBase Oracle 租户的 mysql wire 连接上执行
// DELETE/UPDATE/INSERT，使用 Oracle 风格双引号引用标识符 + mysql wire 风格 "?" 占位符。
func (o *OceanBaseDB) applyOracleChangesMySQLWire(tableName string, changes connection.ChangeSet) error {
	return o.applyOracleChangesMySQLWireContext(context.Background(), tableName, changes)
}

func (o *OceanBaseDB) applyOracleChangesMySQLWireContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if o.oracle == nil || o.oracle.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	columnTypeMap, err := o.oracle.loadColumnTypeMap(tableName)
	if err != nil {
		return fmt.Errorf("OceanBase Oracle 租户 %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	tx, err := o.oracle.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		n = strings.Trim(n, "\"")
		n = strings.ReplaceAll(n, "\"", "\"\"")
		if n == "" {
			return "\"\""
		}
		return `"` + n + `"`
	}

	schema := ""
	table := strings.TrimSpace(tableName)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	qualifiedTable := ""
	if schema != "" {
		qualifiedTable = fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))
	} else {
		qualifiedTable = quoteIdent(table)
	}

	isOracleRowIDLocator := strings.EqualFold(strings.TrimSpace(changes.LocatorStrategy), "oracle-rowid")
	buildWhere := func(keys map[string]interface{}) ([]string, []interface{}) {
		var wheres []string
		var args []interface{}
		for k, v := range keys {
			if isOracleRowIDLocator && strings.EqualFold(strings.TrimSpace(k), "ROWID") {
				wheres = append(wheres, "ROWID = ?")
				args = append(args, v)
				continue
			}
			valueExpr, valueArgs := buildOceanBaseOracleAssignment(k, v, columnTypeMap)
			wheres = append(wheres, fmt.Sprintf("%s = %s", quoteIdent(k), valueExpr))
			args = append(args, valueArgs...)
		}
		return wheres, args
	}

	for _, pk := range changes.Deletes {
		wheres, args := buildWhere(pk)
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}

		for k, v := range update.Values {
			valueExpr, valueArgs := buildOceanBaseOracleAssignment(k, v, columnTypeMap)
			sets = append(sets, fmt.Sprintf("%s = %s", quoteIdent(k), valueExpr))
			args = append(args, valueArgs...)
		}

		if len(sets) == 0 {
			continue
		}

		wheres, whereArgs := buildWhere(update.Keys)
		args = append(args, whereArgs...)

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}

		for k, v := range row {
			cols = append(cols, quoteIdent(k))
			valueExpr, valueArgs := buildOceanBaseOracleAssignment(k, v, columnTypeMap)
			placeholders = append(placeholders, valueExpr)
			args = append(args, valueArgs...)
		}

		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("插入失败：%v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("插入未生效：未影响任何行")
		}
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}
