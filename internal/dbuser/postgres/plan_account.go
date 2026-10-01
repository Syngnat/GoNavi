package postgres

import (
	"maps"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// PG 标识符上限 NAMEDATALEN-1 = 63 字节。
var roleNameRule = dbuser.NameRule{MaxLength: 63, MaxBytes: true}

var timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$`)

type planner struct {
	profile dbuser.ServerProfile
	variant variant
}

func (p planner) feature(name string) bool {
	return p.profile.Feature(name)
}

// Plan 实现 dbuser.Provider。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	pl := planner{profile: profile, variant: p.variant}
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
	// PG 的 CREATE/ALTER ROLE 与 GRANT 都可在事务中执行并回滚；openGauss 系未经验证，逐条执行。
	return dbuser.Plan{Statements: statements, Transactional: p.variant == variantPostgres}, nil
}

func (p planner) validate(request dbuser.ChangeRequest) error {
	names := []string{request.Target.Name}
	if request.Rename != nil {
		names = append(names, request.Rename.Name)
	}
	for _, membership := range append(append([]dbuser.Membership{}, request.MembershipsAdd...), request.MembershipsRemove...) {
		names = append(names, membership.Role.Name)
	}
	if request.Drop != nil && request.Drop.ReassignTo != "" {
		names = append(names, request.Drop.ReassignTo)
	}
	for _, name := range names {
		if err := dbuser.ValidateName(name, roleNameRule); err != nil {
			return err
		}
	}
	for _, id := range []string{dbuser.OptValidUntil, dbuser.OptValidBegin} {
		if value := strings.TrimSpace(request.Options[id]); value != "" && !strings.EqualFold(value, "infinity") && !timestampPattern.MatchString(value) {
			return dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", id)
		}
	}
	grants := append(append([]dbuser.Grant{}, request.GrantsAdd...), request.GrantsRevoke...)
	if err := dbuser.ValidateGrants(p.profile, grants); err != nil {
		return err
	}
	for _, grant := range grants {
		if grant.Scope != dbuser.ScopeRoutine {
			continue
		}
		if _, _, ok := splitRoutineSignature(grant.Object); !ok {
			return dbuser.Errorf(dbuser.ErrCodeInvalidObject, "scope", grant.Scope)
		}
	}
	if request.Action == dbuser.ActionDrop && isSystemRole(request.Target.Name) {
		return dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", request.Target.Name)
	}
	return nil
}

func role(name string) string {
	return dbuser.QuoteDouble(name)
}

func (p planner) planCreate(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	target := request.Target
	kind, _ := p.profile.Kind(target.Kind)
	password := request.Password
	if kind.SupportsPassword && target.Kind == dbuser.KindUser && (password == nil || !password.Set) {
		return nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
	}
	options := maps.Clone(request.Options)
	if options == nil {
		options = map[string]string{}
	}
	if _, ok := options[dbuser.OptCanLogin]; !ok {
		options[dbuser.OptCanLogin] = strconv.FormatBool(target.Kind == dbuser.KindUser)
	}
	var builder dbuser.SQLBuilder
	keyword := "CREATE ROLE "
	if p.variant == variantOpenGauss && target.Kind == dbuser.KindUser {
		keyword = "CREATE USER "
	}
	builder.Write(keyword, role(target.Name), " WITH")
	builder.Write(p.attributeClauses(options, true)...)
	secret, err := p.writePassword(&builder, password, target.Name, options)
	if err != nil {
		return nil, err
	}
	if !secret && p.variant == variantOpenGauss {
		// openGauss 的 CREATE ROLE 必须带口令子句；无口令角色用 PASSWORD DISABLE。
		builder.Write(" PASSWORD DISABLE")
	}
	statements := []dbuser.Statement{builder.Statement("", dbuser.RiskNormal)}
	if comment, ok := options[dbuser.OptComment]; ok && strings.TrimSpace(comment) != "" {
		statements = append(statements, commentStatement(target.Name, comment))
	}
	return append(statements, p.planPrivilegesAndMemberships(target.Name, request)...), nil
}

// attributeClauses 生成角色属性子句；只输出请求中出现的项。
func (p planner) attributeClauses(options map[string]string, creating bool) []string {
	flags := []struct{ id, on, off string }{
		{dbuser.OptSuperuser, "SUPERUSER", "NOSUPERUSER"},
		{dbuser.OptSysAdmin, "SYSADMIN", "NOSYSADMIN"},
		{dbuser.OptAuditAdmin, "AUDITADMIN", "NOAUDITADMIN"},
		{dbuser.OptMonAdmin, "MONADMIN", "NOMONADMIN"},
		{dbuser.OptOprAdmin, "OPRADMIN", "NOOPRADMIN"},
		{dbuser.OptPolAdmin, "POLADMIN", "NOPOLADMIN"},
		{dbuser.OptCreateDB, "CREATEDB", "NOCREATEDB"},
		{dbuser.OptCreateRole, "CREATEROLE", "NOCREATEROLE"},
		{dbuser.OptInherit, "INHERIT", "NOINHERIT"},
		{dbuser.OptCanLogin, "LOGIN", "NOLOGIN"},
		{dbuser.OptReplication, "REPLICATION", "NOREPLICATION"},
		{dbuser.OptBypassRLS, "BYPASSRLS", "NOBYPASSRLS"},
	}
	clauses := make([]string, 0, len(flags)+4)
	for _, flag := range flags {
		if value, ok := dbuser.OptionBoolValue(options, flag.id); ok {
			if value {
				clauses = append(clauses, " "+flag.on)
			} else if !creating || flag.id == dbuser.OptCanLogin {
				clauses = append(clauses, " "+flag.off)
			}
		}
	}
	if raw, ok := options[dbuser.OptConnectionLimit]; ok {
		limit, found := dbuser.OptionIntValue(options, dbuser.OptConnectionLimit)
		if !found && strings.TrimSpace(raw) == "" {
			limit = -1
		}
		clauses = append(clauses, " CONNECTION LIMIT "+strconv.Itoa(limit))
	}
	if value, ok := options[dbuser.OptValidBegin]; ok && p.variant == variantOpenGauss && strings.TrimSpace(value) != "" {
		clauses = append(clauses, " VALID BEGIN "+dbuser.PGString(value))
	}
	if value, ok := options[dbuser.OptValidUntil]; ok {
		if strings.TrimSpace(value) == "" {
			value = "infinity"
		}
		clauses = append(clauses, " VALID UNTIL "+dbuser.PGString(value))
	}
	return clauses
}

// writePassword 追加口令子句；返回是否写入了口令（含 NULL/DISABLE）。
// 原生 PG 10+ 在客户端预计算 verifier，明文不进入服务端日志。
func (p planner) writePassword(builder *dbuser.SQLBuilder, change *dbuser.PasswordChange, roleName string, options map[string]string) (bool, error) {
	if change == nil || !change.Set {
		return false, nil
	}
	if change.Remove {
		if p.variant == variantOpenGauss {
			builder.Write(" PASSWORD DISABLE")
		} else {
			builder.Write(" PASSWORD NULL")
		}
		return true, nil
	}
	if change.Password != "" {
		if err := dbuser.ValidatePassword(change.Password, roleName, p.profile.PasswordPolicy); err != nil {
			return false, err
		}
	}
	keyword := " PASSWORD "
	if p.variant == variantOpenGauss {
		keyword = " IDENTIFIED BY "
	}
	builder.Write(keyword)
	masked := dbuser.Masked("'", "'")
	if change.Password == "" {
		builder.Secret(dbuser.PGString(""), masked)
		return true, nil
	}
	if p.feature(featClientHash) && isPrehashable(change.Password) {
		verifier, err := p.verifier(change.Password, roleName, options)
		if err != nil {
			return false, err
		}
		builder.Secret(dbuser.PlainString(verifier), masked)
		return true, nil
	}
	builder.Secret(dbuser.PGString(change.Password), masked)
	return true, nil
}

func (p planner) verifier(password, roleName string, options map[string]string) (string, error) {
	method := options[dbuser.OptPasswordEncryption]
	if method == "" {
		method = p.profile.Dialect[dialectEncryption]
	}
	if method == "md5" {
		return md5Verifier(password, roleName), nil
	}
	return scramSHA256Verifier(password, defaultRandom)
}

func commentStatement(name, comment string) dbuser.Statement {
	value := "NULL"
	if strings.TrimSpace(comment) != "" {
		value = dbuser.PGString(comment)
	}
	return dbuser.Plain("COMMENT ON ROLE "+role(name)+" IS "+value, "", dbuser.RiskNormal)
}

func (p planner) planAlter(request dbuser.ChangeRequest) ([]dbuser.Statement, error) {
	name := request.Target.Name
	statements := make([]dbuser.Statement, 0, 8)
	if request.Rename != nil && request.Rename.Name != name {
		statements = append(statements, dbuser.Plain("ALTER ROLE "+role(name)+" RENAME TO "+role(request.Rename.Name), "", dbuser.RiskHigh))
		name = request.Rename.Name
	}
	var builder dbuser.SQLBuilder
	builder.Write("ALTER ROLE ", role(name), " WITH")
	clauses := p.attributeClauses(request.Options, false)
	builder.Write(clauses...)
	wrote := len(clauses) > 0
	if request.Password != nil && request.Password.Set && !(p.variant == variantOpenGauss && request.Password.CurrentPassword != "") {
		secret, err := p.writePassword(&builder, request.Password, name, request.Options)
		if err != nil {
			return nil, err
		}
		wrote = wrote || secret
	}
	if wrote {
		statements = append(statements, builder.Statement("", dbuser.RiskHigh))
	}
	if p.variant == variantOpenGauss {
		statements = append(statements, p.openGaussAccountStatements(name, request)...)
	}
	if comment, ok := request.Options[dbuser.OptComment]; ok {
		statements = append(statements, commentStatement(name, comment))
	}
	return append(statements, p.planPrivilegesAndMemberships(name, request)...), nil
}

// openGaussAccountStatements 处理 openGauss 特有的改自身口令（REPLACE）与账户锁定。
func (p planner) openGaussAccountStatements(name string, request dbuser.ChangeRequest) []dbuser.Statement {
	var statements []dbuser.Statement
	if change := request.Password; change != nil && change.Set && change.CurrentPassword != "" {
		var builder dbuser.SQLBuilder
		masked := dbuser.Masked("'", "'")
		builder.Write("ALTER USER ", role(name), " IDENTIFIED BY ").Secret(dbuser.PGString(change.Password), masked).
			Write(" REPLACE ").Secret(dbuser.PGString(change.CurrentPassword), masked)
		statements = append(statements, builder.Statement("", dbuser.RiskHigh))
	}
	if locked, ok := dbuser.OptionBoolValue(request.Options, dbuser.OptAccountLocked); ok {
		keyword := " ACCOUNT UNLOCK"
		risk := dbuser.RiskNormal
		if locked {
			keyword, risk = " ACCOUNT LOCK", dbuser.RiskHigh
		}
		statements = append(statements, dbuser.Plain("ALTER USER "+role(name)+keyword, "", risk))
	}
	return statements
}

func (p planner) planDrop(request dbuser.ChangeRequest) []dbuser.Statement {
	name := request.Target.Name
	statements := make([]dbuser.Statement, 0, 3)
	if drop := request.Drop; drop != nil && p.variant == variantPostgres {
		if drop.ReassignTo != "" {
			statements = append(statements, dbuser.Plain("REASSIGN OWNED BY "+role(name)+" TO "+role(drop.ReassignTo), request.Database, dbuser.RiskDanger))
		}
		if drop.DropOwned {
			statements = append(statements, dbuser.Plain("DROP OWNED BY "+role(name), request.Database, dbuser.RiskDanger))
		}
	}
	keyword := "DROP ROLE "
	if p.variant == variantOpenGauss && request.Target.Kind == dbuser.KindUser {
		keyword = "DROP USER "
	}
	text := keyword + role(name)
	if p.variant == variantOpenGauss && request.Drop != nil && request.Drop.Cascade {
		text += " CASCADE"
	}
	return append(statements, dbuser.Plain(text, "", dbuser.RiskDanger))
}
