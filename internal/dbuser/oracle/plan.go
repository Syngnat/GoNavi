package oracle

import (
	"regexp"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// unquotedIdentifier 是 Oracle 未加引号时合法的标识符；这类名称按 Oracle 惯例转为大写。
var unquotedIdentifier = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_$#]*$`)

// quotaPattern 限制配额取值：UNLIMITED 或带 K/M/G/T 单位的数字。
var quotaPattern = regexp.MustCompile(`(?i)^(UNLIMITED|\d+[KMGT]?)$`)

type planner struct {
	profile dbuser.ServerProfile
	variant variant
}

func q(name string) string {
	return dbuser.QuoteDouble(name)
}

// Plan 实现 dbuser.Provider。Oracle/达梦 DDL 隐式提交，逐条执行；语句不带结尾分号。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	pl := planner{profile: profile, variant: p.variant}
	request = pl.normalizeNames(request)
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
		statements = pl.planDrop(request)
	}
	if err != nil {
		return dbuser.Plan{}, err
	}
	return dbuser.Plan{Statements: statements}, nil
}

// normalizeNames 新建时未勾选「区分大小写」的普通标识符转为大写，与 Oracle 未加引号的行为一致。
func (p planner) normalizeNames(request dbuser.ChangeRequest) dbuser.ChangeRequest {
	if request.Action != dbuser.ActionCreate {
		return request
	}
	if sensitive, _ := dbuser.OptionBoolValue(request.Options, dbuser.OptCaseSensitiveName); sensitive {
		return request
	}
	if unquotedIdentifier.MatchString(request.Target.Name) {
		request.Target.Name = strings.ToUpper(request.Target.Name)
	}
	return request
}

func (p planner) nameRule() dbuser.NameRule {
	if p.variant == variantOracle && !p.profile.Version.AtLeast(12, 2, 0) {
		return dbuser.NameRule{MaxLength: 30, MaxBytes: true}
	}
	return dbuser.NameRule{MaxLength: 128, MaxBytes: true}
}

func (p planner) validate(request dbuser.ChangeRequest) error {
	if err := dbuser.ValidateName(request.Target.Name, p.nameRule()); err != nil {
		return err
	}
	if request.Rename != nil && request.Rename.Name != request.Target.Name {
		return dbuser.NewError(dbuser.ErrCodeRenameUnsupported, nil)
	}
	if p.profile.Feature(featCommonUsers) && request.Action == dbuser.ActionCreate {
		prefix := p.profile.Dialect[dialectCommonPrefix]
		if prefix != "" && !strings.HasPrefix(strings.ToUpper(request.Target.Name), strings.ToUpper(prefix)) {
			return dbuser.Errorf(dbuser.ErrCodeInvalidName, "name", request.Target.Name)
		}
	}
	if quota := strings.TrimSpace(request.Options[dbuser.OptTablespaceQuota]); quota != "" && !quotaPattern.MatchString(quota) {
		return dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", dbuser.OptTablespaceQuota)
	}
	for _, id := range []string{dbuser.OptDefaultTablespace, dbuser.OptTemporaryTablespace, dbuser.OptProfile} {
		if value := strings.TrimSpace(request.Options[id]); value != "" {
			if err := dbuser.ValidateName(value, dbuser.NameRule{MaxLength: 128}); err != nil {
				return err
			}
		}
	}
	if request.Action == dbuser.ActionDrop && (systemUsers[strings.ToUpper(request.Target.Name)] || predefinedRoles[strings.ToUpper(request.Target.Name)]) {
		return dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", request.Target.Name)
	}
	return dbuser.ValidateGrants(p.profile, append(append([]dbuser.Grant{}, request.GrantsAdd...), request.GrantsRevoke...))
}

// container 返回 CDB 根容器下的 CONTAINER=ALL 后缀。
func (p planner) container() string {
	if p.profile.Feature(featCommonUsers) {
		return " CONTAINER=ALL"
	}
	return ""
}

// writeSecret 追加双引号口令；口令不能含双引号（Oracle/达梦都不支持转义）。
func (p planner) writeSecret(builder *dbuser.SQLBuilder, password, username string) error {
	if strings.ContainsRune(password, '"') {
		return dbuser.Errorf(dbuser.ErrCodePasswordInvalidChar, "chars", `"`)
	}
	if password != "" {
		if err := dbuser.ValidatePassword(password, username, p.profile.PasswordPolicy); err != nil {
			return err
		}
	}
	builder.Secret(`"`+password+`"`, dbuser.Masked(`"`, `"`))
	return nil
}

