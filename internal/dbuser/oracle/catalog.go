package oracle

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

func lit(value string) string {
	return dbuser.PlainString(value)
}

// List 列出用户与角色；没有 DBA 视图权限时回退 ALL_USERS（只读）。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, _ dbuser.ListQuery) ([]dbuser.Principal, error) {
	if !profile.Feature(featDBAViews) {
		rows, err := env.SQL.Query(ctx, "", "SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME")
		if err != nil {
			return nil, fmt.Errorf("list oracle users: %w", err)
		}
		principals := make([]dbuser.Principal, 0, len(rows))
		for _, row := range rows {
			name := dbuser.CellString(row, "USERNAME")
			principals = append(principals, dbuser.Principal{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: name}, System: isSystemUser(name, false), CanLogin: true, ReadOnly: true, Current: name == profile.CurrentUser})
		}
		return principals, nil
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM DBA_USERS ORDER BY USERNAME")
	if err != nil {
		return nil, fmt.Errorf("list oracle users: %w", err)
	}
	principals := make([]dbuser.Principal, 0, len(rows)+16)
	for _, row := range rows {
		principals = append(principals, userFromRow(profile, row))
	}
	roles, err := env.SQL.Query(ctx, "", "SELECT * FROM DBA_ROLES ORDER BY ROLE")
	if err == nil {
		for _, row := range roles {
			name := dbuser.CellString(row, "ROLE")
			principals = append(principals, dbuser.Principal{
				Ref:    dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: name},
				System: isSystemUser(name, dbuser.CellBool(row, "ORACLE_MAINTAINED")) || predefinedRoles[strings.ToUpper(name)],
			})
		}
	}
	return principals, nil
}

var predefinedRoles = map[string]bool{
	"DBA": true, "CONNECT": true, "RESOURCE": true, "PUBLIC": true, "SELECT_CATALOG_ROLE": true, "EXECUTE_CATALOG_ROLE": true,
	"EXP_FULL_DATABASE": true, "IMP_FULL_DATABASE": true, "DATAPUMP_EXP_FULL_DATABASE": true, "DATAPUMP_IMP_FULL_DATABASE": true,
	"SOI": true, "SVI": true, "VTI": true, "DB_AUDIT_ADMIN": true, "DB_POLICY_ADMIN": true, "DB_OBJECT_ADMIN": true,
}

func userFromRow(profile dbuser.ServerProfile, row map[string]any) dbuser.Principal {
	name := dbuser.CellString(row, "USERNAME")
	status := strings.ToUpper(dbuser.CellString(row, "ACCOUNT_STATUS"))
	principal := dbuser.Principal{
		Ref:        dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: name},
		System:     isSystemUser(name, dbuser.CellBool(row, "ORACLE_MAINTAINED")),
		Locked:     strings.Contains(status, "LOCKED"),
		Expired:    strings.Contains(status, "EXPIRED"),
		CanLogin:   !strings.EqualFold(dbuser.CellString(row, "AUTHENTICATION_TYPE"), "NONE"),
		AuthMethod: dbuser.CellString(row, "AUTHENTICATION_TYPE"),
		Current:    name == profile.CurrentUser,
	}
	if versions := dbuser.CellString(row, "PASSWORD_VERSIONS"); versions != "" {
		principal.Tags = append(principal.Tags, "pwd:"+strings.TrimSpace(versions))
	}
	return principal
}

// Describe 读取账号属性、系统/对象/列权限与角色。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	name := query.Ref.Name
	detail := dbuser.PrincipalDetail{Options: map[string]string{}}
	if query.Ref.Kind == dbuser.KindUser {
		rows, err := env.SQL.Query(ctx, "", "SELECT * FROM DBA_USERS WHERE USERNAME = "+lit(name))
		if err != nil {
			return dbuser.PrincipalDetail{}, fmt.Errorf("describe oracle user: %w", err)
		}
		if len(rows) == 0 {
			return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
		}
		detail.Principal = userFromRow(profile, rows[0])
		detail.Options = p.userOptions(ctx, env, profile, rows[0])
	} else {
		detail.Principal = dbuser.Principal{Ref: query.Ref, System: predefinedRoles[strings.ToUpper(name)]}
	}
	detail.Principal.Ref = query.Ref
	detail.Grants = describeGrants(ctx, env, name)
	defaults := make([]string, 0, 4)
	rows, _ := env.SQL.Query(ctx, "", "SELECT GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE FROM DBA_ROLE_PRIVS WHERE GRANTEE = "+lit(name))
	for _, row := range rows {
		role := dbuser.CellString(row, "GRANTED_ROLE")
		detail.MemberOf = append(detail.MemberOf, dbuser.Membership{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: role}, AdminOption: dbuser.CellBool(row, "ADMIN_OPTION")})
		if dbuser.CellBool(row, "DEFAULT_ROLE") {
			defaults = append(defaults, role)
		}
	}
	if _, ok := profile.Option(dbuser.OptDefaultRoles); ok && query.Ref.Kind == dbuser.KindUser {
		detail.Options[dbuser.OptDefaultRoles] = dbuser.JoinList(defaults)
	}
	if query.Ref.Kind == dbuser.KindRole {
		members, _ := env.SQL.Query(ctx, "", "SELECT GRANTEE FROM DBA_ROLE_PRIVS WHERE GRANTED_ROLE = "+lit(name))
		for _, member := range members {
			detail.Members = append(detail.Members, dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: dbuser.CellString(member, "GRANTEE")})
		}
	}
	return detail, nil
}

