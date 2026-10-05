// Package datasource 保存数据源描述表：后端、前端与发布工具共用的同一份类型声明。
//
// 每个数据源一个描述文件 specs/<type>.json。描述表只覆盖通过它接入的数据源
// （全部走可选驱动代理）；历史类型仍由各自的硬编码清单维护，调用方先查旧清单，
// 再回落到本包，所以新增类型只需声明一次。
package datasource

import "strings"

// CatalogGroup 是新建连接时类型卡片所在的分组键，与前端 connection_modal.step1.group.* 对齐。
type CatalogGroup string

// 描述表允许使用的分组；新增分组必须同步前端分组与 i18n 文案。
const (
	GroupRelational   CatalogGroup = "relational"
	GroupDomestic     CatalogGroup = "domestic"
	GroupNoSQL        CatalogGroup = "nosql"
	GroupSearch       CatalogGroup = "search"
	GroupVector       CatalogGroup = "vector"
	GroupTimeSeries   CatalogGroup = "timeseries"
	GroupBigData      CatalogGroup = "bigdata"
	GroupConfigCenter CatalogGroup = "config_center"
)

// ProxyMode 决定连接代理由谁处理。
const (
	// ProxyModeForward：主进程起本地端口转发，驱动连本地地址（单地址 TCP 协议）。
	ProxyModeForward = "forward"
	// ProxyModeDriver：主进程不改写地址，由代理进程内的驱动自己走代理（HTTPS 云服务需要
	// 原始主机名做 SNI 与证书校验，Cassandra/etcd 这类会发现集群节点的驱动也不能只转发一个地址）。
	ProxyModeDriver = "driver"
)

// VariantAuto 表示连接时按服务端自报版本自动选择驱动版本档位。
const VariantAuto = "auto"

// MaxVariants 是单个数据源可供用户选择的驱动版本档位上限。
const MaxVariants = 3

// Spec 描述一个数据源类型。字段保持 JSON 兼容：前端直接导入同一份 JSON（并读取 Go 忽略的 ui 段）。
type Spec struct {
	Type        string       `json:"type"`
	Aliases     []string     `json:"aliases,omitempty"`
	DisplayName string       `json:"displayName"`
	Group       CatalogGroup `json:"group"`
	// Order 是同一分组内的排序权重，越小越靠前；相同时按类型名排序。
	Order       int `json:"order,omitempty"`
	DefaultPort int `json:"defaultPort,omitempty"`
	// Wire 是传输协议族（mysql、postgres、http、cql、thrift、odbc、native 等），
	// 决定连接表单的默认 SSL 选项与可复用的驱动实现。
	Wire string `json:"wire"`
	// Dialect 是查询编辑器方言键；DDLDialect 是 app 层借用的既有方言（DDL、分页、
	// 只读分类、同步等按它分发，例如 TiDB → mysql），没有可借用的方言时留空。
	Dialect    string `json:"dialect"`
	DDLDialect string `json:"ddlDialect,omitempty"`
	// Family 声明与既有类型的兼容家族（mysql、postgres、oracle、sqlite 等），
	// 供“是否 MySQL 兼容”之类的判定回落使用；没有兼容家族时留空。
	Family string `json:"family,omitempty"`
	// ObjectKind 是导航树里“表”节点的对象名词（table、collection、index、measurement、key、node）。
	ObjectKind string `json:"objectKind,omitempty"`
	// VersionQuery 是读取服务端版本的只读查询（SQL 或驱动可识别的伪命令），供连接健康与 AI 提示使用。
	VersionQuery             string `json:"versionQuery,omitempty"`
	CaseSensitiveIdentifiers bool   `json:"caseSensitiveIdentifiers,omitempty"`
	// SyntheticDatabase 为 true 时 GetDatabases 返回的是虚拟命名空间（如 KV 的根前缀），
	// 导航树选中的库名不得覆盖连接配置里的 Database。
	SyntheticDatabase bool `json:"syntheticDatabase,omitempty"`
	// ProxyMode 为空等同 forward。
	ProxyMode  string `json:"proxyMode,omitempty"`
	Protection bool   `json:"protection,omitempty"`
	// ExcelImport 为 true 时开放表数据导入（CSV / JSON / Excel，经驱动的 ApplyChanges 写入）。
	ExcelImport bool `json:"excelImport,omitempty"`
	// SQLFileImport 为 true 时开放运行 SQL 文件 / 从 SQL 备份恢复（按方言切分语句，在固定会话里执行）。
	SQLFileImport bool      `json:"sqlFileImport,omitempty"`
	Sync          *SyncSpec `json:"sync,omitempty"`
	// DriverTransactions 为 true 时 SQL 编辑器的托管事务走驱动接口（OpenTransactionExecer），
	// 用于文本 BEGIN / START TRANSACTION 不生效的库（如 GBase 8a 需要关闭自动提交）。
	DriverTransactions bool `json:"driverTransactions,omitempty"`
	// ClientLibrary 声明驱动依赖的用户自备客户端库（如 GBase 8s 的 CSDK），启动驱动代理时据此注入环境变量。
	ClientLibrary *ClientLibrarySpec `json:"clientLibrary,omitempty"`
	// Agent 是默认驱动代理；其 Key 恒等于 Type。
	Agent AgentSpec `json:"agent"`
	// ModuleAliases 是驱动管理里展示历史版本时额外查询的 Go module 路径。
	ModuleAliases []string   `json:"moduleAliases,omitempty"`
	Variants      VariantSet `json:"variants"`
	// UI 是前端展示配置；Go 只读取影响对象列表的字段，让导出、对象列表与 AI 工具和侧栏保持一致。
	UI UISpec `json:"ui"`
}

