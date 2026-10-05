package db

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

type OptionalDriverAgentDB struct {
	driverType         string
	client             *optionalDriverAgentClient
	kingbaseSearchPath string
	pingTimeout        time.Duration
	serverMajor        int
	// driverVariant / serverVersion 由描述表数据源的代理在 connect 时回报。
	driverVariant string
	serverVersion string
}

var _ DriverVariantReporter = (*OptionalDriverAgentDB)(nil)

// DriverVariantInfo 返回代理回报的驱动版本档位与服务端版本；历史驱动的代理不回报，均为空串。
func (d *OptionalDriverAgentDB) DriverVariantInfo() (string, string) {
	if d == nil {
		return "", ""
	}
	return d.driverVariant, d.serverVersion
}

func (d *OptionalDriverAgentDB) ElasticsearchServerMajor() int {
	if d == nil || !IsElasticsearchFamily(d.driverType) {
		return 0
	}
	return d.serverMajor
}

type optionalDriverAgentTransactionalDB struct {
	*OptionalDriverAgentDB
}

func (d *optionalDriverAgentTransactionalDB) bindMetadataContext(ctx context.Context) {
	if d == nil || d.OptionalDriverAgentDB == nil {
		return
	}
	BindMetadataContext(d.OptionalDriverAgentDB, ctx)
}

func (d *optionalDriverAgentTransactionalDB) clearMetadataContext() {
	if d == nil || d.OptionalDriverAgentDB == nil {
		return
	}
	ClearMetadataContext(d.OptionalDriverAgentDB)
}

type optionalDriverAgentSession struct {
	client    *optionalDriverAgentClient
	driver    string
	sessionID string
	mu        sync.Mutex
	closed    bool
}

type optionalDriverAgentTransaction struct {
	*optionalDriverAgentSession
	finishMu sync.Mutex
	finished bool
}

var _ TransactionExecerProvider = (*optionalDriverAgentTransactionalDB)(nil)

var _ TransactionExecer = (*optionalDriverAgentTransaction)(nil)

func newOptionalDriverAgentDatabase(driverType string) databaseFactory {
	normalized := normalizeRuntimeDriverType(driverType)
	return func() Database {
		return &OptionalDriverAgentDB{driverType: normalized}
	}
}

func newOptionalDriverAgentTransactionalDatabase(driverType string) databaseFactory {
	normalized := normalizeRuntimeDriverType(driverType)
	return func() Database {
		return &optionalDriverAgentTransactionalDB{
			OptionalDriverAgentDB: &OptionalDriverAgentDB{driverType: normalized},
		}
	}
}

func (d *OptionalDriverAgentDB) Connect(config connection.ConnectionConfig) error {
	d.kingbaseSearchPath = ""
	d.serverMajor = 0
	d.driverVariant, d.serverVersion = "", ""
	if d.client != nil {
		_ = d.client.close()
		d.client = nil
	}

	agentKey := RegistryAgentKeyForConfig(d.driverType, config.DriverVariant)
	executablePath, err := resolveOptionalDriverAgentExecutableForConfig(d.driverType, config)
	if err != nil {
		return err
	}
	logger.Infof("%s 驱动代理路径：%s", driverDisplayName(agentKey), executablePath)
	client, err := newOptionalDriverAgentClient(agentKey, executablePath, agentClientLibraryEnv(d.driverType, config)...)
	if err != nil {
		return err
	}
	connectTimeout := getConnectTimeout(config)
	var connectionInfo optionalAgentConnectionInfo
	request := newOptionalAgentConnectRequest(config)
	if config.UseSSH {
		request.sshProgressReporter = func(event connection.SSHProgressEvent) {
			config.SSH.ReportProgress(event.Stage, event.Status)
		}
	}
	if err := client.callWithTimeout(request, &connectionInfo, nil, nil, nil, connectTimeout); err != nil {
		_ = client.close()
		return err
	}
	d.client = client
	d.pingTimeout = connectTimeout
	d.serverMajor = connectionInfo.ElasticsearchServerMajor
	d.driverVariant, d.serverVersion = connectionInfo.DriverVariant, connectionInfo.ServerVersion
	client.setConnectionCapabilities(connectionInfo)
	d.ensureKingbaseSearchPath(config)
	return nil
}

func (d *OptionalDriverAgentDB) Close() error {
	d.serverMajor = 0
	if d.client == nil {
		return nil
	}
	client := d.client
	d.client = nil
	_ = client.callWithTimeout(
		optionalAgentRequest{Method: optionalAgentMethodClose},
		nil,
		nil,
		nil,
		nil,
		client.shutdownCallTimeout(),
	)
	return client.close()
}

func (d *OptionalDriverAgentDB) Ping() error {
	timeout := d.pingTimeout
	if timeout <= 0 {
		timeout = optionalAgentControlCallTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return d.PingContext(ctx)
}

func (d *OptionalDriverAgentDB) PingContext(ctx context.Context) error {
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	return client.callContext(ctx, optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil)
}

func (d *OptionalDriverAgentDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	data, fields, _, err := d.QueryContextWithMessages(ctx, query)
	return data, fields, err
}

// AttachExternalDatabase 通过驱动代理转发外部数据源附加（issue #1270）；
// 附加状态保存在代理进程内，随连接关闭消失。
func (d *OptionalDriverAgentDB) AttachExternalDatabase(ctx context.Context, spec ExternalAttachSpec) error {
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:     optionalAgentMethodAttachExternalDatabase,
		TimeoutMs:  timeoutMsFromContext(ctx),
		AttachSpec: &spec,
	}, nil, nil, nil, nil); err != nil {
		return wrapOptionalAgentExternalAttachError(err)
	}
	return nil
}

