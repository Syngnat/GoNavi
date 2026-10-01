package mysql

import (
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// planner 持有一次 Plan 所需的上下文。
type planner struct {
	profile dbuser.ServerProfile
	escapes bool
}

func newPlanner(profile dbuser.ServerProfile) planner {
	return planner{profile: profile, escapes: backslash(profile)}
}

func (p planner) feature(name string) bool {
	return p.profile.Feature(name)
}

func (p planner) literal(value string) string {
	return dbuser.MySQLString(value, p.escapes)
}

// account 生成账号引用；MariaDB 角色没有 host。
func (p planner) account(ref dbuser.PrincipalRef) string {
	if ref.Kind == dbuser.KindRole && !p.feature(featRoleHost) {
		return dbuser.QuoteBacktick(ref.Name)
	}
	host := ref.Host
	if host == "" {
		host = "%"
	}
	return dbuser.MySQLAccount(ref.Name, host)
}

// Plan 实现 dbuser.Provider。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	planner := newPlanner(profile)
	if err := planner.validateIdentity(request); err != nil {
		return dbuser.Plan{}, err
	}
	if err := dbuser.ValidateGrants(profile, append(append([]dbuser.Grant{}, request.GrantsAdd...), request.GrantsRevoke...)); err != nil {
		return dbuser.Plan{}, err
	}
	if err := validateRoutineTypes(request); err != nil {
		return dbuser.Plan{}, err
	}
	var statements []dbuser.Statement
	var err error
	switch request.Action {
	case dbuser.ActionCreate:
		statements, err = planner.planCreate(request)
	case dbuser.ActionAlter:
		statements, err = planner.planAlter(request)
	case dbuser.ActionDrop:
		statements = []dbuser.Statement{planner.planDrop(request)}
	}
	if err != nil {
		return dbuser.Plan{}, err
	}
	return dbuser.Plan{Statements: statements}, nil
}

func (p planner) validateIdentity(request dbuser.ChangeRequest) error {
	rule := dbuser.NameRule{MaxLength: userNameMaxLength(p.profile.Flavor, p.profile.Version)}
	hostRule := dbuser.NameRule{MaxLength: hostMaxLength(p.profile.Flavor, p.profile.Version), AllowedRunes: isHostRune}
	refs := []dbuser.PrincipalRef{request.Target}
	if request.Rename != nil {
		refs = append(refs, *request.Rename)
	}
	for _, ref := range refs {
		if err := dbuser.ValidateName(ref.Name, rule); err != nil {
			return err
		}
		if ref.Kind == dbuser.KindRole && !p.feature(featRoleHost) {
			continue
		}
		if ref.Host == "" {
			continue
		}
		if err := dbuser.ValidateName(ref.Host, hostRule); err != nil {
			return dbuser.Errorf(dbuser.ErrCodeInvalidHost, "host", ref.Host)
		}
	}
	if request.Action == dbuser.ActionDrop && isSystemAccount(request.Target.Name) {
		return dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", request.Target.Name)
	}
	return nil
}

// isHostRune 允许主机名、IP、IPv6、网段与 % _ 通配符。
func isHostRune(r rune) bool {
	return dbuser.IsIdentifierRune(r) || strings.ContainsRune(".%-:/[]", r)
}

func validateRoutineTypes(request dbuser.ChangeRequest) error {
	for _, grant := range append(append([]dbuser.Grant{}, request.GrantsAdd...), request.GrantsRevoke...) {
		if grant.Scope != dbuser.ScopeRoutine {
			continue
		}
		switch strings.ToUpper(grant.ObjectType) {
		case "PROCEDURE", "FUNCTION":
		default:
			return dbuser.Errorf(dbuser.ErrCodeInvalidObject, "scope", grant.Scope)
		}
	}
	return nil
}

