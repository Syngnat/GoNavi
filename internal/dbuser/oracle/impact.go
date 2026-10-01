package oracle

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 影响项代码。
const (
	impactOwnedObjects   = "owned_objects"
	impactActiveSessions = "active_sessions"
)

// Impact 统计用户拥有的对象（DROP USER 需 CASCADE）与在线会话。
func (p *Provider) Impact(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	impact := dbuser.DropImpact{CascadeSupported: ref.Kind == dbuser.KindUser}
	if ref.Kind != dbuser.KindUser {
		return impact, nil
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT OBJECT_TYPE, COUNT(*) AS TOTAL FROM DBA_OBJECTS WHERE OWNER = "+lit(ref.Name)+" GROUP BY OBJECT_TYPE")
	if err == nil {
		total := 0
		samples := make([]string, 0, len(rows))
		for _, row := range rows {
			count, _ := dbuser.CellInt(row, "TOTAL")
			total += int(count)
			samples = append(samples, dbuser.CellString(row, "OBJECT_TYPE")+" × "+dbuser.CellString(row, "TOTAL"))
		}
		if total > 0 {
			impact.Items = append(impact.Items, dbuser.ImpactItem{Code: impactOwnedObjects, Count: total, Samples: samples})
		}
	}
	sessionQuery := "SELECT COUNT(*) AS TOTAL FROM V$SESSION WHERE USERNAME = " + lit(ref.Name)
	if p.variant == variantDameng {
		sessionQuery = "SELECT COUNT(*) AS TOTAL FROM V$SESSIONS WHERE USER_NAME = " + lit(ref.Name)
	}
	rows, err = env.SQL.Query(ctx, "", sessionQuery)
	if err == nil && len(rows) > 0 {
		if count, ok := dbuser.CellInt(rows[0], "TOTAL"); ok && count > 0 {
			impact.Items = append(impact.Items, dbuser.ImpactItem{Code: impactActiveSessions, Count: int(count)})
		}
	}
	return impact, nil
}

// ExportDDL 由详情反向生成脚本（口令为掩码）。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	detail, err := p.Describe(ctx, env, profile, dbuser.DescribeQuery{Ref: ref})
	if err != nil {
		return "", err
	}
	options := map[string]string{dbuser.OptCaseSensitiveName: "true"}
	for key, value := range detail.Options {
		if value != "" && value != "false" && key != dbuser.OptExpirePasswordNow && key != dbuser.OptDefaultRoles {
			options[key] = value
		}
	}
	request := dbuser.ChangeRequest{Action: dbuser.ActionCreate, Target: ref, Options: options, GrantsAdd: detail.Grants, MembershipsAdd: detail.MemberOf}
	if ref.Kind == dbuser.KindUser && options[dbuser.OptNoAuthentication] != "true" {
		request.Password = &dbuser.PasswordChange{Set: true}
	}
	pl := planner{profile: profile, variant: p.variant}
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
