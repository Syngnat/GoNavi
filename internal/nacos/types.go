package nacos

import (
	"context"

	"GoNavi-Wails/internal/connection"
)

// Namespace describes a Nacos namespace entry.
type Namespace struct {
	ID          string `json:"id"`
	ShowName    string `json:"showName"`
	Description string `json:"description,omitempty"`
	ConfigCount int64  `json:"configCount,omitempty"`
	Quota       int64  `json:"quota,omitempty"`
	Type        int    `json:"type,omitempty"`
}

// ConfigItem is a row in the config search list.
type ConfigItem struct {
	ID           string `json:"id,omitempty"`
	DataID       string `json:"dataId"`
	Group        string `json:"group"`
	NamespaceID  string `json:"namespaceId,omitempty"`
	Content      string `json:"content,omitempty"`
	Type         string `json:"type,omitempty"`
	MD5          string `json:"md5,omitempty"`
	AppName      string `json:"appName,omitempty"`
	Desc         string `json:"desc,omitempty"`
	ModifiedTime string `json:"modifiedTime,omitempty"`
}

// ConfigDetail is a full config payload for the editor.
type ConfigDetail struct {
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	NamespaceID string `json:"namespaceId,omitempty"`
	Content     string `json:"content"`
	Type        string `json:"type,omitempty"`
	MD5         string `json:"md5,omitempty"`
	AppName     string `json:"appName,omitempty"`
	Desc        string `json:"desc,omitempty"`
}

// ConfigQuery is the search/list request for configs under a namespace.
type ConfigQuery struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId,omitempty"`
	Group       string `json:"group,omitempty"`
	AppName     string `json:"appName,omitempty"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
	Search      string `json:"search,omitempty"` // blur | accurate
}

// ConfigPage is a paged config search result.
type ConfigPage struct {
	TotalCount     int64        `json:"totalCount"`
	PageNumber     int          `json:"pageNumber"`
	PagesAvailable int          `json:"pagesAvailable"`
	PageItems      []ConfigItem `json:"pageItems"`
}

// PublishRequest publishes (create/update) a config.
type PublishRequest struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	Content     string `json:"content"`
	Type        string `json:"type,omitempty"`
	AppName     string `json:"appName,omitempty"`
	Desc        string `json:"desc,omitempty"`
	// BetaIPs enables beta/gray publish when non-empty (comma-separated IPs).
	BetaIPs string `json:"betaIps,omitempty"`
}

// BetaConfigDetail is a beta/gray config payload.
type BetaConfigDetail struct {
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	NamespaceID string `json:"namespaceId,omitempty"`
	Content     string `json:"content"`
	Type        string `json:"type,omitempty"`
	MD5         string `json:"md5,omitempty"`
	BetaIPs     string `json:"betaIps,omitempty"`
	Exists      bool   `json:"exists"`
}

// TransferConfigEntry is one config in import/export payload.
type TransferConfigEntry struct {
	DataID  string `json:"dataId"`
	Group   string `json:"group"`
	Content string `json:"content"`
	Type    string `json:"type,omitempty"`
	AppName string `json:"appName,omitempty"`
	Desc    string `json:"desc,omitempty"`
}

// TransferFile is the on-disk format for bulk import/export.
type TransferFile struct {
	Format        string                `json:"format"`
	Version       int                   `json:"version"`
	ExportedAt    string                `json:"exportedAt"`
	NamespaceID   string                `json:"namespaceId,omitempty"`
	NamespaceName string                `json:"namespaceName,omitempty"`
	SourceAppName string                `json:"sourceAppName,omitempty"`
	Configs       []TransferConfigEntry `json:"configs"`
}

// CreateNamespaceRequest creates a namespace.
type CreateNamespaceRequest struct {
	// ID is the custom namespace id (optional; empty lets server generate in some versions).
	ID          string `json:"id"`
	ShowName    string `json:"showName"`
	Description string `json:"description,omitempty"`
}

// UpdateNamespaceRequest updates a namespace display name/description.
type UpdateNamespaceRequest struct {
	ID          string `json:"id"`
	ShowName    string `json:"showName"`
	Description string `json:"description,omitempty"`
}

// HistoryQuery lists config history records.
type HistoryQuery struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
}

// HistoryItem is one history list row (content may be empty until detail fetch).
type HistoryItem struct {
	ID           string `json:"id"`
	LastID       string `json:"lastId,omitempty"`
	DataID       string `json:"dataId"`
	Group        string `json:"group"`
	NamespaceID  string `json:"namespaceId,omitempty"`
	AppName      string `json:"appName,omitempty"`
	MD5          string `json:"md5,omitempty"`
	Content      string `json:"content,omitempty"`
	SrcIP        string `json:"srcIp,omitempty"`
	SrcUser      string `json:"srcUser,omitempty"`
	OpType       string `json:"opType,omitempty"`
	CreatedTime  string `json:"createdTime,omitempty"`
	ModifiedTime string `json:"modifiedTime,omitempty"`
}

// HistoryPage is a paged history list.
type HistoryPage struct {
	TotalCount     int64         `json:"totalCount"`
	PageNumber     int           `json:"pageNumber"`
	PagesAvailable int           `json:"pagesAvailable"`
	PageItems      []HistoryItem `json:"pageItems"`
}

// ConfigListenTarget is one config identity for long-polling.
type ConfigListenTarget struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	ContentMD5  string `json:"contentMd5,omitempty"`
}

// ServiceQuery lists services under a namespace.
type ServiceQuery struct {
	NamespaceID string `json:"namespaceId"`
	ServiceName string `json:"serviceName,omitempty"`
	GroupName   string `json:"groupName,omitempty"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
}

