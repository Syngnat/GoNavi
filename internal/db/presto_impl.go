//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultPrestoPort   = 8080
	defaultPrestoSource = "GoNavi"
	prestoVersionQuery  = "SELECT node_version FROM system.runtime.nodes WHERE coordinator = true"
	// prestoOffsetSessionProperty 打开 PrestoDB 0.257 起支持、但默认关闭的 OFFSET 子句。
	prestoOffsetSessionProperty = "offset_clause_enabled"
)

// prestoOffsetMode 决定数据浏览分页生成的 OFFSET n LIMIT m 怎么执行。
type prestoOffsetMode int

const (
	// prestoOffsetNative：服务端原生支持（PrestoSQL 310+）或由会话属性打开（PrestoDB 0.257+）。
	prestoOffsetNative prestoOffsetMode = iota
	// prestoOffsetEmulated：服务端没有 OFFSET，改写为 LIMIT n+m 后在客户端丢弃前 n 行。
	prestoOffsetEmulated
)

// PrestoDB 通过 Presto 客户端 HTTP 协议访问 PrestoDB（0.x）与 PrestoSQL（300–350，Trino 改名前）。
// 库对应 catalog.schema，与 Trino 的命名空间约定一致；连接配置里的 Database 是默认命名空间。
type PrestoDB struct {
	driverVariantState
	client *prestoClient
	// session 是普通查询与编辑器语句共用的会话（USE、SET SESSION 等会改变它）；
	// metaSession 固定使用连接配置的命名空间，元数据查询不受用户语句影响。
	session     *prestoSession
	metaSession *prestoSession
	catalog     string
	schema      string
	offsetMode  prestoOffsetMode
	forwarder   *ssh.LocalForwarder
}

var (
	_ Database              = (*PrestoDB)(nil)
	_ QueryContexter        = (*PrestoDB)(nil)
	_ ExecContexter         = (*PrestoDB)(nil)
	_ StreamQueryExecer     = (*PrestoDB)(nil)
	_ QueryArgsContexter    = (*PrestoDB)(nil)
	_ ExecArgsContexter     = (*PrestoDB)(nil)
	_ SessionExecerProvider = (*PrestoDB)(nil)
	_ DriverVariantReporter = (*PrestoDB)(nil)
)

// Connect 先识别服务端版本（/v1/info，取不到时查 system.runtime.nodes），按版本确定档位与会话属性，
// 再执行 SELECT 1 校验凭据与会话属性（/v1/info 通常不需要认证）。
func (p *PrestoDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = p.Close()
	defer func() {
		if err != nil {
			_ = p.Close()
		}
	}()

	runConfig := normalizeRegistryHTTPConfig(config, defaultPrestoPort, "presto", "prestodb")
	params := registryHTTPConnectionParams(runConfig, "presto", "prestodb")
	user := strings.TrimSpace(runConfig.User)
	if user == "" {
		return localizedDatabaseRuntimeError("db.backend.error.presto_user_required", nil)
	}
	token := firstNonEmptyParam(params, "accessToken", "access_token", "token")
	if runConfig.Password != "" && token == "" && !runConfig.UseSSL {
		return localizedDatabaseRuntimeError("db.backend.error.presto_password_requires_https", nil)
	}
	serverName := strings.TrimSpace(runConfig.Host)
	if runConfig.UseSSH {
		if runConfig, p.forwarder, err = forwardRegistryHTTPThroughSSH(runConfig, "Presto"); err != nil {
			return err
		}
	}
	httpClient, err := buildPrestoHTTPClient(runConfig, serverName, p.forwarder != nil)
	if err != nil {
		return err
	}

	database := runConfig.Database
	if strings.TrimSpace(database) == "" {
		database = prestoURIPath(runConfig.URI)
	}
	p.catalog, p.schema = prestoNamespace(database, params)
	p.session = newPrestoSession(p.catalog, p.schema)
	p.metaSession = newPrestoSession(p.catalog, p.schema)
	p.metaSession.fixed = true
	p.client = &prestoClient{
		http:       httpClient,
		baseURL:    registryHTTPBaseURL(runConfig),
		user:       user,
		headers:    prestoFixedHeaders(user, runConfig.Password, token, params),
		properties: prestoSessionProperties(params),
	}

	ctx, cancel := context.WithTimeout(context.Background(), getConnectTimeout(runConfig))
	defer cancel()
	version, err := p.detectVersion(ctx)
	if err != nil {
		return err
	}
	if err := p.resolve("presto", config, version); err != nil {
		return err
	}
	p.applyVariant()
	_, err = p.client.execute(ctx, p.metaSession, "SELECT 1", nil, nil)
	return err
}

// buildPrestoHTTPClient 复用描述表 HTTP 客户端；经 SSH 转发时地址变成本机端口，证书仍按原主机名校验。
func buildPrestoHTTPClient(config connection.ConnectionConfig, serverName string, forwarded bool) (*http.Client, error) {
	client := buildRegistryHTTPClient(config)
	if !config.UseSSL {
		return client, nil
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		if forwarded && serverName != "" {
			tlsConfig.ServerName = serverName
		}
		if transport, ok := client.Transport.(*http.Transport); ok {
			transport.TLSClientConfig = tlsConfig
		}
	}
	return client, nil
}