func (p planner) planCreate(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	name := request.Target.Name
	if request.Target.Kind == dbuser.KindRole {
		statements := []dbuser.Statement{dbuser.Plain("CREATE ROLE "+q(name)+p.container(), "", dbuser.RiskNormal)}
		return append(statements, p.planGrants(name, request)...), nil
	}
	var builder dbuser.SQLBuilder
	builder.Write("CREATE USER ", q(name))
	if noAuth, _ := dbuser.OptionBoolValue(request.Options, dbuser.OptNoAuthentication); noAuth && p.profile.Feature(featNoAuthentication) {
		builder.Write(" NO AUTHENTICATION")
	} else {
		if request.Password == nil || !request.Password.Set {
			return nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
		}
		builder.Write(" IDENTIFIED BY ")
		if err := p.writeSecret(&builder, request.Password.Password, name); err != nil {
			return nil, err
		}
	}
	builder.Write(p.attributeClauses(request.Options)...)
	builder.Write(p.container())
	statements := []dbuser.Statement{builder.Statement("", dbuser.RiskNormal)}
	return append(statements, p.planGrants(name, request)...), nil
}

// attributeClauses 生成表空间、配额、PROFILE、口令过期与锁定子句。
func (p planner) attributeClauses(options map[string]string) []string {
	clauses := make([]string, 0, 6)
	tablespace := strings.TrimSpace(options[dbuser.OptDefaultTablespace])
	if tablespace != "" {
		clauses = append(clauses, " DEFAULT TABLESPACE "+q(tablespace))
	}
	if value := strings.TrimSpace(options[dbuser.OptTemporaryTablespace]); value != "" {
		clauses = append(clauses, " TEMPORARY TABLESPACE "+q(value))
	}
	if quota := strings.ToUpper(strings.TrimSpace(options[dbuser.OptTablespaceQuota])); quota != "" && tablespace != "" && p.profile.Feature(featQuota) {
		clauses = append(clauses, " QUOTA "+quota+" ON "+q(tablespace))
	}
	if value := strings.TrimSpace(options[dbuser.OptProfile]); value != "" {
		clauses = append(clauses, " PROFILE "+q(value))
	}
	if expire, _ := dbuser.OptionBoolValue(options, dbuser.OptExpirePasswordNow); expire {
		clauses = append(clauses, " PASSWORD EXPIRE")
	}
	if locked, ok := dbuser.OptionBoolValue(options, dbuser.OptAccountLocked); ok {
		if locked {
			clauses = append(clauses, " ACCOUNT LOCK")
		} else {
			clauses = append(clauses, " ACCOUNT UNLOCK")
		}
	}
	return clauses
}

func (p planner) planAlter(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	name := request.Target.Name
	statements := make([]dbuser.Statement, 0, 6)
	if request.Target.Kind == dbuser.KindUser {
		if change := request.Password; change != nil && change.Set {
			var builder dbuser.SQLBuilder
			builder.Write("ALTER USER ", q(name), " IDENTIFIED BY ")
			if err := p.writeSecret(&builder, change.Password, name); err != nil {
				return nil, err
			}
			if change.CurrentPassword != "" {
				builder.Write(" REPLACE ")
				if err := p.writeSecret(&builder, change.CurrentPassword, name); err != nil {
					return nil, err
				}
			}
			statements = append(statements, builder.Statement("", dbuser.RiskHigh))
		}
		if noAuth, ok := dbuser.OptionBoolValue(request.Options, dbuser.OptNoAuthentication); ok && noAuth {
			statements = append(statements, dbuser.Plain("ALTER USER "+q(name)+" NO AUTHENTICATION", "", dbuser.RiskHigh))
		}
		if clauses := p.attributeClauses(request.Options); len(clauses) > 0 {
			risk := dbuser.RiskNormal
			if locked, _ := dbuser.OptionBoolValue(request.Options, dbuser.OptAccountLocked); locked {
				risk = dbuser.RiskHigh
			}
			statements = append(statements, dbuser.Plain("ALTER USER "+q(name)+strings.Join(clauses, ""), "", risk))
		}
	}
	statements = append(statements, p.planGrants(name, request)...)
	if raw, ok := request.Options[dbuser.OptDefaultRoles]; ok && p.profile.Feature(featDefaultRoles) && request.Target.Kind == dbuser.KindUser {
		roles := dbuser.SplitList(raw)
		clause := "NONE"
		if len(roles) > 0 {
			quoted := make([]string, 0, len(roles))
			for _, role := range roles {
				quoted = append(quoted, q(role))
			}
			clause = strings.Join(quoted, ", ")
		}
		statements = append(statements, dbuser.Plain("ALTER USER "+q(name)+" DEFAULT ROLE "+clause, "", dbuser.RiskNormal))
	}
	return statements, nil
}

