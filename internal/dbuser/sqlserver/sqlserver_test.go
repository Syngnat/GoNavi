package sqlserver

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
)

func probe(t *testing.T, productVersion string, edition int, database string) dbuser.ServerProfile {
	t.Helper()
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SERVERPROPERTY('ProductVersion')", Rows: []map[string]any{dbusertest.Row(
			"product_version", productVersion, "engine_edition", int64(edition), "login_name", "sa", "db_name", database, "banner", "Microsoft SQL Server\nCopyright",
		)}},
		dbusertest.Response{Match: "IS_SRVROLEMEMBER", Rows: []map[string]any{dbusertest.Row("sysadmin", int64(1), "securityadmin", int64(0), "alter_user", int64(1))}},
		dbusertest.Response{Match: "fn_builtin_permissions", Err: dbusertest.ErrNotScripted},
	)
	profile, err := New().Probe(context.Background(), dbuser.Env{SQL: executor}, dbuser.Target{SourceType: "sqlserver"})
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := dbuser.CheckDescriptorsAgainstContract(profile.Options); err != nil {
		t.Fatalf("contract drift: %v", err)
	}
	return profile
}

func displays(t *testing.T, profile dbuser.ServerProfile, request dbuser.ChangeRequest) []string {
	t.Helper()
	plan, err := dbuser.BuildPlan(New(), profile, request)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	return dbusertest.Displays(plan)
}

func expect(t *testing.T, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("statements mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestProbeVersionsAndAzure(t *testing.T) {
	legacy := probe(t, "10.50.6000.34", 3, "master")
	if legacy.VersionText != "SQL Server 2008 R2 (10.50.6000)" || legacy.Feature(featAlterRoleMember) || legacy.Feature(featContainedUsers) {
		t.Fatalf("2008 R2 profile: %+v", legacy)
	}
	modern := probe(t, "15.0.4322.2", 3, "master")
	if !modern.Feature(featAlterRoleMember) || modern.VersionText != "SQL Server 2019 (15.0.4322)" {
		t.Fatalf("2019 profile: %+v", modern)
	}
	if _, ok := modern.Kind(dbuser.KindLogin); !ok {
		t.Fatal("on-prem must expose logins")
	}
	azureUserDB := probe(t, "12.0.2000.8", engineEditionAzureSQL, "appdb")
	if _, ok := azureUserDB.Kind(dbuser.KindLogin); ok || azureUserDB.Flavor != "azure-sql" {
		t.Fatalf("Azure user database must not manage logins: %+v", azureUserDB.Kinds)
	}
	azureMaster := probe(t, "12.0.2000.8", engineEditionAzureSQL, "master")
	if _, ok := azureMaster.Kind(dbuser.KindLogin); !ok {
		t.Fatal("Azure master must manage logins")
	}
	for _, privilege := range modern.Privileges {
		if privilege.Name == "SELECT" && !reflect.DeepEqual(privilege.Scopes, []string{dbuser.ScopeDatabase, dbuser.ScopeSchema, dbuser.ScopeTable, dbuser.ScopeColumn}) {
			t.Fatalf("SELECT scopes: %+v", privilege.Scopes)
		}
	}
}

func TestPlanLogins(t *testing.T) {
	profile := probe(t, "15.0.4322.2", 3, "master")
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: "P@ss'word1"},
		Options: map[string]string{dbuser.OptLoginType: "sql", dbuser.OptMustChange: "true", dbuser.OptCheckExpiration: "true", dbuser.OptCheckPolicy: "true",
			dbuser.OptDefaultDatabase: "appdb", dbuser.OptLoginEnabled: "false"},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "dbcreator"}}},
		GrantsAdd:      []dbuser.Grant{{Privilege: "VIEW SERVER STATE", Scope: dbuser.ScopeGlobal}},
	}), []string{
		"CREATE LOGIN [app] WITH PASSWORD = N'******' MUST_CHANGE, DEFAULT_DATABASE = [appdb], CHECK_EXPIRATION = ON, CHECK_POLICY = ON",
		"ALTER LOGIN [app] DISABLE",
		"GRANT VIEW SERVER STATE TO [app]",
		"ALTER SERVER ROLE [dbcreator] ADD MEMBER [app]",
	})
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:  dbuser.ActionCreate,
		Target:  dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: `CORP\alice`},
		Options: map[string]string{dbuser.OptLoginType: "windows", dbuser.OptDefaultDatabase: "appdb"},
	}), []string{`CREATE LOGIN [CORP\alice] FROM WINDOWS WITH DEFAULT_DATABASE = [appdb]`})
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: "N3w!pass"},
		Options:  map[string]string{dbuser.OptAccountLocked: "false", dbuser.OptLoginEnabled: "true"},
	}), []string{"ALTER LOGIN [app] WITH PASSWORD = N'******' UNLOCK", "ALTER LOGIN [app] ENABLE"})
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:  dbuser.ActionAlter,
		Target:  dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: "app"},
		Options: map[string]string{dbuser.OptAccountLocked: "false"},
	}), []string{"ALTER LOGIN [app] WITH CHECK_POLICY = OFF", "ALTER LOGIN [app] WITH CHECK_POLICY = ON"})
	for name, request := range map[string]dbuser.ChangeRequest{
		"manual lock": {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: "app"}, Options: map[string]string{dbuser.OptAccountLocked: "true"}},
		"must change without expiration": {Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: "x"},
			Password: &dbuser.PasswordChange{Set: true, Password: "p"}, Options: map[string]string{dbuser.OptMustChange: "true"}},
		"drop system login": {Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: "##MS_PolicyEventProcessingLogin##"}},
	} {
		if _, err := dbuser.BuildPlan(New(), profile, request); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestPlanLegacyMembershipProcedures(t *testing.T) {
	profile := probe(t, "10.50.6000.34", 3, "master")
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:            dbuser.ActionAlter,
		Target:            dbuser.PrincipalRef{Kind: dbuser.KindLogin, Name: "app"},
		MembershipsAdd:    []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "sysadmin"}}},
		MembershipsRemove: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "dbcreator"}}},
	}), []string{"EXEC sp_dropsrvrolemember N'app', N'dbcreator'", "EXEC sp_addsrvrolemember N'app', N'sysadmin'"})
	plan, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action:         dbuser.ActionAlter,
		Target:         dbuser.PrincipalRef{Kind: dbuser.KindDBUser, Name: "app", Database: "sales"},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "db_datareader", Database: "sales"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Statements[0].Display != "EXEC sp_addrolemember N'db_datareader', N'app'" || plan.Statements[0].Database != "sales" {
		t.Fatalf("legacy db role: %+v", plan.Statements[0])
	}
}

