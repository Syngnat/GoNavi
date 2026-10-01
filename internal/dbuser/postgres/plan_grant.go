package postgres

import (
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// planPrivilegesAndMemberships 先撤后授，再处理角色成员。
func (p planner) planPrivilegesAndMemberships(grantee string, request dbuser.ChangeRequest) []dbuser.Statement {
	statements := make([]dbuser.Statement, 0, len(request.GrantsAdd)+len(request.GrantsRevoke)+4)
	for _, group := range dbuser.GroupGrants(request.GrantsRevoke) {
		prefix := "REVOKE "
		if group.WithGrantOption {
			prefix = "REVOKE GRANT OPTION FOR "
		}
		statements = append(statements, dbuser.Plain(prefix+privilegeClause(group)+" ON "+p.grantTarget(group.Target)+" FROM "+role(grantee), grantDatabase(group.Target), dbuser.RiskHigh))
	}
	for _, group := range dbuser.GroupGrants(request.GrantsAdd) {
		text := "GRANT " + privilegeClause(group) + " ON " + p.grantTarget(group.Target) + " TO " + role(grantee)
		risk := dbuser.RiskNormal
		if group.WithGrantOption {
			text += " WITH GRANT OPTION"
			risk = dbuser.RiskHigh
		}
		statements = append(statements, dbuser.Plain(text, grantDatabase(group.Target), risk))
	}
	for _, membership := range request.MembershipsRemove {
		statements = append(statements, dbuser.Plain("REVOKE "+role(membership.Role.Name)+" FROM "+role(grantee), "", dbuser.RiskHigh))
	}
	for _, membership := range request.MembershipsAdd {
		statements = append(statements, dbuser.Plain("GRANT "+role(membership.Role.Name)+" TO "+role(grantee)+p.membershipOptions(membership), "", dbuser.RiskNormal))
	}
	return statements
}

func (p planner) membershipOptions(membership dbuser.Membership) string {
	if !p.feature(featMembershipOptions) {
		if membership.AdminOption {
			return " WITH ADMIN OPTION"
		}
		return ""
	}
	options := make([]string, 0, 3)
	if membership.AdminOption {
		options = append(options, "ADMIN TRUE")
	}
	if membership.Inherit != nil && !*membership.Inherit {
		options = append(options, "INHERIT FALSE")
	}
	if membership.Set != nil && !*membership.Set {
		options = append(options, "SET FALSE")
	}
	if len(options) == 0 {
		return ""
	}
	return " WITH " + strings.Join(options, ", ")
}

// grantDatabase 返回执行库：库级授权写在共享 catalog，可在默认库执行；其余按对象所在库。
func grantDatabase(target dbuser.Grant) string {
	if target.Scope == dbuser.ScopeDatabase {
		return ""
	}
	return target.Database
}

func privilegeClause(group dbuser.GrantGroup) string {
	if group.Target.Scope != dbuser.ScopeColumn {
		return dbuser.PrivilegeList(group.Privileges)
	}
	parts := make([]string, 0, len(group.Privileges))
	for _, privilege := range group.Privileges {
		parts = append(parts, privilege+" ("+dbuser.QuoteDouble(group.Target.Column)+")")
	}
	return strings.Join(parts, ", ")
}

func qualified(schema, object string) string {
	if schema == "" {
		return dbuser.QuoteDouble(object)
	}
	return dbuser.QuoteDouble(schema) + "." + dbuser.QuoteDouble(object)
}

func (p planner) grantTarget(target dbuser.Grant) string {
	switch target.Scope {
	case dbuser.ScopeDatabase:
		return "DATABASE " + dbuser.QuoteDouble(target.Database)
	case dbuser.ScopeSchema:
		return "SCHEMA " + dbuser.QuoteDouble(target.Schema)
	case dbuser.ScopeSequence:
		return "SEQUENCE " + qualified(target.Schema, target.Object)
	case dbuser.ScopeRoutine:
		name, args, _ := splitRoutineSignature(target.Object)
		keyword := "FUNCTION "
		if strings.EqualFold(target.ObjectType, "PROCEDURE") && p.feature(featRoutineKeyword) {
			keyword = "PROCEDURE "
		}
		return keyword + qualified(target.Schema, name) + "(" + args + ")"
	default:
		return "TABLE " + qualified(target.Schema, target.Object)
	}
}
