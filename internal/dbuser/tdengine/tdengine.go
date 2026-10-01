// Package tdengine 实现 TDengine（2.x / 3.x）的账号管理。
// 2.x 只有 read/write 两级用户权限（ALTER USER ... PRIVILEGE）；3.x 支持按库/表 GRANT。
package tdengine

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 特性开关。
const (
	featGrants   = "grants"
	featCreateDB = "createDb"
	featEnable   = "enable"
)

// forbiddenPasswordChars 是 TDengine 口令不允许的字符（官方文档：单双引号、反引号、反斜杠、空格）。
const forbiddenPasswordChars = "'\"`\\ "

// userNameRule：用户名只允许字母数字下划线，最长 23 字节。
var userNameRule = dbuser.NameRule{MaxLength: 23, MaxBytes: true, AllowedRunes: dbuser.IsIdentifierRune}

// Provider 是 TDengine 实现。
type Provider struct{}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 TDengine Provider。
func New() *Provider {
	return &Provider{}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	return dbuser.FamilyTDengine
}

// Probe 实现 dbuser.Provider。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, target dbuser.Target) (dbuser.ServerProfile, error) {
	rows, err := env.SQL.Query(ctx, "", "SELECT SERVER_VERSION() AS version")
	if err != nil {
		return dbuser.ServerProfile{}, fmt.Errorf("probe tdengine version: %w", err)
	}
	versionText := ""
	if len(rows) > 0 {
		versionText = dbuser.CellString(rows[0], "version")
	}
	version := dbuser.ParseDottedVersion(versionText)
	v3 := version.Major >= 3
	profile := dbuser.ServerProfile{
		Supported:   true,
		Family:      dbuser.FamilyTDengine,
		Flavor:      "tdengine",
		Version:     version,
		VersionText: "TDengine " + versionText,
		Banner:      versionText,
		CurrentUser: target.ConnectionUser,
		Features: map[string]bool{
			featGrants:    v3,
			featEnable:    v3,
			featCreateDB:  version.AtLeast(3, 3, 2),
			"grantOption": false,
			"adminOption": false,
		},
		PasswordPolicy: dbuser.PasswordPolicy{ForbiddenChars: forbiddenPasswordChars, MaxLength: 128, Source: "tdengine"},
		Permissions:    dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true},
		Kinds:          []dbuser.KindDescriptor{{Kind: dbuser.KindUser, Creatable: true, IdentityFields: []string{"name"}, SupportsPassword: true}},
	}
	if version.AtLeast(3, 3, 5) {
		profile.PasswordPolicy.MinLength, profile.PasswordPolicy.MaxLength, profile.PasswordPolicy.MinCategories = 8, 16, 3
	}
	user := dbuser.KindUser
	if v3 {
		profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabObjectPrivileges, dbuser.TabPreview}
		profile.ObjectScopes = []string{dbuser.ScopeDatabase, dbuser.ScopeTable}
		scopes := []string{dbuser.ScopeDatabase, dbuser.ScopeTable}
		profile.Privileges = []dbuser.PrivilegeDescriptor{{Name: "READ", Scopes: scopes}, {Name: "WRITE", Scopes: scopes}}
		profile.Options = []dbuser.OptionDescriptor{dbuser.BoolOption(dbuser.OptLoginEnabled, dbuser.TabGeneral, user), dbuser.BoolOption(dbuser.OptSysInfo, dbuser.TabGeneral, user)}
		if profile.Feature(featCreateDB) {
			profile.Options = append(profile.Options, dbuser.BoolOption(dbuser.OptCreateDB, dbuser.TabGeneral, user))
		}
	} else {
		profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabPreview}
		level := dbuser.EnumOption(dbuser.OptPrivilegeLevel, dbuser.TabGeneral, dbuser.Choices("read", "write"), user)
		level.Default = "write"
		profile.Options = []dbuser.OptionDescriptor{level}
	}
	return profile, nil
}

// List 解析 SHOW USERS（3.x: name/super/enable/sysinfo；2.x: name/privilege）。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, _ dbuser.ListQuery) ([]dbuser.Principal, error) {
	rows, err := env.SQL.Query(ctx, "", "SHOW USERS")
	if err != nil {
		return nil, fmt.Errorf("list tdengine users: %w", err)
	}
	principals := make([]dbuser.Principal, 0, len(rows))
	for _, row := range rows {
		principals = append(principals, principalFromRow(profile, row))
	}
	return principals, nil
}

