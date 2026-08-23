//go:build gonavi_full_drivers || gonavi_oceanbase_driver

package db

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/shared/i18n"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

const (
	testOceanBaseOracleHost     = "ob-oracle.internal.example"
	testOceanBaseOraclePort     = 2881
	testOceanBaseOracleUser     = "APP_USER@SERVICE:test_service"
	testOceanBaseOraclePassword = "test-password"
	testOceanBaseOracleDatabase = "test_service"
	testSSHJumpHost             = "ssh-gateway.example.test"
	testSSHJumpUser             = "test-ops"
	testSSHJumpPassword         = "test-ssh-password"
)

func TestResolveOceanBaseProtocol(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		config connection.ConnectionConfig
		want   string
	}{
		{
			name:   "default mysql",
			config: connection.ConnectionConfig{Type: "oceanbase"},
			want:   oceanBaseProtocolMySQL,
		},
		{
			name: "explicit oracle params",
			config: connection.ConnectionConfig{
				Type:             "oceanbase",
				ConnectionParams: "protocol=oracle",
			},
			want: oceanBaseProtocolOracle,
		},
		{
			name: "uri protocol oracle",
			config: connection.ConnectionConfig{
				Type: "oceanbase",
				URI:  "oceanbase://sys%40oracle001:pass@127.0.0.1:2881/ORCL?protocol=oracle",
			},
			want: oceanBaseProtocolOracle,
		},
		{
			name: "connection params tenant mode oracle",
			config: connection.ConnectionConfig{
				Type:             "oceanbase",
				ConnectionParams: "tenantMode=oracle&PREFETCH_ROWS=5000",
			},
			want: oceanBaseProtocolOracle,
		},
		{
			name: "connection params wins over uri",
			config: connection.ConnectionConfig{
				Type:             "oceanbase",
				URI:              "oceanbase://root:pass@127.0.0.1:2881/app?protocol=oracle",
				ConnectionParams: "protocol=mysql",
			},
			want: oceanBaseProtocolMySQL,
		},
		{
			name: "explicit config protocol wins over params",
			config: connection.ConnectionConfig{
				Type:              "oceanbase",
				OceanBaseProtocol: "oracle",
				ConnectionParams:  "protocol=mysql",
			},
			want: oceanBaseProtocolOracle,
		},
		{
			name: "protocol key wins over compatibility aliases",
			config: connection.ConnectionConfig{
				Type:             "oceanbase",
				ConnectionParams: "protocol=mysql&tenantMode=oracle",
			},
			want: oceanBaseProtocolMySQL,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := resolveOceanBaseProtocol(tt.config)
			if err != nil {
				t.Fatalf("resolveOceanBaseProtocol() unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("resolveOceanBaseProtocol() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestResolveOceanBaseProtocolRejectsUnsupportedNative(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		config connection.ConnectionConfig
	}{
		{
			name: "params native",
			config: connection.ConnectionConfig{
				Type:             "oceanbase",
				ConnectionParams: "protocol=native",
			},
		},
		{
			name: "explicit mysql does not mask params native",
			config: connection.ConnectionConfig{
				Type:              "oceanbase",
				OceanBaseProtocol: "mysql",
				ConnectionParams:  "protocol=native",
			},
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := resolveOceanBaseProtocol(tt.config)
			if err == nil || !strings.Contains(err.Error(), "不支持") {
				t.Fatalf("expected unsupported protocol error, got %v", err)
			}
		})
	}
}

func TestWithoutOceanBaseProtocolParamsStripsDriverMeta(t *testing.T) {
	t.Parallel()

	config := withoutOceanBaseProtocolParams(connection.ConnectionConfig{
		Type:             "oceanbase",
		URI:              "oceanbase://root:pass@127.0.0.1:2881/app?protocol=mysql&timeout=10",
		ConnectionParams: "tenantMode=oracle&PREFETCH_ROWS=5000",
	})

	if strings.Contains(config.URI, "protocol=") {
		t.Fatalf("expected URI protocol param stripped, got %q", config.URI)
	}
	if strings.Contains(config.ConnectionParams, "tenantMode=") {
		t.Fatalf("expected connection param tenantMode stripped, got %q", config.ConnectionParams)
	}
	if !strings.Contains(config.URI, "timeout=10") {
		t.Fatalf("expected URI business params kept, got %q", config.URI)
	}
	if !strings.Contains(config.ConnectionParams, "PREFETCH_ROWS=5000") {
		t.Fatalf("expected Oracle params kept, got %q", config.ConnectionParams)
	}
}

// OceanBase Oracle 租户实际通过 OBProxy 暴露的 Oracle 网络协议端口连接（走 go-ora），
// 锁定 prepareOceanBaseOracleConfig 把 oceanbase:// URI 的业务参数提升到 ConnectionParams，
// 并清理 protocol 关键字，避免泄漏到 OracleDB.getDSN。
func TestPrepareOceanBaseOracleConfigPromotesURIParams(t *testing.T) {
	t.Parallel()

	config := prepareOceanBaseOracleConfig(connection.ConnectionConfig{
		Type:              "oceanbase",
		OceanBaseProtocol: "oracle",
		Host:              "127.0.0.1",
		Port:              60014,
		User:              "SYS@oracle_tenant#cluster",
		Database:          "ORCL",
		URI:               "oceanbase://SYS%40oracle_tenant%23cluster:p@127.0.0.1:60014/ORCL?protocol=oracle&PREFETCH_ROWS=5000",
	})

	if config.Type != "oracle" {
		t.Fatalf("expected Type rewritten to oracle (for OracleDB.Connect), got %q", config.Type)
	}
	if config.URI != "" {
		t.Fatalf("expected URI cleared so OracleDB does not try to reparse oceanbase scheme, got %q", config.URI)
	}
	if strings.Contains(config.ConnectionParams, "protocol=") {
		t.Fatalf("expected protocol param stripped, got %q", config.ConnectionParams)
	}
	if !strings.Contains(config.ConnectionParams, "PREFETCH_ROWS=5000") {
		t.Fatalf("expected Oracle business param PREFETCH_ROWS promoted to ConnectionParams, got %q", config.ConnectionParams)
	}
}

// 验证 go-ora 错误信息按三类常见根因分别给出可操作的诊断提示，
// 避免用户在「mysql wire 路径」与「go-ora 路径」之间方向摇摆。
func TestAnnotateOceanBaseOracleConnectErrorClassifies(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  error
		want string
	}{
		{
			name: "port unreachable",
			raw:  errors.New("dial tcp 172.16.1.155:60014: connect: connection refused"),
			want: "目标地址未响应",
		},
		{
			name: "non-oracle protocol on port (e.g. mysql wire)",
			raw:  errors.New("TNS: protocol error - got unexpected packet from server"),
			want: "MySQL wire 协议端口",
		},
		{
			name: "ora authentication error",
			raw:  errors.New("ORA-01017: invalid username/password; logon denied"),
			want: "服务名（Service Name）",
		},
		{
			name: "fallback generic wrapping",
			raw:  errors.New("some unexpected go-ora error"),
			want: "OceanBase Oracle 协议连接失败",
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := annotateOceanBaseOracleConnectError(tt.raw)
			if got == nil {
				t.Fatal("expected wrapped error, got nil")
			}
			if !strings.Contains(got.Error(), tt.want) {
				t.Fatalf("expected hint to contain %q, got %v", tt.want, got)
			}
		})
	}
}

