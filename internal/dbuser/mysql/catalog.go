package mysql

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// systemAccountPrefixes 是 MySQL 系内置账号；默认隐藏，禁止删除。
var systemAccountNames = map[string]bool{
	"mysql.sys": true, "mysql.session": true, "mysql.infoschema": true,
	"mariadb.sys": true, "public": true, "proxyro": true, "oraauditor": true,
}

func isSystemAccount(name string) bool {
	lower := strings.ToLower(name)
	return systemAccountNames[lower] || strings.HasPrefix(lower, "mysql.")
}

type sqlLiteral func(string) string

func literalFor(profile dbuser.ServerProfile) sqlLiteral {
	escapes := backslash(profile)
	return func(value string) string { return dbuser.MySQLString(value, escapes) }
}

// List 列出账号与角色。使用 SELECT * 以兼容各分支/版本的 mysql.user 列差异。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, _ dbuser.ListQuery) ([]dbuser.Principal, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM mysql.user")
	if err != nil {
		return nil, fmt.Errorf("list mysql accounts: %w", err)
	}
	roles := roleAccounts(ctx, env, profile)
	extras := mariaDBGlobalPriv(ctx, env, profile, "")
	principals := make([]dbuser.Principal, 0, len(rows))
	for _, row := range rows {
		principals = append(principals, principalFromRow(profile, row, roles, extras))
	}
	return principals, nil
}

func accountKey(user, host string) string {
	return user + "@" + host
}

// roleAccounts 返回被当作角色使用的账号集合（MySQL 8 role_edges 的 FROM 端）。
func roleAccounts(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile) map[string]bool {
	roles := map[string]bool{}
	if !profile.Feature(featRoles) || profile.Flavor == flavorMariaDB {
		return roles
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT DISTINCT FROM_USER AS from_user, FROM_HOST AS from_host FROM mysql.role_edges")
	if err != nil {
		return roles
	}
	for _, row := range rows {
		roles[accountKey(dbuser.CellString(row, "from_user"), dbuser.CellString(row, "from_host"))] = true
	}
	return roles
}

// mariaDBGlobalPriv 读取 MariaDB 10.4+ mysql.global_priv 的 JSON 属性（锁定、插件、口令寿命）。
func mariaDBGlobalPriv(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, where string) map[string]map[string]any {
	extras := map[string]map[string]any{}
	if profile.Flavor != flavorMariaDB || !profile.Version.AtLeast(10, 4, 0) {
		return extras
	}
	query := "SELECT User AS user_name, Host AS host_name, Priv AS priv FROM mysql.global_priv" + where
	rows, err := env.SQL.Query(ctx, "", query)
	if err != nil {
		return extras
	}
	for _, row := range rows {
		var priv map[string]any
		if json.Unmarshal([]byte(dbuser.CellString(row, "priv")), &priv) != nil {
			continue
		}
		extras[accountKey(dbuser.CellString(row, "user_name"), dbuser.CellString(row, "host_name"))] = priv
	}
	return extras
}

func principalFromRow(profile dbuser.ServerProfile, row map[string]any, roles map[string]bool, extras map[string]map[string]any) dbuser.Principal {
	user := dbuser.CellString(row, "User")
	host := dbuser.CellString(row, "Host")
	key := accountKey(user, host)
	extra := extras[key]
	locked := dbuser.CellBool(row, "account_locked") || dbuser.AsBool(extra["account_locked"])
	expired := dbuser.CellBool(row, "password_expired")
	plugin := dbuser.CellString(row, "plugin")
	if value := dbuser.AsString(extra["plugin"]); value != "" {
		plugin = value
	}
	isRole := dbuser.CellBool(row, "is_role") || roles[key] ||
		(profile.Feature(featRoles) && profile.Flavor != flavorMariaDB && locked && expired && dbuser.CellString(row, "authentication_string") == "")
	principal := dbuser.Principal{
		Ref:        dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: user, Host: host},
		System:     isSystemAccount(user),
		Locked:     locked,
		Expired:    expired,
		CanLogin:   !isRole,
		Superuser:  dbuser.CellBool(row, "Super_priv"),
		AuthMethod: plugin,
		Current:    key == profile.CurrentUser,
	}
	if isRole {
		principal.Ref.Kind = dbuser.KindRole
		principal.Locked = false
		principal.Expired = false
		principal.AuthMethod = ""
		if !profile.Feature(featRoleHost) {
			principal.Ref.Host = ""
		}
	}
	if user == "" {
		principal.Tags = append(principal.Tags, "anonymous")
	}
	return principal
}