func principalFromRow(profile dbuser.ServerProfile, row map[string]any) dbuser.Principal {
	name := dbuser.CellString(row, "name", "user_name")
	enabled := true
	if value, ok := dbuser.Cell(row, "enable"); ok {
		enabled = dbuser.AsBool(value)
	}
	return dbuser.Principal{
		Ref:       dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: name},
		Locked:    !enabled,
		CanLogin:  enabled,
		Superuser: dbuser.CellBool(row, "super") || strings.EqualFold(dbuser.CellString(row, "privilege"), "super"),
		Current:   strings.EqualFold(name, profile.CurrentUser),
	}
}

// Describe 读取属性与（3.x）按库/表的授权。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	rows, err := env.SQL.Query(ctx, "", "SHOW USERS")
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe tdengine user: %w", err)
	}
	for _, row := range rows {
		if dbuser.CellString(row, "name", "user_name") != query.Ref.Name {
			continue
		}
		detail := dbuser.PrincipalDetail{Principal: principalFromRow(profile, row), Options: map[string]string{}}
		if profile.Feature(featGrants) {
			detail.Options[dbuser.OptLoginEnabled] = strconv.FormatBool(!detail.Principal.Locked)
			detail.Options[dbuser.OptSysInfo] = strconv.FormatBool(dbuser.CellBool(row, "sysinfo"))
			if profile.Feature(featCreateDB) {
				detail.Options[dbuser.OptCreateDB] = strconv.FormatBool(dbuser.CellBool(row, "createdb"))
			}
			detail.Grants = describeGrants(ctx, env, query.Ref.Name)
		} else {
			level := strings.ToLower(dbuser.CellString(row, "privilege"))
			if level != "read" {
				level = "write"
			}
			detail.Options[dbuser.OptPrivilegeLevel] = level
		}
		return detail, nil
	}
	return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
}

func describeGrants(ctx context.Context, env dbuser.Env, name string) []dbuser.Grant {
	rows, err := env.SQL.Query(ctx, "", "SELECT * FROM information_schema.ins_user_privileges WHERE user_name = "+dbuser.PlainString(name))
	if err != nil {
		return nil
	}
	var grants []dbuser.Grant
	for _, row := range rows {
		privilege := strings.ToUpper(dbuser.CellString(row, "privilege"))
		database := dbuser.CellString(row, "db_name")
		table := dbuser.CellString(row, "table_name")
		if database == "" || (privilege != "READ" && privilege != "WRITE" && privilege != "ALL") {
			continue
		}
		grant := dbuser.Grant{Scope: dbuser.ScopeDatabase, Database: database}
		if table != "" && table != "*" {
			grant.Scope, grant.Object = dbuser.ScopeTable, table
		}
		for _, item := range expandAll(privilege) {
			grant.Privilege = item
			grants = append(grants, grant)
		}
	}
	return grants
}

func expandAll(privilege string) []string {
	if privilege == "ALL" {
		return []string{"READ", "WRITE"}
	}
	return []string{privilege}
}

func quoteIdent(name string) string {
	return "`" + name + "`"
}

// Plan 实现 dbuser.Provider。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	name := request.Target.Name
	if err := dbuser.ValidateName(name, userNameRule); err != nil {
		return dbuser.Plan{}, err
	}
	if request.Rename != nil && request.Rename.Name != name {
		return dbuser.Plan{}, dbuser.NewError(dbuser.ErrCodeRenameUnsupported, nil)
	}
	grants := append(append([]dbuser.Grant{}, request.GrantsAdd...), request.GrantsRevoke...)
	if err := dbuser.ValidateGrants(profile, grants); err != nil {
		return dbuser.Plan{}, err
	}
	for _, grant := range grants {
		for _, part := range []string{grant.Database, grant.Object} {
			if part != "" {
				if err := dbuser.ValidateName(part, dbuser.NameRule{MaxLength: 192, AllowedRunes: dbuser.IsIdentifierRune}); err != nil {
					return dbuser.Plan{}, dbuser.Errorf(dbuser.ErrCodeInvalidObject, "scope", grant.Scope)
				}
			}
		}
	}
	var statements []dbuser.Statement
	switch request.Action {
	case dbuser.ActionDrop:
		if strings.EqualFold(name, "root") {
			return dbuser.Plan{}, dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", name)
		}
		statements = []dbuser.Statement{dbuser.Plain("DROP USER "+name, "", dbuser.RiskDanger)}
	case dbuser.ActionCreate:
		if request.Password == nil || !request.Password.Set {
			return dbuser.Plan{}, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
		}
		var builder dbuser.SQLBuilder
		builder.Write("CREATE USER ", name, " PASS ")
		if err := writePassword(&builder, request.Password.Password, name, profile); err != nil {
			return dbuser.Plan{}, err
		}
		if profile.Feature(featGrants) {
			builder.Write(flagClause(request.Options, dbuser.OptSysInfo, " SYSINFO "))
			builder.Write(flagClause(request.Options, dbuser.OptCreateDB, " CREATEDB "))
		}
		statements = append(statements, builder.Statement("", dbuser.RiskNormal))
		statements = append(statements, alterFlags(name, request.Options, profile, true)...)
	default:
		if change := request.Password; change != nil && change.Set {
			var builder dbuser.SQLBuilder
			builder.Write("ALTER USER ", name, " PASS ")
			if err := writePassword(&builder, change.Password, name, profile); err != nil {
				return dbuser.Plan{}, err
			}
			statements = append(statements, builder.Statement("", dbuser.RiskHigh))
		}
		statements = append(statements, alterFlags(name, request.Options, profile, false)...)
	}
	statements = append(statements, grantStatements(name, request)...)
	return dbuser.Plan{Statements: statements}, nil
}

