// Package clickhouse 实现 ClickHouse（20.4+ SQL 驱动的访问控制）的账号管理。
// 定义在 users.xml 中的账号只读；本地目录或复制存储中的账号可编辑。
package clickhouse

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 特性开关。
const (
	featBcrypt     = "bcrypt"
	featValidUntil = "validUntil"
)

// 提示码。
const (
	noticeNoRBAC        = "clickhouse_no_rbac"
	noticeConfigUsers   = "clickhouse_config_users"
	noticeDoubleSha1    = "clickhouse_double_sha1"
	noticeOnCluster     = "clickhouse_on_cluster"
	reasonConfigManaged = "clickhouse_config_managed"
)

// Provider 是 ClickHouse 实现。
type Provider struct{}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 ClickHouse Provider。
func New() *Provider {
	return &Provider{}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	return dbuser.FamilyClickHouse
}

// Probe 实现 dbuser.Provider。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, _ dbuser.Target) (dbuser.ServerProfile, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT version() AS version, currentUser() AS current_user_name")
	if err != nil {
		return dbuser.ServerProfile{}, fmt.Errorf("probe clickhouse version: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.ServerProfile{}, fmt.Errorf("probe clickhouse version: empty result")
	}
	versionText := dbuser.CellString(rows[0], "version")
	version := dbuser.ParseDottedVersion(versionText)
	profile := dbuser.ServerProfile{
		Supported:   true,
		Family:      dbuser.FamilyClickHouse,
		Flavor:      "clickhouse",
		Version:     version,
		VersionText: "ClickHouse " + versionText,
		Banner:      versionText,
		CurrentUser: dbuser.CellString(rows[0], "current_user_name"),
		Features: map[string]bool{
			featBcrypt:     version.AtLeast(24, 1, 0),
			featValidUntil: version.AtLeast(23, 9, 0),
			"grantOption":  true,
			"adminOption":  true,
		},
	}
	if _, err := env.SQL.Query(ctx, "", "SELECT name FROM system.users LIMIT 1"); err != nil {
		reason := dbuser.Notef(noticeNoRBAC, dbuser.LevelWarning, "version", versionText)
		profile.Supported = false
		profile.UnsupportedReason = &reason
		return profile, nil
	}
	clusters := stringColumn(ctx, env, "SELECT DISTINCT cluster FROM system.clusters ORDER BY cluster", "cluster")
	profiles := stringColumn(ctx, env, "SELECT name FROM system.settings_profiles ORDER BY name", "name")
	profile.Kinds = []dbuser.KindDescriptor{
		{Kind: dbuser.KindUser, Creatable: true, IdentityFields: []string{"name"}, Renamable: true, SupportsPassword: true},
		{Kind: dbuser.KindRole, Creatable: true, IdentityFields: []string{"name"}, Renamable: true},
	}
	profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabAdvanced, dbuser.TabServerPrivileges, dbuser.TabObjectPrivileges, dbuser.TabMembership, dbuser.TabPreview}
	profile.ObjectScopes = []string{dbuser.ScopeDatabase, dbuser.ScopeTable, dbuser.ScopeColumn}
	profile.Privileges = probePrivileges(ctx, env)
	profile.Options = buildOptions(profile, clusters, profiles)
	profile.Permissions = dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true}
	profile.Notices = []dbuser.Notice{dbuser.Notef(noticeConfigUsers, dbuser.LevelInfo), dbuser.Notef(noticeDoubleSha1, dbuser.LevelInfo)}
	if len(clusters) > 0 {
		profile.Notices = append(profile.Notices, dbuser.Notef(noticeOnCluster, dbuser.LevelInfo))
	}
	return profile, nil
}

func stringColumn(ctx context.Context, env dbuser.Env, query, column string) []string {
	rows, err := env.SQL.Query(ctx, "", query)
	if err != nil {
		return nil
	}
	values := make([]string, 0, len(rows))
	for _, row := range rows {
		if value := dbuser.CellString(row, column); value != "" {
			values = append(values, value)
		}
	}
	return values
}