func (p planner) planCreate(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	target := request.Target
	if target.Kind == dbuser.KindRole {
		statements := []dbuser.Statement{dbuser.Plain("CREATE ROLE "+p.account(target), "", dbuser.RiskNormal)}
		return append(statements, p.planPrivilegesAndRoles(target, request)...), nil
	}
	if request.Password == nil || !request.Password.Set {
		return nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
	}
	if err := p.validatePassword(request.Password.Password, target.Name); err != nil {
		return nil, err
	}
	plugin := request.Options[dbuser.OptAuthPlugin]
	var builder dbuser.SQLBuilder
	builder.Write("CREATE USER ", p.account(target))
	p.writeIdentified(&builder, plugin, request.Password.Password)
	statements := []dbuser.Statement{}
	if p.feature(featLimitsInCreate) {
		p.writeAccountClauses(&builder, request.Options)
		statements = append(statements, builder.Statement("", dbuser.RiskNormal))
	} else {
		statements = append(statements, builder.Statement("", dbuser.RiskNormal))
		if usage, ok := p.legacyUsageGrant(target, request.Options); ok {
			statements = append(statements, usage)
		}
	}
	return append(statements, p.planPrivilegesAndRoles(target, request)...), nil
}

func (p planner) validatePassword(password, username string) error {
	if password == "" {
		// Preview 阶段不携带口令，由绑定层在 Apply 时保证非空。
		return nil
	}
	return dbuser.ValidatePassword(password, username, p.profile.PasswordPolicy)
}

// writeIdentified 追加认证子句；口令只进入执行文本。
func (p planner) writeIdentified(builder *dbuser.SQLBuilder, plugin, password string) {
	secret := p.literal(password)
	masked := dbuser.Masked("'", "'")
	switch {
	case p.profile.Flavor == flavorMariaDB && p.feature(featMariaDBVia) && mariaDBViaPlugin(plugin):
		builder.Write(" IDENTIFIED VIA ", plugin, " USING PASSWORD(").Secret(secret, masked).Write(")")
	case plugin != "" && p.feature(featPluginChoice):
		builder.Write(" IDENTIFIED WITH ", plugin, " BY ").Secret(secret, masked)
	default:
		builder.Write(" IDENTIFIED BY ").Secret(secret, masked)
	}
}

// writeAccountClauses 按 MySQL/MariaDB 语法顺序追加 REQUIRE、WITH、口令与锁定子句。
// 返回是否写入了任何子句。
func (p planner) writeAccountClauses(builder *dbuser.SQLBuilder, options map[string]string) bool {
	wrote := false
	if clause := p.requireClause(options); clause != "" {
		builder.Write(clause)
		wrote = true
	}
	if clause := p.withClause(options); clause != "" {
		builder.Write(clause)
		wrote = true
	}
	lock := p.lockClause(options)
	passwordClauses := p.passwordClauses(options)
	if p.profile.Flavor == flavorMariaDB {
		builder.Write(lock, passwordClauses)
	} else {
		builder.Write(passwordClauses, lock)
	}
	wrote = wrote || lock != "" || passwordClauses != ""
	if value, ok := options[dbuser.OptComment]; ok && p.feature(featComment) {
		builder.Write(" COMMENT ", p.literal(value))
		wrote = true
	}
	return wrote
}

func (p planner) requireClause(options map[string]string) string {
	value, ok := options[dbuser.OptRequireSSL]
	if !ok || !p.feature(featRequireSSL) {
		return ""
	}
	switch value {
	case sslAny:
		return " REQUIRE SSL"
	case sslX509:
		return " REQUIRE X509"
	case sslNone:
		return " REQUIRE NONE"
	default:
		return ""
	}
}

func (p planner) withClause(options map[string]string) string {
	if !p.feature(featResourceLimits) {
		return ""
	}
	parts := make([]string, 0, 4)
	for _, item := range []struct{ id, keyword string }{
		{dbuser.OptMaxQueriesPerHour, "MAX_QUERIES_PER_HOUR"},
		{dbuser.OptMaxUpdatesPerHour, "MAX_UPDATES_PER_HOUR"},
		{dbuser.OptMaxConnectionsPerHour, "MAX_CONNECTIONS_PER_HOUR"},
		{dbuser.OptMaxUserConnections, "MAX_USER_CONNECTIONS"},
	} {
		raw, present := options[item.id]
		if !present {
			continue
		}
		value, ok := dbuser.OptionIntValue(options, item.id)
		if !ok && strings.TrimSpace(raw) == "" {
			value = 0
		}
		parts = append(parts, item.keyword+" "+strconv.Itoa(value))
	}
	if len(parts) == 0 {
		return ""
	}
	return " WITH " + strings.Join(parts, " ")
}

