package postgres

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// describeGrants 用 aclexplode 读取直接授予该角色的权限（不含 PUBLIC 与继承）。
// 库级 ACL 在共享 catalog 中；模式/表/列/序列/例程 ACL 按库存放，在 database 中查询。
func describeGrants(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, role, database string) []dbuser.Grant {
	grantee := roleOIDExpr(profile, role)
	grants := make([]dbuser.Grant, 0, 16)
	collect := func(query string, build func(row map[string]any) dbuser.Grant) {
		rows, err := env.SQL.Query(ctx, database, query)
		if err != nil {
			return
		}
		for _, row := range rows {
			grant := build(row)
			grant.Privilege = dbuser.NormalizePrivilegeName(dbuser.CellString(row, "privilege_type"))
			grant.WithGrantOption = dbuser.CellBool(row, "is_grantable")
			grants = append(grants, grant)
		}
	}
	collect("SELECT d.datname, a.privilege_type, a.is_grantable FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a WHERE a.grantee = "+grantee,
		func(row map[string]any) dbuser.Grant {
			return dbuser.Grant{Scope: dbuser.ScopeDatabase, Database: dbuser.CellString(row, "datname")}
		})
	collect("SELECT n.nspname, a.privilege_type, a.is_grantable FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee = "+grantee,
		func(row map[string]any) dbuser.Grant {
			return dbuser.Grant{Scope: dbuser.ScopeSchema, Database: database, Schema: dbuser.CellString(row, "nspname")}
		})
	collect("SELECT n.nspname, c.relname, c.relkind, a.privilege_type, a.is_grantable FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, pg_catalog.aclexplode(c.relacl) a WHERE a.grantee = "+grantee+" AND c.relkind IN ('r','v','m','f','p','S')",
		func(row map[string]any) dbuser.Grant {
			scope := dbuser.ScopeTable
			if dbuser.CellString(row, "relkind") == "S" {
				scope = dbuser.ScopeSequence
			}
			return dbuser.Grant{Scope: scope, Database: database, Schema: dbuser.CellString(row, "nspname"), Object: dbuser.CellString(row, "relname")}
		})
	collect("SELECT n.nspname, c.relname, att.attname, a.privilege_type, a.is_grantable FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, pg_catalog.aclexplode(att.attacl) a WHERE a.grantee = "+grantee+" AND att.attnum > 0 AND NOT att.attisdropped",
		func(row map[string]any) dbuser.Grant {
			return dbuser.Grant{Scope: dbuser.ScopeColumn, Database: database, Schema: dbuser.CellString(row, "nspname"), Object: dbuser.CellString(row, "relname"), Column: dbuser.CellString(row, "attname")}
		})
	collect("SELECT n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, a.privilege_type, a.is_grantable FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace, pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = "+grantee,
		func(row map[string]any) dbuser.Grant {
			return dbuser.Grant{
				Scope:      dbuser.ScopeRoutine,
				Database:   database,
				Schema:     dbuser.CellString(row, "nspname"),
				Object:     dbuser.CellString(row, "proname") + "(" + dbuser.CellString(row, "args") + ")",
				ObjectType: "FUNCTION",
			}
		})
	return grants
}

// splitRoutineSignature 拆分 name(args)；参数表只允许类型名相关字符，防止注入。
func splitRoutineSignature(object string) (name, args string, ok bool) {
	open := strings.Index(object, "(")
	if open < 0 {
		return object, "", true
	}
	if !strings.HasSuffix(object, ")") {
		return "", "", false
	}
	name, args = object[:open], object[open+1:len(object)-1]
	for _, r := range args {
		if !(dbuser.IsIdentifierRune(r) || strings.ContainsRune(` ,."[]()`, r)) {
			return "", "", false
		}
	}
	return name, args, name != ""
}
