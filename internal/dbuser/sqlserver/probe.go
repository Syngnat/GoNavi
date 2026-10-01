// Package sqlserver 实现 SQL Server（2005 起，含 Azure SQL）的账号管理。
// SQL Server 是两级主体：服务器登录名（login）与数据库用户（dbuser），角色分服务器角色与数据库角色。
package sqlserver

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 特性开关。
const (
	featAlterRoleMember = "alterRoleMember"
	featContainedUsers  = "containedUsers"
	featAzureDatabase   = "azureDatabase"
	featServerLevel     = "serverLevel"
)

// 方言开关。
const dialectDatabase = "database"

// 提示码。
const (
	noticeAzureDatabase     = "sqlserver_azure_database"
	noticeLimitedVisibility = "sqlserver_limited_visibility"
	noticeLegacyMembership  = "sqlserver_legacy_membership"
)

// engineEditionAzureSQL 是 SERVERPROPERTY('EngineEdition') 中 Azure SQL Database 的取值。
const engineEditionAzureSQL = 5

// Provider 是 SQL Server 实现。
type Provider struct{}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 SQL Server Provider。
func New() *Provider {
	return &Provider{}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	return dbuser.FamilySQLServer
}

var productYears = map[int]string{9: "2005", 10: "2008", 11: "2012", 12: "2014", 13: "2016", 14: "2017", 15: "2019", 16: "2022", 17: "2025"}

// Probe 实现 dbuser.Provider。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, target dbuser.Target) (dbuser.ServerProfile, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version, CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition, SUSER_SNAME() AS login_name, DB_NAME() AS db_name, @@VERSION AS banner")
	if err != nil {
		return dbuser.ServerProfile{}, fmt.Errorf("probe sqlserver version: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.ServerProfile{}, fmt.Errorf("probe sqlserver version: empty result")
	}
	row := rows[0]
	version := dbuser.ParseDottedVersion(dbuser.CellString(row, "product_version"))
	edition, _ := dbuser.CellInt(row, "engine_edition")
	azure := edition == engineEditionAzureSQL
	database := dbuser.CellString(row, "db_name")
	profile := dbuser.ServerProfile{
		Supported:   true,
		Family:      dbuser.FamilySQLServer,
		Flavor:      "sqlserver",
		Version:     version,
		VersionText: versionText(version, azure),
		Banner:      strings.TrimSpace(strings.SplitN(dbuser.CellString(row, "banner"), "\n", 2)[0]),
		CurrentUser: dbuser.CellString(row, "login_name"),
		Features: map[string]bool{
			featAlterRoleMember:  version.AtLeast(11, 0, 0) || azure,
			featContainedUsers:   version.AtLeast(11, 0, 0) || azure,
			featAzureDatabase:    azure,
			featServerLevel:      !azure || strings.EqualFold(database, "master"),
			"databaseScoped":     true,
			"rolesMatchDatabase": true,
			"deny":               true,
			"grantOption":        true,
			"adminOption":        false,
		},
		Dialect: map[string]string{dialectDatabase: database},
	}
	if azure {
		profile.Flavor = "azure-sql"
	}
	profile.Permissions = probePermissions(ctx, env)
	profile.Kinds = buildKinds(profile)
	profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabObjectPrivileges, dbuser.TabMembership, dbuser.TabPreview}
	profile.ObjectScopes = []string{dbuser.ScopeDatabase, dbuser.ScopeSchema, dbuser.ScopeTable, dbuser.ScopeColumn, dbuser.ScopeRoutine}
	profile.Privileges = probePrivileges(ctx, env)
	profile.Options = buildOptions(profile)
	profile.Notices = buildNotices(profile)
	return profile, nil
}

func versionText(v dbuser.Version, azure bool) string {
	if azure {
		return "Azure SQL " + v.String()
	}
	year := productYears[v.Major]
	if v.Major == 10 && v.Minor >= 50 {
		year = "2008 R2"
	}
	if year == "" {
		return "SQL Server " + v.String()
	}
	return "SQL Server " + year + " (" + v.String() + ")"
}

