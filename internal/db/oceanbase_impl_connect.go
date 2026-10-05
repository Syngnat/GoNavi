//go:build gonavi_full_drivers || gonavi_oceanbase_driver

package db

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"
)

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
