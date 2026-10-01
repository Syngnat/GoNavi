package mysql

import (
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// planPrivilegesAndRoles 生成授权、撤权、角色成员与默认角色语句。
// 顺序：先撤后授（重新授予不同 WITH GRANT OPTION 时不会被随后的撤销抵消）。
func (p planner) planPrivilegesAndRoles(target dbuser.PrincipalRef, request dbuser.ChangeRequest) []dbuser.Statement {
	account := p.account(target)
	statements := make([]dbuser.Statement, 0, len(request.GrantsAdd)+len(request.GrantsRevoke)+4)
	for _, group := range dbuser.GroupGrants(request.GrantsRevoke) {
		if group.WithGrantOption {
			statements = append(statements, dbuser.Plain("REVOKE GRANT OPTION ON "+grantTarget(group.Target)+" FROM "+account, "", dbuser.RiskHigh))
			continue
		}
		statements = append(statements, dbuser.Plain("REVOKE "+privilegeClause(group)+" ON "+grantTarget(group.Target)+" FROM "+account, "", dbuser.RiskHigh))
	}
	for _, group := range dbuser.GroupGrants(request.GrantsAdd) {
		text := "GRANT " + privilegeClause(group) + " ON " + grantTarget(group.Target) + " TO " + account
		if group.WithGrantOption {
			text += " WITH GRANT OPTION"
		}
		statements = append(statements, dbuser.Plain(text, "", grantRisk(group)))
	}
	if !p.feature(featRoles) {
		return statements
	}
	for _, membership := range request.MembershipsRemove {
		statements = append(statements, dbuser.Plain("REVOKE "+p.roleRef(membership.Role)+" FROM "+account, "", dbuser.RiskHigh))
	}
	for _, membership := range request.MembershipsAdd {
		text := "GRANT " + p.roleRef(membership.Role) + " TO " + account
		if membership.AdminOption {
			text += " WITH ADMIN OPTION"
		}
		statements = append(statements, dbuser.Plain(text, "", dbuser.RiskNormal))
	}
	if raw, ok := request.Options[dbuser.OptDefaultRoles]; ok && p.feature(featDefaultRoles) && target.Kind == dbuser.KindUser {
		statements = append(statements, p.defaultRoleStatement(account, dbuser.SplitList(raw)))
	}
	return statements
}

func (p planner) roleRef(role dbuser.PrincipalRef) string {
	role.Kind = dbuser.KindRole
	return p.account(role)
}

func (p planner) defaultRoleStatement(account string, keys []string) dbuser.Statement {
	if p.feature(featSingleDefaultRole) {
		// MariaDB 只允许一个默认角色。
		role := "NONE"
		if len(keys) > 0 {
			role = dbuser.QuoteBacktick(keys[0])
		}
		return dbuser.Plain("SET DEFAULT ROLE "+role+" FOR "+account, "", dbuser.RiskNormal)
	}
	if len(keys) == 0 {
		return dbuser.Plain("SET DEFAULT ROLE NONE TO "+account, "", dbuser.RiskNormal)
	}
	roles := make([]string, 0, len(keys))
	for _, key := range keys {
		name, host := splitAccount(key)
		roles = append(roles, dbuser.MySQLAccount(name, host))
	}
	return dbuser.Plain("SET DEFAULT ROLE "+strings.Join(roles, ", ")+" TO "+account, "", dbuser.RiskNormal)
}

// privilegeClause 生成权限列表；列级权限写成 SELECT (`c`)。
func privilegeClause(group dbuser.GrantGroup) string {
	if group.Target.Scope != dbuser.ScopeColumn {
		return dbuser.PrivilegeList(group.Privileges)
	}
	parts := make([]string, 0, len(group.Privileges))
	for _, privilege := range group.Privileges {
		parts = append(parts, privilege+" ("+dbuser.QuoteBacktick(group.Target.Column)+")")
	}
	return strings.Join(parts, ", ")
}

// grantTarget 生成 ON 之后的对象。库级授权中的 _ 与 % 由 MySQL 视为通配符，按原样透传。
func grantTarget(grant dbuser.Grant) string {
	switch grant.Scope {
	case dbuser.ScopeGlobal:
		return "*.*"
	case dbuser.ScopeDatabase:
		return dbuser.QuoteBacktick(grant.Database) + ".*"
	case dbuser.ScopeRoutine:
		return strings.ToUpper(grant.ObjectType) + " " + dbuser.QuoteBacktick(grant.Database) + "." + dbuser.QuoteBacktick(grant.Object)
	default:
		return dbuser.QuoteBacktick(grant.Database) + "." + dbuser.QuoteBacktick(grant.Object)
	}
}

// highRiskPrivileges 是授予后等同于管理员的权限。
var highRiskPrivileges = map[string]bool{
	"SUPER": true, "CREATE USER": true, "FILE": true, "SHUTDOWN": true, "PROCESS": true,
	"RELOAD": true, "GRANT OPTION": true, "SYSTEM_USER": true, "CONNECTION_ADMIN": true,
}

func grantRisk(group dbuser.GrantGroup) string {
	if group.WithGrantOption {
		return dbuser.RiskHigh
	}
	for _, privilege := range group.Privileges {
		if highRiskPrivileges[privilege] {
			return dbuser.RiskHigh
		}
	}
	return dbuser.RiskNormal
}
