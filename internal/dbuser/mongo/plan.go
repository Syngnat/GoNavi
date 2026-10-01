package mongo

import (
	"encoding/json"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// mongoNameRule：用户名/角色名/库名不允许 NUL 等控制字符，长度按经验上限控制。
var mongoNameRule = dbuser.NameRule{MaxLength: 256}

func jsonString(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

// command 以固定键顺序构造 JSON 命令；命令名必须位于首位（driver 按有序文档解析）。
type command struct {
	exec    strings.Builder
	display strings.Builder
	fields  int
}

func newCommand(name, value string) *command {
	c := &command{}
	c.exec.WriteString("{")
	c.display.WriteString("{")
	c.field(name, jsonString(value))
	return c
}

func (c *command) field(key, rawJSON string) *command {
	if c.fields > 0 {
		c.exec.WriteString(", ")
		c.display.WriteString(", ")
	}
	part := jsonString(key) + ": " + rawJSON
	c.exec.WriteString(part)
	c.display.WriteString(part)
	c.fields++
	return c
}

func (c *command) secret(key, value string) *command {
	if c.fields > 0 {
		c.exec.WriteString(", ")
		c.display.WriteString(", ")
	}
	c.exec.WriteString(jsonString(key) + ": " + jsonString(value))
	c.display.WriteString(jsonString(key) + ": " + jsonString(dbuser.MaskedSecret))
	c.fields++
	return c
}

func (c *command) statement(database, risk string) dbuser.Statement {
	return dbuser.Statement{Exec: c.exec.String() + "}", Display: c.display.String() + "}", Database: database, Risk: risk}
}

func rolesJSON(memberships []dbuser.Membership) string {
	parts := make([]string, 0, len(memberships))
	for _, membership := range memberships {
		parts = append(parts, `{"role": `+jsonString(membership.Role.Name)+`, "db": `+jsonString(membership.Role.Database)+`}`)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func listJSON(items []string) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, jsonString(item))
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// Plan 实现 dbuser.Provider。命令在主体所在认证库执行。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	target := request.Target
	for _, name := range []string{target.Name, target.Database} {
		if err := dbuser.ValidateName(name, mongoNameRule); err != nil {
			return dbuser.Plan{}, err
		}
	}
	for _, membership := range append(append([]dbuser.Membership{}, request.MembershipsAdd...), request.MembershipsRemove...) {
		if err := dbuser.ValidateName(membership.Role.Name, mongoNameRule); err != nil {
			return dbuser.Plan{}, err
		}
		if err := dbuser.ValidateName(membership.Role.Database, mongoNameRule); err != nil {
			return dbuser.Plan{}, err
		}
	}
	if request.Rename != nil && request.Rename.Name != target.Name {
		return dbuser.Plan{}, dbuser.NewError(dbuser.ErrCodeRenameUnsupported, nil)
	}
	customData, err := customDataJSON(request.Options)
	if err != nil {
		return dbuser.Plan{}, err
	}
	var statements []dbuser.Statement
	switch {
	case request.Action == dbuser.ActionDrop:
		keyword := "dropUser"
		if target.Kind == dbuser.KindRole {
			keyword = "dropRole"
		}
		if isSystemUser(target.Name) {
			return dbuser.Plan{}, dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", target.Name)
		}
		statements = append(statements, newCommand(keyword, target.Name).statement(target.Database, dbuser.RiskDanger))
	case target.Kind == dbuser.KindRole:
		statements = planRole(request)
	default:
		userStatements, planErr := planUser(profile, request, customData)
		if planErr != nil {
			return dbuser.Plan{}, planErr
		}
		statements = userStatements
	}
	return dbuser.Plan{Statements: statements}, nil
}

func customDataJSON(options map[string]string) (string, error) {
	raw, ok := options[dbuser.OptCustomData]
	if !ok {
		return "", nil
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "{}", nil
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
		return "", dbuser.Errorf(dbuser.ErrCodeInvalidOption, "option", dbuser.OptCustomData)
	}
	compact, _ := json.Marshal(document)
	return string(compact), nil
}

func planUser(profile dbuser.ServerProfile, request dbuser.ChangeRequest, customData string) ([]dbuser.Statement, error) {
	target := request.Target
	options := request.Options
	change := request.Password
	if change != nil && change.Set && change.Password != "" {
		if err := dbuser.ValidatePassword(change.Password, target.Name, profile.PasswordPolicy); err != nil {
			return nil, err
		}
	}
	var cmd *command
	if request.Action == dbuser.ActionCreate {
		if change == nil || !change.Set {
			return nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
		}
		cmd = newCommand("createUser", target.Name).secret("pwd", change.Password).field("roles", rolesJSON(request.MembershipsAdd))
	} else {
		cmd = newCommand("updateUser", target.Name)
		if change != nil && change.Set {
			cmd.secret("pwd", change.Password)
		}
	}
	if raw, ok := options[dbuser.OptMechanisms]; ok {
		mechanisms := dbuser.SplitList(raw)
		if len(mechanisms) > 0 {
			cmd.field("mechanisms", listJSON(mechanisms))
		}
	}
	if customData != "" {
		cmd.field("customData", customData)
	}
	_, clientsChanged := options[dbuser.OptClientSources]
	_, serversChanged := options[dbuser.OptServerAddresses]
	if clientsChanged || serversChanged {
		cmd.field("authenticationRestrictions", restrictionsJSON(options))
	}
	statements := []dbuser.Statement{}
	risk := dbuser.RiskNormal
	if request.Action == dbuser.ActionAlter {
		risk = dbuser.RiskHigh
	}
	if cmd.fields > 1 || request.Action == dbuser.ActionCreate {
		statements = append(statements, cmd.statement(target.Database, risk))
	}
	if request.Action == dbuser.ActionAlter {
		statements = append(statements, membershipStatements("RolesToUser", "RolesFromUser", request)...)
	}
	return statements, nil
}

func restrictionsJSON(options map[string]string) string {
	clients := dbuser.SplitList(options[dbuser.OptClientSources])
	servers := dbuser.SplitList(options[dbuser.OptServerAddresses])
	if len(clients) == 0 && len(servers) == 0 {
		return "[]"
	}
	parts := make([]string, 0, 2)
	if len(clients) > 0 {
		parts = append(parts, `"clientSource": `+listJSON(clients))
	}
	if len(servers) > 0 {
		parts = append(parts, `"serverAddress": `+listJSON(servers))
	}
	return "[{" + strings.Join(parts, ", ") + "}]"
}

func planRole(request dbuser.ChangeRequest) []dbuser.Statement {
	target := request.Target
	if request.Action == dbuser.ActionCreate {
		cmd := newCommand("createRole", target.Name).field("privileges", "[]").field("roles", rolesJSON(request.MembershipsAdd))
		return []dbuser.Statement{cmd.statement(target.Database, dbuser.RiskNormal)}
	}
	return membershipStatements("RolesToRole", "RolesFromRole", request)
}

// membershipStatements 生成 grantRolesTo* / revokeRolesFrom* 命令。
func membershipStatements(grantSuffix, revokeSuffix string, request dbuser.ChangeRequest) []dbuser.Statement {
	var statements []dbuser.Statement
	if len(request.MembershipsRemove) > 0 {
		cmd := newCommand("revoke"+revokeSuffix, request.Target.Name).field("roles", rolesJSON(request.MembershipsRemove))
		statements = append(statements, cmd.statement(request.Target.Database, dbuser.RiskHigh))
	}
	if len(request.MembershipsAdd) > 0 {
		cmd := newCommand("grant"+grantSuffix, request.Target.Name).field("roles", rolesJSON(request.MembershipsAdd))
		statements = append(statements, cmd.statement(request.Target.Database, dbuser.RiskNormal))
	}
	return statements
}