// UISpec 是描述表 ui 段里 Go 侧需要的子集。ui 段不计入驱动代理修订号，代理里的过滤逻辑不能依赖它。
type UISpec struct {
	// HiddenSchemaPrefixes 是扩展内部 schema 的前缀（如 TimescaleDB 的 _timescaledb_），对象列表与导出跳过其中的对象。
	HiddenSchemaPrefixes []string `json:"hiddenSchemaPrefixes,omitempty"`
	// HiddenSchemas 是按全名隐藏的内部 schema（如 GBase 8c 的 blockchain、sys），与前缀规则一起生效。
	HiddenSchemas []string `json:"hiddenSchemas,omitempty"`
	// HideExtensionRoutines 为 true 时函数列表不含 CREATE EXTENSION 带入的函数（pg_depend.deptype = 'e'）。
	HideExtensionRoutines bool `json:"hideExtensionRoutines,omitempty"`
	// HideExtensionViews 为 true 时视图列表不含扩展带入的视图（如 GBase 8c Oracle 兼容扩展建在 public 下的 dual）。
	HideExtensionViews bool `json:"hideExtensionViews,omitempty"`
	// FlatObjectNames 为 true 时对象名（etcd 键路径、znode 路径）整体是一个标识符，不能按点拆成 schema.table。
	FlatObjectNames bool `json:"flatObjectNames,omitempty"`
	// Quoting 是标识符引号规则（pg：只在需要时加双引号；double、backtick、bracket），与前端一致。
	Quoting string `json:"quoting,omitempty"`
	// ObjectStatements 是未借用方言的数据源的对象操作语句模板（renameTable、dropTable、dropView、dropRoutine、
	// truncateTable、clearTable），占位符 {table}、{old}、{new}、{view}、{name} 按 Quoting 加引号，{type} 原样替换。
	ObjectStatements map[string]string `json:"objectStatements,omitempty"`
}

// HidesSchema 报告 schema 是否属于 HiddenSchemas / HiddenSchemaPrefixes 声明的内部 schema。
func (u UISpec) HidesSchema(schema string) bool {
	lower := strings.ToLower(strings.TrimSpace(schema))
	if lower == "" {
		return false
	}
	for _, name := range u.HiddenSchemas {
		if strings.EqualFold(strings.TrimSpace(name), lower) {
			return true
		}
	}
	for _, prefix := range u.HiddenSchemaPrefixes {
		if normalized := strings.ToLower(strings.TrimSpace(prefix)); normalized != "" && strings.HasPrefix(lower, normalized) {
			return true
		}
	}
	return false
}

// ClientLibrarySpec 描述用户自备的客户端库目录：连接参数 Param 优先，其次依次读取 HomeEnv 里的环境变量。
// 动态库在进程启动后才设置 LD_LIBRARY_PATH 不生效，所以由应用在启动代理进程时注入：HomeEnv 的第一个变量
// 指向客户端目录，LibraryDirs（Windows 用 WindowsLibraryDirs）里的子目录加到动态库搜索路径前面。
type ClientLibrarySpec struct {
	Param              string   `json:"param"`
	HomeEnv            []string `json:"homeEnv"`
	LibraryDirs        []string `json:"libraryDirs,omitempty"`
	WindowsLibraryDirs []string `json:"windowsLibraryDirs,omitempty"`
}