// prestoNamespace 取默认 catalog.schema：Database 支持 catalog.schema 与 catalog/schema（JDBC 路径），
// 都没有时用连接参数里的 catalog、schema。
func prestoNamespace(database string, params url.Values) (string, string) {
	text := strings.Trim(strings.TrimSpace(database), "/")
	if text != "" {
		separator := "."
		if strings.Contains(text, "/") {
			separator = "/"
		}
		catalog, schema, _ := strings.Cut(text, separator)
		return strings.TrimSpace(catalog), strings.TrimSpace(schema)
	}
	return strings.TrimSpace(params.Get("catalog")), strings.TrimSpace(params.Get("schema"))
}

// prestoURIPath 取连接串路径里的命名空间（/catalog/schema 或 /catalog.schema，JDBC 连接串同样适用）。
func prestoURIPath(uri string) string {
	text := strings.TrimSpace(uri)
	if len(text) > len("jdbc:") && strings.EqualFold(text[:len("jdbc:")], "jdbc:") {
		text = text[len("jdbc:"):]
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return ""
	}
	return strings.Trim(parsed.Path, "/")
}

// prestoFixedHeaders 是每个请求都带的头：认证（访问令牌优先，其次 HTTPS 上的用户名密码）、来源、客户端标签、时区与 header.* 自定义头。
func prestoFixedHeaders(user, password, token string, params url.Values) map[string]string {
	headers := registryHTTPHeaderParams(params)
	switch {
	case token != "":
		headers["Authorization"] = "Bearer " + token
	case password != "":
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
	}
	headers["X-Presto-Source"] = defaultPrestoSource
	if source := firstNonEmptyParam(params, "source"); source != "" {
		headers["X-Presto-Source"] = source
	}
	for header, names := range map[string][]string{
		"X-Presto-Client-Tags": {"clientTags", "client_tags"},
		"X-Presto-Client-Info": {"clientInfo", "client_info"},
		"X-Presto-Time-Zone":   {"timeZone", "time_zone", "timezone"},
		"X-Presto-Language":    {"locale", "language"},
	} {
		if value := firstNonEmptyParam(params, names...); value != "" {
			headers[header] = value
		}
	}
	headers["User-Agent"] = "GoNavi-Presto"
	return headers
}

// prestoSessionProperties 读取连接级会话属性：session_properties=a=1,b=2（也接受 trino-go-client 的 a:1;b:2）
// 与 session.<名称>=<值>。
func prestoSessionProperties(params url.Values) map[string]string {
	properties := map[string]string{}
	for _, entry := range strings.FieldsFunc(firstNonEmptyParam(params, "session_properties", "sessionProperties"), func(r rune) bool {
		return r == ',' || r == ';'
	}) {
		index := strings.IndexAny(entry, "=:")
		if index <= 0 {
			continue
		}
		if name := strings.TrimSpace(entry[:index]); name != "" {
			properties[name] = strings.TrimSpace(entry[index+1:])
		}
	}
	for name, values := range params {
		if len(name) > len("session.") && strings.EqualFold(name[:len("session.")], "session.") && len(values) > 0 {
			properties[strings.TrimSpace(name[len("session."):])] = strings.TrimSpace(values[0])
		}
	}
	return properties
}

// detectVersion 读取协调节点版本：PrestoDB 是 0.289 这样的版本号，PrestoSQL 是 350 这样的整数。
// /v1/info 取不到时（被网关拦截等）查 system.runtime.nodes；此时档位相关的会话属性还没有加上。
func (p *PrestoDB) detectVersion(ctx context.Context) (string, error) {
	if version := p.serverInfoVersion(ctx); version != "" {
		return version, nil
	}
	collector := &prestoSingleColumn{}
	if _, err := p.client.execute(ctx, p.metaSession, prestoVersionQuery, nil, collector); err != nil {
		return "", err
	}
	if len(collector.values) == 0 {
		return "", nil
	}
	return strings.TrimSpace(collector.values[0]), nil
}

func (p *PrestoDB) serverInfoVersion(ctx context.Context) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.client.baseURL+"/v1/info", nil)
	if err != nil {
		return ""
	}
	for name, value := range p.client.pollHeaders() {
		req.Header[name] = value
	}
	res, err := p.client.http.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return ""
	}
	var payload struct {
		NodeVersion struct {
			Version string `json:"version"`
		} `json:"nodeVersion"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	return strings.TrimSpace(payload.NodeVersion.Version)
}

// applyVariant 按档位设置协议差异：PrestoDB 0.257+ 用会话属性打开 OFFSET，更早的版本与 PrestoSQL 310 之前
// 在客户端模拟 OFFSET；PrestoSQL 声明客户端能力，让服务端按列的实际精度返回时间值。
func (p *PrestoDB) applyVariant() {
	p.offsetMode = prestoOffsetNative
	switch p.variant.ID {
	case "prestosql":
		p.client.headers["X-Presto-Client-Capabilities"] = "PATH,PARAMETRIC_DATETIME"
		if !p.atLeast("310") {
			p.offsetMode = prestoOffsetEmulated
		}
	case "prestodb":
		if !p.atLeast("0.257") {
			p.offsetMode = prestoOffsetEmulated
		} else if _, set := p.client.properties[prestoOffsetSessionProperty]; !set {
			p.client.properties[prestoOffsetSessionProperty] = "true"
		}
	default:
		p.offsetMode = prestoOffsetEmulated
	}
}

func (p *PrestoDB) Close() error {
	releaseRegistryHTTPForwarder(p.forwarder, "Presto")
	p.forwarder = nil
	p.client = nil
	p.session = nil
	p.metaSession = nil
	return nil
}

func (p *PrestoDB) Ping() error {
	if p.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := p.client.execute(ctx, p.metaSession, "SELECT 1", nil, nil)
	return err
}
