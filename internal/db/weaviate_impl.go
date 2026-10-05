//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"context"
	"net/http"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultWeaviatePort         = 8080
	weaviateDefaultNamespace    = "default"
	defaultWeaviateQueryTimeout = 60 * time.Second
	// weaviatePageSize 是逐页读取对象时每次 Get 的条数；SELECT 没写 LIMIT 时读取全部对象。
	weaviatePageSize = 1000
	// weaviateMaxNamespaces 限制导航树列出的租户数量，租户上万的集合不在树上逐个展开。
	weaviateMaxNamespaces  = 1000
	weaviateSchemaCacheTTL = 15 * time.Second

	// 合成列：对象 ID、时间戳与向量不在 properties 里，查询结果与网格编辑都按这些列名对应。
	weaviateIDColumn      = "_id"
	weaviateCreatedColumn = "_creationTimeUnix"
	weaviateUpdatedColumn = "_lastUpdateTimeUnix"
	weaviateVectorColumn  = "_vector"
	weaviateVectorsColumn = "_vectors"
)

// WeaviateDB 通过 REST 与 GraphQL 访问 Weaviate。集合（class）对应表；多租户集合的租户映射为导航树上的库，
// 普通集合归在 default 下。连接配置里的 Database 就是当前租户：导航树选中的库会写入这里，
// 每个租户各用一个连接实例（连接缓存键含 Database）。
type WeaviateDB struct {
	driverVariantState
	client      *http.Client
	baseURL     string
	authHeaders map[string]string
	forwarder   *ssh.LocalForwarder
	tenant      string

	schemaMu       sync.Mutex
	schemaCache    []weaviateClass
	schemaLoadedAt time.Time
	tenantCache    map[string][]string
}

var (
	_ Database              = (*WeaviateDB)(nil)
	_ BatchApplierContext   = (*WeaviateDB)(nil)
	_ QueryContexter        = (*WeaviateDB)(nil)
	_ ExecContexter         = (*WeaviateDB)(nil)
	_ DriverVariantReporter = (*WeaviateDB)(nil)
)

// Connect 读取 /v1/meta 校验地址与认证，并按服务端版本确定驱动档位（租户、命名向量等按档位开启）。
func (w *WeaviateDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = w.Close()
	defer func() {
		if err != nil {
			_ = w.Close()
		}
	}()

	runConfig := normalizeWeaviateConfig(config)
	if runConfig.UseSSH {
		if runConfig, w.forwarder, err = forwardRegistryHTTPThroughSSH(runConfig, "Weaviate"); err != nil {
			return err
		}
	}

	w.baseURL = registryHTTPBaseURL(runConfig)
	w.authHeaders = weaviateAuthHeaders(runConfig)
	w.client = buildRegistryHTTPClient(runConfig)
	w.tenant = weaviateTenantFromConfig(runConfig)

	ctx, cancel := context.WithTimeout(context.Background(), getConnectTimeout(runConfig))
	defer cancel()
	version, err := w.serverVersion(ctx)
	if err != nil {
		return err
	}
	return w.resolve("weaviate", config, version)
}

func (w *WeaviateDB) serverVersion(ctx context.Context) (string, error) {
	var meta struct {
		Version string `json:"version"`
	}
	if err := w.doJSON(ctx, http.MethodGet, "/v1/meta", nil, &meta); err != nil {
		return "", err
	}
	return meta.Version, nil
}

// Close 释放 SSH 转发并清空元数据缓存。
func (w *WeaviateDB) Close() error {
	releaseRegistryHTTPForwarder(w.forwarder, "Weaviate")
	w.forwarder = nil
	w.client = nil
	w.invalidateSchema()
	return nil
}

// Ping 用 /v1/meta 检测连通性：就绪探针不校验认证，不能代表凭据仍然有效。
func (w *WeaviateDB) Ping() error {
	if w.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := w.serverVersion(ctx)
	return err
}

// supportsTenants 报告服务端是否有多租户（1.20 起）。
func (w *WeaviateDB) supportsTenants() bool { return w.atLeast("1.20") }

// supportsNamedVectors 报告服务端是否有命名向量（1.24 起）。
func (w *WeaviateDB) supportsNamedVectors() bool { return w.atLeast("1.24") }

// usesValueText 报告 text 与 string 是否已合并、过滤值统一用 valueText（1.19 起）。
func (w *WeaviateDB) usesValueText() bool { return w.atLeast("1.19") }
