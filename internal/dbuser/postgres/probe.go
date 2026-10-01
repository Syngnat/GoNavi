// Package postgres 实现 PG 系（PostgreSQL / 人大金仓 / 瀚高）与 openGauss 系
// （openGauss / GaussDB / Vastbase）的账号管理。两者共用角色模型、授权语法与 catalog，
// 差异（口令语法、管理员属性、锁定、事务性）由 variant 开关控制。
package postgres

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

type variant int

const (
	variantPostgres variant = iota
	variantOpenGauss
)

// 特性开关。
const (
	featBypassRLS         = "bypassRls"
	featMembershipOptions = "membershipOptions"
	featMaintain          = "maintain"
	featClientHash        = "clientHash"
	featDatabaseScoped    = "databaseScoped"
	featReplacePassword   = "replacePassword"
	featAccountLock       = "accountLock"
	featRoutineKeyword    = "routineKeyword"
)

// 方言开关（参与指纹）。
const (
	dialectRolesRelation = "rolesRelation"
	dialectEncryption    = "passwordEncryption"
)

// 提示码。
const (
	noticeServerHash        = "pg_server_side_hash"
	noticeMD5Deprecated     = "pg_md5_deprecated"
	noticePerDatabaseGrants = "pg_per_database_grants"
	noticeOpenGaussSchema   = "opengauss_user_schema"
	noticeNoSuperuser       = "pg_missing_createrole"
	noticeExperimental      = "experimental_flavor"
)

// Provider 是 PG 系 / openGauss 系实现。
type Provider struct {
	variant variant
}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 PG 系 Provider（postgres / kingbase / highgo）。
func New() *Provider {
	return &Provider{variant: variantPostgres}
}

// NewOpenGauss 返回 openGauss 系 Provider（opengauss / gaussdb / vastbase）。
func NewOpenGauss() *Provider {
	return &Provider{variant: variantOpenGauss}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	if p.variant == variantOpenGauss {
		return dbuser.FamilyOpenGauss
	}
	return dbuser.FamilyPostgres
}

// parseVersionNum 解析 server_version_num：160002 → 16.0.2，90624 → 9.6.24。
func parseVersionNum(text string) dbuser.Version {
	value, ok := dbuser.AsInt(strings.TrimSpace(text))
	if !ok || value <= 0 {
		return dbuser.Version{}
	}
	if value >= 100000 {
		return dbuser.Version{Major: int(value / 10000), Minor: 0, Patch: int(value % 100), Raw: text}
	}
	return dbuser.Version{Major: int(value / 10000), Minor: int(value / 100 % 100), Patch: int(value % 100), Raw: text}
}

// Probe 实现 dbuser.Provider。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, target dbuser.Target) (dbuser.ServerProfile, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT version() AS version, current_user AS current_role")
	if err != nil {
		return dbuser.ServerProfile{}, fmt.Errorf("probe postgres version: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.ServerProfile{}, fmt.Errorf("probe postgres version: empty result")
	}
	banner := dbuser.CellString(rows[0], "version")
	version := parseVersionNum(settingValue(ctx, env, "server_version_num"))
	if !version.Known() {
		version = dbuser.ParseDottedVersion(banner)
	}
	flavor := resolveFlavor(target.SourceType, banner, p.variant)
	profile := dbuser.ServerProfile{
		Supported:    true,
		Family:       p.Family(),
		Flavor:       flavor,
		Version:      version,
		VersionText:  displayVersion(banner),
		Banner:       banner,
		CurrentUser:  dbuser.CellString(rows[0], "current_role"),
		Features:     p.resolveFeatures(flavor, version),
		Dialect:      map[string]string{dialectRolesRelation: probeRolesRelation(ctx, env)},
		Experimental: flavor == "kingbase" || flavor == "highgo" || flavor == "gaussdb" || flavor == "vastbase",
	}
	encryption, choices := probePasswordEncryption(ctx, env, p.variant)
	profile.Dialect[dialectEncryption] = encryption
	profile.Permissions = probePermissions(ctx, env, profile)
	if p.variant == variantOpenGauss {
		profile.PasswordPolicy = probeOpenGaussPolicy(ctx, env)
	}
	profile.Kinds = p.buildKinds()
	profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabServerPrivileges, dbuser.TabObjectPrivileges, dbuser.TabMembership, dbuser.TabPreview}
	profile.ObjectScopes = []string{dbuser.ScopeDatabase, dbuser.ScopeSchema, dbuser.ScopeTable, dbuser.ScopeColumn, dbuser.ScopeSequence, dbuser.ScopeRoutine}
	profile.Privileges = buildPrivileges(profile)
	profile.Options = p.buildOptions(profile, choices)
	profile.Notices = p.buildNotices(profile, encryption)
	return profile, nil
}

