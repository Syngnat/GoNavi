// Package mongo 实现 MongoDB（3.6–8.x）的用户与角色管理。
// 所有命令以有序 JSON 文本经 Executor 下发（driver 在 agent 进程中执行 RunCommand），
// 本包不引入 bson，避免 lite 构建依赖 mongo-driver。
package mongo

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 特性开关。
const (
	featSCRAM256     = "scramSha256"
	featRestrictions = "authenticationRestrictions"
)

// 提示码。
const (
	noticeAuthDisabled   = "mongo_auth_disabled"
	noticeManaged        = "mongo_managed_service"
	noticeSHA256Clients  = "mongo_scram_sha256_clients"
	adminDatabase        = "admin"
	maxDatabasesForRoles = 30
)

// perDatabaseRoles 是每个库都存在的内置角色。
var perDatabaseRoles = []string{"read", "readWrite", "dbAdmin", "dbOwner", "userAdmin"}

// Provider 是 MongoDB 实现。
type Provider struct{}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 MongoDB Provider。
func New() *Provider {
	return &Provider{}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	return dbuser.FamilyMongo
}

// runCommand 执行命令并返回结果文档（兼容 agent 回传的 {"result": {...}} 与游标文档行）。
func runCommand(ctx context.Context, env dbuser.Env, database, command string) (map[string]any, error) {
	rows, err := env.SQL.Query(ctx, database, command)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return map[string]any{}, nil
	}
	if result, ok := rows[0]["result"]; ok {
		if document, normalized := dbuser.NormalizeDocument(result); normalized {
			return document, nil
		}
	}
	document, _ := dbuser.NormalizeDocument(rows[0])
	return document, nil
}

// findRows 执行 find 命令（driver 以原生游标返回文档行）。
func findRows(ctx context.Context, env dbuser.Env, database, command string) ([]map[string]any, error) {
	rows, err := env.SQL.Query(ctx, database, command)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if document, ok := dbuser.NormalizeDocument(row); ok {
			out = append(out, document)
		}
	}
	return out, nil
}

func documents(value any) []map[string]any {
	items, _ := value.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if document, ok := item.(map[string]any); ok {
			out = append(out, document)
		}
	}
	return out
}

// Probe 实现 dbuser.Provider。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, target dbuser.Target) (dbuser.ServerProfile, error) {
	info, err := runCommand(ctx, env, adminDatabase, `{"buildInfo": 1}`)
	if err != nil {
		return dbuser.ServerProfile{}, fmt.Errorf("probe mongodb buildInfo: %w", err)
	}
	versionText := dbuser.AsString(info["version"])
	version := dbuser.ParseDottedVersion(versionText)
	profile := dbuser.ServerProfile{
		Supported:   true,
		Family:      dbuser.FamilyMongo,
		Flavor:      "mongodb",
		Version:     version,
		VersionText: "MongoDB " + versionText,
		Banner:      versionText,
		Features: map[string]bool{
			featSCRAM256:     version.AtLeast(4, 0, 0),
			featRestrictions: version.AtLeast(3, 6, 0),
			"adminOption":    false,
			"grantOption":    false,
		},
	}
	profile.CurrentUser, profile.Permissions = probeConnection(ctx, env)
	if profile.CurrentUser == "" {
		profile.Notices = append(profile.Notices, dbuser.Notef(noticeAuthDisabled, dbuser.LevelWarning))
	}
	if !profile.Permissions.CanCreate && profile.CurrentUser != "" {
		profile.Notices = append(profile.Notices, dbuser.Notef(noticeManaged, dbuser.LevelWarning))
	}
	profile.Kinds = []dbuser.KindDescriptor{
		{Kind: dbuser.KindUser, Creatable: true, IdentityFields: []string{"name", "database"}, SupportsPassword: true},
		{Kind: dbuser.KindRole, Creatable: true, IdentityFields: []string{"name", "database"}},
	}
	profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabAdvanced, dbuser.TabMembership, dbuser.TabPreview}
	profile.Options = buildOptions(profile)
	profile.AssignableRoles = assignableRoles(ctx, env)
	if profile.Feature(featSCRAM256) {
		profile.Notices = append(profile.Notices, dbuser.Notef(noticeSHA256Clients, dbuser.LevelInfo))
	}
	return profile, nil
}

