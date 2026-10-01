package clickhouse

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

func str(value string) string {
	return dbuser.ClickHouseString(value)
}

// isConfigStorage 表示账号定义在配置文件中（users.xml），SQL 无法修改。
func isConfigStorage(storage string) bool {
	lower := strings.ToLower(storage)
	return strings.Contains(lower, "users.xml") || strings.Contains(lower, "users_xml") || strings.Contains(lower, "config")
}

// List 列出用户与角色，标记配置文件管理的只读账号。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, _ dbuser.ListQuery) ([]dbuser.Principal, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM system.users ORDER BY name")
	if err != nil {
		return nil, fmt.Errorf("list clickhouse users: %w", err)
	}
	principals := make([]dbuser.Principal, 0, len(rows)+8)
	for _, row := range rows {
		principals = append(principals, principalFromRow(profile, row, dbuser.KindUser))
	}
	roles, err := env.SQL.Query(ctx, "", "SELECT * FROM system.roles ORDER BY name")
	if err == nil {
		for _, row := range roles {
			principals = append(principals, principalFromRow(profile, row, dbuser.KindRole))
		}
	}
	return principals, nil
}

func principalFromRow(profile dbuser.ServerProfile, row map[string]any, kind dbuser.PrincipalKind) dbuser.Principal {
	name := dbuser.CellString(row, "name")
	principal := dbuser.Principal{
		Ref:        dbuser.PrincipalRef{Kind: kind, Name: name},
		CanLogin:   kind == dbuser.KindUser,
		AuthMethod: authTypeFromCell(row),
		Current:    name == profile.CurrentUser,
	}
	if storage := dbuser.CellString(row, "storage"); isConfigStorage(storage) {
		principal.ReadOnly = true
		principal.ReadOnlyReason = reasonConfigManaged
		principal.Tags = append(principal.Tags, "config")
	}
	return principal
}

// authTypeFromCell 兼容 auth_type 为单值或数组（24.9+ 支持多认证方式）。
func authTypeFromCell(row map[string]any) string {
	value, _ := dbuser.Cell(row, "auth_type")
	if items := stringItems(value); len(items) > 0 {
		return items[0]
	}
	return dbuser.AsString(value)
}

// stringItems 把驱动返回的数组（[]any / []string / "['a','b']" 文本）转为字符串切片。
func stringItems(value any) []string {
	switch typed := value.(type) {
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := dbuser.AsString(item); text != "" {
				out = append(out, text)
			}
		}
		return out
	case []string:
		return typed
	case string:
		trimmed := strings.TrimSpace(typed)
		if !strings.HasPrefix(trimmed, "[") {
			return nil
		}
		trimmed = strings.Trim(trimmed, "[]")
		var out []string
		for item := range strings.SplitSeq(trimmed, ",") {
			if text := strings.Trim(strings.TrimSpace(item), `'"`); text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

// Describe 读取属性、授权与角色。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	ref := query.Ref
	table, column := "system.users", "user_name"
	if ref.Kind == dbuser.KindRole {
		table, column = "system.roles", "role_name"
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM "+table+" WHERE name = "+str(ref.Name))
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe clickhouse principal: %w", err)
	}
	if len(rows) == 0 {
		return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	row := rows[0]
	detail := dbuser.PrincipalDetail{Principal: principalFromRow(profile, row, ref.Kind), Options: map[string]string{}}
	detail.Principal.Ref = ref
	if ref.Kind == dbuser.KindUser {
		detail.Options[dbuser.OptAuthType] = authTypeFromCell(row)
		detail.Options[dbuser.OptHosts] = dbuser.JoinList(hostsFromRow(row))
		detail.Options[dbuser.OptDefaultDatabase] = dbuser.CellString(row, "default_database")
		value, _ := dbuser.Cell(row, "default_roles_list")
		detail.Options[dbuser.OptDefaultRoles] = dbuser.JoinList(stringItems(value))
	}
	grants, _ := env.SQL.Query(ctx, "", "SELECT * FROM system.grants WHERE "+column+" = "+str(ref.Name))
	for _, grant := range grants {
		if dbuser.CellBool(grant, "is_partial_revoke") {
			continue
		}
		detail.Grants = append(detail.Grants, grantFromRow(grant))
	}
	roles, _ := env.SQL.Query(ctx, "", "SELECT * FROM system.role_grants WHERE "+column+" = "+str(ref.Name))
	for _, role := range roles {
		detail.MemberOf = append(detail.MemberOf, dbuser.Membership{
			Role:        dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.CellString(role, "granted_role_name")},
			AdminOption: dbuser.CellBool(role, "with_admin_option"),
		})
	}
	return detail, nil
}

func grantFromRow(row map[string]any) dbuser.Grant {
	grant := dbuser.Grant{
		Privilege:       dbuser.NormalizePrivilegeName(dbuser.CellString(row, "access_type")),
		Scope:           dbuser.ScopeGlobal,
		Database:        dbuser.CellString(row, "database"),
		Object:          dbuser.CellString(row, "table"),
		Column:          dbuser.CellString(row, "column"),
		WithGrantOption: dbuser.CellBool(row, "grant_option"),
	}
	switch {
	case grant.Column != "":
		grant.Scope = dbuser.ScopeColumn
	case grant.Object != "":
		grant.Scope = dbuser.ScopeTable
	case grant.Database != "":
		grant.Scope = dbuser.ScopeDatabase
	}
	return grant
}

// hostsFromRow 把 host_ip / host_names / host_names_like / host_names_regexp 还原为 HOST 子句条目。
func hostsFromRow(row map[string]any) []string {
	var hosts []string
	for _, item := range []struct{ column, kind string }{
		{"host_ip", "IP"}, {"host_names", "NAME"}, {"host_names_like", "LIKE"}, {"host_names_regexp", "REGEXP"},
	} {
		value, _ := dbuser.Cell(row, item.column)
		for _, entry := range stringItems(value) {
			if item.kind == "IP" && (entry == "::/0" || entry == "0.0.0.0/0") {
				return []string{"ANY"}
			}
			hosts = append(hosts, item.kind+" "+entry)
		}
	}
	return hosts
}
