package dbuser

// Family 标识一组共享账号模型与 SQL 方言的数据源。
type Family string

// 支持的数据源族。连接类型到族的映射见 providers.Resolve。
const (
	FamilyMySQL      Family = "mysql"
	FamilyPostgres   Family = "postgres"
	FamilyOpenGauss  Family = "opengauss"
	FamilySQLServer  Family = "sqlserver"
	FamilyOracle     Family = "oracle"
	FamilyDameng     Family = "dameng"
	FamilyClickHouse Family = "clickhouse"
	FamilyTDengine   Family = "tdengine"
	FamilyMongo      Family = "mongodb"
	FamilyRedis      Family = "redis"
)

// PrincipalKind 是账号主体的种类。
type PrincipalKind string

// 主体种类。PG 系中用户与角色是同一对象，按 rolcanlogin 区分展示。
const (
	KindUser   PrincipalKind = "user"
	KindRole   PrincipalKind = "role"
	KindLogin  PrincipalKind = "login"  // SQL Server 服务器登录名
	KindDBUser PrincipalKind = "dbuser" // SQL Server 数据库用户
)

// 编辑器标签页标识，前端按 ServerProfile.EditorTabs 决定展示哪些页。
const (
	TabGeneral          = "general"
	TabAdvanced         = "advanced"
	TabServerPrivileges = "server-privileges"
	TabObjectPrivileges = "object-privileges"
	TabMembership       = "membership"
	TabRedisRules       = "redis-rules"
	TabPreview          = "preview"
)

// Target 描述一次请求要管理的数据源，由绑定层根据连接配置组装。
type Target struct {
	// DBType 是方言归一后的类型（resolveDDLDBType 结果，如 goldendb → mysql）。
	DBType string `json:"dbType"`
	// SourceType 是连接原始类型归一值（如 goldendb、oceanbase、kingbase），用于识别分支。
	SourceType string `json:"sourceType"`
	// OceanBaseOracle 表示 OceanBase 以 Oracle 租户模式连接。
	OceanBaseOracle bool `json:"oceanBaseOracle"`
	// ConnectionUser 是本连接配置的登录用户，用于自锁防护。
	ConnectionUser string `json:"connectionUser"`
	// ConnectionDatabase 是连接配置的默认库。
	ConnectionDatabase string `json:"connectionDatabase"`
}

// Version 是解析后的服务端版本号。
type Version struct {
	Major int    `json:"major"`
	Minor int    `json:"minor"`
	Patch int    `json:"patch"`
	Raw   string `json:"raw"`
}

// Notice 是需要展示给用户的提示；Code 由绑定层映射为 i18n 文案。
type Notice struct {
	Code   string            `json:"code"`
	Level  string            `json:"level"`
	Params map[string]string `json:"params,omitempty"`
	Text   string            `json:"text,omitempty"`
}

// Notice 级别。
const (
	LevelInfo    = "info"
	LevelWarning = "warning"
	LevelDanger  = "danger"
)

// OptionType 是账号属性字段的值类型。
type OptionType string

// 属性字段类型。list 类型的值以换行分隔存放在字符串中。
const (
	OptionString   OptionType = "string"
	OptionBool     OptionType = "bool"
	OptionInt      OptionType = "int"
	OptionEnum     OptionType = "enum"
	OptionMulti    OptionType = "multi"
	OptionList     OptionType = "list"
	OptionDateTime OptionType = "datetime"
	OptionText     OptionType = "text"
)

// Choice 是枚举型字段的候选值。
type Choice struct {
	Value      string `json:"value"`
	Label      string `json:"label,omitempty"`
	Disabled   bool   `json:"disabled,omitempty"`
	Deprecated bool   `json:"deprecated,omitempty"`
	NoticeCode string `json:"noticeCode,omitempty"`
	// Hint 由绑定层按 NoticeCode 本地化填充。
	Hint string `json:"hint,omitempty"`
}

// OptionDescriptor 描述某个版本下可编辑的一个账号属性；前端据此通用渲染表单。
type OptionDescriptor struct {
	ID         string          `json:"id"`
	Type       OptionType      `json:"type"`
	Tab        string          `json:"tab"`
	Kinds      []PrincipalKind `json:"kinds"`
	Choices    []Choice        `json:"choices,omitempty"`
	Default    string          `json:"default,omitempty"`
	Min        int             `json:"min,omitempty"`
	Max        int             `json:"max,omitempty"`
	CreateOnly bool            `json:"createOnly,omitempty"`
	ReadOnly   bool            `json:"readOnly,omitempty"`
	Required   bool            `json:"required,omitempty"`
	NoticeCode string          `json:"noticeCode,omitempty"`
	Hint       string          `json:"hint,omitempty"`
}