func TestPlanDatabaseUsersAndPermissions(t *testing.T) {
	profile := probe(t, "16.0.4135.4", 3, "master")
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:  dbuser.ActionCreate,
		Target:  dbuser.PrincipalRef{Kind: dbuser.KindDBUser, Name: "app", Database: "sales"},
		Options: map[string]string{dbuser.OptDBUserType: "login", dbuser.OptLoginName: "app_login", dbuser.OptDefaultSchema: "dbo"},
		GrantsAdd: []dbuser.Grant{
			{Privilege: "SELECT", Scope: dbuser.ScopeSchema, Database: "sales", Schema: "dbo"},
			{Privilege: "UPDATE", Scope: dbuser.ScopeColumn, Database: "sales", Schema: "dbo", Object: "orders", Column: "note"},
			{Privilege: "DELETE", Scope: dbuser.ScopeTable, Database: "sales", Schema: "dbo", Object: "orders", Deny: true},
			{Privilege: "EXECUTE", Scope: dbuser.ScopeRoutine, Database: "sales", Schema: "dbo", Object: "sp_calc", ObjectType: "PROCEDURE", WithGrantOption: true},
			{Privilege: "CREATE TABLE", Scope: dbuser.ScopeDatabase, Database: "sales"},
		},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "db_datareader", Database: "sales"}}},
	}), []string{
		"CREATE USER [app] FOR LOGIN [app_login] WITH DEFAULT_SCHEMA = [dbo]",
		"GRANT SELECT ON SCHEMA::[dbo] TO [app]",
		"GRANT UPDATE ([note]) ON OBJECT::[dbo].[orders] TO [app]",
		"DENY DELETE ON OBJECT::[dbo].[orders] TO [app]",
		"GRANT EXECUTE ON OBJECT::[dbo].[sp_calc] TO [app] WITH GRANT OPTION",
		"GRANT CREATE TABLE TO [app]",
		"ALTER ROLE [db_datareader] ADD MEMBER [app]",
	})
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindDBUser, Name: "contained", Database: "sales"},
		Options:  map[string]string{dbuser.OptDBUserType: "password"},
		Password: &dbuser.PasswordChange{Set: true, Password: "C0ntained!"},
	}), []string{"CREATE USER [contained] WITH PASSWORD = N'******'"})
	expect(t, displays(t, profile, dbuser.ChangeRequest{
		Action:       dbuser.ActionAlter,
		Target:       dbuser.PrincipalRef{Kind: dbuser.KindDBUser, Name: "app", Database: "sales"},
		Options:      map[string]string{dbuser.OptLoginName: "app_login2"},
		GrantsRevoke: []dbuser.Grant{{Privilege: "SELECT", Scope: dbuser.ScopeSchema, Database: "sales", Schema: "dbo", WithGrantOption: true}},
	}), []string{"ALTER USER [app] WITH LOGIN = [app_login2]", "REVOKE GRANT OPTION FOR SELECT ON SCHEMA::[dbo] FROM [app] CASCADE"})
	expect(t, displays(t, profile, dbuser.ChangeRequest{Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "readers", Database: "sales"}}),
		[]string{"CREATE ROLE [readers]"})
	quoted := displays(t, profile, dbuser.ChangeRequest{Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindDBUser, Name: "a]b", Database: "sales"}})
	expect(t, quoted, []string{"DROP USER [a]]b]"})
}

