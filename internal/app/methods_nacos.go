package app

import (
	"context"
	"errors"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/nacos"

	"golang.org/x/sync/singleflight"
)

var (
	nacosCache                 = make(map[string]nacos.Client)
	nacosCacheMu               sync.Mutex
	nacosCacheGeneration       uint64
	nacosCacheGenerationCtx    context.Context
	nacosCacheGenerationCancel context.CancelFunc
	nacosConnectGroup          singleflight.Group
	newNacosClientFunc         = nacos.NewClient
)

var errNacosCacheInvalidated = errors.New("Nacos 连接缓存已关闭")

const defaultNacosOperationTimeoutSeconds = 30

const nacosNamespaceListForbiddenErrorCode = "nacos_namespace_list_forbidden"

const connectionTestQueryPrefix = "connection-test:"

type nacosContextConnector interface {
	ConnectContext(context.Context, connection.ConnectionConfig) error
}

func init() {
	nacosCacheGenerationCtx, nacosCacheGenerationCancel = context.WithCancel(context.Background())
}

// NacosConfigQuery is the frontend search payload.
type NacosConfigQuery struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId,omitempty"`
	Group       string `json:"group,omitempty"`
	AppName     string `json:"appName,omitempty"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
	Search      string `json:"search,omitempty"`
}

// NacosPublishConfigPayload is the frontend publish payload.
type NacosPublishConfigPayload struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	Content     string `json:"content"`
	Type        string `json:"type,omitempty"`
	AppName     string `json:"appName,omitempty"`
	Desc        string `json:"desc,omitempty"`
	BetaIPs     string `json:"betaIps,omitempty"`
}

// NacosConfigIdentity identifies one config by dataId + group.
// Named type (not anonymous) so wailsjs models.ts generation stays valid.
type NacosConfigIdentity struct {
	DataID string `json:"dataId"`
	Group  string `json:"group"`
	Index  *int   `json:"index,omitempty"`
}

// NacosExportConfigsOptions controls config export.
type NacosExportConfigsOptions struct {
	NamespaceID   string                `json:"namespaceId"`
	NamespaceName string                `json:"namespaceName,omitempty"`
	Scope         string                `json:"scope,omitempty"` // all | selected
	Items         []NacosConfigIdentity `json:"items,omitempty"`
}

// NacosImportConfigsOptions controls config import.
type NacosImportConfigsOptions struct {
	NamespaceID  string                `json:"namespaceId"`
	ConflictMode string                `json:"conflictMode,omitempty"` // skip | overwrite
	File         string                `json:"file,omitempty"`
	Scope        string                `json:"scope,omitempty"` // all | selected
	Items        []NacosConfigIdentity `json:"items,omitempty"`
}

// NacosCreateNamespacePayload creates a namespace.
type NacosCreateNamespacePayload struct {
	ID          string `json:"id"`
	ShowName    string `json:"showName"`
	Description string `json:"description,omitempty"`
}

// NacosUpdateNamespacePayload updates a namespace.
type NacosUpdateNamespacePayload struct {
	ID          string `json:"id"`
	ShowName    string `json:"showName"`
	Description string `json:"description,omitempty"`
}

// NacosHistoryQuery lists config history.
type NacosHistoryQuery struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
}

// NacosServiceQuery lists services.
type NacosServiceQuery struct {
	NamespaceID string `json:"namespaceId"`
	ServiceName string `json:"serviceName,omitempty"`
	GroupName   string `json:"groupName,omitempty"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
	// WithStatistics asks for per-service instance statistics. It never adds extra
	// Nacos requests: the counts come from the same service-list response when the
	// server provides them, and are reported as unavailable otherwise.
	WithStatistics bool `json:"withStatistics,omitempty"`
}

// NacosServicePayload creates/updates a service.
type NacosServicePayload struct {
	NamespaceID      string            `json:"namespaceId"`
	ServiceName      string            `json:"serviceName"`
	GroupName        string            `json:"groupName,omitempty"`
	Ephemeral        *bool             `json:"ephemeral,omitempty"`
	ProtectThreshold float64           `json:"protectThreshold,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
}

// NacosInstanceQuery lists instances.
type NacosInstanceQuery struct {
	NamespaceID string `json:"namespaceId"`
	ServiceName string `json:"serviceName"`
	GroupName   string `json:"groupName,omitempty"`
	Clusters    string `json:"clusters,omitempty"`
	HealthyOnly bool   `json:"healthyOnly,omitempty"`
}

// NacosInstancePayload mutates an instance.
type NacosInstancePayload struct {
	NamespaceID string            `json:"namespaceId"`
	ServiceName string            `json:"serviceName"`
	GroupName   string            `json:"groupName,omitempty"`
	IP          string            `json:"ip"`
	Port        int               `json:"port"`
	ClusterName string            `json:"clusterName,omitempty"`
	Weight      *float64          `json:"weight,omitempty"`
	Enabled     *bool             `json:"enabled,omitempty"`
	Healthy     *bool             `json:"healthy,omitempty"`
	Ephemeral   *bool             `json:"ephemeral,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
}
