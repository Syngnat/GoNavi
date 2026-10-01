package postgres

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 影响项代码。
const (
	impactOwnedObjects   = "owned_objects"
	impactACLEntries     = "acl_entries"
	impactActiveSessions = "active_sessions"
)

// Impact 用 pg_shdepend 统计各库中该角色拥有的对象（deptype 'o'）与授权引用（'a'）。
// 拥有对象的角色无法直接删除，需要先 REASSIGN OWNED / DROP OWNED（二者只作用于当前库）。
func (p *Provider) Impact(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	impact := dbuser.DropImpact{ReassignSupported: p.variant == variantPostgres, CascadeSupported: p.variant == variantOpenGauss}
	rows, err := env.SQL.Query(ctx, "", "SELECT COALESCE(db.datname, '') AS datname, d.deptype, count(*) AS total FROM pg_catalog.pg_shdepend d LEFT JOIN pg_catalog.pg_database db ON db.oid = d.dbid WHERE d.refobjid = "+roleOIDExpr(profile, ref.Name)+" GROUP BY db.datname, d.deptype")
	if err == nil {
		for _, row := range rows {
			count, _ := dbuser.CellInt(row, "total")
			code := impactACLEntries
			if strings.EqualFold(dbuser.CellString(row, "deptype"), "o") {
				code = impactOwnedObjects
			}
			impact.Items = append(impact.Items, dbuser.ImpactItem{Code: code, Count: int(count), Database: dbuser.CellString(row, "datname")})
		}
	}
	rows, err = env.SQL.Query(ctx, "", "SELECT count(*) AS total FROM pg_catalog.pg_stat_activity WHERE usename = "+dbuser.PGString(ref.Name))
	if err == nil && len(rows) > 0 {
		if count, ok := dbuser.CellInt(rows[0], "total"); ok && count > 0 {
			impact.Items = append(impact.Items, dbuser.ImpactItem{Code: impactActiveSessions, Count: int(count)})
		}
	}
	return impact, nil
}

// ExportDDL 由详情反向生成建角色脚本（不含口令）、成员关系与当前库的对象授权。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	detail, err := p.Describe(ctx, env, profile, dbuser.DescribeQuery{Ref: ref})
	if err != nil {
		return "", err
	}
	request := dbuser.ChangeRequest{
		Action:         dbuser.ActionCreate,
		Target:         ref,
		Options:        exportableOptions(detail.Options),
		GrantsAdd:      detail.Grants,
		MembershipsAdd: detail.MemberOf,
	}
	pl := planner{profile: profile, variant: p.variant}
	if ref.Kind == dbuser.KindUser {
		// 导出脚本不含口令：用占位的 set 标记生成语句结构，展示文本中为掩码。
		request.Password = &dbuser.PasswordChange{Set: true}
	}
	statements, err := pl.planCreate(request)
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(statements))
	for _, statement := range statements {
		lines = append(lines, statement.Display+";")
	}
	return strings.Join(lines, "\n"), nil
}

func exportableOptions(options map[string]string) map[string]string {
	out := make(map[string]string, len(options))
	for key, value := range options {
		if key == dbuser.OptPasswordEncryption || key == dbuser.OptAccountLocked || value == "" {
			continue
		}
		out[key] = value
	}
	return out
}
