package mysql

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

var (
	scopesGlobal   = []string{dbuser.ScopeGlobal}
	scopesDatabase = []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase}
	scopesTable    = []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase, dbuser.ScopeTable}
	scopesColumn   = []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase, dbuser.ScopeTable, dbuser.ScopeColumn}
	scopesRoutine  = []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase, dbuser.ScopeRoutine}
)

type staticPrivilege struct {
	name   string
	scopes []string
	group  string
	since  [3]int
}

// staticPrivileges 是 MySQL 文档中「可授予权限及其层级」的静态表。
// SHOW PRIVILEGES 可用时仅用于确定该版本实际存在哪些权限及补充动态权限。
var staticPrivileges = []staticPrivilege{
	{name: "SELECT", scopes: scopesColumn, group: "data"},
	{name: "INSERT", scopes: scopesColumn, group: "data"},
	{name: "UPDATE", scopes: scopesColumn, group: "data"},
	{name: "DELETE", scopes: scopesTable, group: "data"},
	{name: "REFERENCES", scopes: scopesColumn, group: "structure"},
	{name: "CREATE", scopes: scopesTable, group: "structure"},
	{name: "ALTER", scopes: scopesTable, group: "structure"},
	{name: "DROP", scopes: scopesTable, group: "structure"},
	{name: "INDEX", scopes: scopesTable, group: "structure"},
	{name: "CREATE VIEW", scopes: scopesTable, group: "structure"},
	{name: "SHOW VIEW", scopes: scopesTable, group: "structure"},
	{name: "TRIGGER", scopes: scopesTable, group: "structure"},
	{name: "CREATE TEMPORARY TABLES", scopes: scopesDatabase, group: "structure"},
	{name: "LOCK TABLES", scopes: scopesDatabase, group: "data"},
	{name: "EVENT", scopes: scopesDatabase, group: "routine"},
	{name: "CREATE ROUTINE", scopes: scopesDatabase, group: "routine"},
	{name: "ALTER ROUTINE", scopes: scopesRoutine, group: "routine"},
	{name: "EXECUTE", scopes: scopesRoutine, group: "routine"},
	{name: "CREATE USER", scopes: scopesGlobal, group: "server"},
	{name: "CREATE ROLE", scopes: scopesGlobal, group: "server", since: [3]int{8, 0, 0}},
	{name: "DROP ROLE", scopes: scopesGlobal, group: "server", since: [3]int{8, 0, 0}},
	{name: "CREATE TABLESPACE", scopes: scopesGlobal, group: "server"},
	{name: "FILE", scopes: scopesGlobal, group: "server"},
	{name: "PROCESS", scopes: scopesGlobal, group: "server"},
	{name: "RELOAD", scopes: scopesGlobal, group: "server"},
	{name: "REPLICATION CLIENT", scopes: scopesGlobal, group: "server"},
	{name: "REPLICATION SLAVE", scopes: scopesGlobal, group: "server"},
	{name: "SHOW DATABASES", scopes: scopesGlobal, group: "server"},
	{name: "SHUTDOWN", scopes: scopesGlobal, group: "server"},
	{name: "SUPER", scopes: scopesGlobal, group: "server"},
}

// 不作为可勾选权限展示：USAGE 无意义，PROXY 语法不同，GRANT OPTION 以 WithGrantOption 表达。
var skippedPrivileges = map[string]bool{"USAGE": true, "PROXY": true, "GRANT OPTION": true}

// probePrivileges 合并静态表与 SHOW PRIVILEGES（含 8.0 动态权限、MariaDB 扩展权限）。
func probePrivileges(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile) []dbuser.PrivilegeDescriptor {
	rows, err := env.SQL.Query(ctx, "", "SHOW PRIVILEGES")
	if err != nil || len(rows) == 0 {
		return staticCatalog(profile, nil)
	}
	present := make(map[string]string, len(rows))
	for _, row := range rows {
		name := dbuser.NormalizePrivilegeName(dbuser.CellString(row, "Privilege"))
		if name != "" && !skippedPrivileges[name] {
			present[name] = dbuser.CellString(row, "Context")
		}
	}
	catalog := staticCatalog(profile, present)
	known := make(map[string]bool, len(catalog))
	for _, item := range catalog {
		known[item.Name] = true
	}
	for name, context := range present {
		if known[name] {
			continue
		}
		catalog = append(catalog, dbuser.PrivilegeDescriptor{
			Name:    name,
			Scopes:  scopesFromContext(context),
			Group:   "dynamic",
			Dynamic: true,
		})
	}
	sortDynamicTail(catalog, len(known))
	return catalog
}

func staticCatalog(profile dbuser.ServerProfile, present map[string]string) []dbuser.PrivilegeDescriptor {
	catalog := make([]dbuser.PrivilegeDescriptor, 0, len(staticPrivileges)+16)
	for _, item := range staticPrivileges {
		if present != nil {
			if _, ok := present[item.name]; !ok {
				continue
			}
		} else if item.since != [3]int{} && profile.Flavor != flavorMariaDB && !profile.Version.AtLeast(item.since[0], item.since[1], item.since[2]) {
			continue
		}
		catalog = append(catalog, dbuser.PrivilegeDescriptor{Name: item.name, Scopes: item.scopes, Group: item.group})
	}
	return catalog
}

// scopesFromContext 把 SHOW PRIVILEGES 的 Context 列映射为作用域。
func scopesFromContext(context string) []string {
	lower := strings.ToLower(context)
	switch {
	case strings.Contains(lower, "functions") || strings.Contains(lower, "procedures"):
		return scopesRoutine
	case strings.Contains(lower, "tables"):
		return scopesTable
	case strings.Contains(lower, "databases"):
		return scopesDatabase
	default:
		return scopesGlobal
	}
}

// sortDynamicTail 让动态权限按名称排序，静态部分保持文档顺序。
func sortDynamicTail(catalog []dbuser.PrivilegeDescriptor, staticCount int) {
	tail := catalog[staticCount:]
	for i := 1; i < len(tail); i++ {
		for j := i; j > 0 && tail[j].Name < tail[j-1].Name; j-- {
			tail[j], tail[j-1] = tail[j-1], tail[j]
		}
	}
}