func (p *Provider) resolveFeatures(flavor string, v dbuser.Version) map[string]bool {
	features := map[string]bool{
		featBypassRLS:      v.AtLeast(9, 5, 0) && p.variant == variantPostgres,
		featDatabaseScoped: true,
		featRoutineKeyword: v.AtLeast(11, 0, 0) && p.variant == variantPostgres,
		"grantOption":      true,
		"adminOption":      true,
	}
	if p.variant == variantPostgres {
		features[featMembershipOptions] = v.AtLeast(16, 0, 0)
		features[featMaintain] = v.AtLeast(17, 0, 0)
		// 只有原生 PostgreSQL 的口令格式与 libpq 预计算一致；国产分支可能使用 sm3 等算法。
		features[featClientHash] = flavor == "postgres" && v.AtLeast(10, 0, 0)
	} else {
		features[featReplacePassword] = true
		features[featAccountLock] = true
	}
	return features
}

func resolveFlavor(sourceType, banner string, variant variant) string {
	lower := strings.ToLower(banner)
	switch {
	case sourceType == "kingbase" || strings.Contains(lower, "kingbase"):
		return "kingbase"
	case sourceType == "highgo" || strings.Contains(lower, "highgo"):
		return "highgo"
	case sourceType == "vastbase" || strings.Contains(lower, "vastbase"):
		return "vastbase"
	case sourceType == "gaussdb" || strings.Contains(lower, "gaussdb"):
		return "gaussdb"
	case variant == variantOpenGauss:
		return "opengauss"
	default:
		return "postgres"
	}
}

// displayVersion 截取横幅中 " on "/"," 之前的部分作为徽标文本。
func displayVersion(banner string) string {
	text := strings.TrimSpace(banner)
	for _, separator := range []string{" on ", ", compiled", " compiled"} {
		if index := strings.Index(text, separator); index > 0 {
			text = text[:index]
		}
	}
	return text
}

func settingValue(ctx context.Context, env dbuser.Env, name string) string {
	rows, err := env.SQL.Query(ctx, "", "SELECT current_setting("+dbuser.PlainString(name)+") AS value")
	if err != nil || len(rows) == 0 {
		return ""
	}
	return dbuser.CellString(rows[0], "value")
}

// probeRolesRelation 选择角色视图：优先 pg_catalog.pg_roles，人大金仓等分支回退 sys_roles。
func probeRolesRelation(ctx context.Context, env dbuser.Env) string {
	if _, err := env.SQL.Query(ctx, "", "SELECT rolname FROM pg_catalog.pg_roles LIMIT 1"); err == nil {
		return "pg_catalog.pg_roles"
	}
	if _, err := env.SQL.Query(ctx, "", "SELECT rolname FROM sys_catalog.sys_roles LIMIT 1"); err == nil {
		return "sys_catalog.sys_roles"
	}
	return "pg_catalog.pg_roles"
}

