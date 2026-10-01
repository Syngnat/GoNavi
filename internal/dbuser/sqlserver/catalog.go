package sqlserver

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

var (
	systemDatabasePrincipals = map[string]bool{"dbo": true, "guest": true, "information_schema": true, "sys": true, "public": true}
	sqlLoginTypes            = map[string]bool{"S": true}
	databaseUserTypes        = map[string]bool{"S": true, "U": true, "G": true, "E": true, "X": true, "C": true, "K": true}
)

func isSystemLogin(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "##") || strings.HasPrefix(lower, `nt service\`) || strings.HasPrefix(lower, `nt authority\`) || lower == "public"
}

func isSystemDatabasePrincipal(name string, fixedRole bool) bool {
	return fixedRole || systemDatabasePrincipals[strings.ToLower(name)] || strings.HasPrefix(strings.ToLower(name), "db_")
}

// resolveDatabase 返回数据库级主体所在库：请求指定优先，其次连接默认库。
func resolveDatabase(profile dbuser.ServerProfile, database string) string {
	if strings.TrimSpace(database) != "" {
		return database
	}
	return profile.Dialect[dialectDatabase]
}

// List 列出服务器登录名、服务器角色（只读）与指定库的数据库用户/角色。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.ListQuery) ([]dbuser.Principal, error) {
	database := resolveDatabase(profile, query.Database)
	principals := make([]dbuser.Principal, 0, 64)
	serverSIDs := map[string]bool{}
	if profile.Feature(featServerLevel) {
		rows, err := env.SQL.Query(ctx, "", "SELECT sp.*, CONVERT(varchar(200), sp.sid, 1) AS sid_hex, CAST(LOGINPROPERTY(sp.name, 'IsLocked') AS int) AS is_locked, CAST(LOGINPROPERTY(sp.name, 'IsExpired') AS int) AS is_expired FROM sys.server_principals sp WHERE sp.type IN ('S','U','G','E','X','C','K','R')")
		if err != nil {
			return nil, fmt.Errorf("list sqlserver logins: %w", err)
		}
		for _, row := range rows {
			serverSIDs[dbuser.CellString(row, "sid_hex")] = true
			principals = append(principals, loginFromRow(profile, row))
		}
	}
	rows, err := env.SQL.Query(ctx, database, "SELECT dp.*, CONVERT(varchar(200), dp.sid, 1) AS sid_hex FROM sys.database_principals dp WHERE dp.type IN ('S','U','G','E','X','C','K','R')")
	if err != nil {
		if len(principals) > 0 {
			return principals, nil
		}
		return nil, fmt.Errorf("list sqlserver database principals: %w", err)
	}
	for _, row := range rows {
		principals = append(principals, databasePrincipalFromRow(row, database, serverSIDs, profile.Feature(featServerLevel)))
	}
	return principals, nil
}

func loginFromRow(profile dbuser.ServerProfile, row map[string]any) dbuser.Principal {
	name := dbuser.CellString(row, "name")
	kind := dbuser.KindLogin
	principalType := strings.ToUpper(strings.TrimSpace(dbuser.CellString(row, "type")))
	principal := dbuser.Principal{
		Ref:        dbuser.PrincipalRef{Kind: kind, Name: name},
		System:     isSystemLogin(name),
		Locked:     dbuser.CellBool(row, "is_locked"),
		Expired:    dbuser.CellBool(row, "is_expired"),
		CanLogin:   !dbuser.CellBool(row, "is_disabled"),
		AuthMethod: dbuser.CellString(row, "type_desc"),
		Current:    strings.EqualFold(name, profile.CurrentUser),
	}
	if principalType == "R" {
		// 服务器角色只读展示：固定服务器角色为系统对象，自定义服务器角色暂不支持编辑。
		principal.Ref.Kind = dbuser.KindRole
		principal.CanLogin = false
		principal.ReadOnly = true
		principal.System = principal.System || dbuser.CellBool(row, "is_fixed_role") || isFixedServerRole(name)
	}
	return principal
}

var fixedServerRoles = map[string]bool{
	"sysadmin": true, "securityadmin": true, "serveradmin": true, "setupadmin": true, "processadmin": true,
	"diskadmin": true, "dbcreator": true, "bulkadmin": true, "public": true,
}

func isFixedServerRole(name string) bool {
	return fixedServerRoles[strings.ToLower(name)] || strings.HasPrefix(name, "##")
}

func databasePrincipalFromRow(row map[string]any, database string, serverSIDs map[string]bool, serverVisible bool) dbuser.Principal {
	name := dbuser.CellString(row, "name")
	principalType := strings.ToUpper(strings.TrimSpace(dbuser.CellString(row, "type")))
	fixed := dbuser.CellBool(row, "is_fixed_role")
	principal := dbuser.Principal{
		Ref:        dbuser.PrincipalRef{Kind: dbuser.KindDBUser, Name: name, Database: database},
		System:     isSystemDatabasePrincipal(name, fixed),
		CanLogin:   databaseUserTypes[principalType],
		AuthMethod: dbuser.CellString(row, "authentication_type_desc"),
	}
	if principalType == "R" {
		principal.Ref.Kind = dbuser.KindRole
		principal.CanLogin = false
		return principal
	}
	// 孤立用户：SQL 用户（type S）映射的登录名 SID 在服务器上已不存在。
	sid := dbuser.CellString(row, "sid_hex")
	authType := strings.ToUpper(dbuser.CellString(row, "authentication_type_desc"))
	if serverVisible && sqlLoginTypes[principalType] && sid != "" && sid != "0x00" && !serverSIDs[sid] && authType != "DATABASE" && authType != "NONE" && !principal.System {
		principal.Tags = append(principal.Tags, "orphan")
	}
	return principal
}

// Describe 按主体种类读取属性、权限与角色成员关系。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	if query.Ref.Kind == dbuser.KindLogin || (query.Ref.Kind == dbuser.KindRole && query.Ref.Database == "") {
		return p.describeLogin(ctx, env, profile, query.Ref)
	}
	return p.describeDatabasePrincipal(ctx, env, profile, query.Ref)
}

func (p *Provider) describeLogin(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.PrincipalDetail, error) {
	literal := dbuser.NString(ref.Name)
	rows, err := env.SQL.Query(ctx, "", "SELECT sp.*, sl.is_policy_checked, sl.is_expiration_checked, CAST(LOGINPROPERTY(sp.name, 'IsLocked') AS int) AS is_locked, CAST(LOGINPROPERTY(sp.name, 'IsExpired') AS int) AS is_expired FROM sys.server_principals sp LEFT JOIN sys.sql_logins sl ON sl.principal_id = sp.principal_id WHERE sp.name = "+literal)
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe sqlserver login: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	row := rows[0]
	principalType := strings.ToUpper(strings.TrimSpace(dbuser.CellString(row, "type")))
	loginType := "windows"
	if principalType == "S" {
		loginType = "sql"
	}
	detail := dbuser.PrincipalDetail{
		Principal: loginFromRow(profile, row),
		Options: map[string]string{
			dbuser.OptLoginType:       loginType,
			dbuser.OptLoginEnabled:    strconv.FormatBool(!dbuser.CellBool(row, "is_disabled")),
			dbuser.OptAccountLocked:   strconv.FormatBool(dbuser.CellBool(row, "is_locked")),
			dbuser.OptCheckPolicy:     strconv.FormatBool(dbuser.CellBool(row, "is_policy_checked")),
			dbuser.OptCheckExpiration: strconv.FormatBool(dbuser.CellBool(row, "is_expiration_checked")),
			dbuser.OptMustChange:      "false",
			dbuser.OptDefaultDatabase: dbuser.CellString(row, "default_database_name"),
			dbuser.OptDefaultLanguage: dbuser.CellString(row, "default_language_name"),
		},
	}
	detail.Principal.Ref = ref
	permissions, _ := env.SQL.Query(ctx, "", "SELECT p.permission_name, p.state FROM sys.server_permissions p JOIN sys.server_principals sp ON sp.principal_id = p.grantee_principal_id WHERE sp.name = "+literal+" AND p.class = 100")
	for _, permission := range permissions {
		detail.Grants = append(detail.Grants, grantFromState(dbuser.Grant{Scope: dbuser.ScopeGlobal}, permission))
	}
	roles, _ := env.SQL.Query(ctx, "", "SELECT r.name FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id JOIN sys.server_principals u ON u.principal_id = m.member_principal_id WHERE u.name = "+literal)
	for _, role := range roles {
		detail.MemberOf = append(detail.MemberOf, dbuser.Membership{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.CellString(role, "name")}})
	}
	return detail, nil
}

func (p *Provider) describeDatabasePrincipal(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.PrincipalDetail, error) {
	database := resolveDatabase(profile, ref.Database)
	literal := dbuser.NString(ref.Name)
	rows, err := env.SQL.Query(ctx, database, "SELECT dp.*, CONVERT(varchar(200), dp.sid, 1) AS sid_hex, sp.name AS login_name FROM sys.database_principals dp LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid WHERE dp.name = "+literal)
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe sqlserver database principal: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	row := rows[0]
	detail := dbuser.PrincipalDetail{Principal: databasePrincipalFromRow(row, database, map[string]bool{dbuser.CellString(row, "sid_hex"): dbuser.CellString(row, "login_name") != ""}, true)}
	detail.Principal.Ref = ref
	detail.Principal.Ref.Database = database
	if ref.Kind == dbuser.KindDBUser {
		userType := "login"
		switch strings.ToUpper(dbuser.CellString(row, "authentication_type_desc")) {
		case "DATABASE":
			userType = "password"
		case "NONE":
			userType = "without_login"
		}
		detail.Options = map[string]string{
			dbuser.OptDBUserType:    userType,
			dbuser.OptLoginName:     dbuser.CellString(row, "login_name"),
			dbuser.OptDefaultSchema: dbuser.CellString(row, "default_schema_name"),
		}
	} else {
		detail.Options = map[string]string{}
	}
	detail.Grants = describeDatabasePermissions(ctx, env, database, literal)
	roles, _ := env.SQL.Query(ctx, database, "SELECT r.name FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE u.name = "+literal)
	for _, role := range roles {
		detail.MemberOf = append(detail.MemberOf, dbuser.Membership{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.CellString(role, "name"), Database: database}})
	}
	if ref.Kind == dbuser.KindRole {
		members, _ := env.SQL.Query(ctx, database, "SELECT u.name, u.type FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE r.name = "+literal)
		for _, member := range members {
			kind := dbuser.KindDBUser
			if strings.EqualFold(dbuser.CellString(member, "type"), "R") {
				kind = dbuser.KindRole
			}
			detail.Members = append(detail.Members, dbuser.PrincipalRef{Kind: kind, Name: dbuser.CellString(member, "name"), Database: database})
		}
	}
	return detail, nil
}

// describeDatabasePermissions 读取库级（class 0）、对象/列（class 1）与架构（class 3）权限。
func describeDatabasePermissions(ctx context.Context, env dbuser.Env, database, literal string) []dbuser.Grant {
	rows, err := env.SQL.Query(ctx, database, "SELECT p.class, p.permission_name, p.state, s.name AS schema_name, o.name AS object_name, o.type AS object_type, c.name AS column_name, sch.name AS target_schema FROM sys.database_permissions p JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id LEFT JOIN sys.objects o ON p.class = 1 AND o.object_id = p.major_id LEFT JOIN sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN sys.columns c ON p.class = 1 AND p.minor_id > 0 AND c.object_id = p.major_id AND c.column_id = p.minor_id LEFT JOIN sys.schemas sch ON p.class = 3 AND sch.schema_id = p.major_id WHERE dp.name = "+literal+" AND p.class IN (0, 1, 3)")
	if err != nil {
		return nil
	}
	grants := make([]dbuser.Grant, 0, len(rows))
	for _, row := range rows {
		class, _ := dbuser.CellInt(row, "class")
		target := dbuser.Grant{Database: database}
		switch class {
		case 0:
			target.Scope = dbuser.ScopeDatabase
		case 3:
			target.Scope = dbuser.ScopeSchema
			target.Schema = dbuser.CellString(row, "target_schema")
		default:
			target.Schema = dbuser.CellString(row, "schema_name")
			target.Object = dbuser.CellString(row, "object_name")
			target.Scope = dbuser.ScopeTable
			if column := dbuser.CellString(row, "column_name"); column != "" {
				target.Scope, target.Column = dbuser.ScopeColumn, column
			} else if objectType := routineObjectType(dbuser.CellString(row, "object_type")); objectType != "" {
				target.Scope, target.ObjectType = dbuser.ScopeRoutine, objectType
			}
		}
		grants = append(grants, grantFromState(target, row))
	}
	return grants
}

// routineObjectType 把 sys.objects.type 映射为例程类型。
func routineObjectType(objectType string) string {
	switch strings.ToUpper(strings.TrimSpace(objectType)) {
	case "P", "PC", "X":
		return "PROCEDURE"
	case "FN", "IF", "TF", "FS", "FT":
		return "FUNCTION"
	default:
		return ""
	}
}

// grantFromState 把 state（G 授予 / W 可转授 / D 拒绝）映射到 Grant。
func grantFromState(target dbuser.Grant, row map[string]any) dbuser.Grant {
	target.Privilege = dbuser.NormalizePrivilegeName(dbuser.CellString(row, "permission_name"))
	switch strings.ToUpper(strings.TrimSpace(dbuser.CellString(row, "state"))) {
	case "W":
		target.WithGrantOption = true
	case "D":
		target.Deny = true
	}
	return target
}