// ServicePage is a paged service name list.
type ServicePage struct {
	Count        int64    `json:"count"`
	ServiceNames []string `json:"serviceNames"`
	PageNo       int      `json:"pageNo,omitempty"`
	PageSize     int      `json:"pageSize,omitempty"`
}

// ServiceDetail is service metadata.
type ServiceDetail struct {
	Name             string            `json:"name"`
	GroupName        string            `json:"groupName,omitempty"`
	NamespaceID      string            `json:"namespaceId,omitempty"`
	Ephemeral        bool              `json:"ephemeral"`
	ProtectThreshold float64           `json:"protectThreshold,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
	Selector         map[string]any    `json:"selector,omitempty"`
	Clusters         []ServiceCluster  `json:"clusters,omitempty"`
}

// ServiceCluster is a cluster definition under a service.
type ServiceCluster struct {
	Name          string            `json:"name"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	HealthChecker map[string]any    `json:"healthChecker,omitempty"`
}

// CreateServiceRequest creates a service.
type CreateServiceRequest struct {
	NamespaceID      string            `json:"namespaceId"`
	ServiceName      string            `json:"serviceName"`
	GroupName        string            `json:"groupName,omitempty"`
	Ephemeral        *bool             `json:"ephemeral,omitempty"`
	ProtectThreshold float64           `json:"protectThreshold,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
}

// UpdateServiceRequest updates a service.
type UpdateServiceRequest struct {
	NamespaceID      string            `json:"namespaceId"`
	ServiceName      string            `json:"serviceName"`
	GroupName        string            `json:"groupName,omitempty"`
	ProtectThreshold float64           `json:"protectThreshold,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
}

// InstanceQuery lists instances of a service.
type InstanceQuery struct {
	NamespaceID string `json:"namespaceId"`
	ServiceName string `json:"serviceName"`
	GroupName   string `json:"groupName,omitempty"`
	Clusters    string `json:"clusters,omitempty"`
	HealthyOnly bool   `json:"healthyOnly,omitempty"`
}

// Instance describes a service instance.
type Instance struct {
	InstanceID  string            `json:"instanceId,omitempty"`
	IP          string            `json:"ip"`
	Port        int               `json:"port"`
	Weight      float64           `json:"weight,omitempty"`
	Healthy     bool              `json:"healthy"`
	Enabled     bool              `json:"enabled"`
	Ephemeral   bool              `json:"ephemeral"`
	ClusterName string            `json:"clusterName,omitempty"`
	ServiceName string            `json:"serviceName,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
}

// InstanceList is the instance list response.
type InstanceList struct {
	Name        string     `json:"name,omitempty"`
	GroupName   string     `json:"groupName,omitempty"`
	Clusters    string     `json:"clusters,omitempty"`
	CacheMillis int64      `json:"cacheMillis,omitempty"`
	Hosts       []Instance `json:"hosts"`
}

// InstanceRequest is used for register / update / deregister / health.
type InstanceRequest struct {
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

// Client is the Nacos OpenAPI client used by GoNavi.
type Client interface {
	Connect(config connection.ConnectionConfig) error
	Close() error
	Ping(ctx context.Context) error

	ListNamespaces(ctx context.Context) ([]Namespace, error)
	CreateNamespace(ctx context.Context, req CreateNamespaceRequest) error
	UpdateNamespace(ctx context.Context, req UpdateNamespaceRequest) error
	DeleteNamespace(ctx context.Context, namespaceID string) error

	SearchConfigs(ctx context.Context, query ConfigQuery) (*ConfigPage, error)
	ListConfigGroups(ctx context.Context, namespaceID string) ([]string, error)
	GetConfig(ctx context.Context, namespaceID, group, dataID string) (*ConfigDetail, error)
	PublishConfig(ctx context.Context, req PublishRequest) error
	DeleteConfig(ctx context.Context, namespaceID, group, dataID string) error
	GetBetaConfig(ctx context.Context, namespaceID, group, dataID string) (*BetaConfigDetail, error)
	StopBetaConfig(ctx context.Context, namespaceID, group, dataID string) error

	ListConfigHistory(ctx context.Context, query HistoryQuery) (*HistoryPage, error)
	GetConfigHistory(ctx context.Context, namespaceID, group, dataID, nid string) (*HistoryItem, error)

	// ListenOnce performs one long-poll for config changes.
	// Returns the subset of targets that changed. Empty slice means no change before timeout.
	ListenOnce(ctx context.Context, targets []ConfigListenTarget, timeoutMs int) ([]ConfigListenTarget, error)

	ListServices(ctx context.Context, query ServiceQuery) (*ServicePage, error)
	GetService(ctx context.Context, namespaceID, serviceName, groupName string) (*ServiceDetail, error)
	CreateService(ctx context.Context, req CreateServiceRequest) error
	UpdateService(ctx context.Context, req UpdateServiceRequest) error
	DeleteService(ctx context.Context, namespaceID, serviceName, groupName string) error

	ListInstances(ctx context.Context, query InstanceQuery) (*InstanceList, error)
	GetInstance(ctx context.Context, req InstanceRequest) (*Instance, error)
	RegisterInstance(ctx context.Context, req InstanceRequest) error
	UpdateInstance(ctx context.Context, req InstanceRequest) error
	DeregisterInstance(ctx context.Context, req InstanceRequest) error
	UpdateInstanceHealth(ctx context.Context, req InstanceRequest) error
}