// 任何 mysql 兼容数据源中含 @/#/: 的复合用户名/密码都依赖 go-sql-driver/mysql ParseDSN
// 的特殊切分算法（从右向左找最后一个 @，从左向右找首个 :）。锁定该 invariant 防止未来
// 重构 buildMySQLCompatibleDSN 时误加 url.QueryEscape 破坏认证。
func TestOceanBaseOracleDSNParsesTenantCredentials(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		config   connection.ConnectionConfig
		wantUser string
		wantPass string
	}{
		{
			name: "tenant user with @",
			config: connection.ConnectionConfig{
				Host: "127.0.0.1", Port: 2881,
				User: "sys@oracle001", Password: "pass", Database: "ORCL",
			},
			wantUser: "sys@oracle001",
			wantPass: "pass",
		},
		{
			name: "tenant user with @ and #cluster + password with @",
			config: connection.ConnectionConfig{
				Host: "127.0.0.1", Port: 2881,
				User: "sys@oracle001#cluster", Password: "p@ss", Database: "ORCL",
			},
			wantUser: "sys@oracle001#cluster",
			wantPass: "p@ss",
		},
	}

	ob := &OceanBaseDB{}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			dsn, err := ob.getDSN(tt.config)
			if err != nil {
				t.Fatalf("getDSN error: %v", err)
			}
			cfg, err := mysqlDriver.ParseDSN(dsn)
			if err != nil {
				t.Fatalf("mysql ParseDSN failed for %q: %v", dsn, err)
			}
			if cfg.User != tt.wantUser {
				t.Fatalf("user mismatch: got %q want %q (dsn=%q)", cfg.User, tt.wantUser, dsn)
			}
			if cfg.Passwd != tt.wantPass {
				t.Fatalf("password mismatch: got %q want %q (dsn=%q)", cfg.Passwd, tt.wantPass, dsn)
			}
			if cfg.DBName != tt.config.Database {
				t.Fatalf("database mismatch: got %q want %q", cfg.DBName, tt.config.Database)
			}
		})
	}
}

// buildMySQLHandshakePacket 构造一个完整的 MySQL initial handshake packet（protocol v10），
// 用于 mock OceanBase / 通用 MySQL / OBProxy 各种 server_version 场景。
// 实际字段顺序按 MySQL 协议规范：
//
//	4 字节 header (3 字节 payload length + 1 字节 sequence id)
//	payload[0]       protocol_version (10)
//	payload[1..N]    server_version (null-terminated)
//	...             auth seed / capability / auth plugin
func buildMySQLHandshakePacket(serverVersion string) []byte {
	payload := []byte{10}
	payload = append(payload, []byte(serverVersion)...)
	payload = append(payload, 0)
	// connection id
	payload = append(payload, []byte{0x01, 0x00, 0x00, 0x00}...)
	// auth-plugin-data-part-1 + filler
	payload = append(payload, []byte("12345678")...)
	payload = append(payload, 0)
	// capability lower 2 bytes: CLIENT_LONG_PASSWORD | CLIENT_LONG_FLAG |
	// CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION
	payload = append(payload, 0x05, 0x82)
	// character set + status flags
	payload = append(payload, 45, 0x00, 0x00)
	// capability upper 2 bytes: CLIENT_MULTI_RESULTS | CLIENT_PLUGIN_AUTH |
	// CLIENT_CONNECT_ATTRS | CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA | CLIENT_SESSION_TRACK
	payload = append(payload, 0x1a, 0x00)
	// auth-plugin-data length + reserved
	payload = append(payload, 21)
	payload = append(payload, make([]byte, 10)...)
	// auth-plugin-data-part-2 minimum 13 bytes, last byte NUL
	payload = append(payload, []byte("abcdefghijkl")...)
	payload = append(payload, 0)
	payload = append(payload, []byte("mysql_native_password")...)
	payload = append(payload, 0)
	payloadLen := len(payload)
	header := []byte{byte(payloadLen), byte(payloadLen >> 8), byte(payloadLen >> 16), 0}
	return append(header, payload...)
}

