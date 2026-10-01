package mongo

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// List 列出所有库的用户与自定义角色。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, _ dbuser.ListQuery) ([]dbuser.Principal, error) {
	result, err := runCommand(ctx, env, adminDatabase, `{"usersInfo": {"forAllDBs": true}}`)
	var users []map[string]any
	if err == nil {
		users = documents(result["users"])
	} else {
		// 旧版本不支持 forAllDBs 时回退读取 admin.system.users。
		users, err = findRows(ctx, env, adminDatabase, `{"find": "system.users", "projection": {"user": 1, "db": 1, "roles": 1}}`)
		if err != nil {
			return nil, fmt.Errorf("list mongodb users: %w", err)
		}
	}
	principals := make([]dbuser.Principal, 0, len(users)+8)
	for _, user := range users {
		name, database := dbuser.AsString(user["user"]), dbuser.AsString(user["db"])
		principals = append(principals, dbuser.Principal{
			Ref:      dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: name, Database: database},
			System:   isSystemUser(name),
			CanLogin: true,
			Current:  name+"@"+database == profile.CurrentUser,
		})
	}
	roles, err := findRows(ctx, env, adminDatabase, `{"find": "system.roles", "projection": {"role": 1, "db": 1}}`)
	if err == nil {
		for _, role := range roles {
			principals = append(principals, dbuser.Principal{
				Ref: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.AsString(role["role"]), Database: dbuser.AsString(role["db"])},
			})
		}
	}
	return principals, nil
}

func refJSON(ref dbuser.PrincipalRef, key string) string {
	return `{"` + key + `": ` + jsonString(ref.Name) + `, "db": ` + jsonString(ref.Database) + `}`
}

// Describe 读取用户（或角色）的角色、机制、自定义数据与认证限制。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	ref := query.Ref
	if ref.Kind == dbuser.KindRole {
		result, err := runCommand(ctx, env, ref.Database, `{"rolesInfo": `+refJSON(ref, "role")+`}`)
		if err != nil {
			return dbuser.PrincipalDetail{}, fmt.Errorf("describe mongodb role: %w", err)
		}
		roles := documents(result["roles"])
		if len(roles) == 0 {
			return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
		}
		return dbuser.PrincipalDetail{Principal: dbuser.Principal{Ref: ref}, Options: map[string]string{}, MemberOf: memberships(roles[0]["roles"])}, nil
	}
	result, err := runCommand(ctx, env, ref.Database, `{"usersInfo": `+refJSON(ref, "user")+`}`)
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe mongodb user: %w", err)
	}
	users := documents(result["users"])
	if len(users) == 0 {
		return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	user := users[0]
	detail := dbuser.PrincipalDetail{
		Principal: dbuser.Principal{Ref: ref, CanLogin: true, Current: ref.Name+"@"+ref.Database == profile.CurrentUser},
		Options:   map[string]string{},
		MemberOf:  memberships(user["roles"]),
	}
	mechanisms, _ := user["mechanisms"].([]any)
	items := make([]string, 0, len(mechanisms))
	for _, mechanism := range mechanisms {
		items = append(items, dbuser.AsString(mechanism))
	}
	detail.Options[dbuser.OptMechanisms] = dbuser.JoinList(items)
	detail.Options[dbuser.OptCustomData] = ""
	if custom, ok := user["customData"].(map[string]any); ok && len(custom) > 0 {
		if raw, err := json.MarshalIndent(custom, "", "  "); err == nil {
			detail.Options[dbuser.OptCustomData] = string(raw)
		}
	}
	if profile.Feature(featRestrictions) {
		clients, servers := restrictions(user["authenticationRestrictions"])
		detail.Options[dbuser.OptClientSources] = dbuser.JoinList(clients)
		detail.Options[dbuser.OptServerAddresses] = dbuser.JoinList(servers)
	}
	return detail, nil
}

func memberships(value any) []dbuser.Membership {
	var out []dbuser.Membership
	for _, role := range documents(value) {
		out = append(out, dbuser.Membership{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.AsString(role["role"]), Database: dbuser.AsString(role["db"])}})
	}
	return out
}

// restrictions 合并 authenticationRestrictions 数组中的 clientSource / serverAddress。
func restrictions(value any) ([]string, []string) {
	var clients, servers []string
	for _, restriction := range documents(value) {
		for _, item := range asStrings(restriction["clientSource"]) {
			clients = append(clients, item)
		}
		for _, item := range asStrings(restriction["serverAddress"]) {
			servers = append(servers, item)
		}
	}
	return clients, servers
}

func asStrings(value any) []string {
	items, _ := value.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text := strings.TrimSpace(dbuser.AsString(item)); text != "" {
			out = append(out, text)
		}
	}
	return out
}

// Impact：MongoDB 删除用户不影响数据；统计该用户当前连接无公开命令，这里不做。
func (p *Provider) Impact(context.Context, dbuser.Env, dbuser.ServerProfile, dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	return dbuser.DropImpact{}, nil
}

// ExportDDL 生成 mongosh 可执行的创建脚本（口令为占位）。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	detail, err := p.Describe(ctx, env, profile, dbuser.DescribeQuery{Ref: ref})
	if err != nil {
		return "", err
	}
	request := dbuser.ChangeRequest{Action: dbuser.ActionCreate, Target: ref, Options: map[string]string{}, MembershipsAdd: detail.MemberOf}
	for key, value := range detail.Options {
		if value != "" {
			request.Options[key] = value
		}
	}
	if ref.Kind == dbuser.KindUser {
		request.Password = &dbuser.PasswordChange{Set: true}
	}
	plan, err := p.Plan(profile, request)
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(plan.Statements))
	for _, statement := range plan.Statements {
		lines = append(lines, "db.getSiblingDB("+jsonString(statement.Database)+").runCommand("+statement.Display+")")
	}
	return strings.Join(lines, "\n"), nil
}