// probeConnection 读取当前认证用户与其对用户管理的操作权限。
func probeConnection(ctx context.Context, env dbuser.Env) (string, dbuser.Permissions) {
	status, err := runCommand(ctx, env, adminDatabase, `{"connectionStatus": 1, "showPrivileges": true}`)
	unknown := dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true}
	if err != nil {
		return "", unknown
	}
	auth, _ := status["authInfo"].(map[string]any)
	users := documents(auth["authenticatedUsers"])
	if len(users) == 0 {
		return "", unknown
	}
	current := dbuser.AsString(users[0]["user"]) + "@" + dbuser.AsString(users[0]["db"])
	actions := map[string]bool{}
	for _, privilege := range documents(auth["authenticatedUserPrivileges"]) {
		items, _ := privilege["actions"].([]any)
		for _, action := range items {
			actions[dbuser.AsString(action)] = true
		}
	}
	return current, dbuser.Permissions{
		CanList:   actions["viewUser"] || actions["viewRole"],
		CanCreate: actions["createUser"],
		CanAlter:  actions["changePassword"] || actions["changeCustomData"] || actions["grantRole"],
		CanDrop:   actions["dropUser"],
		CanGrant:  actions["grantRole"] && actions["revokeRole"],
	}
}

func buildOptions(profile dbuser.ServerProfile) []dbuser.OptionDescriptor {
	user := dbuser.KindUser
	mechanisms := dbuser.Choices("SCRAM-SHA-1")
	if profile.Feature(featSCRAM256) {
		mechanisms = append(mechanisms, dbuser.Choice{Value: "SCRAM-SHA-256"})
	}
	mechanismOption := dbuser.OptionDescriptor{ID: dbuser.OptMechanisms, Type: dbuser.OptionMulti, Tab: dbuser.TabGeneral, Choices: mechanisms, Kinds: []dbuser.PrincipalKind{user}}
	options := []dbuser.OptionDescriptor{
		mechanismOption,
		{ID: dbuser.OptCustomData, Type: dbuser.OptionText, Tab: dbuser.TabAdvanced, Kinds: []dbuser.PrincipalKind{user}},
	}
	if profile.Feature(featRestrictions) {
		options = append(options,
			dbuser.OptionDescriptor{ID: dbuser.OptClientSources, Type: dbuser.OptionList, Tab: dbuser.TabAdvanced, Kinds: []dbuser.PrincipalKind{user}},
			dbuser.OptionDescriptor{ID: dbuser.OptServerAddresses, Type: dbuser.OptionList, Tab: dbuser.TabAdvanced, Kinds: []dbuser.PrincipalKind{user}},
		)
	}
	return options
}

// assignableRoles 返回内置角色：admin 库的集群/全库角色 + 每个库的库级角色。
func assignableRoles(ctx context.Context, env dbuser.Env) []dbuser.PrincipalRef {
	var roles []dbuser.PrincipalRef
	result, err := runCommand(ctx, env, adminDatabase, `{"rolesInfo": 1, "showBuiltinRoles": true}`)
	if err == nil {
		for _, role := range documents(result["roles"]) {
			if dbuser.CellBool(role, "isBuiltin") {
				roles = append(roles, dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: dbuser.AsString(role["role"]), Database: adminDatabase})
			}
		}
	}
	databases, err := runCommand(ctx, env, adminDatabase, `{"listDatabases": 1, "nameOnly": true}`)
	if err != nil {
		return roles
	}
	names := make([]string, 0, 16)
	for _, database := range documents(databases["databases"]) {
		name := dbuser.AsString(database["name"])
		if name != "" && name != adminDatabase && name != "local" && name != "config" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) > maxDatabasesForRoles {
		names = names[:maxDatabasesForRoles]
	}
	for _, name := range names {
		for _, role := range perDatabaseRoles {
			roles = append(roles, dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: role, Database: name})
		}
	}
	return roles
}

func isSystemUser(name string) bool {
	return strings.HasPrefix(name, "__")
}