// startMockHandshakeServer 启动一个本地 TCP server，在 Accept 后立即写入一个 handshake packet，
// 然后等待客户端关闭连接。返回 server 地址（host, port）和 cleanup 函数。
func startMockHandshakeServer(t *testing.T, packet []byte) (string, int, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
			if packet != nil {
				_, _ = conn.Write(packet)
			}
			// 让客户端有机会读完后主动关闭
			buf := make([]byte, 16)
			_, _ = conn.Read(buf)
			_ = conn.Close()
		}
	}()
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	cleanup := func() {
		_ = ln.Close()
		<-done
	}
	return host, port, cleanup
}

func TestProbeOceanBaseMySQLWireDetectsOceanBaseHandshake(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		serverVersion string
		wantIsOB      bool
	}{
		{name: "ob server version", serverVersion: "5.7.25-OceanBase-v4.2.1.0", wantIsOB: true},
		{name: "obproxy server version", serverVersion: "5.6.25-OBProxy-3.2.0", wantIsOB: true},
		{name: "community ob suffix", serverVersion: "5.7.25-OB", wantIsOB: true},
		{name: "regular mysql is not flagged", serverVersion: "8.0.36", wantIsOB: false},
		{name: "mariadb is not flagged", serverVersion: "10.6.12-MariaDB", wantIsOB: false},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			host, port, cleanup := startMockHandshakeServer(t, buildMySQLHandshakePacket(tt.serverVersion))
			defer cleanup()
			gotIsOB, probed := probeOceanBaseMySQLWireHandshake(host, port, time.Second)
			if !probed {
				t.Fatal("expected probe to succeed against mock server, got probed=false")
			}
			if gotIsOB != tt.wantIsOB {
				t.Fatalf("server_version=%q expected isOB=%v got %v", tt.serverVersion, tt.wantIsOB, gotIsOB)
			}
		})
	}
}

func TestProbeOceanBaseMySQLWireHandshakeReturnsFalseOnUnreachable(t *testing.T) {
	t.Parallel()

	// 用一个不可达端口（监听后立即关闭），探测应返回 probed=false，
	// 上层会直接给出网络不可达诊断，避免 OBClient/TNS 两条路径重复超时。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	_ = ln.Close()

	gotIsOB, probed := probeOceanBaseMySQLWireHandshake(host, port, 200*time.Millisecond)
	if gotIsOB {
		t.Fatal("expected unreachable port not flagged as OB")
	}
	if probed {
		t.Fatal("expected probed=false on unreachable port so upper layer can return network diagnosis")
	}
}

func TestOceanBaseOracleConnectTriesOBClientWhenMySQLHandshakeIsGeneric(t *testing.T) {
	t.Parallel()

	host, port, cleanup := startMockHandshakeServer(t, buildMySQLHandshakePacket("8.0.36"))
	defer cleanup()

	ob := &OceanBaseDB{}
	err := ob.Connect(connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              host,
		Port:              port,
		User:              testOceanBaseOracleUser,
		Password:          testOceanBaseOraclePassword,
		OceanBaseProtocol: oceanBaseProtocolOracle,
		Timeout:           1,
	})
	if err == nil {
		t.Fatal("expected connect error from mock generic MySQL handshake server")
	}
	got := err.Error()
	if !strings.Contains(got, "OBClient/MySQL-wire 路径连接失败") {
		t.Fatalf("expected generic MySQL handshake to try OBClient first, got %q", got)
	}
	if !strings.Contains(got, "已跳过 TNS 路径") {
		t.Fatalf("expected empty Service Name to skip TNS fallback, got %q", got)
	}
	if strings.Contains(got, "需要填写服务名") {
		t.Fatalf("expected empty Service Name not to surface TNS required error for MySQL-wire fallback, got %q", got)
	}
}

func TestOceanBaseOracleConnectStopsOnProbeDialFailure(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	_ = ln.Close()

	ob := &OceanBaseDB{}
	err = ob.Connect(connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              host,
		Port:              port,
		User:              testOceanBaseOracleUser,
		Password:          testOceanBaseOraclePassword,
		Database:          testOceanBaseOracleDatabase,
		OceanBaseProtocol: oceanBaseProtocolOracle,
		Timeout:           1,
	})
	if err == nil {
		t.Fatal("expected connect error for unreachable OceanBase Oracle endpoint")
	}
	got := err.Error()
	if !strings.Contains(got, "TCP 不可达") {
		t.Fatalf("expected direct TCP unreachable diagnosis, got %q", got)
	}
	if !strings.Contains(got, "和 OBClient/TNS 路径无关") {
		t.Fatalf("expected error to explain protocol paths are irrelevant, got %q", got)
	}
	if strings.Contains(got, "两条连接路径均失败") {
		t.Fatalf("expected no dual-path failure after probe dial failure, got %q", got)
	}
}

