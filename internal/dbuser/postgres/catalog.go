package postgres

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/dbuser"
)

func rolesRelation(profile dbuser.ServerProfile) string {
	if relation := profile.Dialect[dialectRolesRelation]; relation != "" {
		return relation
	}
	return "pg_catalog.pg_roles"
}

// roleOIDExpr 生成按名称定位角色 OID 的子查询。
func roleOIDExpr(profile dbuser.ServerProfile, name string) string {
	return "(SELECT oid FROM " + rolesRelation(profile) + " WHERE rolname = " + dbuser.PGString(name) + ")"
}

func isSystemRole(name string) bool {
	return strings.HasPrefix(name, "pg_") || strings.HasPrefix(name, "gs_role_")
}

// List 实现 dbuser.Provider。SELECT * 兼容不同版本/分支的 pg_roles 列差异。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, _ dbuser.ListQuery) ([]dbuser.Principal, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM "+rolesRelation(profile)+" ORDER BY rolname")
	if err != nil {
		return nil, fmt.Errorf("list postgres roles: %w", err)
	}
	locked := p.lockedRoles(ctx, env)
	principals := make([]dbuser.Principal, 0, len(rows))
	for _, row := range rows {
		principals = append(principals, principalFromRow(profile, row, locked))
	}
	return principals, nil
}

