package postgres

import "GoNavi-Wails/internal/dbuser"

// buildPrivileges 返回各对象层级可授予的权限；MAINTAIN 仅 PG17+。
func buildPrivileges(profile dbuser.ServerProfile) []dbuser.PrivilegeDescriptor {
	table := []string{dbuser.ScopeTable}
	tableColumn := []string{dbuser.ScopeTable, dbuser.ScopeColumn}
	privileges := []dbuser.PrivilegeDescriptor{
		{Name: "CONNECT", Scopes: []string{dbuser.ScopeDatabase}, Group: "database"},
		{Name: "CREATE", Scopes: []string{dbuser.ScopeDatabase, dbuser.ScopeSchema}, Group: "structure"},
		{Name: "TEMPORARY", Scopes: []string{dbuser.ScopeDatabase}, Group: "database"},
		{Name: "USAGE", Scopes: []string{dbuser.ScopeSchema, dbuser.ScopeSequence}, Group: "structure"},
		{Name: "SELECT", Scopes: []string{dbuser.ScopeTable, dbuser.ScopeColumn, dbuser.ScopeSequence}, Group: "data"},
		{Name: "INSERT", Scopes: tableColumn, Group: "data"},
		{Name: "UPDATE", Scopes: []string{dbuser.ScopeTable, dbuser.ScopeColumn, dbuser.ScopeSequence}, Group: "data"},
		{Name: "DELETE", Scopes: table, Group: "data"},
		{Name: "TRUNCATE", Scopes: table, Group: "data"},
		{Name: "REFERENCES", Scopes: tableColumn, Group: "structure"},
		{Name: "TRIGGER", Scopes: table, Group: "structure"},
		{Name: "EXECUTE", Scopes: []string{dbuser.ScopeRoutine}, Group: "routine"},
	}
	if profile.Feature(featMaintain) {
		privileges = append(privileges, dbuser.PrivilegeDescriptor{Name: "MAINTAIN", Scopes: table, Group: "structure"})
	}
	return privileges
}

// buildOptions 返回可编辑属性。角色属性放在「服务器权限」页，与 MySQL 全局权限对应。
func (p *Provider) buildOptions(profile dbuser.ServerProfile, encryptionChoices []string) []dbuser.OptionDescriptor {
	user, role := dbuser.KindUser, dbuser.KindRole
	server := dbuser.TabServerPrivileges
	options := []dbuser.OptionDescriptor{
		dbuser.StringOption(dbuser.OptComment, dbuser.TabGeneral, user, role),
		{ID: dbuser.OptValidUntil, Type: dbuser.OptionDateTime, Tab: dbuser.TabGeneral, Kinds: []dbuser.PrincipalKind{user, role}},
		dbuser.IntOption(dbuser.OptConnectionLimit, dbuser.TabGeneral, -1, 1000000, user, role),
		dbuser.BoolOption(dbuser.OptCanLogin, server, user, role),
		dbuser.BoolOption(dbuser.OptCreateDB, server, user, role),
		dbuser.BoolOption(dbuser.OptCreateRole, server, user, role),
		dbuser.BoolOption(dbuser.OptInherit, server, user, role),
		dbuser.BoolOption(dbuser.OptReplication, server, user, role),
	}
	if p.variant == variantPostgres {
		options = append(options, dbuser.BoolOption(dbuser.OptSuperuser, server, user, role))
		if profile.Feature(featBypassRLS) {
			options = append(options, dbuser.BoolOption(dbuser.OptBypassRLS, server, user, role))
		}
	} else {
		options = append(options,
			dbuser.OptionDescriptor{ID: dbuser.OptValidBegin, Type: dbuser.OptionDateTime, Tab: dbuser.TabGeneral, Kinds: []dbuser.PrincipalKind{user, role}},
			dbuser.BoolOption(dbuser.OptAccountLocked, dbuser.TabGeneral, user),
			dbuser.BoolOption(dbuser.OptSysAdmin, server, user, role),
			dbuser.BoolOption(dbuser.OptAuditAdmin, server, user, role),
			dbuser.BoolOption(dbuser.OptMonAdmin, server, user, role),
			dbuser.BoolOption(dbuser.OptOprAdmin, server, user, role),
			dbuser.BoolOption(dbuser.OptPolAdmin, server, user, role),
		)
	}
	if profile.Feature(featClientHash) && len(encryptionChoices) > 0 {
		choices := make([]dbuser.Choice, 0, len(encryptionChoices))
		for _, value := range encryptionChoices {
			if value != "scram-sha-256" && value != "md5" {
				continue
			}
			choice := dbuser.Choice{Value: value}
			if value == "md5" {
				choice.Deprecated = true
				choice.NoticeCode = noticeMD5Deprecated
			}
			choices = append(choices, choice)
		}
		option := dbuser.EnumOption(dbuser.OptPasswordEncryption, dbuser.TabGeneral, choices, user)
		option.Default = profile.Dialect[dialectEncryption]
		options = append(options, option)
	}
	return options
}