func TestOceanBaseOracleConnectProbeDialFailureMentionsSSHWhenEnabled(t *testing.T) {
	originalDial := oceanBaseProbeDialContext
	t.Cleanup(func() { oceanBaseProbeDialContext = originalDial })

	var seenConfig connection.ConnectionConfig
	var seenAddress string
	oceanBaseProbeDialContext = func(ctx context.Context, config connection.ConnectionConfig, address string) (net.Conn, error) {
		seenConfig = config
		seenAddress = address
		return nil, errors.New("remote dial denied")
	}

	ob := &OceanBaseDB{}
	err := ob.Connect(connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              testOceanBaseOracleHost,
		Port:              testOceanBaseOraclePort,
		User:              testOceanBaseOracleUser,
		Password:          testOceanBaseOraclePassword,
		Database:          testOceanBaseOracleDatabase,
		OceanBaseProtocol: oceanBaseProtocolOracle,
		Timeout:           1,
		UseSSH:            true,
		SSH: connection.SSHConfig{
			Host:     testSSHJumpHost,
			Port:     22,
			User:     testSSHJumpUser,
			Password: testSSHJumpPassword,
		},
	})
	if err == nil {
		t.Fatal("expected connect error for SSH probe dial failure")
	}
	got := err.Error()
	if !seenConfig.UseSSH {
		t.Fatalf("expected probe dialer to receive UseSSH=true, got %+v", seenConfig)
	}
	if seenAddress != "ob-oracle.internal.example:2881" {
		t.Fatalf("expected probe target to remain remote inner address, got %q", seenAddress)
	}
	if !strings.Contains(got, "通过 SSH 跳板机访问目标地址 ob-oracle.internal.example:2881 失败") {
		t.Fatalf("expected SSH-specific network diagnosis, got %q", got)
	}
	if strings.Contains(got, "VPN/内网路由") {
		t.Fatalf("expected SSH diagnosis not direct-client VPN hint, got %q", got)
	}
}

func TestOceanBaseOBClientPreservesSSHHostKeyTrustError(t *testing.T) {
	originalAcquireLocalForwarder := oceanBaseAcquireLocalForwarder
	t.Cleanup(func() { oceanBaseAcquireLocalForwarder = originalAcquireLocalForwarder })

	want := &ssh.HostKeyTrustRequiredError{Status: ssh.HostKeyTrustStatus{
		State:       "unknown",
		Host:        testSSHJumpHost,
		Port:        22,
		Address:     testSSHJumpHost + ":22",
		KeyType:     "ssh-ed25519",
		Fingerprint: "SHA256:untrusted-key",
	}}
	oceanBaseAcquireLocalForwarder = func(connection.SSHConfig, string, int) (*ssh.LocalForwarder, error) {
		return nil, want
	}

	config := connection.ConnectionConfig{
		Type:   "oceanbase",
		Host:   testOceanBaseOracleHost,
		Port:   testOceanBaseOraclePort,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: testSSHJumpHost,
			Port: 22,
			User: testSSHJumpUser,
		},
	}
	for _, connect := range []struct {
		name string
		fn   func(connection.ConnectionConfig) error
	}{
		{name: "OBClient path", fn: (&OceanBaseDB{}).connectOracleViaOBClient},
		{name: "OBClient to TNS fallback", fn: (&OceanBaseDB{}).connectOracleViaOBClientThenTNS},
	} {
		connect := connect
		t.Run(connect.name, func(t *testing.T) {
			err := connect.fn(config)
			if err == nil {
				t.Fatal("expected SSH host-key trust error")
			}

			var got *ssh.HostKeyTrustRequiredError
			if !errors.As(err, &got) {
				t.Fatalf("expected HostKeyTrustRequiredError to remain unwrapable, got %T: %v", err, err)
			}
			if got != want {
				t.Fatalf("unexpected SSH host-key trust error: got %#v, want %#v", got, want)
			}
		})
	}
}

func TestOceanBaseMySQLPathPreservesSSHHostKeyTrustError(t *testing.T) {
	originalRegisterSSHNetwork := oceanBaseRegisterSSHNetwork
	t.Cleanup(func() { oceanBaseRegisterSSHNetwork = originalRegisterSSHNetwork })

	want := &ssh.HostKeyTrustRequiredError{Status: ssh.HostKeyTrustStatus{
		State:       "unknown",
		Host:        testSSHJumpHost,
		Port:        22,
		Address:     testSSHJumpHost + ":22",
		KeyType:     "ssh-ed25519",
		Fingerprint: "SHA256:untrusted-key",
	}}
	oceanBaseRegisterSSHNetwork = func(connection.SSHConfig) (string, error) {
		return "", want
	}

	err := (&OceanBaseDB{}).Connect(connection.ConnectionConfig{
		Type:     "oceanbase",
		Host:     testOceanBaseOracleHost,
		Port:     testOceanBaseOraclePort,
		User:     testOceanBaseOracleUser,
		Password: testOceanBaseOraclePassword,
		UseSSH:   true,
		SSH: connection.SSHConfig{
			Host: testSSHJumpHost,
			Port: 22,
			User: testSSHJumpUser,
		},
	})
	if err == nil {
		t.Fatal("expected SSH host-key trust error")
	}
	var got *ssh.HostKeyTrustRequiredError
	if !errors.As(err, &got) {
		t.Fatalf("expected HostKeyTrustRequiredError to remain unwrapable, got %T: %v", err, err)
	}
	if got != want {
		t.Fatalf("unexpected SSH host-key trust error: got %#v, want %#v", got, want)
	}
}

