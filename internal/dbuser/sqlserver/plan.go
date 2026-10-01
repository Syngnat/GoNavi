package sqlserver

import (
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// sysname 上限 128 字符。
var sysnameRule = dbuser.NameRule{MaxLength: 128}

type planner struct {
	profile dbuser.ServerProfile
}

func q(name string) string {
	return dbuser.QuoteBracket(name)
}

// Plan 实现 dbuser.Provider。SQL Server 的登录名语句不能放进用户事务，统一逐条执行。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	pl := planner{profile: profile}
	if err := pl.validate(request); err != nil {
		return dbuser.Plan{}, err
	}
	var statements []dbuser.Statement
	var err error
	switch request.Target.Kind {
	case dbuser.KindLogin:
		statements, err = pl.planLogin(request)
	case dbuser.KindDBUser:
		statements, err = pl.planDatabaseUser(request)
	default:
		statements, err = pl.planDatabaseRole(request)
	}
	if err != nil {
		return dbuser.Plan{}, err
	}
	return dbuser.Plan{Statements: statements}, nil
}

func (p planner) validate(request dbuser.ChangeRequest) error {
	names := []string{request.Target.Name}
	if request.Rename != nil {
		names = append(names, request.Rename.Name)
	}
	for _, id := range []string{dbuser.OptDefaultDatabase, dbuser.OptDefaultLanguage, dbuser.OptLoginName, dbuser.OptDefaultSchema} {
		if value := strings.TrimSpace(request.Options[id]); value != "" {
			names = append(names, value)
		}
	}
	for _, name := range names {
		if err := dbuser.ValidateName(name, sysnameRule); err != nil {
			return err
		}
	}
	if request.Target.Kind == dbuser.KindRole && request.Target.Database == "" && request.Action != dbuser.ActionCreate {
		return dbuser.Errorf(dbuser.ErrCodeKindNotSupported, "kind", "server-role")
	}
	if locked, ok := dbuser.OptionBoolValue(request.Options, dbuser.OptAccountLocked); ok && locked {
		// 登录名只能被口令策略锁定，不能手工锁定；需要禁止登录请用 DISABLE。
		return dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", dbuser.OptAccountLocked)
	}
	if request.Action == dbuser.ActionDrop && (isSystemLogin(request.Target.Name) || isSystemDatabasePrincipal(request.Target.Name, false)) {
		return dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", request.Target.Name)
	}
	return dbuser.ValidateGrants(p.profile, append(append([]dbuser.Grant{}, request.GrantsAdd...), request.GrantsRevoke...))
}

func passwordSecret(builder *dbuser.SQLBuilder, value string) {
	builder.Secret(dbuser.NString(value), "N"+dbuser.Masked("'", "'"))
}

func (p planner) planLogin(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	name := request.Target.Name
	options := request.Options
	switch request.Action {
	case dbuser.ActionDrop:
		return []dbuser.Statement{dbuser.Plain("DROP LOGIN "+q(name), "", dbuser.RiskDanger)}, nil
	case dbuser.ActionCreate:
		return p.createLogin(request)
	}
	statements := make([]dbuser.Statement, 0, 6)
	if request.Rename != nil && request.Rename.Name != name {
		statements = append(statements, dbuser.Plain("ALTER LOGIN "+q(name)+" WITH NAME = "+q(request.Rename.Name), "", dbuser.RiskHigh))
		name = request.Rename.Name
	}
	unlock := false
	if value, ok := dbuser.OptionBoolValue(options, dbuser.OptAccountLocked); ok && !value {
		unlock = true
	}
	if change := request.Password; change != nil && change.Set {
		if change.Password != "" {
			if err := dbuser.ValidatePassword(change.Password, name, p.profile.PasswordPolicy); err != nil {
				return nil, err
			}
		}
		var builder dbuser.SQLBuilder
		builder.Write("ALTER LOGIN ", q(name), " WITH PASSWORD = ")
		passwordSecret(&builder, change.Password)
		if change.CurrentPassword != "" {
			builder.Write(" OLD_PASSWORD = ")
			passwordSecret(&builder, change.CurrentPassword)
		}
		if must, _ := dbuser.OptionBoolValue(options, dbuser.OptMustChange); must {
			builder.Write(" MUST_CHANGE")
		}
		if unlock {
			builder.Write(" UNLOCK")
			unlock = false
		}
		statements = append(statements, builder.Statement("", dbuser.RiskHigh))
	}
	if unlock {
		// 未改口令时解锁：先关再开 CHECK_POLICY 会重置锁定计数（微软文档给出的做法）。
		statements = append(statements,
			dbuser.Plain("ALTER LOGIN "+q(name)+" WITH CHECK_POLICY = OFF", "", dbuser.RiskHigh),
			dbuser.Plain("ALTER LOGIN "+q(name)+" WITH CHECK_POLICY = ON", "", dbuser.RiskHigh))
	}
	if clauses := loginWithClauses(options); len(clauses) > 0 {
		statements = append(statements, dbuser.Plain("ALTER LOGIN "+q(name)+" WITH "+strings.Join(clauses, ", "), "", dbuser.RiskNormal))
	}
	if enabled, ok := dbuser.OptionBoolValue(options, dbuser.OptLoginEnabled); ok {
		statements = append(statements, loginEnableStatement(name, enabled))
	}
	return append(statements, p.serverRolesAndPermissions(name, request)...), nil
}

