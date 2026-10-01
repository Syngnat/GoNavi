package dbuser

// ChangeAction 是变更动作。
type ChangeAction string

// 变更动作。
const (
	ActionCreate ChangeAction = "create"
	ActionAlter  ChangeAction = "alter"
	ActionDrop   ChangeAction = "drop"
)

// MaskedSecret 是预览、审计与日志中代替口令的固定掩码。
const MaskedSecret = "******"

// PasswordChange 描述口令变更。Preview 阶段 Password 为空，仅 Set 为 true；
// Apply 阶段才携带明文。JSON 键保持 password，使请求追踪按键名脱敏。
type PasswordChange struct {
	Set      bool   `json:"set"`
	Password string `json:"password,omitempty"`
	// CurrentPassword 用于需要旧口令的场景（openGauss 改自己口令、MySQL REPLACE）。
	CurrentPassword string `json:"currentPassword,omitempty"`
	// Remove 表示清除口令（Redis nopass、ClickHouse no_password 等）。
	Remove bool `json:"remove,omitempty"`
	// RetainCurrent 对应 MySQL 8.0.14+ 双口令 RETAIN CURRENT PASSWORD。
	RetainCurrent bool `json:"retainCurrent,omitempty"`
}

// DropOptions 是删除选项。
type DropOptions struct {
	Cascade    bool   `json:"cascade,omitempty"`
	ReassignTo string `json:"reassignTo,omitempty"`
	DropOwned  bool   `json:"dropOwned,omitempty"`
}

// ChangeRequest 是前端提交的结构化变更；后端据此生成语句，从不执行前端传来的 SQL。
type ChangeRequest struct {
	Action ChangeAction  `json:"action"`
	Target PrincipalRef  `json:"target"`
	Rename *PrincipalRef `json:"rename,omitempty"`
	// Options 为本次变更涉及的属性；create 时为完整取值，alter 时只含改动项。
	Options           map[string]string `json:"options,omitempty"`
	Password          *PasswordChange   `json:"password,omitempty"`
	GrantsAdd         []Grant           `json:"grantsAdd,omitempty"`
	GrantsRevoke      []Grant           `json:"grantsRevoke,omitempty"`
	MembershipsAdd    []Membership      `json:"membershipsAdd,omitempty"`
	MembershipsRemove []Membership      `json:"membershipsRemove,omitempty"`
	Drop              *DropOptions      `json:"drop,omitempty"`
	// Database 是对象级授权的执行库（PG/SQL Server）。
	Database string `json:"database,omitempty"`
}

// 语句风险级别。
const (
	RiskNormal = "normal"
	RiskHigh   = "high"
	RiskDanger = "danger"
)

// Statement 是一条待执行语句。Exec/Args 含口令明文，永不序列化给前端。
type Statement struct {
	Exec string   `json:"-"`
	Args []string `json:"-"`
	// Secrets 是执行文本中派生出的敏感值（如预计算的 SCRAM verifier），用于错误脱敏。
	Secrets  []string `json:"-"`
	Display  string   `json:"display"`
	Database string   `json:"database,omitempty"`
	Risk     string   `json:"risk"`
	// EachNode 表示 Redis 集群需要逐节点下发。
	EachNode bool `json:"eachNode,omitempty"`
	// Optional 表示失败时只记警告、不中断（如 ACL SAVE 持久化）。
	Optional bool `json:"optional,omitempty"`
}

// Plan 是一次变更的完整执行计划。
type Plan struct {
	Statements    []Statement `json:"statements"`
	Notices       []Notice    `json:"notices,omitempty"`
	Transactional bool        `json:"transactional"`
	Fingerprint   string      `json:"fingerprint"`
}

// StatementResult 是单条语句的执行结果。
type StatementResult struct {
	Index   int    `json:"index"`
	Display string `json:"display"`
	Success bool   `json:"success"`
	Skipped bool   `json:"skipped,omitempty"`
	Error   string `json:"error,omitempty"`
	Node    string `json:"node,omitempty"`
}

// ApplyReport 是执行报告。FailedIndex 从 1 开始，0 表示无失败。
type ApplyReport struct {
	Results       []StatementResult `json:"results"`
	ExecutedCount int               `json:"executedCount"`
	FailedIndex   int               `json:"failedIndex"`
	RolledBack    bool              `json:"rolledBack"`
	Notices       []Notice          `json:"notices,omitempty"`
}

// Failed 表示是否有语句失败。
func (r ApplyReport) Failed() bool {
	return r.FailedIndex > 0
}