func TestProbeOceanBaseMySQLWireHandshakeUsesSSHConfiguredDialer(t *testing.T) {
	originalDial := oceanBaseProbeDialContext
	t.Cleanup(func() { oceanBaseProbeDialContext = originalDial })

	var seenConfig connection.ConnectionConfig
	var seenAddress string
	oceanBaseProbeDialContext = func(ctx context.Context, config connection.ConnectionConfig, address string) (net.Conn, error) {
		seenConfig = config
		seenAddress = address
		clientConn, serverConn := net.Pipe()
		go func() {
			defer serverConn.Close()
			_, _ = serverConn.Write(buildMySQLHandshakePacket("5.7.25-OceanBase-v4.2.1.0"))
		}()
		return clientConn, nil
	}

	result := probeOceanBaseMySQLWireHandshakeDetail(connection.ConnectionConfig{
		Host:   testOceanBaseOracleHost,
		Port:   testOceanBaseOraclePort,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: testSSHJumpHost,
			Port: 22,
			User: testSSHJumpUser,
		},
	}, time.Second)

	if !result.probeSucceeded || !result.isOBMySQLWire {
		t.Fatalf("expected SSH-routed probe to detect OceanBase handshake, got %+v", result)
	}
	if !seenConfig.UseSSH {
		t.Fatalf("expected probe dialer to receive SSH config, got %+v", seenConfig)
	}
	if seenAddress != "ob-oracle.internal.example:2881" {
		t.Fatalf("expected remote target address through SSH, got %q", seenAddress)
	}
}

func TestOceanBaseOracleConnectUsesFullSSHTimeoutForProbeDial(t *testing.T) {
	originalDial := oceanBaseProbeDialContext
	t.Cleanup(func() { oceanBaseProbeDialContext = originalDial })

	var observedDialTimeout time.Duration
	oceanBaseProbeDialContext = func(ctx context.Context, config connection.ConnectionConfig, address string) (net.Conn, error) {
		if deadline, ok := ctx.Deadline(); ok {
			observedDialTimeout = time.Until(deadline)
		}
		return nil, errors.New("remote dial denied")
	}

	ob := &OceanBaseDB{}
	err := ob.Connect(connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              testOceanBaseOracleHost,
		Port:              testOceanBaseOraclePort,
		User:              testOceanBaseOracleUser,
		Password:          testOceanBaseOraclePassword,
		Database:          testOceanBaseOracleDatabase,
		OceanBaseProtocol: oceanBaseProtocolOracle,
		Timeout:           12,
		UseSSH:            true,
		SSH: connection.SSHConfig{
			Host: testSSHJumpHost,
			Port: 22,
			User: testSSHJumpUser,
		},
	})
	if err == nil {
		t.Fatal("expected connect error from mocked probe dialer")
	}
	if observedDialTimeout < 10*time.Second {
		t.Fatalf("expected SSH probe dial to use the full configured timeout, got about %s", observedDialTimeout)
	}
}

func TestProbeOceanBaseMySQLWireHandshakeSplitsDialAndReadTimeout(t *testing.T) {
	originalDial := oceanBaseProbeDialContext
	t.Cleanup(func() { oceanBaseProbeDialContext = originalDial })

	var observedDialTimeout time.Duration
	var serverConn net.Conn
	oceanBaseProbeDialContext = func(ctx context.Context, config connection.ConnectionConfig, address string) (net.Conn, error) {
		if deadline, ok := ctx.Deadline(); ok {
			observedDialTimeout = time.Until(deadline)
		}
		clientConn, remoteConn := net.Pipe()
		serverConn = remoteConn
		return clientConn, nil
	}
	t.Cleanup(func() {
		if serverConn != nil {
			_ = serverConn.Close()
		}
	})

	started := time.Now()
	result := probeOceanBaseMySQLWireHandshakeDetailWithTimeouts(connection.ConnectionConfig{
		Host:   testOceanBaseOracleHost,
		Port:   testOceanBaseOraclePort,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: testSSHJumpHost,
			Port: 22,
			User: testSSHJumpUser,
		},
	}, 12*time.Second, 50*time.Millisecond)
	elapsed := time.Since(started)

	if observedDialTimeout < 10*time.Second {
		t.Fatalf("expected probe dial context to keep the long dial timeout, got about %s", observedDialTimeout)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("expected handshake read to use short timeout, elapsed=%s", elapsed)
	}
	if !result.probeSucceeded || !result.tcpReachable {
		t.Fatalf("expected short read timeout to be treated as reachable non-MySQL-wire probe, got %+v", result)
	}
	if result.err == nil {
		t.Fatalf("expected read timeout error to be recorded for diagnostics")
	}
}

// probe 放宽 protocol_version 检查后，普通 MySQL/MariaDB（server_version 不含 OB 关键字）
// 应仍判定为非 OB MySQL wire（由 regular_mysql_is_not_flagged / mariadb_is_not_flagged 子用例
// 覆盖）。原 IgnoresNonMySQLProtocol 测试因 probe 不再严格区分 mysql vs 非 mysql 而失效，已删除。