func loginEnableStatement(name string, enabled bool) dbuser.Statement {
	if enabled {
		return dbuser.Plain("ALTER LOGIN "+q(name)+" ENABLE", "", dbuser.RiskNormal)
	}
	return dbuser.Plain("ALTER LOGIN "+q(name)+" DISABLE", "", dbuser.RiskHigh)
}

func onOff(value bool) string {
	if value {
		return "ON"
	}
	return "OFF"
}

func loginWithClauses(options map[string]string) []string {
	clauses := make([]string, 0, 4)
	if value := strings.TrimSpace(options[dbuser.OptDefaultDatabase]); value != "" {
		clauses = append(clauses, "DEFAULT_DATABASE = "+q(value))
	}
	if value := strings.TrimSpace(options[dbuser.OptDefaultLanguage]); value != "" {
		clauses = append(clauses, "DEFAULT_LANGUAGE = "+q(value))
	}
	if value, ok := dbuser.OptionBoolValue(options, dbuser.OptCheckExpiration); ok {
		clauses = append(clauses, "CHECK_EXPIRATION = "+onOff(value))
	}
	if value, ok := dbuser.OptionBoolValue(options, dbuser.OptCheckPolicy); ok {
		clauses = append(clauses, "CHECK_POLICY = "+onOff(value))
	}
	return clauses
}

func (p planner) createLogin(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	name := request.Target.Name
	options := request.Options
	var builder dbuser.SQLBuilder
	builder.Write("CREATE LOGIN ", q(name))
	if options[dbuser.OptLoginType] == "windows" {
		builder.Write(" FROM WINDOWS")
		if clauses := loginWithClauses(map[string]string{
			dbuser.OptDefaultDatabase: options[dbuser.OptDefaultDatabase],
			dbuser.OptDefaultLanguage: options[dbuser.OptDefaultLanguage],
		}); len(clauses) > 0 {
			builder.Write(" WITH ", strings.Join(clauses, ", "))
		}
	} else {
		change := request.Password
		if change == nil || !change.Set {
			return nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
		}
		if change.Password != "" {
			if err := dbuser.ValidatePassword(change.Password, name, p.profile.PasswordPolicy); err != nil {
				return nil, err
			}
		}
		mustChange, _ := dbuser.OptionBoolValue(options, dbuser.OptMustChange)
		checkPolicy, policySet := dbuser.OptionBoolValue(options, dbuser.OptCheckPolicy)
		checkExpiration, _ := dbuser.OptionBoolValue(options, dbuser.OptCheckExpiration)
		if mustChange && (!checkExpiration || (policySet && !checkPolicy)) {
			// MUST_CHANGE 要求 CHECK_EXPIRATION 与 CHECK_POLICY 均为 ON。
			return nil, dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", dbuser.OptMustChange)
		}
		builder.Write(" WITH PASSWORD = ")
		passwordSecret(&builder, change.Password)
		if mustChange {
			builder.Write(" MUST_CHANGE")
		}
		if clauses := loginWithClauses(options); len(clauses) > 0 {
			builder.Write(", ", strings.Join(clauses, ", "))
		}
	}
	statements := []dbuser.Statement{builder.Statement("", dbuser.RiskNormal)}
	if enabled, ok := dbuser.OptionBoolValue(options, dbuser.OptLoginEnabled); ok && !enabled {
		statements = append(statements, loginEnableStatement(name, false))
	}
	return append(statements, p.serverRolesAndPermissions(name, request)...), nil
}