func probePermissions(ctx context.Context, env dbuser.Env) dbuser.Permissions {
	rows, err := env.SQL.Query(ctx, "", "SELECT IS_SRVROLEMEMBER('sysadmin') AS sysadmin, IS_SRVROLEMEMBER('securityadmin') AS securityadmin, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER ANY USER') AS alter_user")
	if err != nil || len(rows) == 0 {
		return dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true}
	}
	manage := dbuser.CellBool(rows[0], "sysadmin") || dbuser.CellBool(rows[0], "securityadmin") || dbuser.CellBool(rows[0], "alter_user")
	return dbuser.Permissions{CanList: true, CanCreate: manage, CanAlter: manage, CanDrop: manage, CanGrant: manage}
}

func buildKinds(profile dbuser.ServerProfile) []dbuser.KindDescriptor {
	kinds := []dbuser.KindDescriptor{
		{Kind: dbuser.KindDBUser, Creatable: true, IdentityFields: []string{"name", "database"}, Renamable: true, SupportsPassword: profile.Feature(featContainedUsers),
			EditorTabs: []string{dbuser.TabGeneral, dbuser.TabObjectPrivileges, dbuser.TabMembership, dbuser.TabPreview}},
		{Kind: dbuser.KindRole, Creatable: true, IdentityFields: []string{"name", "database"}, Renamable: true,
			EditorTabs: []string{dbuser.TabGeneral, dbuser.TabObjectPrivileges, dbuser.TabMembership, dbuser.TabPreview}},
	}
	if profile.Feature(featServerLevel) {
		kinds = append([]dbuser.KindDescriptor{{
			Kind: dbuser.KindLogin, Creatable: true, IdentityFields: []string{"name"}, Renamable: true, SupportsPassword: true,
			EditorTabs: []string{dbuser.TabGeneral, dbuser.TabServerPrivileges, dbuser.TabMembership, dbuser.TabPreview},
		}}, kinds...)
	}
	return kinds
}

func buildOptions(profile dbuser.ServerProfile) []dbuser.OptionDescriptor {
	login, dbUser := dbuser.KindLogin, dbuser.KindDBUser
	loginType := dbuser.EnumOption(dbuser.OptLoginType, dbuser.TabGeneral, dbuser.Choices("sql", "windows"), login)
	loginType.CreateOnly, loginType.Default = true, "sql"
	userTypes := dbuser.Choices("login", "without_login")
	if profile.Feature(featContainedUsers) {
		userTypes = append(userTypes, dbuser.Choice{Value: "password"})
	}
	userType := dbuser.EnumOption(dbuser.OptDBUserType, dbuser.TabGeneral, userTypes, dbUser)
	userType.CreateOnly, userType.Default = true, "login"
	checkPolicy := dbuser.BoolOption(dbuser.OptCheckPolicy, dbuser.TabGeneral, login)
	checkPolicy.Default = "true"
	return []dbuser.OptionDescriptor{
		loginType,
		dbuser.BoolOption(dbuser.OptLoginEnabled, dbuser.TabGeneral, login),
		dbuser.BoolOption(dbuser.OptAccountLocked, dbuser.TabGeneral, login),
		checkPolicy,
		dbuser.BoolOption(dbuser.OptCheckExpiration, dbuser.TabGeneral, login),
		dbuser.BoolOption(dbuser.OptMustChange, dbuser.TabGeneral, login),
		dbuser.StringOption(dbuser.OptDefaultDatabase, dbuser.TabGeneral, login),
		dbuser.StringOption(dbuser.OptDefaultLanguage, dbuser.TabGeneral, login),
		userType,
		dbuser.StringOption(dbuser.OptLoginName, dbuser.TabGeneral, dbUser),
		dbuser.StringOption(dbuser.OptDefaultSchema, dbuser.TabGeneral, dbUser),
	}
}

func buildNotices(profile dbuser.ServerProfile) []dbuser.Notice {
	var notices []dbuser.Notice
	if profile.Feature(featAzureDatabase) {
		notices = append(notices, dbuser.Notef(noticeAzureDatabase, dbuser.LevelInfo))
	}
	if !profile.Feature(featAlterRoleMember) {
		notices = append(notices, dbuser.Notef(noticeLegacyMembership, dbuser.LevelInfo, "version", profile.VersionText))
	}
	if !profile.Permissions.CanCreate {
		notices = append(notices, dbuser.Notef(noticeLimitedVisibility, dbuser.LevelWarning))
	}
	return notices
}