// KindDescriptor 描述某种主体在当前数据源下的身份字段与可创建性。
type KindDescriptor struct {
	Kind      PrincipalKind `json:"kind"`
	Creatable bool          `json:"creatable"`
	// IdentityFields 是标识该主体所需字段：name / host / database。
	IdentityFields []string `json:"identityFields"`
	// Renamable 表示支持改名。
	Renamable bool `json:"renamable"`
	// SupportsPassword 表示该种主体可设置口令。
	SupportsPassword bool `json:"supportsPassword"`
	// EditorTabs 非空时覆盖 ServerProfile.EditorTabs（如 SQL Server 登录名没有对象权限页）。
	EditorTabs []string `json:"editorTabs,omitempty"`
}

// Grant 作用域。
const (
	ScopeGlobal   = "global"
	ScopeDatabase = "database"
	ScopeSchema   = "schema"
	ScopeTable    = "table"
	ScopeColumn   = "column"
	ScopeRoutine  = "routine"
	ScopeSequence = "sequence"
)

// PrivilegeDescriptor 是某版本可授予的一项权限及其可用作用域。
type PrivilegeDescriptor struct {
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	Group      string   `json:"group,omitempty"`
	Dynamic    bool     `json:"dynamic,omitempty"`
	Deprecated bool     `json:"deprecated,omitempty"`
}

// PasswordPolicy 是从服务端探测到（或按版本推断）的口令复杂度要求。
type PasswordPolicy struct {
	MinLength        int    `json:"minLength"`
	MaxLength        int    `json:"maxLength"`
	RequireUpper     bool   `json:"requireUpper"`
	RequireLower     bool   `json:"requireLower"`
	RequireDigit     bool   `json:"requireDigit"`
	RequireSpecial   bool   `json:"requireSpecial"`
	MinCategories    int    `json:"minCategories"`
	ForbiddenChars   string `json:"forbiddenChars,omitempty"`
	DisallowUsername bool   `json:"disallowUsername"`
	Source           string `json:"source,omitempty"`
}

// Permissions 描述当前登录账号对账号管理的能力，用于灰显按钮。
type Permissions struct {
	CanList     bool `json:"canList"`
	CanCreate   bool `json:"canCreate"`
	CanAlter    bool `json:"canAlter"`
	CanDrop     bool `json:"canDrop"`
	CanGrant    bool `json:"canGrant"`
	CanReadHash bool `json:"canReadHash"`
}

// ServerProfile 是一次探测的结果：版本、分支、可用能力与表单描述符。
type ServerProfile struct {
	Supported         bool                  `json:"supported"`
	ReadOnly          bool                  `json:"readOnly"`
	UnsupportedReason *Notice               `json:"unsupportedReason,omitempty"`
	Family            Family                `json:"family"`
	Flavor            string                `json:"flavor"`
	Version           Version               `json:"version"`
	VersionText       string                `json:"versionText"`
	Banner            string                `json:"banner"`
	CurrentUser       string                `json:"currentUser"`
	Topology          string                `json:"topology,omitempty"`
	Experimental      bool                  `json:"experimental,omitempty"`
	Features          map[string]bool       `json:"features"`
	Kinds             []KindDescriptor      `json:"kinds"`
	EditorTabs        []string              `json:"editorTabs"`
	Options           []OptionDescriptor    `json:"options"`
	Privileges        []PrivilegeDescriptor `json:"privileges"`
	ObjectScopes      []string              `json:"objectScopes"`
	AssignableRoles   []PrincipalRef        `json:"assignableRoles,omitempty"`
	PasswordPolicy    PasswordPolicy        `json:"passwordPolicy"`
	Permissions       Permissions           `json:"permissions"`
	Notices           []Notice              `json:"notices,omitempty"`
	// Dialect 保存影响语句生成的会话开关（如 sql_mode），参与 Plan 与指纹。
	Dialect map[string]string `json:"dialect,omitempty"`
}

