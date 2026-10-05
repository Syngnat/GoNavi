//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultInfluxDBPort         = 8086
	defaultInfluxDBQueryTimeout = 60 * time.Second
	influxSchemaCacheTTL        = 15 * time.Second
	// influxTimeColumn 是每个 measurement 的时间列；它与全部 tag 一起构成点的身份（series key + 时间）。
	influxTimeColumn = "time"
)

// InfluxDB 通过 HTTP API 访问 InfluxDB 1.x / 2.x / 3.x。三个大版本都提供 v1 兼容的 /query（InfluxQL），
// 元数据统一用它读取；2.x 另支持 Flux，3.x 原生查询语言是 SQL。库对应 1.x 的 database、2.x 的 bucket、
// 3.x 的 database，表对应 measurement。连接配置里的 Database 是当前库（导航树选中的库会写入这里）。
type InfluxDB struct {
	driverVariantState
	client    *http.Client
	baseURL   string
	headers   map[string]string
	org       string
	database  string
	forwarder *ssh.LocalForwarder

	schemaMu    sync.Mutex
	schemaCache map[string]influxMeasurementSchema
}

var (
	_ Database              = (*InfluxDB)(nil)
	_ BatchApplierContext   = (*InfluxDB)(nil)
	_ QueryContexter        = (*InfluxDB)(nil)
	_ ExecContexter         = (*InfluxDB)(nil)
	_ DriverVariantReporter = (*InfluxDB)(nil)
)

// Connect 用 /ping 识别版本（1.x / 2.x 在响应头，3.x 在响应体），再按版本发一个需要认证的请求校验凭据。
func (x *InfluxDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = x.Close()
	defer func() {
		if err != nil {
			_ = x.Close()
		}
	}()

	runConfig := normalizeRegistryHTTPConfig(config, defaultInfluxDBPort, "influxdb", "influx")
	if runConfig.UseSSH {
		if runConfig, x.forwarder, err = forwardRegistryHTTPThroughSSH(runConfig, "InfluxDB"); err != nil {
			return err
		}
	}
	params := registryHTTPConnectionParams(runConfig, "influxdb", "influx")
	x.baseURL = registryHTTPBaseURL(runConfig)
	x.client = buildRegistryHTTPClient(runConfig)
	x.headers = influxAuthHeaders(runConfig, params)
	x.org = strings.TrimSpace(params.Get("org"))
	x.database = strings.TrimSpace(runConfig.Database)
	if x.database == "" {
		x.database = strings.TrimSpace(firstNonEmptyParam(params, "db", "bucket", "database"))
	}

	ctx, cancel := context.WithTimeout(context.Background(), getConnectTimeout(runConfig))
	defer cancel()
	version, err := x.detectVersion(ctx)
	if err != nil {
		return err
	}
	if err := x.resolve("influxdb", config, version); err != nil {
		return err
	}
	if err := x.verifyCredentials(ctx); err != nil {
		return err
	}
	if x.isV2() && x.org == "" {
		x.org = x.detectSingleOrg(ctx)
	}
	return nil
}

// influxAuthHeaders：填了用户名时用 Basic（1.x 用户、2.x 的 v1 兼容认证），只填密码或 token 参数时用 Token
// （2.x / 3.x 的 API token；3.x 同时接受 Token 与 Bearer）。header.<名称> 参数原样带上。
func influxAuthHeaders(config connection.ConnectionConfig, params map[string][]string) map[string]string {
	headers := registryHTTPHeaderParams(params)
	token := ""
	for _, name := range []string{"token", "apiToken", "authToken"} {
		if values := params[name]; len(values) > 0 && strings.TrimSpace(values[0]) != "" {
			token = strings.TrimSpace(values[0])
			break
		}
	}
	user := strings.TrimSpace(config.User)
	switch {
	case token != "":
		headers["Authorization"] = "Token " + token
	case user != "":
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+config.Password))
	case config.Password != "":
		headers["Authorization"] = "Token " + strings.TrimSpace(config.Password)
	}
	return headers
}

func (x *InfluxDB) detectVersion(ctx context.Context) (string, error) {
	status, header, body, err := x.request(ctx, http.MethodGet, "/ping", nil, nil)
	if err != nil {
		return "", err
	}
	if status >= 400 {
		return "", x.httpError(http.MethodGet, "/ping", status, body)
	}
	if version := strings.TrimPrefix(strings.TrimSpace(header.Get("X-Influxdb-Version")), "v"); version != "" {
		return version, nil
	}
	var payload struct {
		Version string `json:"version"`
	}
	_ = json.Unmarshal(body, &payload)
	return strings.TrimPrefix(strings.TrimSpace(payload.Version), "v"), nil
}

// verifyCredentials 发一个需要认证的只读请求：/ping 在三个版本上都不校验凭据。
func (x *InfluxDB) verifyCredentials(ctx context.Context) error {
	switch {
	case x.isV3():
		_, err := x.listV3Databases(ctx)
		return err
	case x.isV2():
		_, err := x.listBuckets(ctx, 1)
		if err == nil || x.headers["Authorization"] == "" || !strings.HasPrefix(x.headers["Authorization"], "Basic ") {
			return err
		}
		// Basic 只对 v1 兼容接口有效，退回 SHOW DATABASES 校验。
		_, err = x.influxQL(ctx, "", "SHOW DATABASES", false)
		return err
	default:
		_, err := x.influxQL(ctx, "", "SHOW DATABASES", false)
		return err
	}
}

// detectSingleOrg 在没指定 org 时取 token 唯一能访问的组织；有多个组织时留空，需要 org 的接口再提示设置。
func (x *InfluxDB) detectSingleOrg(ctx context.Context) string {
	var payload struct {
		Orgs []struct {
			Name string `json:"name"`
		} `json:"orgs"`
	}
	if err := x.doJSON(ctx, http.MethodGet, "/api/v2/orgs?limit=2", nil, &payload); err != nil || len(payload.Orgs) != 1 {
		return ""
	}
	return payload.Orgs[0].Name
}

func (x *InfluxDB) Close() error {
	releaseRegistryHTTPForwarder(x.forwarder, "InfluxDB")
	x.forwarder = nil
	x.client = nil
	x.schemaMu.Lock()
	x.schemaCache = nil
	x.schemaMu.Unlock()
	return nil
}

func (x *InfluxDB) Ping() error {
	if x.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return x.verifyCredentials(ctx)
}

func (x *InfluxDB) isV2() bool { return x.atLeast("2.0") && !x.atLeast("3.0") }

func (x *InfluxDB) isV3() bool { return x.atLeast("3.0") }
