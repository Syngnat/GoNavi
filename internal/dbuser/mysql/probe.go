package mysql

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 提示码。
const (
	noticeNativeUnavailable   = "mysql_native_unavailable"
	noticeCachingSha2Clients  = "mysql_caching_sha2_clients"
	noticeDBWildcard          = "mysql_db_wildcard"
	noticeExperimental        = "experimental_flavor"
	noticeMissingCreateUser   = "missing_create_user_privilege"
	noticeLegacyAccountSyntax = "mysql_legacy_account_syntax"
)

// Provider 是 MySQL 系实现。
type Provider struct{}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 MySQL 系 Provider。
func New() *Provider {
	return &Provider{}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	return dbuser.FamilyMySQL
}

// Probe 探测版本、分支、会话开关、认证插件、口令策略与当前账号能力。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, target dbuser.Target) (dbuser.ServerProfile, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT VERSION() AS version, CURRENT_USER() AS current_account, @@sql_mode AS sql_mode")
	if err != nil {
		return dbuser.ServerProfile{}, fmt.Errorf("probe mysql version: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.ServerProfile{}, fmt.Errorf("probe mysql version: empty result")
	}
	versionText := dbuser.CellString(rows[0], "version")
	versionComment := firstValue(ctx, env, "SELECT @@version_comment AS version_comment", "version_comment")
	flavor := resolveFlavor(target.SourceType, versionText, versionComment)
	version := parseFlavorVersion(flavor, versionText)
	sqlMode := strings.ToUpper(dbuser.CellString(rows[0], "sql_mode"))
	profile := dbuser.ServerProfile{
		Supported:   true,
		Family:      dbuser.FamilyMySQL,
		Flavor:      flavor,
		Version:     version,
		VersionText: versionText,
		Banner:      strings.TrimSpace(versionText + " " + versionComment),
		CurrentUser: dbuser.CellString(rows[0], "current_account"),
		Features:    resolveFeatures(flavor, version),
		Dialect: map[string]string{
			dialectFlavor:           flavor,
			dialectBackslashEscapes: strconv.FormatBool(!strings.Contains(sqlMode, "NO_BACKSLASH_ESCAPES")),
		},
		Experimental: flavor == flavorTiDB || flavor == flavorOceanBase || flavor == flavorGoldenDB,
	}
	if flavor == flavorOceanBase && probeSucceeds(ctx, env, "SELECT 1 FROM mysql.role_edges LIMIT 1") {
		profile.Features[featRoles] = true
		profile.Features[featRoleHost] = true
		profile.Features[featDefaultRoles] = true
	}
	plugins, defaultPlugin := probeAuthPlugins(ctx, env, flavor, version)
	profile.Dialect[dialectDefaultPlugin] = defaultPlugin
	profile.PasswordPolicy = probePasswordPolicy(ctx, env, flavor)
	profile.Permissions = probePermissions(ctx, env, profile.CurrentUser, backslash(profile))
	profile.Privileges = probePrivileges(ctx, env, profile)
	profile.Kinds = buildKinds(profile)
	profile.EditorTabs = buildEditorTabs(profile)
	profile.ObjectScopes = []string{dbuser.ScopeDatabase, dbuser.ScopeTable, dbuser.ScopeColumn, dbuser.ScopeRoutine}
	profile.Options = buildOptions(profile, plugins, defaultPlugin)
	profile.Notices = buildProbeNotices(profile, plugins, defaultPlugin)
	return profile, nil
}

func backslash(profile dbuser.ServerProfile) bool {
	return profile.Dialect[dialectBackslashEscapes] != "false"
}

func firstValue(ctx context.Context, env dbuser.Env, query, column string) string {
	rows, err := env.SQL.Query(ctx, "", query)
	if err != nil || len(rows) == 0 {
		return ""
	}
	return dbuser.CellString(rows[0], column)
}

func probeSucceeds(ctx context.Context, env dbuser.Env, query string) bool {
	_, err := env.SQL.Query(ctx, "", query)
	return err == nil
}