// Feature 查询能力开关。
func (p ServerProfile) Feature(name string) bool {
	return p.Features[name]
}

// Kind 返回指定主体种类的描述。
func (p ServerProfile) Kind(kind PrincipalKind) (KindDescriptor, bool) {
	for _, item := range p.Kinds {
		if item.Kind == kind {
			return item, true
		}
	}
	return KindDescriptor{}, false
}

// Option 返回指定 ID 的属性描述。
func (p ServerProfile) Option(id string) (OptionDescriptor, bool) {
	for _, item := range p.Options {
		if item.ID == id {
			return item, true
		}
	}
	return OptionDescriptor{}, false
}

// PrincipalRef 唯一标识一个账号主体。
type PrincipalRef struct {
	Kind PrincipalKind `json:"kind"`
	Name string        `json:"name"`
	// Host 仅 MySQL 系使用（'user'@'host'）。
	Host string `json:"host,omitempty"`
	// Database 是 Mongo 认证库 / SQL Server 数据库用户所在库。
	Database string `json:"database,omitempty"`
}

// Principal 是列表中的一行。
type Principal struct {
	Ref            PrincipalRef `json:"ref"`
	System         bool         `json:"system"`
	Locked         bool         `json:"locked"`
	Expired        bool         `json:"expired"`
	CanLogin       bool         `json:"canLogin"`
	Superuser      bool         `json:"superuser"`
	ReadOnly       bool         `json:"readOnly"`
	ReadOnlyReason string       `json:"readOnlyReason,omitempty"`
	AuthMethod     string       `json:"authMethod,omitempty"`
	Tags           []string     `json:"tags,omitempty"`
	Current        bool         `json:"current"`
}

// Grant 是一条权限授予。Inherited 非空表示经由角色继承，只读展示。
type Grant struct {
	Privilege       string `json:"privilege"`
	Scope           string `json:"scope"`
	Database        string `json:"database,omitempty"`
	Schema          string `json:"schema,omitempty"`
	Object          string `json:"object,omitempty"`
	Column          string `json:"column,omitempty"`
	ObjectType      string `json:"objectType,omitempty"`
	WithGrantOption bool   `json:"withGrantOption,omitempty"`
	Deny            bool   `json:"deny,omitempty"`
	Inherited       string `json:"inherited,omitempty"`
	Node            string `json:"node,omitempty"`
}

// Membership 表示主体属于某个角色。
type Membership struct {
	Role        PrincipalRef `json:"role"`
	AdminOption bool         `json:"adminOption,omitempty"`
	// Inherit / Set 仅 PG16+ 使用；nil 表示按服务端默认。
	Inherit *bool `json:"inherit,omitempty"`
	Set     *bool `json:"set,omitempty"`
}

// PrincipalDetail 是编辑器所需的完整信息。
type PrincipalDetail struct {
	Principal Principal         `json:"principal"`
	Options   map[string]string `json:"options"`
	Grants    []Grant           `json:"grants"`
	MemberOf  []Membership      `json:"memberOf"`
	Members   []PrincipalRef    `json:"members,omitempty"`
	Notices   []Notice          `json:"notices,omitempty"`
}

// ListQuery 是列表查询参数。
type ListQuery struct {
	// Database 用于按库区分的主体（SQL Server 数据库用户、Mongo 认证库过滤）。
	Database string `json:"database,omitempty"`
}

// DescribeQuery 是详情查询参数。
type DescribeQuery struct {
	Ref PrincipalRef `json:"ref"`
	// Database 是对象权限所在库（PG/SQL Server 对象权限按库存放）。
	Database string `json:"database,omitempty"`
}

// ImpactItem 是删除影响中的一类依赖。
type ImpactItem struct {
	Code     string            `json:"code"`
	Count    int               `json:"count"`
	Database string            `json:"database,omitempty"`
	Samples  []string          `json:"samples,omitempty"`
	Params   map[string]string `json:"params,omitempty"`
	Text     string            `json:"text,omitempty"`
}

// DropImpact 是删除前的依赖分析结果。
type DropImpact struct {
	Items             []ImpactItem `json:"items"`
	CascadeSupported  bool         `json:"cascadeSupported"`
	ReassignSupported bool         `json:"reassignSupported"`
	Blocking          bool         `json:"blocking"`
	Notices           []Notice     `json:"notices,omitempty"`
}
