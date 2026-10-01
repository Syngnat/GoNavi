package sqlserver

import (
	"context"
	"sort"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 对象类权限中可细化到列的权限，以及适用于存储过程/函数的权限。
var (
	columnPermissions  = map[string]bool{"SELECT": true, "UPDATE": true, "REFERENCES": true}
	routinePermissions = map[string]bool{"EXECUTE": true, "ALTER": true, "CONTROL": true, "VIEW DEFINITION": true, "TAKE OWNERSHIP": true, "REFERENCES": true}
)

var staticPermissions = map[string][]string{
	"SERVER":   {"ALTER ANY DATABASE", "ALTER ANY LOGIN", "CONNECT SQL", "CONTROL SERVER", "CREATE ANY DATABASE", "VIEW ANY DATABASE", "VIEW ANY DEFINITION", "VIEW SERVER STATE", "ALTER TRACE", "SHUTDOWN"},
	"DATABASE": {"CONNECT", "CREATE TABLE", "CREATE VIEW", "CREATE PROCEDURE", "CREATE FUNCTION", "CREATE SCHEMA", "ALTER", "ALTER ANY USER", "ALTER ANY ROLE", "BACKUP DATABASE", "CONTROL", "DELETE", "EXECUTE", "INSERT", "SELECT", "UPDATE", "VIEW DEFINITION", "SHOWPLAN"},
	"SCHEMA":   {"ALTER", "CONTROL", "DELETE", "EXECUTE", "INSERT", "REFERENCES", "SELECT", "UPDATE", "VIEW DEFINITION", "TAKE OWNERSHIP"},
	"OBJECT":   {"ALTER", "CONTROL", "DELETE", "EXECUTE", "INSERT", "REFERENCES", "SELECT", "UPDATE", "VIEW DEFINITION", "TAKE OWNERSHIP"},
}

// probePrivileges 读取 fn_builtin_permissions，失败时回退静态表；同名权限合并作用域。
func probePrivileges(ctx context.Context, env dbuser.Env) []dbuser.PrivilegeDescriptor {
	byClass := map[string][]string{}
	rows, err := env.SQL.Query(ctx, "", "SELECT class_desc, permission_name FROM sys.fn_builtin_permissions(DEFAULT) WHERE class_desc IN ('SERVER','DATABASE','SCHEMA','OBJECT')")
	if err == nil && len(rows) > 0 {
		for _, row := range rows {
			class := strings.ToUpper(dbuser.CellString(row, "class_desc"))
			byClass[class] = append(byClass[class], dbuser.NormalizePrivilegeName(dbuser.CellString(row, "permission_name")))
		}
	} else {
		byClass = staticPermissions
	}
	scopes := map[string]map[string]bool{}
	add := func(name, scope string) {
		if scopes[name] == nil {
			scopes[name] = map[string]bool{}
		}
		scopes[name][scope] = true
	}
	for class, names := range byClass {
		for _, name := range names {
			switch class {
			case "SERVER":
				add(name, dbuser.ScopeGlobal)
			case "DATABASE":
				add(name, dbuser.ScopeDatabase)
			case "SCHEMA":
				add(name, dbuser.ScopeSchema)
			case "OBJECT":
				add(name, dbuser.ScopeTable)
				if columnPermissions[name] {
					add(name, dbuser.ScopeColumn)
				}
				if routinePermissions[name] {
					add(name, dbuser.ScopeRoutine)
				}
			}
		}
	}
	names := make([]string, 0, len(scopes))
	for name := range scopes {
		names = append(names, name)
	}
	sort.Strings(names)
	order := []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase, dbuser.ScopeSchema, dbuser.ScopeTable, dbuser.ScopeColumn, dbuser.ScopeRoutine}
	catalog := make([]dbuser.PrivilegeDescriptor, 0, len(names))
	for _, name := range names {
		var list []string
		for _, scope := range order {
			if scopes[name][scope] {
				list = append(list, scope)
			}
		}
		catalog = append(catalog, dbuser.PrivilegeDescriptor{Name: name, Scopes: list})
	}
	return catalog
}