func TestListDetectsOrphansAndServerRoles(t *testing.T) {
	profile := probe(t, "15.0.4322.2", 3, "sales")
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "FROM sys.server_principals sp WHERE sp.type", Rows: []map[string]any{
			dbusertest.Row("name", "sa", "type", "S", "sid_hex", "0x01", "is_disabled", false),
			dbusertest.Row("name", "app_login", "type", "S", "sid_hex", "0xAA", "is_locked", int64(1)),
			dbusertest.Row("name", "sysadmin", "type", "R", "is_fixed_role", true),
		}},
		dbusertest.Response{Match: "FROM sys.database_principals dp", Rows: []map[string]any{
			dbusertest.Row("name", "dbo", "type", "S", "sid_hex", "0x01", "authentication_type_desc", "INSTANCE"),
			dbusertest.Row("name", "app", "type", "S", "sid_hex", "0xAA", "authentication_type_desc", "INSTANCE"),
			dbusertest.Row("name", "ghost", "type", "S", "sid_hex", "0xBB", "authentication_type_desc", "INSTANCE"),
			dbusertest.Row("name", "db_datareader", "type", "R", "is_fixed_role", true),
		}},
	)
	principals, err := New().List(context.Background(), dbuser.Env{SQL: executor}, profile, dbuser.ListQuery{Database: "sales"})
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]dbuser.Principal{}
	for _, principal := range principals {
		byName[principal.Ref.Name] = principal
	}
	if !byName["app_login"].Locked || !byName["sa"].Current {
		t.Fatalf("login flags: %+v", byName)
	}
	if byName["sysadmin"].Ref.Kind != dbuser.KindRole || !byName["sysadmin"].ReadOnly || !byName["sysadmin"].System {
		t.Fatalf("server role must be read-only system role: %+v", byName["sysadmin"])
	}
	if !strings.Contains(strings.Join(byName["ghost"].Tags, ","), "orphan") || len(byName["app"].Tags) != 0 {
		t.Fatalf("orphan detection: ghost=%+v app=%+v", byName["ghost"], byName["app"])
	}
	if !byName["db_datareader"].System || byName["db_datareader"].Ref.Database != "sales" {
		t.Fatalf("fixed database role: %+v", byName["db_datareader"])
	}
}