// serverRolesAndPermissions 处理服务器角色成员与服务器级权限。
func (p planner) serverRolesAndPermissions(name string, request dbuser.ChangeRequest) []dbuser.Statement {
	statements := permissionStatements(name, request, "")
	for _, membership := range request.MembershipsRemove {
		statements = append(statements, p.memberStatement(true, membership.Role.Name, name, false, ""))
	}
	for _, membership := range request.MembershipsAdd {
		statements = append(statements, p.memberStatement(true, membership.Role.Name, name, true, ""))
	}
	return statements
}

// memberStatement 生成角色成员增删；2012 前使用 sp_add*member 存储过程。
func (p planner) memberStatement(server bool, roleName, member string, add bool, database string) dbuser.Statement {
	risk := dbuser.RiskNormal
	if !add {
		risk = dbuser.RiskHigh
	}
	if p.profile.Feature(featAlterRoleMember) {
		action := " DROP MEMBER "
		if add {
			action = " ADD MEMBER "
		}
		keyword := "ALTER ROLE "
		if server {
			keyword = "ALTER SERVER ROLE "
		}
		return dbuser.Plain(keyword+q(roleName)+action+q(member), database, risk)
	}
	procedure := map[[2]bool]string{
		{true, true}: "sp_addsrvrolemember", {true, false}: "sp_dropsrvrolemember",
		{false, true}: "sp_addrolemember", {false, false}: "sp_droprolemember",
	}[[2]bool{server, add}]
	if server {
		return dbuser.Plain("EXEC "+procedure+" "+dbuser.NString(member)+", "+dbuser.NString(roleName), database, risk)
	}
	return dbuser.Plain("EXEC "+procedure+" "+dbuser.NString(roleName)+", "+dbuser.NString(member), database, risk)
}

func (p planner) planDatabaseUser(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	database := resolveDatabase(p.profile, request.Target.Database)
	name := request.Target.Name
	options := request.Options
	switch request.Action {
	case dbuser.ActionDrop:
		return []dbuser.Statement{dbuser.Plain("DROP USER "+q(name), database, dbuser.RiskDanger)}, nil
	case dbuser.ActionCreate:
		var builder dbuser.SQLBuilder
		builder.Write("CREATE USER ", q(name))
		schema := strings.TrimSpace(options[dbuser.OptDefaultSchema])
		switch options[dbuser.OptDBUserType] {
		case "without_login":
			builder.Write(" WITHOUT LOGIN")
			if schema != "" {
				builder.Write(" WITH DEFAULT_SCHEMA = ", q(schema))
			}
		case "password":
			change := request.Password
			if change == nil || !change.Set {
				return nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
			}
			builder.Write(" WITH PASSWORD = ")
			passwordSecret(&builder, change.Password)
			if schema != "" {
				builder.Write(", DEFAULT_SCHEMA = ", q(schema))
			}
		default:
			login := strings.TrimSpace(options[dbuser.OptLoginName])
			if login == "" {
				login = name
			}
			builder.Write(" FOR LOGIN ", q(login))
			if schema != "" {
				builder.Write(" WITH DEFAULT_SCHEMA = ", q(schema))
			}
		}
		statements := []dbuser.Statement{builder.Statement(database, dbuser.RiskNormal)}
		return append(statements, p.databaseRolesAndPermissions(name, database, request)...), nil
	}
	statements := make([]dbuser.Statement, 0, 6)
	if request.Rename != nil && request.Rename.Name != name {
		statements = append(statements, dbuser.Plain("ALTER USER "+q(name)+" WITH NAME = "+q(request.Rename.Name), database, dbuser.RiskHigh))
		name = request.Rename.Name
	}
	if schema, ok := options[dbuser.OptDefaultSchema]; ok && strings.TrimSpace(schema) != "" {
		statements = append(statements, dbuser.Plain("ALTER USER "+q(name)+" WITH DEFAULT_SCHEMA = "+q(schema), database, dbuser.RiskNormal))
	}
	if login, ok := options[dbuser.OptLoginName]; ok && strings.TrimSpace(login) != "" {
		// 重新映射登录名，用于修复孤立用户。
		statements = append(statements, dbuser.Plain("ALTER USER "+q(name)+" WITH LOGIN = "+q(login), database, dbuser.RiskHigh))
	}
	if change := request.Password; change != nil && change.Set {
		var builder dbuser.SQLBuilder
		builder.Write("ALTER USER ", q(name), " WITH PASSWORD = ")
		passwordSecret(&builder, change.Password)
		if change.CurrentPassword != "" {
			builder.Write(", OLD_PASSWORD = ")
			passwordSecret(&builder, change.CurrentPassword)
		}
		statements = append(statements, builder.Statement(database, dbuser.RiskHigh))
	}
	return append(statements, p.databaseRolesAndPermissions(name, database, request)...), nil
}