func (p planner) lockClause(options map[string]string) string {
	locked, ok := dbuser.OptionBoolValue(options, dbuser.OptAccountLocked)
	if !ok || !p.feature(featAccountLock) {
		return ""
	}
	if locked {
		return " ACCOUNT LOCK"
	}
	return " ACCOUNT UNLOCK"
}

func (p planner) passwordClauses(options map[string]string) string {
	var builder strings.Builder
	if p.feature(featPasswordExpire) {
		if policy, ok := options[dbuser.OptPasswordExpirePolicy]; ok {
			switch policy {
			case expireNever:
				builder.WriteString(" PASSWORD EXPIRE NEVER")
			case expireInterval:
				days, found := dbuser.OptionIntValue(options, dbuser.OptPasswordLifetimeDays)
				if found && days > 0 {
					builder.WriteString(" PASSWORD EXPIRE INTERVAL " + strconv.Itoa(days) + " DAY")
				}
			default:
				builder.WriteString(" PASSWORD EXPIRE DEFAULT")
			}
		} else if days, found := dbuser.OptionIntValue(options, dbuser.OptPasswordLifetimeDays); found && days > 0 {
			builder.WriteString(" PASSWORD EXPIRE INTERVAL " + strconv.Itoa(days) + " DAY")
		}
	}
	if p.feature(featPasswordHistory) {
		builder.WriteString(defaultableClause(options, dbuser.OptPasswordHistory, " PASSWORD HISTORY ", ""))
		builder.WriteString(defaultableClause(options, dbuser.OptPasswordReuseDays, " PASSWORD REUSE INTERVAL ", " DAY"))
	}
	if value, ok := options[dbuser.OptPasswordRequireCurrent]; ok && p.feature(featRequireCurrent) {
		switch value {
		case requireCurrentRequired:
			builder.WriteString(" PASSWORD REQUIRE CURRENT")
		case requireCurrentOptional:
			builder.WriteString(" PASSWORD REQUIRE CURRENT OPTIONAL")
		default:
			builder.WriteString(" PASSWORD REQUIRE CURRENT DEFAULT")
		}
	}
	if p.feature(featFailedLogin) {
		if attempts, ok := dbuser.OptionIntValue(options, dbuser.OptFailedLoginAttempts); ok {
			builder.WriteString(" FAILED_LOGIN_ATTEMPTS " + strconv.Itoa(attempts))
		}
		if days, ok := dbuser.OptionIntValue(options, dbuser.OptPasswordLockDays); ok {
			if days < 0 {
				builder.WriteString(" PASSWORD_LOCK_TIME UNBOUNDED")
			} else {
				builder.WriteString(" PASSWORD_LOCK_TIME " + strconv.Itoa(days))
			}
		}
	}
	return builder.String()
}

// defaultableClause 生成「空值 = DEFAULT」的子句。
func defaultableClause(options map[string]string, id, prefix, suffix string) string {
	raw, ok := options[id]
	if !ok {
		return ""
	}
	if strings.TrimSpace(raw) == "" {
		return prefix + "DEFAULT"
	}
	value, found := dbuser.OptionIntValue(options, id)
	if !found {
		return ""
	}
	return prefix + strconv.Itoa(value) + suffix
}

// legacyUsageGrant 为不支持在 CREATE/ALTER USER 中设置限制的旧版本生成 GRANT USAGE。
func (p planner) legacyUsageGrant(target dbuser.PrincipalRef, options map[string]string) (dbuser.Statement, bool) {
	clauses := p.requireClause(options) + p.withClause(options)
	if clauses == "" {
		return dbuser.Statement{}, false
	}
	return dbuser.Plain("GRANT USAGE ON *.* TO "+p.account(target)+clauses, "", dbuser.RiskNormal), true
}