// probeAuthPlugins 返回可用于建号的口令类插件与默认插件。
func probeAuthPlugins(ctx context.Context, env dbuser.Env, flavor string, v dbuser.Version) ([]string, string) {
	active := map[string]bool{}
	rows, err := env.SQL.Query(ctx, "", "SELECT PLUGIN_NAME AS plugin_name FROM information_schema.PLUGINS WHERE PLUGIN_TYPE = 'AUTHENTICATION' AND PLUGIN_STATUS = 'ACTIVE'")
	if err == nil {
		for _, row := range rows {
			active[strings.ToLower(dbuser.CellString(row, "plugin_name"))] = true
		}
	}
	if err != nil {
		// 插件表不可读（权限或分支差异）时，只给出该分支/版本内置且必然可用的插件。
		return fallbackPlugins(flavor, v), probeDefaultPlugin(ctx, env, flavor, v)
	}
	candidates := []string{"caching_sha2_password", "mysql_native_password", "sha256_password"}
	switch flavor {
	case flavorMariaDB:
		candidates = []string{"mysql_native_password", "ed25519", "parsec"}
	case flavorTiDB:
		candidates = []string{"caching_sha2_password", "mysql_native_password", "tidb_sm3_password"}
	}
	plugins := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if active[candidate] {
			plugins = append(plugins, candidate)
		}
	}
	return plugins, probeDefaultPlugin(ctx, env, flavor, v)
}

func fallbackPlugins(flavor string, v dbuser.Version) []string {
	switch {
	case flavor == flavorMariaDB || flavor == flavorOceanBase:
		return []string{"mysql_native_password"}
	case flavor == flavorTiDB:
		return []string{"caching_sha2_password", "mysql_native_password"}
	case v.AtLeast(9, 0, 0):
		return []string{"caching_sha2_password"}
	case v.AtLeast(8, 0, 4):
		return []string{"caching_sha2_password", "mysql_native_password"}
	default:
		return []string{"mysql_native_password"}
	}
}

func probeDefaultPlugin(ctx context.Context, env dbuser.Env, flavor string, v dbuser.Version) string {
	if flavor == flavorMariaDB || flavor == flavorOceanBase {
		return "mysql_native_password"
	}
	if value := firstValue(ctx, env, "SELECT @@default_authentication_plugin AS plugin", "plugin"); value != "" {
		return value
	}
	// 8.4 起移除 default_authentication_plugin，改读 authentication_policy 首项；'*' 表示内置默认。
	policy := firstValue(ctx, env, "SELECT @@authentication_policy AS policy", "policy")
	first := strings.TrimSpace(strings.Split(policy, ",")[0])
	if first != "" && first != "*" {
		return first
	}
	if v.AtLeast(8, 0, 4) || flavor == flavorTiDB {
		return "caching_sha2_password"
	}
	return "mysql_native_password"
}

// probePasswordPolicy 读取 validate_password（MySQL）或 simple_password_check（MariaDB）。
func probePasswordPolicy(ctx context.Context, env dbuser.Env, flavor string) dbuser.PasswordPolicy {
	pattern := "validate_password%"
	if flavor == flavorMariaDB {
		pattern = "simple_password_check%"
	}
	rows, err := env.SQL.Query(ctx, "", "SHOW VARIABLES LIKE '"+pattern+"'")
	if err != nil || len(rows) == 0 {
		return dbuser.PasswordPolicy{}
	}
	values := make(map[string]string, len(rows))
	for _, row := range rows {
		name := strings.ToLower(dbuser.CellString(row, "Variable_name"))
		name = strings.TrimPrefix(strings.TrimPrefix(name, "validate_password."), "validate_password_")
		name = strings.TrimPrefix(name, "simple_password_check_")
		values[name] = strings.TrimSpace(dbuser.CellString(row, "Value"))
	}
	if flavor == flavorMariaDB {
		return dbuser.PasswordPolicy{
			MinLength:      atoi(values["minimal_length"]),
			RequireDigit:   atoi(values["digits"]) > 0,
			RequireUpper:   atoi(values["letters_same_case"]) > 0,
			RequireLower:   atoi(values["letters_same_case"]) > 0,
			RequireSpecial: atoi(values["other_characters"]) > 0,
			Source:         "simple_password_check",
		}
	}
	policy := dbuser.PasswordPolicy{MinLength: atoi(values["length"]), Source: "validate_password"}
	level := strings.ToUpper(values["policy"])
	if level != "LOW" && level != "0" {
		policy.RequireUpper = atoi(values["mixed_case_count"]) > 0
		policy.RequireLower = atoi(values["mixed_case_count"]) > 0
		policy.RequireDigit = atoi(values["number_count"]) > 0
		policy.RequireSpecial = atoi(values["special_char_count"]) > 0
	}
	policy.DisallowUsername = strings.EqualFold(values["check_user_name"], "ON")
	return policy
}