// lockedRoles 读取 openGauss 的账户锁定状态（pg_user_status.rolstatus != 0）。
func (p *Provider) lockedRoles(ctx context.Context, env dbuser.Env) map[string]bool {
	locked := map[string]bool{}
	if p.variant != variantOpenGauss {
		return locked
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT r.rolname, s.rolstatus FROM pg_catalog.pg_user_status s JOIN pg_catalog.pg_roles r ON r.oid = s.roloid")
	if err != nil {
		return locked
	}
	for _, row := range rows {
		if status, ok := dbuser.CellInt(row, "rolstatus"); ok && status != 0 {
			locked[dbuser.CellString(row, "rolname")] = true
		}
	}
	return locked
}

func principalFromRow(profile dbuser.ServerProfile, row map[string]any, locked map[string]bool) dbuser.Principal {
	name := dbuser.CellString(row, "rolname")
	canLogin := dbuser.CellBool(row, "rolcanlogin")
	kind := dbuser.KindRole
	if canLogin {
		kind = dbuser.KindUser
	}
	return dbuser.Principal{
		Ref:       dbuser.PrincipalRef{Kind: kind, Name: name},
		System:    isSystemRole(name),
		Locked:    locked[name],
		Expired:   validUntilExpired(dbuser.CellString(row, "rolvaliduntil")),
		CanLogin:  canLogin,
		Superuser: dbuser.CellBool(row, "rolsuper") || dbuser.CellBool(row, "rolsystemadmin"),
		Current:   name == profile.CurrentUser,
	}
}

func validUntilExpired(value string) bool {
	parsed, ok := parseTimestamp(value)
	return ok && parsed.Before(time.Now())
}

func parseTimestamp(value string) (time.Time, bool) {
	text := strings.TrimSpace(value)
	if text == "" || strings.EqualFold(text, "infinity") {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05-07", "2006-01-02 15:04:05.999999-07", "2006-01-02 15:04:05", "2006-01-02"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func formatTimestamp(value string) string {
	parsed, ok := parseTimestamp(value)
	if !ok {
		return ""
	}
	return parsed.Format("2006-01-02 15:04:05")
}

// Describe 实现 dbuser.Provider。对象权限按 query.Database（为空取连接默认库）读取。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	name := query.Ref.Name
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM "+rolesRelation(profile)+" WHERE rolname = "+dbuser.PGString(name))
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe postgres role: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	row := rows[0]
	detail := dbuser.PrincipalDetail{
		Principal: principalFromRow(profile, row, p.lockedRoles(ctx, env)),
		Options:   p.optionsFromRow(profile, row),
	}
	detail.Options[dbuser.OptComment] = roleComment(ctx, env, profile, name)
	if p.variant == variantOpenGauss {
		detail.Options[dbuser.OptAccountLocked] = strconv.FormatBool(detail.Principal.Locked)
	}
	detail.Grants = describeGrants(ctx, env, profile, name, query.Database)
	detail.MemberOf, detail.Members = describeMemberships(ctx, env, profile, name)
	return detail, nil
}

func (p *Provider) optionsFromRow(profile dbuser.ServerProfile, row map[string]any) map[string]string {
	options := map[string]string{}
	set := func(id, value string) {
		if _, ok := profile.Option(id); ok {
			options[id] = value
		}
	}
	for id, column := range map[string]string{
		dbuser.OptCanLogin: "rolcanlogin", dbuser.OptSuperuser: "rolsuper", dbuser.OptCreateDB: "rolcreatedb",
		dbuser.OptCreateRole: "rolcreaterole", dbuser.OptInherit: "rolinherit", dbuser.OptReplication: "rolreplication",
		dbuser.OptBypassRLS: "rolbypassrls", dbuser.OptSysAdmin: "rolsystemadmin", dbuser.OptAuditAdmin: "rolauditadmin",
		dbuser.OptMonAdmin: "rolmonitoradmin", dbuser.OptOprAdmin: "roloperatoradmin", dbuser.OptPolAdmin: "rolpolicyadmin",
	} {
		set(id, strconv.FormatBool(dbuser.CellBool(row, column)))
	}
	if limit, ok := dbuser.CellInt(row, "rolconnlimit"); ok {
		set(dbuser.OptConnectionLimit, strconv.FormatInt(limit, 10))
	}
	set(dbuser.OptValidUntil, formatTimestamp(dbuser.CellString(row, "rolvaliduntil")))
	set(dbuser.OptValidBegin, formatTimestamp(dbuser.CellString(row, "rolvalidbegin")))
	set(dbuser.OptPasswordEncryption, profile.Dialect[dialectEncryption])
	return options
}

func roleComment(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, name string) string {
	rows, err := env.SQL.Query(ctx, "", "SELECT pg_catalog.shobj_description("+roleOIDExpr(profile, name)+", 'pg_authid') AS description")
	if err != nil || len(rows) == 0 {
		return ""
	}
	return dbuser.CellString(rows[0], "description")
}

// describeMemberships 读取所属角色（PG16+ 含 INHERIT/SET 选项）与成员。
func describeMemberships(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, name string) ([]dbuser.Membership, []dbuser.PrincipalRef) {
	relation := rolesRelation(profile)
	columns := "m.admin_option"
	if profile.Feature(featMembershipOptions) {
		columns += ", m.inherit_option, m.set_option"
	}
	var memberOf []dbuser.Membership
	rows, err := env.SQL.Query(ctx, "", "SELECT r.rolname AS role_name, "+columns+" FROM pg_catalog.pg_auth_members m JOIN "+relation+" r ON r.oid = m.roleid JOIN "+relation+" u ON u.oid = m.member WHERE u.rolname = "+dbuser.PGString(name))
	if err == nil {
		for _, row := range rows {
			membership := dbuser.Membership{
				Role:        dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.CellString(row, "role_name")},
				AdminOption: dbuser.CellBool(row, "admin_option"),
			}
			if profile.Feature(featMembershipOptions) {
				inherit := dbuser.CellBool(row, "inherit_option")
				set := dbuser.CellBool(row, "set_option")
				membership.Inherit, membership.Set = &inherit, &set
			}
			memberOf = append(memberOf, membership)
		}
	}
	var members []dbuser.PrincipalRef
	rows, err = env.SQL.Query(ctx, "", "SELECT u.rolname AS member_name, u.rolcanlogin FROM pg_catalog.pg_auth_members m JOIN "+relation+" r ON r.oid = m.roleid JOIN "+relation+" u ON u.oid = m.member WHERE r.rolname = "+dbuser.PGString(name))
	if err == nil {
		for _, row := range rows {
			kind := dbuser.KindRole
			if dbuser.CellBool(row, "rolcanlogin") {
				kind = dbuser.KindUser
			}
			members = append(members, dbuser.PrincipalRef{Kind: kind, Name: dbuser.CellString(row, "member_name")})
		}
	}
	return memberOf, members
}