// SyncSpec 声明数据同步的参与方式。
type SyncSpec struct {
	Source bool   `json:"source"`
	Target bool   `json:"target"`
	Model  string `json:"model,omitempty"`
	// SingleKindBatches 为 true 时同步把删除、修改、新增分开提交：目标库的一个事务里同一张表只能做一类写入
	// （如 GBase 8a 在 UPDATE / DELETE 之后不能再写同一张表）。
	SingleKindBatches bool `json:"singleKindBatches,omitempty"`
	// HashIndexesOnly 为 true 时目标库只支持 HASH 普通索引（如 GBase 8a）：同步建索引时普通索引改用 USING HASH，
	// 唯一索引跳过并提示。
	HashIndexesOnly bool `json:"hashIndexesOnly,omitempty"`
}

// AgentSpec 描述一个可选驱动代理构建。
type AgentSpec struct {
	// Key 是代理的驱动键：安装目录、可执行文件名、修订号、发布资产都按它区分。
	// 默认代理留空（等同数据源类型名）；独立构建档位必须填写，例如 cassandra_legacy。
	Key      string `json:"key,omitempty"`
	BuildTag string `json:"buildTag"`
	GoModule string `json:"goModule,omitempty"`
	Version  string `json:"version,omitempty"`
	// CGO 为 true 时该构建需要目标平台的 C 工具链。
	CGO bool `json:"cgo,omitempty"`
	// Platforms 为空表示发布全部六个平台；否则只发布列出的 GOOS/GOARCH。
	Platforms []string `json:"platforms,omitempty"`
	// SourcePrefixes 是计算代理源码指纹时纳入的 internal/db 文件名前缀。
	SourcePrefixes []string `json:"sourcePrefixes,omitempty"`
}

// VariantSet 是连接级驱动版本选择。Items 按服务端版本从旧到新排列。
type VariantSet struct {
	Auto    bool      `json:"auto,omitempty"`
	Default string    `json:"default"`
	Items   []Variant `json:"items"`
}

// Variant 是一个驱动版本档位。Build 非空表示该档位需要独立的代理构建
// （不同 Go module 主版本），否则档位只是同一代理内的运行时协议配置。
type Variant struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// DescriptionKey 指向 shared/i18n 里的档位说明（适用版本、协议差异）。
	DescriptionKey string `json:"descriptionKey,omitempty"`
	// MinServer/MaxServer 是自动识别使用的服务端版本区间 [MinServer, MaxServer)。
	MinServer string     `json:"minServer,omitempty"`
	MaxServer string     `json:"maxServer,omitempty"`
	Build     *AgentSpec `json:"build,omitempty"`
}

// HasSeparateBuilds 报告是否存在需要独立代理构建的档位。
func (v VariantSet) HasSeparateBuilds() bool {
	for _, item := range v.Items {
		if item.Build != nil {
			return true
		}
	}
	return false
}

// Item 返回指定 ID 的档位。
func (v VariantSet) Item(id string) (Variant, bool) {
	for _, item := range v.Items {
		if item.ID == id {
			return item, true
		}
	}
	return Variant{}, false
}

// AgentFor 返回某个档位实际使用的代理构建（Key 已填好）；档位没有独立构建时回落到默认代理。
func (s Spec) AgentFor(variantID string) AgentSpec {
	if item, ok := s.Variants.Item(normalizeName(variantID)); ok && item.Build != nil {
		return *item.Build
	}
	agent := s.Agent
	agent.Key = s.Type
	return agent
}

// AgentKeyFor 返回连接选择该档位时要启动的代理驱动键。
func (s Spec) AgentKeyFor(requestedVariant string) string {
	return s.AgentFor(s.RequestedVariant(requestedVariant)).Key
}

// Agents 返回该数据源的全部代理构建：默认代理在前，独立构建档位随后。
func (s Spec) Agents() []AgentSpec {
	agents := []AgentSpec{s.AgentFor("")}
	for _, item := range s.Variants.Items {
		if item.Build != nil {
			agents = append(agents, *item.Build)
		}
	}
	return agents
}

// UsesDriverProxy 报告连接代理是否交给驱动自己处理。
func (s Spec) UsesDriverProxy() bool {
	return s.ProxyMode == ProxyModeDriver
}