// probe 在 payload_length 落在新放宽的 65536 上限内仍能正确读取并提取 server_version。
// 模拟 OB 4.x 可能携带额外能力位、payload 略大于历史 MySQL handshake 的情况。
func TestProbeOceanBaseMySQLWireHandshakeAcceptsLargerPayload(t *testing.T) {
	t.Parallel()

	base := buildMySQLHandshakePacket("5.7.25-OceanBase-v4.2.1.0")
	// 在 packet 末尾追加 4096 字节伪能力位扩展，重写 header 的 payload_length 字段
	extra := make([]byte, 4096)
	for i := range extra {
		extra[i] = 0x42
	}
	originalPayload := base[4:]
	enlargedPayload := append(append([]byte{}, originalPayload...), extra...)
	payloadLen := len(enlargedPayload)
	header := []byte{byte(payloadLen), byte(payloadLen >> 8), byte(payloadLen >> 16), 0}
	packet := append(header, enlargedPayload...)

	host, port, cleanup := startMockHandshakeServer(t, packet)
	defer cleanup()

	gotIsOB, probed := probeOceanBaseMySQLWireHandshake(host, port, time.Second)
	if !probed {
		t.Fatal("expected probe to read full packet within new 64KB limit")
	}
	if !gotIsOB {
		t.Fatal("expected enlarged OceanBase handshake to be flagged as OB MySQL wire")
	}
}

// 锁定 Oracle 协议 MySQL-wire 路径使用 oboracle 专用 DSN，并把用户提供的
// connectionAttributes 映射为 obconnector-go 支持的 attr.* 参数。
func TestOceanBaseOracleOBClientDSNUsesDedicatedDriverParams(t *testing.T) {
	t.Parallel()

	cfg := connection.ConnectionConfig{
		Type:             "oceanbase",
		Host:             "127.0.0.1",
		Port:             2881,
		User:             "SYS@oracle_tenant#cluster",
		Password:         "p@ss",
		Database:         "ORCL",
		Timeout:          12,
		ConnectionParams: "connectionAttributes=_client_name:Custom OB,_pid:9527&cap.add=0x80&init=alter+session+set+nls_date_format%3D%27YYYY-MM-DD%27",
	}
	dsn, err := buildOceanBaseOracleOBClientDSN(cfg)
	if err != nil {
		t.Fatalf("buildOceanBaseOracleOBClientDSN error: %v", err)
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("Parse DSN error: %v", err)
	}
	if parsed.Scheme != "oboracle" {
		t.Fatalf("expected oboracle scheme, got %q (dsn=%s)", parsed.Scheme, dsn)
	}
	if parsed.User.Username() != "SYS@oracle_tenant#cluster" {
		t.Fatalf("unexpected user %q", parsed.User.Username())
	}
	password, _ := parsed.User.Password()
	if password != "p@ss" {
		t.Fatalf("unexpected password %q", password)
	}
	query := parsed.Query()
	if query.Get("preset") != "oboracle" {
		t.Fatalf("expected preset=oboracle, got query=%v", query)
	}
	if query.Get("timeout") != "12s" {
		t.Fatalf("expected timeout=12s, got query=%v", query)
	}
	if query.Get("attr._client_name") != "Custom OB" || query.Get("attr._pid") != "9527" {
		t.Fatalf("expected connectionAttributes mapped to attr.*, got query=%v", query)
	}
	if query.Get("cap.add") != "0x80" {
		t.Fatalf("expected cap.add passthrough, got query=%v", query)
	}
	if got := query["init"]; len(got) != 1 || got[0] != "alter session set nls_date_format='YYYY-MM-DD'" {
		t.Fatalf("expected init SQL passthrough, got query=%v", query)
	}
}

// OBClient 路径写操作仍然使用 mysql wire 风格 "?" 占位符 + Oracle 风格双引号引用标识符。
// 注意 bindConnectedDatabase 直接绑 OracleDB wrapper（OracleDB.conn 实际是 mysql wire conn），
// ApplyChanges 会走 applyOracleChangesMySQLWire。
func TestOceanBaseOracleOBClientApplyChangesUsesMySQLWirePlaceholders(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oceanbaseDB := &OceanBaseDB{}
	oceanbaseDB.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolOracle)

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"ID": 7},
			Values: map[string]interface{}{"NAME": "new-name"},
		}},
	}

	if err := oceanbaseDB.ApplyChanges("APP.USERS", changes); err != nil {
		t.Fatalf("ApplyChanges() unexpected error: %v", err)
	}

	queries := state.snapshotExecQueries()
	if len(queries) != 1 {
		t.Fatalf("expected one exec query, got %#v", queries)
	}
	if strings.Contains(queries[0], ":1") {
		t.Fatalf("expected MySQL wire placeholder style, got %q", queries[0])
	}
	if !strings.Contains(queries[0], `"NAME" = ?`) || !strings.Contains(queries[0], `"ID" = ?`) {
		t.Fatalf("expected question mark placeholders + double-quoted identifiers, got %q", queries[0])
	}
}

func TestOceanBaseOracleApplyChangesContextCancelsMySQLWireStatement(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.blockExecUntilCanceled = true
	state.execStarted = make(chan struct{}, 1)
	state.execRelease = make(chan struct{})
	state.mu.Unlock()

	oceanbaseDB := &OceanBaseDB{}
	oceanbaseDB.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolOracle)

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- oceanbaseDB.ApplyChangesContext(ctx, "APP.USERS", connection.ChangeSet{
			Updates: []connection.UpdateRow{{
				Keys:   map[string]interface{}{"ID": 42},
				Values: map[string]interface{}{"NAME": "cancel-me"},
			}},
		})
	}()

	select {
	case <-state.execStarted:
		cancel()
	case <-time.After(time.Second):
		cancel()
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not reach the Oracle-protocol MySQL-wire execution path")
	}

	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("ApplyChangesContext error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}
}