var fallbackPrivileges = []struct {
	name  string
	level string
}{
	{"SELECT", "COLUMN"}, {"INSERT", "COLUMN"}, {"ALTER", "COLUMN"}, {"CREATE", "GLOBAL"}, {"CREATE TABLE", "DATABASE"},
	{"DROP", "GLOBAL"}, {"DROP TABLE", "TABLE"}, {"TRUNCATE", "TABLE"}, {"OPTIMIZE", "TABLE"}, {"SHOW", "COLUMN"},
	{"KILL QUERY", "GLOBAL"}, {"ACCESS MANAGEMENT", "GLOBAL"}, {"SYSTEM", "GLOBAL"}, {"INTROSPECTION", "GLOBAL"},
	{"SOURCES", "GLOBAL"}, {"dictGet", "TABLE"}, {"ALL", "GLOBAL"},
}

// probePrivileges 以 SHOW PRIVILEGES 的 level 列确定作用域，权限目录随版本变化。
func probePrivileges(ctx context.Context, env dbuser.Env) []dbuser.PrivilegeDescriptor {
	rows, err := env.SQL.Query(ctx, "", "SHOW PRIVILEGES")
	entries := make([][2]string, 0, 128)
	if err == nil && len(rows) > 0 {
		for _, row := range rows {
			entries = append(entries, [2]string{dbuser.CellString(row, "privilege"), dbuser.CellString(row, "level")})
		}
	} else {
		for _, item := range fallbackPrivileges {
			entries = append(entries, [2]string{item.name, item.level})
		}
	}
	catalog := make([]dbuser.PrivilegeDescriptor, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		name := dbuser.NormalizePrivilegeName(entry[0])
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		catalog = append(catalog, dbuser.PrivilegeDescriptor{Name: name, Scopes: scopesForLevel(entry[1])})
	}
	return catalog
}

func scopesForLevel(level string) []string {
	switch strings.ToUpper(strings.TrimSpace(level)) {
	case "COLUMN":
		return []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase, dbuser.ScopeTable, dbuser.ScopeColumn}
	case "TABLE", "VIEW", "DICTIONARY":
		return []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase, dbuser.ScopeTable}
	case "DATABASE":
		return []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase}
	default:
		return []string{dbuser.ScopeGlobal}
	}
}

func buildOptions(profile dbuser.ServerProfile, clusters, settingsProfiles []string) []dbuser.OptionDescriptor {
	user, role := dbuser.KindUser, dbuser.KindRole
	authTypes := dbuser.Choices("sha256_password", "double_sha1_password", "plaintext_password", "no_password")
	if profile.Feature(featBcrypt) {
		authTypes = append([]dbuser.Choice{{Value: "bcrypt_password"}}, authTypes...)
	}
	for index := range authTypes {
		switch authTypes[index].Value {
		case "plaintext_password":
			authTypes[index].Deprecated = true
		case "double_sha1_password":
			authTypes[index].NoticeCode = noticeDoubleSha1
		}
	}
	authType := dbuser.EnumOption(dbuser.OptAuthType, dbuser.TabGeneral, authTypes, user)
	authType.Default = "sha256_password"
	options := []dbuser.OptionDescriptor{
		authType,
		{ID: dbuser.OptHosts, Type: dbuser.OptionList, Tab: dbuser.TabGeneral, Kinds: []dbuser.PrincipalKind{user}},
		dbuser.StringOption(dbuser.OptDefaultDatabase, dbuser.TabGeneral, user),
		dbuser.EnumOption(dbuser.OptSettingsProfile, dbuser.TabAdvanced, dbuser.Choices(settingsProfiles...), user, role),
		{ID: dbuser.OptDefaultRoles, Type: dbuser.OptionMulti, Tab: dbuser.TabMembership, Kinds: []dbuser.PrincipalKind{user}},
	}
	if profile.Feature(featValidUntil) {
		options = append(options, dbuser.OptionDescriptor{ID: dbuser.OptValidUntil, Type: dbuser.OptionDateTime, Tab: dbuser.TabGeneral, Kinds: []dbuser.PrincipalKind{user}})
	}
	if len(clusters) > 0 {
		onCluster := dbuser.EnumOption(dbuser.OptOnCluster, dbuser.TabAdvanced, dbuser.Choices(clusters...), user, role)
		options = append(options, onCluster)
	}
	return options
}