// DetachExternalDatabase 通过驱动代理转发卸载；代理进程内未附加时返回
// ErrExternalAttachNotAttached，保持与进程内驱动一致的幂等语义。
func (d *OptionalDriverAgentDB) DetachExternalDatabase(ctx context.Context, alias string) error {
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	if err := client.callContext(ctx, optionalAgentRequest{
		TimeoutMs: timeoutMsFromContext(ctx),
		Method:    optionalAgentMethodDetachExternalDatabase,
		Alias:     alias,
	}, nil, nil, nil, nil); err != nil {
		return wrapOptionalAgentExternalAttachError(err)
	}
	return nil
}

// ListExternalAttachments 通过驱动代理查询当前会话的附加关系列表。
func (d *OptionalDriverAgentDB) ListExternalAttachments(ctx context.Context) ([]ExternalAttachmentInfo, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var attachments []ExternalAttachmentInfo
	if err := client.callContext(ctx, optionalAgentRequest{
		TimeoutMs: timeoutMsFromContext(ctx),
		Method:    optionalAgentMethodListExternalAttachments,
	}, &attachments, nil, nil, nil); err != nil {
		return nil, err
	}
	return attachments, nil
}

// wrapOptionalAgentExternalAttachError 还原代理侧的“别名未附加”哨兵，
// 使 App 层的 errors.Is 幂等判定在代理形态下同样成立。
func wrapOptionalAgentExternalAttachError(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), ErrExternalAttachNotAttached.Error()) {
		return fmt.Errorf("%w", ErrExternalAttachNotAttached)
	}
	return err
}

// 编译期守卫：代理实现可选附加接口。
var _ ExternalDatabaseAttacher = (*OptionalDriverAgentDB)(nil)

var _ ExternalAttachmentLister = (*OptionalDriverAgentDB)(nil)

func (d *OptionalDriverAgentDB) ExecuteElasticsearchConsoleRequest(ctx context.Context, request ElasticsearchConsoleRequest) (ElasticsearchConsoleResponse, error) {
	if !IsElasticsearchFamily(d.driverType) {
		return ElasticsearchConsoleResponse{}, fmt.Errorf("当前驱动不支持 Elasticsearch Console")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return ElasticsearchConsoleResponse{}, err
	}
	client, err := d.requireClient()
	if err != nil {
		return ElasticsearchConsoleResponse{}, err
	}
	var response ElasticsearchConsoleResponse
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:               optionalAgentMethodElasticsearchConsole,
		ElasticsearchRequest: &request,
		TimeoutMs:            timeoutMsFromContext(ctx),
	}, &response, nil, nil, nil); err != nil {
		return ElasticsearchConsoleResponse{}, err
	}
	return response, nil
}

func (d *OptionalDriverAgentDB) ElasticsearchConsoleTransportUsable() bool {
	client := d.client
	return client != nil && client.stoppedError() == nil
}

func (d *OptionalDriverAgentDB) Query(query string) ([]map[string]interface{}, []string, error) {
	data, fields, _, err := d.QueryContextWithMessages(metadataContextFor(d), query)
	return data, fields, err
}

func (d *OptionalDriverAgentDB) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return d.QueryContextWithMessages(metadataContextFor(d), query)
}

func (d *OptionalDriverAgentDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	results, _, err := d.QueryMultiWithMessages(query)
	return results, err
}

func (d *OptionalDriverAgentDB) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, err
	}
	var results []connection.ResultSetData
	var messages []string
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodQueryMulti,
		Query:  query,
	}, &results, nil, &messages, nil); err != nil {
		if isOptionalAgentMultiResultUnsupportedError(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	return results, messages, nil
}

func (d *OptionalDriverAgentDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return d.StreamQueryContext(context.Background(), query, consumer)
}

func (d *OptionalDriverAgentDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	err = client.callStreamQueryContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodStreamQuery,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, consumer)
	if isOptionalAgentStreamUnsupportedError(err) {
		logger.Warnf("%s 驱动代理暂不支持流式查询，回退到缓冲模式：err=%v", driverDisplayName(d.driverType), err)
		data, columns, queryErr := d.QueryContext(ctx, query)
		if queryErr != nil {
			return queryErr
		}
		if err := consumer.SetColumns(columns); err != nil {
			return err
		}
		for _, row := range data {
			if err := consumer.ConsumeRow(row); err != nil {
				return err
			}
		}
		return nil
	}
	return err
}

func (d *OptionalDriverAgentDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	client, err := d.requireClient()
	if err != nil {
		return 0, err
	}
	var affected int64
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodExec,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, nil, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (d *OptionalDriverAgentDB) Exec(query string) (int64, error) {
	client, err := d.requireClient()
	if err != nil {
		return 0, err
	}
	var affected int64
	if err := client.call(optionalAgentRequest{
		Method: optionalAgentMethodExec,
		Query:  query,
	}, nil, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (d *OptionalDriverAgentDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var sessionID string
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodOpenSession,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, &sessionID, nil, nil, nil); err != nil {
		return nil, err
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("%s 驱动代理未返回事务会话 ID", driverDisplayName(d.driverType))
	}
	session := &optionalDriverAgentSession{
		client:    client,
		driver:    d.driverType,
		sessionID: sessionID,
	}
	if searchPath := strings.TrimSpace(d.kingbaseSearchPath); searchPath != "" {
		if _, err := session.ExecContext(ctx, fmt.Sprintf("SET search_path TO %s", searchPath)); err != nil {
			_ = session.Close()
			return nil, fmt.Errorf("人大金仓会话初始化 search_path 失败：%w", err)
		}
	}
	return session, nil
}