// accountFilter 生成定位 mysql.user 某行的 WHERE 子句。
func accountFilter(ref dbuser.PrincipalRef, literal sqlLiteral) string {
	return " WHERE User = " + literal(ref.Name) + " AND Host = " + literal(ref.Host)
}

// grantee 生成 information_schema 中 GRANTEE 列的取值：'user'@'host' 或 MariaDB 角色 'role'。
func grantee(ref dbuser.PrincipalRef, profile dbuser.ServerProfile) string {
	if ref.Kind == dbuser.KindRole && !profile.Feature(featRoleHost) {
		return "'" + ref.Name + "'"
	}
	return "'" + ref.Name + "'@'" + ref.Host + "'"
}

// Describe 读取账号属性、各层级权限与角色关系。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	literal := literalFor(profile)
	ref := query.Ref
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM mysql.user"+accountFilter(ref, literal))
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe mysql account: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	extras := mariaDBGlobalPriv(ctx, env, profile, accountFilter(ref, literal))
	roles := map[string]bool{}
	if ref.Kind == dbuser.KindRole {
		roles[accountKey(ref.Name, ref.Host)] = true
	}
	detail := dbuser.PrincipalDetail{
		Principal: principalFromRow(profile, rows[0], roles, extras),
		Options:   optionsFromRow(profile, rows[0], extras[accountKey(ref.Name, ref.Host)]),
	}
	detail.Principal.Ref = ref
	detail.Grants = describeGrants(ctx, env, profile, ref, literal)
	detail.MemberOf, detail.Members = describeMemberships(ctx, env, profile, ref, literal)
	if profile.Feature(featDefaultRoles) && ref.Kind == dbuser.KindUser {
		detail.Options[dbuser.OptDefaultRoles] = dbuser.JoinList(describeDefaultRoles(ctx, env, profile, ref, rows[0], literal))
	}
	return detail, nil
}

// optionsFromRow 从 mysql.user 行与 MariaDB global_priv JSON 还原字段取值。
func optionsFromRow(profile dbuser.ServerProfile, row map[string]any, extra map[string]any) map[string]string {
	options := map[string]string{}
	set := func(id string, value string) {
		if _, ok := profile.Option(id); ok {
			options[id] = value
		}
	}
	plugin := dbuser.CellString(row, "plugin")
	if value := dbuser.AsString(extra["plugin"]); value != "" {
		plugin = value
	}
	set(dbuser.OptAuthPlugin, plugin)
	set(dbuser.OptAccountLocked, strconv.FormatBool(dbuser.CellBool(row, "account_locked") || dbuser.AsBool(extra["account_locked"])))
	set(dbuser.OptExpirePasswordNow, "false")
	lifetime, hasLifetime := dbuser.CellInt(row, "password_lifetime")
	if extraLifetime, ok := dbuser.AsInt(extra["password_lifetime"]); ok {
		lifetime, hasLifetime = extraLifetime, extraLifetime >= 0
	}
	switch {
	case !hasLifetime:
		set(dbuser.OptPasswordExpirePolicy, expireDefault)
	case lifetime == 0:
		set(dbuser.OptPasswordExpirePolicy, expireNever)
	default:
		set(dbuser.OptPasswordExpirePolicy, expireInterval)
		set(dbuser.OptPasswordLifetimeDays, strconv.FormatInt(lifetime, 10))
	}
	for id, column := range map[string]string{
		dbuser.OptMaxQueriesPerHour:     "max_questions",
		dbuser.OptMaxUpdatesPerHour:     "max_updates",
		dbuser.OptMaxConnectionsPerHour: "max_connections",
		dbuser.OptMaxUserConnections:    "max_user_connections",
		dbuser.OptPasswordHistory:       "Password_reuse_history",
		dbuser.OptPasswordReuseDays:     "Password_reuse_time",
	} {
		if value, ok := dbuser.CellInt(row, column); ok {
			set(id, strconv.FormatInt(value, 10))
		} else {
			set(id, "")
		}
	}
	set(dbuser.OptRequireSSL, sslFromColumn(dbuser.CellString(row, "ssl_type")))
	switch strings.ToUpper(dbuser.CellString(row, "Password_require_current")) {
	case "Y":
		set(dbuser.OptPasswordRequireCurrent, requireCurrentRequired)
	case "N":
		set(dbuser.OptPasswordRequireCurrent, requireCurrentOptional)
	default:
		set(dbuser.OptPasswordRequireCurrent, requireCurrentDefault)
	}
	applyUserAttributes(dbuser.CellString(row, "User_attributes"), set)
	return options
}