// probePasswordEncryption 返回当前口令加密方式与可选值（取自 pg_settings.enumvals）。
func probePasswordEncryption(ctx context.Context, env dbuser.Env, variant variant) (string, []string) {
	name := "password_encryption"
	if variant == variantOpenGauss {
		name = "password_encryption_type"
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT setting, enumvals FROM pg_catalog.pg_settings WHERE name = "+dbuser.PlainString(name))
	if err != nil || len(rows) == 0 {
		return "", nil
	}
	setting := dbuser.CellString(rows[0], "setting")
	raw := strings.Trim(dbuser.CellString(rows[0], "enumvals"), "{}")
	var choices []string
	for item := range strings.SplitSeq(raw, ",") {
		if value := strings.Trim(strings.TrimSpace(item), `"`); value != "" {
			choices = append(choices, value)
		}
	}
	return setting, choices
}

func probePermissions(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile) dbuser.Permissions {
	relation := profile.Dialect[dialectRolesRelation]
	rows, err := env.SQL.Query(ctx, "", "SELECT rolsuper, rolcreaterole FROM "+relation+" WHERE rolname = current_user")
	if err != nil || len(rows) == 0 {
		return dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true}
	}
	manage := dbuser.CellBool(rows[0], "rolsuper") || dbuser.CellBool(rows[0], "rolcreaterole")
	return dbuser.Permissions{CanList: true, CanCreate: manage, CanAlter: manage, CanDrop: manage, CanGrant: true}
}

func probeOpenGaussPolicy(ctx context.Context, env dbuser.Env) dbuser.PasswordPolicy {
	rows, err := env.SQL.Query(ctx, "", "SELECT name, setting FROM pg_catalog.pg_settings WHERE name IN ('password_policy','password_min_length','password_max_length','password_min_uppercase','password_min_lowercase','password_min_digital','password_min_special')")
	if err != nil || len(rows) == 0 {
		return dbuser.PasswordPolicy{MinLength: 8, MinCategories: 3, DisallowUsername: true, Source: "opengauss-default"}
	}
	values := map[string]int{}
	for _, row := range rows {
		value, _ := dbuser.AsInt(dbuser.CellString(row, "setting"))
		values[dbuser.CellString(row, "name")] = int(value)
	}
	if values["password_policy"] == 0 {
		return dbuser.PasswordPolicy{Source: "password_policy=0"}
	}
	return dbuser.PasswordPolicy{
		MinLength:        values["password_min_length"],
		MaxLength:        values["password_max_length"],
		RequireUpper:     values["password_min_uppercase"] > 0,
		RequireLower:     values["password_min_lowercase"] > 0,
		RequireDigit:     values["password_min_digital"] > 0,
		RequireSpecial:   values["password_min_special"] > 0,
		MinCategories:    3,
		DisallowUsername: true,
		Source:           "password_policy",
	}
}

func (p *Provider) buildKinds() []dbuser.KindDescriptor {
	return []dbuser.KindDescriptor{
		{Kind: dbuser.KindUser, Creatable: true, IdentityFields: []string{"name"}, Renamable: true, SupportsPassword: true},
		{Kind: dbuser.KindRole, Creatable: true, IdentityFields: []string{"name"}, Renamable: true, SupportsPassword: p.variant == variantOpenGauss},
	}
}

func (p *Provider) buildNotices(profile dbuser.ServerProfile, encryption string) []dbuser.Notice {
	notices := []dbuser.Notice{dbuser.Notef(noticePerDatabaseGrants, dbuser.LevelInfo)}
	if profile.Experimental {
		notices = append(notices, dbuser.Notef(noticeExperimental, dbuser.LevelWarning, "flavor", profile.Flavor))
	}
	if !profile.Feature(featClientHash) && encryption != "" {
		notices = append(notices, dbuser.Notef(noticeServerHash, dbuser.LevelInfo, "method", encryption))
	}
	if p.variant == variantOpenGauss {
		notices = append(notices, dbuser.Notef(noticeOpenGaussSchema, dbuser.LevelInfo))
	}
	if profile.Version.AtLeast(18, 0, 0) && p.variant == variantPostgres {
		notices = append(notices, dbuser.Notef(noticeMD5Deprecated, dbuser.LevelInfo))
	}
	if !profile.Permissions.CanCreate {
		notices = append(notices, dbuser.Notef(noticeNoSuperuser, dbuser.LevelWarning))
	}
	return notices
}