func writePassword(builder *dbuser.SQLBuilder, password, name string, profile dbuser.ServerProfile) error {
	if password != "" {
		if err := dbuser.ValidatePassword(password, name, profile.PasswordPolicy); err != nil {
			return err
		}
	}
	builder.Secret(dbuser.PlainString(password), dbuser.Masked("'", "'"))
	return nil
}

func flagClause(options map[string]string, id, keyword string) string {
	value, ok := dbuser.OptionBoolValue(options, id)
	if !ok {
		return ""
	}
	if value {
		return keyword + "1"
	}
	return keyword + "0"
}

// alterFlags 生成 ENABLE / SYSINFO / CREATEDB（3.x）或 PRIVILEGE（2.x）语句。
func alterFlags(name string, options map[string]string, profile dbuser.ServerProfile, creating bool) []dbuser.Statement {
	var statements []dbuser.Statement
	if !profile.Feature(featGrants) {
		if level, ok := options[dbuser.OptPrivilegeLevel]; ok && level != "" {
			statements = append(statements, dbuser.Plain("ALTER USER "+name+" PRIVILEGE "+level, "", dbuser.RiskNormal))
		}
		return statements
	}
	if enabled, ok := dbuser.OptionBoolValue(options, dbuser.OptLoginEnabled); ok && !(creating && enabled) {
		risk := dbuser.RiskNormal
		if !enabled {
			risk = dbuser.RiskHigh
		}
		statements = append(statements, dbuser.Plain("ALTER USER "+name+flagClause(options, dbuser.OptLoginEnabled, " ENABLE "), "", risk))
	}
	if creating {
		return statements
	}
	for _, item := range []struct{ id, keyword string }{{dbuser.OptSysInfo, " SYSINFO "}, {dbuser.OptCreateDB, " CREATEDB "}} {
		if clause := flagClause(options, item.id, item.keyword); clause != "" {
			statements = append(statements, dbuser.Plain("ALTER USER "+name+clause, "", dbuser.RiskNormal))
		}
	}
	return statements
}

func grantStatements(name string, request dbuser.ChangeRequest) []dbuser.Statement {
	var statements []dbuser.Statement
	for _, group := range dbuser.GroupGrants(request.GrantsRevoke) {
		statements = append(statements, dbuser.Plain("REVOKE "+dbuser.PrivilegeList(group.Privileges)+" ON "+grantTarget(group.Target)+" FROM "+name, "", dbuser.RiskHigh))
	}
	for _, group := range dbuser.GroupGrants(request.GrantsAdd) {
		statements = append(statements, dbuser.Plain("GRANT "+dbuser.PrivilegeList(group.Privileges)+" ON "+grantTarget(group.Target)+" TO "+name, "", dbuser.RiskNormal))
	}
	return statements
}

func grantTarget(target dbuser.Grant) string {
	if target.Scope == dbuser.ScopeTable {
		return quoteIdent(target.Database) + "." + quoteIdent(target.Object)
	}
	return quoteIdent(target.Database) + ".*"
}

// Impact：TDengine 删除用户不影响数据对象。
func (p *Provider) Impact(context.Context, dbuser.Env, dbuser.ServerProfile, dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	return dbuser.DropImpact{}, nil
}

// ExportDDL 由详情反向生成脚本（口令为掩码）。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	detail, err := p.Describe(ctx, env, profile, dbuser.DescribeQuery{Ref: ref})
	if err != nil {
		return "", err
	}
	plan, err := p.Plan(profile, dbuser.ChangeRequest{
		Action: dbuser.ActionCreate, Target: ref, Options: detail.Options, GrantsAdd: detail.Grants, Password: &dbuser.PasswordChange{Set: true},
	})
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(plan.Statements))
	for _, statement := range plan.Statements {
		lines = append(lines, statement.Display+";")
	}
	return strings.Join(lines, "\n"), nil
}