func sslFromColumn(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "ANY":
		return sslAny
	case "X509":
		return sslX509
	case "SPECIFIED":
		return sslSpecified
	default:
		return sslNone
	}
}

// applyUserAttributes 解析 MySQL 8.0.19+ User_attributes JSON（失败锁定、注释）。
func applyUserAttributes(raw string, set func(id, value string)) {
	set(dbuser.OptFailedLoginAttempts, "0")
	set(dbuser.OptPasswordLockDays, "0")
	set(dbuser.OptComment, "")
	if strings.TrimSpace(raw) == "" {
		return
	}
	var attributes struct {
		PasswordLocking struct {
			FailedLoginAttempts  int64 `json:"failed_login_attempts"`
			PasswordLockTimeDays int64 `json:"password_lock_time_days"`
		} `json:"Password_locking"`
		Metadata map[string]any `json:"metadata"`
	}
	if json.Unmarshal([]byte(raw), &attributes) != nil {
		return
	}
	set(dbuser.OptFailedLoginAttempts, strconv.FormatInt(attributes.PasswordLocking.FailedLoginAttempts, 10))
	set(dbuser.OptPasswordLockDays, strconv.FormatInt(attributes.PasswordLocking.PasswordLockTimeDays, 10))
	if comment, ok := attributes.Metadata["comment"]; ok {
		set(dbuser.OptComment, dbuser.AsString(comment))
	}
}

// describeGrants 从 information_schema 各层级权限表与 mysql.procs_priv 读取结构化授权。
func describeGrants(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef, literal sqlLiteral) []dbuser.Grant {
	filter := " WHERE GRANTEE = " + literal(grantee(ref, profile))
	grants := make([]dbuser.Grant, 0, 16)
	queries := []struct {
		scope string
		query string
	}{
		{dbuser.ScopeGlobal, "SELECT PRIVILEGE_TYPE AS privilege_type, IS_GRANTABLE AS is_grantable FROM information_schema.USER_PRIVILEGES" + filter},
		{dbuser.ScopeDatabase, "SELECT TABLE_SCHEMA AS table_schema, PRIVILEGE_TYPE AS privilege_type, IS_GRANTABLE AS is_grantable FROM information_schema.SCHEMA_PRIVILEGES" + filter},
		{dbuser.ScopeTable, "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, PRIVILEGE_TYPE AS privilege_type, IS_GRANTABLE AS is_grantable FROM information_schema.TABLE_PRIVILEGES" + filter},
		{dbuser.ScopeColumn, "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, PRIVILEGE_TYPE AS privilege_type, IS_GRANTABLE AS is_grantable FROM information_schema.COLUMN_PRIVILEGES" + filter},
	}
	for _, item := range queries {
		rows, err := env.SQL.Query(ctx, "", item.query)
		if err != nil {
			continue
		}
		for _, row := range rows {
			privilege := dbuser.NormalizePrivilegeName(dbuser.CellString(row, "privilege_type"))
			if skippedPrivileges[privilege] {
				continue
			}
			grants = append(grants, dbuser.Grant{
				Privilege:       privilege,
				Scope:           item.scope,
				Database:        dbuser.CellString(row, "table_schema"),
				Object:          dbuser.CellString(row, "table_name"),
				Column:          dbuser.CellString(row, "column_name"),
				WithGrantOption: dbuser.CellBool(row, "is_grantable"),
			})
		}
	}
	return append(grants, describeRoutineGrants(ctx, env, ref, literal)...)
}