func (p *Provider) userOptions(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, row map[string]any) map[string]string {
	options := map[string]string{}
	set := func(id, value string) {
		if _, ok := profile.Option(id); ok {
			options[id] = value
		}
	}
	name := dbuser.CellString(row, "USERNAME")
	status := strings.ToUpper(dbuser.CellString(row, "ACCOUNT_STATUS"))
	defaultTablespace := dbuser.CellString(row, "DEFAULT_TABLESPACE")
	set(dbuser.OptAccountLocked, strconv.FormatBool(strings.Contains(status, "LOCKED")))
	set(dbuser.OptExpirePasswordNow, "false")
	set(dbuser.OptDefaultTablespace, defaultTablespace)
	set(dbuser.OptTemporaryTablespace, dbuser.CellString(row, "TEMPORARY_TABLESPACE"))
	set(dbuser.OptProfile, dbuser.CellString(row, "PROFILE"))
	set(dbuser.OptNoAuthentication, strconv.FormatBool(strings.EqualFold(dbuser.CellString(row, "AUTHENTICATION_TYPE"), "NONE")))
	if profile.Feature(featQuota) && defaultTablespace != "" {
		set(dbuser.OptTablespaceQuota, "")
		quotas, err := env.SQL.Query(ctx, "", "SELECT MAX_BYTES FROM DBA_TS_QUOTAS WHERE USERNAME = "+lit(name)+" AND TABLESPACE_NAME = "+lit(defaultTablespace))
		if err == nil && len(quotas) > 0 {
			set(dbuser.OptTablespaceQuota, formatQuota(quotas[0]))
		}
	}
	return options
}

func formatQuota(row map[string]any) string {
	maxBytes, ok := dbuser.CellInt(row, "MAX_BYTES")
	if !ok {
		return ""
	}
	if maxBytes < 0 {
		return "UNLIMITED"
	}
	const mb = 1024 * 1024
	if maxBytes%mb == 0 {
		return strconv.FormatInt(maxBytes/mb, 10) + "M"
	}
	return strconv.FormatInt(maxBytes, 10)
}

// describeGrants 读取系统权限（全局）、对象权限与列权限。
func describeGrants(ctx context.Context, env dbuser.Env, grantee string) []dbuser.Grant {
	grants := make([]dbuser.Grant, 0, 16)
	system, _ := env.SQL.Query(ctx, "", "SELECT PRIVILEGE, ADMIN_OPTION FROM DBA_SYS_PRIVS WHERE GRANTEE = "+lit(grantee))
	for _, row := range system {
		grants = append(grants, dbuser.Grant{
			Privilege:       dbuser.NormalizePrivilegeName(dbuser.CellString(row, "PRIVILEGE")),
			Scope:           dbuser.ScopeGlobal,
			WithGrantOption: dbuser.CellBool(row, "ADMIN_OPTION"),
		})
	}
	objects, _ := env.SQL.Query(ctx, "", "SELECT * FROM DBA_TAB_PRIVS WHERE GRANTEE = "+lit(grantee))
	for _, row := range objects {
		grant := dbuser.Grant{
			Privilege:       dbuser.NormalizePrivilegeName(dbuser.CellString(row, "PRIVILEGE")),
			Scope:           dbuser.ScopeTable,
			Schema:          dbuser.CellString(row, "OWNER"),
			Object:          dbuser.CellString(row, "TABLE_NAME"),
			WithGrantOption: dbuser.CellBool(row, "GRANTABLE"),
		}
		switch strings.ToUpper(dbuser.CellString(row, "TYPE")) {
		case "PROCEDURE", "FUNCTION", "PACKAGE", "TYPE":
			grant.Scope, grant.ObjectType = dbuser.ScopeRoutine, strings.ToUpper(dbuser.CellString(row, "TYPE"))
		case "SEQUENCE":
			grant.Scope = dbuser.ScopeSequence
		}
		grants = append(grants, grant)
	}
	columns, _ := env.SQL.Query(ctx, "", "SELECT OWNER, TABLE_NAME, COLUMN_NAME, PRIVILEGE, GRANTABLE FROM DBA_COL_PRIVS WHERE GRANTEE = "+lit(grantee))
	for _, row := range columns {
		grants = append(grants, dbuser.Grant{
			Privilege:       dbuser.NormalizePrivilegeName(dbuser.CellString(row, "PRIVILEGE")),
			Scope:           dbuser.ScopeColumn,
			Schema:          dbuser.CellString(row, "OWNER"),
			Object:          dbuser.CellString(row, "TABLE_NAME"),
			Column:          dbuser.CellString(row, "COLUMN_NAME"),
			WithGrantOption: dbuser.CellBool(row, "GRANTABLE"),
		})
	}
	return grants
}