func (p planner) planAlter(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	target := request.Target
	statements := make([]dbuser.Statement, 0, 8)
	if request.Rename != nil && (request.Rename.Name != target.Name || request.Rename.Host != target.Host) {
		renamed := *request.Rename
		renamed.Kind = target.Kind
		statements = append(statements, dbuser.Plain("RENAME USER "+p.account(target)+" TO "+p.account(renamed), "", dbuser.RiskHigh))
		target = renamed
	}
	if target.Kind == dbuser.KindUser {
		passwordStatements, err := p.planPassword(target, request)
		if err != nil {
			return nil, err
		}
		statements = append(statements, passwordStatements...)
		statements = append(statements, p.planAccountOptions(target, request.Options)...)
	}
	return append(statements, p.planPrivilegesAndRoles(target, request)...), nil
}

func (p planner) planPassword(target dbuser.PrincipalRef, request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	plugin, pluginChanged := request.Options[dbuser.OptAuthPlugin]
	change := request.Password
	if change == nil || !change.Set {
		if pluginChanged {
			// 换插件必须同时设置口令，否则账号口令会被清空。
			return nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
		}
		return nil, nil
	}
	if err := p.validatePassword(change.Password, target.Name); err != nil {
		return nil, err
	}
	var builder dbuser.SQLBuilder
	if !p.feature(featAlterUser) {
		builder.Write("SET PASSWORD FOR ", p.account(target), " = PASSWORD(").
			Secret(p.literal(change.Password), dbuser.Masked("'", "'")).Write(")")
		return []dbuser.Statement{builder.Statement("", dbuser.RiskHigh)}, nil
	}
	builder.Write("ALTER USER ", p.account(target))
	p.writeIdentified(&builder, plugin, change.Password)
	if change.CurrentPassword != "" && p.feature(featRequireCurrent) {
		builder.Write(" REPLACE ").Secret(p.literal(change.CurrentPassword), dbuser.Masked("'", "'"))
	}
	if change.RetainCurrent && p.feature(featDualPassword) {
		builder.Write(" RETAIN CURRENT PASSWORD")
	}
	return []dbuser.Statement{builder.Statement("", dbuser.RiskHigh)}, nil
}

func (p planner) planAccountOptions(target dbuser.PrincipalRef, options map[string]string) []dbuser.Statement {
	statements := make([]dbuser.Statement, 0, 2)
	rest := make(map[string]string, len(options))
	for id, value := range options {
		if id != dbuser.OptAuthPlugin && id != dbuser.OptExpirePasswordNow && id != dbuser.OptDefaultRoles {
			rest[id] = value
		}
	}
	if p.feature(featAlterUser) {
		var builder dbuser.SQLBuilder
		builder.Write("ALTER USER ", p.account(target))
		if p.writeAccountClauses(&builder, rest) {
			risk := dbuser.RiskNormal
			if locked, ok := dbuser.OptionBoolValue(rest, dbuser.OptAccountLocked); ok && locked {
				risk = dbuser.RiskHigh
			}
			statements = append(statements, builder.Statement("", risk))
		}
	} else if usage, ok := p.legacyUsageGrant(target, rest); ok {
		statements = append(statements, usage)
	}
	if expire, ok := dbuser.OptionBoolValue(options, dbuser.OptExpirePasswordNow); ok && expire && p.feature(featExpireNow) {
		statements = append(statements, dbuser.Plain("ALTER USER "+p.account(target)+" PASSWORD EXPIRE", "", dbuser.RiskHigh))
	}
	return statements
}

func (p planner) planDrop(request dbuser.ChangeRequest) dbuser.Statement {
	keyword := "DROP USER "
	if request.Target.Kind == dbuser.KindRole {
		keyword = "DROP ROLE "
	}
	return dbuser.Plain(keyword+p.account(request.Target), "", dbuser.RiskDanger)
}