func TestOceanBaseMySQLApplyChangesContextForwardsCancellation(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.blockExecUntilCanceled = true
	state.execStarted = make(chan struct{}, 1)
	state.execRelease = make(chan struct{})
	state.mu.Unlock()

	oceanbaseDB := &OceanBaseDB{}
	oceanbaseDB.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolMySQL)

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- oceanbaseDB.ApplyChangesContext(ctx, "app.orders", connection.ChangeSet{
			Inserts: []map[string]interface{}{{"id": 42, "status": "pending"}},
		})
	}()

	select {
	case <-state.execStarted:
		cancel()
	case <-time.After(time.Second):
		cancel()
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not reach the underlying MySQL context applier")
	}

	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("ApplyChangesContext error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}
}

func TestOceanBaseForwardsUnknownCommitOutcomeFromMySQLApplier(t *testing.T) {
	commitErr := errors.New("commit response lost")
	state := &writeOutcomeTransactionState{commitErr: commitErr}
	database := openWriteOutcomeTransactionDB(t, state)
	oceanbase := &OceanBaseDB{}
	oceanbase.bindConnectedDatabase(database, 0, oceanBaseProtocolMySQL)

	err := oceanbase.ApplyChangesContext(context.Background(), "users", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": int64(1)}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
		t.Fatalf("OceanBase forwarding must preserve the typed MySQL commit outcome, got %v", err)
	}
}

func TestOceanBaseOracleMySQLWireMarksCommitFailureOutcomeUnknown(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	commitErr := errors.New("commit response lost")
	state.mu.Lock()
	state.txCommitErr = commitErr
	state.mu.Unlock()
	oceanbase := &OceanBaseDB{}
	oceanbase.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolOracle)

	err := oceanbase.ApplyChangesContext(context.Background(), "APP.USERS", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"ID": int64(1)}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
		t.Fatalf("OceanBase Oracle MySQL-wire commit failure must mark the outcome unknown, got %v", err)
	}
}

var _ BatchApplierContext = (*OceanBaseDB)(nil)

func TestOceanBaseOracleOBClientApplyChangesFormatsTemporalValuesExplicitly(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oceanbaseDB := &OceanBaseDB{}
	oceanbaseDB.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolOracle)

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"ID": int64(7),
			},
			Values: map[string]interface{}{
				"UPDATED_AT": "2026-06-16 17:37:08",
			},
		}},
	}

	if err := oceanbaseDB.ApplyChanges("APP.USERS", changes); err != nil {
		t.Fatalf("ApplyChanges() unexpected error: %v", err)
	}

	queries := state.snapshotExecQueries()
	if len(queries) != 1 {
		t.Fatalf("expected one exec query, got %#v", queries)
	}
	if !strings.Contains(queries[0], `"UPDATED_AT" = TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS')`) {
		t.Fatalf("expected explicit TO_TIMESTAMP binding for temporal update, got %q", queries[0])
	}

	executions := state.snapshotExecArgs()
	if len(executions) != 1 || len(executions[0]) != 2 {
		t.Fatalf("unexpected exec args: %#v", executions)
	}
	if got, ok := executions[0][0].Value.(string); !ok || got != "2026-06-16 17:37:08" {
		t.Fatalf("expected temporal bind arg kept as canonical string, got %#v (%T)", executions[0][0].Value, executions[0][0].Value)
	}
}

func TestOceanBaseOracleOBClientApplyChangesFormatsAllColumnsTemporalWhereValuesExplicitly(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oceanbaseDB := &OceanBaseDB{}
	oceanbaseDB.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolOracle)

	changes := connection.ChangeSet{
		LocatorStrategy: "all-columns",
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"CREATED_AT": "2026-07-13",
				"UPDATED_AT": "2026-07-13 13:42:00.123456",
			},
			Values: map[string]interface{}{
				"STATUS": "0",
			},
		}},
	}

	if err := oceanbaseDB.ApplyChanges("APP.USERS", changes); err != nil {
		t.Fatalf("ApplyChanges() unexpected error: %v", err)
	}

	queries := state.snapshotExecQueries()
	if len(queries) != 1 {
		t.Fatalf("expected one exec query, got %#v", queries)
	}
	query := queries[0]
	if !strings.Contains(query, `"CREATED_AT" = TO_DATE(?, 'YYYY-MM-DD')`) {
		t.Fatalf("expected explicit TO_DATE binding in all-columns WHERE, got %q", query)
	}
	if !strings.Contains(query, `"UPDATED_AT" = TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS.FF')`) {
		t.Fatalf("expected explicit TO_TIMESTAMP binding in all-columns WHERE, got %q", query)
	}
}