func describeRoutineGrants(ctx context.Context, env dbuser.Env, ref dbuser.PrincipalRef, literal sqlLiteral) []dbuser.Grant {
	rows, err := env.SQL.Query(ctx, "", "SELECT Db AS db_name, Routine_name AS routine_name, Routine_type AS routine_type, Proc_priv AS proc_priv FROM mysql.procs_priv"+accountFilter(ref, literal))
	if err != nil {
		return nil
	}
	grants := make([]dbuser.Grant, 0, len(rows))
	for _, row := range rows {
		privileges := strings.Split(dbuser.CellString(row, "proc_priv"), ",")
		withGrant := false
		for _, privilege := range privileges {
			withGrant = withGrant || strings.EqualFold(strings.TrimSpace(privilege), "Grant")
		}
		for _, privilege := range privileges {
			name := dbuser.NormalizePrivilegeName(privilege)
			if name == "" || name == "GRANT" {
				continue
			}
			grants = append(grants, dbuser.Grant{
				Privilege:       name,
				Scope:           dbuser.ScopeRoutine,
				Database:        dbuser.CellString(row, "db_name"),
				Object:          dbuser.CellString(row, "routine_name"),
				ObjectType:      strings.ToUpper(dbuser.CellString(row, "routine_type")),
				WithGrantOption: withGrant,
			})
		}
	}
	return grants
}

// describeMemberships 读取主体所属角色与（对角色而言）其成员。
func describeMemberships(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef, literal sqlLiteral) ([]dbuser.Membership, []dbuser.PrincipalRef) {
	if !profile.Feature(featRoles) {
		return nil, nil
	}
	if profile.Flavor == flavorMariaDB {
		return describeMariaDBMemberships(ctx, env, ref, literal)
	}
	var memberOf []dbuser.Membership
	rows, err := env.SQL.Query(ctx, "", "SELECT FROM_USER AS from_user, FROM_HOST AS from_host, WITH_ADMIN_OPTION AS admin_option FROM mysql.role_edges WHERE TO_USER = "+literal(ref.Name)+" AND TO_HOST = "+literal(ref.Host))
	if err == nil {
		for _, row := range rows {
			memberOf = append(memberOf, dbuser.Membership{
				Role:        dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.CellString(row, "from_user"), Host: dbuser.CellString(row, "from_host")},
				AdminOption: dbuser.CellBool(row, "admin_option"),
			})
		}
	}
	var members []dbuser.PrincipalRef
	if ref.Kind == dbuser.KindRole {
		rows, err = env.SQL.Query(ctx, "", "SELECT TO_USER AS to_user, TO_HOST AS to_host FROM mysql.role_edges WHERE FROM_USER = "+literal(ref.Name)+" AND FROM_HOST = "+literal(ref.Host))
		if err == nil {
			for _, row := range rows {
				members = append(members, dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: dbuser.CellString(row, "to_user"), Host: dbuser.CellString(row, "to_host")})
			}
		}
	}
	return memberOf, members
}

func describeMariaDBMemberships(ctx context.Context, env dbuser.Env, ref dbuser.PrincipalRef, literal sqlLiteral) ([]dbuser.Membership, []dbuser.PrincipalRef) {
	var memberOf []dbuser.Membership
	rows, err := env.SQL.Query(ctx, "", "SELECT Role AS role_name, Admin_option AS admin_option FROM mysql.roles_mapping WHERE User = "+literal(ref.Name)+" AND Host = "+literal(ref.Host))
	if err == nil {
		for _, row := range rows {
			memberOf = append(memberOf, dbuser.Membership{
				Role:        dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.CellString(row, "role_name")},
				AdminOption: dbuser.CellBool(row, "admin_option"),
			})
		}
	}
	var members []dbuser.PrincipalRef
	if ref.Kind == dbuser.KindRole {
		rows, err = env.SQL.Query(ctx, "", "SELECT User AS user_name, Host AS host_name FROM mysql.roles_mapping WHERE Role = "+literal(ref.Name))
		if err == nil {
			for _, row := range rows {
				member := dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: dbuser.CellString(row, "user_name"), Host: dbuser.CellString(row, "host_name")}
				if member.Host == "" {
					member.Kind = dbuser.KindRole
				}
				members = append(members, member)
			}
		}
	}
	return memberOf, members
}

// describeDefaultRoles 返回默认角色键：MySQL/TiDB 为 name@host，MariaDB 为 name。
func describeDefaultRoles(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef, row map[string]any, literal sqlLiteral) []string {
	if profile.Flavor == flavorMariaDB {
		if role := dbuser.CellString(row, "default_role"); role != "" {
			return []string{role}
		}
		return nil
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT DEFAULT_ROLE_USER AS role_user, DEFAULT_ROLE_HOST AS role_host FROM mysql.default_roles WHERE USER = "+literal(ref.Name)+" AND HOST = "+literal(ref.Host))
	if err != nil {
		return nil
	}
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, accountKey(dbuser.CellString(row, "role_user"), dbuser.CellString(row, "role_host")))
	}
	return keys
}
