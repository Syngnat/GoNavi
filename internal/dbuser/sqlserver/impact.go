package sqlserver

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 影响项代码。
const (
	impactOwnedSchemas   = "owned_schemas"
	impactActiveSessions = "active_sessions"
)

// Impact：数据库用户拥有架构时 DROP USER 会失败（需先 ALTER AUTHORIZATION）；登录名统计在线会话。
func (p *Provider) Impact(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	impact := dbuser.DropImpact{}
	literal := dbuser.NString(ref.Name)
	if ref.Kind == dbuser.KindLogin {
		rows, err := env.SQL.Query(ctx, "", "SELECT COUNT(*) AS total FROM sys.dm_exec_sessions WHERE login_name = "+literal)
		if err == nil && len(rows) > 0 {
			if count, ok := dbuser.CellInt(rows[0], "total"); ok && count > 0 {
				impact.Items = append(impact.Items, dbuser.ImpactItem{Code: impactActiveSessions, Count: int(count)})
			}
		}
		return impact, nil
	}
	database := resolveDatabase(profile, ref.Database)
	rows, err := env.SQL.Query(ctx, database, "SELECT s.name FROM sys.schemas s JOIN sys.database_principals dp ON dp.principal_id = s.principal_id WHERE dp.name = "+literal)
	if err == nil && len(rows) > 0 {
		samples := make([]string, 0, len(rows))
		for _, row := range rows {
			samples = append(samples, dbuser.CellString(row, "name"))
		}
		impact.Items = append(impact.Items, dbuser.ImpactItem{Code: impactOwnedSchemas, Count: len(rows), Database: database, Samples: samples})
		impact.Blocking = true
	}
	return impact, nil
}

// ExportDDL 由详情反向生成脚本（不含口令）。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	detail, err := p.Describe(ctx, env, profile, dbuser.DescribeQuery{Ref: ref})
	if err != nil {
		return "", err
	}
	options := map[string]string{}
	for key, value := range detail.Options {
		if value != "" && key != dbuser.OptAccountLocked && key != dbuser.OptMustChange {
			options[key] = value
		}
	}
	grants := make([]dbuser.Grant, 0, len(detail.Grants))
	for _, grant := range detail.Grants {
		if !(grant.Scope == dbuser.ScopeDatabase && grant.Privilege == "CONNECT") {
			grants = append(grants, grant)
		}
	}
	request := dbuser.ChangeRequest{Action: dbuser.ActionCreate, Target: detail.Principal.Ref, Options: options, GrantsAdd: grants, MembershipsAdd: detail.MemberOf}
	if options[dbuser.OptLoginType] == "sql" || options[dbuser.OptDBUserType] == "password" {
		request.Password = &dbuser.PasswordChange{Set: true}
	}
	plan, err := p.Plan(profile, request)
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(plan.Statements))
	for _, statement := range plan.Statements {
		lines = append(lines, statement.Display+";")
	}
	return strings.Join(lines, "\nGO\n"), nil
}
