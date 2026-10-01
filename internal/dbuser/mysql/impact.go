package mysql

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 影响项代码。
const (
	impactDefinerObjects = "definer_objects"
	impactActiveSessions = "active_sessions"
)

// Impact 统计以该账号为 DEFINER 的对象；删除账号后这些对象执行时会报错。
func (p *Provider) Impact(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	literal := literalFor(profile)
	definer := literal(ref.Name + "@" + ref.Host)
	impact := dbuser.DropImpact{}
	var samples []string
	total := 0
	for _, source := range []struct{ query, kind string }{
		{"SELECT ROUTINE_SCHEMA AS s, ROUTINE_NAME AS n FROM information_schema.ROUTINES WHERE DEFINER = " + definer, "routine"},
		{"SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n FROM information_schema.VIEWS WHERE DEFINER = " + definer, "view"},
		{"SELECT TRIGGER_SCHEMA AS s, TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE DEFINER = " + definer, "trigger"},
		{"SELECT EVENT_SCHEMA AS s, EVENT_NAME AS n FROM information_schema.EVENTS WHERE DEFINER = " + definer, "event"},
	} {
		rows, err := env.SQL.Query(ctx, "", source.query)
		if err != nil {
			continue
		}
		total += len(rows)
		for _, row := range rows {
			if len(samples) < 10 {
				samples = append(samples, source.kind+": "+dbuser.CellString(row, "s")+"."+dbuser.CellString(row, "n"))
			}
		}
	}
	if total > 0 {
		impact.Items = append(impact.Items, dbuser.ImpactItem{Code: impactDefinerObjects, Count: total, Samples: samples})
	}
	if ref.Kind == dbuser.KindUser {
		rows, err := env.SQL.Query(ctx, "", "SELECT COUNT(*) AS c FROM information_schema.PROCESSLIST WHERE USER = "+literal(ref.Name))
		if err == nil && len(rows) > 0 {
			if count, ok := dbuser.CellInt(rows[0], "c"); ok && count > 0 {
				impact.Items = append(impact.Items, dbuser.ImpactItem{Code: impactActiveSessions, Count: int(count)})
			}
		}
	}
	return impact, nil
}

var (
	identifiedAsPattern       = regexp.MustCompile(`(?i)(\bAS\s+)('(?:[^'\\]|\\.|'')*'|0x[0-9A-F]+)`)
	identifiedByPasswordRegex = regexp.MustCompile(`(?i)(IDENTIFIED\s+BY\s+PASSWORD\s+)'(?:[^'\\]|\\.|'')*'`)
	usingPasswordHashPattern  = regexp.MustCompile(`(?i)(\bUSING\s+)'(?:[^'\\]|\\.|'')*'`)
)

// RedactAccountDDL 把 SHOW CREATE USER / SHOW GRANTS 中的口令哈希替换为掩码。
func RedactAccountDDL(text string) string {
	text = identifiedAsPattern.ReplaceAllString(text, "${1}'"+dbuser.MaskedSecret+"'")
	text = identifiedByPasswordRegex.ReplaceAllString(text, "${1}'"+dbuser.MaskedSecret+"'")
	return usingPasswordHashPattern.ReplaceAllString(text, "${1}'"+dbuser.MaskedSecret+"'")
}

// ExportDDL 导出账号脚本（SHOW CREATE USER + SHOW GRANTS），口令哈希已脱敏。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	account := newPlanner(profile).account(ref)
	lines := make([]string, 0, 8)
	if profile.Feature(featAlterUser) && ref.Kind == dbuser.KindUser {
		rows, err := env.SQL.Query(ctx, "", "SHOW CREATE USER "+account)
		if err == nil && len(rows) > 0 {
			for _, value := range rows[0] {
				lines = append(lines, dbuser.AsString(value)+";")
			}
		}
	} else if ref.Kind == dbuser.KindRole {
		lines = append(lines, "CREATE ROLE "+account+";")
	}
	rows, err := env.SQL.Query(ctx, "", "SHOW GRANTS FOR "+account)
	if err != nil {
		return "", fmt.Errorf("show grants: %w", err)
	}
	for _, row := range rows {
		for _, value := range row {
			lines = append(lines, dbuser.AsString(value)+";")
		}
	}
	return RedactAccountDDL(strings.Join(lines, "\n")), nil
}
