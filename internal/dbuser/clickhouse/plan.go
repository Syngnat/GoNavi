package clickhouse

import (
	"context"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

var validUntilPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$`)

func ident(name string) string {
	return dbuser.QuoteClickHouseIdent(name)
}

type planner struct {
	profile dbuser.ServerProfile
}

// Plan 实现 dbuser.Provider。ClickHouse 访问控制语句逐条执行。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	pl := planner{profile: profile}
	if err := pl.validate(request); err != nil {
		return dbuser.Plan{}, err
	}
	var statements []dbuser.Statement
	var err error
	switch request.Action {
	case dbuser.ActionCreate:
		statements, err = pl.planCreate(request)
	case dbuser.ActionAlter:
		statements, err = pl.planAlter(request)
	case dbuser.ActionDrop:
		keyword := "DROP USER "
		if request.Target.Kind == dbuser.KindRole {
			keyword = "DROP ROLE "
		}
		statements = []dbuser.Statement{dbuser.Plain(keyword+ident(request.Target.Name)+pl.onCluster(request.Options), "", dbuser.RiskDanger)}
	}
	if err != nil {
		return dbuser.Plan{}, err
	}
	return dbuser.Plan{Statements: statements}, nil
}

func (p planner) validate(request dbuser.ChangeRequest) error {
	rule := dbuser.NameRule{MaxLength: 128}
	if err := dbuser.ValidateName(request.Target.Name, rule); err != nil {
		return err
	}
	if request.Rename != nil {
		if err := dbuser.ValidateName(request.Rename.Name, rule); err != nil {
			return err
		}
	}
	if _, err := parseHosts(request.Options[dbuser.OptHosts]); err != nil {
		return err
	}
	if value := strings.TrimSpace(request.Options[dbuser.OptValidUntil]); value != "" && !strings.EqualFold(value, "infinity") && !validUntilPattern.MatchString(value) {
		return dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", dbuser.OptValidUntil)
	}
	if value := strings.TrimSpace(request.Options[dbuser.OptDefaultDatabase]); value != "" {
		if err := dbuser.ValidateName(value, rule); err != nil {
			return err
		}
	}
	if request.Action == dbuser.ActionDrop && strings.EqualFold(request.Target.Name, "default") {
		return dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", request.Target.Name)
	}
	return dbuser.ValidateGrants(p.profile, append(append([]dbuser.Grant{}, request.GrantsAdd...), request.GrantsRevoke...))
}

// parseHosts 把 HOST 条目转为子句片段；每条为 ANY / LOCAL / NONE 或「IP|NAME|LIKE|REGEXP 值」。
func parseHosts(raw string) ([]string, error) {
	var clauses []string
	for _, entry := range dbuser.SplitList(raw) {
		upper := strings.ToUpper(entry)
		switch upper {
		case "ANY", "LOCAL", "NONE":
			clauses = append(clauses, upper)
			continue
		}
		kind, value, found := strings.Cut(entry, " ")
		kind = strings.ToUpper(kind)
		value = strings.TrimSpace(value)
		if !found || value == "" || (kind != "IP" && kind != "NAME" && kind != "LIKE" && kind != "REGEXP") {
			return nil, dbuser.Errorf(dbuser.ErrCodeInvalidHost, "host", entry)
		}
		clauses = append(clauses, kind+" "+str(value))
	}
	return clauses, nil
}

func (p planner) onCluster(options map[string]string) string {
	if cluster := strings.TrimSpace(options[dbuser.OptOnCluster]); cluster != "" {
		return " ON CLUSTER " + ident(cluster)
	}
	return ""
}

// writeIdentification 追加认证子句；no_password 生成 NOT IDENTIFIED。
func (p planner) writeIdentification(builder *dbuser.SQLBuilder, authType string, change *dbuser.PasswordChange, username string) error {
	if authType == "" {
		authType = "sha256_password"
	}
	if authType == "no_password" || (change != nil && change.Remove) {
		builder.Write(" NOT IDENTIFIED")
		return nil
	}
	if change == nil || !change.Set {
		return dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
	}
	if change.Password != "" {
		if err := dbuser.ValidatePassword(change.Password, username, p.profile.PasswordPolicy); err != nil {
			return err
		}
	}
	builder.Write(" IDENTIFIED WITH ", authType, " BY ").Secret(str(change.Password), dbuser.Masked("'", "'"))
	return nil
}

func (p planner) accountClauses(options map[string]string, creating bool) ([]string, error) {
	clauses := make([]string, 0, 5)
	if raw, ok := options[dbuser.OptHosts]; ok {
		hosts, err := parseHosts(raw)
		if err != nil {
			return nil, err
		}
		if len(hosts) == 0 {
			hosts = []string{"ANY"}
		}
		clauses = append(clauses, " HOST "+strings.Join(hosts, ", "))
	}
	if value, ok := options[dbuser.OptValidUntil]; ok && p.profile.Feature(featValidUntil) {
		if strings.TrimSpace(value) == "" {
			value = "infinity"
		}
		clauses = append(clauses, " VALID UNTIL "+str(value))
	}
	if raw, ok := options[dbuser.OptDefaultRoles]; ok {
		roles := dbuser.SplitList(raw)
		if len(roles) == 0 {
			clauses = append(clauses, " DEFAULT ROLE NONE")
		} else {
			quoted := make([]string, 0, len(roles))
			for _, role := range roles {
				quoted = append(quoted, ident(role))
			}
			clauses = append(clauses, " DEFAULT ROLE "+strings.Join(quoted, ", "))
		}
	}
	if value, ok := options[dbuser.OptDefaultDatabase]; ok {
		if strings.TrimSpace(value) == "" {
			if !creating {
				clauses = append(clauses, " DEFAULT DATABASE NONE")
			}
		} else {
			clauses = append(clauses, " DEFAULT DATABASE "+ident(value))
		}
	}
	if value, ok := options[dbuser.OptSettingsProfile]; ok && strings.TrimSpace(value) != "" {
		clauses = append(clauses, " SETTINGS PROFILE "+str(value))
	}
	return clauses, nil
}

func (p planner) planCreate(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	name := request.Target.Name
	cluster := p.onCluster(request.Options)
	if request.Target.Kind == dbuser.KindRole {
		text := "CREATE ROLE " + ident(name) + cluster
		if value := strings.TrimSpace(request.Options[dbuser.OptSettingsProfile]); value != "" {
			text += " SETTINGS PROFILE " + str(value)
		}
		return append([]dbuser.Statement{dbuser.Plain(text, "", dbuser.RiskNormal)}, p.planGrants(name, request, cluster)...), nil
	}
	var builder dbuser.SQLBuilder
	builder.Write("CREATE USER ", ident(name), cluster)
	if err := p.writeIdentification(&builder, request.Options[dbuser.OptAuthType], request.Password, name); err != nil {
		return nil, err
	}
	// DEFAULT ROLE 必须引用已授予的角色，放到角色授予之后单独设置。
	options := withoutKey(request.Options, dbuser.OptDefaultRoles)
	clauses, err := p.accountClauses(options, true)
	if err != nil {
		return nil, err
	}
	builder.Write(clauses...)
	statements := []dbuser.Statement{builder.Statement("", dbuser.RiskNormal)}
	statements = append(statements, p.planGrants(name, request, cluster)...)
	if raw, ok := request.Options[dbuser.OptDefaultRoles]; ok && strings.TrimSpace(raw) != "" {
		roleClauses, _ := p.accountClauses(map[string]string{dbuser.OptDefaultRoles: raw}, false)
		statements = append(statements, dbuser.Plain("ALTER USER "+ident(name)+cluster+strings.Join(roleClauses, ""), "", dbuser.RiskNormal))
	}
	return statements, nil
}

func withoutKey(options map[string]string, key string) map[string]string {
	out := make(map[string]string, len(options))
	for id, value := range options {
		if id != key {
			out[id] = value
		}
	}
	return out
}

func (p planner) planAlter(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	name := request.Target.Name
	cluster := p.onCluster(request.Options)
	keyword := "ALTER USER "
	if request.Target.Kind == dbuser.KindRole {
		keyword = "ALTER ROLE "
	}
	statements := make([]dbuser.Statement, 0, 6)
	if request.Rename != nil && request.Rename.Name != name {
		statements = append(statements, dbuser.Plain(keyword+ident(name)+cluster+" RENAME TO "+ident(request.Rename.Name), "", dbuser.RiskHigh))
		name = request.Rename.Name
	}
	var builder dbuser.SQLBuilder
	builder.Write(keyword, ident(name), cluster)
	wrote := false
	_, authChanged := request.Options[dbuser.OptAuthType]
	if request.Target.Kind == dbuser.KindUser && ((request.Password != nil && request.Password.Set) || authChanged) {
		if err := p.writeIdentification(&builder, request.Options[dbuser.OptAuthType], request.Password, name); err != nil {
			return nil, err
		}
		wrote = true
	}
	clauses, err := p.accountClauses(request.Options, false)
	if err != nil {
		return nil, err
	}
	builder.Write(clauses...)
	if wrote || len(clauses) > 0 {
		statements = append(statements, builder.Statement("", dbuser.RiskHigh))
	}
	return append(statements, p.planGrants(name, request, cluster)...), nil
}

// planGrants 生成授权、撤权与角色成员。
func (p planner) planGrants(grantee string, request dbuser.ChangeRequest, cluster string) []dbuser.Statement {
	statements := make([]dbuser.Statement, 0, len(request.GrantsAdd)+len(request.GrantsRevoke)+4)
	for _, group := range dbuser.GroupGrants(request.GrantsRevoke) {
		prefix := "REVOKE" + cluster + " "
		if group.WithGrantOption {
			prefix += "GRANT OPTION FOR "
		}
		statements = append(statements, dbuser.Plain(prefix+privilegeClause(group)+" ON "+grantTarget(group.Target)+" FROM "+ident(grantee), "", dbuser.RiskHigh))
	}
	for _, group := range dbuser.GroupGrants(request.GrantsAdd) {
		text := "GRANT" + cluster + " " + privilegeClause(group) + " ON " + grantTarget(group.Target) + " TO " + ident(grantee)
		risk := dbuser.RiskNormal
		if group.WithGrantOption {
			text += " WITH GRANT OPTION"
			risk = dbuser.RiskHigh
		}
		statements = append(statements, dbuser.Plain(text, "", risk))
	}
	for _, membership := range request.MembershipsRemove {
		statements = append(statements, dbuser.Plain("REVOKE"+cluster+" "+ident(membership.Role.Name)+" FROM "+ident(grantee), "", dbuser.RiskHigh))
	}
	for _, membership := range request.MembershipsAdd {
		text := "GRANT" + cluster + " " + ident(membership.Role.Name) + " TO " + ident(grantee)
		if membership.AdminOption {
			text += " WITH ADMIN OPTION"
		}
		statements = append(statements, dbuser.Plain(text, "", dbuser.RiskNormal))
	}
	return statements
}

func privilegeClause(group dbuser.GrantGroup) string {
	if group.Target.Scope != dbuser.ScopeColumn {
		return dbuser.PrivilegeList(group.Privileges)
	}
	parts := make([]string, 0, len(group.Privileges))
	for _, privilege := range group.Privileges {
		parts = append(parts, privilege+"("+ident(group.Target.Column)+")")
	}
	return strings.Join(parts, ", ")
}

func grantTarget(target dbuser.Grant) string {
	switch target.Scope {
	case dbuser.ScopeGlobal:
		return "*.*"
	case dbuser.ScopeDatabase:
		return ident(target.Database) + ".*"
	default:
		return ident(target.Database) + "." + ident(target.Object)
	}
}

// Impact 统计在线查询数。
func (p *Provider) Impact(ctx context.Context, env dbuser.Env, _ dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	impact := dbuser.DropImpact{}
	if ref.Kind != dbuser.KindUser {
		return impact, nil
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT count() AS total FROM system.processes WHERE user = "+str(ref.Name))
	if err == nil && len(rows) > 0 {
		if count, ok := dbuser.CellInt(rows[0], "total"); ok && count > 0 {
			impact.Items = append(impact.Items, dbuser.ImpactItem{Code: "active_sessions", Count: int(count)})
		}
	}
	return impact, nil
}

var hashLiteralPattern = regexp.MustCompile(`(?i)(\b(?:BY|SALT)\s+)'(?:[^'\\]|\\.)*'`)

// ExportDDL 使用 SHOW CREATE 与 SHOW GRANTS，口令哈希与盐值已脱敏。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, _ dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	keyword := "USER "
	if ref.Kind == dbuser.KindRole {
		keyword = "ROLE "
	}
	lines := make([]string, 0, 8)
	for _, query := range []string{"SHOW CREATE " + keyword + ident(ref.Name), "SHOW GRANTS FOR " + ident(ref.Name)} {
		rows, err := env.SQL.Query(ctx, "", query)
		if err != nil {
			return "", err
		}
		for _, row := range rows {
			for _, value := range row {
				lines = append(lines, dbuser.AsString(value)+";")
			}
		}
	}
	return hashLiteralPattern.ReplaceAllString(strings.Join(lines, "\n"), "${1}'"+dbuser.MaskedSecret+"'"), nil
}