func TestOceanBaseOracleGetCreateStatementFallsBackToShowCreateTable(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.queryResults[`SHOW CREATE TABLE "SYS"."test"`] = oracleRecordingQueryResult{
		columns: []string{"Create Table"},
		rows: [][]driver.Value{
			{`CREATE TABLE "SYS"."test" ("ID" NUMBER)`},
		},
	}
	state.mu.Unlock()

	oceanbaseDB := &OceanBaseDB{}
	oceanbaseDB.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolOracle)

	ddl, err := oceanbaseDB.GetCreateStatement("SYS", "test")
	if err != nil {
		t.Fatalf("GetCreateStatement() unexpected error: %v", err)
	}
	if !strings.Contains(ddl, `CREATE TABLE "SYS"."test"`) {
		t.Fatalf("expected SHOW CREATE TABLE DDL, got: %s", ddl)
	}

	queries := state.snapshotQueries()
	if len(queries) < 3 {
		t.Fatalf("expected DBMS_METADATA attempts followed by SHOW CREATE TABLE, got: %v", queries)
	}
	if queries[0] != `SELECT DBMS_METADATA.GET_DDL('TABLE', 'test', 'SYS') as ddl FROM DUAL` {
		t.Fatalf("expected original-case DBMS_METADATA first, got: %v", queries)
	}
	if !slices.Contains(queries, `SHOW CREATE TABLE "SYS"."test"`) {
		t.Fatalf("expected SHOW CREATE TABLE fallback, got: %v", queries)
	}
}

func TestOceanBaseOracleCreateStatementFallbackErrorUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	defer SetBackendLanguage(i18n.LanguageZhCN)

	dbConn, _ := openOracleRecordingDB(t)
	oceanbaseDB := &OceanBaseDB{}
	oceanbaseDB.bindConnectedDatabase(dbConn, 0, oceanBaseProtocolOracle)

	_, err := oceanbaseDB.GetCreateStatement("SYS", "test")
	if err == nil {
		t.Fatal("GetCreateStatement() expected error")
	}

	message := err.Error()
	if strings.Contains(message, "未找到建表语句") || strings.Contains(message, "兜底失败") {
		t.Fatalf("expected localized English fallback error, got %q", message)
	}
	if !strings.Contains(message, "The CREATE TABLE statement was not found") {
		t.Fatalf("expected localized create-table-not-found detail, got %q", message)
	}
	if !strings.Contains(message, "OceanBase Oracle SHOW CREATE TABLE fallback failed") {
		t.Fatalf("expected localized fallback wrapper, got %q", message)
	}
}

// 用户通过 ConnectionParams 设置 connectionAttributes 时，OceanBase MySQL wire 路径必须把
// 这些 attribute 透传到 go-sql-driver/mysql DSN，让 driver 在握手响应里发 CLIENT_CONNECT_ATTRS。
// 这是 OBClient 协议握手探索的入口：高级用户/DBA 可以试错不同 attribute 组合而不需要改 GoNavi 代码。
func TestOceanBaseMySQLDSNPassesThroughConnectionAttributes(t *testing.T) {
	t.Parallel()

	cfg := connection.ConnectionConfig{
		Type:             "oceanbase",
		Host:             "127.0.0.1",
		Port:             2881,
		User:             "root@mysql_tenant",
		Password:         "root",
		Database:         "test",
		ConnectionParams: "connectionAttributes=_client_name:OceanBase Connector/J,_client_version:2.4.5",
	}
	ob := &OceanBaseDB{}
	dsn, err := ob.getDSN(cfg)
	if err != nil {
		t.Fatalf("getDSN error: %v", err)
	}
	parsed, err := mysqlDriver.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("mysql ParseDSN failed: %v", err)
	}
	if !strings.Contains(parsed.ConnectionAttributes, "_client_name:OceanBase Connector/J") {
		t.Fatalf("expected _client_name attribute in DSN, got %q", parsed.ConnectionAttributes)
	}
	if !strings.Contains(parsed.ConnectionAttributes, "_client_version:2.4.5") {
		t.Fatalf("expected _client_version attribute in DSN, got %q", parsed.ConnectionAttributes)
	}
}

func TestOceanBaseMySQLBatchWriteCapabilityTracksConnectedDSN(t *testing.T) {
	oceanBase := &OceanBaseDB{}
	oceanBase.setMySQLBatchWritesFromDSN("user:pass@tcp(localhost:2881)/app?multiStatements=true")
	if !oceanBase.SupportsBatchWrites() {
		t.Fatal("OceanBase MySQL multiStatements=true connection should allow batch writes")
	}

	oceanBase.setMySQLBatchWritesFromDSN("user:pass@tcp(localhost:2881)/app?multiStatements=false")
	if oceanBase.SupportsBatchWrites() {
		t.Fatal("OceanBase MySQL multiStatements=false connection must disable batch writes")
	}
}

// 当用户错选 MySQL 协议但租户实际是 Oracle 模式时，OceanBase 服务端返回 Error 1235，
// 我们必须在错误消息里明确指引用户切换协议，避免方向摇摆。
func TestFormatOceanBaseMySQLAttemptErrorHintsOracleProtocol(t *testing.T) {
	t.Parallel()

	got := formatOceanBaseMySQLAttemptError(
		"127.0.0.1:2881",
		errors.New("Error 1235 (0A000): Oracle tenant for current client driver is not supported"),
	)
	if !strings.Contains(got, "切换为 Oracle") {
		t.Fatalf("expected Oracle protocol hint, got %q", got)
	}
	if !strings.Contains(got, "主机和端口可保持不变") {
		t.Fatalf("expected hint to mention OBClient/MySQL-wire host and port can be kept, got %q", got)
	}
	if !strings.Contains(got, "只有连接 OBProxy Oracle listener/TNS 入口时才需要填写服务名") {
		t.Fatalf("expected hint to limit Service Name requirement to TNS path, got %q", got)
	}
}