func (p planner) planDrop(request dbuser.ChangeRequest) []dbuser.Statement {
	if request.Target.Kind == dbuser.KindRole {
		return []dbuser.Statement{dbuser.Plain("DROP ROLE "+q(request.Target.Name), "", dbuser.RiskDanger)}
	}
	text := "DROP USER " + q(request.Target.Name)
	if request.Drop != nil && request.Drop.Cascade {
		text += " CASCADE"
	}
	return []dbuser.Statement{dbuser.Plain(text, "", dbuser.RiskDanger)}
}

// planGrants 处理系统权限、对象权限与角色。Oracle 无法单独撤销 ADMIN/GRANT OPTION，
// 仅撤销选项时改为「撤销后不带选项重新授予」。
func (p planner) planGrants(grantee string, request dbuser.ChangeRequest) []dbuser.Statement {
	statements := make([]dbuser.Statement, 0, len(request.GrantsAdd)+len(request.GrantsRevoke)+4)
	container := p.container()
	for _, group := range dbuser.GroupGrants(request.GrantsRevoke) {
		statements = append(statements, dbuser.Plain("REVOKE "+dbuser.PrivilegeList(group.Privileges)+onClause(group.Target)+" FROM "+q(grantee)+container, "", dbuser.RiskHigh))
		if group.WithGrantOption {
			statements = append(statements, dbuser.Plain("GRANT "+privilegeClause(group)+onClause(group.Target)+" TO "+q(grantee)+container, "", dbuser.RiskNormal))
		}
	}
	for _, group := range dbuser.GroupGrants(request.GrantsAdd) {
		text := "GRANT " + privilegeClause(group) + onClause(group.Target) + " TO " + q(grantee)
		risk := dbuser.RiskNormal
		if group.WithGrantOption {
			risk = dbuser.RiskHigh
			if group.Target.Scope == dbuser.ScopeGlobal {
				text += " WITH ADMIN OPTION"
			} else {
				text += " WITH GRANT OPTION"
			}
		}
		statements = append(statements, dbuser.Plain(text+container, "", risk))
	}
	for _, membership := range request.MembershipsRemove {
		statements = append(statements, dbuser.Plain("REVOKE "+q(membership.Role.Name)+" FROM "+q(grantee)+container, "", dbuser.RiskHigh))
	}
	for _, membership := range request.MembershipsAdd {
		text := "GRANT " + q(membership.Role.Name) + " TO " + q(grantee)
		if membership.AdminOption {
			text += " WITH ADMIN OPTION"
		}
		statements = append(statements, dbuser.Plain(text+container, "", dbuser.RiskNormal))
	}
	return statements
}

func privilegeClause(group dbuser.GrantGroup) string {
	if group.Target.Scope != dbuser.ScopeColumn {
		return dbuser.PrivilegeList(group.Privileges)
	}
	parts := make([]string, 0, len(group.Privileges))
	for _, privilege := range group.Privileges {
		parts = append(parts, privilege+" ("+q(group.Target.Column)+")")
	}
	return strings.Join(parts, ", ")
}

// onClause：系统权限无 ON；对象/列权限为 ON "OWNER"."OBJECT"（列级撤销会作用于整张表，这是 Oracle 的限制）。
func onClause(target dbuser.Grant) string {
	if target.Scope == dbuser.ScopeGlobal {
		return ""
	}
	object := q(target.Object)
	if target.Schema != "" {
		object = q(target.Schema) + "." + object
	}
	return " ON " + object
}