func atoi(text string) int {
	value, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		return 0
	}
	return value
}

// probePermissions 读取当前账号的全局权限；只作提示，读不到时不阻断。
func probePermissions(ctx context.Context, env dbuser.Env, currentAccount string, backslashEscapes bool) dbuser.Permissions {
	unknown := dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true}
	user, host := splitAccount(currentAccount)
	grantee := "'" + user + "'@'" + host + "'"
	rows, err := env.SQL.Query(ctx, "", "SELECT PRIVILEGE_TYPE AS privilege_type, IS_GRANTABLE AS is_grantable FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = "+dbuser.MySQLString(grantee, backslashEscapes))
	if err != nil || len(rows) == 0 {
		return unknown
	}
	privileges := map[string]bool{}
	grantable := false
	for _, row := range rows {
		privileges[strings.ToUpper(dbuser.CellString(row, "privilege_type"))] = true
		grantable = grantable || dbuser.CellBool(row, "is_grantable")
	}
	canManage := privileges["CREATE USER"] || privileges["SUPER"]
	return dbuser.Permissions{
		CanList:   true,
		CanCreate: canManage,
		CanAlter:  canManage,
		CanDrop:   canManage,
		CanGrant:  grantable || canManage,
	}
}

// splitAccount 拆分 CURRENT_USER() 的 user@host（以最后一个 @ 为界）。
func splitAccount(account string) (string, string) {
	index := strings.LastIndex(account, "@")
	if index < 0 {
		return account, "%"
	}
	return account[:index], account[index+1:]
}

func buildKinds(profile dbuser.ServerProfile) []dbuser.KindDescriptor {
	kinds := []dbuser.KindDescriptor{{
		Kind:             dbuser.KindUser,
		Creatable:        true,
		IdentityFields:   []string{"name", "host"},
		Renamable:        profile.Feature(featRename),
		SupportsPassword: true,
	}}
	if profile.Feature(featRoles) {
		identity := []string{"name", "host"}
		if !profile.Feature(featRoleHost) {
			identity = []string{"name"}
		}
		kinds = append(kinds, dbuser.KindDescriptor{
			Kind:           dbuser.KindRole,
			Creatable:      true,
			IdentityFields: identity,
			Renamable:      profile.Feature(featRoleRename),
		})
	}
	return kinds
}

func buildEditorTabs(profile dbuser.ServerProfile) []string {
	tabs := []string{dbuser.TabGeneral, dbuser.TabAdvanced, dbuser.TabServerPrivileges, dbuser.TabObjectPrivileges}
	if profile.Feature(featRoles) {
		tabs = append(tabs, dbuser.TabMembership)
	}
	return append(tabs, dbuser.TabPreview)
}

func buildProbeNotices(profile dbuser.ServerProfile, plugins []string, defaultPlugin string) []dbuser.Notice {
	notices := []dbuser.Notice{dbuser.Notef(noticeDBWildcard, dbuser.LevelInfo)}
	if profile.Experimental {
		notices = append(notices, dbuser.Notef(noticeExperimental, dbuser.LevelWarning, "flavor", profile.Flavor))
	}
	if !profile.Permissions.CanCreate {
		notices = append(notices, dbuser.Notef(noticeMissingCreateUser, dbuser.LevelWarning))
	}
	if !profile.Feature(featAlterUser) {
		notices = append(notices, dbuser.Notef(noticeLegacyAccountSyntax, dbuser.LevelInfo, "version", profile.Version.String()))
	}
	hasNative := false
	for _, plugin := range plugins {
		hasNative = hasNative || plugin == "mysql_native_password"
	}
	if (profile.Flavor == flavorMySQL || profile.Flavor == flavorPercona) && profile.Version.AtLeast(8, 4, 0) && !hasNative {
		notices = append(notices, dbuser.Notef(noticeNativeUnavailable, dbuser.LevelInfo, "version", profile.Version.String()))
	}
	if defaultPlugin == "caching_sha2_password" {
		notices = append(notices, dbuser.Notef(noticeCachingSha2Clients, dbuser.LevelInfo))
	}
	return notices
}
