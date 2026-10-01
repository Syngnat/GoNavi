package oracle

import (
	"context"
	"sort"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// objectPrivilegeScopes 是对象权限到作用域的映射（TABLE_PRIVILEGE_MAP 中常见项）。
var objectPrivilegeScopes = map[string][]string{
	"SELECT":            {dbuser.ScopeTable, dbuser.ScopeSequence},
	"READ":              {dbuser.ScopeTable},
	"INSERT":            {dbuser.ScopeTable, dbuser.ScopeColumn},
	"UPDATE":            {dbuser.ScopeTable, dbuser.ScopeColumn},
	"DELETE":            {dbuser.ScopeTable},
	"REFERENCES":        {dbuser.ScopeTable, dbuser.ScopeColumn},
	"ALTER":             {dbuser.ScopeTable, dbuser.ScopeSequence},
	"INDEX":             {dbuser.ScopeTable},
	"FLASHBACK":         {dbuser.ScopeTable},
	"ON COMMIT REFRESH": {dbuser.ScopeTable},
	"QUERY REWRITE":     {dbuser.ScopeTable},
	"EXECUTE":           {dbuser.ScopeRoutine},
	"DEBUG":             {dbuser.ScopeTable, dbuser.ScopeRoutine},
}

var staticSystemPrivileges = []string{
	"CREATE SESSION", "CREATE TABLE", "CREATE VIEW", "CREATE SEQUENCE", "CREATE PROCEDURE", "CREATE TRIGGER",
	"CREATE SYNONYM", "CREATE TYPE", "CREATE MATERIALIZED VIEW", "UNLIMITED TABLESPACE",
	"CREATE ANY TABLE", "ALTER ANY TABLE", "DROP ANY TABLE", "SELECT ANY TABLE", "INSERT ANY TABLE", "UPDATE ANY TABLE",
	"DELETE ANY TABLE", "EXECUTE ANY PROCEDURE", "CREATE USER", "ALTER USER", "DROP USER", "CREATE ROLE",
	"GRANT ANY ROLE", "GRANT ANY PRIVILEGE", "GRANT ANY OBJECT PRIVILEGE", "SELECT ANY DICTIONARY",
}

// probePrivileges 读取 SYSTEM_PRIVILEGE_MAP（Oracle），不可读或达梦时回退静态表；对象权限走映射表。
func probePrivileges(ctx context.Context, env dbuser.Env, variant variant) []dbuser.PrivilegeDescriptor {
	system := staticSystemPrivileges
	if variant == variantOracle {
		if rows, err := env.SQL.Query(ctx, "", "SELECT NAME FROM SYSTEM_PRIVILEGE_MAP ORDER BY NAME"); err == nil && len(rows) > 0 {
			system = make([]string, 0, len(rows))
			for _, row := range rows {
				system = append(system, dbuser.NormalizePrivilegeName(dbuser.CellString(row, "NAME")))
			}
		}
	}
	catalog := make([]dbuser.PrivilegeDescriptor, 0, len(system)+len(objectPrivilegeScopes))
	objectNames := make([]string, 0, len(objectPrivilegeScopes))
	for name := range objectPrivilegeScopes {
		objectNames = append(objectNames, name)
	}
	sort.Strings(objectNames)
	seen := map[string]bool{}
	for _, name := range objectNames {
		scopes := append([]string{}, objectPrivilegeScopes[name]...)
		catalog = append(catalog, dbuser.PrivilegeDescriptor{Name: name, Scopes: scopes, Group: "object"})
		seen[name] = true
	}
	for _, name := range system {
		if seen[name] {
			// 同名系统权限（如 ALTER）已作为对象权限出现：追加全局作用域。
			for index := range catalog {
				if catalog[index].Name == name {
					catalog[index].Scopes = append(catalog[index].Scopes, dbuser.ScopeGlobal)
				}
			}
			continue
		}
		seen[name] = true
		catalog = append(catalog, dbuser.PrivilegeDescriptor{Name: name, Scopes: []string{dbuser.ScopeGlobal}, Group: "system"})
	}
	return catalog
}

func tablespaceChoices(names []string) []dbuser.Choice {
	return dbuser.Choices(names...)
}

func (p *Provider) buildOptions(profile dbuser.ServerProfile, tablespaces, temporary, profiles []string) []dbuser.OptionDescriptor {
	user := dbuser.KindUser
	options := []dbuser.OptionDescriptor{
		dbuser.BoolOption(dbuser.OptAccountLocked, dbuser.TabGeneral, user),
		dbuser.BoolOption(dbuser.OptExpirePasswordNow, dbuser.TabGeneral, user),
		dbuser.EnumOption(dbuser.OptDefaultTablespace, dbuser.TabGeneral, tablespaceChoices(tablespaces), user),
	}
	caseSensitive := dbuser.BoolOption(dbuser.OptCaseSensitiveName, dbuser.TabGeneral, user, dbuser.KindRole)
	caseSensitive.CreateOnly = true
	options = append(options, caseSensitive)
	if p.variant == variantOracle {
		options = append(options, dbuser.EnumOption(dbuser.OptTemporaryTablespace, dbuser.TabGeneral, tablespaceChoices(temporary), user))
	}
	if profile.Feature(featQuota) {
		options = append(options, dbuser.StringOption(dbuser.OptTablespaceQuota, dbuser.TabGeneral, user))
	}
	if len(profiles) > 0 {
		options = append(options, dbuser.EnumOption(dbuser.OptProfile, dbuser.TabGeneral, dbuser.Choices(profiles...), user))
	}
	if profile.Feature(featNoAuthentication) {
		options = append(options, dbuser.BoolOption(dbuser.OptNoAuthentication, dbuser.TabGeneral, user))
	}
	if profile.Feature(featDefaultRoles) {
		options = append(options, dbuser.OptionDescriptor{ID: dbuser.OptDefaultRoles, Type: dbuser.OptionMulti, Tab: dbuser.TabMembership, Kinds: []dbuser.PrincipalKind{user}})
	}
	return options
}

// systemUsers 是 11g / 达梦没有 ORACLE_MAINTAINED 列时使用的内置账号名单。
var systemUsers = map[string]bool{
	"SYS": true, "SYSTEM": true, "OUTLN": true, "DBSNMP": true, "XDB": true, "ANONYMOUS": true, "CTXSYS": true,
	"MDSYS": true, "ORDSYS": true, "ORDDATA": true, "ORDPLUGINS": true, "WMSYS": true, "APPQOSSYS": true,
	"EXFSYS": true, "OLAPSYS": true, "SI_INFORMTN_SCHEMA": true, "MDDATA": true, "SPATIAL_CSW_ADMIN_USR": true,
	"SPATIAL_WFS_ADMIN_USR": true, "APEX_PUBLIC_USER": true, "FLOWS_FILES": true, "XS$NULL": true, "ORACLE_OCM": true,
	"DIP": true, "MGMT_VIEW": true, "SYSMAN": true, "OWBSYS": true, "AUDSYS": true, "GSMADMIN_INTERNAL": true,
	"SYSDBA": true, "SYSAUDITOR": true, "SYSSSO": true, "SYSDBO": true, "CTISYS": true, "PUBLIC": true,
}

func isSystemUser(name string, maintained bool) bool {
	upper := strings.ToUpper(name)
	return maintained || systemUsers[upper] || strings.HasPrefix(upper, "APEX_") || strings.HasPrefix(upper, "SYS_")
}