func (p planner) planDatabaseRole(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	database := resolveDatabase(p.profile, request.Target.Database)
	name := request.Target.Name
	switch request.Action {
	case dbuser.ActionDrop:
		return []dbuser.Statement{dbuser.Plain("DROP ROLE "+q(name), database, dbuser.RiskDanger)}, nil
	case dbuser.ActionCreate:
		statements := []dbuser.Statement{dbuser.Plain("CREATE ROLE "+q(name), database, dbuser.RiskNormal)}
		return append(statements, p.databaseRolesAndPermissions(name, database, request)...), nil
	}
	var statements []dbuser.Statement
	if request.Rename != nil && request.Rename.Name != name {
		statements = append(statements, dbuser.Plain("ALTER ROLE "+q(name)+" WITH NAME = "+q(request.Rename.Name), database, dbuser.RiskHigh))
		name = request.Rename.Name
	}
	return append(statements, p.databaseRolesAndPermissions(name, database, request)...), nil
}

func (p planner) databaseRolesAndPermissions(name, database string, request dbuser.ChangeRequest) []dbuser.Statement {
	statements := permissionStatements(name, request, database)
	for _, membership := range request.MembershipsRemove {
		statements = append(statements, p.memberStatement(false, membership.Role.Name, name, false, database))
	}
	for _, membership := range request.MembershipsAdd {
		statements = append(statements, p.memberStatement(false, membership.Role.Name, name, true, database))
	}
	return statements
}

// permissionStatements 生成 GRANT / DENY / REVOKE。REVOKE 同时撤销授予与拒绝。
func permissionStatements(grantee string, request dbuser.ChangeRequest, database string) []dbuser.Statement {
	statements := make([]dbuser.Statement, 0, len(request.GrantsAdd)+len(request.GrantsRevoke))
	for _, group := range dbuser.GroupGrants(request.GrantsRevoke) {
		prefix := "REVOKE "
		suffix := ""
		if group.WithGrantOption {
			prefix, suffix = "REVOKE GRANT OPTION FOR ", " CASCADE"
		}
		statements = append(statements, dbuser.Plain(prefix+privilegeClause(group)+onClause(group.Target)+" FROM "+q(grantee)+suffix, database, dbuser.RiskHigh))
	}
	for _, group := range dbuser.GroupGrants(request.GrantsAdd) {
		verb := "GRANT "
		if group.Deny {
			verb = "DENY "
		}
		text := verb + privilegeClause(group) + onClause(group.Target) + " TO " + q(grantee)
		risk := dbuser.RiskNormal
		if group.WithGrantOption && !group.Deny {
			text += " WITH GRANT OPTION"
			risk = dbuser.RiskHigh
		}
		if group.Deny {
			risk = dbuser.RiskHigh
		}
		statements = append(statements, dbuser.Plain(text, database, risk))
	}
	return statements
}

func privilegeClause(group dbuser.GrantGroup) string {
	if group.Target.Scope != dbuser.ScopeColumn {
		return dbuser.PrivilegeList(group.Privileges)
	}
	parts := make([]string, 0, len(group.Privileges))
	for _, privilege := range group.Privileges {
		parts = append(parts, privilege+" ("+q(group.Target.Column)+")")
	}
	return strings.Join(parts, ", ")
}

// onClause 生成 ON 子句：服务器/库级权限无 ON，架构用 SCHEMA::，对象用 OBJECT::。
func onClause(target dbuser.Grant) string {
	switch target.Scope {
	case dbuser.ScopeGlobal, dbuser.ScopeDatabase:
		return ""
	case dbuser.ScopeSchema:
		return " ON SCHEMA::" + q(target.Schema)
	default:
		object := q(target.Object)
		if target.Schema != "" {
			object = q(target.Schema) + "." + object
		}
		return " ON OBJECT::" + object
	}
}
